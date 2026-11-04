import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionDirectory } from "../server/core/headless";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Auth } from "../server/core/auth";
import { Tools } from "../server/core/tools";
import { employeeCall } from "./public-call";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  return { store, engine };
}
async function add(employee: Engine["employee"], text = "work") {
  const created = await employee.execute("", { action: "add", kind: "todo", text });
  return employee.task(employee.state(), created.value.id);
}

test("browser extension is resolved from source or packaged assets, never the workspace cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-extension-layout-"));
  try {
    for (const [asset, module, entry] of [
      ["source/extensions/nova-chrome", "source/server/core/headless.ts", "source/server/index.ts"],
      ["built/.output/public/extension/nova-chrome", "built/.output/server/chunks/_/nitro.mjs", "built/.output/server/index.mjs"],
      ["container/extension", "container/.output/server/chunks/_/nitro.mjs", "container/.output/server/index.mjs"],
    ]) {
      const path = join(dir, asset);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "manifest.json"), "{}");
      await writeFile(join(path, "worker.js"), "// fixture");
      assert.equal(extensionDirectory(pathToFileURL(join(dir, module)).href, join(dir, entry)), path);
    }
    assert.throws(() => extensionDirectory(pathToFileURL(join(dir, "missing/core/module.js")).href, join(dir, "missing/main.mjs")), /完整部署/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("team employees are visible to everyone; personal employees and management stay scoped", async () => {
  const { store, engine } = fixture(), auth = new Auth(store, "test-token-at-least-16-characters");
  try {
    const team = engine.employee.for(engine.employee.create({ name: "Team" }, "admin", "team").id);
    const personal = engine.employee.for(engine.employee.create({ name: "Private" }, "alice").id);
    const alice = { id: "alice", role: "operator" } as any, bob = { id: "bob", role: "operator" } as any, viewer = { id: "viewer", role: "viewer" } as any, admin = { id: "admin", role: "admin" } as any;
    for (const user of [alice, bob, viewer, admin]) assert(team.accessible(user));
    for (const user of [alice, bob, viewer]) assert(!team.manageable(user));
    assert(team.manageable(admin));
    assert(personal.accessible(alice) && personal.accessible(admin));
    assert(!personal.accessible(bob) && !personal.accessible(viewer));
    const teamSession = team.chat("admin"), privateSession = personal.chat("alice");
    assert(auth.canRead(viewer, teamSession));
    assert(auth.canRead(bob, teamSession));
    assert(!auth.canRead(bob, privateSession));
    assert(!auth.canWrite(viewer, teamSession));
    assert.equal(engine.employee.state().scope, "team", "the legacy default employee migrates to the team group");
  } finally { await engine.close(); store.close(); }
});

test("team chat management uses the current sender, not the employee owner or a previous administrator", async () => {
  const { store, engine } = fixture();
  try {
    const insert = store.db.prepare("INSERT INTO web_users(id,username,password,role,disabled,createdAt,lastLogin) VALUES(?,?,?,?,0,0,0)");
    insert.run("admin", "admin", "fixture", "admin");
    insert.run("member", "member", "fixture", "operator");
    const employee = engine.employee.for(engine.employee.create({ name: "Team" }, "admin", "team").id);
    const session = employee.chat("admin");
    const tools = new Tools(engine, session, engine.config(), new AbortController().signal, () => {});
    const action = (name: string) => tools.definitions({} as any).some((tool) => tool.name === ({ add: "employee_task_create" } as Record<string, string>)[name] || tool.name === name);
    tools.actorId = "admin";
    assert(action("memory_propose") && action("add"));
    await tools.execute({ id: "remember", ...employeeCall({ action: "memory_propose", claim: "Use this workflow", source: "ui" }) }, {} as any);
    await tools.execute({ id: "duty", ...employeeCall({ action: "add", kind: "duty", text: "Weekly review", manual: true }) }, {} as any);
    assert.equal(employee.state().duties.length, 1);
    tools.actorId = "member";
    assert(!action("memory_propose") && !action("vault_get"));
    await assert.rejects(tools.execute({ id: "denied", ...employeeCall({ action: "memory_propose", claim: "untrusted change", source: "ui" }) }, {} as any), /Tool unavailable/);
    await assert.rejects(tools.execute({ id: "denied-duty", name: "employee_duty_create", arguments: { instructions: "x", trigger: { kind: "manual" } } }, {} as any), /Tool unavailable/);
    const work = await tools.execute({ id: "work", ...employeeCall({ action: "add", kind: "todo", text: "authorized work" }) }, {} as any);
    await assert.rejects(tools.execute({ id: "denied-edit", name: "employee_task_manage", arguments: { taskId: work.value.id, request: { command: "set_instructions", instructions: "changed" } } }, {} as any), /command 只能是 "resume" \/ "answer" \/ "stop"/);
    assert.equal(employee.state().duties.length, 1);
    assert.equal(employee.task(employee.state(), work.value.id).text, "authorized work");
    tools.actorId = "admin";
    store.db.prepare("UPDATE web_users SET role='operator' WHERE id='admin'").run();
    assert(!action("memory_propose"), "revoked management cannot survive in a cached conversation");
    tools.actorId = undefined;
    assert(!action("memory_propose"), "owner identity is never a fallback for a shared conversation");
  } finally { await engine.close(); store.close(); }
});

test("employees are immediately available even with legacy disabled hours; duty triggers still control due dates", async () => {
  const { store, engine } = fixture();
  try {
    engine.employee.update((state) => { state.enabled = false; state.workStart = "23:58"; state.workEnd = "23:59"; });
    assert.equal(engine.employee.state().enabled, true);
    assert.equal(engine.employee.state().workStart, "00:00");
    const employee = engine.employee.for(engine.employee.create({ name: "Ready" }, "alice").id);
    const duty = await employee.execute("", { action: "add", kind: "duty", text: "manual work", manual: true });
    engine.employee.closed = false;
    await employee.tick();
    engine.employee.closed = true;
    assert.equal(employee.state().tasks.length, 0);
    assert(employee.state().duties.some((row) => row.id === duty.value.id));
    const job = await add(employee);
    assert.equal(job.status, "queued");
  } finally { await engine.close(); store.close(); }
});

test("switching employee execution defaults never changes old, running, resumed or child tasks", async () => {
  const { store, engine } = fixture();
  const client = { instance: "a".repeat(32), clientId: "d".repeat(32), name: "Office PC", cwd: "C:\\client-only", platform: "windows" };
  try {
    const employee = engine.employee.for(engine.employee.create({ name: "Developer" }, "alice").id);
    const original = await add(employee, "server work");
    const session = store.newSession({ employeeId: employee.employeeId, taskId: original.id, cwd: original.cwd, ownerId: "alice" });
    employee.update((state) => { state.tasks[0].workSession = session.id; state.tasks[0].status = "running"; });
    employee.busy.set(original.id, { session: session.id, computer: false });
    engine.active.set(session.id, { control: new AbortController(), steer: [] });
    engine.localAgents.connect("alice", client);
    engine.localAgents.request = async (_agent, op, args) => { assert.equal(op, "file"); assert.equal(args.op, "stat"); return { isDir: true, path: args.path }; };
    await engine.switchEmployeeExecution(employee.employeeId, true, client.clientId, "alice");
    assert.equal(store.session(session.id).localAgent, undefined);
    assert.equal(engine.active.has(session.id), true);
    assert.equal(employee.state().tasks[0].execution?.localAgent, undefined);
    const local = await add(employee, "client work");
    assert.equal(local.execution?.clientId, client.clientId);
    assert.equal(local.cwd, client.cwd);
    const child = await employee.execute(original.id, { action: "add", kind: "todo", text: "child inherits server" });
    assert.equal(employee.task(employee.state(), child.value.id).execution?.localAgent, undefined);
    await engine.switchEmployeeExecution(employee.employeeId, false, undefined, "alice");
    assert.equal(employee.task(employee.state(), local.id).execution?.clientId, client.clientId);
    assert.equal(employee.task(employee.state(), local.id).cwd, client.cwd);
    engine.active.delete(session.id); employee.busy.clear();
    employee.update((state) => { state.tasks.find((task) => task.id === local.id)!.status = "stopped"; });
    await employee.control({ action: "resume", id: local.id });
    assert.equal(employee.task(employee.state(), local.id).execution?.clientId, client.clientId);
    const localTask = employee.task(employee.state(), local.id);
    employee.update((state) => { state.tasks.find((task) => task.id === local.id)!.status = 'running'; });
    employee.busy.set(local.id, { session: '', computer: false });
    const originalRun = employee.runtime.run;
    employee.runtime.run = async (sessionId) => {
      const actual = store.session(sessionId);
      assert.equal(actual.localAgent, true);
      assert.equal(actual.clientId, client.clientId);
      assert.equal(actual.cwd, client.cwd);
      await employee.execute(local.id, { action: 'progress', text: 'verified on original client', plan: [{ content: 'check target', status: 'completed' }] });
      await employee.execute(local.id, { action: 'complete', text: 'verified on original client' });
    };
    await employee.run(localTask);
    employee.runtime.run = originalRun;
    engine.localAgents.disconnect("alice");
    const before = employee.state();
    await assert.rejects(engine.switchEmployeeExecution(employee.employeeId, true, client.clientId, "alice"), /未连接/);
    assert.deepEqual(employee.state(), before);
  } finally { engine.active.clear(); engine.employee.all().forEach((employee) => employee.busy.clear()); await engine.close(); store.close(); }
});

test("employee deletion removes its sessions/profile and its own vault and survives restart without deleting project files or other employees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-delete-employee-")), previous = process.env.VEGA_DB;
  process.env.VEGA_DB = join(dir, "database.db");
  const { store, engine } = fixture();
  try {
    const a = engine.employee.for(engine.employee.create({ name: "Remove", cwd: dir }, "alice").id), b = engine.employee.for(engine.employee.create({ name: "Keep", cwd: dir }, "alice").id);
    const job = await add(a), chat = a.chat("alice");
    const legacy = store.newSession({ taskId: job.id, employeeId: a.employeeId, cwd: dir });
    a.update((state) => { state.tasks[0].workSession = legacy.id; });
    store.append(legacy.id, { role: "assistant", text: "private record" });
    const profile = engine.browsers.profile(a.employeeId);
    await mkdir(profile, { recursive: true }); await writeFile(join(profile, "Cookies"), "private");
    await writeFile(join(dir, "project.txt"), "keep");
    const credential = a.vault.save({ name: "removed with A", condition: "authorized", content: "gone" }), kept = b.vault.save({ name: "B own", condition: "authorized", content: "keep" });
    const temp = a.vault.request(job.id) && job.id;
    engine.active.set(chat.id, { control: new AbortController(), steer: [] });
    await assert.rejects(engine.removeEmployee(a.employeeId), /先停止/);
    assert.equal(a.deleting, false);
    engine.active.clear();
    await engine.removeEmployee(a.employeeId);
    assert.throws(() => engine.employee.for(a.employeeId), /not found/);
    assert.throws(() => store.session(chat.id), /not found/);
    assert.throws(() => store.session(legacy.id), /not found/);
    await assert.rejects(access(profile));
    assert.equal(await readFile(join(dir, "project.txt"), "utf8"), "keep");
    assert.deepEqual(store.objects(a.vault.kind), [], "deleting an employee deletes its own vault");
    assert.equal(store.object("vault-request", temp), undefined);
    assert(!b.vault.list().some((entry) => entry.id === credential.id));
    assert.deepEqual(b.vault.list().map((entry) => entry.id), [kept.id]);
    assert.equal(engine.employee.for(b.employeeId).state().name, "Keep");
    await engine.removeEmployee("default");
    assert(!engine.employee.all().some((employee) => employee.employeeId === "default"));
    engine.employee.start(); engine.employee.close();
    assert(!engine.employee.all().some((employee) => employee.employeeId === "default"));
    await assert.rejects(engine.browsers.get(a.employeeId), /deleted/);
    assert.throws(() => a.update(() => {}), /being deleted/i);
  } finally {
    engine.active.clear(); await engine.close(); store.close();
    if (previous === undefined) delete process.env.VEGA_DB; else process.env.VEGA_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("set_manual clears the old trigger wording, and a task can reschedule only itself", async () => {
  const { store, engine } = fixture();
  try {
    const employee = engine.employee.for(engine.employee.create({ name: "Planner" }, "alice").id);
    const duty = await employee.execute("", { action: "add", kind: "duty", text: "report", times: ["09:00"], condition: "每天 9 点" });
    const owner = new Tools(engine, employee.chat("alice"), engine.config(), new AbortController().signal, () => {});
    owner.actorId = "alice";
    await owner.execute({ id: "m", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "set_manual" } } }, {} as any);
    const row = employee.state().duties.find((d) => d.id === duty.value.id)!;
    assert.equal(row.manual, true);
    assert.equal(row.condition, undefined, "a stale condition would keep describing the old schedule");
    assert.deepEqual(row.times, []);

    const job = await add(employee, "call back later");
    const other = await add(employee, "someone else");
    const session = store.newSession({ employeeId: employee.employeeId, taskId: job.id, cwd: job.cwd, ownerId: "alice" });
    employee.update((state) => { state.tasks.find((t) => t.id === job.id)!.status = "running"; state.tasks.find((t) => t.id === job.id)!.workSession = session.id; });
    employee.busy.set(job.id, { session: session.id, computer: false });
    const tools = new Tools(engine, session, engine.config(), new AbortController().signal, () => {});
    assert(tools.definitions({} as any).some((t) => t.name === "task_reschedule"));
    const before = Date.now();
    await tools.execute({ id: "r", name: "task_reschedule", arguments: { delayMinutes: 90 } }, {} as any);
    const moved = employee.task(employee.state(), job.id);
    assert.equal(moved.status, "deferred");
    assert(moved.nextCheckAt >= before + 89 * 60_000 && moved.nextCheckAt <= Date.now() + 91 * 60_000);
    assert.equal(employee.task(employee.state(), other.id).status, "queued", "other tasks are untouched");
  } finally { await engine.close(); store.close(); }
});

test("one update changes several aspects together, with the old executor's semantics", async () => {
  const { store, engine } = fixture();
  try {
    const employee = engine.employee.for(engine.employee.create({ name: "Multi" }, "alice").id);
    const tools = new Tools(engine, employee.chat("alice"), engine.config(), new AbortController().signal, () => {});
    tools.actorId = "alice";
    const duty = await employee.execute("", { action: "add", kind: "duty", text: "old", manual: true });
    await tools.execute({ id: "u", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: {
      command: "update", instructions: "new work", note: "细化", profile: "编码", trigger: { kind: "interval", everyMinutes: 30 } } } }, {} as any);
    let row = employee.state().duties.find((d) => d.id === duty.value.id)!;
    assert.deepEqual([row.text, row.note, row.profile, row.manual, row.everyMinutes], ["new work", "细化", "coding", false, 30]);
    await tools.execute({ id: "d", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "update", trigger: { kind: "daily", times: ["09:00"] } } } }, {} as any);
    row = employee.state().duties.find((d) => d.id === duty.value.id)!;
    assert.deepEqual([row.everyMinutes, row.times], [0, ["09:00"]], "switching kinds resets the competing rule");
    await tools.execute({ id: "n", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "update", trigger: { kind: "dynamic", delayMinutes: 15 } } } }, {} as any);
    row = employee.state().duties.find((d) => d.id === duty.value.id)!;
    assert(!row.manual && !row.everyMinutes && !row.times.length && row.nextCheckAt > Date.now());

    // Like the old update, an invalid part rejects the whole call.
    const before = JSON.stringify(row);
    await assert.rejects(tools.execute({ id: "bad", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "update", instructions: "x", profile: "电脑" } } }, {} as any));
    assert.equal(JSON.stringify(employee.state().duties.find((d) => d.id === duty.value.id)), before);

    // Like master, set_daily keeps the old condition wording; only set_manual clears it.
    const worded = await employee.execute("", { action: "add", kind: "duty", text: "w", everyMinutes: 60, condition: "每小时" });
    await tools.execute({ id: "sd", name: "employee_duty_manage", arguments: { dutyId: worded.value.id, request: { command: "set_daily", times: ["10:00"] } } }, {} as any);
    assert.equal(employee.state().duties.find((d) => d.id === worded.value.id)!.condition, "每小时");

    const job = await add(employee, "old task");
    await tools.execute({ id: "t", name: "employee_task_manage", arguments: { taskId: job.id, request: { command: "update", instructions: "new task", profile: "coding", delayMinutes: 60 } } }, {} as any);
    const moved = employee.task(employee.state(), job.id);
    assert.deepEqual([moved.text, moved.profile, moved.status], ["new task", "coding", "queued"]);
    assert(moved.nextCheckAt > Date.now() + 59 * 60_000);
    await assert.rejects(tools.execute({ id: "past", name: "employee_task_manage", arguments: { taskId: job.id, request: { command: "update", instructions: "zzz", runAt: "2001-01-01 09:00" } } }, {} as any), /未来/);
    assert.equal(employee.task(employee.state(), job.id).text, "new task", "the executor applies all parts or none");
  } finally { await engine.close(); store.close(); }
});
