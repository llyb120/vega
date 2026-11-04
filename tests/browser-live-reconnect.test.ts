import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref, computed } from "vue";

const sfc = readFileSync("web/src/BrowserView.vue", "utf8");
const script = sfc.slice(sfc.indexOf("<script setup vapor>") + "<script setup vapor>".length, sfc.indexOf("</script>"))
  .replace(/^import .*$/gm, "")
  .replace("const props = defineProps({ api: Function, employeeId: String });", "");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function mount() {
  const sockets: any[] = [], timers = new Map<number, { fn: () => void; ms: number }>(), listeners: Record<string, () => void> = {};
  let serial = 0, tickets = 0;
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    readyState = 0; sent: string[] = [];
    onopen?: () => void; onmessage?: (e: any) => void; onclose?: (e: any) => void; onerror?: () => void;
    constructor(public url: URL) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: "ready" }) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const tab = { tag: "T1", title: "page", url: "https://example.test/", controllable: true };
  const document = { hidden: false, addEventListener: (type: string, fn: any) => { listeners[type] = fn; }, removeEventListener() {} };
  const context: any = {
    ref, computed, onMounted: (fn: any) => fn(), onBeforeUnmount() {}, console, JSON, Math, Date, Number, String, Array, Object, Promise, Error,
    props: { api: async (path: string) => path === "/chrome/live" ? { ticket: "t" + ++tickets } : { tabs: [tab], status: { connected: true } } },
    WebSocket: Socket, URL, document, window: { location: { href: "https://vega.test/" }, addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn: any, ms: number) => { timers.set(++serial, { fn, ms }); return serial; },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn: any) => setImmediate(fn), cancelAnimationFrame() {}, navigator: {},
  };
  const api = vm.runInNewContext(script + "\n({capture, hidden, error, info, liveState, tabs, busy, screenshot})", context);
  const fire = (ms: number) => { for (const [id, t] of timers) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  return { ...api, sockets, timers, fire, document, tab, listeners };
}

test("a dropped live connection reconnects by itself with backoff, keeping the last picture", async () => {
  const s = mount();
  await s.capture(s.tab); await tick();
  s.sockets[0].open();
  assert.equal(s.liveState.value, "view");
  s.sockets[0].drop();
  assert.equal(s.error.value, "", "no error is shown for a transient drop");
  assert.match(s.info.value, /自动重连/);
  assert.equal(s.sockets.length, 1);
  s.fire(1000); await tick(); await tick();
  assert.equal(s.sockets.length, 2, "reconnected after 1s");
  s.sockets[1].drop();
  s.fire(2000); await tick(); await tick();
  assert.equal(s.sockets.length, 3, "then after 2s");
  s.sockets[2].drop();
  s.fire(4000); await tick(); await tick();
  s.sockets[3].drop();
  assert.match(s.error.value, /已断开/, "after three failed attempts the user is asked");
});

test("a revoked login or server-reported error does not auto-reconnect", async () => {
  const s = mount();
  await s.capture(s.tab); await tick();
  s.sockets[0].open();
  s.sockets[0].drop(4401);
  assert.equal(s.sockets.length, 1);
  assert.equal([...s.timers.values()].some((t) => t.ms === 1000), false);
  await s.capture(s.tab); await tick();
  s.sockets[1].open();
  s.sockets[1].onmessage({ data: JSON.stringify({ type: "error", reason: "此页面不能远程控制" }) });
  s.sockets[1].drop(1011);
  assert.equal(s.error.value, "此页面不能远程控制");
});

test("hiding the page releases the live view and showing it again reconnects", async () => {
  const s = mount();
  await s.capture(s.tab); await tick();
  s.sockets[0].open();
  s.document.hidden = true;
  s.hidden();
  assert.equal(s.liveState.value, "offline");
  s.document.hidden = false;
  s.hidden(); await tick(); await tick();
  assert.equal(s.sockets.length, 2, "visible again: a new live connection to the same tab");
  assert.equal(s.sockets[1].url.searchParams.get("ticket"), "t2");
});
