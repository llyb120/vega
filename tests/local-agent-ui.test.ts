import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalAgentBridge } from "../web/src/local-agent.js";

test("frontend connects outward using the current login ticket and never replays jobs after disconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const original = globalThis.WebSocket;
  const sent: any[] = [], calls: any[] = [], sockets: any[] = [];
  class Socket {
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string) { sockets.push(this); }
    send(value: string) { sent.push(JSON.parse(value)); }
    close() {}
  }
  globalThis.WebSocket = Socket as any;
  t.after(() => { globalThis.WebSocket = original; });
  const bridge = new LocalAgentBridge(async (path: any, method: any, data: any) => {
    calls.push({ path, method, data });
    return path.endsWith("ticket") ? { ticket: "one-time-login-proof" } : { ok: true };
  }, "alice");
  t.after(() => bridge.close());
  await bridge.connect();
  const socket = sockets[0];
  assert.equal(socket.url, "ws://127.0.0.1:47673/agent");
  socket.onopen();
  assert.deepEqual(sent[0], { type: "auth", ticket: "one-time-login-proof" });
  const instance = (bridge as any).instance;
  await socket.onmessage({ data: JSON.stringify({ type: "ready", userId: "alice", instance, cwd: "C:\\work", platform: "windows" }) });
  bridge.forward({ instance: "other", id: "not-ours", op: "exec" });
  bridge.forward({ instance, id: "once", op: "exec", args: { command: "fixture" } });
  bridge.forward({ instance, id: "once", op: "exec", args: { command: "fixture" } });
  assert.equal(sent.filter((item) => item.id === "once").length, 1);
  await socket.onmessage({ data: JSON.stringify({ id: "once", result: { exitCode: 0 } }) });
  assert.equal(calls.filter((item) => item.path.endsWith("result")).length, 1);
  bridge.forward({ instance, id: "uncertain", op: "exec", args: {} });
  socket.onclose();
  assert.equal(calls.filter((item) => item.path.endsWith("disconnect")).length, 1);
  t.mock.timers.tick(5000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(sent.filter((item) => item.id === "uncertain").length, 1);
  bridge.forward({ instance, id: "uncertain", op: "exec" });
  assert.equal(sent.filter((item) => item.id === "uncertain").length, 1);
});
