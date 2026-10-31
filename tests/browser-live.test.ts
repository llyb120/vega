import { isolatedBrowserPresence } from "../server/core/presence";
import { headlessArguments } from "../server/core/headless";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import { BrowserLive } from "../server/core/browser-live";
import type { Auth, Principal } from "../server/core/auth";
import type { Chrome } from "../server/core/chrome";
import { Mutex, sleep, type Obj } from "../server/core/util";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("live control idle and uncertain delivery release the shared gate without replay", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  f.hub.sessions.get(s.socket.id)!.lastInput = Date.now() - 30001;
  await s.wait(
    "mode",
    (m) => m.mode === "view" && String(m.reason).includes("闲置"),
  );
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(f.hub.controllers.size, 0);
  s.message({ type: "mode", mode: "control" });
  for (let i = 0; i < 100 && !f.hub.sessions.get(s.socket.id)!.locked; i++)
    await sleep(5);
  const original = f.chrome.cdp.bind(f.chrome);
  let attempts = 0;
  f.chrome.cdp = async (...args: Parameters<Chrome["cdp"]>) => {
    if (args[1] === "Input.insertText") {
      attempts++;
      throw Error("wire lost after input");
    }
    return original(...args);
  };
  const input = {
    type: "input",
    seq: 1,
    frameId: s.frame().frameId,
    action: { action: "type", text: "only once" },
  };
  s.message(input);
  const result = await s.wait("input_result");
  assert.equal(result.status, "needs_review");
  assert.match(result.reason, /wire lost/);
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(f.hub.controllers.size, 0);
  s.message(input);
  assert.equal(attempts, 1);
  assert(s.closed.length);
});
test("control of another tab runs while an agent task owns a different tab", async () => {
  const f = await fixture(),
    a = await f.open(),
    b = await f.open();
  await a.wait("frame");
  await b.wait("frame");
  const session = f.hub.sessions.get(b.socket.id)!;
  session.tabTag = "C2";
  f.state.url = "https://other.test/";
  b.message({ type: "mode", mode: "control" });
  await b.wait("mode", (m) => m.mode === "control");
  assert(f.hub.controllers.get("C2") === session);
  let released = false;
  const held = f.chrome.tabGate("C1").run(async () => {
    await sleep(60);
    released = true;
  });
  b.message({
    type: "input",
    seq: 1,
    frameId: b.frame().frameId,
    action: { action: "click_at", x: 250, y: 150 },
  });
  const result = await b.wait("input_result");
  assert.equal(result.status, "executed");
  assert(!released, "click on a different tab must not wait for the C1 gate");
  await held;
});
test("isolated browser presence is per-platform and headless arguments are consistent with Docker", () => {
  assert.equal(isolatedBrowserPresence("win32", undefined), undefined);
  assert.equal(isolatedBrowserPresence("win32", "isolated", 5000)!.source, "isolated-chromium");
  assert.equal(isolatedBrowserPresence("linux", "isolated", 5000)!.source, "isolated-chromium");
  assert.equal(isolatedBrowserPresence("darwin", "isolated", 5000)!.source, "isolated-chromium");
  const args = headlessArguments("/data/chromium", "/app/extension");
  assert(args.includes("--headless=new"));
  assert(args.includes("--user-data-dir=/data/chromium"));
  assert(args.includes("--load-extension=/app/extension"));
  assert(args.includes("--remote-debugging-port=0"));
  assert(args.includes("--password-store=basic"));
});
async function fixture() {
  const bytes = await sharp({
    create: { width: 1000, height: 600, channels: 3, background: "#c7dafa" },
  })
    .jpeg()
    .toBuffer();
  const events = new EventEmitter(),
    principal = {
      hash: "owner-hash",
      csrf: "csrf",
      expiresAt: Date.now() + 60000,
      user: { id: "admin", role: "admin" },
    } as Principal;
  let allowed = true;
  const auth = {
    events,
    resolveHash: (hash: string) =>
      allowed && hash === principal.hash ? principal : undefined,
    authenticate: (token: string) =>
      allowed && token === "cookie-token" ? principal : undefined,
  } as unknown as Auth;
  const calls: Obj[] = [],
    state = {
      stamp: "viewport",
      document: "document",
      focus: { identity: 1, editable: true },
      width: 2000,
      height: 1200,
      url: "https://example.test/",
      title: "Live fixture",
    };
  const tabGates = new Map<string, Mutex>();
  const chrome = {
    gate: new Mutex(),
    tabGates,
    tabGate(tag: string) {
      let g = tabGates.get(tag);
      if (!g) tabGates.set(tag, (g = new Mutex()));
      return g;
    },
    observations: new Map(),
    bridge: {
      status: () => ({ connected: true }),
      request: async (op: string, args: Obj) => {
        calls.push({ op, args });
        return { tabs: [{ tag: "C1", controllable: true, url: state.url }] };
      },
    },
    observe: async () => ({
      tabTag: "C1",
      frames: [{ id: "root", context: 1 }],
      pages: [{ ...state }],
      images: [],
      captured: Date.now(),
    }),
    evaluate: async (_tag: string, _frame: Obj, expression: string) =>
      structuredClone(
        expression === "__novaWebview.inputState()" ? state.focus : state,
      ),
    frameFocused: async () => true,
    cdp: async (_tag: string, method: string, params: Obj) => {
      calls.push({ method, params });
      return { data: bytes.toString("base64") };
    },
    mouse: async (_tag: string, p: Obj, button: string, count: number) => {
      calls.push({ method: "mouse", p, button, count });
    },
    key: async (_tag: string, key: string) => {
      calls.push({ method: "key", key });
    },
  } as unknown as Chrome;
  const hub = new BrowserLive(chrome, auth);
  cleanup.push(() => hub.close());
  let socketId = 0;
  async function open(autoAck = true) {
    const ticket = await hub.ticket(principal, "C1"),
      messages: Obj[] = [],
      closed: Obj[] = [];
    const request = {
      url: "http://localhost/api/chrome/live?ticket=" + ticket.ticket,
      headers: new Headers({
        origin: "http://localhost",
        cookie: "vega_session=cookie-token",
      }),
    };
    const socket = {
      id: "socket-" + ++socketId,
      request,
      send: (raw: unknown) => {
        const message = JSON.parse(String(raw));
        messages.push(message);
        if (autoAck && message.type === "frame")
          queueMicrotask(() =>
            hub.message(
              socket,
              JSON.stringify({ type: "frame_ack", frameId: message.frameId }),
            ),
          );
      },
      close: (code?: number, reason?: string) => closed.push({ code, reason }),
    };
    hub.open(socket);
    const message = (value: Obj) => hub.message(socket, JSON.stringify(value));
    const wait = async (
      type: string,
      predicate: (m: Obj) => boolean = () => true,
    ) => {
      for (let i = 0; i < 200; i++) {
        const m = messages.find((m) => m.type === type && predicate(m));
        if (m) return m;
        await sleep(5);
      }
      throw Error(
        "Missing " +
          type +
          ":" +
          JSON.stringify(
            messages.map((m) => ({
              type: m.type,
              reason: m.reason,
              status: m.status,
            })),
          ),
      );
    };
    return {
      socket,
      ticket,
      messages,
      closed,
      message,
      wait,
      frame: () => messages.filter((m) => m.type === "frame").at(-1)!,
    };
  }
  return {
    hub,
    chrome,
    auth,
    principal,
    state,
    calls,
    open,
    revoke: () => {
      allowed = false;
      events.emit("revoke", "admin");
    },
  };
}
test("live browser tickets require same-origin admin cookie, expire and are consumed once", async () => {
  const f = await fixture(),
    ticket = await f.hub.ticket(f.principal, "C1");
  const request = {
    url: "http://localhost/api/chrome/live?ticket=" + ticket.ticket,
    headers: new Headers({
      origin: "http://localhost",
      cookie: "vega_session=cookie-token",
    }),
  };
  for (const headers of [
    { origin: "https://evil.test", cookie: "vega_session=cookie-token" },
    { origin: "http://localhost" },
    { origin: "http://localhost", cookie: "vega_session=other" },
  ])
    assert.throws(() =>
      f.hub.authorize({
        ...request,
        headers: new Headers(headers as Record<string, string>),
      }),
    );
  assert.equal(f.hub.authorize(request, true).principal.hash, f.principal.hash);
  assert.throws(() => f.hub.authorize(request, true));
  const stale = await f.hub.ticket(f.principal, "C1");
  f.hub.tickets.get(stale.ticket)!.until = 0;
  assert.throws(() =>
    f.hub.authorize({
      ...request,
      url: "http://localhost/api/chrome/live?ticket=" + stale.ticket,
    }),
  );
  f.principal.user.role = "viewer";
  await assert.rejects(() => f.hub.ticket(f.principal, "C1"));
});
test("live frames use acknowledgement backpressure without SQLite snapshots; control exclusively leases the shared agent gate", async () => {
  const f = await fixture(),
    s = await f.open(false),
    first = await s.wait("frame");
  assert.equal(first.width, 1000);
  assert.equal(first.height, 600);
  assert(first.data);
  await sleep(250);
  assert.equal(
    s.messages.filter((m) => m.type === "frame").length,
    1,
    "no unacknowledged frame queue",
  );
  assert.equal(f.chrome.observations.size, 0);
  s.message({ type: "frame_ack", frameId: first.frameId });
  await s.wait("frame", (m) => m.frameId > first.frameId);
  s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  let agentRan = false;
  const agent = f.chrome.tabGate("C1").run(async () => {
    agentRan = true;
  });
  await sleep(30);
  assert.equal(agentRan, false);
  s.message({ type: "mode", mode: "view" });
  await agent;
  assert.equal(agentRan, true);
});
test("live input maps displayed pixels, streams drag phases, types once and releases a held mouse on disconnect", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  let seq = 0;
  const input = async (action: Obj) => {
    s.message({
      type: "input",
      seq: ++seq,
      frameId: s.frame().frameId,
      action,
    });
    return s.wait("input_result", (m) => m.seq === seq);
  };
  f.chrome.observations.set("agent:C1", { tabTag: "C1" } as any);
  assert.equal(
    (await input({ action: "click_at", x: 250, y: 150 })).status,
    "executed",
  );
  assert.deepEqual(f.calls.find((c) => c.method === "mouse")?.p, {
    x: 500,
    y: 300,
  });
  assert.equal(f.chrome.observations.size, 0);
  assert.equal(
    (await input({ action: "type", text: "实时输入" })).status,
    "executed",
  );
  assert.equal(
    f.calls.filter((c) => c.method === "Input.insertText").length,
    1,
  );
  for (const phase of ["down", "move", "up"])
    assert.equal(
      (await input({ action: "pointer", phase, x: 200, y: 100 })).status,
      "executed",
    );
  assert.deepEqual(
    f.calls
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params.type),
    ["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"],
  );
  await input({ action: "pointer", phase: "down", x: 100, y: 100 });
  await f.hub.sessions.get(s.socket.id)!.close();
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(
    f.calls.filter((c) => c.method === "Input.dispatchMouseEvent").at(-1)
      ?.params.type,
    "mouseReleased",
  );
  assert.equal(f.hub.controllers.size, 0);
});
test("live controls reject stale frames, changed focus, arbitrary scripts and duplicates, and auth revocation closes a live lease", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  const session = f.hub.sessions.get(s.socket.id)!;
  let seq = 0;
  for (const action of [
    { action: "click_at", x: 1000, y: 2 },
    { action: "evaluate", expression: "alert(1)" },
    { action: "press", key: "Ctrl+L" },
    { action: "goto", url: "javascript:alert(1)" },
  ]) {
    s.message({
      type: "input",
      seq: ++seq,
      frameId: s.frame().frameId,
      action,
    });
    assert.equal(
      (await s.wait("input_result", (m) => m.seq === seq)).status,
      "not_executed",
    );
  }
  f.state.focus.identity = 2;
  s.message({
    type: "input",
    seq: ++seq,
    frameId: s.frame().frameId,
    action: { action: "type", text: "wrong field" },
  });
  assert.equal(
    (await s.wait("input_result", (m) => m.seq === seq)).status,
    "not_executed",
  );
  assert(!f.calls.some((c) => c.method === "Input.insertText"));
  f.revoke();
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(s.closed.at(-1)?.code, 4401);
  assert.equal(session.active, false);
  assert.equal(f.hub.sessions.size, 0);
  const next = await fixture(),
    other = await next.open();
  await other.wait("frame");
  other.message({ type: "mode", mode: "control" });
  await other.wait("mode", (m) => m.mode === "control");
  other.message({
    type: "input",
    seq: 1,
    frameId: other.frame().frameId,
    action: { action: "press", key: "Enter" },
  });
  await other.wait("input_result");
  other.message({
    type: "input",
    seq: 1,
    frameId: other.frame().frameId,
    action: { action: "press", key: "Enter" },
  });
  assert(other.closed.length);
  assert.equal(next.calls.filter((c) => c.method === "key").length, 1);
});
