import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgents, LocalAgentUnavailable } from "../server/core/local-agent";
import { Store } from "../server/core/store";
import { Auth, type Principal } from "../server/core/auth";
import { eventAllowed } from "../server/core/http-auth";
import { Tools } from "../server/core/tools";
import { Vault } from "../server/core/vault";

const details = { instance: "a".repeat(32), clientId: "d".repeat(32), name: "Office PC", cwd: "C:\\only-on-client", platform: "windows" };
const idle = () => new AbortController().signal;
/** Jobs reach a client only through its own socket transport; captured as { data: { instance, ...job } }. */
const wire = (jobs: any[], instance = details.instance, reply?: (job: any) => void) => ({ send: (job: any) => { jobs.push({ data: { instance, ...job } }); reply?.(job); }, close() {} });

test("local login tickets are one-use, bounded, expire and follow website revocation without API keys", async () => {
  const hub = new LocalAgents();
  const principal = { hash: "login", user: { id: "alice" }, expiresAt: Date.now() + 10000 } as Principal;
  let current: Principal | undefined = principal;
  const auth = { resolveHash: () => current } as unknown as Auth;
  const first = hub.ticket(principal, details.instance);
  assert.equal((await hub.verify(first.ticket, auth)).userId, "alice");
  await assert.rejects(async () => await hub.verify(first.ticket, auth));
  const revoked = hub.ticket(principal, details.instance);
  current = undefined;
  await assert.rejects(async () => await hub.verify(revoked.ticket, auth));
  const expired = hub.ticket(principal, details.instance);
  (hub as any).tickets.get(expired.ticket).until = Date.now() - 1;
  current = principal;
  await assert.rejects(async () => await hub.verify(expired.ticket, auth));
  hub.close();
});

test("browser bridge routes only to its owner and instance, never another user or competing tab", async () => {
  const events: any[] = [], hub = new LocalAgents();
  hub.connect("alice", details, wire(events));
  hub.connect("bob", { ...details, instance: "b".repeat(32) }, wire([], "b".repeat(32)));
  assert.throws(() => hub.connect("alice", { ...details, instance: "c".repeat(32) }));
  const pending = hub.request(hub.active("alice")!, "file", { op: "read" }, idle());
  const event = events[0];
  assert.throws(() => hub.result("bob", { ...event.data, result: { content: "stolen" } }));
  hub.result("alice", { ...event.data, result: { content: "ok" } });
  assert.deepEqual(await pending, { content: "ok" });
  hub.result("alice", { ...event.data, result: { content: "duplicate ignored" } });
  assert.equal(events.length, 1);
  hub.disconnect("alice", "stale");
  assert.ok(hub.active("alice"));
  hub.close();
});

test("one account can hold several connected devices, and each operation goes only to the device it is addressed to", async (t) => {
  const events: any[] = [], hub = new LocalAgents();
  t.after(() => hub.close());
  const other = { ...details, clientId: "e".repeat(32), instance: "b".repeat(32), name: "Home PC" };
  hub.connect("alice", details, wire(events));
  hub.connect("alice", other, wire(events, other.instance));
  hub.connect("bob", { ...details, instance: "c".repeat(32) }, wire(events, "c".repeat(32)));
  assert.deepEqual(hub.list("alice").map((c) => [c.name, c.active]), [["Office PC", true], ["Home PC", true]], "两台都已连接，不再按最新登录让旧设备待命");
  assert.equal(hub.list("bob").length, 1);
  assert.equal(hub.active("alice"), undefined, "有多台时没有默认设备，必须显式指定");
  const office = hub.active("alice", details.clientId)!, home = hub.active("alice", other.clientId)!;
  assert.equal(office.clientId, details.clientId);
  assert.equal(home.clientId, other.clientId);
  assert.throws(() => hub.connect("alice", { ...details, instance: "f".repeat(32) }));
  assert.throws(() => hub.connect("alice", { ...other, clientId: "0".repeat(32) }), /instance already registered/);

  // 操作只发给被指定的那台，两台互不串。
  const job = hub.request(home, "file", { op: "read" }, idle());
  assert.equal(events.at(-1).data.instance, other.instance, "操作只发给被指定的设备");
  hub.result("alice", { ...events.at(-1).data, result: { content: "home" } });
  assert.deepEqual(await job, { content: "home" });
  const officeJob = hub.request(office, "file", { op: "read" }, idle());
  assert.equal(events.at(-1).data.instance, details.instance);
  hub.result("alice", { ...events.at(-1).data, result: { content: "office" } });
  assert.deepEqual(await officeJob, { content: "office" });

  // 一台退出后剩下那台继续工作；只剩一台时它就是默认设备。
  hub.disconnect("alice", other.instance);
  assert.equal(hub.list("alice").length, 1);
  assert.equal(hub.active("alice")!.clientId, details.clientId);
  const again = hub.request(hub.active("alice", details.clientId)!, "file", { op: "read" }, idle());
  assert.equal(events.at(-1).data.instance, details.instance);
  hub.result("alice", { ...events.at(-1).data, result: { content: "office" } });
  assert.deepEqual(await again, { content: "office" });

  hub.disconnect("alice");
  assert.deepEqual(hub.list("alice"), []);
  assert.equal(hub.list("bob").length, 1);
});

test("unbound historical local sessions pause instead of guessing which computer to use", async () => {
  const store = await Store.open(":memory:"), hub = new LocalAgents();
  try {
    hub.connect("alice", details);
    const session = await store.newSession({ ownerId: "alice", cwd: details.cwd, localAgent: true });
    const tools = await Tools.create({ store, localAgents: hub, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, idle(), () => {});
    const result = await tools.execute({ id: "unbound", name: "bash", arguments: { command: "must not run" } }, {} as any);
    assert.equal(result.stop, true);
    assert.match(result.pause!, /尚未绑定客户端/);
    assert.equal(hub.active("alice", details.clientId)!.pending.size, 0);
  } finally { hub.close(); await store.close(); }
});

test("session cancellation sends a WebSocket cancel job and rejects the original pending request", async () => {
  const events: any[] = [], hub = new LocalAgents();
  hub.connect("alice", details, wire(events));
  const controller = new AbortController();
  const request = hub.request(hub.active("alice")!, "exec", { command: "fixture", timeout: 10 }, controller.signal);
  controller.abort(Error("Cancelled by user"));
  await assert.rejects(request, /Cancelled by user/);
  assert.equal(events[1].data.op, "cancel");
  assert.equal(events[1].data.id, events[0].data.id);
  assert.equal(hub.active("alice")!.pending.size, 0);
  hub.close();
});

test("lost local response pauses for user confirmation, without replay or server filesystem fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-local-loss-"));
  const store = await Store.open(":memory:");
  const hub = new LocalAgents();
  hub.connect("alice", { ...details, cwd: dir });
  const session = await store.newSession({ ownerId: "alice", cwd: dir, localAgent: true, clientId: details.clientId });
  const engine = { store, localAgents: hub, vault: new Vault(store), mcpFor: () => ({}) } as any;
  const tools = await Tools.create(engine, session, { model: "", provider: {} }, idle(), () => {});
  const operation = tools.execute({ id: "once", name: "bash", arguments: { command: "this command must not run on the server", timeout: 10 } }, {} as any);
  hub.disconnect("alice");
  const result = await operation;
  assert.equal(result.stop, true);
  assert.match(result.pause!, /修复连接.*继续/);
  assert.equal(result.error, true);
  assert.deepEqual(await store.messages(session.id), []);
  const offline = await tools.execute({ id: "offline-write", name: "write", arguments: { path: "must-not-exist", content: "unsafe fallback" } }, {} as any);
  assert.equal(offline.stop, true);
  await assert.rejects(access(join(dir, "must-not-exist")));
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test("local file reads resolve on the client rather than statting server paths", async () => {
  const store = await Store.open(":memory:");
  let hub: LocalAgents;
  hub = new LocalAgents();
  hub.connect("alice", details, wire([], details.instance, (job) => queueMicrotask(() => hub.result("alice", { id: job.id, instance: details.instance, result: { path: "C:\\only-on-client\\note.txt", content: Buffer.from("hello\nworld").toString("base64") } }))));
  const session = await store.newSession({ ownerId: "alice", cwd: details.cwd, localAgent: true, clientId: details.clientId });
  const tools = await Tools.create({ store, localAgents: hub, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, idle(), () => {});
  const result = await tools.execute({ id: "read", name: "read", arguments: { path: "note.txt" } }, {} as any);
  assert.match(result.value.text, /1\|hello\n2\|world/);
  assert.equal((await store.stage(session.id)).localAgent, true);
  assert.equal((await store.fork(session.id)).localAgent, true);
  hub.close(); await store.close();
});

test("ping-style connect without transport cannot clear a suspended recovery", async (t) => {
  const events: any[] = [], hub = new LocalAgents();
  t.after(() => hub.close());
  hub.connect("alice", details, wire(events));
  const agent = hub.active("alice", details.clientId)!;
  hub.suspend("alice", details.instance);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.transport, undefined);
  hub.connect("alice", details); // ping-style refresh, no transport
  assert.equal(agent.reconnecting, true, "must stay suspended until a socket transport returns");
  assert.equal(agent.transport, undefined);
  const waiting = hub.request(agent, "file", { op: "read" }, idle());
  assert.equal(events.length, 0, "must not send while suspended");
  assert.equal(agent.pending.size, 1);
  hub.connect("alice", details, wire(events, details.instance, (job) => queueMicrotask(() => hub.result("alice", { id: job.id, instance: details.instance, result: { content: "ok" } }))));
  assert.equal(agent.reconnecting, false);
  assert.deepEqual(await waiting, { content: "ok" });
  assert.equal(events.length, 1);
});

test("a healthy ping still refreshes the heartbeat without replacing transport", async (t) => {
  const events: any[] = [], hub = new LocalAgents();
  t.after(() => hub.close());
  const transport = wire(events);
  hub.connect("alice", details, transport);
  const agent = hub.active("alice", details.clientId)!;
  const until = agent.onlineUntil;
  await new Promise((r) => setTimeout(r, 5));
  hub.connect("alice", details);
  assert.equal(agent.transport, transport);
  assert.equal(agent.reconnecting, false);
  assert(agent.onlineUntil >= until, "heartbeat deadline moves forward");
  const pending = hub.request(agent, "file", { op: "read" }, idle());
  hub.result("alice", { id: events[0].data.id, instance: details.instance, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("a live-socket browser timeout does not suspend the client or claim reconnect failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const events: any[] = [], hub = new LocalAgents();
  t.after(() => hub.close());
  const transport = wire(events);
  hub.connect("alice", details, transport);
  const agent = hub.active("alice", details.clientId)!;
  clearTimeout(agent.heartbeat);
  agent.onlineUntil = Date.now() + 86_400_000;
  const pending = hub.request(agent, "browser", { operation: "navigate", args: { url: "https://tapd.example/story" } }, idle());
  assert.equal(events[0].data.op, "browser");
  t.mock.timers.tick(180_000);
  await assert.rejects(pending, /浏览器操作超时.*连接仍正常/);
  assert.equal(agent.reconnecting, false, "healthy timeout must not enter reconnect recovery");
  assert.equal(agent.transport, transport, "control channel stays bound");
  assert.equal(events.some((e) => e.data.op === "cancel"), true);
});
