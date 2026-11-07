import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskHandoffs } from "../server/core/handoffs";

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

function world(options: { clientOnline?: boolean; running?: boolean; cloud?: boolean; local?: Memory; remote?: Memory } = {}) {
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
  const agent = { userId: "u1", clientId: "c1", name: "本机", instance: "i1", cwd: "/local", platform: "windows" };
  const store: any = {
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
      if (args.op === "write") { local.files.set(full, Buffer.from(args.content, "base64")); return { path: full }; }
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

test("handoff refuses instead of pretending when the cloud or the client is unavailable", async () => {
  const offlineWithCopy = world({ cloud: false });
  await assert.rejects(new TaskHandoffs(offlineWithCopy.deps).toCloud("e1", "t1"), /未启用云端隔离/);

  const running = world({ running: true });
  await assert.rejects(new TaskHandoffs(running.deps).toCloud("e1", "t1"), /还在执行/);

  const gone = world({ clientOnline: false });
  await assert.rejects(new TaskHandoffs(gone.deps).toCloud("e1", "t1"), /离线且没有云端副本/);
  assert.equal(gone.state.tasks[0].execution.localAgent, true, "执行权不得被悄悄改掉");
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
  assert.equal(await handoffs.ensureBrowserState(session), undefined, "未配置授权站点时不动本机登录态");
  await handoffs.configure("e1", { sites: ["https://a.test"] });
  await assert.rejects(handoffs.ensureBrowserState(session), /浏览器不可用/);
  // 用本机浏览器、或在服务端执行时，不需要搬运登录态。
  assert.equal(await handoffs.ensureBrowserState({ ...session, localBrowser: true }), undefined);
  assert.equal(await handoffs.ensureBrowserState({ ...session, localAgent: false }), undefined);
  // 已经搬过的任务不重复搬。
  w.state.tasks[0].browserSyncedAt = Date.now();
  assert.equal(await handoffs.ensureBrowserState(session), undefined);
});

test("cloud preparation is explicit and bounded", async () => {
  const w = world();
  const handoffs = new TaskHandoffs(w.deps);
  await assert.rejects(handoffs.configure("e1", { prepare: "x".repeat(2001) }), /太长/);
  const record = await handoffs.toCloud("e1", "t1");
  assert.match(record.note!, /未配置环境准备命令/);
});

test("non-terminal tasks whose client died are taken over only when the policy allows it", async () => {
  const options: any = { clientOnline: true };
  const w = world(options);
  w.local.put("/local/work/a.ts", "v1");
  const handoffs = new TaskHandoffs(w.deps);
  options.clientOnline = false;
  await handoffs.clientsGone("c1", "u1");
  assert.equal(w.state.tasks[0].execution.localAgent, true, "默认不自动接管");

  options.clientOnline = true;
  await handoffs.toCloud("e1", "t1");
  await handoffs.configure("e1", { auto: true });
  await handoffs.toLocal("e1", "t1");
  options.clientOnline = false;
  await handoffs.clientsGone("c1", "u1");
  assert.equal(w.state.tasks[0].execution.localAgent, false, "策略允许时从云端副本继续");
  assert.equal((await handoffs.record("t1"))!.source, "auto");
});
