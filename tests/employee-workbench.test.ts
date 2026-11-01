import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
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
