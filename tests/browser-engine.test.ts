import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(health.version, "0.2.5");

  const clientId = "11111111-1111-4111-8111-111111111111";
  const pairRes = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: extOrigin,
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify({ clientId, version: "0.2.5" }),
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
  assert.equal(hello.version, "0.2.5");
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
