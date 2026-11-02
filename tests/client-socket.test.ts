import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../server/core/auth";
import { Store } from "../server/core/store";
import { CLIENT_HEARTBEAT_TIMEOUT, CLIENT_RECONNECT_GRACE, LocalAgents, LocalAgentUnavailable } from "../server/core/local-agent";
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

test("a transient disconnect resumes the same jobs and sends only operations not yet dispatched", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  agent.browserLeases.add("active-lease");
  const running = f.hub.request(agent, "browser", { operation: "click" }, new AbortController().signal);
  const original = first.messages.at(-1);
  f.sockets.close(first.id);
  assert.equal(agent.pending.size, 1);
  assert.equal(agent.reconnecting, true);
  const queued = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  assert(second.messages[0].pending.includes(original.id));
  assert.deepEqual(second.messages[0].leases, ["active-lease"]);
  await Promise.resolve();
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "file"]);
  const unsent = second.messages[1];
  assert.notEqual(unsent.id, original.id);
  f.sockets.message(second, JSON.stringify({ type: "result", id: original.id, result: { clicked: true } }));
  assert.deepEqual(await running, { clicked: true });
  assert.deepEqual(second.messages.at(-1), { type: "ack", id: original.id });
  f.sockets.message(second, JSON.stringify({ type: "result", id: original.id, result: { clicked: true } }));
  f.sockets.message(second, JSON.stringify({ type: "result", id: unsent.id, result: { content: "recovered" } }));
  assert.deepEqual(await queued, { content: "recovered" });
  assert.equal(agent.pending.size, 0);
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0);
});

test("same-instance socket replacement and late close do not interrupt healthy work", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first"), second = f.peer(paired.deviceToken, "second");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const running = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details }));
  f.sockets.close(first.id);
  f.sockets.message(first, JSON.stringify({ type: "ping" }));
  assert.equal(agent.reconnecting, false);
  assert.equal(first.closed.length, 1);
  f.sockets.message(second, JSON.stringify({ type: "result", id: job.id, result: { ok: true } }));
  assert.deepEqual(await running, { ok: true });
  assert.equal(second.messages.length, 1, "legacy clients receive no new protocol messages or replayed jobs");
});

test("a failed operation send waits for its result without retrying an ambiguous input", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const send = first.send;
  first.send = (raw) => { send(raw); throw Error("connection lost after write"); };
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const running = f.hub.request(agent, "file", { op: "write" }, new AbortController().signal), job = first.messages.at(-1);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready"]);
  f.sockets.message(second, JSON.stringify({ type: "result", id: job.id, result: { written: true } }));
  assert.deepEqual(await running, { written: true });
});

test("a failed result acknowledgement recovers other pending work rather than failing the client", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const completed = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  const running = f.hub.request(agent, "file", {}, new AbortController().signal), pendingJob = first.messages.at(-1);
  first.send = () => { throw Error("socket closed during ack"); };
  f.sockets.message(first, JSON.stringify({ type: "result", id: job.id, result: { ok: true } }));
  assert.deepEqual(await completed, { ok: true });
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  f.sockets.message(second, JSON.stringify({ type: "result", id: pendingJob.id, result: { recovered: true } }));
  assert.deepEqual(await running, { recovered: true });
});

test("a lost response gets one recovery probe before an uncertain result pauses", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  t.mock.timers.tick(25000);
  f.sockets.message(first, JSON.stringify({ type: "ping" }));
  t.mock.timers.tick(5000);
  assert.equal(agent.reconnecting, true, "a response timeout first attempts recovery, even with recent heartbeats");
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.deepEqual(second.messages[0].pending, [job.id]);
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(agent.reconnecting, false, "a failed probe must not start an endless recovery loop");
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "cancel"]);
});

test("missed heartbeats allow recovery, and only a sustained outage rejects pending work", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "browser", {}, new AbortController().signal), job = first.messages.at(-1);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  t.mock.timers.tick(CLIENT_HEARTBEAT_TIMEOUT);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  t.mock.timers.tick(CLIENT_RECONNECT_GRACE - 1);
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.equal(agent.reconnecting, false);
  assert.equal(agent.pending.size, 1, "response timeout is suspended during the reconnect window");
  assert.deepEqual(second.messages[0].pending, [job.id]);
  f.sockets.close(second.id);
  t.mock.timers.tick(CLIENT_RECONNECT_GRACE);
  await rejected;
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), undefined);
  assert.equal(second.messages.length, 1, "recovery never replays an already-dispatched action");
});

test("cancellation during an outage is reconciled on reconnect without dispatching queued work", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!, controller = new AbortController();
  const running = f.hub.request(agent, "exec", { command: "fixture", timeout: 5 }, controller.signal);
  const cancelled = assert.rejects(running, /cancelled/);
  f.sockets.close(first.id);
  const queued = f.hub.request(agent, "file", { op: "write" }, controller.signal);
  const unsent = assert.rejects(queued, /cancelled/);
  controller.abort(Error("cancelled"));
  await Promise.all([cancelled, unsent]);
  const second = f.peer(paired.deviceToken, "second");
  f.sockets.open(second); f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.deepEqual(second.messages[0].pending, []);
  assert.equal(second.messages.length, 1);
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0, "a disconnected native client must never fall back to website events");
});

test("revocation while reconnecting rejects work immediately and cannot be healed with a revoked grant", async (t) => {
  const f = await fixture(t), paired = f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken);
  f.sockets.open(first); f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "file", {}, new AbortController().signal);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  f.sockets.close(first.id);
  f.sockets.revoke(f.login.principal.user.id, details.clientId);
  await rejected;
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), undefined);
  assert.throws(() => f.sockets.authorize(first.request));
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
