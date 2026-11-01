import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { LocalAgentPairing, canBridgeLocal, pairingStatusText } from "../web/src/local-agent.js";

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

test("pairing reports permission, verification and backend failures without mistaking them for online", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const original = globalThis.WebSocket, sockets: any[] = [], statuses: any[] = [], requests: any[] = [];
  class Socket {
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string) { sockets.push(this); }
    send() {}
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = Socket as any;
  t.after(() => { globalThis.WebSocket = original; });
  const pairing = new LocalAgentPairing(async (_path: string, _method: string, body: any) => { requests.push(body); return { ticket: "fixture" }; }, "alice", (status: any) => statuses.push(status));
  t.after(() => pairing.close());
  await pairing.connect();
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ type: "status", code: "permission_required" }) });
  assert.equal(statuses.at(-1).code, "permission_required");
  assert.match(pairingStatusText(statuses.at(-1)), /允许此站点/);
  t.mock.timers.tick(5000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(sockets.length, 2, "approval is retried with a fresh one-use ticket");
  sockets[1].onopen();
  for (const code of ["authorizing", "backend_connecting"])
    sockets[1].onmessage({ data: JSON.stringify({ type: "status", code }) });
  assert.equal((pairing as any).paired, undefined);
  sockets[1].onmessage({ data: JSON.stringify({ type: "status", code: "backend_http", httpStatus: 404, deviceToken: "must-not-be-copied", message: "private server text" }) });
  assert.match(pairingStatusText(statuses.at(-1)), /HTTP 404/);
  assert.match(pairingStatusText(statuses.at(-1)), /\/api\/local-agent\/socket/);
  assert(!JSON.stringify(statuses).includes("must-not-be-copied"));
  assert(!pairingStatusText(statuses.at(-1)).includes("private server text"));
  assert.notEqual(requests[0].instance, requests[1].instance);
});

test("pairing exposes local-network, credential-save and old-client failures and stops on terminal errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const original = globalThis.WebSocket, sockets: any[] = [];
  class Socket {
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor() { sockets.push(this); }
    send() {}
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = Socket as any;
  t.after(() => { globalThis.WebSocket = original; });
  for (const code of ["local_unavailable", "credential_save", "legacy_client"]) {
    const statuses: any[] = [];
    const pairing = new LocalAgentPairing(async () => ({ ticket: "fixture" }), "alice", (status: any) => statuses.push(status));
    await pairing.connect();
    const socket = sockets.at(-1);
    if (code === "local_unavailable") socket.onerror();
    else if (code === "legacy_client") socket.onmessage({ data: JSON.stringify({ type: "paired", instance: (pairing as any).instance, userId: "alice", clientId: "d".repeat(32) }) });
    else socket.onmessage({ data: JSON.stringify({ type: "status", code }) });
    assert.equal(statuses.at(-1).code, code);
    assert(!statuses.some((status) => status.code === "connected"));
    if (code === "credential_save") {
      const count = sockets.length;
      t.mock.timers.tick(60000); await Promise.resolve();
      assert.equal(sockets.length, count);
      assert.match(pairingStatusText(statuses.at(-1)), /写入权限/);
    }
    pairing.close();
  }
});

test("local pairing starts independently from the website event socket and refreshes actual online clients", () => {
  const source = readFileSync("web/src/App.vue", "utf8"), statuses: any[] = [];
  let refreshes = 0;
  class Pairing {
    constructor(_api: any, _user: any, public status: any) { statuses.push(this); }
    connect() { this.status({ code: "detecting" }); }
    close() {}
  }
  const state: any = {
    LocalAgentPairing: Pairing, canBridgeLocal: () => true, canExecute: { value: true }, user: { value: { id: "alice" } },
    localPairing: { value: null }, httpApi() {}, attempt: (fn: any) => fn(), bootstrap: () => { refreshes++; },
  };
  const code = source.slice(source.indexOf("let localBridge;"), source.indexOf("const mobileTitles ="));
  const actions = vm.runInNewContext(code + "\n({startLocalPairing,retryLocalPairing})", state);
  actions.startLocalPairing();
  assert.equal(state.localPairing.value.code, "detecting");
  statuses[0].status({ code: "connected" });
  assert.equal(refreshes, 1);
  actions.retryLocalPairing();
  statuses[0].status({ code: "backend_http", httpStatus: 404 });
  assert.equal(state.localPairing.value.code, "detecting", "stale bridges cannot overwrite a retry");
  const onClose = source.slice(source.indexOf("  ws.onclose = (event) => {"), source.indexOf("async function attempt(fn)"));
  assert(!onClose.includes("localBridge?.close()"), "website event loss must not abort initial native pairing");
  assert(onClose.includes("clientListReady.value = false"), "a lost event connection means unknown state, not proven offline");
  assert.match(source, /await bootstrap\(\);\s*startLocalPairing\(\);/);
  assert(source.includes("{{ localPairingText }}") && source.includes("重新检测"));
});

test("the frontend pairs once and never relays jobs, holds device tokens or disconnects a native client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const original = globalThis.WebSocket;
  const sent: any[] = [], calls: any[] = [], sockets: any[] = [], statuses: any[] = [];
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
  socket.onmessage({ data: JSON.stringify({ type: "paired", userId: "alice", instance, clientId: "d".repeat(32), connected: true }) });
  assert.deepEqual(statuses.map((status) => status.code), ["detecting", "connected"]);
  socket.onclose();
  t.mock.timers.tick(30000);
  await Promise.resolve(); await Promise.resolve();
  pairing.close();
  assert.equal(sockets.length, 1, "the page releases its handshake socket after pairing");
  assert.deepEqual(calls.map((item) => item.path), ["/local-agent/ticket"]);
  assert.equal(sent.length, 1);
  assert.equal((pairing as any).forward, undefined, "job forwarding is not a browser responsibility");
});
