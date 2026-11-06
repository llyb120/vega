import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createApp, createRouter, defineWebSocketHandler } from "h3";
import nodeAdapter from "crossws/adapters/node";
import WebSocket from "ws";
import ts from "typescript";
import { Auth } from "../server/core/auth";
import { Store } from "../server/core/store";
import { ClientSockets } from "../server/core/client-socket";
import { LocalAgents } from "../server/core/local-agent";

async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), auth = new Auth(store, "socket-upgrade-test");
  const login = await auth.setup({ setupToken: "socket-upgrade-test", username: "admin", password: "Socket upgrade fixture password" });
  const hub = new LocalAgents(), clientSockets = new ClientSockets(store, auth, hub, () => false);
  const clientId = "c".repeat(32), instance = "a".repeat(32);
  const paired = await clientSockets.pair({ ticket: hub.ticket(login.principal, instance).ticket, clientId });
  const authorize = clientSockets.authorize.bind(clientSockets);
  let authorizationCalls = 0;
  clientSockets.authorize = async (request) => {
    authorizationCalls++;
    await delay(40);
    return authorize(request);
  };
  const source = await readFile("server/routes/api/local-agent/socket.get.ts", "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name === "h3") return { defineWebSocketHandler };
    if (name === "../../../core/application") return { app: () => ({ clientSockets }) };
    throw Error("Unexpected route dependency: " + name);
  }, module, module.exports);
  const h3App = createApp();
  h3App.use(createRouter().get("/api/local-agent/socket", module.exports.default));
  const adapter = nodeAdapter(h3App.websocket), server = createServer(), clients: WebSocket[] = [];
  server.on("upgrade", adapter.handleUpgrade);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    for (const client of clients) client.terminate();
    clientSockets.closeAll(); hub.close(); adapter.closeAll(1000, "Test cleanup", true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
  });
  const connect = (headers: Record<string, string>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/api/local-agent/socket`, { headers });
    clients.push(ws);
    ws.on("error", () => {});
    return ws;
  };
  return { connect, hub, userId: login.principal.user.id, clientId, instance,
    headers: { authorization: "Bearer " + paired.deviceToken }, authorizationCalls: () => authorizationCalls };
}

test("native control route registers before an immediate hello despite slow authorization", { timeout: 10000 }, async (t) => {
  const f = await fixture(t), ws = f.connect(f.headers);
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: f.clientId, instance: f.instance, cwd: "/work", platform: "linux", resume: true })));
  const [raw] = await once(ws, "message", { signal: AbortSignal.timeout(2000) });
  const ready = JSON.parse(raw.toString());
  assert.equal(ready.type, "ready");
  assert.equal(ready.userId, f.userId);
  assert.equal(ready.clientId, f.clientId);
  assert(f.hub.active(f.userId, f.clientId)?.transport);
  assert.equal(f.authorizationCalls(), 1, "open must reuse the verified upgrade grant instead of racing hello");
});

test("native control route still rejects missing credentials and browser origins before upgrade", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const headers of [{}, { ...f.headers, origin: "https://untrusted.example" }]) {
    await new Promise<void>((resolve, reject) => {
      const ws = f.connect(headers);
      ws.on("open", () => reject(Error("Unauthorized connection upgraded")));
      ws.on("error", reject);
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        assert.equal(response.statusCode, 403);
        resolve();
      });
    });
  }
  assert.equal(f.hub.list(f.userId).length, 0);
});
