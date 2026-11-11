import { isolatedBrowserPresence } from "../server/core/presence";
import { headlessArguments } from "../server/core/headless";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import { BrowserLive } from "../server/core/browser-live";
import type { Auth, Principal } from "../server/core/auth";
import type { Chrome } from "../server/core/chrome";
import { wire as streamWire, type Request as LiveRequest, type Sink } from "../server/core/sse";
import { Mutex, sleep, type Obj } from "../server/core/util";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
/** One lane of a stream response: every SSE frame written to it, plus a backlog the test controls. */
function lane(onFrame?: (value: Obj) => void) {
  const messages: Obj[] = [],
    state = { ended: 0, buffered: 0, close: undefined as (() => void) | undefined };
  const sink: Sink = {
    write(chunk) {
      for (const block of chunk.split("\n\n")) {
        if (!block.startsWith("data: ")) continue;
        const value = JSON.parse(block.slice("data: ".length));
        messages.push(value);
        if (value.type === "frame") onFrame?.(value);
      }
      return true;
    },
    end() {
      state.ended++;
    },
    buffered: () => state.buffered,
    onclose(fn) {
      state.close = fn;
    },
  };
  return { sink, messages, state };
}
test("live control idle and uncertain delivery release the shared gate without replay", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  f.hub.sessions.get(s.channel.id)!.lastInput = Date.now() - 30001;
  await s.wait(
    "mode",
    (m) => m.mode === "view" && String(m.reason).includes("闲置"),
  );
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(f.hub.controllers.size, 0);
  await s.message({ type: "mode", mode: "control" });
  for (let i = 0; i < 100 && !f.hub.sessions.get(s.channel.id)!.locked; i++)
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
  await s.message(input);
  const result = await s.wait("input_result");
  assert.equal(result.status, "needs_review");
  assert.match(result.reason, /wire lost/);
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(f.hub.controllers.size, 0);
  await s.message(input);
  assert.equal(attempts, 1);
  assert(s.closed.length);
});
for (const [stage, reason] of [
  ["state", "Cannot find context with specified id"],
  ["observe", "Execution context was destroyed."],
  ["screenshot", "Unable to capture screenshot"],
  ["after", "Inspected target navigated or closed"],
]) test(`Enter navigation recovers ${stage} reads on the same live connection without replay`, async () => {
  const f = await fixture(), s = await f.open();
  await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  const session = f.hub.sessions.get(s.channel.id)!;
  const evaluate = f.chrome.evaluate.bind(f.chrome), observe = f.chrome.observe.bind(f.chrome), cdp = f.chrome.cdp.bind(f.chrome);
  let navigating = false, afterShot = false, remaining = 3, enters = 0;
  f.chrome.key = async (_tag, key) => {
    assert.equal(key, "Enter");
    enters++;
    navigating = true;
    f.state.url = "https://example.test/submitted";
    f.state.document = "submitted document";
    f.state.stamp = "submitted viewport";
    if (stage === "observe") session.observation = undefined;
  };
  f.chrome.observe = async (...args) => {
    if (navigating && stage === "observe" && remaining > 0) {
      remaining--;
      throw Error(reason);
    }
    return observe(...args);
  };
  f.chrome.evaluate = async (...args) => {
    if (navigating && (stage === "state" || stage === "after" && afterShot) && remaining > 0) {
      remaining--;
      afterShot = false;
      throw Error(reason);
    }
    return evaluate(...args);
  };
  f.chrome.cdp = async (...args) => {
    if (navigating && args[1] === "Page.captureScreenshot") {
      if (stage === "screenshot" && remaining > 0) {
        remaining--;
        throw Error(reason);
      }
      afterShot = true;
    }
    return cdp(...args);
  };
  await s.message({ type: "input", seq: 1, frameId: s.frame().frameId, action: { action: "press", key: "Enter" } });
  assert.equal((await s.wait("input_result", m => m.seq === 1)).status, "executed");
  const frame = await s.wait("frame", m => m.url === f.state.url);
  await s.wait("frame", m => m.frameId > frame.frameId);
  assert.equal(remaining, 0);
  assert.equal(enters, 1, "only read-only observation may retry, never the submitted key");
  assert.equal(f.hub.sessions.get(s.channel.id), session);
  assert.equal(session.locked, true);
  assert.deepEqual(s.closed, []);
  assert.equal(s.messages.some(m => m.type === "error"), false);
  assert.equal(session.presented!.state.document, f.state.document);
});

test("persistent navigation read failures are bounded and real extension disconnects still close the live session", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const reason of ["Execution context was destroyed.", "浏览器扩展已断开"]) {
    const f = await fixture(), s = await f.open();
    await s.wait("frame");
    const cdp = f.chrome.cdp.bind(f.chrome);
    let failures = 0;
    f.chrome.cdp = async (...args) => {
      if (args[1] === "Page.captureScreenshot") {
        if (failures++) now += 5001;
        throw Error(reason);
      }
      return cdp(...args);
    };
    await s.wait("error", m => m.reason === reason);
    assert.equal(failures, reason.startsWith("Execution") ? 2 : 1);
    assert.equal(s.closed.at(-1)?.code, 1011);
    assert.equal(f.hub.sessions.has(s.channel.id), false);
  }
});

test("control of another tab runs while an agent task owns a different tab", async () => {
  const f = await fixture(),
    a = await f.open(),
    b = await f.open();
  await a.wait("frame");
  await b.wait("frame");
  const session = f.hub.sessions.get(b.channel.id)!;
  session.tabTag = "C2";
  f.state.url = "https://other.test/";
  await b.message({ type: "mode", mode: "control" });
  await b.wait("mode", (m) => m.mode === "control");
  assert(f.hub.controllers.get("C2") === session);
  let released = false;
  const held = f.chrome.tabGate("C1").run(async () => {
    await sleep(60);
    released = true;
  });
  await b.message({
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
  assert(args.includes("--window-size=1920,1200"), "default isolated Chrome viewport should be tall enough for denser pages");
  assert(args.includes("--silent-debugger-extension-api"), "no debugging bar resizing the viewport on attach");
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
      viewport: "[1,0,0]",
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
  /** One viewer: its ticket, its stream channel, lane 0 and the wire the route hands to the hub. */
  async function open(autoAck = true) {
    const ticket = await hub.ticket(principal, "C1"),
      request: LiveRequest = {
        url: "http://localhost/api/chrome/live?ticket=" + ticket.ticket,
        headers: new Headers({
          origin: "http://localhost",
          cookie: "vega_session=cookie-token",
        }),
      };
    // Same order as the route: verify and consume the one-use ticket, create the channel, run the session on it.
    const { principal: who, ticket: granted } = await hub.authorize(request, true);
    let id = "";
    const channel = hub.channels.create(who.hash, {
      lanes: 3,
      // Losing lane 0 ends the session: capture, control lock and the viewer all go with it.
      ongone: () => void hub.sessions.get(id)?.close(1000, "连接已关闭"),
    });
    id = channel.id;
    const control = lane((value) => {
      if (autoAck)
        queueMicrotask(async () =>
          await hub.message(channel.id, {
            type: "frame_ack",
            frameId: value.frameId,
          }),
        );
    });
    channel.attach(0, control.sink);
    const socket = streamWire(channel, request);
    // The first downstream message names the channel; upstream POSTs are routed by it.
    socket.send({ type: "channel", channel: channel.id });
    await hub.open(socket, who, granted.tabTag);
    const messages = control.messages;
    const message = async (value: Obj) => await hub.message(channel.id, value);
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
      channel,
      socket,
      control,
      ticket,
      messages,
      message,
      wait,
      /** Endings the viewer saw: the server's last frame per lane, in order. */
      get closed() {
        return messages
          .filter((m) => m.type === "closed")
          .map((m) => ({ code: m.code, reason: m.reason }));
      },
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
    await assert.rejects(async () =>
      await f.hub.authorize({
                ...request,
                headers: new Headers(headers as Record<string, string>),
              }),
    );
  assert.equal((await f.hub.authorize(request, true)).principal.hash, f.principal.hash);
  await assert.rejects(async () => await f.hub.authorize(request, true));
  const stale = await f.hub.ticket(f.principal, "C1");
  f.hub.tickets.get(stale.ticket)!.until = 0;
  await assert.rejects(async () =>
    await f.hub.authorize({
            ...request,
            url: "http://localhost/api/chrome/live?ticket=" + stale.ticket,
          }),
  );
  f.principal.user.role = "viewer";
  await assert.rejects(() => f.hub.ticket(f.principal, "C1"));
});
test("an extra lane re-uses the stream's login without a ticket and can only be taken by its owner", async () => {
  const f = await fixture(),
    laneURL = "http://localhost/api/chrome/live?channel=abc&lane=1";
  assert.equal(
    (await f.hub.identity({
      url: laneURL,
      headers: new Headers({ origin: "http://localhost", cookie: "vega_session=cookie-token" }),
    })).hash,
    f.principal.hash,
    "a lane gets its identity from the cookie, never from another one-use ticket",
  );
  await assert.rejects(
    () => f.hub.identity({ url: laneURL, headers: new Headers({ origin: "https://evil.test", cookie: "vega_session=cookie-token" }) }),
    /不允许跨站连接/,
  );
  await assert.rejects(
    () => f.hub.identity({ url: laneURL, headers: new Headers({ origin: "http://localhost" }) }),
    /重新连接/,
  );
  const channel = f.hub.channels.create(f.principal.hash, { lanes: 1 }),
    page = lane();
  channel.attach(0, page.sink);
  assert.equal(f.hub.channels.owned(channel.id, f.principal.hash), channel);
  assert.throws(() => f.hub.channels.owned(channel.id, "other-hash"), /实时连接已失效/, "another login cannot attach a lane to this channel");
  assert.throws(() => f.hub.channels.owned("forged-channel", f.principal.hash), /实时连接已失效/);
  channel.close(1000, "测试结束");
  assert.equal(page.state.ended, 1, "closing ends the response");
  assert.deepEqual(page.messages.at(-1), { type: "closed", code: 1000, reason: "测试结束" });
  assert.equal(f.hub.channels.size, 0, "a closed channel is forgotten");
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
  await s.message({ type: "frame_ack", frameId: first.frameId });
  await s.wait("frame", (m) => m.frameId > first.frameId);
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  let agentRan = false;
  const agent = f.chrome.tabGate("C1").run(async () => {
    agentRan = true;
  });
  await sleep(30);
  assert.equal(agentRan, false);
  await s.message({ type: "mode", mode: "view" });
  await agent;
  assert.equal(agentRan, true);
});
test("a picture rides a data lane while control keeps lane 0 in its own order, even when that lane is backed up", async () => {
  const f = await fixture(),
    s = await f.open(false),
    first = await s.wait("frame");
  assert.equal(first.frameId, 1);
  // The page attached the extra lane it is told to open; from then on the picture travels there.
  const data = lane();
  s.channel.requested.add(1);
  s.channel.attach(1, data.sink);
  await s.message({ type: "frame_ack", frameId: first.frameId });
  for (let i = 0; i < 200 && !data.messages.some((m) => m.type === "frame"); i++)
    await sleep(5);
  const carried = data.messages.filter((m) => m.type === "frame");
  assert(carried.length >= 1, "the picture appears on a lane");
  assert(carried[0].frameId > first.frameId);
  assert.equal(
    s.messages.filter((m) => m.type === "frame").length,
    1,
    "and no longer queues behind the control messages",
  );
  // A backed-up picture lane must still carry the next frame and must never delay control.
  data.state.buffered = 4 << 20;
  assert.equal(s.socket.buffered, 4 << 20, "the wire reports the whole backlog");
  const mark = s.messages.length,
    pictures = carried.length;
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  await s.message({ type: "frame_ack", frameId: carried.at(-1)!.frameId });
  for (let i = 0; i < 200 && data.messages.filter((m) => m.type === "frame").length === pictures; i++)
    await sleep(5);
  assert(
    data.messages.filter((m) => m.type === "frame").length > pictures,
    "a backed-up lane still delivers pictures instead of stalling them behind control",
  );
  const control = s.messages
    .slice(mark)
    .filter((m) => m.type !== "lane" && m.type !== "closed");
  assert.deepEqual(
    control.map((m) => [m.type, m.mode]),
    [["mode", "waiting"], ["mode", "control"]],
    "control keeps lane 0, in the order it was produced",
  );
});
test("upstream messages of one channel are handled one at a time, in arrival order", async () => {
  const f = await fixture(),
    s = await f.open(),
    session = f.hub.sessions.get(s.channel.id)!;
  await s.wait("frame");
  const original = session.message.bind(session);
  let running = 0,
    most = 0;
  session.message = async (value: Obj) => {
    running++;
    most = Math.max(most, running);
    await sleep(20);
    try {
      return await original(value);
    } finally {
      running--;
    }
  };
  // Both arrive before either finishes: the second must wait for the first instead of interleaving.
  await Promise.all([
    f.hub.message(s.channel.id, { type: "ping" }),
    f.hub.message(s.channel.id, { type: "ping" }),
  ]);
  assert.equal(most, 1, "the same channel's messages never run concurrently");
  assert.equal(s.messages.filter((m) => m.type === "pong").length, 2);
});
test("an upstream message only reaches the session of its own channel and login", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  const stranger = {
    ...f.principal,
    hash: "other-hash",
    user: { id: "other", role: "admin" },
  } as Principal;
  await assert.rejects(
    () => f.hub.messageByChannel(s.channel.id, stranger, { type: "ping" }),
    /实时连接已失效/,
  );
  await assert.rejects(
    () => f.hub.messageByChannel("forged-channel", f.principal, { type: "ping" }),
    /实时连接已失效/,
  );
  assert.equal(
    s.messages.some((m) => m.type === "pong"),
    false,
    "a foreign or forged channel never reaches the viewer's session",
  );
  await f.hub.messageByChannel(s.channel.id, f.principal, { type: "ping" });
  await s.wait("pong");
});
test("silence no longer closes a live session, an unacknowledged picture does", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(),
    s = await f.open(false),
    frame = await s.wait("frame");
  assert.equal(frame.frameId, 1);
  // The stream is the liveness signal: an idle viewer that acknowledges its picture stays connected.
  await s.message({ type: "frame_ack", frameId: frame.frameId });
  now += 25000;
  await sleep(150);
  assert.deepEqual(s.closed, [], "an idle viewer is not disconnected for being quiet");
  assert.equal(f.hub.sessions.has(s.channel.id), true);
  // A picture that is never acknowledged still has a bounded budget: the session ends and says why.
  const stalled = await f.open(false),
    picture = await stalled.wait("frame");
  assert.equal(picture.frameId, 1);
  now += 10001;
  const error = await stalled.wait("error");
  assert.match(String(error.reason), /画面传输超时/);
  assert.equal(stalled.closed.at(-1)?.code, 1011);
  assert.equal(stalled.control.state.ended, 1, "the response is ended, so the page sees the stream stop instead of a silent stall");
  assert.equal(f.hub.sessions.has(stalled.channel.id), false, "the stale session is gone, not silently stalled");
  // The viewer simply opens a new channel.
  const again = await f.open();
  await again.wait("frame");
});
test("live input maps displayed pixels, streams drag phases, types once and releases a held mouse on disconnect", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  let seq = 0;
  const input = async (action: Obj) => {
    await s.message({
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
  await f.hub.sessions.get(s.channel.id)!.close();
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(
    f.calls.filter((c) => c.method === "Input.dispatchMouseEvent").at(-1)
      ?.params.type,
    "mouseReleased",
  );
  assert.equal(f.hub.controllers.size, 0);
});
test("weak-network pointer samples coalesce server-side and release applies the final position before the next frame", async () => {
  const f = await fixture(), s = await f.open();
  const frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  const session = f.hub.sessions.get(s.channel.id)!;
  await s.message({ type: "input", seq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "down", x: 100, y: 100 } });
  assert.equal((await s.wait("input_result", m => m.seq === 1)).status, "executed");
  let unblock!: () => void;
  const blocked = session.io.run(() => new Promise<void>(yes => { unblock = yes; }));
  while (!unblock) await sleep(1);
  for (let seq = 2; seq <= 101; seq++)
    await s.message({ type: "pointer", seq, dragSeq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "move", x: 100 + seq, y: 100 } });
  assert.equal(session.pointerPending?.seq, 101, "keep one latest sample, not an unbounded movement queue");
  await s.message({ type: "pointer", seq: 102, dragSeq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "up", x: 250, y: 150 } });
  unblock(); await blocked;
  assert.equal((await s.wait("pointer_result", m => m.seq === 102)).status, "executed");
  assert.deepEqual(f.calls.filter(c => c.method === "Input.dispatchMouseEvent").map(c => [c.params.type, c.params.x, c.params.y]), [
    ["mousePressed", 200, 200], ["mouseMoved", 500, 300], ["mouseReleased", 500, 300],
  ]);
  assert.equal(session.mouse, undefined);
  assert.equal(session.pointerPending, undefined);
  const after = await s.wait("frame", m => m.inputSeq === 102);
  assert(after.frameId > frame.frameId);
  assert(!s.messages.some(m => m.type === "pointer_result" && m.seq < 102), "dropped samples must not be falsely reported as executed");
  f.state.stamp = "result of first drag";
  // A second gesture uses the new picture, never a frame re-labeled from the first gesture.
  const nextFrame = await s.wait("frame", m => m.inputSeq === 102 && m.frameId > after.frameId);
  await s.message({ type: "input", seq: 103, frameId: nextFrame.frameId, action: { action: "pointer", phase: "down", x: 200, y: 100 } });
  assert.equal((await s.wait("input_result", m => m.seq === 103)).status, "executed");
  await s.message({ type: "pointer", seq: 104, dragSeq: 103, frameId: nextFrame.frameId, action: { action: "pointer", phase: "up", x: 210, y: 100 } });
  assert.equal((await s.wait("pointer_result", m => m.seq === 104)).status, "executed");
});

test("a queued weak-network release fails closed on navigation and does not replay discarded moves", async () => {
  const f = await fixture(), s = await f.open(), frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  await s.message({ type: "input", seq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "down", x: 100, y: 100 } });
  await s.wait("input_result", m => m.seq === 1);
  const session = f.hub.sessions.get(s.channel.id)!;
  let unblock!: () => void;
  const blocked = session.io.run(() => new Promise<void>(yes => { unblock = yes; }));
  while (!unblock) await sleep(1);
  for (let seq = 2; seq <= 4; seq++)
    await s.message({ type: "pointer", seq, dragSeq: 1, frameId: frame.frameId, action: { action: "pointer", phase: seq === 4 ? "up" : "move", x: 150 + seq, y: 100 } });
  f.state.url = "https://other.test/";
  unblock(); await blocked;
  assert.equal((await s.wait("pointer_result", m => m.seq === 4)).status, "not_executed");
  assert.equal(session.pointerPending, undefined);
  assert.equal(session.mouse, undefined);
  assert.deepEqual(f.calls.filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type), ["mousePressed", "mouseReleased"]);
});

for (const mutation of ["wrong drag", "wrong frame", "invalid phase", "invalid coordinates", "duplicate"]) test(`pointer stream rejects ${mutation} and releases any held mouse without replay`, async () => {
  const f = await fixture(), s = await f.open();
  const frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  await s.message({ type: "input", seq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "down", x: 100, y: 100 } });
  await s.wait("input_result", m => m.seq === 1);
  const message = { type: "pointer", seq: 2, dragSeq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "move", x: 150, y: 100 } };
  if (mutation === "wrong drag") message.dragSeq = 999;
  if (mutation === "wrong frame") message.frameId = -1;
  if (mutation === "invalid phase") message.action.phase = "down";
  if (mutation === "invalid coordinates") message.action.x = -1;
  if (mutation === "duplicate") message.seq = 1;
  await s.message(message);
  await f.chrome.tabGate("C1").run(async () => {});
  assert.equal(s.closed.at(-1)?.code, 4400);
  assert.deepEqual(f.calls.filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type), ["mousePressed", "mouseReleased"]);
});

test("a held touch can start from its displayed frame after stream repaints without relaxing freshness or page checks", async () => {
  const f = await fixture(), s = await f.open();
  const frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  await sleep(650);
  await s.wait("frame", m => m.frameId >= frame.frameId + 4);
  const session = f.hub.sessions.get(s.channel.id)!;
  const starting = session.acknowledged.get(frame.frameId)!;
  assert(starting, "a long press must not lose its starting frame after only three repaints");
  let seq = 0;
  const input = async (phase: string) => {
    await s.message({ type: "input", seq: ++seq, frameId: frame.frameId, action: { action: "pointer", phase, x: 200, y: 100 } });
    return s.wait("input_result", m => m.seq === seq);
  };
  for (const phase of ["down", "move", "up"]) assert.equal((await input(phase)).status, "executed");
  const presses = f.calls.filter(c => c.params?.type === "mousePressed").length;
  f.state.stamp = "changed during hold";
  assert.equal((await input("down")).status, "not_executed");
  f.state.stamp = "viewport";
  starting.at = Date.now() - 11000;
  assert.equal((await input("down")).status, "not_executed", "the input freshness window still applies");
  assert.equal(f.calls.filter(c => c.params?.type === "mousePressed").length, presses);
  for (let i = 0; i < 40; i++) {
    session.pendingFrame = { ...starting, id: 1000 + i, at: Date.now() };
    await s.message({ type: "frame_ack", frameId: 1000 + i });
  }
  assert.equal(session.acknowledged.size, 32, "frame metadata retention stays bounded");
  assert(!session.acknowledged.has(frame.frameId));
});
test("live input still accepts an acknowledged frame within the ten-second freshness window", async () => {
  const f = await fixture(), s = await f.open();
  const frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  const session = f.hub.sessions.get(s.channel.id)!;
  const held = session.acknowledged.get(frame.frameId)!;
  held.at = Date.now() - 8000;
  await s.message({ type: "input", seq: 1, frameId: frame.frameId, action: { action: "press", key: "Enter" } });
  assert.equal((await s.wait("input_result", m => m.seq === 1)).status, "executed");
});

test("live drag retains its accepted frame across scroll, expiry and acknowledgement eviction", async () => {
  const f = await fixture(), s = await f.open();
  const frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  const session = f.hub.sessions.get(s.channel.id)!;
  let seq = 0;
  const input = async (phase: string) => {
    await s.message({ type: "input", seq: ++seq, frameId: frame.frameId, action: { action: "pointer", phase, x: 200, y: 100 } });
    return s.wait("input_result", m => m.seq === seq);
  };
  assert.equal((await input("down")).status, "executed");
  const accepted = session.acknowledged.get(frame.frameId)!;
  accepted.at = Date.now() - 11000;
  session.acknowledged.clear();
  f.state.stamp = "scrolled while dragging";
  assert.equal((await input("move")).status, "executed");
  assert.equal((await input("up")).status, "executed");
  assert.deepEqual(f.calls.filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type), ["mousePressed", "mouseMoved", "mouseReleased"]);
  assert.equal(session.mouse, undefined);
  assert.equal((await input("down")).status, "not_executed", "a new gesture still requires a fresh acknowledged frame");
  session.acknowledged.set(frame.frameId, accepted);
  assert.equal((await input("down")).status, "not_executed", "expiry still blocks a new press even if its frame remains acknowledged");
});

for (const change of ["document", "url", "width", "height", "viewport", "frameId"]) test(`live drag stops and releases the mouse when ${change} changes`, async () => {
  const f = await fixture(), s = await f.open();
  const frame = await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", m => m.mode === "control");
  const session = f.hub.sessions.get(s.channel.id)!;
  await s.message({ type: "input", seq: 1, frameId: frame.frameId, action: { action: "pointer", phase: "down", x: 100, y: 100 } });
  assert.equal((await s.wait("input_result", m => m.seq === 1)).status, "executed");
  if (change === "document") session.observation!.pages[0].document = "new document";
  else if (change === "url") f.state.url = "https://other.test/";
  else if (change === "width" || change === "height") f.state[change] += 100;
  else if (change === "viewport") f.state.viewport = "[2,0,0]";
  if (change !== "frameId") f.state.stamp = "changed " + change;
  await s.message({ type: "input", seq: 2, frameId: change === "frameId" ? -1 : frame.frameId, action: { action: "pointer", phase: "move", x: 150, y: 100 } });
  assert.equal((await s.wait("input_result", m => m.seq === 2)).status, "not_executed");
  assert.equal(session.mouse, undefined);
  assert.deepEqual(f.calls.filter(c => c.method === "Input.dispatchMouseEvent").map(c => c.params.type), ["mousePressed", "mouseReleased"]);
});

test("live controls reject stale frames, changed focus, arbitrary scripts and duplicates, and auth revocation closes a live lease", async () => {
  const f = await fixture(),
    s = await f.open();
  await s.wait("frame");
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  const session = f.hub.sessions.get(s.channel.id)!;
  let seq = 0;
  for (const action of [
    { action: "click_at", x: 1000, y: 2 },
    { action: "evaluate", expression: "alert(1)" },
    { action: "press", key: "Ctrl+L" },
    { action: "goto", url: "javascript:alert(1)" },
  ]) {
    await s.message({
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
  await s.message({
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
  await other.message({ type: "mode", mode: "control" });
  await other.wait("mode", (m) => m.mode === "control");
  await other.message({
    type: "input",
    seq: 1,
    frameId: other.frame().frameId,
    action: { action: "press", key: "Enter" },
  });
  await other.wait("input_result");
  await other.message({
    type: "input",
    seq: 1,
    frameId: other.frame().frameId,
    action: { action: "press", key: "Enter" },
  });
  assert(other.closed.length);
  assert.equal(next.calls.filter((c) => c.method === "key").length, 1);
});
test("a still page sends its picture once, then tiny same-picture frames at 2 fps; a change or a resend request sends it again", async () => {
  const f = await fixture(), s = await f.open();
  const first = await s.wait("frame");
  assert(first.data, "the first frame carries the picture");
  await s.wait("frame", (m) => m.frameId > first.frameId);
  const repeat = s.messages.filter((m) => m.type === "frame").slice(1);
  assert(repeat.length >= 1 && repeat.every((m) => m.same === true && m.data === undefined), "unchanged frames carry no image");
  assert(repeat.every((m) => m.width === first.width && m.height === first.height && m.url === first.url));
  const session = f.hub.sessions.get(s.channel.id)!;
  session.lastChange = session.lastInput = Date.now() - 5000;
  const before = s.messages.filter((m) => m.type === "frame").length;
  await sleep(1100);
  const idleFrames = s.messages.filter((m) => m.type === "frame").length - before;
  assert(idleFrames >= 1 && idleFrames <= 3, `idle page sampled ${idleFrames} times in 1.1s`);
  const bytesPerFrame = JSON.stringify(s.messages.filter((m) => m.type === "frame").at(-1)).length;
  console.log(`full frame ${JSON.stringify(first).length} B; unchanged frame ${bytesPerFrame} B`);
  const changed = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
  const cdp = f.chrome.cdp.bind(f.chrome);
  f.chrome.cdp = async (...args: Parameters<Chrome["cdp"]>) =>
    args[1] === "Page.captureScreenshot" ? { data: changed.toString("base64") } : cdp(...args);
  const mark = s.messages.length;
  const full = await s.wait("frame", (m) => s.messages.indexOf(m) >= mark && !!m.data);
  assert(full.data && !full.same, "a changed screen sends the new picture");
  const latest = () => s.messages.filter((m) => m.type === "frame").at(-1)!;
  for (let i = 0; i < 100 && !latest().same; i++) await sleep(10);
  await s.message({ type: "frame_ack", frameId: latest().frameId, resend: true });
  const mark2 = s.messages.length;
  const resent = await s.wait("frame", (m) => s.messages.indexOf(m) >= mark2 && !!m.data);
  assert(resent.data, "a viewer that lost its picture gets it again");
});
test("input brings the stream back to 10 fps immediately", async () => {
  const f = await fixture(), s = await f.open();
  await s.wait("frame");
  const session = f.hub.sessions.get(s.channel.id)!;
  session.lastChange = session.lastInput = Date.now() - 5000;
  assert.equal(session.interval(), 500);
  await s.message({ type: "mode", mode: "control" });
  await s.wait("mode", (m) => m.mode === "control");
  await s.message({ type: "input", seq: 1, frameId: s.frame().frameId, action: { action: "type", text: "x" } });
  await s.wait("input_result");
  assert.equal(session.interval(), 100);
});
