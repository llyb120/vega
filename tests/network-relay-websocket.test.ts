import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createApp, createRouter, createError, defineEventHandler, getHeader, setHeader, toNodeListener } from "h3";
import ts from "typescript";
import { NetworkRelay } from "../server/core/network-relay";
import { LocalAgents } from "../server/core/local-agent";
import { Store } from "../server/core/store";
import { encodeFrame, laneParams, openStream, SseChannels, wire, wireRequest } from "../server/core/sse";
import { bodyJSON } from "../server/core/http-auth-routes";

function read(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off("readable", poll); socket.off("close", closed); };
    const closed = () => { cleanup(); reject(Error("Proxy closed before returning data")); };
    const poll = () => { const data = socket.read(size); if (data) { cleanup(); resolve(data); } };
    const timer = setTimeout(() => { cleanup(); reject(Error("Proxy timed out")); }, 3000);
    socket.on("readable", poll).once("close", closed); poll();
  });
}

async function route(file: string, application: unknown) {
  const source = await readFile("server/routes/api/local-agent/" + file, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "h3") return { defineEventHandler, getHeader, setHeader, createError };
    if (name === "../../../core/application") return { app: () => application };
    if (name === "../../../core/sse") return { laneParams, openStream, wire, wireRequest };
    if (name === "../../../core/http-auth-routes") return { bodyJSON };
    throw Error("Unexpected route dependency: " + name);
  }, module, module.exports);
  return module.exports.default;
}

/** Reads one SSE response: every `data:` frame in arrival order, in the background. */
function stream(response: Response) {
  const frames: any[] = [];
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
          if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice("data: ".length)));
        }
      }
    } catch { /* the response is aborted when its test ends */ }
  })();
  return frames;
}

async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), hub = new LocalAgents(), relay = new NetworkRelay(store, hub);
  const grant = { userId: "alice", clientId: "c".repeat(32), hash: "device-grant" };
  const requests: string[] = [], clients: { frames: any[]; stop: boolean }[] = [];
  let opens = 0, posts = 0;
  const application = { engine: { relay }, clientSockets: { authorize: async (request: { headers: Headers }) => {
    // A remote authorization store is slower than the client's first tunnel frame.
    if (request.headers.get("content-type")) posts++; else opens++;
    await delay(40);
    assert.equal(request.headers.get("authorization"), "Bearer relay-test-credential");
    assert.equal(request.headers.get("origin"), null);
    return grant;
  }, channels: new SseChannels() } };
  const h3App = createApp();
  h3App.use(createRouter()
    .get("/api/local-agent/relay", await route("relay.get.ts", application))
    .post("/api/local-agent/relay", await route("relay.post.ts", application)));
  const server = createServer(toNodeListener(h3App));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/local-agent/relay`;
  t.after(async () => {
    for (const client of clients) client.stop = true;
    await relay.close(); hub.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });
  hub.connect("alice", { clientId: grant.clientId, instance: "a".repeat(32), cwd: "/work", platform: "linux" }, {
    close() {},
    // 一台假客户端：开下行 SSE，先用 POST 报就绪，之后每帧确认并把字节回声回去。
    send(job) {
      requests.push(job.id);
      const headers = { authorization: "Bearer relay-test-credential", "x-vega-relay": job.id };
      const state = { frames: [] as any[], stop: false };
      clients.push(state);
      const post = async (frame: Buffer) => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ data: encodeFrame(frame) }) });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
      };
      void (async () => {
        const response = await fetch(url, { headers });
        assert.equal(response.status, 200);
        state.frames = stream(response);
        await post(Buffer.from([2])); // 目标连接就绪
        let seen = 0;
        while (!state.stop) {
          await delay(5);
          for (; seen < state.frames.length; seen++) {
            const frame = state.frames[seen];
            if (frame.type !== "relay") continue;
            const data = Buffer.from(String(frame.data), "base64");
            if (data[0] !== 0) continue;
            await post(Buffer.from([1])); // 确认这一帧
            await post(data);             // 目标回声
          }
        }
      })().catch(() => {});
      return state;
    },
  });
  await relay.configure(grant, ["internal.test:443"]);
  const tunnel = async (proxy: string) => {
    const socket = connect(Number(new URL(proxy).port), "127.0.0.1");
    socket.on("error", () => {}); t.after(() => socket.destroy());
    await once(socket, "connect");
    socket.write(Buffer.from([5, 1, 0]));
    assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]));
    const host = Buffer.from("internal.test"), request = Buffer.alloc(7 + host.length);
    request.set([5, 1, 0, 3, host.length]); host.copy(request, 5); request.writeUInt16BE(443, request.length - 2);
    socket.write(request);
    assert.equal((await read(socket, 10))[1], 0, "SOCKS connection must survive an immediate ready frame");
    return socket;
  };
  const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await delay(5); assert(check()); };
  return { relay, tunnel, requests, url, until, opens: () => opens, posts: () => posts, credential: { authorization: "Bearer relay-test-credential" } };
}

test("the real relay route takes an immediate ready frame after slow authorization and returns tunnel bytes", { timeout: 15000 }, async (t) => {
  const f = await fixture(t), socket = await f.tunnel(await f.relay.proxy("alice"));
  assert.equal(f.opens(), 1, "authorization runs once for the stream and open reuses that grant");
  const payload = Buffer.from([0, 255, 13, 10, 7]);
  socket.write(payload);
  assert.deepEqual(await read(socket, payload.length), payload);
  assert(f.posts() >= 3, "就绪、确认与隧道数据都走上行 POST");
});

test("concurrent employee tunnels share one account gateway without mixing streams", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const proxies = await Promise.all(Array.from({ length: 3 }, () => f.relay.proxy("alice")));
  assert.equal(new Set(proxies).size, 1, "one gateway for the account, not one per employee");
  assert.notEqual(await f.relay.proxy("bob"), proxies[0]);
  await Promise.all(proxies.map(async (proxy, i) => {
    const socket = await f.tunnel(proxy), payload = Buffer.from(`employee-${i}`);
    socket.write(payload);
    assert.deepEqual(await read(socket, payload.length), payload);
  }));
  assert.equal(new Set(f.requests).size, 3, "independent TCP streams, shared gateway");
});

test("the relay route refuses missing credentials before a stream and closes foreign or expired tunnels", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const unauthorized = await fetch(f.url);
  assert(unauthorized.status >= 400, "unauthorized stream refused with " + unauthorized.status);
  assert(!String(unauthorized.headers.get("content-type")).includes("event-stream"));
  await unauthorized.body?.cancel();
  const posted = await fetch(f.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: encodeFrame(Buffer.from([2])) }) });
  assert.equal(posted.status, 403);
  assert.equal(f.opens(), 1, "被拒绝的 GET 只验一次凭据，也从未开过 flow");
  assert.deepEqual(f.requests, [], "no tunnel was dispatched");
  // 有凭据但 flow 不存在或不属于它：流照开，但立刻以 1008 结束，客户端不会误以为可以重连。
  const response = await fetch(f.url, { headers: { ...f.credential, "x-vega-relay": "unknown-flow" } });
  assert.equal(response.status, 200);
  const frames = stream(response);
  await f.until(() => frames.length >= 2);
  assert.equal(frames[0].type, "channel");
  assert.deepEqual(frames.at(-1), { type: "closed", code: 1008, reason: "Invalid relay connection" });
  assert(f.opens() === 2, "被拒绝的隧道只验一次凭据");
});
