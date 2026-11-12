import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createApp, createRouter, createError, defineEventHandler, getHeader, setHeader, toNodeListener } from "h3";
import ts from "typescript";
import { Auth, digest } from "../server/core/auth";
import { Store } from "../server/core/store";
import { CLIENT_SOCKET_LIMIT, ClientSockets, MIN_CLIENT_VERSION } from "../server/core/client-socket";
import { LocalAgents } from "../server/core/local-agent";
import { laneParams, openStream, wire, wireRequest } from "../server/core/sse";
import { bodyJSON } from "../server/core/http-auth-routes";

const clientId = "c".repeat(32), instance = "a".repeat(32);
const hello = { type: "hello", clientId, instance, name: "Office PC", cwd: "/work", platform: "linux", version: MIN_CLIENT_VERSION, resume: true };

/** The two real route handlers with only the application singleton injected; h3 and the SSE helpers stay real. */
async function route(file: string, application: unknown) {
  const source = await readFile("server/routes/api/local-agent/" + file, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "h3") return { defineEventHandler, getHeader, setHeader, createError };
    if (name === "../../../core/application") return { app: () => application };
    if (name === "../../../core/sse") return { laneParams, openStream, wire, wireRequest };
    if (name === "../../../core/http-auth-routes") return { bodyJSON };
    if (name === "../../../core/client-socket") return { CLIENT_SOCKET_LIMIT };
    throw Error("Unexpected route dependency: " + name);
  }, module, module.exports);
  return module.exports.default;
}

async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), auth = new Auth(store, "socket-http-test");
  const login = await auth.setup({ setupToken: "socket-http-test", username: "admin", password: "Socket HTTP fixture password" });
  const hub = new LocalAgents(), clientSockets = new ClientSockets(store, auth, hub, () => false);
  const paired = await clientSockets.pair({ ticket: hub.ticket(login.principal, instance).ticket, clientId });
  // A remote authorization store is slower than the client's first message; the channel id must absorb that.
  const authorized: string[] = [], authorize = clientSockets.authorize.bind(clientSockets);
  clientSockets.authorize = async (request) => { authorized.push(request.url); await delay(40); return authorize(request); };
  const application = { clientSockets };
  const h3App = createApp();
  h3App.use(createRouter()
    .get("/api/local-agent/socket", await route("socket.get.ts", application))
    .post("/api/local-agent/socket", await route("socket.post.ts", application)));
  const server = createServer(toNodeListener(h3App));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    clientSockets.closeAll(); hub.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/local-agent/socket`;
  const bearer = { authorization: "Bearer " + paired.deviceToken };
  const open = (headers: Record<string, string> = bearer, query = "") => fetch(url + (query ? "?" + query : ""), { headers });
  const post = (body: unknown, headers: Record<string, string> = bearer) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { store, auth, hub, clientSockets, login, clientId, instance, bearer, open, post, authorized: () => authorized, deviceToken: paired.deviceToken,
    userId: login.principal.user.id, bearerFor: (token: string) => ({ authorization: "Bearer " + token }) };
}

/** Reads one SSE response: every `data:` frame in arrival order, plus the raw blocks (keepalives included). */
function stream(response: Response) {
  const frames: any[] = [], raw: string[] = [];
  let pending = "";
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        for (let end; (end = pending.indexOf("\n\n")) >= 0;) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          raw.push(block);
          if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice("data: ".length)));
        }
      }
    } catch { /* the response is aborted when its test ends */ }
  })();
  return { frames, raw };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await delay(5);
  assert(check());
};

test("the control channel is announced before the verified grant is reused, so no message can outrun registration", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const response = await f.open();
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const channel = stream(response);
  await until(() => channel.frames.length > 0);
  assert.equal(channel.frames[0].type, "channel", "车道 0 的第一条消息是通道号");
  assert.match(channel.frames[0].channel, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(f.authorized().length, 1, "车道 0 只验一次凭据，open 复用这个 grant 而不是再验一遍");
  // 通道号公布之前，上行消息没有可投递的通道，而不是被静默排队等待注册。
  const early = await f.post({ channel: "", message: hello });
  assert.equal(early.status, 403);
  assert.deepEqual(f.hub.list(f.userId), [], "未登记的通道不会顺手把设备挂上线");
  await f.post({ channel: channel.frames[0].channel, message: hello });
  await until(() => channel.frames.some((frame) => frame.type === "ready"));
  const ready = channel.frames.find((frame) => frame.type === "ready");
  assert.deepEqual([ready.userId, ready.clientId], [f.userId, clientId]);
  assert(f.hub.active(f.userId, clientId)?.transport);
  assert.equal(f.authorized().length, 3, "开流 + 被拒的上行 + 这次 hello；open 自己没有再验一遍");
});

test("the native control route refuses missing credentials and browser origins without opening a stream", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const headers of [{}, { ...f.bearer, origin: "https://untrusted.example" }, f.bearerFor("A".repeat(43)), f.bearerFor(f.login.token)]) {
    const response = await f.open(headers);
    assert(response.status >= 400, "unauthorized stream refused with " + response.status);
    assert(!String(response.headers.get("content-type")).includes("event-stream"));
    await response.body?.cancel();
  }
  // The upstream half answers with its own status instead of joining a channel.
  const posted = await f.post({ channel: "any", message: hello }, {});
  assert.equal(posted.status, 403);
  assert.match(String((await posted.json()).statusMessage ?? ""), /credential/);
  assert.deepEqual(f.hub.list(f.userId), []);
  assert.equal(f.clientSockets.channels.size, 0, "被拒绝的请求不会留下通道");
});

test("an upstream body over CLIENT_SOCKET_LIMIT is refused before it reaches the device, without dropping the channel", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const channel = stream(await f.open());
  await until(() => channel.frames.length > 0);
  const id = channel.frames[0].channel;
  // 超大 hello：bodyJSON(CLIENT_SOCKET_LIMIT) 直接 413，设备不会因此上线。
  const huge = await f.post({ channel: id, message: { ...hello, padding: "x".repeat(CLIENT_SOCKET_LIMIT) } });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).statusCode, 413);
  assert.deepEqual(f.hub.list(f.userId), []);
  await delay(50);
  assert(!channel.frames.some((frame) => frame.type === "ready"), "413 的消息一条都没处理");
  // 正常大小照旧：通道继续可用，超大的那一帧只被拒绝，不拆连接。
  assert.equal((await f.post({ channel: id, message: hello })).status, 200);
  await until(() => channel.frames.some((frame) => frame.type === "ready"));
  const oversized = await f.post({ channel: id, message: { type: "result", id: "job", result: { content: "x".repeat(CLIENT_SOCKET_LIMIT) } } });
  assert.equal(oversized.status, 413);
  assert.equal((await f.post({ channel: id, message: { type: "ping" } })).status, 200);
  await until(() => channel.frames.at(-1)?.type === "pong");
  assert(f.hub.active(f.userId, clientId)?.transport, "超大上行不会让设备掉线");
});

test("a data lane attaches only after the server announced it, and then carries the jobs", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const control = stream(await f.open());
  await until(() => control.frames.length > 0);
  const id = control.frames[0].channel;
  await f.post({ channel: id, message: hello });
  await until(() => control.frames.some((frame) => frame.type === "ready"));
  const other = await f.clientSockets.pair({ ticket: f.hub.ticket(f.login.principal, instance).ticket, clientId: "e".repeat(32) });
  for (const [label, headers, query] of [
    ["a lane nobody asked for", f.bearer, `channel=${id}&lane=1`],
    ["a lane on an unknown channel", f.bearer, "channel=missing&lane=1"],
  ] as const) {
    const refused = await f.open(headers, query);
    assert(refused.status >= 400, label + " is refused with " + refused.status);
    await refused.body?.cancel();
  }
  assert.equal(control.frames.filter((frame) => frame.type === "lane").length, 0, "没扩容就不会有车道通告");
  // 服务端下发扩容通告（通道自己的 grow()）：客户端随后才能打开这条车道。
  const channel = f.clientSockets.channels.owned(id, digest(f.deviceToken));
  channel.grow();
  await until(() => control.frames.some((frame) => frame.type === "lane" && frame.open === 1));
  const foreign = await f.open(f.bearerFor(other.deviceToken), `channel=${id}&lane=1`);
  assert(foreign.status >= 400, "别的设备拿同一个通道号也开不了车道");
  await foreign.body?.cancel();
  // 数据车道的响应头跟着第一帧载荷一起发出，所以先等服务端 attach 再派任务。
  const pending = f.open(f.bearer, `channel=${id}&lane=1`);
  await until(() => channel.lanes.has(1));
  const operation = f.hub.request(f.hub.active(f.userId, clientId)!, "file", { op: "read", path: "note.txt" }, new AbortController().signal);
  const lane = await pending;
  assert.match(String(lane.headers.get("content-type")), /text\/event-stream/);
  const data = stream(lane);
  await until(() => data.frames.length > 0);
  assert.equal(data.frames[0].op, "file");
  assert(!control.frames.some((frame) => frame.op === "file"), "打开数据车道后，任务不再挤在控制车道上");
  await f.post({ channel: id, message: { type: "result", id: data.frames[0].id, result: { content: "ok" } } });
  assert.deepEqual(await operation, { content: "ok" });
});

test("without a data lane the dispatched job still arrives on the control channel and can be answered", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const control = stream(await f.open());
  await until(() => control.frames.length > 0);
  const id = control.frames[0].channel;
  await f.post({ channel: id, message: hello });
  await until(() => control.frames.some((frame) => frame.type === "ready"));
  const operation = f.hub.request(f.hub.active(f.userId, clientId)!, "file", { op: "read", path: "a.txt" }, new AbortController().signal);
  await until(() => control.frames.some((frame) => frame.op === "file"));
  const job = control.frames.find((frame) => frame.op === "file");
  await f.post({ channel: id, message: { type: "result", id: job.id, result: { content: "fallback" } } });
  assert.deepEqual(await operation, { content: "fallback" }, "没扩容也不会丢任务");
});
