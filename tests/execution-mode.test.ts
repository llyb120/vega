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
import { LocalAgentUnavailable } from "../server/core/local-agent";

const client = { instance: "a".repeat(32), cwd: "C:\\client-only", platform: "windows" };
function fixture(t: TestContext) {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  t.after(async () => { await engine.close(); store.close(); });
  return { engine, store };
}

test("connecting a client never moves existing server sessions or their Stage/fork tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vega-execution-server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { engine, store } = fixture(t), session = store.newSession({ cwd: dir, ownerId: "alice" });
  const config = { model: "", provider: {} }, signal = new AbortController().signal;
  const tools = new Tools(engine, session, config, signal, () => {});
  await tools.execute({ id: "before", name: "write", arguments: { path: "note.txt", content: "before" } }, {} as any);
  engine.localAgents.connect("alice", client);
  engine.localAgents.request = async () => { throw Error("Server work must not reach the client"); };
  await tools.execute({ id: "after", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }, {} as any);
  assert.equal(await readFile(join(dir, "note.txt"), "utf8"), "after");
  for (const saved of [store.session(session.id), store.stage(session.id), store.fork(session.id)]) {
    assert.equal(!!saved.localAgent, false);
    const reloaded = new Tools(engine, saved, config, signal, () => {});
    const result = await reloaded.execute({ id: "read", name: "read", arguments: { path: "note.txt" } }, {} as any);
    assert.match(result.value.text, /after/);
  }
});

test("manual switches validate destination paths, reset cached runtimes and remember each side's cwd", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vega-execution-roundtrip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { engine, store } = fixture(t), session = store.newSession({ cwd: dir, ownerId: "alice" });
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
  store.saveSession(local);
  const server = await engine.switchExecution(session.id, false);
  assert.equal(server.cwd, dir);
  assert.equal(server.localPlatform, undefined);
  assert.equal(server.executionCwds?.local, localProject);
  assert.match(await sessionPrompt(server, { model: "", provider: {} }, store), /当前执行位置：服务端/);
  const restored = await engine.switchExecution(session.id, true);
  assert.equal(restored.cwd, localProject);
  assert.deepEqual(store.stage(session.id).executionCwds, restored.executionCwds);
  assert.deepEqual(store.fork(session.id).executionCwds, restored.executionCwds);
});

test("missing remembered directories recover to the destination root; offline switches leave the session unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vega-execution-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { engine, store } = fixture(t);
  const session = store.newSession({ cwd: dir, ownerId: "alice", executionCwds: { local: "C:\\deleted-project" } });
  const original = store.session(session.id);
  await assert.rejects(engine.switchExecution(session.id, true), /客户端未连接/);
  assert.deepEqual(store.session(session.id), original);
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
  const beforeFailure = store.session(session.id);
  let requests = 0;
  engine.localAgents.request = async () => { requests++; throw new LocalAgentUnavailable(); };
  await assert.rejects(engine.switchExecution(session.id, true), LocalAgentUnavailable);
  assert.equal(requests, 1, "a disconnected client must not cause a second probe or a server fallback");
  assert.deepEqual(store.session(session.id), beforeFailure);
  assert.equal(engine.executionSwitches.size, 0);
});

test("execution changes cannot overlap a running turn, Fire, another switch or employee task", async (t) => {
  const { engine, store } = fixture(t), session = store.newSession({ ownerId: "alice" });
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
  assert.equal(store.messages(session.id).length, 0);
  finish({ isDir: true, path: client.cwd });
  await switching;
  assert.equal(engine.executionSwitches.size, 0);
  const task = store.newSession({ ownerId: "alice", taskId: "task" });
  await assert.rejects(engine.switchExecution(task.id, true), /员工任务/);
  await assert.rejects(engine.switchExecution(session.id, "server" as any), /Invalid execution mode/);
});

test("a client lost after path validation or a session deleted during validation is not resurrected", async (t) => {
  const { engine, store } = fixture(t), session = store.newSession({ ownerId: "alice" });
  engine.localAgents.connect("alice", client);
  engine.localAgents.request = async () => ({ isDir: true, path: client.cwd });
  engine.mcpSessions.set(session.id, { key: "old", client: { close: async () => { engine.localAgents.disconnect("alice"); } } as any });
  await assert.rejects(engine.switchExecution(session.id, true), /客户端已断开/);
  assert.equal(!!store.session(session.id).localAgent, false);
  engine.localAgents.connect("alice", client);
  let finish!: (value: any) => void;
  engine.localAgents.request = async () => new Promise((resolve) => { finish = resolve; });
  const switching = engine.switchExecution(session.id, true);
  store.deleteSession(session.id);
  finish({ isDir: true, path: client.cwd });
  await assert.rejects(switching, /Session not found/);
  assert.throws(() => store.session(session.id), /Session not found/);
  assert.equal(engine.executionSwitches.size, 0);
});
