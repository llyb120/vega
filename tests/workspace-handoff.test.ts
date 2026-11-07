import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile, readdir } from "node:fs/promises";
import { createServer as http } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { LocalAgentUnavailable } from "../server/core/local-agent";
import { PREVIEW_SUFFIX } from "../server/core/network-relay";
import { syncable } from "../server/core/handoff";
import { sessionPrompt } from "../server/core/prompt";

const client = { instance: "a".repeat(32), clientId: "c".repeat(32), name: "Dev PC", platform: "linux" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const within = (root: string, path: string) => { const part = relative(root, path); return part === "" || (!part.startsWith("..") && !isAbsolute(part)); };

/** The native client's exec/file operations, run for real against a temp checkout (same checks as local/main.go). */
async function clientOperation(op: string, args: any) {
  if (op === "exec") {
    try { return { output: execFileSync("/bin/sh", ["-c", args.command], { cwd: args.cwd, encoding: "utf8" }), exitCode: 0 }; }
    catch (error: any) { return { output: String(error.stdout || "") + String(error.stderr || ""), exitCode: error.status ?? 1, error: "exit" }; }
  }
  const path = resolve(args.cwd, args.path);
  try {
    if (args.op === "upload") {
      const root = await realpath(args.cwd), file = await realpath(path);
      if (!within(root, file) || !(await stat(file)).isFile()) return { error: "Only regular files within the working directory may be uploaded" };
      return { path: file };
    }
    if (args.op === "read") return { path, content: (await readFile(path)).toString("base64") };
    if (args.op === "write") { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, Buffer.from(args.content, "base64")); return { path }; }
    if (args.op === "stat") return { path, isDir: (await stat(path)).isDirectory() };
  } catch (error: any) { return { error: error.message }; }
  return { error: "Unknown file operation" };
}
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  await new Promise((done) => server.close(done));
  return port;
}
function read(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((yes, no) => {
    const cleanup = () => { clearTimeout(timer); socket.off("readable", poll); socket.off("close", close); };
    const close = () => { cleanup(); no(Error("Connection closed")); };
    const poll = () => { const data = socket.read(size); if (data) { cleanup(); yes(data); } };
    const timer = setTimeout(() => { cleanup(); no(Error("Read timed out")); }, 5000);
    socket.on("readable", poll).once("close", close); poll();
  });
}
async function socks(proxy: string, host: string, port: number, t: TestContext) {
  const socket = connect(Number(new URL(proxy).port), "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]));
  const address = Buffer.from(host), request = Buffer.alloc(7 + address.length);
  request.set([5, 1, 0, 3, address.length]); address.copy(request, 5); request.writeUInt16BE(port, request.length - 2);
  socket.write(request);
  return socket;
}
/** One HTTP GET through the owner's SOCKS proxy, as the cloud browser would send it. */
async function viaPreview(proxy: string, host: string, t: TestContext) {
  const socket = await socks(proxy, host, 80, t);
  const reply = await read(socket, 10);
  if (reply[1] !== 0) return { refused: reply[1] };
  socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  let body = "";
  socket.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
  await once(socket, "close");
  return { body: body.split("\r\n\r\n").slice(1).join("\r\n\r\n") };
}

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "vega-handoff-")));
  const origin = join(base, "origin"), local = join(base, "local"), cloud = join(base, "cloud");
  await mkdir(origin);
  git(origin, "init", "-q", "-b", "main");
  await writeFile(join(origin, "app.txt"), "v1\n");
  await writeFile(join(origin, "shared.txt"), "base\n");
  await writeFile(join(origin, "old.txt"), "remove me\n");
  git(origin, "add", "."); git(origin, "commit", "-qm", "init");
  git(base, "clone", "-q", origin, local);
  git(base, "clone", "-q", origin, cloud);
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  engine.handoffs.drainMs = 100;
  engine.handoffs.readyMs = 15000;
  const jobs: any[] = [];
  const transport = { send: (job: any) => jobs.push(job), close() {} };
  engine.localAgents.connect("alice", { ...client, cwd: local }, transport);
  const hooks: { exec?: (command: string) => Promise<void> } = {};
  engine.localAgents.request = async (_agent, op, args) => {
    if (op === "exec") await hooks.exec?.(args.command);
    return await clientOperation(op, args);
  };
  const session = await store.newSession({ localAgent: true, clientId: client.clientId, clientName: client.name, localPlatform: "linux", ownerId: "alice", cwd: local, executionCwds: { server: cloud } });
  t.after(async () => {
    for (const record of await store.objects<any>("handoff")) for (const service of record.services || []) try { process.kill(-service.pid, "SIGKILL"); } catch {}
    await engine.close(); await store.close(); await rm(base, { recursive: true, force: true });
  });
  return { base, local, cloud, store, engine, session, jobs, transport, hooks };
}
async function workInProgress(local: string) {
  await writeFile(join(local, "app.txt"), "v2 local edit\n");
  await writeFile(join(local, "notes.md"), "untracked note\n");
  await unlink(join(local, "old.txt"));
  await writeFile(join(local, ".env"), "API_KEY=secret-value\n");
  await mkdir(join(local, "node_modules", "x"), { recursive: true });
  await writeFile(join(local, "node_modules", "x", "index.js"), "dependency\n");
  await symlink("/etc/hostname", join(local, "escape.txt"));
}
const SERVICE = (port: number) => ({ name: "web", port, ready: "/", preview: true,
  command: `node -e "require('http').createServer((q,r)=>r.end('cloud '+require('fs').readFileSync('app.txt','utf8'))).listen(process.env.PORT,'127.0.0.1')"` });

test("a client workspace keeps Chrome in the cloud; the local browser needs a recorded exception", async (t) => {
  const { engine, store, session } = await fixture(t);
  const cloudBrowser = {} as any, localBrowser = {} as any;
  engine.browsers.get = async (key) => { assert.equal(key, "user_alice"); return cloudBrowser; };
  engine.localBrowsers.get = async () => localBrowser;
  assert.equal(await engine.chromeFor(session), cloudBrowser, "local workspace does not force the local browser");
  assert.equal(await engine.chromeFor({ ...session, employeeId: "e1", taskId: "t1" }), cloudBrowser);
  assert.match(await sessionPrompt(session, { model: "", provider: {} } as any, store), /Chrome 仍是云端浏览器.*不写裸 localhost.*远程浏览器界面接管同一页面/);
  await assert.rejects(engine.setBrowserLocation(session.id, "local", "convenience"), /existing_page/);
  const server = await store.newSession({ ownerId: "alice", cwd: process.cwd() });
  await assert.rejects(engine.setBrowserLocation(server.id, "local", "existing_page"), /会话在客户端执行/);
  const local = await engine.setBrowserLocation(session.id, "local", "existing_page");
  assert.equal(await engine.chromeFor(local), localBrowser);
  assert.match(await sessionPrompt(local, { model: "", provider: {} } as any, store), /按记录的例外（existing_page）操作该客户端本地浏览器/);
  assert.equal(await engine.chromeFor(await engine.setBrowserLocation(session.id, "cloud", undefined)), cloudBrowser);

  const employee = engine.employee;
  await employee.update((state) => { state.execution = { localAgent: false }; });
  await assert.rejects(employee.execute("", { action: "add", kind: "todo", text: "open my tab", localBrowser: "existing_page" }), /需要牛马在客户端执行/);
  await employee.update((state) => { state.execution = { localAgent: true, clientId: client.clientId, ownerId: "alice" }; });
  const added = await employee.execute("", { action: "add", kind: "todo", text: "use my already open admin page", localBrowser: "existing_page" });
  const task = employee.task(await employee.state(), added.value.id);
  assert.equal(task.browserLocation, "local");
  const normal = (await employee.execute("", { action: "add", kind: "todo", text: "normal web research" })).value.id;
  assert.equal(employee.task(await employee.state(), normal).browserLocation, undefined);
});

test("agent input yields while the user controls a tab in the live view", async () => {
  const store = await Store.open(":memory:");
  try {
    const chrome = new Chrome(store, new ChromeBridge(), "");
    chrome.bridge.request = async (operation: string) => operation === "tabs" ? { tabs: [{ tag: "tab-1", url: "https://example.test/", title: "Login" }, { tag: "tab-2", url: "https://example.test/b", title: "B" }] } : { ok: true };
    chrome.userControl.add("tab-1");
    await assert.rejects(chrome.execute("s1", process.cwd(), { operation: "act", tabTag: "tab-1", action: { action: "press", key: "Enter" } }), /用户正在远程浏览器中接管此标签页.*不会排队稍后重放/);
    assert.equal((await chrome.execute("s1", process.cwd(), { operation: "tabs", observe: "none" })).tabs.length, 2, "listing tabs still works");
    chrome.userControl.delete("tab-1");
    const after = await chrome.execute("s1", process.cwd(), { operation: "act", tabTag: "tab-1", action: { action: "press", key: "Enter" } }).catch((error) => error);
    assert.doesNotMatch(String(after?.message || ""), /接管/, "after release the agent continues on the same page");
  } finally { await store.close(); }
});

test("a stable preview origin routes through the client relay, fails closed offline and moves to a cloud service in place", async (t) => {
  const { engine, session, jobs } = await fixture(t);
  await engine.relay.configure({ userId: "alice", clientId: client.clientId, hash: "h" }, ["dev.example.test:3000"]);
  await assert.rejects(engine.handoffs.control(session.id, { action: "preview", host: "localhost", port: 3000 }), /精确域名/);
  await assert.rejects(engine.handoffs.control(session.id, { action: "preview", host: "other.example.test", port: 3000 }), /流量中继规则/);
  const { origin } = await engine.handoffs.control(session.id, { action: "preview", host: "dev.example.test", port: 3000 });
  const host = new URL(origin).host;
  assert(host.endsWith(PREVIEW_SUFFIX));
  assert.match(await engine.previewPrompt(session), new RegExp(`稳定预览地址.*${host.replace(/\./g, "\\.")}.*不写 localhost`));
  const proxy = await engine.relay.proxy("alice");

  const viaClient = await socks(proxy, host, 80, t);
  for (let i = 0; i < 50 && !jobs.some((job) => job.type === "relay"); i++) await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(jobs.find((job) => job.type === "relay").args, { host: "dev.example.test", port: 3000 }, "the stable origin is served by the client's allowed relay target");
  engine.localAgents.suspend("alice", client.instance);
  assert.deepEqual(await viaPreview(proxy, host, t), { refused: 1 }, "client away: no direct or cloud fallback");
  assert.deepEqual(await viaPreview(proxy, "s0000" + PREVIEW_SUFFIX, t), { refused: 1 }, "unregistered preview hosts are refused");

  const port = await freePort();
  const server = http((_q, r) => r.end("cloud copy")).listen(port, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const preview = (await engine.relay.previews(session.id))[0];
  await engine.relay.savePreview({ ...preview, backend: { kind: "cloud", port } });
  await once(viaClient, "close");
  assert.deepEqual(await viaPreview(proxy, host, t), { body: "cloud copy" }, "same origin, new backend; open connections were dropped to reconnect");
  assert.deepEqual(await viaPreview(await engine.relay.proxy("bob"), host, t), { refused: 1 }, "another user's proxy cannot reach this preview");
});

test("checkpoints capture dirty, deleted and untracked files but never secrets, symlinks or dependency folders", async (t) => {
  const { engine, session, local, store } = await fixture(t);
  await workInProgress(local);
  const checkpoint = await engine.handoffs.control(session.id, { action: "checkpoint" });
  assert.equal(checkpoint.rev, 1);
  const saved = JSON.parse(await readFile(join(store.files.root, "handoff", session.id, "rev-1.json"), "utf8"));
  assert(saved.complete);
  assert.deepEqual(saved.files.map((file: any) => file.path + (file.deleted ? ":deleted" : file.untracked ? ":untracked" : "")).sort(), ["app.txt", "notes.md:untracked", "old.txt:deleted"]);
  const skipped = Object.fromEntries(saved.skipped.map((item: any) => [item.path, item.reason]));
  assert.match(skipped[".env"], /凭据/);
  assert.match(skipped["escape.txt"], /越出工作目录|符号链接/);
  assert(!Object.keys(skipped).includes("node_modules/x/index.js") || /依赖目录/.test(skipped["node_modules/x/index.js"]));
  const blobs = await Promise.all((await readdir(join(store.files.root, "handoff", session.id, "blobs"))).map((name) => readFile(join(store.files.root, "handoff", session.id, "blobs", name), "utf8")));
  assert(!blobs.some((content) => content.includes("secret-value") || content.includes("dependency")), "no secret or dependency content stored");
  assert(blobs.includes("v2 local edit\n") && blobs.includes("untracked note\n"));
  for (const path of ["../outside.txt", "/etc/passwd", ".git/config", "a/../../b"]) assert(syncable(path, [path]), path);
  await assert.rejects(engine.handoffs.control(session.id, { action: "checkpoint", include: ["../secrets"] }), /相对路径/);
  await engine.handoffs.control(session.id, { action: "checkpoint", include: [".env"] });
  const explicit = JSON.parse(await readFile(join(store.files.root, "handoff", session.id, "rev-2.json"), "utf8"));
  assert(explicit.files.some((file: any) => file.path === ".env"), "a secret file is synced only when explicitly included");
});

test("handoff syncs the workspace, rebuilds the service, reroutes the preview and only then moves the same session to the cloud", async (t) => {
  const { engine, session, local, cloud, store, hooks } = await fixture(t);
  await engine.relay.configure({ userId: "alice", clientId: client.clientId, hash: "h" }, ["dev.example.test:3000"]);
  const { origin } = await engine.handoffs.control(session.id, { action: "preview", host: "dev.example.test", port: 3000 });
  await workInProgress(local);
  await writeFile(join(local, "shared.txt"), "local version\n");
  await writeFile(join(cloud, "shared.txt"), "cloud edit\n");
  const stuck = await engine.handoffs.admit(session.id, "bash");
  let refusedDuringHandoff = false;
  hooks.exec = async () => {
    if (refusedDuringHandoff) return;
    await assert.rejects(engine.handoffs.admit(session.id, "write"), (error: any) => error instanceof LocalAgentUnavailable && /已暂停新的本地操作/.test(error.message));
    refusedDuringHandoff = true;
  };
  const port = await freePort();
  const result = await engine.handoffs.control(session.id, { action: "handoff", services: [SERVICE(port)] });
  stuck();
  assert(refusedDuringHandoff, "new local operations are refused while handing off");
  assert.equal(result.phase, "cloud_owned");
  assert.equal(result.message, "云端已接管，可以关闭电脑");
  assert.equal(result.canCloseComputer, true);
  assert.deepEqual(result.unknown.map((item: any) => item.tool), ["bash"], "an operation still running is recorded as unverified, not replayed");

  const moved = await store.session(session.id);
  assert.equal(moved.id, session.id);
  assert.equal(moved.localAgent, false);
  assert.equal(moved.cwd, cloud);
  assert.equal(moved.executionCwds?.["client:" + client.clientId], local);
  assert.equal(await readFile(join(cloud, "app.txt"), "utf8"), "v2 local edit\n");
  assert.equal(await readFile(join(cloud, "notes.md"), "utf8"), "untracked note\n");
  await assert.rejects(stat(join(cloud, "old.txt")), "tracked deletion applied");
  await assert.rejects(stat(join(cloud, ".env")), "secret not copied");
  assert.equal(await readFile(join(cloud, "shared.txt"), "utf8"), "local version\n");
  assert.equal(await readFile(join(cloud, "shared.txt.vega-cloud-1"), "utf8"), "cloud edit\n", "divergent cloud edit is kept beside the file");
  assert.deepEqual(await viaPreview(await engine.relay.proxy("alice"), new URL(origin).host, t), { body: "cloud v2 local edit\n" }, "the preview origin now serves the rebuilt cloud service from synced files");
  const note = (await store.messages(session.id)).findLast((message) => message.notice);
  assert.match(note!.text!, /交接到云端，同一任务与会话继续.*结果不确定，先核验，不要重放：bash/);
  await assert.rejects(engine.handoffs.control(session.id, { action: "handoff" }), /执行权已在云端/);
});

test("a remaining local dependency keeps execution local and says files are synced but the computer is still needed", async (t) => {
  const { engine, session, local, store } = await fixture(t);
  await engine.relay.configure({ userId: "alice", clientId: client.clientId, hash: "h" }, ["db.corp.test:5432"]);
  await workInProgress(local);
  const result = await engine.handoffs.control(session.id, { action: "handoff", requires: [{ kind: "intranet", name: "db.corp.test:5432" }, { kind: "hardware", name: "USB key" }] });
  assert.equal(result.phase, "files_synced_local_dependent");
  assert.match(result.message, /^文件已同步，仍依赖本地：.*db\.corp\.test:5432.*USB key.*不要关闭电脑/);
  assert.equal(result.canCloseComputer, false);
  assert.equal(result.owner, "local");
  assert.equal((await store.session(session.id)).localAgent, true);
});

test("handoff stops an active run at a safe boundary and needs confirmation before reloading open preview pages", async (t) => {
  const { engine, session, local, cloud } = await fixture(t);
  await engine.relay.configure({ userId: "alice", clientId: client.clientId, hash: "h" }, ["dev.example.test:3000"]);
  const { origin } = await engine.handoffs.control(session.id, { action: "preview", host: "dev.example.test", port: 3000 });
  const reloads: string[] = [];
  const browser = {
    async execute(_owner: string, _cwd: string, a: any) { if (a.operation === "reload") reloads.push(a.tabTag); return { tabs: [{ tag: "p1", url: origin + "/editor" }, { tag: "x", url: "https://other.test/" }] }; },
    async cdp() { return { result: { value: JSON.stringify([origin, "complete"]) } }; },
  } as any;
  engine.peekBrowser = () => browser;
  engine.chromeFor = async () => browser;
  await writeFile(join(local, "app.txt"), "v3\n");
  const port = await freePort();
  const first = await engine.handoffs.control(session.id, { action: "handoff", services: [SERVICE(port)] });
  assert.equal(first.phase, "needs_confirmation");
  assert.match(first.message, /刷新.*WebSocket 会重连.*未保存的草稿可能丢失/);
  assert.equal(await readFile(join(cloud, "app.txt"), "utf8"), "v1\n", "nothing changed before confirmation");
  const control = new AbortController();
  engine.active.set(session.id, { control } as any);
  control.signal.addEventListener("abort", () => setTimeout(() => engine.active.delete(session.id), 30));
  const result = await engine.handoffs.control(session.id, { action: "handoff", services: [SERVICE(port)], acknowledgeReload: true });
  assert(control.signal.aborted, "the running turn was stopped before ownership moved");
  assert.equal(result.phase, "cloud_owned");
  assert.deepEqual(reloads, ["p1"], "only preview pages are reloaded and verified on the same origin");
});

test("abrupt disconnect recovers only the last complete checkpoint and blocks what is missing", async (t) => {
  const { engine, session, local, cloud, store } = await fixture(t);
  await assert.rejects(engine.handoffs.control(session.id, { action: "recover" }), /在线交接/);
  await writeFile(join(local, "app.txt"), "checkpointed\n");
  await engine.handoffs.control(session.id, { action: "checkpoint" });
  await writeFile(join(local, "app.txt"), "after checkpoint\n");
  engine.localAgents.disconnect("alice");
  const result = await engine.handoffs.control(session.id, { action: "recover" });
  assert.equal(await readFile(join(cloud, "app.txt"), "utf8"), "checkpointed\n");
  assert.equal(result.owner, "cloud");
  assert.equal(result.canCloseComputer, false);
  assert.match(result.message, /检查点之后的本机改动/);
  assert.equal((await store.session(session.id)).localAgent, false, "the same session continues in the cloud");

  const fresh = await store.newSession({ localAgent: true, clientId: client.clientId, ownerId: "alice", cwd: local, executionCwds: { server: cloud } });
  await assert.rejects(engine.handoffs.control(fresh.id, { action: "recover" }), /没有完整的检查点/);
});

test("reconnecting never steals execution back; sync_back keeps dirty local files and transfer_back waits for a safe boundary", async (t) => {
  const { engine, session, local, cloud, store, transport } = await fixture(t);
  await engine.relay.configure({ userId: "alice", clientId: client.clientId, hash: "h" }, ["dev.example.test:3000"]);
  const { origin } = await engine.handoffs.control(session.id, { action: "preview", host: "dev.example.test", port: 3000 });
  await writeFile(join(local, "app.txt"), "handed off\n");
  const port = await freePort();
  await engine.handoffs.control(session.id, { action: "handoff", services: [SERVICE(port)] });
  engine.localAgents.disconnect("alice");
  engine.localAgents.connect("alice", { ...client, cwd: local }, transport);
  assert.equal((await engine.handoffs.status(session.id)).owner, "cloud", "a reconnect alone does not move execution");
  assert.equal((await store.session(session.id)).localAgent, false);

  await writeFile(join(cloud, "app.txt"), "cloud continued\n");
  await writeFile(join(cloud, "shared.txt"), "cloud shared\n");
  await writeFile(join(local, "shared.txt"), "local dirty work\n");
  await assert.rejects(engine.handoffs.control(session.id, { action: "transfer_back" }), /先执行 sync_back/);
  const synced = await engine.handoffs.control(session.id, { action: "sync_back" });
  assert.equal(synced.owner, "cloud", "syncing back does not transfer ownership");
  assert.equal(await readFile(join(local, "app.txt"), "utf8"), "cloud continued\n");
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "local dirty work\n", "dirty local work is never overwritten");
  const copy = (await readdir(local)).find((name) => name.startsWith("shared.txt.vega-cloud-"));
  assert.equal(await readFile(join(local, copy!), "utf8"), "cloud shared\n");

  const control = new AbortController();
  engine.active.set(session.id, { control } as any);
  const pending = await engine.handoffs.control(session.id, { action: "transfer_back" });
  assert.equal(pending.phase, "returning");
  assert(!control.signal.aborted, "a running cloud turn is not interrupted");
  assert.equal((await store.session(session.id)).localAgent, false);
  engine.active.delete(session.id);
  await engine.handoffs.boundary(session.id);
  const back = await store.session(session.id);
  assert.equal(back.localAgent, true);
  assert.equal(back.cwd, local);
  assert.equal(back.browserLocation, undefined, "the browser stays in the cloud when the workspace returns");
  assert.equal((await engine.relay.previews(session.id))[0].backend.kind, "client");
  assert.equal(new URL(origin).host, (await engine.relay.previews(session.id))[0].host);
  assert.equal((await engine.handoffs.status(session.id)).phase, "local_owned");
});

test("a cloud checkout at another commit or with a symlinked path is refused and ownership is rolled back", async (t) => {
  const { engine, session, local, cloud, store } = await fixture(t);
  await writeFile(join(cloud, "extra.txt"), "x\n");
  git(cloud, "add", "."); git(cloud, "commit", "-qm", "cloud only");
  await writeFile(join(local, "app.txt"), "v2\n");
  await assert.rejects(engine.handoffs.control(session.id, { action: "handoff" }), /提交.*不一致.*未写入任何文件/);
  assert.equal((await engine.handoffs.status(session.id)).phase, "failed");
  assert.equal((await store.session(session.id)).localAgent, true);
  git(cloud, "reset", "-q", "--hard", "HEAD~1");
  await mkdir(join(local, "docs"));
  await writeFile(join(local, "docs", "a.md"), "doc\n");
  await symlink("/tmp", join(cloud, "docs"));
  await assert.rejects(engine.handoffs.control(session.id, { action: "handoff" }), /符号链接/);
  assert.equal((await store.session(session.id)).localAgent, true);
});

test("an exceptional local browser migrates only authorized task tabs and is verified in the cloud browser", async (t) => {
  const { engine, session, local, store } = await fixture(t);
  await engine.setBrowserLocation(session.id, "local", "existing_page");
  const cookies = [{ name: "sid", value: "abc", domain: "app.test", path: "/" }];
  const localChrome = {
    observations: new Map([[session.id + ":L1", { tabTag: "L1" }], ["other-session:L2", { tabTag: "L2" }]]),
    async execute(_o: string, _c: string, a: any) { assert.equal(a.operation, "tabs"); return { tabs: [{ tag: "L1", url: "https://app.test/dash" }, { tag: "L2", url: "https://bank.test/" }] }; },
    async cdp(tag: string, method: string) {
      assert.equal(tag, "L1", "only tabs this task observed are exported");
      return method === "Network.getCookies" ? { cookies } : { result: { value: JSON.stringify({ local: [["theme", "dark"]], session: [["draft", "1"]] }) } };
    },
  } as any;
  let restored = true;
  const set: any[] = [], visited: string[] = [];
  const cloudChrome = {
    async execute(_o: string, _c: string, a: any) { if (a.url) visited.push(a.url); return { tabTag: "C1" }; },
    async cdp(_tag: string, method: string, params: any) {
      if (method === "Network.setCookie") { set.push(params); return {}; }
      if (method === "Network.getCookies") return { cookies: restored ? set : [] };
      if (params?.expression?.includes("Object.keys(localStorage)")) return { result: { value: JSON.stringify(restored ? ["theme"] : []) } };
      return { result: { value: "" } };
    },
  } as any;
  engine.localBrowsers.get = async () => localChrome;
  engine.chromeFor = async (s: any) => engine.localBrowser(s) ? localChrome : cloudChrome;
  engine.peekBrowser = () => undefined;
  await writeFile(join(local, "app.txt"), "v2\n");

  const refused = await engine.handoffs.control(session.id, { action: "handoff" });
  assert.equal(refused.phase, "files_synced_local_dependent", "without authorization the local browser stays a local dependency");
  assert.match(refused.message, /本机浏览器（existing_page）/);
  restored = false;
  await assert.rejects(engine.handoffs.control(session.id, { action: "handoff", migrateBrowser: true }), /登录态在云端浏览器中未能完整恢复/);
  assert.equal((await store.session(session.id)).localAgent, true, "a failed browser restore leaves ownership local");
  restored = true;
  set.length = 0;
  const moved = await engine.handoffs.control(session.id, { action: "handoff", migrateBrowser: true });
  assert.equal(moved.phase, "cloud_owned");
  assert.deepEqual(set.map((cookie) => cookie.name), ["sid"]);
  assert(!visited.some((url) => url.includes("bank.test")), "tabs of other sessions are not exported");
  const after = await store.session(session.id);
  assert.equal(after.browserLocation, undefined, "the task now uses the cloud browser");
  assert.match((await store.messages(session.id)).findLast((m) => m.notice)!.text!, /已迁移本机标签页：https:\/\/app\.test\/dash/);
});
