import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";

const source = readFileSync("web/src/App.vue", "utf8");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function mount() {
  const timers = new Map<number, { fn: () => void; ms: number }>(), intervals = new Map<number, () => void>();
  const sockets: any[] = [], calls: any[] = [], listeners: Record<string, () => void> = {}, handled: any[] = [];
  let serial = 0, now = 1000;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onmessage?: (event: any) => void;
    onclose?: (event: any) => void;
    onerror?: () => void;
    sent: string[] = [];
    constructor(public url: URL) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const context: any = {
    Blob, URL, WebSocket: Socket, Date: { now: () => now }, Math, JSON, Number,
    AbortController, AbortSignal: { timeout: () => new AbortController().signal },
    navigator: { onLine: true },
    window: { location: { href: "https://vega.test/" }, addEventListener: (type: string, fn: any) => listeners[type] = fn, removeEventListener() {} },
    document: { hidden: false, addEventListener: (type: string, fn: any) => listeners[type] = fn, removeEventListener() {} },
    onMounted: (fn: any) => fn(), onBeforeUnmount() {},
    computed: (fn: () => any) => ({ get value() { return fn(); } }), watch() {},
    setTimeout: (fn: any, ms: number) => { timers.set(++serial, { fn, ms }); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: any) => { intervals.set(++serial, fn); return serial; },
    clearInterval: (id: number) => intervals.delete(id),
    fetch: async (url: string, init: any) => { calls.push({ url, init }); return Response.json(url.endsWith("/events") ? { ticket: "ticket" } : { ok: true }); },
    eventsSocket: null, eventsReady: false, eventsWasConnected: true, eventGeneration: 0,
    eventReconnect: undefined, eventRetryDelay: 500, eventsWatchdog: undefined, eventCursor: "", lastEventAt: 0, EVENT_SILENCE_MS: 75000,
    eventQueue: Promise.resolve(), closed: false,
    csrfToken: ref("csrf"), authenticated: ref(true), error: ref(""), clientListReady: ref(true), onlineClients: ref([{ id: "client" }]),
    current: ref({ id: "chat-1" }), employee: ref({ chatSession: "employee-chat" }), view: ref("employee"), employeeSession: ref(""), employeeSessionVersion: ref(0),
    bootstrap: async () => {}, refreshCurrent: async () => {}, loadEmployee: async () => {}, handleEvent: async (value: any) => { handled.push(value); },
  };
  context.resetLogin = () => { context.authenticated.value = false; context.closed = true; };
  const methods = vm.runInNewContext(source.slice(source.indexOf("function isChatSend("), source.indexOf("async function attempt(")) + "\n({api, httpApi, connectEvents, recoverEvents})", context);
  const deliver = (socket: any, value: any) => socket.onmessage({ data: JSON.stringify(value) });
  const watchdog = () => [...timers.values()].find((timer) => timer.ms === 75000);
  return { ...methods, context, calls, sockets, timers, intervals, listeners, handled, deliver, watchdog, advance: (ms: number) => { now += ms; } };
}
async function connected(s: ReturnType<typeof mount>, ready: any = { type: "ready", epoch: "e1", seq: 0, replayed: false }) {
  s.connectEvents(); await tick();
  const socket = s.sockets.at(-1);
  socket.readyState = 1;
  s.deliver(socket, ready);
  await tick();
  return socket;
}

test("every API call is plain HTTP, and writes still go out while realtime is disconnected", async () => {
  const s = mount();
  await s.api("/employees/one/messages", "POST", { text: "hello", clientMessageId: "stable-message-id" });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].init.headers["X-CSRF-Token"], "csrf");
  assert(s.calls[0].init.signal);
  s.context.eventsWasConnected = true;
  await s.api("/employees/one/cancel", "POST", {});
  assert.equal(s.calls.length, 2, "a write is not blocked by a reconnecting event socket");
  const socket = await connected(s);
  await s.api("/employees/one/chat");
  assert.equal(socket.sent.length, 0, "nothing but subscriptions is ever sent over the socket");
  s.context.fetch = async () => { throw Error("offline"); };
  await assert.rejects(s.api("/employees/one/messages", "POST", { text: "hello", clientMessageId: "stable-message-id" }), (error: any) => error.network === true);
  assert.equal(s.context.error.value, "");
});

test("older mobile browsers without AbortSignal.timeout can send and obtain realtime tickets", async () => {
  const s = mount();
  s.context.AbortSignal = {};
  await s.api("/employees/one/messages", "POST", { text: "手机消息", clientMessageId: "mobile-message-id" });
  assert.equal(s.calls.length, 1, "send reaches fetch instead of throwing on unsupported API");
  assert.equal(s.timers.size, 0, "completed requests release their timeout");
  s.connectEvents(); await tick();
  assert.equal(s.sockets.length, 1);
});

test("compatible request timeout covers the response body and clears after success or failure", async () => {
  for (const phase of ["fetch", "body"]) {
    const s = mount();
    s.context.AbortSignal = {};
    let signal: AbortSignal | undefined;
    s.context.fetch = (_url: string, init: any) => {
      signal = init.signal;
      const pending = () => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
      return phase === "fetch" ? pending() : Promise.resolve({ ok: true, status: 200, json: pending });
    };
    const result = s.api("/employees/one/messages", "POST", { text: "hello", clientMessageId: "mobile-message-id" });
    const failed = assert.rejects(result, (error: any) => error.network === true);
    await tick();
    assert(signal);
    const timeout = [...s.timers.values()].find((timer) => timer.ms === 30000);
    assert(timeout, "sending cannot remain stuck on an older browser");
    timeout.fn();
    await failed;
    assert.equal(signal.aborted, true);
    assert.equal(s.timers.size, 0);
  }
});

test("a hidden tab with throttled timers is not disconnected while server heartbeats keep arriving", async () => {
  const s = mount();
  const socket = await connected(s);
  s.context.document.hidden = true;
  assert.equal(s.intervals.size, 0, "no chained client timer exists for throttling to delay");
  // Ten minutes in the background: Chrome runs chained timers once a minute, but heartbeats re-arm the watchdog.
  for (let t = 0; t < 600000; t += 20000) {
    s.advance(20000);
    s.deliver(socket, { type: "heartbeat", epoch: "e1", seq: 0 });
  }
  assert.equal(socket.readyState, 1);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.context.eventsReady, true);
  assert.equal(s.watchdog()!.ms, 75000);
  // A real outage: no frames at all for 75s closes and reconnects.
  s.advance(75000);
  s.watchdog()!.fn();
  assert.equal(socket.readyState, 3);
  assert.equal(s.context.eventsReady, false);
  assert.equal(s.context.error.value, "");
});

test("reconnect sends the event cursor and subscriptions; a replayed reconnect does not reload, a reset does", async () => {
  const s = mount();
  s.context.eventsWasConnected = false;
  const socket = await connected(s);
  assert.equal(s.context.employeeSessionVersion.value, 0, "the first connection does not reload");
  assert.equal(socket.url.searchParams.get("sessions"), "chat-1,employee-chat");
  s.deliver(socket, { type: "text_delta", session: "chat-1", data: "x", seq: 7 });
  await tick();
  assert.equal(s.handled.at(-1).seq, 7);
  socket.onerror();
  [...s.timers.values()].find((timer) => timer.ms < 1000)!.fn(); await tick();
  const back = s.sockets.at(-1);
  assert.equal(back.url.searchParams.get("since"), "e1:7");
  back.readyState = 1;
  s.deliver(back, { type: "done", session: "chat-1", seq: 8 });
  s.deliver(back, { type: "ready", epoch: "e1", seq: 8, replayed: true });
  await tick();
  assert.equal(s.context.employeeSessionVersion.value, 0, "replayed events are enough; no full reload");
  assert.equal(s.handled.at(-1).type, "done");
  back.onerror();
  [...s.timers.values()].find((timer) => timer.ms < 2000)!.fn(); await tick();
  const reset = s.sockets.at(-1);
  assert.equal(reset.url.searchParams.get("since"), "e1:8");
  reset.readyState = 1;
  s.deliver(reset, { type: "ready", epoch: "e2", seq: 3, replayed: false });
  await tick();
  assert.equal(s.context.employeeSessionVersion.value, 1, "outside the replay window the page reloads once");
});

test("superseded sockets cannot schedule retries; too many pages back off for 30s", async () => {
  const s = mount();
  const old = await connected(s);
  s.connectEvents(); await tick();
  const timerCount = s.timers.size;
  old.onclose({ code: 1006 });
  assert.equal(s.timers.size, timerCount, "old socket cannot schedule another retry");
  const current = s.sockets.at(-1);
  current.close(4429);
  const retry = [...s.timers.values()].find((timer) => timer.ms >= 22500);
  assert(retry && retry.ms <= 37500, "account connection cap waits for zombies to be reaped");
});

test("returning to a tab after a long silence reconnects at once", async () => {
  const s = mount();
  await connected(s);
  s.advance(120000);
  s.context.document.hidden = false;
  s.listeners.visibilitychange(); await tick();
  assert.equal(s.sockets.length, 2);
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
