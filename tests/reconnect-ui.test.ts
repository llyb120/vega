import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";

const source = readFileSync("web/src/App.vue", "utf8");
// The page's real transport runs inside the sandbox, so these tests cover the shipped client code.
const transport = readFileSync("web/src/sse-socket.js", "utf8").replace(/^export /gm, "");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();

/** One page: App.vue's realtime slice + the real SseSocket, with fetch, timers and the event stream under test control. */
function mount(): any {
  const timers = new Map<number, { fn: () => void; ms: number }>(), intervals = new Map<number, () => void>();
  const sockets: any[] = [], calls: any[] = [], listeners: Record<string, () => void> = {}, handled: any[] = [];
  let serial = 0, now = 1000;
  const context: any = {
    Blob, URL, Date: { now: () => now }, Math, JSON, Number,
    TextDecoder, queueMicrotask, AbortController,
    AbortSignal: { timeout: () => new AbortController().signal },
    navigator: { onLine: true },
    location: { href: "https://vega.test/" },
    window: { location: { href: "https://vega.test/" }, addEventListener: (type: string, fn: any) => listeners[type] = fn, removeEventListener() {} },
    document: { hidden: false, addEventListener: (type: string, fn: any) => listeners[type] = fn, removeEventListener() {} },
    onMounted: (fn: any) => fn(), onBeforeUnmount() {},
    computed: (fn: () => any) => ({ get value() { return fn(); } }), watch() {},
    setTimeout: (fn: any, ms: number) => { timers.set(++serial, { fn, ms }); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: any) => { intervals.set(++serial, fn); return serial; },
    clearInterval: (id: number) => intervals.delete(id),
    // A GET of /api/events is the event stream; every other request answers like a small JSON API.
    fetch: async (url: any, init: any = {}) => {
      const target = String(url), method = init.method || "GET";
      calls.push({ url: target, init });
      if (method === "GET" && target.includes("/api/events")) {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (started) => { controller = started; } });
        sockets.push({ url: new URL(target), init, controller });
        return { ok: true, status: 200, body };
      }
      return { ok: true, status: 200, json: async () => target.includes("/api/events") ? { ticket: "ticket" } : { ok: true } };
    },
    eventsSocket: null, eventsReady: false, eventsWasConnected: true, eventGeneration: 0,
    eventReconnect: undefined, eventRetryDelay: 500, eventsWatchdog: undefined, eventCursor: "", lastEventAt: 0, EVENT_SILENCE_MS: 75000,
    eventQueue: Promise.resolve(), closed: false,
    csrfToken: ref("csrf"), authenticated: ref(true), error: ref(""), clientListReady: ref(true), onlineClients: ref([{ id: "client" }]),
    current: ref({ id: "chat-1" }), employee: ref({ chatSession: "employee-chat" }), view: ref("employee"), employeeSession: ref(""), employeeSessionVersion: ref(0),
    bootstrap: async () => {}, refreshCurrent: async () => {}, loadEmployee: async () => {}, handleEvent: async (value: any) => { handled.push(value); },
  };
  context.resetLogin = () => { context.authenticated.value = false; context.closed = true; };
  context.SseSocket = vm.runInNewContext(transport + "\n({ SseSocket })", context).SseSocket;
  const methods = vm.runInNewContext(source.slice(source.indexOf("function isChatSend("), source.indexOf("async function attempt(")) + "\n({api, httpApi, connectEvents, recoverEvents})", context);
  // One SSE event on the newest stream; the reader may not be attached yet, the stream buffers it.
  const feed = (s: ReturnType<typeof mount>, value: any, stream = s.sockets.at(-1)) => stream.controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  const drop = (s: ReturnType<typeof mount>, stream = s.sockets.at(-1)) => stream.controller.error(Error("network"));
  const watchdog = () => [...timers.values()].find((timer) => timer.ms === 75000);
  return { ...methods, context, calls, sockets, timers, intervals, listeners, handled, feed, drop, watchdog, advance: (ms: number) => { now += ms; } };
}
async function connected(s: ReturnType<typeof mount>, ready: any = { type: "ready", epoch: "e1", seq: 0, replayed: false }) {
  const before = s.sockets.length;
  s.connectEvents();
  for (let i = 0; i < 20 && s.sockets.length === before; i++) await tick();
  s.feed(s, ready);
  await tick();
  return s.context.eventsSocket;
}

test("every API call is plain HTTP, and writes still go out while realtime is disconnected", async () => {
  const s = mount();
  await s.api("/employees/one/messages", "POST", { text: "hello", clientMessageId: "stable-message-id" });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].init.headers["X-CSRF-Token"], "csrf");
  assert(s.calls[0].init.signal);
  s.context.eventsWasConnected = true;
  await s.api("/employees/one/cancel", "POST", {});
  assert.equal(s.calls.length, 2, "a write is not blocked by a reconnecting event stream");
  await connected(s);
  await s.api("/employees/one/chat");
  assert.equal(s.calls.filter((call: any) => (call.init.method || "GET") === "POST" && call.url.includes("/api/events")).length, 1, "the event stream never posts an uplink; only the one-time ticket is a POST");
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
  s.connectEvents();
  for (let i = 0; i < 20 && !s.sockets.length; i++) await tick();
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
  await connected(s);
  s.context.document.hidden = true;
  assert.equal(s.intervals.size, 0, "no chained client timer exists for throttling to delay");
  // Ten minutes in the background: Chrome runs chained timers once a minute, but heartbeats re-arm the watchdog.
  for (let t = 0; t < 600000; t += 20000) {
    s.advance(20000);
    s.feed(s, { type: "heartbeat", epoch: "e1", seq: 0 });
  }
  assert.equal(s.context.eventsSocket.readyState, 1);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.context.eventsReady, true);
  assert.equal(s.watchdog()!.ms, 75000);
  // A real outage: no frames at all for 75s closes and reconnects.
  s.advance(75000);
  s.watchdog()!.fn();
  await tick();
  assert.equal(s.context.eventsSocket.readyState, 3);
  assert.equal(s.context.eventsReady, false);
  assert.equal(s.context.error.value, "");
});

test("reconnect sends the event cursor and subscriptions; a replayed reconnect does not reload, a reset does", async () => {
  const s = mount();
  s.context.eventsWasConnected = false;
  const socket = await connected(s);
  assert.equal(s.context.employeeSessionVersion.value, 0, "the first connection does not reload");
  assert.equal(socket.url.searchParams.get("sessions"), "chat-1,employee-chat");
  s.feed(s, { type: "text_delta", session: "chat-1", data: "x", seq: 7 });
  await tick();
  assert.equal(s.handled.at(-1).seq, 7);
  s.drop(s);
  await tick();
  [...s.timers.values()].find((timer) => timer.ms < 1000)!.fn(); await tick();
  const back = s.context.eventsSocket;
  assert.equal(back.url.searchParams.get("since"), "e1:7");
  s.feed(s, { type: "done", session: "chat-1", seq: 8 });
  s.feed(s, { type: "ready", epoch: "e1", seq: 8, replayed: true });
  await tick();
  assert.equal(s.context.employeeSessionVersion.value, 0, "replayed events are enough; no full reload");
  assert.equal(s.handled.at(-1).type, "done");
  s.drop(s);
  await tick();
  [...s.timers.values()].find((timer) => timer.ms < 2000)!.fn(); await tick();
  const reset = s.context.eventsSocket;
  assert.equal(reset.url.searchParams.get("since"), "e1:8");
  s.feed(s, { type: "ready", epoch: "e2", seq: 3, replayed: false });
  await tick();
  assert.equal(s.context.employeeSessionVersion.value, 1, "outside the replay window the page reloads once");
});

test("superseded streams cannot schedule retries; too many pages back off for 30s", async () => {
  const s = mount();
  const old = await connected(s);
  const lateClose = old.onclose;
  s.connectEvents(); await tick();
  const timerCount = s.timers.size;
  lateClose({ code: 1006 });
  assert.equal(s.timers.size, timerCount, "a superseded stream cannot schedule another retry");
  s.feed(s, { type: "closed", code: 4429, reason: "too many" });
  await tick();
  const retry = [...s.timers.values()].find((timer) => timer.ms >= 22500);
  assert(retry && retry.ms <= 37500, "account connection cap waits for zombies to be reaped");
});

test("a refused realtime stream says why and backs off instead of retrying silently", async () => {
  const s = mount();
  await connected(s);
  // 浏览器对同源 GET 不带 Origin 那次故障就是这个码：页面必须把服务端的话摆出来，而不是静默热重试。
  s.feed(s, { type: "closed", code: 4403, reason: "不允许跨站连接" });
  await tick();
  assert.match(String(s.context.error.value), /不允许跨站连接/);
  const retry = [...s.timers.values()].find((timer) => timer.ms >= 22500);
  assert(retry && retry.ms <= 37500, "a refusal backs off instead of hot-looping");
});

test("returning to a tab after a long silence reconnects at once", async () => {
  const s = mount();
  await connected(s);
  s.advance(120000);
  s.context.document.hidden = false;
  s.listeners.visibilitychange(); await tick(); await tick();
  assert.equal(s.sockets.length, 2);
});

test("offline waits for network restoration; authentication failure is not hidden or retried", async () => {
  const s = mount();
  s.context.navigator.onLine = false;
  s.connectEvents(); await tick();
  assert.equal(s.calls.length, 0);
  s.context.navigator.onLine = true;
  s.listeners.online();
  for (let i = 0; i < 20 && !s.sockets.length; i++) await tick();
  assert.equal(s.sockets.length, 1);
  s.feed(s, { type: "closed", code: 4401, reason: "session revoked" });
  await tick();
  assert.equal(s.context.authenticated.value, false);
  assert.match(s.context.error.value, /登录/);
  assert.equal(s.timers.size, 0);
});
