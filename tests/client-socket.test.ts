import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../server/core/auth";
import { Store } from "../server/core/store";
import { CLIENT_HEARTBEAT_TIMEOUT, CLIENT_RECONNECT_GRACE, LocalAgents, LocalAgentUnavailable } from "../server/core/local-agent";
import { ClientSockets } from "../server/core/client-socket";
import { NetworkRelay } from "../server/core/network-relay";

const details = { clientId: "d".repeat(32), instance: "a".repeat(32), name: "Office PC", cwd: "C:\\work", platform: "windows" };
async function fixture(t: any, clientInUse: (clientId: string) => boolean = () => false) {
  const store = await Store.open(":memory:"), auth = new Auth(store, "client-pairing-fixture-token");
  const login = await auth.setup({ setupToken: "client-pairing-fixture-token", username: "admin", password: "Long pairing fixture password" });
  const events: any[] = [], hub = new LocalAgents((event) => events.push(event)), relay = new NetworkRelay(store, hub), sockets = new ClientSockets(store, auth, hub, clientInUse, relay);
  t.after(async () => { sockets.closeAll(); hub.close(); await relay.close(); await store.close(); });
  const ticket = () => hub.ticket(login.principal, details.instance).ticket;
  const peer = (token: string, id = "native") => {
    const messages: any[] = [], closed: any[] = [];
    return { id, request: new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + token } }), send: (raw: string) => { messages.push(JSON.parse(raw)); }, close: (...args: any[]) => { closed.push(args); }, messages, closed };
  };
  return { store, auth, login, events, hub, sockets, relay, ticket, peer };
}

test("relay policy follows authenticated account and device on hello and heartbeat", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken), owner = f.login.principal.user.id;
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details, userId: "other", relay: ["git.internal:443"] }));
  assert.equal((await f.relay.route(owner, "git.internal", 443))?.agent.clientId, details.clientId);
  assert.equal(await f.relay.route("other", "git.internal", 443), undefined);
  const agent = f.hub.active(owner, details.clientId)!;
  await f.sockets.message(socket, JSON.stringify({ type: "ping", relay: ["api.internal:8080"] }));
  assert.equal(f.hub.active(owner, details.clientId), agent);
  assert.equal(await f.relay.route(owner, "git.internal", 443), undefined);
  assert.equal((await f.relay.route(owner, "api.internal", 8080))?.agent.clientId, details.clientId);
  f.sockets.close(socket.id);
  await assert.rejects(f.relay.route(owner, "api.internal", 8080), /离线/);
});

test("invalid relay policy is rejected without clearing the last protected domains", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details, relay: ["git.internal:443"] }));
  await f.sockets.message(socket, JSON.stringify({ type: "ping", relay: ["localhost:80"] }));
  assert.equal(socket.closed.length, 1);
  await assert.rejects(f.relay.route(f.login.principal.user.id, "git.internal", 443), /离线/);
});

test("device pairing is one-use, hashed, scoped and persists without a website login or connection", async (t) => {
  const f = await fixture(t), oneUse = f.ticket();
  const paired = await f.sockets.pair({ ticket: oneUse, clientId: details.clientId });
  assert.equal(paired.deviceToken.length, 43);
  await assert.rejects(async () => await f.sockets.pair({ ticket: oneUse, clientId: details.clientId }));
  assert(!JSON.stringify(await f.store.objects("client-token")).includes(paired.deviceToken));
  const again = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId, deviceToken: paired.deviceToken });
  assert.equal(again.deviceToken, paired.deviceToken, "opening the website again must not rotate a healthy client's token");
  await f.auth.logout(f.login.principal.hash);
  const socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details }));
  assert.equal(socket.messages[0].type, "ready");
  const operation = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "file", { op: "read", path: "note.txt" }, new AbortController().signal);
  const job = socket.messages.at(-1);
  assert.equal(job.op, "file");
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0, "jobs never use website events");
  await f.sockets.message(socket, JSON.stringify({ type: "result", id: job.id, result: { content: "native result" } }));
  assert.deepEqual(await operation, { content: "native result" });
  await f.sockets.message(socket, JSON.stringify({ type: "ping" }));
  assert.equal(socket.messages.at(-1).type, "pong");
  f.sockets.closeAll();
  const restarted = new ClientSockets(f.store, f.auth, f.hub, () => false);
  assert.equal((await restarted.authorize(socket.request)).clientId, details.clientId);
  restarted.closeAll();
});

test("client supplements update through heartbeats without replacing jobs, leases or device identity", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details, supplement: "项目目录：D:\\code\\old" }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  assert.equal(agent.supplement, "项目目录：D:\\code\\old");
  assert(!JSON.stringify(f.hub.list(f.login.principal.user.id)).includes("项目目录"));
  agent.browserLeases.add("existing-lease");
  const pending = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal), job = socket.messages.at(-1);
  await f.sockets.message(socket, JSON.stringify({ type: "ping", clientId: "e".repeat(32), supplement: "项目目录：D:\\code\\new\n仅作路径提示" }));
  assert.equal(agent, f.hub.active(f.login.principal.user.id, details.clientId));
  assert.equal(agent.clientId, details.clientId);
  assert.equal(agent.supplement, "项目目录：D:\\code\\new\n仅作路径提示");
  assert.equal(agent.pending.size, 1);
  assert(agent.browserLeases.has("existing-lease"));
  await f.sockets.message(socket, JSON.stringify({ type: "ping" }));
  assert.match(agent.supplement!, /new/);
  await f.sockets.message(socket, JSON.stringify({ type: "result", id: job.id, result: { ok: true } }));
  assert.deepEqual(await pending, { ok: true });
  await f.sockets.message(socket, JSON.stringify({ type: "ping", supplement: "" }));
  assert.equal(agent.supplement, "");
  assert.equal(socket.closed.length, 0);
});

test("client supplements reject oversized, non-text and NUL input on hello and heartbeat", async (t) => {
  for (const phase of ["hello", "ping"]) for (const supplement of [null, 42, "x".repeat(8193), "中".repeat(3000), "bad\0text"]) {
    const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), socket = f.peer(paired.deviceToken);
    await f.sockets.open(socket);
    if (phase === "ping") await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details }));
    await f.sockets.message(socket, JSON.stringify({ ...details, type: phase, supplement }));
    assert.equal(socket.closed.length, 1, phase);
    assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), undefined);
  }
});

test("automatic update drains only idle clients and queues new work across a same-instance restart", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const hello = { type: "hello", ...details, version: "0.3.0", autoUpdate: true, resume: true };
  const first = f.peer(paired.deviceToken, "before-update");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify(hello));
  assert.equal(first.messages[0].autoUpdate, true);
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const working = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal), job = first.messages.at(-1);
  await f.sockets.message(first, JSON.stringify({ type: "update_prepare" }));
  assert.equal(first.messages.at(-1).type, "update_busy");
  assert.equal(agent.reconnecting, false);
  await f.sockets.message(first, JSON.stringify({ type: "result", id: job.id, result: { done: true } }));
  await working;
  agent.browserLeases.add("active-turn");
  await f.sockets.message(first, JSON.stringify({ type: "update_prepare" }));
  assert.equal(first.messages.at(-1).type, "update_busy", "a browser lease is busy even between browser commands");
  agent.browserLeases.clear();
  await f.sockets.message(first, JSON.stringify({ type: "update_prepare" }));
  assert.equal(first.messages.at(-1).type, "update_ready");
  assert.equal(first.closed.length, 0, "the updater must receive readiness before its socket is closed");
  assert.equal(agent.reconnecting, true);
  await f.sockets.message(first, JSON.stringify({ type: "ping" }));
  assert.equal(agent.reconnecting, true, "heartbeats must not undo the update reservation");
  const queued = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal);
  assert.equal(first.messages.at(-1).type, "pong", "no new job is dispatched to the exiting process");
  const second = f.peer(paired.deviceToken, "after-update");
  f.sockets.close(first.id);
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ ...hello, version: "0.3.1" }));
  await Promise.resolve();
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "file"]);
  const resumed = second.messages.at(-1);
  await f.sockets.message(second, JSON.stringify({ type: "result", id: resumed.id, result: { updated: true } }));
  assert.deepEqual(await queued, { updated: true });
});

test("a running session blocks updates during model thinking even without local operations", async (t) => {
  const running = new Set([details.clientId]);
  const f = await fixture(t, (clientId) => running.has(clientId));
  const paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details, version: "0.3.0", autoUpdate: true, resume: true }));
  assert.equal(socket.messages[0].busy, true);
  assert.equal(socket.messages[0].sessionIdle, true);
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  assert.equal(agent.pending.size, 0);
  assert.equal(agent.browserLeases.size, 0);
  await f.sockets.message(socket, JSON.stringify({ type: "update_prepare" }));
  assert.equal(socket.messages.at(-1).type, "update_busy");
  assert.equal(agent.reconnecting, false);
  assert.equal(socket.closed.length, 0);
  await f.sockets.message(socket, JSON.stringify({ type: "ping" }));
  assert.deepEqual(socket.messages.at(-1), { type: "pong", busy: true });
  running.clear();
  await f.sockets.message(socket, JSON.stringify({ type: "ping" }));
  assert.deepEqual(socket.messages.at(-1), { type: "pong", busy: false });
  running.add(details.clientId); // A session can start after the last idle heartbeat.
  await f.sockets.message(socket, JSON.stringify({ type: "update_prepare" }));
  assert.equal(socket.messages.at(-1).type, "update_busy");
  assert.equal(socket.closed.length, 0);
  running.clear();
  await f.sockets.message(socket, JSON.stringify({ type: "update_prepare" }));
  assert.equal(socket.messages.at(-1).type, "update_ready");
});

test("an update reservation aborted before installation resumes queued work without replay", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const hello = { type: "hello", ...details, version: "0.3.0", autoUpdate: true, resume: true };
  const first = f.peer(paired.deviceToken, "prepare");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify(hello));
  await f.sockets.message(first, JSON.stringify({ type: "update_prepare" }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const queued = f.hub.request(agent, "file", {}, new AbortController().signal);
  f.sockets.close(first.id);
  const retry = f.peer(paired.deviceToken, "unchanged-client");
  await f.sockets.open(retry); await f.sockets.message(retry, JSON.stringify(hello));
  await Promise.resolve();
  assert.deepEqual(retry.messages.map((m) => m.type || m.op), ["ready", "file"]);
  await f.sockets.message(retry, JSON.stringify({ type: "result", id: retry.messages[1].id, result: { ok: true } }));
  assert.deepEqual(await queued, { ok: true });
});

test("device tokens are accepted only as native WebSocket Authorization and cannot impersonate a device", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  for (const request of [
    new Request("http://localhost/api/local-agent/socket?token=" + paired.deviceToken),
    new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + paired.deviceToken, origin: "http://localhost" } }),
    new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + f.login.token } }),
  ]) await assert.rejects(async () => await f.sockets.authorize(request));
  const socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details, clientId: "e".repeat(32) }));
  assert.equal(socket.closed.length, 1);
  assert.deepEqual(f.hub.list(f.login.principal.user.id), []);
  const viewer = await f.auth.add({ username: "viewer", password: "Long viewer fixture password", role: "viewer" });
  const login = await f.auth.issue(viewer), ticket = f.hub.ticket(login.principal, details.instance);
  await assert.rejects(async () => await f.sockets.pair({ ticket: ticket.ticket, clientId: details.clientId }), /execution permission/);
});

test("reconnect never replays jobs, and an old connection cannot disconnect its replacement", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details }));
  const invalid = f.peer(paired.deviceToken, "malformed");
  await f.sockets.open(invalid); await f.sockets.message(invalid, JSON.stringify({ type: "hello", ...details, cwd: "" }));
  assert.equal(first.closed.length, 0, "an invalid replacement must not cancel healthy work");
  assert.equal(invalid.closed.length, 1);
  const pending = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "exec", { command: "once", timeout: 5 }, new AbortController().signal);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, instance: "b".repeat(32) }));
  await rejected;
  f.sockets.close(first.id);
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId)!.instance, "b".repeat(32));
  assert.equal(second.messages.length, 1, "the replacement gets readiness, not a replayed command");
  await f.sockets.message(second, JSON.stringify({ type: "request", path: "/config" }));
  assert.equal(second.closed.length, 1, "native client credentials cannot call website APIs over their socket");
});

test("a transient disconnect resumes the same jobs and sends only operations not yet dispatched", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  agent.browserLeases.add("active-lease");
  const running = f.hub.request(agent, "browser", { operation: "click" }, new AbortController().signal);
  const original = first.messages.at(-1);
  f.sockets.close(first.id);
  assert.equal(agent.pending.size, 1);
  assert.equal(agent.reconnecting, true);
  const queued = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  assert(second.messages[0].pending.includes(original.id));
  assert.deepEqual(second.messages[0].leases, ["active-lease"]);
  await Promise.resolve();
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "file"]);
  const unsent = second.messages[1];
  assert.notEqual(unsent.id, original.id);
  await f.sockets.message(second, JSON.stringify({ type: "result", id: original.id, result: { clicked: true } }));
  assert.deepEqual(await running, { clicked: true });
  assert.deepEqual(second.messages.at(-1), { type: "ack", id: original.id });
  await f.sockets.message(second, JSON.stringify({ type: "result", id: original.id, result: { clicked: true } }));
  await f.sockets.message(second, JSON.stringify({ type: "result", id: unsent.id, result: { content: "recovered" } }));
  assert.deepEqual(await queued, { content: "recovered" });
  assert.equal(agent.pending.size, 0);
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0);
});

test("same-instance socket replacement and late close do not interrupt healthy work", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first"), second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const running = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details }));
  f.sockets.close(first.id);
  await f.sockets.message(first, JSON.stringify({ type: "ping" }));
  assert.equal(agent.reconnecting, false);
  assert.equal(first.closed.length, 1);
  await f.sockets.message(second, JSON.stringify({ type: "result", id: job.id, result: { ok: true } }));
  assert.deepEqual(await running, { ok: true });
  assert.equal(second.messages.length, 1, "legacy clients receive no new protocol messages or replayed jobs");
});

test("a failed operation send waits for its result without retrying an ambiguous input", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const send = first.send;
  first.send = (raw) => { send(raw); throw Error("connection lost after write"); };
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const running = f.hub.request(agent, "file", { op: "write" }, new AbortController().signal), job = first.messages.at(-1);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready"]);
  await f.sockets.message(second, JSON.stringify({ type: "result", id: job.id, result: { written: true } }));
  assert.deepEqual(await running, { written: true });
});

test("a failed result acknowledgement recovers other pending work rather than failing the client", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const completed = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  const running = f.hub.request(agent, "file", {}, new AbortController().signal), pendingJob = first.messages.at(-1);
  first.send = () => { throw Error("socket closed during ack"); };
  await f.sockets.message(first, JSON.stringify({ type: "result", id: job.id, result: { ok: true } }));
  assert.deepEqual(await completed, { ok: true });
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await f.sockets.message(second, JSON.stringify({ type: "result", id: pendingJob.id, result: { recovered: true } }));
  assert.deepEqual(await running, { recovered: true });
});

test("a lost response gets one recovery probe before an uncertain result pauses", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  t.mock.timers.tick(25000);
  await f.sockets.message(first, JSON.stringify({ type: "ping" }));
  t.mock.timers.tick(5000);
  assert.equal(agent.reconnecting, true, "a response timeout first attempts recovery, even with recent heartbeats");
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.deepEqual(second.messages[0].pending, [job.id]);
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(agent.reconnecting, false, "a failed probe must not start an endless recovery loop");
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "cancel"]);
});

test("missed heartbeats allow recovery, and only a sustained outage rejects pending work", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "browser", {}, new AbortController().signal), job = first.messages.at(-1);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  t.mock.timers.tick(CLIENT_HEARTBEAT_TIMEOUT);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  t.mock.timers.tick(CLIENT_RECONNECT_GRACE - 1);
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
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
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!, controller = new AbortController();
  const running = f.hub.request(agent, "exec", { command: "fixture", timeout: 5 }, controller.signal);
  const cancelled = assert.rejects(running, /cancelled/);
  f.sockets.close(first.id);
  const queued = f.hub.request(agent, "file", { op: "write" }, controller.signal);
  const unsent = assert.rejects(queued, /cancelled/);
  controller.abort(Error("cancelled"));
  await Promise.all([cancelled, unsent]);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second, JSON.stringify({ type: "hello", ...details, resume: true }));
  await Promise.resolve();
  assert.deepEqual(second.messages[0].pending, []);
  assert.equal(second.messages.length, 1);
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0, "a disconnected native client must never fall back to website events");
});

test("revocation while reconnecting rejects work immediately and cannot be healed with a revoked grant", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken);
  await f.sockets.open(first); await f.sockets.message(first, JSON.stringify({ type: "hello", ...details, resume: true }));
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "file", {}, new AbortController().signal);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  f.sockets.close(first.id);
  await f.sockets.revoke(f.login.principal.user.id, details.clientId);
  await rejected;
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), undefined);
  await assert.rejects(async () => await f.sockets.authorize(first.request));
});

test("revocation and password changes erase device grants and terminate native sockets", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket); await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details }));
  await f.sockets.revoke("another-user", details.clientId);
  assert.equal(socket.closed.length, 0);
  await f.sockets.revoke(f.login.principal.user.id, details.clientId);
  assert.equal(socket.closed.length, 1);
  await assert.rejects(async () => await f.sockets.authorize(socket.request));
  const next = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const native = f.peer(next.deviceToken, "new");
  await f.sockets.open(native); await f.sockets.message(native, JSON.stringify({ type: "hello", ...details }));
  await f.auth.update(f.login.principal.user.id, { password: "A newer long fixture password" });
  assert.equal(native.closed.length, 1);
  assert.equal((await f.store.objects("client-token")).length, 0);
});

test("large results arrive over HTTP from the same device and instance; the socket only takes small messages", async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket, JSON.stringify({ type: "hello", ...details }));
  const operation = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "file", { op: "read", path: "big.bin" }, new AbortController().signal);
  const job = socket.messages.at(-1);
  const content = "x".repeat(4 << 20);
  const post = (token: string, instance = details.instance) => new Request("http://localhost/api/local-agent/result", { method: "POST", headers: { authorization: "Bearer " + token, "x-vega-instance": instance } });
  await assert.rejects(async () => await f.sockets.upload(post("A".repeat(43)), { type: "result", id: job.id, result: { content } }), "a wrong device token is refused");
  await assert.rejects(async () => await f.sockets.upload(post(deviceToken, "b".repeat(32)), { type: "result", id: job.id, result: { content } }), "another instance cannot answer");
  assert.deepEqual(await f.sockets.upload(post(deviceToken), { type: "result", id: job.id, result: { content } }), { ok: true });
  assert.equal((await operation as any).content.length, content.length);
  await f.sockets.message(socket, JSON.stringify({ type: "result", id: job.id, result: { content } }));
  assert.equal(socket.closed.length, 1, "an oversized socket message is refused");
});
