import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { LocalAgentPairing, canBridgeLocal, pairingStatusText } from "../web/src/local-agent.js";

const encoder = new TextEncoder();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** The page pairs by POSTing to loopback and reading one event stream back; keep it under test control. */
function pairingStream() {
  const streams: any[] = [];
  return {
    streams,
    fetch: async (url: any, init: any = {}) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (started) => { controller = started; } });
      streams.push({ url: String(url), init, controller });
      return { ok: true, status: 200, body };
    },
  };
}
const feed = (stream: any, value: unknown) => stream.controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
function patchFetch(replacement: any) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  return () => { globalThis.fetch = original; };
}

test("desktop and mobile indicators describe all online clients rather than the current device", () => {
  const app = readFileSync("web/src/App.vue", "utf8");
  assert.match(app, /:client-status="clientStatus"/, "the sidebar indicator renders App's clientStatus for every layout");
  const source = readFileSync("web/src/AppSidebar.vue", "utf8");
  const indicators = [...source.matchAll(/<span\b([^>]*:title="([^"]*clientStatus[^"\n]*)"[^>]*)>([^<]*)<\/span>/g)];
  assert.equal(indicators.length, 1);
  for (const [, attributes, title, text] of indicators) {
    if (attributes.includes('v-if="view')) assert.match(attributes, /v-if="view !== 'employee'"/, "mobile employee chat omits the redundant connection indicator");
    else assert.doesNotMatch(attributes, /v-if=/);
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

test("execution position follows each employee's Master, so the website keeps no session-level client switcher", () => {
  const app = readFileSync("web/src/App.vue", "utf8");
  // 4497e39 起执行位置由每头牛马在客户端「连接授权」里配置的文件系统 Master 决定。
  assert.doesNotMatch(app, /executionLocal|executionClientId|executionBusy|executionUnavailable|executionHint|toggleExecution|switchingExecution|draftExecution|draftClientId|selectedClient/);
  assert.doesNotMatch(app, /\/execution/, "the page no longer posts a session execution switch");
});

test("pairing reports permission, verification and backend failures without mistaking them for online", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { streams, fetch } = pairingStream();
  t.after(patchFetch(fetch));
  const statuses: any[] = [], requests: any[] = [];
  const pairing = new LocalAgentPairing(async (_path: string, _method: string, body: any) => { requests.push(body); return { ticket: "fixture" }; }, "alice", (status: any) => statuses.push(status));
  t.after(() => pairing.close());
  const first = pairing.connect();
  await settle();
  assert.equal(streams.length, 1);
  feed(streams[0], { type: "status", code: "permission_required" });
  await first;
  assert.equal(statuses.at(-1).code, "permission_required");
  assert.match(pairingStatusText(statuses.at(-1)), /允许此站点/);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(streams.length, 2, "approval is retried with a fresh one-use ticket");
  for (const code of ["authorizing", "backend_connecting"])
    feed(streams[1], { type: "status", code });
  await settle();
  assert.equal((pairing as any).paired, undefined);
  feed(streams[1], { type: "status", code: "backend_http", httpStatus: 404, deviceToken: "must-not-be-copied", message: "private server text" });
  await settle();
  assert.match(pairingStatusText(statuses.at(-1)), /HTTP 404/);
  assert.match(pairingStatusText(statuses.at(-1)), /\/api\/local-agent\/socket/);
  assert(!JSON.stringify(statuses).includes("must-not-be-copied"));
  assert(!pairingStatusText(statuses.at(-1)).includes("private server text"));
  assert.notEqual(requests[0].instance, requests[1].instance);
});

test("pairing exposes local-network, credential-save and old-client failures and stops on terminal errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { streams, fetch } = pairingStream();
  t.after(patchFetch(fetch));
  for (const code of ["local_unavailable", "credential_save", "legacy_client"]) {
    const statuses: any[] = [];
    const pairing = new LocalAgentPairing(async () => ({ ticket: "fixture" }), "alice", (status: any) => statuses.push(status));
    const running = pairing.connect();
    await settle();
    const stream = streams.at(-1);
    if (code === "local_unavailable") stream.controller.error(Error("connection refused"));
    else if (code === "legacy_client") feed(stream, { type: "paired", instance: (pairing as any).instance, userId: "alice", clientId: "d".repeat(32) });
    else feed(stream, { type: "status", code });
    await running;
    assert.equal(statuses.at(-1).code, code);
    assert(!statuses.some((status) => status.code === "connected"));
    if (code === "credential_save") {
      const count = streams.length;
      t.mock.timers.tick(60000); await settle();
      assert.equal(streams.length, count);
      assert.match(pairingStatusText(statuses.at(-1)), /写入权限/);
    }
    pairing.close();
  }
});

test("local pairing starts independently from the website event socket and refreshes actual online clients", () => {
  const source = readFileSync("web/src/App.vue", "utf8"), statuses: any[] = [];
  let refreshes = 0, onlineWatcher: any;
  class Pairing {
    constructor(_api: any, _user: any, public status: any) { statuses.push(this); }
    connect() { this.status({ code: "detecting" }); }
    close() {}
  }
  const state: any = {
    LocalAgentPairing: Pairing, canBridgeLocal: () => true, canExecute: { value: true }, user: { value: { id: "alice" } },
    localPairing: { value: null }, localConnected: { value: false }, watch: (_source: any, cb: any) => { onlineWatcher = cb; },
    httpApi() {}, attempt: (fn: any) => fn(), bootstrap: () => { refreshes++; },
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
  state.localConnected.value = true;
  onlineWatcher(true);
  assert.equal(state.localPairing.value, null, "a client that connects on its own ends the page handshake");
  const attempts = statuses.length;
  actions.startLocalPairing();
  assert.equal(statuses.length, attempts, "an online client keeps its own connection; the page never dials 127.0.0.1");
  state.localConnected.value = false;
  assert.match(source, /canBridgeLocal\(\) && canExecute\.value && !localConnected\.value/);
  const onClose = source.slice(source.indexOf("  ws.onclose = (event) => {"), source.indexOf("async function attempt(fn)"));
  assert(!onClose.includes("localBridge?.close()"), "website event loss must not abort initial native pairing");
  assert(onClose.includes("eventsReady = false"), "a lost event stream is no longer live");
  assert.match(source, /await bootstrap\(\);\s*startLocalPairing\(\);/);
  assert(source.includes("{{ localPairingText }}") && source.includes("重新检测"));
});

test("the frontend pairs once and never relays jobs, holds device tokens or disconnects a native client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { streams, fetch } = pairingStream();
  t.after(patchFetch(fetch));
  const calls: any[] = [], statuses: any[] = [];
  const pairing = new LocalAgentPairing(async (path: any, method: any, data: any) => {
    calls.push({ path, method, data });
    return { ticket: "one-time-login-proof" };
  }, "alice", (paired) => statuses.push(paired));
  t.after(() => pairing.close());
  const running = pairing.connect();
  await settle();
  const stream = streams[0];
  assert.equal(stream.url, "http://127.0.0.1:47673/agent");
  assert.equal(stream.init.method, "POST");
  assert.equal(stream.init.headers["Content-Type"], "text/plain");
  assert.deepEqual(JSON.parse(stream.init.body), { type: "auth", ticket: "one-time-login-proof", userId: "alice" });
  const instance = (pairing as any).instance;
  feed(stream, { type: "paired", userId: "alice", instance, clientId: "d".repeat(32), connected: true });
  await running;
  assert.deepEqual(statuses.map((status) => status.code), ["detecting", "connected"]);
  t.mock.timers.tick(30000);
  await settle();
  pairing.close();
  assert.equal(streams.length, 1, "the page releases its handshake stream after pairing");
  assert.deepEqual(calls.map((item) => item.path), ["/local-agent/ticket"]);
  assert.equal(JSON.parse(stream.init.body).ticket, "one-time-login-proof", "no device token ever travels through the page");
  assert.equal((pairing as any).forward, undefined, "job forwarding is not a browser responsibility");
});
