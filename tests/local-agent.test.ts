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

test("local login tickets are one-use, bounded, expire and follow website revocation without API keys", () => {
  const hub = new LocalAgents();
  const principal = { hash: "login", user: { id: "alice" }, expiresAt: Date.now() + 10000 } as Principal;
  let current: Principal | undefined = principal;
  const auth = { resolveHash: () => current } as unknown as Auth;
  const first = hub.ticket(principal, details.instance);
  assert.equal(hub.verify(first.ticket, auth).userId, "alice");
  assert.throws(() => hub.verify(first.ticket, auth));
  const revoked = hub.ticket(principal, details.instance);
  current = undefined;
  assert.throws(() => hub.verify(revoked.ticket, auth));
  const expired = hub.ticket(principal, details.instance);
  (hub as any).tickets.get(expired.ticket).until = Date.now() - 1;
  current = principal;
  assert.throws(() => hub.verify(expired.ticket, auth));
  hub.close();
});

test("browser bridge routes only to its owner and instance, never another user or competing tab", async () => {
  const events: any[] = [], hub = new LocalAgents((event) => { if (event.type === "local_agent_request") events.push(event); });
  hub.connect("alice", details);
  hub.connect("bob", { ...details, instance: "b".repeat(32) });
  assert.throws(() => hub.connect("alice", { ...details, instance: "c".repeat(32) }));
  const pending = hub.request(hub.active("alice")!, "file", { op: "read" }, idle());
  const event = events[0];
  assert.equal(eventAllowed({ id: "alice" } as any, event), true);
  assert.equal(eventAllowed({ id: "bob", role: "admin" } as any, event), false);
  assert.throws(() => hub.result("bob", { ...event.data, result: { content: "stolen" } }));
  hub.result("alice", { ...event.data, result: { content: "ok" } });
  assert.deepEqual(await pending, { content: "ok" });
  hub.result("alice", { ...event.data, result: { content: "duplicate ignored" } });
  assert.equal(events.length, 1);
  hub.disconnect("alice", "stale");
  assert.ok(hub.active("alice"));
  hub.close();
});

test("multiple owned clients route by device and expire independently without falling back", async (t) => {
  const events: any[] = [], hub = new LocalAgents((event) => { if (event.type === "local_agent_request") events.push(event); });
  t.after(() => hub.close());
  const other = { ...details, clientId: "e".repeat(32), instance: "b".repeat(32), name: "Home PC" };
  hub.connect("alice", details);
  hub.connect("alice", other);
  hub.connect("bob", { ...details, instance: "c".repeat(32) });
  assert.deepEqual(hub.list("alice").map((c) => c.name), ["Office PC", "Home PC"]);
  assert.equal(hub.list("bob").length, 1);
  assert.equal(hub.active("alice"), undefined, "multiple clients require an explicit selection");
  assert.throws(() => hub.connect("alice", { ...details, instance: "f".repeat(32) }));
  assert.throws(() => hub.connect("alice", { ...other, clientId: "0".repeat(32) }), /instance already registered/);
  const office = hub.active("alice", details.clientId)!, home = hub.active("alice", other.clientId)!;
  const first = hub.request(office, "file", { op: "read" }, idle());
  const second = hub.request(home, "file", { op: "read" }, idle());
  assert.equal(events[0].data.instance, details.instance);
  assert.equal(events[1].data.instance, other.instance);
  hub.result("alice", { ...events[0].data, instance: other.instance, result: { content: "wrong client" } });
  assert.equal(office.pending.size, 1, "another client's result must not satisfy the selected client's job");
  hub.result("alice", { ...events[1].data, result: { content: "home" } });
  assert.deepEqual(await second, { content: "home" });
  const lost = assert.rejects(first, LocalAgentUnavailable);
  office.onlineUntil = Date.now() - 1;
  assert.deepEqual(hub.list("alice").map((c) => c.id), [other.clientId]);
  await lost;
  assert.equal(hub.active("alice", details.clientId), undefined);
  hub.connect("alice", { ...details, instance: "f".repeat(32) });
  assert.equal(hub.active("alice", details.clientId)!.instance, "f".repeat(32));
  assert.throws(() => hub.result("alice", { ...events[0].data, result: { content: "stale" } }), /disconnected/);
  hub.disconnect("alice", other.instance);
  assert.equal(hub.list("alice").length, 1);
  assert.equal(hub.list("bob").length, 1);
  hub.disconnect("alice");
  assert.deepEqual(hub.list("alice"), []);
});

test("unbound historical local sessions pause instead of guessing which computer to use", async () => {
  const store = new Store(":memory:"), hub = new LocalAgents();
  try {
    hub.connect("alice", details);
    const session = store.newSession({ ownerId: "alice", cwd: details.cwd, localAgent: true });
    const tools = new Tools({ store, localAgents: hub, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, idle(), () => {});
    const result = await tools.execute({ id: "unbound", name: "bash", arguments: { command: "must not run" } }, {} as any);
    assert.equal(result.stop, true);
    assert.match(result.pause!, /尚未绑定客户端/);
    assert.equal(hub.active("alice", details.clientId)!.pending.size, 0);
  } finally { hub.close(); store.close(); }
});

test("session cancellation sends a WebSocket cancel job and rejects the original pending request", async () => {
  const events: any[] = [], hub = new LocalAgents((event) => { if (event.type === "local_agent_request") events.push(event); });
  hub.connect("alice", details);
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
  const store = new Store(":memory:");
  const hub = new LocalAgents();
  hub.connect("alice", { ...details, cwd: dir });
  const session = store.newSession({ ownerId: "alice", cwd: dir, localAgent: true, clientId: details.clientId });
  const engine = { store, localAgents: hub, vault: new Vault(store), mcpFor: () => ({}) } as any;
  const tools = new Tools(engine, session, { model: "", provider: {} }, idle(), () => {});
  const operation = tools.execute({ id: "once", name: "bash", arguments: { command: "this command must not run on the server", timeout: 10 } }, {} as any);
  hub.disconnect("alice");
  const result = await operation;
  assert.equal(result.stop, true);
  assert.match(result.pause!, /修复连接.*继续/);
  assert.equal(result.error, true);
  assert.deepEqual(store.messages(session.id), []);
  const offline = await tools.execute({ id: "offline-write", name: "write", arguments: { path: "must-not-exist", content: "unsafe fallback" } }, {} as any);
  assert.equal(offline.stop, true);
  await assert.rejects(access(join(dir, "must-not-exist")));
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("local file reads resolve on the client rather than statting server paths", async () => {
  const store = new Store(":memory:");
  let hub: LocalAgents;
  hub = new LocalAgents((event) => { if (event.type === "local_agent_request") queueMicrotask(() => hub.result("alice", { ...event.data, result: { path: "C:\\only-on-client\\note.txt", content: Buffer.from("hello\nworld").toString("base64") } })); });
  hub.connect("alice", details);
  const session = store.newSession({ ownerId: "alice", cwd: details.cwd, localAgent: true, clientId: details.clientId });
  const tools = new Tools({ store, localAgents: hub, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, idle(), () => {});
  const result = await tools.execute({ id: "read", name: "read", arguments: { path: "note.txt" } }, {} as any);
  assert.match(result.value.text, /1\|hello\n2\|world/);
  assert.equal(store.stage(session.id).localAgent, true);
  assert.equal(store.fork(session.id).localAgent, true);
  hub.close(); store.close();
});
