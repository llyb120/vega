import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { sessionPrompt } from "../server/core/prompt";
import { resolveModel } from "../server/core/config";
import { LocalAgentUnavailable } from "../server/core/local-agent";

const client = { instance: "a".repeat(32), clientId: "d".repeat(32), name: "Office PC", cwd: "C:\\client-only", platform: "windows" };
async function fixture(t: TestContext) {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  t.after(async () => { await engine.close(); await store.close(); });
  return { engine, store };
}

test("client hints follow only the working device and owner, refresh live and never change cwd", async (t) => {
  const { engine, store } = await fixture(t);
  const config = { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] } } } } } };
  await store.put("config", config);
  engine.catalog.resolve = async (_c, selection) => resolveModel(config, selection || config.scenes.lightweight[0]);
  const officeHint = "项目目录：D:\\code\\office\n辅助提示，不是切换工作目录。", homeHint = "Home-only hint", bobHint = "Bob-only hint";
  const hints = [officeHint, homeHint, bobHint];
  let system = "";
  engine.providers.chat = async (_model, prompt) => { system = prompt; return { role: "assistant", text: "done" }; };
  const run = async (session: any, expected: string) => {
    await engine.run(session.id, { role: "user", text: "Describe the current environment" });
    for (const hint of hints) assert.equal(system.includes(JSON.stringify(hint)), hint === expected);
    assert.equal((await store.session(session.id)).cwd, session.cwd);
    if (expected) assert.match(system, /不自动切换工作目录/);
  };

  // 只有一台设备时它生效。
  engine.localAgents.connect("alice", { ...client, supplement: officeHint });
  const office = await store.newSession({ cwd: client.cwd, ownerId: "alice", clientId: client.clientId, localAgent: true });
  await run(office, officeHint);

  // 同账号后登录的设备接管，用它自己的提示；待命设备的提示不再进入提示词。
  engine.localAgents.connect("alice", { ...client, clientId: "e".repeat(32), instance: "b".repeat(32), supplement: homeHint });
  const home = await store.newSession({ cwd: client.cwd, ownerId: "alice", clientId: "e".repeat(32), localAgent: true });
  await run(home, homeHint);

  // 换账号互不影响。
  engine.localAgents.connect("bob", { ...client, supplement: bobHint });
  const bob = await store.newSession({ cwd: client.cwd, ownerId: "bob", clientId: client.clientId, localAgent: true, scene: "computer" });
  await run(bob, bobHint);

  // 服务端会话没有客户端提示。
  await run(await store.newSession({ cwd: process.cwd(), ownerId: "alice", clientId: client.clientId }), "");

  // 提示可以刷新，也能清空。
  engine.localAgents.connect("alice", { ...client, clientId: "e".repeat(32), instance: "b".repeat(32), supplement: "Updated local hint" });
  await run(home, "Updated local hint");
  engine.localAgents.connect("alice", { ...client, clientId: "e".repeat(32), instance: "b".repeat(32), supplement: "" });
  await run(home, "");
  assert(!system.includes("[所选客户端补充内容]"));
  assert(!(await sessionPrompt({ ...office, localAgent: false }, config, store, officeHint)).includes(JSON.stringify(officeHint)));
});

test("client update idleness covers entire local turns, employee sessions and Fire chains", async (t) => {
  const { engine, store } = await fixture(t);
  const ordinary = await store.newSession({ cwd: client.cwd, localAgent: true, clientId: client.clientId, ownerId: "alice" });
  const employee = await store.newSession({ cwd: client.cwd, localAgent: true, clientId: client.clientId, ownerId: "bob", employeeId: "worker", taskId: "task", scene: "computer" });
  const server = await store.newSession({ cwd: process.cwd(), localAgent: false, clientId: client.clientId, ownerId: "alice" });
  const other = await store.newSession({ cwd: client.cwd, localAgent: true, clientId: "e".repeat(32), ownerId: "alice" });
  const state = () => ({ control: new AbortController(), steer: [] });
  try {
    engine.active.set(server.id, state());
    engine.active.set(other.id, state());
    assert.equal(await engine.clientInUse(client.clientId), false, "idle local sessions and unrelated running sessions do not block");
    for (const session of [ordinary, employee]) {
      engine.active.set(session.id, state());
      assert.equal(await engine.clientInUse(client.clientId), true, "thinking without a pending tool is still busy, across all owners");
      engine.active.get(session.id)!.control.abort();
      assert.equal(await engine.clientInUse(client.clientId), true, "cancellation remains busy until the turn finishes cleanup");
      engine.active.delete(session.id);
      assert.equal(await engine.clientInUse(client.clientId), false);
    }
    engine.fire.running.set(ordinary.id, Promise.resolve());
    assert.equal(await engine.clientInUse(client.clientId), true, "Fire stays busy between phases even without an active model call");
    engine.fire.running.delete(ordinary.id);
    engine.fire.running.set(server.id, Promise.resolve());
    assert.equal(await engine.clientInUse(client.clientId), false, "server-side Fire must not block this client");
  } finally {
    engine.active.clear();
    engine.fire.running.clear();
  }
});

test("connecting a client never moves existing server sessions or their Stage/fork tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vega-execution-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { engine, store } = await fixture(t), session = await store.newSession({ cwd: dir, ownerId: "alice" });
  const config = { model: "", provider: {} }, signal = new AbortController().signal;
  const tools = await Tools.create(engine, session, config, signal, () => {});
  await tools.execute({ id: "before", name: "write", arguments: { path: "note.txt", content: "before" } }, {} as any);
  engine.localAgents.connect("alice", client);
  engine.localAgents.request = async () => { throw Error("Server work must not reach the client"); };
  await tools.execute({ id: "after", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }, {} as any);
  assert.equal(await readFile(join(dir, "note.txt"), "utf8"), "after");
  for (const saved of [await store.session(session.id), await store.stage(session.id), await store.fork(session.id)]) {
    assert.equal(!!saved.localAgent, false);
    const reloaded = await Tools.create(engine, saved, config, signal, () => {});
    const result = await reloaded.execute({ id: "read", name: "read", arguments: { path: "note.txt" } }, {} as any);
    assert.match(result.value.text, /after/);
  }
});

test("manual switches validate destination paths, reset cached runtimes and remember each side's cwd", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vega-execution-roundtrip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { engine, store } = await fixture(t), session = await store.newSession({ cwd: dir, ownerId: "alice" });
  engine.localAgents.connect("alice", client);
  const probes: any[] = [];
  engine.localAgents.request = async (_agent, op, args) => {
    assert.equal(op, "file"); assert.equal(args.op, "stat");
    probes.push(args);
    return { isDir: true, path: args.path };
  };
  let closed = 0, reset = 0;
  engine.mcpSessions.set(session.id, { key: "old-runtime", client: { close: async () => { closed++; } } as any });
  engine.providers.reset = (key) => { assert.equal(key, session.id); reset++; };
  const local = await engine.switchExecution(session.id, true);
  assert.equal(local.cwd, client.cwd);
  assert.equal(local.localAgent, true);
  assert.equal(local.localPlatform, "windows");
  assert.equal(probes[0].cwd, client.cwd, "never interpret a server path as a client cwd");
  assert.equal(closed, 1); assert.equal(reset, 1);
  assert.equal(engine.mcpSessions.has(session.id), false);
  const prompt = await sessionPrompt(local, { model: "", provider: {} }, store);
  assert.match(prompt, /当前执行位置：客户端/);
  assert.match(prompt, /PowerShell/);
  assert.match(prompt, /不要重放已完成或结果不确定/);
  const localProject = client.cwd + "\\project";
  local.cwd = localProject;
  await store.saveSession(local);
  const server = await engine.switchExecution(session.id, false);
  assert.equal(server.cwd, dir);
  assert.equal(server.localPlatform, undefined);
  assert.equal(server.executionCwds?.["client:" + client.clientId], localProject);
  assert.match(await sessionPrompt(server, { model: "", provider: {} }, store), /当前执行位置：服务端/);
  const restored = await engine.switchExecution(session.id, true);
  assert.equal(restored.cwd, localProject);
  assert.deepEqual((await store.stage(session.id)).executionCwds, restored.executionCwds);
  assert.deepEqual((await store.fork(session.id)).executionCwds, restored.executionCwds);
});

test("missing remembered directories recover to the destination root; offline switches leave the session unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vega-execution-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { engine, store } = await fixture(t);
  const session = await store.newSession({ cwd: dir, ownerId: "alice", executionCwds: { ["client:" + client.clientId]: "C:\\deleted-project" } });
  const original = await store.session(session.id);
  await assert.rejects(engine.switchExecution(session.id, true), /未连接/);
  assert.deepEqual(await store.session(session.id), original);
  engine.localAgents.connect("alice", client);
  const paths: string[] = [];
  engine.localAgents.request = async (_agent, _op, args) => {
    paths.push(args.path);
    return args.path === client.cwd ? { isDir: true, path: client.cwd } : { error: "directory removed" };
  };
  const local = await engine.switchExecution(session.id, true);
  assert.deepEqual(paths, ["C:\\deleted-project", client.cwd]);
  assert.equal(local.cwd, client.cwd);
  await rm(dir, { recursive: true });
  const recovered = await engine.switchExecution(session.id, false);
  assert.equal(recovered.cwd, process.cwd());
  const beforeFailure = await store.session(session.id);
  let requests = 0;
  engine.localAgents.request = async () => { requests++; throw new LocalAgentUnavailable(); };
  await assert.rejects(engine.switchExecution(session.id, true), LocalAgentUnavailable);
  assert.equal(requests, 1, "a disconnected client must not cause a second probe or a server fallback");
  assert.deepEqual(await store.session(session.id), beforeFailure);
  assert.equal(engine.executionSwitches.size, 0);
});

test("execution changes cannot overlap a running turn, Fire, another switch or employee task", async (t) => {
  const { engine, store } = await fixture(t), session = await store.newSession({ ownerId: "alice" });
  engine.localAgents.connect("alice", client);
  engine.active.set(session.id, { control: new AbortController(), steer: [] });
  await assert.rejects(engine.switchExecution(session.id, true), /当前轮执行结束/);
  engine.active.delete(session.id);
  const forSession = engine.fire.forSession.bind(engine.fire);
  engine.fire.forSession = () => ({ status: "running" }) as any;
  await assert.rejects(engine.switchExecution(session.id, true), /当前轮执行结束/);
  engine.fire.forSession = forSession;
  let finish!: (value: any) => void;
  engine.localAgents.request = async () => new Promise((resolve) => { finish = resolve; });
  const switching = engine.switchExecution(session.id, true);
  await assert.rejects(engine.switchExecution(session.id, false), /正在切换/);
  await assert.rejects(engine.run(session.id, { role: "user", text: "must not execute during switch" }), /正在切换/);
  assert.equal((await store.messages(session.id)).length, 0);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
  finish({ isDir: true, path: client.cwd });
  await switching;
  assert.equal(engine.executionSwitches.size, 0);
  const task = await store.newSession({ ownerId: "alice", taskId: "task" });
  await assert.rejects(engine.switchExecution(task.id, true), /牛马任务/);
  await assert.rejects(engine.switchExecution(session.id, "server" as any), /Invalid execution mode/);
});

test("switching between computers keeps independent paths and never substitutes a standby target", async (t) => {
  const { engine, store } = await fixture(t), session = await store.newSession({ ownerId: "alice" });
  const home = { ...client, clientId: "e".repeat(32), instance: "b".repeat(32), cwd: "/home/project", name: "Home", platform: "linux" };
  engine.localAgents.connect("alice", client);
  engine.localAgents.connect("alice", home);
  engine.localAgents.request = async (agent, _op, args) => {
    assert.equal(args.cwd, agent.cwd);
    return { isDir: true, path: args.path };
  };
  // 不指定设备时用最新登录的那台，而不是报“多个客户端”。
  const primary = await engine.switchExecution(session.id, true);
  assert.equal(primary.clientId, home.clientId);
  // 待命设备不能接执行权：不会偷偷换到旧那台。
  await assert.rejects(engine.switchExecution(session.id, true, client.clientId), /未连接/);
  const onHome = await engine.switchExecution(session.id, true, home.clientId);
  assert.equal(onHome.clientName, home.name);
  onHome.cwd = "/home/office-project";
  await store.saveSession(onHome);

  // 生效设备退出后轮到旧设备，且两端路径各自保存。
  engine.localAgents.disconnect("alice", home.instance);
  const onOffice = await engine.switchExecution(session.id, true);
  assert.equal(onOffice.clientId, client.clientId);
  assert.equal(onOffice.cwd, client.cwd);
  engine.localAgents.connect("alice", home);
  const back = await engine.switchExecution(session.id, true, home.clientId);
  assert.equal(back.cwd, "/home/office-project");

  await assert.rejects(engine.switchExecution(session.id, true, "f".repeat(32)), /未连接/);
  assert.equal((await store.session(session.id)).clientId, home.clientId);
});

test("an authorized admin can bind a legacy ownerless session without guessing another account's device", async (t) => {
  const { engine, store } = await fixture(t), session = await store.newSession();
  engine.localAgents.connect("alice", client);
  engine.localAgents.request = async (_agent, _op, args) => ({ isDir: true, path: args.path });
  await assert.rejects(engine.switchExecution(session.id, true, client.clientId, "bob"), /未连接/);
  assert.equal((await store.session(session.id)).ownerId, undefined);
  const bound = await engine.switchExecution(session.id, true, client.clientId, "alice");
  assert.equal(bound.ownerId, "alice");
  assert.equal(bound.clientId, client.clientId);
});

test("a client lost after path validation or a session deleted during validation is not resurrected", async (t) => {
  const { engine, store } = await fixture(t), session = await store.newSession({ ownerId: "alice" });
  engine.localAgents.connect("alice", client);
  engine.localAgents.request = async () => ({ isDir: true, path: client.cwd });
  engine.mcpSessions.set(session.id, { key: "old", client: { close: async () => { engine.localAgents.disconnect("alice"); } } as any });
  await assert.rejects(engine.switchExecution(session.id, true), /客户端已断开/);
  assert.equal(!!(await store.session(session.id)).localAgent, false);
  engine.localAgents.connect("alice", client);
  let finish!: (value: any) => void;
  engine.localAgents.request = async () => new Promise((resolve) => { finish = resolve; });
  const switching = engine.switchExecution(session.id, true);
  await store.deleteSession(session.id);
  finish({ isDir: true, path: client.cwd });
  await assert.rejects(switching, /Session not found/);
  await assert.rejects(async () => await store.session(session.id), /Session not found/);
  assert.equal(engine.executionSwitches.size, 0);
});
