import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { defineWebSocketHandler } from "h3";
import nodeAdapter from "crossws/adapters/node";
import WebSocket from "ws";
import ts from "typescript";
import { NetworkRelay } from "../server/core/network-relay";
import { LocalAgents } from "../server/core/local-agent";
import { Store } from "../server/core/store";

function read(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off("readable", poll); socket.off("close", closed); };
    const closed = () => { cleanup(); reject(Error("Proxy closed before returning data")); };
    const poll = () => { const data = socket.read(size); if (data) { cleanup(); resolve(data); } };
    const timer = setTimeout(() => { cleanup(); reject(Error("Proxy timed out")); }, 3000);
    socket.on("readable", poll).once("close", closed); poll();
  });
}
async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), hub = new LocalAgents(), relay = new NetworkRelay(store, hub);
  const grant = { userId: "alice", clientId: "c".repeat(32), hash: "device-grant" };
  const clients: WebSocket[] = [], requests: string[] = [];
  let authorizationCalls = 0;
  const application = { engine: { relay }, clientSockets: { authorize: async (request: { headers: Headers }) => {
    // A remote authorization store is slower than the client's first binary frame.
    authorizationCalls++;
    await delay(40);
    assert.equal(request.headers.get("authorization"), "Bearer relay-test-credential");
    assert.equal(request.headers.get("origin"), null);
    return grant;
  } } };
  // Run the actual route with only its application singleton injected; retain real H3/crossws hooks.
  const source = await readFile("server/routes/api/local-agent/relay.get.ts", "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "h3") return { defineWebSocketHandler };
    if (name === "../../../core/application") return { app: () => application };
    throw Error("Unexpected route dependency: " + name);
  }, module, module.exports);
  const adapter = nodeAdapter({ resolve: () => module.exports.default.__websocket__ });
  const server = createServer();
  server.on("upgrade", adapter.handleUpgrade);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `ws://127.0.0.1:${(server.address() as any).port}/api/local-agent/relay`;
  hub.connect("alice", { clientId: grant.clientId, instance: "a".repeat(32), cwd: "/work", platform: "linux" }, {
    close() {},
    send(job) {
      requests.push(job.id);
      const ws = new WebSocket(url, { headers: { authorization: "Bearer relay-test-credential", "x-vega-relay": job.id } });
      clients.push(ws);
      ws.on("error", () => {});
      ws.on("open", () => ws.send(Buffer.from([2])));
      ws.on("message", (raw) => {
        const data = raw as Buffer;
        if (data[0] !== 0) return;
        ws.send(Buffer.from([1]));
        ws.send(data); // Stand in for the client's TCP target; keep the real wire protocol.
      });
    },
  });
  await relay.configure(grant, ["internal.test:443"]);
  t.after(async () => {
    for (const client of clients) client.terminate();
    adapter.closeAll(1000, "Test cleanup", true);
    await relay.close(); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
  });
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
  return { relay, tunnel, requests, url, authorizationCalls: () => authorizationCalls };
}

test("real WebSocket upgrade accepts an immediate ready frame with slow authorization", { timeout: 10000 }, async (t) => {
  const f = await fixture(t), socket = await f.tunnel(await f.relay.proxy("alice"));
  const payload = Buffer.from([0, 255, 13, 10, 7]);
  socket.write(payload);
  assert.deepEqual(await read(socket, payload.length), payload);
  assert.equal(f.authorizationCalls(), 1, "authorization must finish before upgrade, not run again in open");
});

test("concurrent employee connections share one account gateway without mixing streams", { timeout: 10000 }, async (t) => {
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

test("real relay endpoint rejects missing credentials before opening a WebSocket", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(f.url);
    ws.on("open", () => { ws.terminate(); reject(Error("Unauthorized upgrade accepted")); });
    ws.on("error", reject);
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      assert.equal(response.statusCode, 401);
      resolve();
    });
  });
  assert.equal(f.authorizationCalls(), 1);
});
