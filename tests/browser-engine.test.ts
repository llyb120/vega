import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import { WebSocket } from "ws";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Store } from "../server/core/store";
import { processScreenshot, ShotMapping, visionScale } from "../server/core/browser-annotate";
import type { Obj } from "../server/core/util";

test("visionScale, ShotMapping and processScreenshot fast-path + SoM badge rendering", async () => {
  assert(visionScale(800, 600) >= 1);
  const s = visionScale(2560, 1440);
  const nw = Math.round(2560 * s), nh = Math.round(1440 * s);
  assert(nw <= 1568 && nh <= 1568 && nw * nh <= 1_200_000);

  const map = new ShotMapping(1000, 500, 100, 50, 500, 250);
  assert.deepEqual(map.imageToCss(500, 250), [350, 175]);
  assert.deepEqual(map.cssToImage(350, 175), [500, 250]);
  assert.throws(() => map.imageToCss(-1, 10), /超出/);
  assert.throws(() => map.imageToCss(1001, 10), /超出/);

  // Fast path: JPEG within cap, no crop, no SoM -> zero re-encode.
  const smallJpeg = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 245, g: 245, b: 245 } },
  }).jpeg({ quality: 82 }).toBuffer();
  const fast = await processScreenshot({
    jpegBase64: smallJpeg.toString("base64"),
    cssViewport: [320, 200],
    boxes: [],
    drawSom: false,
  });
  assert.equal(fast.mime, "image/jpeg");
  assert(fast.buffer.equals(smallJpeg), "fast path returns original JPEG bytes untouched");

  // Annotated + cropped path: draws crisp SoM badges on buffer & keeps cleanBuffer clean.
  const annotated = await processScreenshot({
    jpegBase64: smallJpeg.toString("base64"),
    cssViewport: [320, 200],
    cropCss: [20, 20, 200, 140],
    boxes: [
      { id: 1, rect: [40, 50, 80, 30] },
      { id: 2, rect: [42, 52, 80, 30] },
    ],
    drawSom: true,
  });
  assert.equal(annotated.mime, "image/jpeg");
  assert.equal(annotated.mapping.cssX, 20);
  assert.equal(annotated.mapping.cssWidth, 200);
  const { data: rawPixels, info } = await sharp(annotated.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 200);
  assert.equal(info.height, 140);
  // Dark slate badge pill pixels should alter the uniformly light background on buffer, NOT cleanBuffer.
  let darkPixels = 0;
  for (let i = 0; i < rawPixels.length; i += info.channels) {
    if (rawPixels[i] < 100 && rawPixels[i + 1] < 100) darkPixels++;
  }
  assert(darkPixels > 40, `expected dark slate SoM pills, found ${darkPixels} dark pixels`);
  const { data: cleanPixels, info: cleanInfo } = await sharp(annotated.cleanBuffer).raw().toBuffer({ resolveWithObject: true });
  let cleanDark = 0;
  for (let i = 0; i < cleanPixels.length; i += cleanInfo.channels) {
    if (cleanPixels[i] < 100 && cleanPixels[i + 1] < 100) cleanDark++;
  }
  assert.equal(cleanDark, 0, "cleanBuffer must remain free of SoM badge boxes");
});

test("ChromeBridge supports /health, /pair, /ws hello+command push+reply, and origin enforcement", async (t) => {
  const extOrigin = "chrome-extension://bhiemmbmefifaloapbcopihahhckolce";
  const bridge = new ChromeBridge(true, "/* runtime v6 */");
  await bridge.start();
  assert(bridge.port > 0);
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.port}`;

  // Reject unauthenticated/non-extension origin on /health.
  const deniedHealth = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(deniedHealth.status, 403);

  const health = await (await fetch(`${base}/health`, { headers: { origin: extOrigin } })).json() as any;
  assert.equal(health.ok, true);
  assert.equal(health.app, "vega");
  assert.equal(health.version, "0.2.9");

  const clientId = "11111111-1111-4111-8111-111111111111";
  const pairRes = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: extOrigin,
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify({ clientId, version: "0.2.9" }),
  });
  assert.equal(pairRes.status, 200);
  const { token, app } = await pairRes.json() as any;
  assert.equal(app, "vega");
  assert.equal(token, bridge.token);

  // Reject foreign Origin on /ws.
  await assert.rejects(new Promise((_, reject) => {
    const bad = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?clientId=${clientId}&token=${token}`, {
      origin: "https://evil.example",
    });
    bad.once("error", reject);
    bad.once("open", () => reject(new Error("must not open with foreign origin")));
  }));

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?clientId=${clientId}&token=${token}`, {
    origin: extOrigin,
    headers: { "user-agent": "Chrome/130.0.0.0" },
  });
  t.after(() => ws.terminate());

  const msgs: any[] = [];
  let onHello!: (msg: any) => void;
  const helloPromise = new Promise<any>((resolve) => { onHello = resolve; });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString("utf8"));
    msgs.push(msg);
    if (msg.type === "hello") onHello(msg);
    else if (msg.type === "cmd" && msg.op === "tabs") {
      ws.send(JSON.stringify({ type: "reply", id: msg.id, ok: true, result: { tabs: [{ tag: "C1", active: true, url: "https://example.test/" }] } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", resolve);
  });

  const hello = await helloPromise;
  assert.equal(hello.type, "hello");
  assert.equal(hello.version, "0.2.9");
  assert.equal(hello.runtime, "/* runtime v6 */");

  const tabsRes = await bridge.request("tabs", {});
  assert.equal(tabsRes.tabs[0].tag, "C1");
  bridge.hideCursor();
  await new Promise((r) => setTimeout(r, 30));
  assert(msgs.some((m) => m.type === "cmd" && m.op === "cursor_hide"));
});

test("unified browser_tabs / browser_view / browser_act / browser_eval / browser_debug 1-RTT execution", async (t: TestContext) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  await store.saveSession({ id: "owner", title: "", cwd: ".", createdAt: 0 });
  const jpeg = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } },
  }).jpeg({ quality: 82 }).toBuffer();

  const reqs: { op: string; args: Obj }[] = [];
  const fakeView = {
    url: "https://example.test/form",
    title: "Form",
    readyState: "complete",
    stamp: "v1",
    frameCount: 1,
    viewport: [800, 600, 1],
    scroll: [0, 0, 800, 1200],
    text: "Submit Email",
    focused: { tag: "INPUT", role: "textbox" },
    overlay: { open: true, kind: "menu", rect: [100, 100, 120, 80], hasConfirm: false, outsidePoint: [40, 40] },
    items: [
      { id: 1, role: "button", name: "Submit", x: 200, y: 300, rect: [160, 285, 80, 30], inView: true },
      { id: 2, role: "textbox", name: "Email", x: 200, y: 200, rect: [120, 185, 160, 30], inView: true, editable: true },
    ],
    screenshotB64: jpeg.toString("base64"),
  };

  const bridge = {
    async request(op: string, args: Obj) {
      reqs.push({ op, args });
      if (op === "open") return { tab: "C1-1", tabs: [{ tag: "C1-1", active: true, url: args.url }], view: fakeView };
      if (op === "view") return fakeView;
      if (op === "act") return { ok: true, completed: args.steps.length, actions: args.steps.map((s: Obj) => s.op), view: fakeView };
      if (op === "eval") return { ok: true, value: { count: 42 }, view: args.withView ? fakeView : undefined };
      if (op === "debug") return { entries: [{ level: "error", text: "boom" }], count: 1 };
      return { tabs: [{ tag: "C1-1", active: true, url: "https://example.test/form" }] };
    },
    hideCursor() {},
    close() {},
  };

  const chrome = new Chrome(store, bridge as any, "");
  const opened = await chrome.execute("owner", ".", { operation: "browser_tabs", action: "open", url: "https://example.test/form" });
  assert.equal(opened.tab, "C1-1");
  assert.equal(opened.images.length, 1);
  assert.equal(opened.images[0].mime, "image/jpeg");
  assert.match(opened.images[0].path, /\.jpg$/);
  assert(!opened.images[0].path.endsWith("-som.jpg"), "tool output image path must point to clean unannotated shot");
  assert(!JSON.stringify(opened).includes("-som.jpg"), "_vision must stay non-enumerable and absent from JSON output");
  assert(opened.images[0]._vision?.path?.endsWith("-som.jpg"), "model vision receives annotated -som.jpg");
  assert(opened.elements.includes("[1] button") && opened.elements.includes("Submit"));

  const cleanView = await chrome.execute("owner", ".", { operation: "browser_view", annotate: false });
  assert.equal(reqs.at(-1)?.args.viewOpts?.clean, true);
  assert.equal(cleanView.images[0]._vision, undefined, "annotate=false skips SoM rendering completely");

  // browser_act forwards element IDs / dismiss directly and maps coordinate-only steps via snapshot mapping.
  const acted = await chrome.execute("owner", ".", {
    operation: "browser_act",
    steps: [
      { op: "type", id: 2, text: "a@b.test", clear: true, submit: false },
      { op: "click", id: 1 },
      { op: "hover", x: 100, y: 120 },
      { op: "dismiss" },
    ],
  });
  assert.equal(acted.ok, true);
  assert.equal(acted.completed, 4);
  const actCall = reqs.findLast((r) => r.op === "act")!;
  assert.equal(actCall.args.steps[0].id, 2);
  assert.equal(actCall.args.steps[1].id, 1);
  assert.equal(actCall.args.steps[2].x, 100);
  assert.equal(actCall.args.steps[2].y, 120);
  assert.equal(actCall.args.steps[3].op, "dismiss");

  // browser_eval without view skips screenshot re-encode.
  const evaluated = await chrome.execute("owner", ".", { operation: "browser_eval", code: "({ count: 42 })" });
  assert.deepEqual(evaluated.value, { count: 42 });
  assert.equal(evaluated.images, undefined);

  // browser_debug queries console/network/downloads.
  const debugged = await chrome.execute("owner", ".", { operation: "browser_debug", kind: "console", level: "error" });
  assert.equal(debugged.count, 1);
});

test("credentialScope reads current URL, title, text and editable fields from browser_view snapshot", async (t: TestContext) => {
  const { Engine } = await import("../server/core/engine");
  const { Catalog } = await import("../server/core/catalog");
  const { Subscriptions } = await import("../server/core/subscriptions");
  const { Tools } = await import("../server/core/tools");
  const store = await Store.open(":memory:");

  const bridge = {
    async request(op: string) {
      if (op === "tabs") return { tabs: [{ tag: "C1-1", active: true, url: "https://login.example.test/signin" }] };
      if (op === "view") {
        return {
          url: "https://login.example.test/signin",
          title: "Example Sign In",
          text: "Please sign in with your company account",
          viewport: [800, 600, 1],
          scroll: [0, 0, 800, 600],
          items: [
            { id: 1, role: "textbox", name: "Username", x: 200, y: 150, rect: [100, 135, 200, 30], inView: true, editable: true },
            { id: 2, role: "button", name: "Sign in", x: 200, y: 210, rect: [140, 195, 120, 30], inView: true },
          ],
        };
      }
      return {};
    },
    hideCursor() {},
    close() {},
  };
  const chrome = new Chrome(store, bridge as any, "");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), chrome);
  engine.employee.closed = true;
  t.after(async () => {
    await engine.close();
    await store.close();
  });

  const session = await store.newSession({ scene: "computer" });
  await store.put("config", {
    scenes: { lightweight: ["p/m"] },
    provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: {} } } },
  });
  let seenPayload: any;
  engine.providers.chat = async (_model, _system, messages) => {
    seenPayload = JSON.parse(String(messages[0]?.text || "{}"));
    return {
      role: "assistant",
      calls: [{ id: "c1", name: "check_credential_use", arguments: { allowed: true, reason: "matches login page" } }],
    };
  };
  const emp = await engine.employeeFor(session);
  const added = await emp.vault.save({
    name: "Example SSO",
    condition: "Sign in to login.example.test",
    content: "alice / secret",
  });
  await chrome.execute(session.id, ".", { operation: "browser_view", tab: "C1-1", screenshot: false });

  const tools = await Tools.create(engine, session, await engine.config(), new AbortController().signal, () => {});
  (tools as any).browserTab = "C1-1";
  const scope = await (tools as any).credentialScope({ id: added.id, text: "Sign in to Example SSO" });
  assert.equal(scope, "https://login.example.test");
  assert.equal(seenPayload.credential.name, "Example SSO");
  assert.equal(seenPayload.pages.length, 1);
  assert.equal(seenPayload.pages[0].url, "https://login.example.test/signin");
  assert.equal(seenPayload.pages[0].title, "Example Sign In");
  assert(seenPayload.pages[0].text.includes("company account"));
  assert.deepEqual(seenPayload.pages[0].fields.map((f: any) => f.name), ["Username"]);
});

test("browser_view strips all-zero zoom placeholder objects while preserving partial coordinate checks", async (t: TestContext) => {
  const { Engine } = await import("../server/core/engine");
  const { Catalog } = await import("../server/core/catalog");
  const { Subscriptions } = await import("../server/core/subscriptions");
  const { Tools } = await import("../server/core/tools");
  const store = await Store.open(":memory:");
  const viewRequests: any[] = [];
  const bridge = {
    async request(op: string, payload: any) {
      if (op === "tabs") return { tabs: [{ tag: "C1-1", active: true, url: "https://example.test/" }] };
      if (op === "view") {
        viewRequests.push(payload.viewOpts);
        return {
          url: "https://example.test/",
          title: "Example",
          text: "Hello",
          viewport: [800, 600, 1],
          scroll: [0, 0, 800, 600],
          items: [],
        };
      }
      return {};
    },
    hideCursor() {},
    close() {},
  };
  const chrome = new Chrome(store, bridge as any, "");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), chrome);
  engine.employee.closed = true;
  t.after(async () => {
    await engine.close();
    await store.close();
  });
  await store.put("config", {
    scenes: { computer: ["p/m"] },
    provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { modalities: { input: ["text", "image"] } } } } },
  });
  const session = await store.newSession({ scene: "computer" });
  const tools = await Tools.create(engine, session, await engine.config(), new AbortController().signal, () => {});
  await chrome.execute(session.id, ".", { operation: "browser_tabs", action: "list", view: false });

  const okRes = await tools.execute({
    id: "bv-zero-zoom",
    name: "browser_view",
    arguments: {
      tab: "C1-1",
      screenshot: false,
      zoom: { id: 0, x: 0, y: 0, width: 0, height: 0 },
    },
  }, { supportsImages: true } as any);
  assert.equal(okRes.error, undefined);
  assert.equal(viewRequests.length, 1);
  assert.equal(viewRequests[0].zoomRect, undefined);
  assert.equal(viewRequests[0].zoomId, undefined);

  await assert.rejects(
    tools.execute({
      id: "bv-partial-zoom",
      name: "browser_view",
      arguments: {
        tab: "C1-1",
        screenshot: false,
        zoom: { x: 10, y: 20, width: 0, height: 0 },
      },
    }, { supportsImages: true } as any),
    /必须大于 0/,
  );
});

test("processScreenshot reuses unchanged frames and invalidates when SoM layout changes", async () => {
  const { somSignature } = await import("../server/core/browser-annotate");
  const smallJpeg = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 245, g: 245, b: 245 } },
  }).jpeg({ quality: 85 }).toBuffer();
  const boxes1 = [{ id: 1, rect: [40, 50, 80, 30] as [number, number, number, number] }];
  const boxes2 = [{ id: 2, rect: [40, 50, 80, 30] as [number, number, number, number] }];
  assert.notEqual(
    somSignature(boxes1, 320, 200, [0, 0, 320, 200]),
    somSignature(boxes2, 320, 200, [0, 0, 320, 200]),
  );

  const first = await processScreenshot({
    jpegBase64: smallJpeg.toString("base64"),
    cssViewport: [320, 200],
    boxes: boxes1,
    drawSom: true,
    stream: "C1-1:viewport",
  });
  assert.equal(first.unchanged, undefined);
  assert(first.plain && first.basis);

  const prior = {
    stream: "C1-1:viewport",
    basis: first.basis!,
    plain: first.plain!,
    width: first.mapping.pixelWidth,
    height: first.mapping.pixelHeight,
    path: "/tmp/first.jpg",
    url: "/first.jpg",
  };
  const same = await processScreenshot({
    jpegBase64: smallJpeg.toString("base64"),
    cssViewport: [320, 200],
    boxes: boxes1,
    drawSom: true,
    stream: "C1-1:viewport",
    prior,
  });
  assert.equal(same.unchanged, true);
  assert.equal(same.reused?.path, "/tmp/first.jpg");

  const changedSom = await processScreenshot({
    jpegBase64: smallJpeg.toString("base64"),
    cssViewport: [320, 200],
    boxes: boxes2,
    drawSom: true,
    stream: "C1-1:viewport",
    prior,
  });
  assert.equal(changedSom.unchanged, undefined, "SoM layout change must invalidate unchanged reuse");
});

test("browser_debug(kind='status') works both connected and disconnected, and short tab tags expand", async (t: TestContext) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  await store.saveSession({ id: "owner", title: "", cwd: ".", createdAt: 0 });
  const jpeg = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 245, g: 245, b: 245 } },
  }).jpeg({ quality: 85 }).toBuffer();

  let connected = false;
  const requestedTags: string[] = [];
  const bridge = {
    status() {
      return {
        connected,
        browser: connected ? "Google Chrome" : undefined,
        browsers: connected ? ["Google Chrome"] : [],
        origin: "http://127.0.0.1:47753",
        extensionId: "bhiemmbmefifaloapbcopihahhckolce",
        extensionVersion: "0.2.9",
      };
    },
    async request(op: string, args: Obj) {
      if (op === "status") return { version: "0.2.9", incognitoAllowed: true };
      if (op === "open") return { tabTag: "C1-abcd", tabs: [{ tag: "C1-abcd", active: true, url: args.url }] };
      if (op === "view") {
        requestedTags.push(args.tabTag);
        return { url: "https://example.test/", title: "Ex", viewport: [320, 200, 1], scroll: [0, 0, 320, 200], items: [], text: "", screenshotB64: jpeg.toString("base64") };
      }
      return {};
    },
    hideCursor() {},
    close() {},
  };

  const chrome = new Chrome(store, bridge as any, "");
  const offline = await chrome.execute("owner", ".", { operation: "browser_debug", kind: "status" });
  assert.equal(offline.connected, false);
  assert.equal(offline.extensionVersion, "0.2.9");

  connected = true;
  const online = await chrome.execute("owner", ".", { operation: "browser_debug", kind: "status" });
  assert.equal(online.connected, true);
  assert.equal(online.version, "0.2.9");
  assert.equal(online.incognitoAllowed, true);

  await chrome.execute("owner", ".", { operation: "browser_tabs", action: "open", url: "https://example.test/", view: false });
  await chrome.execute("owner", ".", { operation: "browser_view", tab: "C2" });
  assert.deepEqual(requestedTags, ["C2-abcd"]);
});

test("formatView emits loadingHint for skeleton/blank pages and omits it when content is ready", async (t: TestContext) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  const chrome = new Chrome(store, new ChromeBridge(), "");

  const readyOut = await chrome.formatView("owner", "C1-1", {
    url: "https://example.test/",
    title: "Ready",
    viewport: [1280, 800, 1],
    scroll: [0, 0, 1280, 800],
    items: [],
    text: "Loaded content",
  });
  assert.equal(readyOut.loadingHint, undefined);

  const skeletonOut = await chrome.formatView("owner", "C1-1", {
    url: "https://tapd.example.test/story/1",
    title: "TAPD",
    viewport: [1280, 800, 1],
    scroll: [0, 0, 1280, 800],
    items: [],
    text: "",
    loadingState: { readyState: "complete", skeleton: true, blank: true, textChars: 0, skeletonNodes: 5 },
  });
  assert.match(String(skeletonOut.loadingHint || ""), /空骨架屏/);
  assert.match(String(skeletonOut.loadingHint || ""), /browser_debug\(kind="all"\)/);

  const mediaOut = await chrome.formatView("owner", "C1-1", {
    url: "https://example.test/file.png",
    title: "file.png",
    viewport: [1280, 800, 1],
    scroll: [0, 0, 1280, 800],
    items: [],
    text: "",
    loadingState: { readyState: "loading", skeleton: false, blank: true, textChars: 0, skeletonNodes: 0, media: true, contentType: "image/png" },
  });
  assert.match(String(mediaOut.loadingHint || ""), /媒体\/图片资源仍在加载中/);
  assert.doesNotMatch(String(mediaOut.loadingHint || ""), /空骨架屏/);

  const mediaReadyOut = await chrome.formatView("owner", "C1-1", {
    url: "https://example.test/file.png",
    title: "file.png (3758×2015)",
    viewport: [1280, 800, 1],
    scroll: [0, 0, 1280, 800],
    items: [],
    text: "",
    media: { contentType: "image/png", naturalWidth: 3758, naturalHeight: 2015 },
  });
  assert.equal(mediaReadyOut.loadingHint, undefined);
  assert.deepEqual(mediaReadyOut.mediaReady, { contentType: "image/png", naturalWidth: 3758, naturalHeight: 2015 });
});

test("page_runtime.js detectSkeleton handles standalone media docs and visual HTML pages, and stays synced with local/page_runtime.js", () => {
  const serverSrc = readFileSync("server/assets/browser/page_runtime.js", "utf8");
  const localSrc = readFileSync("local/page_runtime.js", "utf8");
  assert.equal(serverSrc, localSrc, "server/assets/browser/page_runtime.js and local/page_runtime.js must stay byte-for-byte identical");

  const runDetect = (opts: {
    contentType: string;
    readyState: string;
    textNodes?: string[];
    imgs?: { complete: boolean; naturalWidth: number; naturalHeight: number; rect?: { left: number; top: number; right: number; bottom: number } }[];
    canvases?: { width: number; height: number; rect?: { left: number; top: number; right: number; bottom: number } }[];
    svgRect?: { width: number; height: number };
  }) => {
    const textNodes = (opts.textNodes || []).map((nodeValue) => ({
      nodeValue,
      parentElement: {
        nodeType: 1,
        tagName: "P",
        getBoundingClientRect: () => ({ width: 200, height: 20, left: 0, top: 0, right: 200, bottom: 20 }),
      },
    }));
    const imgs = (opts.imgs || []).map((im) => ({
      nodeType: 1,
      ...im,
      getBoundingClientRect: () => im.rect || { left: 0, top: 0, right: 800, bottom: 600 },
    }));
    const canvases = (opts.canvases || []).map((cv) => ({
      nodeType: 1,
      ...cv,
      getBoundingClientRect: () => cv.rect || { left: 0, top: 0, right: 800, bottom: 600 },
    }));
    let cursor = 0;
    const doc: any = {
      contentType: opts.contentType,
      readyState: opts.readyState,
      body: { tagName: "BODY" },
      documentElement: {
        tagName: opts.svgRect ? "svg" : "HTML",
        getBoundingClientRect: () => opts.svgRect || { width: 1280, height: 800 },
      },
      querySelectorAll(sel: string) {
        if (sel === "img") return imgs;
        if (sel === "canvas") return canvases;
        return [];
      },
      createTreeWalker() {
        return { nextNode: () => (cursor < textNodes.length ? textNodes[cursor++] : null) };
      },
    };
    const win: any = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 };
    win.top = win;
    const scope: any = {
      window: win,
      document: doc,
      innerWidth: 1280,
      innerHeight: 800,
      NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      performance: { now: () => 0 },
      clearTimeout,
      setTimeout,
      clearInterval,
      setInterval,
    };
    scope.globalThis = scope;
    runInNewContext(serverSrc, scope);
    return scope.__novaBrowser.detectSkeleton();
  };

  // 1. Loaded standalone image/png -> blank: false, stillLoading: false, natural dimensions reported
  const loadedPng = runDetect({
    contentType: "image/png",
    readyState: "complete",
    imgs: [{ complete: true, naturalWidth: 3758, naturalHeight: 2015 }],
  });
  assert.equal(loadedPng.blank, false);
  assert.equal(loadedPng.stillLoading, false);
  assert.equal(loadedPng.media, true);
  assert.equal(loadedPng.naturalWidth, 3758);
  assert.equal(loadedPng.naturalHeight, 2015);

  // 2. Streaming/loading standalone image/png -> stillLoading: true, media: true
  const loadingPng = runDetect({
    contentType: "image/png",
    readyState: "loading",
    imgs: [{ complete: false, naturalWidth: 0, naturalHeight: 0 }],
  });
  assert.equal(loadingPng.blank, true);
  assert.equal(loadingPng.stillLoading, true);
  assert.equal(loadingPng.media, true);
  assert.equal(loadingPng.contentType, "image/png");

  // 3. Loaded standalone PDF -> blank: false, stillLoading: false
  const loadedPdf = runDetect({ contentType: "application/pdf", readyState: "complete" });
  assert.equal(loadedPdf.blank, false);
  assert.equal(loadedPdf.stillLoading, false);

  // 4. Blank HTML page -> blank: true, stillLoading: true
  const blankHtml = runDetect({ contentType: "text/html", readyState: "complete" });
  assert.equal(blankHtml.blank, true);
  assert.equal(blankHtml.stillLoading, true);

  // 5. Visual HTML page with large loaded img -> blank: false, stillLoading: false
  const visualHtml = runDetect({
    contentType: "text/html",
    readyState: "complete",
    imgs: [{ complete: true, naturalWidth: 1200, naturalHeight: 800, rect: { left: 0, top: 0, right: 600, bottom: 400 } }],
  });
  assert.equal(visualHtml.blank, false);
  assert.equal(visualHtml.stillLoading, false);
});
