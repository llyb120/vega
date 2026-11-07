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

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  return { store, engine };
}
async function add(employee: Engine["employee"], text = "work") {
  const created = await employee.execute("", { action: "add", kind: "todo", text });
  return employee.task(await employee.state(), created.value.id);
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

test("employees belong to their owner: only the owner and administrators see or manage them", async () => {
  const { store, engine } = await fixture(), auth = new Auth(store, "test-token-at-least-16-characters");
  try {
    const mine = await engine.employee.for((await engine.employee.create({ name: "Admin's" }, "admin")).id);
    const personal = await engine.employee.for((await engine.employee.create({ name: "Private" }, "alice")).id);
    const alice = { id: "alice", role: "operator" } as any, bob = { id: "bob", role: "operator" } as any, viewer = { id: "viewer", role: "viewer" } as any, admin = { id: "admin", role: "admin" } as any;
    for (const user of [alice, bob, viewer]) assert(!await mine.accessible(user) && !await mine.manageable(user));
    assert(await mine.manageable(admin));
    assert(await personal.accessible(alice) && await personal.manageable(alice) && await personal.accessible(admin));
    assert(!await personal.accessible(bob) && !await personal.accessible(viewer));
    const privateSession = await personal.chat("alice");
    assert(await auth.canRead(alice, privateSession) && await auth.canRead(admin, privateSession));
    assert(!await auth.canRead(bob, privateSession) && !await auth.canRead(viewer, privateSession));
    assert.equal("scope" in await engine.employee.state(), false, "there is no team scope any more");
  } finally { await engine.close(); await store.close(); }
});

test("employees are immediately available even with legacy disabled hours; duty triggers still control due dates", async () => {
  const { store, engine } = await fixture();
  try {
    await engine.employee.update((state) => { state.enabled = false; state.workStart = "23:58"; state.workEnd = "23:59"; });
    assert.equal((await engine.employee.state()).enabled, true);
    assert.equal((await engine.employee.state()).workStart, "00:00");
    const employee = await engine.employee.for((await engine.employee.create({ name: "Ready" }, "alice")).id);
    const duty = await employee.execute("", { action: "add", kind: "duty", text: "manual work", manual: true });
    engine.employee.closed = false;
    await employee.tick();
    engine.employee.closed = true;
    assert.equal((await employee.state()).tasks.length, 0);
    assert((await employee.state()).duties.some((row) => row.id === duty.value.id));
    const job = await add(employee);
    assert.equal(job.status, "queued");
  } finally { await engine.close(); await store.close(); }
});

test("switching employee execution defaults never changes old, running, resumed or child tasks", async () => {
  const { store, engine } = await fixture();
  const client = { instance: "a".repeat(32), clientId: "d".repeat(32), name: "Office PC", cwd: "C:\\client-only", platform: "windows" };
  try {
    const employee = await engine.employee.for((await engine.employee.create({ name: "Developer" }, "alice")).id);
    const original = await add(employee, "server work");
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: original.id, cwd: original.cwd, ownerId: "alice" });
    await employee.update((state) => { state.tasks[0].workSession = session.id; state.tasks[0].status = "running"; });
    employee.busy.set(original.id, { session: session.id, computer: false });
    engine.active.set(session.id, { control: new AbortController(), steer: [] });
    engine.localAgents.connect("alice", client);
    engine.localAgents.request = async (_agent, op, args) => { assert.equal(op, "file"); assert.equal(args.op, "stat"); return { isDir: true, path: args.path }; };
    const preferClient = await engine.switchEmployeeExecution(employee.employeeId, "client", "alice");
    assert.equal(preferClient.clientOnline, true);
    assert.equal((await store.session(session.id)).localAgent, undefined);
    assert.equal(engine.active.has(session.id), true);
    assert.equal((await employee.state()).tasks[0].execution?.localAgent, false);
    const local = await add(employee, "client work");
    assert.equal(local.execution?.clientId, client.clientId);
    assert.equal(local.cwd, client.cwd);
    assert.equal(local.execution?.localBrowser, true, "客户端优先默认让浏览器跟随到本机");
    // 显式选云端浏览器：任务仍在本机，浏览器位置在云端（访问本地服务走流量中继）。
    await engine.switchEmployeeExecution(employee.employeeId, "client", "alice", "cloud");
    const cloudBrowserTask = await add(employee, "client work with cloud browser");
    assert.equal(cloudBrowserTask.execution?.localAgent, true);
    assert.equal(cloudBrowserTask.execution?.localBrowser, false);
    await engine.switchEmployeeExecution(employee.employeeId, "client", "alice", "follow");
    const child = await employee.execute(original.id, { action: "add", kind: "todo", text: "child inherits server" });
    assert.equal(employee.task(await employee.state(), child.value.id).execution?.localAgent, false);
    await engine.switchEmployeeExecution(employee.employeeId, "cloud", "alice");
    assert.equal(employee.task(await employee.state(), local.id).execution?.clientId, client.clientId);
    assert.equal(employee.task(await employee.state(), local.id).cwd, client.cwd);
    engine.active.delete(session.id); employee.busy.clear();
    await employee.update((state) => { state.tasks.find((task) => task.id === local.id)!.status = "stopped"; });
    await employee.control({ action: "resume", id: local.id });
    assert.equal(employee.task(await employee.state(), local.id).execution?.clientId, client.clientId);
    const localTask = employee.task(await employee.state(), local.id);
    await employee.update((state) => { state.tasks.find((task) => task.id === local.id)!.status = 'running'; });
    employee.busy.set(local.id, { session: '', computer: false });
    const originalRun = employee.runtime.run;
    employee.runtime.run = async (sessionId) => {
      const actual = await store.session(sessionId);
      assert.equal(actual.localAgent, true);
      assert.equal(actual.clientId, client.clientId);
      assert.equal(actual.cwd, client.cwd);
      await employee.execute(local.id, { action: 'progress', text: 'verified on original client', plan: [{ content: 'check target', status: 'completed' }] });
      await employee.execute(local.id, { action: 'complete', text: 'verified on original client' });
    };
    await employee.run(localTask);
    employee.runtime.run = originalRun;
    engine.localAgents.disconnect("alice");
    // 客户端离线也能改策略（策略不是设备绑定）；新任务落到服务端并说明原因。
    const offline = await engine.switchEmployeeExecution(employee.employeeId, "client", "alice");
    assert.equal(offline.clientOnline, false);
    const offlineTask = await add(employee, "client prefer without client");
    assert.equal(offlineTask.execution?.localAgent, false);
    assert.match(offlineTask.checkpoint || "", /客户端优先，但当前没有在线的客户端/);
  } finally { engine.active.clear(); (await engine.employee.all()).forEach((employee) => employee.busy.clear()); await engine.close(); await store.close(); }
});

test("employee deletion removes its sessions/profile and its own vault and survives restart without deleting project files or other employees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-delete-employee-")), previous = process.env.VEGA_DB;
  process.env.VEGA_DB = join(dir, "database.db");
  const { store, engine } = await fixture();
  try {
    const a = await engine.employee.for((await engine.employee.create({ name: "Remove", cwd: dir }, "alice")).id), b = await engine.employee.for((await engine.employee.create({ name: "Keep", cwd: dir }, "alice")).id);
    const job = await add(a), chat = await a.chat("alice");
    const legacy = await store.newSession({ taskId: job.id, employeeId: a.employeeId, cwd: dir });
    await a.update((state) => { state.tasks[0].workSession = legacy.id; });
    await store.append(legacy.id, { role: "assistant", text: "private record" });
    const profile = engine.browsers.profile(a.employeeId);
    await mkdir(profile, { recursive: true }); await writeFile(join(profile, "Cookies"), "private");
    await writeFile(join(dir, "project.txt"), "keep");
    const credential = await a.vault.save({ name: "removed with A", condition: "authorized", content: "gone" }), kept = await b.vault.save({ name: "B own", condition: "authorized", content: "keep" });
    engine.active.set(chat.id, { control: new AbortController(), steer: [] });
    await assert.rejects(engine.removeEmployee(a.employeeId), /先停止/);
    assert.equal(a.deleting, false);
    engine.active.clear();
    await engine.removeEmployee(a.employeeId);
    await assert.rejects(async () => await engine.employee.for(a.employeeId), /not found/);
    await assert.rejects(async () => await store.session(chat.id), /not found/);
    await assert.rejects(async () => await store.session(legacy.id), /not found/);
    await assert.rejects(access(profile));
    assert.equal(await readFile(join(dir, "project.txt"), "utf8"), "keep");
    assert.deepEqual(await store.objects(a.vault.kind), [], "deleting an employee deletes its own vault");
    assert(!(await b.vault.list()).some((entry) => entry.id === credential.id));
    assert.deepEqual((await b.vault.list()).map((entry) => entry.id), [kept.id]);
    assert.equal((await (await engine.employee.for(b.employeeId)).state()).name, "Keep");
    await engine.removeEmployee("default");
    assert(!(await engine.employee.all()).some((employee) => employee.employeeId === "default"));
    await engine.employee.start(); engine.employee.close();
    assert(!(await engine.employee.all()).some((employee) => employee.employeeId === "default"));
    await assert.rejects(engine.browsers.get(a.employeeId), /deleted/);
    await assert.rejects(async () => await a.update(() => {}), /being deleted/i);
  } finally {
    engine.active.clear(); await engine.close(); await store.close();
    if (previous === undefined) delete process.env.VEGA_DB; else process.env.VEGA_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("set_manual clears the old trigger wording, and a task can reschedule only itself", async () => {
  const { store, engine } = await fixture();
  try {
    const employee = await engine.employee.for((await engine.employee.create({ name: "Planner" }, "alice")).id);
    const duty = await employee.execute("", { action: "add", kind: "duty", text: "report", times: ["09:00"], condition: "每天 9 点" });
    const owner = await Tools.create(engine, await employee.chat("alice"), await engine.config(), new AbortController().signal, () => {});
    owner.actorId = "alice";
    await owner.execute({ id: "m", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "set_manual" } } }, {} as any);
    const row = (await employee.state()).duties.find((d) => d.id === duty.value.id)!;
    assert.equal(row.manual, true);
    assert.equal(row.condition, undefined, "a stale condition would keep describing the old schedule");
    assert.deepEqual(row.times, []);

    const job = await add(employee, "call back later");
    const other = await add(employee, "someone else");
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: job.id, cwd: job.cwd, ownerId: "alice" });
    await employee.update((state) => { state.tasks.find((t) => t.id === job.id)!.status = "running"; state.tasks.find((t) => t.id === job.id)!.workSession = session.id; });
    employee.busy.set(job.id, { session: session.id, computer: false });
    const tools = await Tools.create(engine, session, await engine.config(), new AbortController().signal, () => {});
    assert((await tools.definitions({} as any)).some((t) => t.name === "task_reschedule"));
    const before = Date.now();
    await tools.execute({ id: "r", name: "task_reschedule", arguments: { delayMinutes: 90 } }, {} as any);
    const moved = employee.task(await employee.state(), job.id);
    assert.equal(moved.status, "deferred");
    assert(moved.nextCheckAt >= before + 89 * 60_000 && moved.nextCheckAt <= Date.now() + 91 * 60_000);
    assert.equal(employee.task(await employee.state(), other.id).status, "queued", "other tasks are untouched");
  } finally { await engine.close(); await store.close(); }
});

test("one update changes several aspects together, with the old executor's semantics", async () => {
  const { store, engine } = await fixture();
  try {
    const employee = await engine.employee.for((await engine.employee.create({ name: "Multi" }, "alice")).id);
    const tools = await Tools.create(engine, await employee.chat("alice"), await engine.config(), new AbortController().signal, () => {});
    tools.actorId = "alice";
    const duty = await employee.execute("", { action: "add", kind: "duty", text: "old", manual: true });
    await tools.execute({ id: "u", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: {
      command: "update", instructions: "new work", note: "细化", profile: "编码", trigger: { kind: "interval", everyMinutes: 30 } } } }, {} as any);
    let row = (await employee.state()).duties.find((d) => d.id === duty.value.id)!;
    assert.deepEqual([row.text, row.note, row.profile, row.manual, row.everyMinutes], ["new work", "细化", "coding", false, 30]);
    await tools.execute({ id: "d", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "update", trigger: { kind: "daily", times: ["09:00"] } } } }, {} as any);
    row = (await employee.state()).duties.find((d) => d.id === duty.value.id)!;
    assert.deepEqual([row.everyMinutes, row.times], [0, ["09:00"]], "switching kinds resets the competing rule");
    await tools.execute({ id: "n", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "update", trigger: { kind: "dynamic", delayMinutes: 15 } } } }, {} as any);
    row = (await employee.state()).duties.find((d) => d.id === duty.value.id)!;
    assert(!row.manual && !row.everyMinutes && !row.times.length && row.nextCheckAt > Date.now());

    // Like the old update, an invalid part rejects the whole call.
    const before = JSON.stringify(row);
    await assert.rejects(tools.execute({ id: "bad", name: "employee_duty_manage", arguments: { dutyId: duty.value.id, request: { command: "update", instructions: "x", profile: "电脑" } } }, {} as any));
    assert.equal(JSON.stringify((await employee.state()).duties.find((d) => d.id === duty.value.id)), before);

    // Like master, set_daily keeps the old condition wording; only set_manual clears it.
    const worded = await employee.execute("", { action: "add", kind: "duty", text: "w", everyMinutes: 60, condition: "每小时" });
    await tools.execute({ id: "sd", name: "employee_duty_manage", arguments: { dutyId: worded.value.id, request: { command: "set_daily", times: ["10:00"] } } }, {} as any);
    assert.equal((await employee.state()).duties.find((d) => d.id === worded.value.id)!.condition, "每小时");

    const job = await add(employee, "old task");
    await tools.execute({ id: "t", name: "employee_task_manage", arguments: { taskId: job.id, request: { command: "update", instructions: "new task", profile: "coding", delayMinutes: 60 } } }, {} as any);
    const moved = employee.task(await employee.state(), job.id);
    assert.deepEqual([moved.text, moved.profile, moved.status], ["new task", "coding", "queued"]);
    assert(moved.nextCheckAt > Date.now() + 59 * 60_000);
    await assert.rejects(tools.execute({ id: "past", name: "employee_task_manage", arguments: { taskId: job.id, request: { command: "update", instructions: "zzz", runAt: "2001-01-01 09:00" } } }, {} as any), /未来/);
    assert.equal(employee.task(await employee.state(), job.id).text, "new task", "the executor applies all parts or none");
  } finally { await engine.close(); await store.close(); }
});
