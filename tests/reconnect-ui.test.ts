import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";

const source = readFileSync("web/src/App.vue", "utf8");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function mount() {
  const timers = new Map<number, { fn: () => void; ms: number }>(), intervals = new Map<number, () => void>();
  const sockets: any[] = [], calls: any[] = [], listeners: Record<string, () => void> = {};
  let serial = 0, now = 1000;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    onerror?: () => void;
    sent: string[] = [];
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const context: any = {
    Blob, URL, WebSocket: Socket, Date: { now: () => now }, Math,
    AbortSignal: { timeout: () => new AbortController().signal },
    navigator: { onLine: true },
    window: { location: { href: "https://vega.test/" }, addEventListener: (type: string, fn: any) => listeners[type] = fn, removeEventListener() {} },
    document: { hidden: false, addEventListener: (type: string, fn: any) => listeners[type] = fn, removeEventListener() {} },
    onMounted: (fn: any) => fn(), onBeforeUnmount() {},
    setTimeout: (fn: any, ms: number) => { timers.set(++serial, { fn, ms }); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: any) => { intervals.set(++serial, fn); return serial; },
    clearInterval: (id: number) => intervals.delete(id),
    fetch: async (url: string, init: any) => { calls.push({ url, init }); return Response.json(url.endsWith("/events") ? { ticket: "ticket" } : { ok: true }); },
    eventsSocket: null, eventsReady: false, eventsWasConnected: true, eventGeneration: 0,
    eventReconnect: undefined, eventRetryDelay: 500, eventsHeartbeat: undefined, eventQueue: Promise.resolve(),
    wsRequests: new Map(), wsRequestSerial: 0, WS_BODY_LIMIT: 240 * 1024, closed: false,
    csrfToken: ref("csrf"), authenticated: ref(true), error: ref(""), clientListReady: ref(true), onlineClients: ref([{ id: "client" }]),
    current: ref(null), view: ref("employee"), employeeSession: ref(""), employeeSessionVersion: ref(0),
    bootstrap: async () => {}, refreshCurrent: async () => {}, loadEmployee: async () => {}, handleEvent: async () => {},
  };
  context.resetLogin = () => { context.authenticated.value = false; context.closed = true; };
  const methods = vm.runInNewContext(source.slice(source.indexOf("function isChatSend("), source.indexOf("async function attempt(")) + "\n({api, httpApi, connectEvents, recoverEvents})", context);
  return { ...methods, context, calls, sockets, timers, intervals, listeners, advance: (ms: number) => { now += ms; } };
}

test("chat submissions use bounded authenticated HTTP even while realtime is disconnected; unrelated writes are not replayed", async () => {
  const s = mount();
  await s.api("/employees/one/messages", "POST", { text: "hello", clientMessageId: "stable-message-id" });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].init.headers["X-CSRF-Token"], "csrf");
  assert(s.calls[0].init.signal);
  await assert.rejects(s.api("/employees/one/cancel", "POST", {}), /不要重复提交/);
  assert.equal(s.calls.length, 1);
  s.context.fetch = async () => { throw Error("offline"); };
  await assert.rejects(s.api("/employees/one/messages", "POST", { text: "hello", clientMessageId: "stable-message-id" }), (error: any) => error.network === true);
  assert.equal(s.context.error.value, "");
});

test("realtime failures retain client state, stay silent and reconnect with bounded backoff", async () => {
  const s = mount();
  s.connectEvents(); await tick();
  const first = s.sockets[0];
  first.onerror();
  assert.equal(s.context.error.value, "");
  assert.equal(s.context.onlineClients.value.length, 1);
  assert.equal(s.context.clientListReady.value, true);
  assert.equal(s.timers.size, 1);
  const timer = [...s.timers.values()][0];
  assert(timer.ms >= 375 && timer.ms <= 625);
  timer.fn(); await tick();
  assert.equal(s.sockets.length, 2);
  s.sockets[1].readyState = 1;
  s.sockets[1].onmessage({ data: JSON.stringify({ type: "ready" }) });
  await tick();
  assert.equal(s.context.eventsReady, true);
  assert.equal(s.context.employeeSessionVersion.value, 1, "reconnect also refreshes chat history");
});

test("read requests fall back once after socket loss; mutations are never automatically resubmitted", async () => {
  const s = mount();
  s.connectEvents(); await tick();
  const socket = s.sockets[0];
  socket.readyState = 1;
  s.context.eventsReady = true;
  const read = s.api("/employees/one/chat"), write = s.api("/employees/one/cancel", "POST", {});
  const rejected = assert.rejects(write, /操作结果可能已提交/);
  socket.close();
  await read; await rejected;
  assert.equal(s.calls.filter((call: any) => call.url.endsWith("/employees/one/chat")).length, 1);
  assert.equal(s.calls.filter((call: any) => call.url.endsWith("/employees/one/cancel")).length, 0);
});

test("heartbeat timeout recovers half-open sockets and ignores callbacks from superseded connections", async () => {
  const s = mount();
  s.connectEvents(); await tick();
  const old = s.sockets[0];
  old.readyState = 1;
  old.onmessage({ data: JSON.stringify({ type: "ready" }) });
  await tick();
  s.advance(31000);
  [...s.intervals.values()][0]();
  assert.equal(s.context.eventsReady, false);
  assert.equal(s.context.error.value, "");
  s.connectEvents(); await tick();
  const timerCount = s.timers.size;
  old.onclose({ code: 1006 });
  assert.equal(s.timers.size, timerCount, "old socket cannot schedule another retry");
});

test("offline waits for network restoration; authentication failure is not hidden or retried", async () => {
  const s = mount();
  s.context.navigator.onLine = false;
  s.connectEvents(); await tick();
  assert.equal(s.calls.length, 0);
  s.context.navigator.onLine = true;
  s.listeners.online(); await tick();
  assert.equal(s.sockets.length, 1);
  s.sockets[0].close(4401);
  assert.equal(s.context.authenticated.value, false);
  assert.match(s.context.error.value, /登录/);
  assert.equal(s.timers.size, 0);
});
