import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { ProviderError } from "../server/core/provider";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { Tools } from "../server/core/tools";
import { Employee, type EmployeeRuntime, type Task } from "../server/core/employee";
import { EmployeeBrowsers } from "../server/core/employee-browsers";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { privateWorker } from "../server/core/headless";
import { Vault } from "../server/core/vault";
import { sleep } from "../server/core/util";

function fixture(run: EmployeeRuntime["run"] = async () => {}) {
  const store = new Store(":memory:"), vault = new Vault(store);
  const runtime: EmployeeRuntime = { run, cancel() {}, isRunning: () => false, emit() {}, send: async () => ({}), config: () => ({ model: "fixture/model" }), isolated: true };
  const employee = new Employee(store, vault, runtime);
  employee.closed = true;
  return { store, employee, vault, runtime };
}
async function task(employee: Employee, text = "work", extra = {}) {
  const result = await employee.execute("", { action: "add", kind: "todo", text, ...extra });
  return employee.task(employee.state(), result.value.id);
}
async function segment(employee: Employee, job: Task) {
  employee.update((s) => { s.tasks.find((t) => t.id === job.id)!.status = "running"; });
  employee.busy.set(job.id, { computer: job.side === "computer", session: "" });
  await employee.run(employee.task(employee.state(), job.id));
  return employee.task(employee.state(), job.id);
}

test("employees isolate state, business keys, conversations and owner access but share credentials; legacy state stays default", async () => {
  const { store, employee, vault } = fixture();
  try {
    employee.update((s) => s.memories.push({ id: "old", text: "legacy" }));
    const a = employee.for(employee.create({ name: "A" }, "alice").id);
    const b = employee.for(employee.create({ name: "B" }, "bob").id);
    assert(a.accessible({ id: "alice", role: "operator" }));
    assert(!a.accessible({ id: "bob", role: "operator" }));
    assert(a.accessible({ id: "alice", role: "viewer" }));
    assert(!a.manageable({ id: "alice", role: "viewer" }));
    assert(a.accessible({ id: "root", role: "admin" }));
    assert.equal(employee.state().memories[0].text, "legacy");
    await a.execute("", { action: "remember", text: "A-only" });
    assert.equal(b.state().memories.length, 0);
    const first = await task(a, "A work", { key: "same-business-key" });
    const second = await task(b, "B work", { key: "same-business-key" });
    assert.notEqual(first.id, second.id);
    await assert.rejects(b.execute("", { action: "done", id: first.id }), /not found/);
    assert.notEqual(a.chat("alice").id, b.chat("bob").id);
    let changes = 0;
    employee.runtime.emit = () => { changes++; };
    a.chat("alice"); a.chat("alice");
    assert.equal(changes, 0, "reading a chat must not emit changes and create a frontend refresh loop");
    assert.equal(store.session(a.state().chatSession!).employeeId, a.employeeId);
    assert.throws(() => store.fork(a.state().chatSession!), /workspace/);
    assert.throws(() => store.stage(a.state().chatSession!), /workspace/);
    const secret = vault.save({ name: "secret", condition: "test", content: "hidden" });
    a.update((s) => Object.assign(s, { vaultIds: [] })); // Legacy grants must not hide shared entries.
    for (const worker of [employee, a, b]) {
      const entries = (await worker.execute("", { action: "vault_list" })).value.entries;
      assert.deepEqual(entries.map((entry: any) => entry.id), [secret.id]);
      assert.equal(entries[0].condition, "test");
      assert(!JSON.stringify(entries).includes("hidden"));
      await assert.rejects(worker.execute("", { action: "vault_get", id: secret.id, text: " " }), /purpose required/);
      const result = await worker.execute("", { action: "vault_get", id: secret.id, text: "test" });
      assert.equal(JSON.parse(result.secret!).content, "hidden");
      assert(!JSON.stringify(result.value).includes("hidden"));
    }
    assert.equal(store.object<any>("vault", secret.id).usedFor, "test");
    const reopened = new Employee(store, vault, employee.runtime);
    assert.equal(reopened.for(a.employeeId).state().memories[0].text, "A-only");
  } finally { employee.close(); store.close(); }
});

test("shared vault keeps remote credentials scoped to their original task", async () => {
  const { store, employee, vault } = fixture();
  try {
    const a = employee.for(employee.create({ name: "A" }, "alice").id);
    const b = employee.for(employee.create({ name: "B" }, "bob").id);
    const own = await task(a), sibling = await task(a), peer = await task(b);
    for (const [worker, job] of [[a, own], [a, sibling], [b, peer]] as const) {
      worker.update((s) => { worker.task(s, job.id).status = "running"; });
      worker.busy.set(job.id, { computer: false, session: "" });
    }
    const shared = vault.save({ name: "shared", condition: "test", content: "hidden", share: true });
    const pk = vault.request(own.id);
    const received = vault.receive(own.id, own.text, vault.sealFor(shared.id, own.id, pk).sealed);
    for (const [worker, caller, allowed] of [[employee, "", false], [a, "", false], [a, own.id, true], [a, sibling.id, false], [b, peer.id, false]] as const) {
      const entries = (await worker.execute(caller, { action: "vault_list" })).value.entries;
      assert.deepEqual(new Set(entries.map((entry: any) => entry.id)), new Set(allowed ? [shared.id, received.id] : [shared.id]));
      assert(!JSON.stringify(entries).includes("hidden"));
      assert.equal(JSON.parse((await worker.execute(caller, { action: "vault_get", id: shared.id, text: "test" })).secret!).content, "hidden");
      if (allowed)
        assert.equal(JSON.parse((await worker.execute(caller, { action: "vault_get", id: received.id, text: "test" })).secret!).content, "hidden");
      else
        await assert.rejects(worker.execute(caller, { action: "vault_get", id: received.id, text: "test" }), /another task/);
    }
    vault.dropTemp(own.id);
    assert.deepEqual(vault.list().map((entry) => entry.id), [shared.id]);
  } finally { employee.close(); store.close(); }
});

test("shared vault sends encrypted support without employee grants but still requires share opt-in", async () => {
  const { store, employee, vault, runtime } = fixture();
  try {
    const job = await task(employee);
    const request = "remote-request", pk = vault.request(request);
    employee.update((s) => Object.assign(employee.task(s, job.id), { status: "running", replyTo: { id: request, token: "remote", name: "Remote" }, vaultPk: pk }));
    employee.busy.set(job.id, { computer: false, session: "" });
    const secret = vault.save({ name: "service", condition: "test", content: "support-secret" });
    const sent: any[] = [];
    runtime.send = async (to, type, data) => { sent.push({ to, type, data }); return {}; };
    await assert.rejects(employee.execute(job.id, { action: "vault_send", id: secret.id }), /not shareable/);
    assert.equal(sent.length, 0);
    vault.save({ id: secret.id, name: "service", condition: "test", share: true });
    assert.equal((await employee.execute(job.id, { action: "vault_send", id: secret.id })).stop, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "remote");
    assert.equal(sent[0].type, "starlink.reply");
    assert(!JSON.stringify(sent).includes("support-secret"));
    const received = vault.receive(request, "remote work", sent[0].data.sealed);
    assert.equal(vault.get(received.id, "test", request).content, "support-secret");
  } finally { employee.close(); store.close(); }
});

test("employee conversation delegates through the existing engine without leaking its identity or executing work in the conversation", async () => {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: { fixture: { api: "openai-completions", baseURL: "https://fixture.test/v1", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  try {
    const a = engine.employee.for(engine.employee.create({ name: "Alice worker", instruction: "Keep work isolated" }, "alice").id);
    const b = engine.employee.for(engine.employee.create({ name: "Bob worker" }, "bob").id);
    const session = a.chat("alice");
    let calls = 0;
    engine.providers.chat = async (_model, system, _messages, definitions) => {
      assert(system.includes("Alice worker") && system.includes("Keep work isolated"));
      assert(system.includes("图片和截图用 Markdown 内嵌") && system.includes("只引用实际返回的图片"), "employee chat shares the image-output rules with execution sessions");
      assert(!system.includes("Bob worker"));
      assert(!definitions.some((tool) => ["bash", "write", "chrome", "vault", "mcp"].includes(tool.name)));
      return calls++ === 0
        ? { role: "assistant", calls: [{ id: "delegate", name: "employee", arguments: { action: "add", kind: "todo", text: "finish authorized work", key: "work" } }] }
        : { role: "assistant", text: "已安排工作" };
    };
    await engine.run(session.id, { role: "user", text: "请完成这项工作" });
    assert.equal(a.state().tasks.length, 1);
    assert.equal(b.state().tasks.length, 0);
    assert.equal(engine.employee.state().tasks.length, 0);
    assert.equal(store.messages(session.id).at(-1)?.text, "已安排工作");
    const computer = store.newSession({ employeeId: a.employeeId, taskId: a.state().tasks[0].id, scene: "computer" });
    const tools = new Tools(engine, computer, engine.config(), new AbortController().signal, () => {});
    const definitions = tools.definitions(await engine.catalog.resolve(engine.config(), "fixture/model"));
    assert(definitions.some((tool) => tool.name === "bash"));
    assert(!definitions.some((tool) => ["write", "edit", "mcp", "switch_scene"].includes(tool.name)));
    const close = Tools.prototype.close;
    try {
      Tools.prototype.close = async () => { throw Error("cleanup failed"); };
      await assert.rejects(engine.run(session.id, { role: "user", text: "explain status" }), /cleanup failed/);
      assert.equal(engine.active.size, 0, "cleanup failures must not leave a permanently running executor");
      assert.equal(engine.redactors.size, 0);
    } finally { Tools.prototype.close = close; }
  } finally { await engine.close(); store.close(); }
});

test("employee chat delegates evidence-dependent questions, follows an existing investigation and answers known facts without a task", async () => {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test/v1", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Investigator" }, "owner").id), chat = employee.chat("owner");
  const question = "刚才任务调用 API 的地址是啥？";
  const investigation = "只读调查刚才任务的 HTTP response headers timed out：核对实际模型、网关、请求 URL 和日志证据。只返回脱敏后的 origin/path，不输出 API Key、Token 或带凭据的查询参数；不得修改配置、修复代码或重试原请求。";
  const source = await task(employee, "Original coding work");
  employee.update((state) => { Object.assign(state.tasks[0], { status: "failed", result: "HTTP response headers timed out" }); });
  const follow = (id: string, arguments_: any) => ({ role: "assistant", calls: [{ id, name: "employee", arguments: arguments_ }] });
  engine.providers.chat = async (_model, system, messages, definitions) => {
    assert(system.includes("需要现场证据的问题") && system.includes("自动安排只读调查"));
    assert(system.includes("不能以沟通会话没有 shell") && system.includes("不是实际发起的请求地址"));
    assert(system.includes("用户明确要求只讨论、不执行时遵守") && system.includes("不得擅自重启用户停止的任务或绕过审批"));
    const description = definitions.find((tool) => tool.name === "employee")!.description;
    assert(description.includes("自动安排只读调查") && description.includes("不要重复派单"));
    assert(!definitions.some((tool) => ["bash", "write", "edit", "chrome", "switch_scene"].includes(tool.name)));
    const last = messages.at(-1)!;
    if (last.role === "user" && last.text?.includes("1+1")) return { role: "assistant", text: "2" };
    if (last.role === "user") return follow("inspect", { action: "list" });
    const result = JSON.parse(last.text!);
    if (result.tasks) {
      assert(result.tasks.some((task: any) => task.id === source.id && task.result.includes("timed out")));
      const current = result.tasks.find((task: any) => task.key === "endpoint-investigation");
      return current
        ? follow("follow-up", { action: "resume", id: current.id, text: "优先核对实际请求 origin/path，保留只读范围。" })
        : follow("investigate", { action: "add", kind: "todo", profile: "lightweight", key: "endpoint-investigation", text: investigation });
    }
    if (result.id) {
      assert(system.includes(result.id), "the next model request sees tasks created in this turn, not a stale task index");
      return { role: "assistant", text: `已安排只读调查（任务 ${result.id}），查到实际请求地址和证据后会回到这里。` };
    }
    return { role: "assistant", text: "已跟进原调查，不重复派单。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: question });
    const job = employee.state().tasks.find((task) => task.key === "endpoint-investigation")!;
    assert(job && job.profile === "lightweight" && job.text === investigation);
    assert.equal(employee.state().tasks.length, 2);
    await engine.run(chat.id, { role: "user", text: question });
    assert.equal(employee.state().tasks.length, 2, "a follow-up does not create a second investigation");
    assert.match(employee.task(employee.state(), job.id).answer, /保留只读范围/);
    await engine.run(chat.id, { role: "user", text: "1+1 等于多少？" });
    assert.equal(store.messages(chat.id).at(-1)?.text, "2");
    assert.equal(employee.state().tasks.length, 2, "ordinary answers remain ordinary answers");
    employee.runtime.run = async (_session, prompt) => {
      assert(prompt.includes(investigation) && prompt.includes("不得修改配置"));
      await employee.execute(job.id, { action: "progress", text: "checked sanitized request evidence", plan: [{ content: "read-only investigation", status: "completed" }] });
      await employee.execute(job.id, { action: "complete", text: "实际请求地址：https://gateway.example/v1/responses；已核对脱敏日志，未修改配置或重试请求。" });
    };
    assert.equal((await segment(employee, job)).status, "done");
    assert.match(store.messages(chat.id).at(-1)!.text!, /实际请求地址：https:\/\/gateway.example\/v1\/responses/);
  } finally { await engine.close(); store.close(); }
});

test("generic recovery diagnoses in the original task/session, requires verified completion and stops at its durable budget", async () => {
  const { store, employee, runtime } = fixture();
  try {
    const job = await task(employee);
    employee.update((s) => { s.tasks[0].checkpoint = "external job-123 was already submitted"; });
    runtime.run = async () => { throw Error("unknown environment failure"); };
    let current = await segment(employee, job);
    assert.equal(current.status, "recovering");
    assert.equal(current.recovery.attempts, 1);
    assert.equal(current.checkpoint, "external job-123 was already submitted");
    const originalSession = current.workSession;
    let recoveryPrompt = "";
    runtime.run = async (_session, prompt) => { recoveryPrompt = prompt; };
    current = await segment(employee, current);
    assert.match(recoveryPrompt, /通用恢复模式/);
    assert.match(recoveryPrompt, /不得重放/);
    assert.equal(current.workSession, originalSession);
    assert.equal(current.recovery.attempts, 2);
    current = await segment(employee, current);
    assert.equal(current.status, "recovering", "three faults do not add an extra early-stop policy");
    current = await segment(employee, current);
    assert.equal(current.status, "waiting");
    assert.equal(current.recovery.attempts, 4);
    const reopened = new Employee(store, employee.vault, runtime);
    assert.equal(reopened.state().tasks[0].recovery.attempts, 4);
    await employee.control({ action: "answer", id: job.id, text: "environment fixed, continue" });
    runtime.run = async () => {
      await assert.rejects(employee.execute(job.id, { action: "complete", text: "trust me" }), /verified plan/);
      await employee.execute(job.id, { action: "progress", text: "checked", plan: [{ content: "verify target", status: "completed" }] });
      await employee.execute(job.id, { action: "complete", text: "verified target state with original external job receipt" });
    };
    current = await segment(employee, current);
    assert.equal(current.status, "done");
    assert.equal(current.workSession, originalSession);
    assert.equal(store.sessions().length, 1);
  } finally { employee.close(); store.close(); }
});

test("consecutive interruptions resume with only new supplements and the current checkpoint, durably in the same session", async () => {
  const { store, employee, runtime } = fixture();
  const firstText = "Unique original task: inspect the submitted external job without resubmitting";
  const job = await task(employee, firstText);
  employee.update((state) => { state.tasks[0].checkpoint = "external job-123 submitted; only inspect"; });
  const prompts: string[] = [], sessions: string[] = [];
  runtime.run = async (session, prompt, _signal, input) => {
    sessions.push(session); prompts.push(prompt);
    store.append(session, { role: "user", text: prompt, taskInput: input });
    throw Error("connection interrupted");
  };
  try {
    let current = await segment(employee, job);
    assert.equal(prompts[0].split(firstText).length - 1, 1, "the original task is sent once, not duplicated inside its first prompt");
    await employee.control({ action: "resume", id: job.id, text: "preserve login" });
    current = await segment(employee, current);
    assert.match(prompts[1], /preserve login/);
    assert(!prompts[1].includes(firstText), "recovery is a continuation, not a re-dispatch of the full task");
    assert.match(prompts[1], /external job-123/);
    assert.match(prompts[1], /不重复.*确认|不要.*确认/);
    const reopened = new Employee(store, employee.vault, runtime);
    reopened.closed = true;
    current = await segment(reopened, current);
    assert(!prompts[2].includes("preserve login"), "a previously delivered supplement is not repeatedly acknowledged after restart");
    assert(sessions.every((session) => session === sessions[0]));
    assert.equal(store.sessions().length, 1);
  } finally { employee.close(); store.close(); }
});

test("a crash before the runtime appends input cannot consume a supplement, and a replacement session gets the full recovery context", async () => {
  const { store, employee, runtime } = fixture();
  const job = await task(employee, "Original authorized task");
  await employee.control({ action: "resume", id: job.id, text: "must preserve login" });
  const prompts: string[] = [];
  runtime.run = async (_session, prompt) => { prompts.push(prompt); throw Error("failed before input was persisted"); };
  try {
    let current = await segment(employee, job);
    runtime.run = async (session, prompt, _signal, input) => {
      prompts.push(prompt);
      store.append(session, { role: "user", text: prompt, taskInput: input });
      throw Error("interrupted after input was persisted");
    };
    current = await segment(employee, current);
    assert.match(prompts[1], /must preserve login/, "unpersisted supplements must be sent again");
    store.deleteSession(current.workSession);
    await employee.control({ action: "resume", id: job.id, text: "also keep the original settings" });
    current = await segment(employee, current);
    assert.match(prompts[2], /Original authorized task/);
    assert.match(prompts[2], /must preserve login/);
    assert.match(prompts[2], /also keep the original settings/);
    assert.equal(current.previousSessions.length, 1);
  } finally { employee.close(); store.close(); }
});

test("the same supplement across interrupted runs is saved once without repeated delivery, version changes or recovery-budget resets", async () => {
  const { store, employee, runtime } = fixture();
  const job = await task(employee), text = "Preserve login\nand keep inline code unchanged";
  const prompts: string[] = [];
  runtime.run = async (session, prompt, _signal, input) => {
    prompts.push(prompt);
    store.append(session, { role: "user", text: prompt, taskInput: input });
    throw Error("connection interrupted");
  };
  try {
    await employee.control({ action: "resume", id: job.id, text });
    let current = await segment(employee, job);
    const originalAnswer = current.answer, checkAt = current.nextCheckAt;
    const repeated = await employee.control({ action: "resume", id: job.id, text: "  " + text.replace(/\n/g, "\r\n") + "\n" });
    assert.equal(repeated.duplicate, true);
    current = employee.task(employee.state(), job.id);
    assert.equal(current.answer, originalAnswer);
    assert.equal(current.revision, 1);
    assert.equal(current.supplementPending, false, "a consumed supplement is not pending again");
    assert.equal(current.status, "recovering");
    assert.equal(current.nextCheckAt, checkAt, "a duplicate does not bypass the existing recovery backoff");
    const reopened = new Employee(store, employee.vault, runtime);
    reopened.closed = true;
    assert.equal((await reopened.control({ action: "resume", id: job.id, text })).duplicate, true);
    current = await segment(reopened, current);
    assert(!prompts[1].includes(text), "the same content is not delivered again after restart");
    assert.equal(current.recovery.attempts, 2);
    await reopened.control({ action: "stop", id: job.id });
    assert.equal((await reopened.control({ action: "resume", id: job.id, text })).duplicate, true);
    current = reopened.task(reopened.state(), job.id);
    assert.equal(current.status, "queued", "identical content can still explicitly resume stopped work");
    assert.equal(current.revision, 1);
    assert.equal(current.answer, originalAnswer);
    assert.equal(current.recovery.attempts, 2);
  } finally { employee.close(); store.close(); }
});

test("repeated supplements do not invalidate a verified plan or bypass the first supplement's completion guard", async () => {
  const { store, employee, runtime } = fixture();
  const job = await task(employee);
  runtime.run = async () => {
    await employee.control({ action: "resume", id: job.id, text: "preserve login" });
    assert.equal((await employee.control({ action: "resume", id: job.id, text: "preserve login" })).duplicate, true);
    assert.equal(employee.state().tasks[0].revision, 1);
    assert.equal((await employee.execute(job.id, { action: "complete", text: "old result" })).value.ok, false, "the first new supplement must still be consumed");
    await employee.execute(job.id, { action: "progress", text: "latest requirements verified", plan: [{ content: "preserve login", status: "completed" }] });
    await employee.control({ action: "resume", id: job.id, text: "preserve login" });
    assert.equal((await employee.execute(job.id, { action: "complete", text: "verified login preserved" })).value.ok, true);
  };
  try { assert.equal((await segment(employee, job)).status, "done"); }
  finally { employee.close(); store.close(); }
});

test("supplement dedup is exact and consecutive, preserves real corrections, and supports existing tasks", async () => {
  const { store, employee } = fixture();
  const job = await task(employee);
  employee.update((state) => { Object.assign(state.tasks[0], { answer: "\n用户补充：keep A", revision: 1, planRevision: 1 }); });
  try {
    assert.equal((await employee.control({ action: "resume", id: job.id, text: "keep A" })).duplicate, true, "existing saved supplements do not require a new task");
    for (const text of ["keep A and B", "keep A"]) await employee.control({ action: "resume", id: job.id, text });
    let current = employee.task(employee.state(), job.id);
    assert.equal(current.revision, 3, "A -> B -> A is an intentional new requirement, not a duplicate");
    assert.equal(current.answer, "\n用户补充：keep A\n用户补充：keep A and B\n用户补充：keep A");
    await employee.control({ action: "stop", id: job.id });
    await employee.control({ action: "resume", id: job.id, text: "keep A" });
    assert.equal(employee.state().tasks[0].revision, 3);
    employee.update((state) => { state.tasks[0].status = "approval"; state.tasks[0].approval = "delete original data"; });
    await assert.rejects(employee.control({ action: "resume", id: job.id, text: "keep A" }), /explicit approval/);
    current = employee.task(employee.state(), job.id);
    assert.equal(current.status, "approval");
    assert.equal(current.revision, 3);
    const other = await task(employee, "other authorized work");
    const code = "  preserve login\n  keep code indentation\n";
    await employee.control({ action: "resume", id: other.id, text: code });
    const otherState = employee.task(employee.state(), other.id);
    assert.equal(otherState.revision, 1);
    assert(otherState.answer.endsWith(code), "dedup comparison must not rewrite the newly supplied content");
    await employee.control({ action: "resume", id: other.id, text: "keep A" });
    assert.equal(employee.task(employee.state(), other.id).revision, 2, "identical text on a different task is not a duplicate");
  } finally { employee.close(); store.close(); }
});

test("real executor recovery preserves committed tool outcomes and consumes each supplement once before final verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-interrupted-task-")), store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test/v1", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee, job = await task(employee, "Keep this original task", { cwd: dir });
  let phase = 0, writes = 0;
  const inputs: string[] = [];
  engine.events.on("event", (event) => { if (event.type === "tool_start" && event.data.name === "write") writes++; });
  engine.providers.chat = async (_model, _system, messages) => {
    const input = messages.findLast((message) => message.role === "user")!;
    if (inputs.at(-1) !== input.text) inputs.push(input.text!);
    if (phase++ === 0) return { role: "assistant", calls: [{ id: "write-once", name: "write", arguments: { path: "proof.txt", content: "do not repeat" } }] };
    if (phase === 2) throw new ProviderError("connection interrupted after write", 400);
    if (phase === 3) {
      assert.match(input.text!, /preserve login/);
      return { role: "assistant", text: "已收到补充，准备继续。" };
    }
    assert(!input.text!.includes("preserve login"), "the continuation must not re-acknowledge a supplement already in history");
    assert(messages.some((message) => message.role === "tool" && message.callId === "write-once"));
    if (phase === 4) return { role: "assistant", calls: [{ id: "verify", name: "employee", arguments: { action: "progress", text: "verified retained file and requirements", plan: [{ content: "preserve file and login", status: "completed" }] } }] };
    return { role: "assistant", calls: [{ id: "finish", name: "employee", arguments: { action: "complete", text: "verified original write and latest supplement; no repeated write" } }] };
  };
  try {
    let current = await segment(employee, job);
    assert.equal(current.status, "recovering");
    await employee.control({ action: "resume", id: job.id, text: "preserve login" });
    current = await segment(employee, current);
    assert.equal(current.status, "recovering");
    assert.equal((await employee.control({ action: "resume", id: job.id, text: "preserve login" })).duplicate, true);
    assert.equal(employee.state().tasks[0].revision, 1);
    current = await segment(employee, current);
    assert.equal(current.status, "done");
    assert.equal(inputs.length, 3);
    assert.equal(writes, 1);
    assert.equal(await readFile(join(dir, "proof.txt"), "utf8"), "do not repeat");
    assert.equal(store.sessions().length, 1);
    assert.equal(store.messages(current.workSession).filter((message) => message.taskInput).length, 3);
    assert.equal(store.messages(current.workSession).filter((message) => message.role === "tool" && message.callId === "write-once").length, 1);
  } finally { await engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a supplement delivered by a completion guard is not re-injected after another interruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-pending-supplement-")), store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test/v1", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee, job = await task(employee, "Original work", { cwd: dir });
  let requests = 0;
  engine.providers.chat = async (_model, _system, messages) => {
    requests++;
    if (requests === 1) {
      await employee.execute(job.id, { action: "progress", text: "old goal verified", plan: [{ content: "old goal", status: "completed" }] });
      await employee.control({ action: "resume", id: job.id, text: "latest requirement" });
      return { role: "assistant", calls: [{ id: "guard", name: "employee", arguments: { action: "complete", text: "old goal done" } }] };
    }
    if (requests === 2) throw new ProviderError("interrupted after receiving supplement", 400);
    assert(!messages.findLast((message) => message.role === "user")!.text!.includes("latest requirement"));
    assert(messages.some((message) => message.role === "tool" && message.taskInput?.answer?.includes("latest requirement")));
    await employee.execute(job.id, { action: "progress", text: "latest goal verified", plan: [{ content: "latest requirement", status: "completed" }] });
    return { role: "assistant", calls: [{ id: "finish", name: "employee", arguments: { action: "complete", text: "latest goal verified" } }] };
  };
  try {
    let current = await segment(employee, job);
    assert.equal(current.status, "recovering");
    current = await segment(employee, current);
    assert.equal(current.status, "done");
    assert.equal(requests, 3);
  } finally { await engine.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a genuinely new browser handoff is delivered even when its wording matches an earlier handoff", async () => {
  const { store, employee, runtime } = fixture();
  const job = await task(employee, "Original work");
  employee.update((state) => { Object.assign(state.tasks[0], { side: "computer", handoff: "Inspect original job-123", handoffRevision: 1 }); });
  const prompts: string[] = [];
  runtime.run = async (session, prompt, _signal, input) => {
    store.append(session, { role: "user", text: prompt, taskInput: input });
    if (store.session(session).scene === "computer") {
      prompts.push(prompt);
      store.append(session, { role: "assistant", text: "original job is still running" });
    } else await employee.execute(job.id, { action: "relay", scene: "computer", text: "Inspect original job-123" });
  };
  try {
    let current = await segment(employee, job);
    current = await segment(employee, current);
    current = await segment(employee, current);
    assert.equal(prompts.length, 2);
    assert(prompts.every((prompt) => prompt.includes("本次电脑交接：Inspect original job-123")));
    assert.equal(store.sessions().length, 2, "the browser session itself is still reused");
  } finally { employee.close(); store.close(); }
});

test("restart recovery never restarts human stops, approvals or cancellations", async () => {
  const { store, employee } = fixture();
  try {
    const jobs = await Promise.all([task(employee, "interrupted"), task(employee, "paused"), task(employee, "cancelled"), task(employee, "approval")]);
    employee.update((s) => { ["running", "stopped", "cancelled", "approval"].forEach((status, index) => s.tasks[index].status = status); });
    employee.start();
    clearTimeout(employee.timer);
    employee.closed = true;
    assert.deepEqual(employee.state().tasks.map((t) => t.status), ["recovering", "stopped", "cancelled", "approval"]);
    assert.equal(employee.task(employee.state(), jobs[0].id).recovery.attempts, 1);
    await employee.control({ action: "settings", enabled: false });
    assert.equal(employee.state().enabled, true, "legacy disable flags cannot gate employees anymore");
    assert.equal(employee.state().workStart, employee.state().workEnd);
  } finally { employee.close(); store.close(); }
});

test("orphaned runs are healed without restarting the service; a missing execution context preserves the original task", async () => {
  const { store, employee, runtime } = fixture();
  try {
    const job = await task(employee);
    employee.update((s) => { s.enabled = true; s.workStart = s.workEnd = "00:00"; s.tasks[0].status = "running"; s.tasks[0].workSession = "missing-history"; });
    employee.closed = false;
    await employee.tick();
    employee.closed = true;
    clearTimeout(employee.timer);
    let current = employee.task(employee.state(), job.id);
    assert.equal(current.status, "recovering");
    runtime.run = async (_session, prompt) => {
      assert.match(prompt, /原执行会话缺失/);
      await employee.execute(job.id, { action: "progress", text: "checked original receipt", plan: [{ content: "verify external state", status: "completed" }] });
      await employee.execute(job.id, { action: "complete", text: "original external state verified; no resubmission" });
    };
    current = await segment(employee, current);
    assert.equal(current.id, job.id);
    assert.equal(current.status, "done");
    assert.notEqual(current.workSession, "missing-history");
    assert.deepEqual(current.previousSessions, ["missing-history"]);
  } finally { employee.close(); store.close(); }
});

test("a user stop during a failing execution is never resurrected by recovery", async () => {
  const { store, employee, runtime } = fixture();
  try {
    const job = await task(employee);
    runtime.run = async () => {
      await employee.control({ action: "stop", id: job.id });
      throw Error("late provider abort");
    };
    const stopped = await segment(employee, job);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.recovery, undefined);
  } finally { employee.close(); store.close(); }
});

test("new supplements cannot be silently lost by completing an in-flight task", async () => {
  const { store, employee, runtime } = fixture();
  try {
    const job = await task(employee);
    runtime.run = async () => {
      await employee.execute(job.id, { action: "progress", text: "verified old goal", plan: [{ content: "goal", status: "completed" }] });
      await employee.control({ action: "resume", id: job.id, text: "also preserve existing login" });
      const result = await employee.execute(job.id, { action: "complete", text: "old result" });
      assert.equal(result.value.ok, false);
      assert.match(result.value.supplement, /preserve existing login/);
      await assert.rejects(employee.execute(job.id, { action: "complete", text: "old result again" }), /latest requirements/);
      await employee.execute(job.id, { action: "progress", text: "verified new goal", plan: [{ content: "goal and existing login", status: "completed" }] });
      await employee.execute(job.id, { action: "complete", text: "verified new goal and retained login" });
    };
    assert.equal((await segment(employee, job)).status, "done");
  } finally { employee.close(); store.close(); }
});

test("browser handoff preserves user supplements instead of replacing them with the browser result", async () => {
  const { store, employee, runtime } = fixture();
  try {
    const job = await task(employee);
    employee.update((s) => { s.tasks[0].side = "computer"; });
    runtime.run = async (session) => {
      await employee.control({ action: "resume", id: job.id, text: "preserve login" });
      store.append(session, { role: "assistant", text: "observed the original page" });
    };
    const current = await segment(employee, job);
    assert.equal(current.status, "queued");
    assert.equal(current.side, "work");
    assert.match(current.answer, /preserve login/);
    assert.match(current.answer, /observed the original page/);
  } finally { employee.close(); store.close(); }
});

test("one scheduler runs different employee browsers concurrently while serializing each employee browser", async () => {
  const { store, employee, runtime } = fixture();
  const release: (() => void)[] = [];
  runtime.run = async () => { await new Promise<void>((resolve) => release.push(resolve)); };
  try {
    const a = employee.for(employee.create({ name: "A" }, "alice").id);
    const b = employee.for(employee.create({ name: "B" }, "bob").id);
    for (const person of [a, b]) {
      const first = await task(person), second = await task(person);
      person.update((s) => { for (const job of s.tasks) job.side = "computer"; });
      assert.notEqual(first.id, second.id);
    }
    employee.closed = false;
    await employee.drain();
    assert.equal(a.busy.size, 1);
    assert.equal(b.busy.size, 1);
    assert.equal(release.length, 2);
    employee.close();
    release.forEach((resolve) => resolve());
    for (let i = 0; i < 20 && (a.busy.size || b.busy.size); i++) await sleep(5);
  } finally { employee.close(); store.close(); }
});

test("one employee starts independent tasks in the same directory concurrently within the existing global capacity", async () => {
  const { store, employee, runtime } = fixture();
  const release: (() => void)[] = [];
  runtime.run = async () => { await new Promise<void>(resolve => release.push(resolve)); };
  try {
    for (let index = 0; index < 4; index++) await task(employee, "independent task " + index);
    employee.closed = false;
    await employee.drain();
    assert.equal(employee.busy.size, 3);
    assert.equal(release.length, 3);
    assert.equal(employee.state().tasks.filter(task => task.status === "queued").length, 1);
    assert.equal(new Set(employee.state().tasks.filter(task => task.workSession).map(task => task.workSession)).size, 3);
    employee.close(); release.forEach(resolve => resolve());
    for (let index = 0; index < 20 && employee.busy.size; index++) await sleep(5);
  } finally { employee.close(); store.close(); }
});

test("directory aliases cannot bypass the shared lock when actual workspace writes are requested", async () => {
  const { store, employee } = fixture();
  try {
    const a = employee.for(employee.create({ name: "A", cwd: process.cwd() }, "alice").id);
    const b = employee.for(employee.create({ name: "B", cwd: process.cwd() + "/." }, "bob").id);
    const first = await task(a), second = await task(b);
    for (const person of [a, b]) person.update(state => { state.tasks[0].status = "running"; });
    const sessionA = store.newSession({ taskId: first.id, employeeId: a.employeeId, cwd: process.cwd() });
    const sessionB = store.newSession({ taskId: second.id, employeeId: b.employeeId, cwd: process.cwd() + "/." });
    assert.equal(await a.claimWorkspace(sessionA, true), true);
    assert.equal(await b.claimWorkspace(sessionB, true), false);
    assert.equal(employee.writers.size, 1);
    assert.equal(b.state().tasks[0].status, "queued");
    assert.match(b.state().tasks[0].queueReason, /本步未执行/);
    assert.equal(b.state().tasks[0].recovery, undefined, "contention does not spend the recovery budget");
    a.releaseWorkspace(first.id);
    b.update(state => { state.tasks[0].status = "running"; delete state.tasks[0].workspaceWait; });
    assert.equal(await b.claimWorkspace(sessionB, true), true);
    b.releaseWorkspace(second.id);
    assert.equal(employee.writers.size, 0);
  } finally { employee.close(); store.close(); }
});

test("workspace leases distinguish execution devices and release transient commands without releasing a code-write phase", async () => {
  const { store, employee } = fixture();
  try {
    const jobs = await Promise.all([task(employee, "client A"), task(employee, "client B"), task(employee, "client A other task")]);
    employee.update(state => { for (const task of state.tasks) task.status = "running"; });
    const sessions = jobs.map((job, index) => store.newSession({ taskId: job.id, employeeId: employee.employeeId, cwd: "/project", localAgent: true, clientId: index === 1 ? "b" : "a", localPlatform: "linux" }));
    assert.equal(await employee.claimWorkspace(sessions[0]), true);
    assert.equal(await employee.claimWorkspace(sessions[1], true), true);
    assert.equal(await employee.claimWorkspace(sessions[2]), false);
    assert.equal(employee.writers.size, 2);
    employee.releaseWorkspace(jobs[0].id, true);
    assert.equal(employee.writers.size, 1);
    employee.releaseWorkspace(jobs[1].id, true);
    assert.equal(employee.writers.size, 1, "coding/write leases outlive individual commands");
    employee.releaseWorkspace(jobs[1].id);
    assert.equal(employee.writers.size, 0);
  } finally { employee.close(); store.close(); }
});

test("employee browser copies bind only their authenticated private bridge; profiles and experience namespaces are separate", async () => {
  const source = await readFile("extensions/nova-chrome/worker.js", "utf8");
  const worker = privateWorker(source, { port: 54321, token: "private-token" });
  assert.match(worker, /connect\("http:\/\/127\.0\.0\.1:54321"\)/);
  assert(!worker.includes("for (let port=47653"));
  assert.match(worker, /Bearer private-token/);
  assert.throws(() => privateWorker("changed protocol", { port: 1, token: "x" }), /protocol changed/);
  const bridge = new ChromeBridge(true);
  await bridge.start();
  try {
    const req = (authorization?: string) => fetch(`http://127.0.0.1:${bridge.port}/pair`, { method: "POST", headers: { Origin: "chrome-extension://mdicifjlbgnkkdkcbfdnebeghhlamjbm", ...(authorization ? { Authorization: authorization } : {}) } });
    assert.equal((await req()).status, 400);
    assert.equal((await req("Bearer " + bridge.token)).status, 200);
  } finally { bridge.close(); }
  const store = new Store(":memory:"), browsers = new EmployeeBrowsers(store, "");
  assert.notEqual(browsers.profile("ea"), browsers.profile("eb"));
  assert.throws(() => browsers.profile("../escape"), /Invalid/);
  await browsers.close();
  store.close();
});

test("real independent employee Chromium instances retain private cookies across restarts", { skip: process.env.VEGA_TEST_EMPLOYEE_BROWSER !== "1", timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-employees-")), old = process.env.VEGA_DB;
  process.env.VEGA_DB = join(dir, "state.db");
  const store = new Store(":memory:"), browsers = new EmployeeBrowsers(store, await readFile("server/assets/browser/browser-page.js", "utf8"));
  const server = createServer((_req, res) => res.end("<!doctype html><title>employee isolation</title><p>ready</p>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const [a, b] = await Promise.all([browsers.get("ea"), browsers.get("eb")]);
    assert.notEqual(a.bridge.port, b.bridge.port);
    assert.notEqual(browsers.entries.get("ea")!.browser.child!.pid, browsers.entries.get("eb")!.browser.child!.pid);
    const openedA = await a.execute("a", dir, { operation: "new_tab", url });
    const openedB = await b.execute("b", dir, { operation: "new_tab", url });
    await a.execute("a", dir, { operation: "evaluate", tabTag: openedA.tabTag, expression: "document.cookie='employee=A; max-age=3600; path=/'", feedback: "none" });
    const cookie = await b.execute("b", dir, { operation: "evaluate", tabTag: openedB.tabTag, expression: "document.cookie", feedback: "none" });
    assert(!JSON.stringify(cookie).includes("employee=A"));
    await browsers.stop("ea");
    const resumed = await browsers.get("ea");
    const tab = await resumed.execute("a", dir, { operation: "new_tab", url });
    const restored = await resumed.execute("a", dir, { operation: "evaluate", tabTag: tab.tabTag, expression: "document.cookie", feedback: "none" });
    assert(JSON.stringify(restored).includes("employee=A"));
  } finally {
    await browsers.close();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (old === undefined) delete process.env.VEGA_DB; else process.env.VEGA_DB = old;
    await rm(dir, { recursive: true, force: true });
  }
});
