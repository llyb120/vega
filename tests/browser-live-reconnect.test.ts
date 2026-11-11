import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref, computed } from "vue";
import { SseSocket } from "../web/src/sse-socket.js";

const sfc = readFileSync("web/src/BrowserView.vue", "utf8");
const script = sfc.slice(sfc.indexOf("<script setup vapor>") + "<script setup vapor>".length, sfc.indexOf("</script>"))
  .replace(/^import .*$/gm, "")
  .replace(/^const props = defineProps.*;$/m, "");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

/** One downstream SSE response: the test writes the events the server would write, and can cut the stream. */
class Stream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  response: Response;
  constructor(public url: string) {
    this.response = new Response(
      new ReadableStream({ start: (controller) => { this.controller = controller; } }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }
  send(value: unknown) {
    this.controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(value) + "\n\n"));
  }
  /** The response ends without a `closed` frame: the viewer sees 1006 and decides whether to reconnect. */
  drop() {
    this.controller.close();
  }
}

/**
 * Mounts the real component against the real SseSocket, with only `fetch` replaced: lane 0 opens a
 * stream the test drives, upstream POSTs are recorded. No WebSocket is involved anywhere.
 */
function mount(t: TestContext) {
  const opened: Stream[] = [], posts: { url: string; body: any }[] = [], timers = new Map<number, { fn: () => void; ms: number }>(), listeners: Record<string, () => void> = {};
  let serial = 0, tickets = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const target = String(url);
    if (init.method === "POST") {
      posts.push({ url: target, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const stream = new Stream(target);
    opened.push(stream);
    return stream.response;
  }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const tab = { tag: "T1", title: "page", url: "https://example.test/", controllable: true };
  const document = { hidden: false, addEventListener: (type: string, fn: any) => { listeners[type] = fn; }, removeEventListener() {} };
  const context: any = {
    ref, computed, onMounted: (fn: any) => fn(), onBeforeUnmount() {}, console, JSON, Math, Date, Number, String, Array, Object, Promise, Error,
    SseSocket,
    props: { api: async (path: string) => path === "/chrome/live" ? { ticket: "t" + ++tickets } : { tabs: [tab], status: { connected: true } }, csrf: "csrf" },
    URL, document, window: { location: { href: "https://vega.test/" }, addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn: any, ms: number) => { timers.set(++serial, { fn, ms }); return serial; },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn: any) => setImmediate(fn), cancelAnimationFrame() {}, navigator: {},
  };
  const api = vm.runInNewContext(script + "\n({capture, hidden, error, info, liveState, tabs, busy, screenshot})", context);
  const fire = (ms: number) => { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
  return { ...api, opened, posts, timers, fire, document, tab, listeners };
}

test("a dropped live connection reconnects by itself with backoff, keeping the last picture", async (t) => {
  const s = mount(t);
  await s.capture(s.tab); await settle();
  assert.equal(s.opened.length, 1, "one SSE request for the stream");
  s.opened[0].send({ type: "channel", channel: "c1" });
  s.opened[0].send({ type: "ready", tabTag: "T1", mode: "view" });
  await settle();
  assert.equal(s.liveState.value, "view");
  s.opened[0].drop();
  await settle();
  assert.equal(s.error.value, "", "no error is shown for a transient drop");
  assert.match(s.info.value, /自动重连/);
  assert.equal(s.opened.length, 1);
  s.fire(1000); await settle();
  assert.equal(s.opened.length, 2, "reconnected after 1s");
  s.opened[1].drop();
  await settle();
  s.fire(2000); await settle();
  assert.equal(s.opened.length, 3, "then after 2s");
  s.opened[2].drop();
  await settle();
  s.fire(4000); await settle();
  assert.equal(s.opened.length, 4);
  s.opened[3].drop();
  await settle();
  assert.match(s.error.value, /已断开/, "after three failed attempts the user is asked");
});

test("a revoked login or server-reported error does not auto-reconnect", async (t) => {
  const s = mount(t);
  await s.capture(s.tab); await settle();
  s.opened[0].send({ type: "channel", channel: "c1" });
  s.opened[0].send({ type: "ready", tabTag: "T1", mode: "view" });
  await settle();
  // The server ends the stream itself: the viewer reads the close code instead of guessing 1006.
  s.opened[0].send({ type: "closed", code: 4401, reason: "登录已失效" });
  s.opened[0].drop();
  await settle();
  assert.equal(s.opened.length, 1);
  assert.equal([...s.timers.values()].some((timer) => timer.ms === 1000), false);
  await s.capture(s.tab); await settle();
  s.opened[1].send({ type: "channel", channel: "c2" });
  s.opened[1].send({ type: "ready", tabTag: "T1", mode: "view" });
  s.opened[1].send({ type: "error", reason: "此页面不能远程控制" });
  s.opened[1].send({ type: "closed", code: 1011, reason: "实时浏览器连接已停止" });
  s.opened[1].drop();
  await settle();
  assert.equal(s.error.value, "此页面不能远程控制");
});

test("hiding the page releases the live view and showing it again reconnects", async (t) => {
  const s = mount(t);
  await s.capture(s.tab); await settle();
  s.opened[0].send({ type: "channel", channel: "c1" });
  s.opened[0].send({ type: "ready", tabTag: "T1", mode: "view" });
  await settle();
  s.document.hidden = true;
  s.hidden();
  await settle();
  assert.equal(s.liveState.value, "offline");
  s.document.hidden = false;
  s.hidden(); await settle();
  assert.equal(s.opened.length, 2, "visible again: a new live connection to the same tab");
  assert.equal(new URL(s.opened[1].url).searchParams.get("ticket"), "t2");
  assert.notEqual(new URL(s.opened[1].url).searchParams.get("ticket"), new URL(s.opened[0].url).searchParams.get("ticket"), "a fresh one-use ticket per connection");
});
