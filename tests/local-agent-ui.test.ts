import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { LocalAgentPairing, canBridgeLocal } from "../web/src/local-agent.js";

test("desktop and mobile indicators describe all online clients rather than the current device", () => {
  const source = readFileSync("web/src/App.vue", "utf8");
  const indicators = [...source.matchAll(/<span\b([^>]*:title="([^"]*clientStatus[^"\n]*)"[^>]*)>([^<]*)<\/span>/g)];
  assert.equal(indicators.length, 2);
  for (const [, attributes, title, text] of indicators) {
    assert.doesNotMatch(attributes, /v-if=/);
    assert.match(attributes, /role="status"/);
    const expression = text.match(/\{\{([\s\S]*?)\}\}/)![1];
    for (const clientStatus of ["无在线客户端", "客户端在线 · 2 台"]) {
      assert.equal(vm.runInNewContext(expression, { clientStatus }), clientStatus);
      assert(vm.runInNewContext(title, { clientStatus }).includes(clientStatus));
    }
  }
});

test("phones and tablets do not bridge loopback clients but desktops can", () => {
  for (const userAgent of ["Mozilla iPhone Mobile", "Mozilla Android", "Mozilla iPad"])
    assert.equal(canBridgeLocal({ userAgent } as any), false);
  assert.equal(canBridgeLocal({ userAgent: "Mac Safari", platform: "MacIntel", maxTouchPoints: 5 } as any), false);
  assert.equal(canBridgeLocal({ userAgent: "Linux Chrome", userAgentData: { mobile: true } } as any), false);
  assert.equal(canBridgeLocal({ userAgent: "Windows Chrome", platform: "Win32", maxTouchPoints: 0 } as any), true);
  assert.match(readFileSync("web/src/App.vue", "utf8"), /!localBridge && canBridgeLocal\(\)/);
});

test("composer defaults follow connectivity only before creation and preserve explicit choices", () => {
  const source = readFileSync("web/src/App.vue", "utf8");
  const code = source.slice(source.indexOf("const executionLocal = computed("), source.indexOf("const executionBusy = computed("));
  const state = { current: { value: null as any }, localConnected: { value: false }, draftExecution: { value: null as boolean | null }, draftClientId: { value: "" }, onlineClients: { value: [] as any[] }, computed: (fn: any) => ({ get value() { return fn(); } }) };
  const { mode, client, unavailable } = vm.runInNewContext(code + "\n({mode:executionLocal,client:executionClientId,unavailable:executionUnavailable})", state);
  assert.equal(mode.value, false);
  state.localConnected.value = true;
  state.onlineClients.value = [{ id: "office", name: "Office PC" }, { id: "home", name: "Home PC" }];
  assert.equal(mode.value, true);
  assert.equal(client.value, "office");
  state.draftExecution.value = false;
  assert.equal(mode.value, false);
  state.current.value = { id: "server", localAgent: false };
  assert.equal(mode.value, false);
  state.current.value = { id: "client", localAgent: true, clientId: "home" };
  assert.equal(client.value, "home");
  state.onlineClients.value = [{ id: "office" }];
  assert.equal(unavailable.value, true, "another online computer must not replace the selected offline one");
  state.localConnected.value = false;
  assert.equal(mode.value, true, "disconnect must never silently migrate a client session");
  assert.match(source, /role="switch"[\s\S]*?:aria-checked="executionLocal"/);
  assert.match(source, /:disabled="executionBusy \|\| \(!executionLocal && !localConnected\)"/);
});

test("a manual switch updates the selected session only after success and keeps the draft on failure", async () => {
  const source = readFileSync("web/src/App.vue", "utf8");
  const code = source.slice(source.indexOf("async function toggleExecution()"), source.indexOf("async function removeSession(s)"));
  const original = { id: "server", cwd: "/server", localAgent: false };
  let fail = true, calls = 0;
  const state: any = {
    current: { value: original }, canWriteCurrent: { value: true }, executionBusy: { value: false }, executionLocal: { value: false }, localConnected: { value: true },
    draftExecution: { value: null }, draftClientId: { value: "" }, executionClientId: { value: "d".repeat(32) }, selectedClient: { value: { id: "d".repeat(32) } }, onlineClients: { value: [{ id: "d".repeat(32) }] }, error: { value: "" }, notice: { value: "" }, sessions: { value: [original] }, switchingExecution: { value: false }, sessionRequest: 0,
    draft: { value: "unsent message" },
    api: async (path: string, method: string, body: any) => { calls++; assert.equal(path, "/sessions/server/execution"); assert.equal(method, "POST"); assert.equal(body.localAgent, true); assert.equal(body.clientId, "d".repeat(32)); if (fail) throw Error("Client offline"); return { ...original, localAgent: true, cwd: "C:\\client" }; },
  };
  state.attempt = async (fn: any) => { try { await fn(); } catch (e: any) { state.error.value = e.message; } };
  const toggle = vm.runInNewContext(code + "\ntoggleExecution", state);
  await toggle();
  assert.equal(state.current.value, original);
  assert.equal(state.switchingExecution.value, false);
  assert.equal(state.draft.value, "unsent message");
  fail = false;
  await toggle();
  assert.equal(state.current.value.localAgent, true);
  assert.equal(state.current.value.cwd, "C:\\client");
  assert.match(state.notice.value, /不会自动同步/);
  state.executionBusy.value = true;
  await toggle();
  assert.equal(calls, 2, "running work must not be moved across machines");
});

test("the frontend pairs once and never relays jobs, holds device tokens or disconnects a native client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const original = globalThis.WebSocket;
  const sent: any[] = [], calls: any[] = [], sockets: any[] = [], statuses: boolean[] = [];
  class Socket {
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string) { sockets.push(this); }
    send(value: string) { sent.push(JSON.parse(value)); }
    close() {}
  }
  globalThis.WebSocket = Socket as any;
  t.after(() => { globalThis.WebSocket = original; });
  const pairing = new LocalAgentPairing(async (path: any, method: any, data: any) => {
    calls.push({ path, method, data });
    return { ticket: "one-time-login-proof" };
  }, "alice", (paired) => statuses.push(paired));
  t.after(() => pairing.close());
  await pairing.connect();
  const socket = sockets[0];
  assert.equal(socket.url, "ws://127.0.0.1:47673/agent");
  socket.onopen();
  assert.deepEqual(sent[0], { type: "auth", ticket: "one-time-login-proof", userId: "alice" });
  const instance = (pairing as any).instance;
  socket.onmessage({ data: JSON.stringify({ type: "paired", userId: "alice", instance, clientId: "d".repeat(32) }) });
  assert.deepEqual(statuses, [true]);
  socket.onclose();
  t.mock.timers.tick(30000);
  await Promise.resolve(); await Promise.resolve();
  pairing.close();
  assert.equal(sockets.length, 1, "the page releases its handshake socket after pairing");
  assert.deepEqual(calls.map((item) => item.path), ["/local-agent/ticket"]);
  assert.equal(sent.length, 1);
  assert.equal((pairing as any).forward, undefined, "job forwarding is not a browser responsibility");
});
