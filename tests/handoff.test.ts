import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TaskHandoffs } from "../server/core/handoffs";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

/** 内存工作区：本地端与云端各一份，测试交接与回传的文件动作。 */
class Memory {
  files = new Map<string, Buffer>();
  put(path: string, text: string) { this.files.set(path, Buffer.from(text)); }
  text(path: string) { return this.files.get(path)?.toString() ?? ""; }
  async mkdir() {}
  async writeFile(path: string, data: any) { this.files.set(path, Buffer.from(data)); }
  async readFile(path: string) {
    const data = this.files.get(path);
    if (!data) throw Error("ENOENT " + path);
    return data;
  }
  async stat(path: string) { return { isFile: () => this.files.has(path), isDirectory: () => true, size: this.files.get(path)?.length || 0 }; }
  async readdir(dir: string) {
    const entries = new Map<string, boolean>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(dir + "/")) continue;
      const [head, ...rest] = path.slice(dir.length + 1).split("/");
      entries.set(head, rest.length > 0 || [...this.files.keys()].some((other) => other.startsWith(dir + "/" + head + "/")));
    }
    return [...entries].map(([name, isDirectory]) => ({ name, isDirectory: () => isDirectory }));
  }
}

const under = (memory: Memory, root: string) => [...memory.files.keys()].filter((path) => path.startsWith(root + "/")).map((path) => [path, memory.text(path)] as const);

function world(options: { clientOnline?: boolean; running?: boolean; cloud?: boolean; local?: Memory; remote?: Memory; prefer?: "client" | "cloud" } = {}) {
  const local = options.local || new Memory();
  const remote = options.remote || new Memory();
  const task: any = {
    id: "t1", text: "开发", status: "queued", cwd: "/local/work",
    execution: { localAgent: true, clientId: "c1", ownerId: "u1" }, owner: { token: "u1", name: "" },
    workSession: "s1", plan: [], progress: [],
  };
  const state: any = { id: "e1", ownerId: "u1", execution: { ...task.execution }, cwd: task.cwd, tasks: [task], duties: [], memories: [], runs: [], orbit: [] };
  const sessions = new Map<string, any>([["s1", { id: "s1", cwd: task.cwd, localAgent: true, clientId: "c1", taskId: "t1", employeeId: "e1", ownerId: "u1", title: "工作" }]]);
  const objects = new Map<string, any>();
  const agent = { userId: "u1", clientId: "c1", name: "本机", instance: "i1", cwd: "/local", platform: "windows", prefer: options.prefer };
  const store: any = {
    async transaction(fn: () => Promise<any>) { return fn(); },
    async object(kind: string, key: string) { return objects.get(kind + ":" + key); },
    async objects(kind: string) { return [...objects].filter(([key]) => key.startsWith(kind + ":")).map(([, value]) => value); },
    async save(kind: string, key: string, value: any) { objects.set(kind + ":" + key, JSON.parse(JSON.stringify(value))); },
    async session(id: string) { return JSON.parse(JSON.stringify(sessions.get(id))); },
    async saveSession(session: any) { sessions.set(session.id, JSON.parse(JSON.stringify(session))); },
  };
  const employee: any = {
    employeeId: "e1",
    async state() { return JSON.parse(JSON.stringify(state)); },
    task(s: any, id: string) { const found = s.tasks.find((item: any) => item.id === id); assert.ok(found, "task missing"); return found; },
    async update(fn: any) { const next = await fn(state); Object.assign(state, next); return JSON.parse(JSON.stringify(state)); },
  };
  const agents: any = {
    active() { return options.clientOnline === false ? undefined : agent; },
    async request(_agent: any, op: string, args: any) {
      assert.equal(op, "file");
      const root = args.cwd as string;
      if (args.op === "list") return { root, files: under(local, root).map(([path, text]) => ({ path: path.slice(root.length + 1), size: text.length })) };
      const full = root + "/" + args.path;
      if (args.op === "read") return { path: full, content: local.files.get(full)!.toString("base64") };
      if (args.op === "sync_write") {
        const old = local.files.get(full), hash = old ? createHash("sha256").update(old).digest("hex") : "";
        if (hash !== args.expectedHash) return { error: "目标文件已变化，交接未覆盖" };
        local.files.set(full, Buffer.from(args.content, "base64"));
        return { path: full };
      }
      throw Error("unexpected " + args.op);
    },
  };
  const cloud = options.cloud === false ? undefined : {
    async cwd(input: string) { return "/cloud/" + input; },
    fs: remote,
  };
  const deps: any = {
    store,
    employees: async () => [employee],
    employeeFor: async () => employee,
    agents,
    isRunning: () => !!options.running,
    cloud: () => cloud,
    browsers: { local: async () => { throw Error("no local browser"); }, cloud: async () => { throw Error("no cloud browser"); } },
    seal: async (value: any) => JSON.stringify(value),
    open: async (blob: string) => JSON.parse(blob),
  };
  return { deps, local, remote, state, task, sessions };
}

test("下线交接：客户端还连着就按本机现读的变动同步，没连着就按服务端还原点续做", async () => {
  const soft = world();
  soft.local.put("/local/work/a.txt", "本机的变动");
  const done = await new TaskHandoffs(soft.deps).offline("c1", "u1");
  assert.deepEqual(done, { mode: "soft", tasks: 1, failed: [] });
  assert.equal(soft.remote.text("/cloud/.vega/handoffs/t1/a.txt"), "本机的变动", "在线时按本机当前内容同步");
  assert.equal(soft.state.tasks[0].execution.localAgent, false);

  const hard = world({ clientOnline: false });
  const resumed = await new TaskHandoffs(hard.deps).offline("c1", "u1");
  assert.deepEqual(resumed, { mode: "hard", tasks: 1, failed: [] });
  assert.match((await new TaskHandoffs(hard.deps).record("t1"))!.note!, /以还原点为准，离线期间的新文件不在其中/);
});

test("handoff refuses instead of pretending when the cloud or the client is unavailable", async () => {
  const offlineWithCopy = world({ cloud: false });
  await assert.rejects(new TaskHandoffs(offlineWithCopy.deps).toCloud("e1", "t1"), /未启用云端隔离/);

  const running = world({ running: true });
  await assert.rejects(new TaskHandoffs(running.deps).toCloud("e1", "t1"), /还在执行/);

  const gone = world({ clientOnline: false });
  // 本机拿不到、又没云端副本：不编造文件也不拒绝，按恢复点先在云端开工，缺什么现场核对（核验不了就停下问用户）。
  const resumed = await new TaskHandoffs(gone.deps).toCloud("e1", "t1");
  assert.equal(gone.state.tasks[0].execution.localAgent, false);
  assert.deepEqual(resumed.base, [], "没有本机副本就不假装有基线");
  assert.match(resumed.note!, /以还原点为准，离线期间的新文件不在其中.*task_ask_user/);
});

test("a cloud restart without the local copy never overwrites the device's files when it comes back", async () => {
  const options: any = { clientOnline: true };
  const w = world(options);
  w.local.put("/local/work/a.ts", "mine");
  options.clientOnline = false;
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.clientsGone("c1", "u1");
  const record = (await handoffs.record("t1"))!;
  assert.deepEqual(record.base, [], "没有本机副本就没有基线");
  w.remote.put(record.cloudCwd + "/a.ts", "guessed by cloud");
  w.remote.put(record.cloudCwd + "/b.ts", "made in cloud");
  options.clientOnline = true;
  await handoffs.backHome("u1");
  assert.equal(w.state.tasks[0].execution.localAgent, true);
  assert.equal(w.local.text("/local/work/a.ts"), "mine", "本机原文件保留");
  assert.equal(w.local.text("/local/work/a.ts.vega-conflict-cloud"), "guessed by cloud", "云端同名版本另存，不覆盖");
  assert.equal(w.local.text("/local/work/b.ts"), "made in cloud", "云端新做的交给本机");
});

test("to cloud copies the workspace, moves the task and bumps the epoch", async () => {
  const w = world();
  w.local.put("/local/work/a.ts", "export const a = 1;");
  w.local.put("/local/work/src/b.ts", "export const b = 2;");
  w.local.put("/local/work/node_modules/x/index.js", "ignored");
  const record = await new TaskHandoffs(w.deps).toCloud("e1", "t1");

  assert.equal(record.where, "cloud");
  assert.equal(record.epoch, 1);
  assert.deepEqual(record.base.map((file: any) => file.path), ["a.ts", "src/b.ts"]);
  assert.deepEqual(under(w.remote, record.cloudCwd!).map(([path, text]) => [path.slice(record.cloudCwd!.length + 1), text]),
    [["a.ts", "export const a = 1;"], ["src/b.ts", "export const b = 2;"]]);
  assert.equal(w.state.tasks[0].execution.localAgent, false);
  assert.equal(w.state.tasks[0].cwd, record.cloudCwd);
  assert.equal(w.state.tasks[0].status, "queued");
  assert.equal(w.sessions.get("s1").localAgent, false);
  assert.equal(w.sessions.get("s1").cwd, record.cloudCwd);
  assert.match(w.state.tasks[0].handoffState.note, /按本地当前内容同步/);
});

test("client coming back merges cloud progress without taking the execution right back", async () => {
  const w = world();
  w.local.put("/local/work/a.ts", "v1");
  const handoffs = new TaskHandoffs(w.deps);
  const record = await handoffs.toCloud("e1", "t1");
  w.remote.put(record.cloudCwd + "/a.ts", "v2");
  w.remote.put(record.cloudCwd + "/c.ts", "new in cloud");

  await handoffs.syncBack("c1", "u1");
  assert.equal(w.local.text("/local/work/a.ts"), "v2");
  assert.equal(w.local.text("/local/work/c.ts"), "new in cloud");
  assert.equal(w.state.tasks[0].execution.localAgent, false, "回传不抢执行权");
});

test("both sides changed means both copies are kept", async () => {
  const w = world();
  w.local.put("/local/work/a.ts", "v1");
  const handoffs = new TaskHandoffs(w.deps);
  const record = await handoffs.toCloud("e1", "t1");
  w.remote.put(record.cloudCwd + "/a.ts", "cloud");
  w.local.put("/local/work/a.ts", "local");
  await handoffs.syncBack("c1", "u1");
  assert.equal(w.local.text("/local/work/a.ts"), "local", "本机原文件保留");
  assert.equal(w.local.text("/local/work/a.ts.vega-conflict-cloud"), "cloud", "云端版本另存");
});

test("browser state is only migrated for authorised sites and only from a local browser", async () => {
  const w = world();
  const handoffs = new TaskHandoffs(w.deps);
  await assert.rejects(handoffs.configure("e1", { sites: ["ftp://example.test"] }), /http/);
  await handoffs.configure("e1", { sites: ["https://example.test/a/b"] });
  assert.deepEqual((await handoffs.policy("e1")).sites, ["https://example.test"]);
  const record = await handoffs.toCloud("e1", "t1");
  assert.match(record.browserNote!, /浏览器已在云端/);
  assert.equal(record.browser, undefined, "默认云端浏览器不需要迁移登录态");
});

test("a task on the local client with a cloud browser takes the local login state along, but only for authorised sites", async () => {
  const w = world();
  const handoffs = new TaskHandoffs(w.deps);
  const session: any = { id: "s1", taskId: "t1", employeeId: "e1", localAgent: true, localBrowser: false, ownerId: "u1" };
  assert.equal(await handoffs.ensureBrowserState(session), undefined, "未配置授权站点时不动登录态");
  await handoffs.configure("e1", { sites: ["https://a.test"] });
  // 目标端云端浏览器不可达就报错；本机做源端也要浏览器可达。
  await assert.rejects(handoffs.ensureBrowserState(session), /云端浏览器不可用/);
  // 浏览器端在本机时，目标就是本机浏览器；它不可达同样报错（云端此时是源端）。
  await assert.rejects(handoffs.ensureBrowserState({ ...session, localBrowser: true }), /本机浏览器不可用/);
  await assert.rejects(handoffs.ensureBrowserState({ ...session, localAgent: false }), /云端浏览器不可用/);
  // 已经搬过的任务不重复搬。
  w.state.tasks[0].browserSyncedAt = Date.now();
  w.state.tasks[0].browserSyncVersion = 2;
  assert.equal(await handoffs.ensureBrowserState(session), undefined);
});

test("cloud preparation is explicit and bounded", async () => {
  const w = world();
  const handoffs = new TaskHandoffs(w.deps);
  await assert.rejects(handoffs.configure("e1", { prepare: "x".repeat(2001) }), /太长/);
  const record = await handoffs.toCloud("e1", "t1");
  assert.match(record.note!, /未配置环境准备命令/);
});

test("non-terminal tasks whose client died move to the cloud by default; only an explicit opt-out keeps them local", async () => {
  const options: any = { clientOnline: true };
  const w = world(options);
  w.local.put("/local/work/a.ts", "v1");
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.toCloud("e1", "t1");
  await handoffs.toLocal("e1", "t1");
  options.clientOnline = false;
  await handoffs.clientsGone("c1", "u1");
  assert.equal(w.state.tasks[0].execution.localAgent, false, "客户端退出后默认转回云端");
  assert.equal((await handoffs.record("t1"))!.source, "auto");

  const optedOut: any = { clientOnline: true };
  const kept = world(optedOut);
  kept.local.put("/local/work/a.ts", "v1");
  const configured = new TaskHandoffs(kept.deps);
  await configured.toCloud("e1", "t1");
  await configured.toLocal("e1", "t1");
  await configured.configure("e1", { auto: false });
  optedOut.clientOnline = false;
  await configured.clientsGone("c1", "u1");
  assert.equal(kept.state.tasks[0].execution.localAgent, true, "显式关闭自动接管时保留本地绑定");
});

test("旧的服务端优先上报不再自动把任务交到云端，要改这头牛马的 Master 才会交接", async () => {
  const w = world({ clientOnline: true, prefer: "cloud" });
  w.local.put("/local/work/a.ts", "v1");
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.clients({ type: "clients_changed", targetUser: "u1" });
  assert.equal(w.state.tasks[0].execution.localAgent, true, "prefer=cloud 不再作为派活或自动交接依据");
});

test("a never-started cloud task can bind an online client without copying a workspace", async () => {
  const w = world({ cloud: false });
  w.task.execution = { localAgent: false, localBrowser: false, ownerId: "u1" };
  w.task.cwd = "/cloud/work";
  delete w.task.workSession;
  const result = await new TaskHandoffs(w.deps).toLocal("e1", "t1", { clientId: "c1" });
  assert.equal(result.where, "local");
  assert.equal(w.task.execution.clientId, "c1");
  assert.equal(w.task.execution.localBrowser, true);
  assert.equal(w.task.cwd, "/local");
  assert.equal(w.task.status, "queued");
});

test("a paused cloud-only task copies its workspace without overwriting local conflicts", async () => {
  const w = world();
  w.task.status = "stopped";
  w.task.execution = { localAgent: false, localBrowser: false, ownerId: "u1" };
  w.task.cwd = "/cloud/work";
  w.task.browserSyncedAt = 1;
  w.remote.put("/cloud/work/src/a.ts", "cloud");
  w.remote.put("/cloud/work/new.ts", "new");
  w.remote.put("/cloud/work/node_modules/ignored.js", "dependency");
  w.local.put("/local/src/a.ts", "local");
  w.local.put("/local/src/a.ts.vega-conflict-cloud", "previous conflict");
  const result = await new TaskHandoffs(w.deps).toLocal("e1", "t1", { clientId: "c1" });
  assert.equal(w.local.text("/local/src/a.ts"), "local");
  assert.equal(w.local.text("/local/src/a.ts.vega-conflict-cloud"), "previous conflict");
  assert.equal(w.local.text("/local/src/a.ts.vega-conflict-cloud-1"), "cloud");
  assert.equal(w.local.text("/local/new.ts"), "new");
  assert.equal(w.local.text("/local/node_modules/ignored.js"), "");
  assert.deepEqual(result.conflicts, ["src/a.ts"]);
  assert.equal(w.task.status, "stopped", "handoff must not resume a paused task");
  assert.equal(w.task.browserSyncedAt, undefined, "the new browser must sync independently");
  assert.equal(w.sessions.get("s1").localAgent, true);
});

test("a paused server task can move to the client without Docker isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vega-handoff-server-"));
  try {
    await writeFile(join(directory, "note.txt"), "server file");
    const w = world({ cloud: false });
    w.task.status = "stopped";
    w.task.execution = { localAgent: false, ownerId: "u1" };
    w.task.cwd = directory;
    await new TaskHandoffs(w.deps).toLocal("e1", "t1", { clientId: "c1" });
    assert.equal(w.local.text("/local/note.txt"), "server file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("handoff uses the cloud task's current directory instead of an obsolete snapshot", async () => {
  const w = world();
  w.local.put("/local/work/old.txt", "old workspace");
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.toCloud("e1", "t1");
  w.task.cwd = "/cloud/new-work";
  w.task.status = "stopped";
  w.remote.put("/cloud/new-work/new.txt", "current workspace");
  await handoffs.toLocal("e1", "t1", { clientId: "c1" });
  assert.equal(w.local.text("/local/new.txt"), "current workspace");
  assert.equal(w.local.text("/local/old.txt"), "");
  assert.equal((await handoffs.record("t1"))!.cloudCwd, undefined, "a later handoff must not overwrite the previous cloud directory");
});

test("handoff stops if a local file changes after the workspace scan", async () => {
  const w = world();
  w.task.status = "stopped";
  w.task.execution = { localAgent: false, ownerId: "u1" };
  w.task.cwd = "/cloud/work";
  w.remote.put("/cloud/work/a.txt", "cloud");
  const request = w.deps.agents.request;
  w.deps.agents.request = async (...args: any[]) => {
    if (args[2].op === "sync_write") w.local.put("/local/a.txt", "new local change");
    return request(...args);
  };
  await assert.rejects(new TaskHandoffs(w.deps).toLocal("e1", "t1", { clientId: "c1" }), /目标文件已变化/);
  assert.equal(w.local.text("/local/a.txt"), "new local change");
  assert.equal(w.task.execution.localAgent, false);
});

test("handoff refuses to switch execution if the task starts during the copy", async () => {
  const w = world();
  w.task.status = "stopped";
  w.task.execution = { localAgent: false, ownerId: "u1" };
  w.task.cwd = "/cloud/work";
  w.remote.put("/cloud/work/a.txt", "cloud");
  const request = w.deps.agents.request;
  w.deps.agents.request = async (...args: any[]) => {
    if (args[2].op === "list") w.task.status = "running";
    return request(...args);
  };
  await assert.rejects(new TaskHandoffs(w.deps).toLocal("e1", "t1", { clientId: "c1" }), /任务状态已变化/);
  assert.equal(w.task.execution.localAgent, false);
});

test("task, execution sessions and handoff record roll back together on a failed switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vega-handoff-atomic-"));
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const originalSave = store.saveSession.bind(store);
  try {
    const employee = await engine.employee.for((await engine.employee.create({ name: "Atomic", cwd: directory }, "alice")).id);
    const clientId = "d".repeat(32);
    engine.localAgents.connect("alice", { clientId, instance: "a".repeat(32), name: "PC", cwd: "C:\\work", platform: "windows" });
    const created = await employee.execute("", { action: "add", kind: "todo", text: "work" });
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, ownerId: "alice", cwd: directory });
    await employee.update((s) => { const task = employee.task(s, created.value.id); task.status = "stopped"; task.workSession = session.id; return s; });
    (engine.localAgents as any).request = async () => ({ files: [] });
    store.saveSession = async () => { throw Error("session save failed"); };
    await assert.rejects(engine.handoffs.toLocal(employee.employeeId, created.value.id, { clientId }), /session save failed/);
    const task = employee.task(await employee.state(), created.value.id);
    assert.equal(task.execution.localAgent, false);
    assert.equal(task.cwd, directory);
    assert.equal((await store.session(session.id)).localAgent, undefined);
    assert.equal(await engine.handoffs.record(task.id), undefined);
  } finally {
    store.saveSession = originalSave;
    await engine.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser sync retries partial results when the target opens an authorised page", async () => {
  const w = world();
  w.task.execution = { localAgent: false, localBrowser: false, ownerId: "u1" };
  const tab = { tag: "target", url: "about:blank" }, cookies: any[] = [];
  const target: any = {
    bridge: { request: async () => ({ tabs: [tab] }) },
    cdp: async (_tag: string, method: string, params: any) => {
      if (method === "Network.getAllCookies") return { cookies };
      if (method === "Network.setCookie") { cookies.push(params); return { success: true }; }
      if (method === "Runtime.evaluate") return { result: { value: { written: 1, failed: 0 } } };
      throw Error("unexpected " + method);
    },
  };
  const source: any = {
    bridge: { request: async () => ({ tabs: [{ tag: "source", url: "https://a.test/" }] }) },
    cdp: async (_tag: string, method: string) => method === "Network.getAllCookies"
      ? { cookies: [{ name: "sid", value: "x", domain: "a.test", path: "/" }] }
      : { result: { value: JSON.stringify({ local: { token: "x" }, session: {} }) } },
  };
  w.deps.browsers = { cloud: async () => target, local: async () => source };
  w.deps.onlineClients = () => [{ id: "c1" }];
  w.deps.releaseLocal = async () => {};
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.configure("e1", { sites: ["https://a.test"] });
  const session: any = { id: "s1", taskId: "t1", employeeId: "e1", ownerId: "u1", localBrowser: false };
  w.task.browserSyncedAt = 1; // Old versions could mark an unsuccessful sync as complete.
  assert.equal((await handoffs.ensureBrowserState(session))!.ok, false);
  assert.equal(w.task.browserSyncedAt, undefined);
  assert.equal(cookies.length, 1);
  tab.url = "https://a.test/";
  assert.equal((await handoffs.ensureBrowserState(session))!.ok, true);
  assert(w.task.browserSyncedAt);
  assert.equal(w.task.browserSyncVersion, 2);
  assert.equal(cookies.length, 1, "retry does not overwrite a copied cookie");
  assert.equal(await handoffs.ensureBrowserState(session), undefined);
});

test("browser sync does not mark cookie-only source pages as fully synchronized", async () => {
  const w = world();
  w.task.execution = { localAgent: false, localBrowser: false, ownerId: "u1" };
  const sourceTab = { tag: "source", url: "about:blank" }, cookies: any[] = [];
  const target: any = {
    bridge: { request: async () => ({ tabs: [{ tag: "target", url: "https://a.test/" }] }) },
    cdp: async (_tag: string, method: string, params: any) => method === "Network.getAllCookies" ? { cookies } : method === "Network.setCookie" ? (cookies.push(params), { success: true }) : { result: { value: { written: 1, failed: 0 } } },
  };
  let storageAvailable = false;
  const source: any = {
    bridge: { request: async () => ({ tabs: [sourceTab] }) },
    cdp: async (_tag: string, method: string) => method === "Network.getAllCookies" ? { cookies: [{ name: "sid", value: "x", domain: "a.test", path: "/" }] } : storageAvailable ? { result: { value: JSON.stringify({ local: { token: "x" }, session: {} }) } } : { result: {}, exceptionDetails: { text: "denied" } },
  };
  w.deps.browsers = { cloud: async () => target, local: async () => source };
  w.deps.onlineClients = () => [{ id: "c1" }];
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.configure("e1", { sites: ["https://a.test"] });
  const session: any = { id: "s1", taskId: "t1", employeeId: "e1", ownerId: "u1" };
  assert.equal((await handoffs.ensureBrowserState(session))!.ok, false);
  assert.equal(cookies.length, 1);
  assert.equal(w.task.browserSyncedAt, undefined);
  sourceTab.url = "https://a.test/";
  assert.equal((await handoffs.ensureBrowserState(session))!.ok, false, "an unreadable source storage must also be retried");
  assert.equal(w.task.browserSyncedAt, undefined);
  storageAvailable = true;
  assert.equal((await handoffs.ensureBrowserState(session))!.ok, true);
  assert(w.task.browserSyncedAt);
});

test("a task taken over automatically comes back to its device once that device returns", async () => {
  const options: any = { clientOnline: true };
  const w = world(options);
  w.local.put("/local/work/a.ts", "v1");
  const handoffs = new TaskHandoffs(w.deps);
  await handoffs.toCloud("e1", "t1");
  await handoffs.toLocal("e1", "t1");
  options.clientOnline = false;
  await handoffs.clientsGone("c1", "u1");
  assert.equal(w.state.tasks[0].execution.localAgent, false, "设备掉了先在云端续做");

  w.remote.put((await handoffs.record("t1"))!.cloudCwd + "/b.ts", "made in cloud");
  options.clientOnline = true;
  options.running = true;
  await handoffs.clients({ type: "clients_changed", targetUser: "u1" });
  assert.equal(w.state.tasks[0].execution.localAgent, false, "云端这一轮还在跑，不硬切执行权");

  options.running = false;
  await handoffs.backHome("u1");
  assert.equal(w.state.tasks[0].execution.localAgent, true, "设备回连后切回本机续做");
  assert.equal(w.state.tasks[0].execution.clientId, "c1");
  assert.equal(w.local.text("/local/work/b.ts"), "made in cloud", "云端做的那部分先回本机");
  assert.equal(w.local.text("/local/work/a.ts"), "v1");

  // 手动交接到云端的任务不自动搬回，仍由用户决定。
  const manual = world({ clientOnline: true });
  manual.local.put("/local/work/a.ts", "v1");
  const byHand = new TaskHandoffs(manual.deps);
  await byHand.toCloud("e1", "t1");
  await byHand.backHome("u1");
  assert.equal(manual.state.tasks[0].execution.localAgent, false);
});
