import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../server/core/auth";
import { Store } from "../server/core/store";
import { CLIENT_HEARTBEAT_TIMEOUT, CLIENT_RECONNECT_GRACE, LocalAgents, LocalAgentUnavailable } from "../server/core/local-agent";
import { ClientSockets, MIN_CLIENT_VERSION } from "../server/core/client-socket";
import { NetworkRelay } from "../server/core/network-relay";
import type { SendOptions, Wire } from "../server/core/sse";

const details = { clientId: "d".repeat(32), instance: "a".repeat(32), name: "Office PC", cwd: "C:\\work", platform: "windows" };
async function fixture(t: any, clientInUse: (clientId: string) => boolean = () => false, offlineHandoff?: (userId: string, clientId: string) => Promise<any>) {
  // 多数用例用旧版本号或省略版本模拟历史客户端；版本门槛单独测，这里先关掉。
  const minimum = process.env.VEGA_MIN_CLIENT_VERSION;
  process.env.VEGA_MIN_CLIENT_VERSION = "";
  t.after(() => { if (minimum === undefined) delete process.env.VEGA_MIN_CLIENT_VERSION; else process.env.VEGA_MIN_CLIENT_VERSION = minimum; });
  const store = await Store.open(":memory:"), auth = new Auth(store, "client-pairing-fixture-token");
  const login = await auth.setup({ setupToken: "client-pairing-fixture-token", username: "admin", password: "Long pairing fixture password" });
  const events: any[] = [], hub = new LocalAgents((event) => events.push(event)), relay = new NetworkRelay(store, hub), sockets = new ClientSockets(store, auth, hub, clientInUse, relay, undefined, offlineHandoff);
  t.after(async () => { sockets.closeAll(); hub.close(); await relay.close(); await store.close(); });
  const ticket = () => hub.ticket(login.principal, details.instance).ticket;
  // 一条客户端控制通道 = 一个下行 Wire（消息对象，不再是 JSON 文本）＋ 一个上行 message(id, value)。
  const peer = (token: string, id = "native") => {
    const messages: any[] = [], closed: [number, string][] = [];
    return { id, request: { url: "http://localhost/api/local-agent/socket", headers: new Headers({ authorization: "Bearer " + token }) },
      send: (value: unknown, _options?: SendOptions) => { messages.push(value); },
      close: (code: number, reason: string) => { closed.push([code, reason]); }, buffered: 0, messages, closed } satisfies Wire & { messages: any[]; closed: [number, string][] };
  };
  return { store, auth, login, events, hub, sockets, relay, ticket, peer };
}

test("relay policy follows authenticated account and device on hello and heartbeat", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken), owner = f.login.principal.user.id;
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details, userId: "other", relay: ["git.internal:443"] });
  assert.equal((await f.relay.route(owner, "git.internal", 443))?.agent.clientId, details.clientId);
  assert.equal(await f.relay.route("other", "git.internal", 443), undefined);
  const agent = f.hub.active(owner, details.clientId)!;
  await f.sockets.message(socket.id, { type: "ping", relay: ["api.internal:8080"] });
  assert.equal(f.hub.active(owner, details.clientId), agent);
  assert.equal(await f.relay.route(owner, "git.internal", 443), undefined);
  assert.equal((await f.relay.route(owner, "api.internal", 8080))?.agent.clientId, details.clientId);
  f.sockets.close(socket.id);
  await assert.rejects(f.relay.route(owner, "api.internal", 8080), /离线/);
});

test("invalid relay policy is rejected without clearing the last protected domains", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details, relay: ["git.internal:443"] });
  await f.sockets.message(socket.id, { type: "ping", relay: ["localhost:80"] });
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
  await f.sockets.message(socket.id, { type: "hello", ...details });
  assert.equal(socket.messages[0].type, "ready");
  const operation = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "file", { op: "read", path: "note.txt" }, new AbortController().signal);
  const job = socket.messages.at(-1);
  assert.equal(job.op, "file");
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0, "jobs never use website events");
  await f.sockets.message(socket.id, { type: "result", id: job.id, result: { content: "native result" } });
  assert.deepEqual(await operation, { content: "native result" });
  await f.sockets.message(socket.id, { type: "ping" });
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
  await f.sockets.message(socket.id, { type: "hello", ...details, supplement: "项目目录：D:\\code\\old" });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  assert.equal(agent.supplement, "项目目录：D:\\code\\old");
  assert(!JSON.stringify(f.hub.list(f.login.principal.user.id)).includes("项目目录"));
  agent.browserLeases.add("existing-lease");
  const pending = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal), job = socket.messages.at(-1);
  await f.sockets.message(socket.id, { type: "ping", clientId: "e".repeat(32), supplement: "项目目录：D:\\code\\new\n仅作路径提示" });
  assert.equal(agent, f.hub.active(f.login.principal.user.id, details.clientId));
  assert.equal(agent.clientId, details.clientId);
  assert.equal(agent.supplement, "项目目录：D:\\code\\new\n仅作路径提示");
  assert.equal(agent.pending.size, 1);
  assert(agent.browserLeases.has("existing-lease"));
  await f.sockets.message(socket.id, { type: "ping" });
  assert.match(agent.supplement!, /new/);
  await f.sockets.message(socket.id, { type: "result", id: job.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  await f.sockets.message(socket.id, { type: "ping", supplement: "" });
  assert.equal(agent.supplement, "");
  assert.equal(socket.closed.length, 0);
});

test("client browser preference and login state follow the client's own config on hello and heartbeat", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken), owner = f.login.principal.user.id;
  await f.sockets.open(socket);
  // 旧客户端不上报 browser：按本机浏览器处理。
  await f.sockets.message(socket.id, { type: "hello", ...details });
  assert.equal(f.hub.active(owner, details.clientId)!.browser, "local");
  assert.equal(f.hub.list(owner)[0].browser, "local");
  await f.sockets.message(socket.id, { type: "ping", browser: "cloud" });
  assert.equal(f.hub.active(owner, details.clientId)!.browser, "cloud");
  assert.equal(f.hub.list(owner)[0].browser, "cloud");
  // 登录态开关已取消：即使旧客户端上报 false，也视为允许借用。
  assert.equal(f.hub.active(owner, details.clientId)!.loginState, true);
  await f.sockets.message(socket.id, { type: "ping", loginState: false });
  assert.equal(f.hub.active(owner, details.clientId)!.loginState, true);
  await f.sockets.message(socket.id, { type: "ping", browser: "bogus" });
  assert.equal(socket.closed.length, 1, "无效位置不静默接受");
});

test("client supplements reject oversized, non-text and NUL input on hello and heartbeat", async (t) => {
  for (const phase of ["hello", "ping"]) for (const supplement of [null, 42, "x".repeat(8193), "中".repeat(3000), "bad\0text"]) {
    const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), socket = f.peer(paired.deviceToken);
    await f.sockets.open(socket);
    if (phase === "ping") await f.sockets.message(socket.id, { type: "hello", ...details });
    await f.sockets.message(socket.id, { ...details, type: phase, supplement });
    assert.equal(socket.closed.length, 1, phase);
    assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), undefined);
  }
});

test("automatic update drains only idle clients and queues new work across a same-instance restart", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const hello = { type: "hello", ...details, version: "0.3.0", autoUpdate: true, resume: true };
  const first = f.peer(paired.deviceToken, "before-update");
  await f.sockets.open(first); await f.sockets.message(first.id, hello);
  assert.equal(first.messages[0].autoUpdate, true);
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const working = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal), job = first.messages.at(-1);
  await f.sockets.message(first.id, { type: "update_prepare" });
  assert.equal(first.messages.at(-1).type, "update_busy");
  assert.equal(agent.reconnecting, false);
  await f.sockets.message(first.id, { type: "result", id: job.id, result: { done: true } });
  await working;
  agent.browserLeases.add("active-turn");
  await f.sockets.message(first.id, { type: "update_prepare" });
  assert.equal(first.messages.at(-1).type, "update_busy", "a browser lease is busy even between browser commands");
  agent.browserLeases.clear();
  await f.sockets.message(first.id, { type: "update_prepare" });
  assert.equal(first.messages.at(-1).type, "update_ready");
  assert.equal(first.closed.length, 0, "the updater must receive readiness before its socket is closed");
  assert.equal(agent.reconnecting, true);
  await f.sockets.message(first.id, { type: "ping" });
  assert.equal(agent.reconnecting, true, "heartbeats must not undo the update reservation");
  const queued = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal);
  assert.equal(first.messages.at(-1).type, "pong", "no new job is dispatched to the exiting process");
  const second = f.peer(paired.deviceToken, "after-update");
  f.sockets.close(first.id);
  await f.sockets.open(second); await f.sockets.message(second.id, { ...hello, version: "0.3.1" });
  await Promise.resolve();
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "file"]);
  const resumed = second.messages.at(-1);
  await f.sockets.message(second.id, { type: "result", id: resumed.id, result: { updated: true } });
  assert.deepEqual(await queued, { updated: true });
});

test("a live socket's heartbeat rebinds a suspended device instead of leaving it online but unusable", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(paired.deviceToken), owner = f.login.principal.user.id;
  await f.sockets.open(socket); await f.sockets.message(socket.id, { type: "hello", ...details });
  const agent = f.hub.active(owner, details.clientId)!;
  // 更新预留 / 心跳过期会清掉 transport 但留着 socket：此时设备仍列在线，只是发不出任何操作。
  f.hub.suspend(owner, agent.instance, agent.transport, true);
  assert.equal(f.hub.active(owner, details.clientId)!.transport, undefined);
  await f.sockets.message(socket.id, { type: "ping" });
  const revived = f.hub.active(owner, details.clientId)!;
  assert.equal(revived.reconnecting, false);
  assert(revived.transport, "活着的 socket 必须在心跳时接回来，否则设备在线而每个操作都失败");
  const pending = f.hub.request(revived, "file", { op: "read" }, new AbortController().signal);
  const job = socket.messages.at(-1);
  assert.equal(job.op, "file");
  await f.sockets.message(socket.id, { type: "result", id: job.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  // 宽限到期被断开（transport 已丢，socket 关不掉）后，同样的心跳要能重建一条可派发的记录。
  f.hub.suspend(owner, agent.instance, revived.transport, true);
  revived.onlineUntil = 0;
  f.hub.active(owner, details.clientId);
  assert.deepEqual(f.hub.list(owner), []);
  await f.sockets.message(socket.id, { type: "ping" });
  const back = f.hub.active(owner, details.clientId)!;
  assert(back.transport);
  const again = f.hub.request(back, "file", { op: "read" }, new AbortController().signal), next = socket.messages.at(-1);
  assert.equal(next.op, "file");
  await f.sockets.message(socket.id, { type: "result", id: next.id, result: { ok: 2 } });
  assert.deepEqual(await again, { ok: 2 });
});

test("a running session blocks updates during model thinking even without local operations", async (t) => {
  const running = new Set([details.clientId]);
  const f = await fixture(t, (clientId) => running.has(clientId));
  const paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details, version: "0.3.0", autoUpdate: true, resume: true });
  assert.equal(socket.messages[0].busy, true);
  assert.equal(socket.messages[0].sessionIdle, true);
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  assert.equal(agent.pending.size, 0);
  assert.equal(agent.browserLeases.size, 0);
  await f.sockets.message(socket.id, { type: "update_prepare" });
  assert.equal(socket.messages.at(-1).type, "update_busy");
  assert.equal(agent.reconnecting, false);
  assert.equal(socket.closed.length, 0);
  await f.sockets.message(socket.id, { type: "ping" });
  assert.deepEqual(socket.messages.at(-1), { type: "pong", busy: true });
  running.clear();
  await f.sockets.message(socket.id, { type: "ping" });
  assert.deepEqual(socket.messages.at(-1), { type: "pong", busy: false });
  running.add(details.clientId); // A session can start after the last idle heartbeat.
  await f.sockets.message(socket.id, { type: "update_prepare" });
  assert.equal(socket.messages.at(-1).type, "update_busy");
  assert.equal(socket.closed.length, 0);
  running.clear();
  await f.sockets.message(socket.id, { type: "update_prepare" });
  assert.equal(socket.messages.at(-1).type, "update_ready");
});

test("an update reservation aborted before installation resumes queued work without replay", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const hello = { type: "hello", ...details, version: "0.3.0", autoUpdate: true, resume: true };
  const first = f.peer(paired.deviceToken, "prepare");
  await f.sockets.open(first); await f.sockets.message(first.id, hello);
  await f.sockets.message(first.id, { type: "update_prepare" });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const queued = f.hub.request(agent, "file", {}, new AbortController().signal);
  f.sockets.close(first.id);
  const retry = f.peer(paired.deviceToken, "unchanged-client");
  await f.sockets.open(retry); await f.sockets.message(retry.id, hello);
  await Promise.resolve();
  assert.deepEqual(retry.messages.map((m) => m.type || m.op), ["ready", "file"]);
  await f.sockets.message(retry.id, { type: "result", id: retry.messages[1].id, result: { ok: true } });
  assert.deepEqual(await queued, { ok: true });
});

test("device tokens are accepted only as native-client Authorization and cannot impersonate a device", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  for (const request of [
    new Request("http://localhost/api/local-agent/socket?token=" + paired.deviceToken),
    new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + paired.deviceToken, origin: "http://localhost" } }),
    new Request("http://localhost/api/local-agent/socket", { headers: { authorization: "Bearer " + f.login.token } }),
  ]) await assert.rejects(async () => await f.sockets.authorize(request));
  // 数据车道用 ?channel=&lane= 打开同一个身份：带查询串的 URL 不再被拒。
  const lane = await f.sockets.authorize({ url: "http://localhost/api/local-agent/socket?channel=abc&lane=1", headers: new Headers({ authorization: "Bearer " + paired.deviceToken }) });
  assert.equal(lane.clientId, details.clientId);
  const socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details, clientId: "e".repeat(32) });
  assert.equal(socket.closed.length, 1);
  assert.deepEqual(f.hub.list(f.login.principal.user.id), []);
  const viewer = await f.auth.add({ username: "viewer", password: "Long viewer fixture password", role: "viewer" });
  const login = await f.auth.issue(viewer), ticket = f.hub.ticket(login.principal, details.instance);
  await assert.rejects(async () => await f.sockets.pair({ ticket: ticket.ticket, clientId: details.clientId }), /execution permission/);
});

test("reconnect never replays jobs, and an old connection cannot disconnect its replacement", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details });
  const invalid = f.peer(paired.deviceToken, "malformed");
  await f.sockets.open(invalid); await f.sockets.message(invalid.id, { type: "hello", ...details, cwd: "" });
  assert.equal(first.closed.length, 0, "an invalid replacement must not cancel healthy work");
  assert.equal(invalid.closed.length, 1);
  const pending = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "exec", { command: "once", timeout: 5 }, new AbortController().signal);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details, instance: "b".repeat(32) });
  await rejected;
  f.sockets.close(first.id);
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId)!.instance, "b".repeat(32));
  assert.equal(second.messages.length, 1, "the replacement gets readiness, not a replayed command");
  await f.sockets.message(second.id, { type: "request", path: "/config" });
  assert.equal(second.closed.length, 1, "native client credentials cannot call website APIs over their socket");
});

test("a transient disconnect resumes the same jobs and sends only operations not yet dispatched", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  agent.browserLeases.add("active-lease");
  const running = f.hub.request(agent, "browser", { operation: "click" }, new AbortController().signal);
  const original = first.messages.at(-1);
  f.sockets.close(first.id);
  assert.equal(agent.pending.size, 1);
  assert.equal(agent.reconnecting, true);
  const queued = f.hub.request(agent, "file", { op: "read" }, new AbortController().signal);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details, resume: true });
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  assert(second.messages[0].pending.includes(original.id));
  assert.deepEqual(second.messages[0].leases, ["active-lease"]);
  await Promise.resolve();
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready", "file"]);
  const unsent = second.messages[1];
  assert.notEqual(unsent.id, original.id);
  await f.sockets.message(second.id, { type: "result", id: original.id, result: { clicked: true } });
  assert.deepEqual(await running, { clicked: true });
  assert.deepEqual(second.messages.at(-1), { type: "ack", id: original.id });
  await f.sockets.message(second.id, { type: "result", id: original.id, result: { clicked: true } });
  await f.sockets.message(second.id, { type: "result", id: unsent.id, result: { content: "recovered" } });
  assert.deepEqual(await queued, { content: "recovered" });
  assert.equal(agent.pending.size, 0);
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0);
});

test("same-instance socket replacement and late close do not interrupt healthy work", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first"), second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const running = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details });
  f.sockets.close(first.id);
  await f.sockets.message(first.id, { type: "ping" });
  assert.equal(agent.reconnecting, false);
  assert.equal(first.closed.length, 1);
  await f.sockets.message(second.id, { type: "result", id: job.id, result: { ok: true } });
  assert.deepEqual(await running, { ok: true });
  assert.equal(second.messages.length, 1, "legacy clients receive no new protocol messages or replayed jobs");
});

test("a failed operation send waits for its result without retrying an ambiguous input", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
  const send = first.send;
  first.send = (value, options) => { send(value, options); throw Error("connection lost after write"); };
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const running = f.hub.request(agent, "file", { op: "write" }, new AbortController().signal), job = first.messages.at(-1);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details, resume: true });
  await Promise.resolve();
  assert.deepEqual(second.messages.map((m) => m.type || m.op), ["ready"]);
  await f.sockets.message(second.id, { type: "result", id: job.id, result: { written: true } });
  assert.deepEqual(await running, { written: true });
});

test("a failed result acknowledgement recovers other pending work rather than failing the client", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const completed = f.hub.request(agent, "file", {}, new AbortController().signal), job = first.messages.at(-1);
  const running = f.hub.request(agent, "file", {}, new AbortController().signal), pendingJob = first.messages.at(-1);
  first.send = () => { throw Error("socket closed during ack"); };
  await f.sockets.message(first.id, { type: "result", id: job.id, result: { ok: true } });
  assert.deepEqual(await completed, { ok: true });
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details, resume: true });
  await f.sockets.message(second.id, { type: "result", id: pendingJob.id, result: { recovered: true } });
  assert.deepEqual(await running, { recovered: true });
});

test("a live-socket response timeout cancels the job without pretending the client disconnected", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "file", {}, new AbortController().signal);
  const rejected = assert.rejects(pending, /操作超时.*连接仍正常/);
  t.mock.timers.tick(25000);
  await f.sockets.message(first.id, { type: "ping" });
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(agent.reconnecting, false, "a healthy timeout must not tear down the control channel");
  assert.equal(!!agent.transport, true);
  assert.equal(first.messages.some((m) => m.op === "cancel"), true);
});

test("missed heartbeats allow recovery, and only a sustained outage rejects pending work", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const first = f.peer(paired.deviceToken, "first");
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!;
  const pending = f.hub.request(agent, "browser", {}, new AbortController().signal), job = first.messages.at(-1);
  const rejected = assert.rejects(pending, LocalAgentUnavailable);
  t.mock.timers.tick(CLIENT_HEARTBEAT_TIMEOUT);
  assert.equal(agent.reconnecting, true);
  assert.equal(agent.pending.size, 1);
  t.mock.timers.tick(CLIENT_RECONNECT_GRACE - 1);
  assert.equal(f.hub.active(f.login.principal.user.id, details.clientId), agent);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details, resume: true });
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
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
  const agent = f.hub.active(f.login.principal.user.id, details.clientId)!, controller = new AbortController();
  const running = f.hub.request(agent, "exec", { command: "fixture", timeout: 5 }, controller.signal);
  const cancelled = assert.rejects(running, /cancelled/);
  f.sockets.close(first.id);
  const queued = f.hub.request(agent, "file", { op: "write" }, controller.signal);
  const unsent = assert.rejects(queued, /cancelled/);
  controller.abort(Error("cancelled"));
  await Promise.all([cancelled, unsent]);
  const second = f.peer(paired.deviceToken, "second");
  await f.sockets.open(second); await f.sockets.message(second.id, { type: "hello", ...details, resume: true });
  await Promise.resolve();
  assert.deepEqual(second.messages[0].pending, []);
  assert.equal(second.messages.length, 1);
  assert.equal(f.events.filter((e) => e.type === "local_agent_request").length, 0, "a disconnected native client must never fall back to website events");
});

test("revocation while reconnecting rejects work immediately and cannot be healed with a revoked grant", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const first = f.peer(paired.deviceToken);
  await f.sockets.open(first); await f.sockets.message(first.id, { type: "hello", ...details, resume: true });
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
  await f.sockets.open(socket); await f.sockets.message(socket.id, { type: "hello", ...details });
  await f.sockets.revoke("another-user", details.clientId);
  assert.equal(socket.closed.length, 0);
  await f.sockets.revoke(f.login.principal.user.id, details.clientId);
  assert.equal(socket.closed.length, 1);
  await assert.rejects(async () => await f.sockets.authorize(socket.request));
  const next = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const native = f.peer(next.deviceToken, "new");
  await f.sockets.open(native); await f.sockets.message(native.id, { type: "hello", ...details });
  await f.auth.update(f.login.principal.user.id, { password: "A newer long fixture password" });
  assert.equal(native.closed.length, 1);
  assert.equal((await f.store.objects("client-token")).length, 0);
});

test("large results arrive over HTTP from the same device and instance", async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const socket = f.peer(deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details });
  const operation = f.hub.request(f.hub.active(f.login.principal.user.id, details.clientId)!, "file", { op: "read", path: "big.bin" }, new AbortController().signal);
  const job = socket.messages.at(-1);
  const content = "x".repeat(4 << 20);
  const post = (token: string, instance = details.instance) => new Request("http://localhost/api/local-agent/result", { method: "POST", headers: { authorization: "Bearer " + token, "x-vega-instance": instance } });
  await assert.rejects(async () => await f.sockets.upload(post("A".repeat(43)), { type: "result", id: job.id, result: { content } }), "a wrong device token is refused");
  await assert.rejects(async () => await f.sockets.upload(post(deviceToken, "b".repeat(32)), { type: "result", id: job.id, result: { content } }), "another instance cannot answer");
  assert.deepEqual(await f.sockets.upload(post(deviceToken), { type: "result", id: job.id, result: { content } }), { ok: true });
  assert.equal((await operation as any).content.length, content.length);
  await f.sockets.message(socket.id, { type: "result", id: job.id, result: { content } });
  // 上行大小现在由 socket.post 的 bodyJSON(CLIENT_SOCKET_LIMIT) 拒绝（见 client-socket-websocket.test.ts）；通道本身不再按帧拆连接。
  assert.equal(socket.closed.length, 0, "an accepted HTTP result never tears down the control channel");
});

test("an upstream message must name a channel owned by the same device grant", async (t) => {
  const f = await fixture(t);
  const paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const grant = await f.sockets.authorize({ url: "http://localhost/api/local-agent/socket", headers: new Headers({ authorization: "Bearer " + paired.deviceToken }) });
  const channel = f.sockets.channels.create(grant.hash, { lanes: 1 }), socket = f.peer(paired.deviceToken, channel.id);
  await f.sockets.open(socket, grant);
  await f.sockets.messageByChannel(channel.id, grant, { type: "hello", ...details });
  assert.equal(socket.messages[0].type, "ready");
  // 另一台设备的凭据把自己的消息塞进这条通道：拒绝，且不惊动设备。
  const other = await f.sockets.pair({ ticket: f.ticket(), clientId: "e".repeat(32) });
  const foreign = await f.sockets.authorize({ url: "http://localhost/api/local-agent/socket", headers: new Headers({ authorization: "Bearer " + other.deviceToken }) });
  await assert.rejects(async () => await f.sockets.messageByChannel(channel.id, foreign, { type: "ping" }));
  assert.equal(socket.messages.length, 1, "a foreign channel message never reaches the device");
  await f.sockets.messageByChannel(channel.id, grant, { type: "ping" });
  assert.equal(socket.messages.at(-1).type, "pong");
});

test("a node minimum client version refuses older clients with a visible reason", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const owner = f.login.principal.user.id, previous = process.env.VEGA_MIN_CLIENT_VERSION;
  // 不配置也应该按发布版本拦截（MIN_CLIENT_VERSION 与 local/VERSION 同步）。
  delete process.env.VEGA_MIN_CLIENT_VERSION;
  t.after(() => { process.env.VEGA_MIN_CLIENT_VERSION = previous ?? ""; });
  for (const [id, version] of [["old", "0.3.9"], ["legacy", undefined]] as const) {
    const socket = f.peer(paired.deviceToken, id);
    await f.sockets.open(socket);
    await f.sockets.message(socket.id, { type: "hello", ...details, version });
    assert.equal(socket.messages[0]?.type, "error", "older and version-less clients are refused before any job");
    assert.equal(socket.messages[0]?.code, "client_outdated");
    assert.match(socket.messages[0]?.message, new RegExp(MIN_CLIENT_VERSION.replace(/\./g, "\\.")));
    assert.equal(f.hub.active(owner, details.clientId), undefined);
    assert.equal(socket.closed.length, 1);
  }
  const current = f.peer(paired.deviceToken, "current");
  await f.sockets.open(current);
  await f.sockets.message(current.id, { type: "hello", ...details, version: MIN_CLIENT_VERSION });
  assert.equal(current.messages[0]?.type, "ready");
  assert(f.hub.active(owner, details.clientId));
});

test("client execution preference and an explicit offline request are honoured", async (t) => {
  const f = await fixture(t), paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId });
  const owner = f.login.principal.user.id, socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details, prefer: "cloud" });
  assert.equal(f.hub.active(owner, details.clientId)?.prefer, "cloud");
  await f.sockets.message(socket.id, { type: "ping", prefer: "client" });
  assert.equal(f.hub.active(owner, details.clientId)?.prefer, "client");
  // 主动下线要很快生效，不能等心跳和重连宽限；交接是异步做的，给它一拍收尾。
  await f.sockets.message(socket.id, { type: "offline" });
  await new Promise((yes) => setTimeout(yes, 0));
  assert.equal(f.hub.active(owner, details.clientId), undefined);
  assert.equal(socket.closed.length, 1);
});

test("going offline hands over while the client is still connected, then closes", async (t) => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((yes) => (release = yes));
  const f = await fixture(t, () => false, async (userId, clientId) => {
    // 软交接要现读工作区和登录态：这一刻客户端必须还在线。
    seen.push(f.hub.active(userId, clientId) ? "online" : "gone");
    await gate;
    return { mode: "soft", tasks: 2, failed: [] };
  });
  const paired = await f.sockets.pair({ ticket: f.ticket(), clientId: details.clientId }), owner = f.login.principal.user.id;
  const socket = f.peer(paired.deviceToken);
  await f.sockets.open(socket);
  await f.sockets.message(socket.id, { type: "hello", ...details });
  await f.sockets.message(socket.id, { type: "offline" });
  assert.deepEqual(seen, ["online"]);
  assert.equal(socket.closed.length, 0, "交接结束前不能断开这条连接");
  // 交接期间心跳照常回 pong，否则客户端读超时会把连接拆掉、交接被截断。
  await f.sockets.message(socket.id, { type: "ping" });
  assert.equal(socket.messages.at(-1).type, "pong");
  release();
  await new Promise((yes) => setTimeout(yes, 0));
  assert.equal(socket.messages.at(-1).type, "offline_ready");
  assert.equal(socket.closed.length, 1);
  assert.equal(f.hub.active(owner, details.clientId), undefined);
});
