import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../server/core/auth";
import { Store } from "../server/core/store";
import { LocalAgents, LocalAgentUnavailable } from "../server/core/local-agent";
import { ClientSockets } from "../server/core/client-socket";

const details = { clientId: "d".repeat(32), instance: "a".repeat(32), name: "Office PC", cwd: "C:\\work", platform: "windows" };
async function fixture(t: any) {
  const store = new Store(":memory:"), auth = new Auth(store, "client-pairing-fixture-token");
  const login = await auth.setup({ setupToken: "client-pairing-fixture-token", username: "admin", password: "Long pairing fixture password" });
  const events: any[] = [], hub = new LocalAgents((event) => events.push(event)), sockets = new ClientSockets(store, auth, hub);
  t.after(() => { sockets.closeAll(); hub.close(); store.close(); });
  const ticket = () => hub.ticket(login.principal, details.instance).ticket;
  const peer = (token: string, id = "native") => {
    const messages: any[] = [], closed: any[] = [];
    return { id, request: new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + token } }), send: (raw: string) => { messages.push(JSON.parse(raw)); }, close: (...args: any[]) => { closed.push(args); }, messages, closed };
  };
  return { store, auth, login, events, hub, sockets, ticket, peer };
}

test("device pairing is one-use, hashed, scoped and persists without a website login or connection", async (t) => {
  const f = await fixture(t), oneUse = f.ticket();
  const paired = f.sockets.pair({ ticket: oneUse, clientId: details.clientId });
  assert.equal(paired.deviceToken.length, 43);
  assert.throws(() => f.sockets.pair({ ticket: oneUse, clientId: details.clientId }));
  assert(!JSON.stringify(f.store.objects("client-token")).includes(paired.deviceToken));
  const again = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId, deviceToken: paired.deviceToken });
  assert.equal(again.deviceToken, paired.deviceToken, "opening the website again must not rotate a healthy client's token");
  f.auth.logout(f.login.principal.hash);
  const socket = f.peer(paired.deviceToken);
  f.sockets.open(socket);
  f.sockets.message(socket, JSON.stringify({ type: "hello", ...details }));
  assert.equal(socket.messages[0].type, "ready");
  const operation = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "file", { op: "read", path: "note.txt" }, new AbortController().signal);
  const job = socket.messages.at(-1);
  assert.equal(job.op, "file");
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0, "jobs never use website events");
  f.sockets.message(socket, JSON.stringify({ type: "result", id: job.id, result: { content: "native result" } }));
  assert.deepEqual(await operation, { content: "native result" });
  f.sockets.message(socket, JSON.stringify({ type: "ping" }));
  assert.equal(socket.messages.at(-1).type, "pong");
  f.sockets.closeAll();
  const restarted = new ClientSockets(f.store, f.auth, f.hub);
  assert.equal(restarted.authorize(socket.request).clientId, details.clientId);
  restarted.closeAll();
});

test("device tokens are accepted only as native WebSocket Authorization and cannot impersonate a device", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  for (const request of [
    new Request("http://localhost/api/local-agent/socket?token=" + paired.deviceToken),
    new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + paired.deviceToken, origin: "http://localhost" } }),
    new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + f.login.token } }),
  ]) assert.throws(() => f.sockets.authorize(request));
  const socket = f.peer(paired.deviceToken);
  f.sockets.open(socket);
  f.sockets.message(socket, JSON.stringify({ type: "hello", ...details, clientId: "e".repeat(32) }));
  assert.equal(socket.closed.length, 1);
  assert.deepEqual(f.hub.list(f.login.principal.user.id), []);
  const viewer = await f.auth.add({ username: "viewer", password: "Long viewer fixture password", role: "viewer" });
  const login = f.auth.issue(viewer), ticket = f.hub.ticket(login.principal, details.instance);
  assert.throws(() => f.sockets.pair({ ticket: ticket.ticket, clientId: details.clientId }), /execution permission/);
});

test("reconnect never replays jobs, and an old connection cannot disconnect its replacement", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details }));
  const invalid = f.peer(paired.deviceToken, "malformed");
  f.sockets.open(invalid); f.sockets.message(invalid, JSON.stringify({ type: "hello", ...details, cwd: "" }));
  assert.equal(first.closed.length, 0, "an invalid replacement must not cancel healthy work");
  assert.equal(invalid.closed.length, 1);
  const pending = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "exec", { command: "once", timeout: 5 }, new AbortController().signal);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, instance: "b".repeat(32) }));
  await rejected;
  f.sockets.close(first.id);
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId)!.instance, "b".repeat(32));
  assert.equal(second.messages.length, 1, "the replacement gets readiness, not a replayed command");
  f.sockets.message(second, JSON.stringify({ type: "request", path: "/config" }));
  assert.equal(second.closed.length, 1, "native client credentials cannot call website APIs over their socket");
});

test("revocation and password changes erase device grants and terminate native sockets", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken);
  f.sockets.open(socket); f.sockets.message(socket, JSON.stringify({ type: "hello", ...details }));
  f.sockets.revoke("another-user", details.clientId);
  assert.equal(socket.closed.length, 0);
  f.sockets.revoke(f.login.principal.user.id, details.clientId);
  assert.equal(socket.closed.length, 1);
  assert.throws(() => f.sockets.authorize(socket.request));
  const next = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const native = f.peer(next.deviceToken, "new");
  f.sockets.open(native); f.sockets.message(native, JSON.stringify({ type: "hello", ...details }));
  await f.auth.update(f.login.principal.user.id, { password: "A newer long fixture password" });
  assert.equal(native.closed.length, 1);
  assert.equal(f.store.objects("client-token").length, 0);
});
