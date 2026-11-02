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

test("employees isolate state, business keys, conversations, credentials and owner access; legacy state stays default", async () => {
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
    assert.deepEqual((await a.execute("", { action: "vault_list" })).value.entries, []);
    await assert.rejects(a.execute("", { action: "vault_get", id: secret.id, text: "test" }), /not granted/);
    await a.control({ action: "settings", vaultIds: [secret.id] });
    assert.equal((await a.execute("", { action: "vault_list" })).value.entries.length, 1);
    assert.equal((await b.execute("", { action: "vault_list" })).value.entries.length, 0);
    const reopened = new Employee(store, vault, employee.runtime);
    assert.equal(reopened.for(a.employeeId).state().memories[0].text, "A-only");
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
    assert(!definitions.some((tool) => ["bash", "write", "edit", "mcp", "switch_scene"].includes(tool.name)));
    const close = Tools.prototype.close;
    try {
      Tools.prototype.close = async () => { throw Error("cleanup failed"); };
      await assert.rejects(engine.run(session.id, { role: "user", text: "explain status" }), /cleanup failed/);
      assert.equal(engine.active.size, 0, "cleanup failures must not leave a permanently running executor");
      assert.equal(engine.redactors.size, 0);
    } finally { Tools.prototype.close = close; }
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
    assert.equal(current.status, "waiting");
    assert.equal(current.recovery.attempts, 3);
    const reopened = new Employee(store, employee.vault, runtime);
    assert.equal(reopened.state().tasks[0].recovery.attempts, 3);
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

test("repeated interruption without new evidence trips a durable breaker; acknowledgements and repeated planning do not count as progress", async () => {
  const { store, employee, runtime } = fixture();
  const job = await task(employee);
  employee.chat("owner");
  let attempts = 0;
  runtime.run = async (session, prompt, _signal, input) => {
    attempts++;
    store.append(session, { role: "user", text: prompt, taskInput: input });
    store.append(session, { role: "assistant", text: "已收到补充，准备继续。" });
    await employee.execute(job.id, { action: "progress", text: "starting again", plan: [{ content: "verify the target", status: "in_progress" }] });
    store.append(session, { role: "assistant", calls: [{ id: "plan-" + attempts, name: "employee", arguments: { action: "progress" } }] });
    store.append(session, { role: "tool", name: "employee", callId: "plan-" + attempts, text: '{"ok":true}' });
    throw Error("connection interrupted");
  };
  try {
    let current = await segment(employee, job);
    const firstCheck = current.nextCheckAt;
    current = await segment(employee, current);
    assert(current.nextCheckAt > firstCheck, "consecutive faults back off instead of immediately spinning");
    current = await segment(employee, current);
    assert.equal(current.status, "waiting");
    assert.equal(current.recovery.stalled, 3);
    assert.equal(current.nextCheckAt, 0);
    assert.match(current.waiting, /连续.*无.*进展/);
    assert.match(store.messages(employee.state().chatSession!).at(-1)!.text!, /需要你处理/);
    const reopened = new Employee(store, employee.vault, runtime);
    reopened.closed = true;
    assert.equal(reopened.state().tasks[0].recovery.stalled, 3);
    await employee.control({ action: "answer", id: job.id, text: "connection fixed, continue original work" });
    assert.equal(employee.state().tasks[0].recovery, undefined);
    assert.equal(employee.state().tasks[0].workSession, current.workSession);
  } finally { employee.close(); store.close(); }
});

test("only new successful tool evidence or newly verified plan steps reset the consecutive-stall counter, not the total recovery budget", async () => {
  const { store, employee } = fixture();
  const job = await task(employee), session = store.newSession({ taskId: job.id });
  job.workSession = session.id;
  const evidence = (id: string, path: string, error = false) => {
    store.append(session.id, { role: "assistant", calls: [{ id, name: "read", arguments: { path } }] });
    store.append(session.id, { role: "tool", name: "read", callId: id, text: "same observed state", error });
  };
  try {
    employee.recover(job, "interrupted", 1000);
    assert.equal(job.recovery.stalled, 1);
    evidence("first", "one");
    employee.recover(job, "interrupted", 2000);
    assert.equal(job.recovery.stalled, 0);
    evidence("repeated", "one");
    evidence("failed", "two", true);
    employee.recover(job, "interrupted", 3000);
    assert.equal(job.recovery.stalled, 1, "new call IDs and failed calls are not new successful evidence");
    job.plan = [{ content: "verify original state", status: "completed" }];
    employee.recover(job, "interrupted", 4000);
    assert.equal(job.recovery.stalled, 0);
    assert.equal(job.recovery.attempts, 4);
    assert.equal(job.status, "waiting", "real progress does not allow unlimited automatic retries");
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

test("directory aliases cannot bypass the shared writer lock", async () => {
  const { store, employee, runtime } = fixture();
  const release: (() => void)[] = [];
  runtime.run = async () => { await new Promise<void>((resolve) => release.push(resolve)); };
  try {
    const a = employee.for(employee.create({ name: "A", cwd: process.cwd() }, "alice").id);
    const b = employee.for(employee.create({ name: "B", cwd: process.cwd() + "/." }, "bob").id);
    await task(a); await task(b);
    employee.closed = false;
    await employee.drain();
    assert.equal(a.busy.size + b.busy.size, 1);
    employee.close();
    release.forEach((resolve) => resolve());
    for (let index = 0; index < 20 && (a.busy.size || b.busy.size); index++) await sleep(5);
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
