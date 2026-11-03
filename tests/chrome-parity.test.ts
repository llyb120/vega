import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Store } from "../server/core/store";
import { bindStep, chains, literalMet, runCandidates, runState, validatePlan } from "../server/core/browser-run";
import type { Obj } from "../server/core/util";

function fixture(t: TestContext) {
  const store = new Store(":memory:"), chrome = new Chrome(store, new ChromeBridge(), "");
  t.after(() => store.close());
  const sent: Obj[] = [], calls: Obj[] = [];
  const page: Obj = { url: "https://example.test/", title: "Fixture", document: "doc", stamp: "stamp", text: "ready", visibleText: "ready", frame: 0,
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }, documentSize: { width: 800, height: 600 },
    items: [{ ref: "save", name: "Save", role: "button", inView: true, nodeId: "save" }, { ref: "email", name: "Email", role: "textbox", editable: true, inView: true, nodeId: "email" }], focus: { identity: "email" } };
  const tabs: Obj[] = [{ tag: "tab", active: true, controllable: true, loading: false }];
  let serial = 0;
  chrome.observe = async (tag) => ({ id: "snap-" + ++serial, tabTag: tag, frames: [{ id: "main", context: 1 }], pages: [structuredClone(page)], images: [], coverageGaps: [], captured: Date.now(), fullPage: false, screenshot: false });
  chrome.bridge.request = async (operation, args) => { calls.push({ operation, args }); return { tabs: structuredClone(tabs) }; };
  chrome.evaluate = async (_tag, _frame, expression, _signal, timeout) => {
    calls.push({ expression, timeout });
    if (expression.includes("inputState")) return { identity: "email", editable: true, matches: true };
    if (expression.includes("verifyValue")) return { matches: true };
    if (expression.includes("innerScrollOverflow")) return 0;
    if (expression.startsWith("__novaWebview.evaluate(")) return { status: "executed", value: null };
    return {};
  };
  chrome.point = async (_o, _f, ref) => ({ x: 20, y: 20, localX: 20, localY: 20, localRect: {}, rect: { x: 10, y: 10, width: 100, height: 20 }, identity: ref, editable: ref === "email" });
  chrome.mouse = async (_tag, point) => { sent.push({ action: "click", ref: point.identity }); };
  chrome.key = async (_tag, key) => { sent.push({ action: "press", key }); };
  chrome.cdp = async (_tag, method, params = {}) => { sent.push({ method, ...params }); return {}; };
  const observe = async () => { const o = await chrome.observe("tab"); chrome.observations.set("owner:tab", o); return o; };
  const act = (args: Obj) => chrome.execute("owner", ".", { tabTag: "tab", operation: "act", visual: "none", settleMs: 0, ...args });
  const run = (steps: Obj[], extra: Obj = {}) => chrome.run("owner", ".", { tabTag: "tab", visual: "none", plan: { task: "fixture", steps, ...extra } }, new AbortController().signal);
  return { store, chrome, sent, calls, page, tabs, observe, act, run };
}

test("navigation invalidates all owners of its tab even without feedback", async (t) => {
  for (const operation of ["goto", "back", "forward", "reload", "close_tab"]) {
    for (const observe of ["none", "inspect"]) {
      const f = fixture(t), old = await f.observe();
      f.chrome.observations.set("other:tab", old);
      f.chrome.observations.set("owner:unrelated", { ...old, tabTag: "unrelated" });
      const result = await f.chrome.execute("owner", ".", { operation, tabTag: "tab", url: "https://example.test/next", observe, visual: "none" });
      assert(!f.chrome.observations.has("other:tab"), operation);
      assert(f.chrome.observations.has("owner:unrelated"), operation);
      if (observe === "none" || operation === "close_tab") {
        assert(!f.chrome.observations.has("owner:tab"), operation);
        await assert.rejects(f.act({ action: { action: "press", key: "Enter" } }), /no observation/);
        assert.equal(f.sent.length, 0);
      } else {
        assert.notEqual(result.snapshotId, old.id);
        assert.equal(f.chrome.observations.get("owner:tab")!.id, result.snapshotId);
      }
      assert.equal(f.calls.filter(call => call.operation === operation).length, 1);
    }
  }
});

test("selecting a tab preserves other owners, and failed navigation does not discard observations", async (t) => {
  const f = fixture(t), old = await f.observe();
  f.chrome.observations.set("other:tab", old);
  await f.chrome.execute("owner", ".", { operation: "select_tab", tabTag: "tab", observe: "none" });
  assert.equal(f.chrome.observations.get("other:tab"), old);
  f.chrome.bridge.request = async () => { throw Error("navigation rejected"); };
  await assert.rejects(f.chrome.execute("owner", ".", { operation: "goto", tabTag: "tab", url: "https://example.test/next" }), /navigation rejected/);
  assert.equal(f.chrome.observations.get("owner:tab"), old);
  assert.equal(f.chrome.observations.get("other:tab"), old);
});

test("whole-batch preflight rejects unknown refs, uploads and screenshot bounds before any input", async (t) => {
  const f = fixture(t); const o = await f.observe();
  f.chrome.workspaceFile = async () => { throw Error("Only regular workspace files"); };
  for (const action of [{ action: "click", ref: "invented" }, { action: "upload", selector: "input[type=file]", files: ["outside"] }, { action: "click_at", x: 1, y: 1 }]) {
    const r = await f.act({ actions: [{ action: "press", key: "Enter" }, action] });
    assert.equal(r.status, "not_executed"); assert.equal(r.completedActions, 0); assert.equal(r.inputAttempted, false);
  }
  o.screenshot = true; o.images = [{ imageId: "image", pixelWidth: 100, pixelHeight: 100 }];
  const r = await f.act({ imageId: "image", actions: [{ action: "press", key: "Enter" }, { action: "drag", x: 1, y: 1, to_x: 101, to_y: 2 }] });
  assert.equal(r.status, "not_executed"); assert.deepEqual(f.sent, []);
});

test("a new child tab ends a batch; only a unique active child receives feedback", async (t) => {
  const f = fixture(t); await f.observe();
  f.chrome.key = async (_tag, key) => { f.sent.push({ key }); f.tabs.push({ tag: "child", openerTag: "tab", active: true, controllable: true }); };
  const r = await f.act({ actions: [{ action: "press", key: "Enter" }, { action: "press", key: "Tab" }] });
  assert.equal(r.completedActions, 1); assert.equal(r.status, "needs_review"); assert.equal(r.tabTag, "child"); assert.equal(r.sourceTabTag, "tab");
  assert.deepEqual(f.sent, [{ key: "Enter" }]);
});

test("ambiguous or background children return inventory without recapturing the source", async (t) => {
  for (const multiple of [false, true]) {
    const f = fixture(t); await f.observe(); let observed = 0;
    f.chrome.observe = async () => { observed++; throw Error("must not observe"); };
    f.chrome.key = async () => {
      f.tabs.push({ tag: "child", openerTag: "tab", active: multiple, controllable: true });
      if (multiple) f.tabs.push({ tag: "other-child", openerTag: "tab", active: false, controllable: true });
    };
    const r = await f.act({ action: { action: "press", key: "Enter" } });
    assert.equal(r.status, "executed"); assert.equal(observed, 0); assert.equal(r.snapshotId, undefined); assert(r.openedTabs.length);
  }
});

test("evaluate discovers only children of its source and honors feedback=none", async (t) => {
  const f = fixture(t); await f.observe();
  const original = f.chrome.evaluate;
  f.chrome.evaluate = async (tag, frame, expression, signal, timeout) => {
    if (expression.startsWith("__novaWebview.evaluate(")) {
      assert.equal(timeout, 5000);
      f.tabs.push({ tag: "child", openerTag: "tab", active: true, controllable: true }, { tag: "unrelated", openerTag: "elsewhere", active: true, controllable: true });
    }
    return original(tag, frame, expression, signal, timeout);
  };
  const r = await f.act({ operation: "evaluate", expression: "window.open('/child')" });
  assert.equal(r.tabTag, "child"); assert.equal(r.completedActions, 1); assert.equal(r.value, null);
  assert.deepEqual(r.openedTabs.map((v: Obj) => v.tag), ["child"]);
  const saved = f.chrome.observations.get("owner:tab");
  const quiet = await f.act({ operation: "evaluate", expression: "null", feedback: "none" });
  assert.equal(quiet.value, null); assert.equal(quiet.snapshotId, undefined); assert.equal(f.chrome.observations.get("owner:tab"), saved);
});

test("script exceptions and observation failures retain execution uncertainty without resending", async (t) => {
  const f = fixture(t); await f.observe(); let scripts = 0;
  f.chrome.evaluate = async () => { scripts++; throw Error("script failed after input"); };
  const r = await f.act({ operation: "evaluate", expression: "throw Error('fail')" });
  assert.equal(r.status, "needs_review"); assert.equal(r.inputAttempted, true); assert.equal(scripts, 1);
  f.chrome.observe = async () => { throw Error("renderer unavailable"); };
  const clicked = await f.act({ action: { action: "press", key: "Enter" } });
  assert.equal(clicked.status, "executed"); assert.equal(clicked.completedActions, 1); assert.match(clicked.observationError, /renderer unavailable/);
});

test("evaluate applies a CDP deadline and an independent bounded wait", async (t) => {
  const f = fixture(t); let params: Obj = {}, calls = 0;
  f.chrome.cdp = async (_tag, _method, args) => { calls++; params = args!; return new Promise(() => {}); };
  await assert.rejects(Chrome.prototype.evaluate.call(f.chrome, "tab", { id: "main", context: 1 }, "new Promise(()=>{})", undefined, 20), /超时.*不要重放/);
  assert.equal(params.timeout, 20); assert.equal(params.awaitPromise, true); assert.equal(calls, 1);
});

test("guided runs wait for when/expect evidence without repeating input and match URL/title", async (t) => {
  const f = fixture(t); f.page.text = f.page.visibleText = "loading"; await f.observe();
  const read = f.chrome.observe; let observations = 0;
  f.chrome.observe = async (tag, scope, signal) => {
    observations++;
    if (!f.sent.length) f.page.visibleText = "ready";
    else if (observations >= 3) f.page.title = "SAVED RESULT";
    return read(tag, scope, signal);
  };
  const r = await f.run([{ action: "click", name: "Save", when: "READY", expect: "saved result" }], { expectedText: "https://example.test/" });
  assert.equal(r.altairRun.status, "completed", JSON.stringify(r.altairRun));
  assert.equal(f.sent.filter((v) => v.action === "click").length, 1);
  assert(r.altairRun.checks.every((c: Obj) => c.met));
});

test("run stops after crossing origins or opening a child and never executes remaining steps", async (t) => {
  for (const popup of [false, true]) {
    const f = fixture(t); await f.observe();
    f.chrome.mouse = async () => {
      f.sent.push({ action: "click" });
      if (popup) f.tabs.push({ tag: "child", openerTag: "tab", active: true, controllable: true });
      else f.page.url = "https://other.test/";
    };
    const r = await f.run([{ action: "click", name: "Save" }, { action: "press", key: "Tab" }]);
    assert.equal(r.altairRun.status, "needs_review"); assert.equal(r.altairRun.guided.completedSteps, 1);
    assert.equal(r.altairRun.guided.remainingSteps.length, 1); assert.equal(f.sent.filter((v) => v.key === "Tab").length, 0);
    assert.match(r.altairRun.guided.next, popup ? /新标签/ : /跨站/);
  }
});

test("run batches independent form fills but ends a batch at submit or a when boundary", async (t) => {
  const f = fixture(t); f.page.items.push({ ref: "city", nodeId: "city", name: "City", role: "textbox", editable: true, inView: true }); await f.observe();
  const batches: Obj[][] = [];
  f.chrome.inner = async (_owner, _cwd, args) => {
    batches.push(args.actions);
    const o = await f.observe();
    return { status: "executed", completedActions: args.actions.length, snapshotId: o.id, tabTag: "tab" };
  };
  const r = await f.run([{ action: "fill", name: "Email", text: "value" }, { action: "fill", name: "City", text: "London" }, { action: "press", key: "Enter" }, { action: "press", key: "Tab", when: "ready" }]);
  assert.equal(r.altairRun.status, "completed", JSON.stringify(r.altairRun)); assert.deepEqual(batches.map((b) => b.length), [3, 1]);
  assert(!JSON.stringify(r.altairRun.history).includes("London"));
});

test("run validates every step before input and uncertain input never retries", async (t) => {
  const f = fixture(t); await f.observe();
  await assert.rejects(f.run([{ action: "click", name: "Save" }, { action: "fill", name: "Email" }]), /fill requires text/);
  assert.equal(f.sent.length, 0);
  f.chrome.inner = async () => { f.sent.push({ uncertain: true }); return { status: "needs_review", inputAttempted: true, completedActions: 0, reason: "unknown" }; };
  const r = await f.run([{ action: "click", name: "Save" }]);
  assert.equal(r.altairRun.status, "needs_review"); assert.equal(f.sent.length, 1);
});

test("run resumes after a partial DOM preflight failure without replaying the completed fill", async (t) => {
  const f = fixture(t); f.page.items.push({ ref: "city", nodeId: "city", name: "City", role: "textbox", editable: true, inView: true }); await f.observe();
  const batches: Obj[][] = [];
  f.chrome.inner = async (_owner, _cwd, args) => {
    batches.push(args.actions);
    const o = await f.observe();
    return batches.length === 1
      ? { status: "needs_review", completedActions: 1, inputAttempted: true, failedAtPreflight: true, snapshotId: o.id, tabTag: "tab" }
      : { status: "executed", completedActions: args.actions.length, snapshotId: o.id, tabTag: "tab" };
  };
  const r = await f.run([{ action: "fill", name: "Email", text: "value" }, { action: "fill", name: "City", text: "London" }]);
  assert.equal(r.altairRun.status, "completed", JSON.stringify(r.altairRun));
  assert.deepEqual(batches.map((b) => b.map((a) => a.ref)), [["email", "city"], ["city"]]);
});

test("local binding ranks column/group icons, refuses ambiguous targets and constrains input fields", () => {
  const pages = [{ viewport: { width: 800, height: 600, scrollY: 0 }, documentSize: { height: 1200 }, items: [
    { ref: "wrong", name: "", role: "button", inView: true, icon: "sort", column: { name: "Revenue", group: "M Science" } },
    { ref: "right", name: "", role: "button", inView: true, icon: "sort", column: { name: "Digital Units", group: "M Science" } },
    { ref: "header", name: "Digital Units", role: "button", inView: true, column: { name: "Digital Units", group: "M Science" } },
    { ref: "one", name: "Search", role: "textbox", editable: true, inView: true, fieldContext: "one" },
    { ref: "two", name: "Search", role: "textbox", editable: true, inView: true, fieldContext: "two" },
  ] }];
  const all = runCandidates(pages);
  assert.equal(bindStep({ action: "click", target: "M Science 分组 Digital Units 排序图标" }, [], all).candidate?.action.ref, "right");
  assert.equal(bindStep({ action: "fill", name: "Search", text: "query" }, [], all).ambiguous, true);
  assert.equal(bindStep({ action: "fill", name: "Search", text: "query" }, [{ name: "Search", text: "query", fieldContext: "two" }], all).candidate?.action.ref, "two");
  assert.equal(bindStep({ action: "scroll" }, [], all).candidate?.action.delta, 480);
  assert(literalMet([{ url: "https://test/RESULT", title: "Done" }], "missing｜ result"));
  assert(!chains({ action: "press", key: "Enter" }, all[0], { action: "click" }));
  assert.throws(() => validatePlan({ task: "test", steps: [{ action: "click", name: "Save", repeat: 4 }] }));
});

async function screenshotFixture(t: TestContext, width = 800, height = 3000) {
  const f = fixture(t), captures: Obj[] = [], layouts: string[] = [];
  f.page.documentSize = { width, height };
  f.chrome.evaluate = async (_tag, _frame, expression) => { layouts.push(expression); return expression.includes("innerScrollOverflow") ? 0 : true; };
  f.chrome.cdp = async (_tag, method, params = {}) => {
    captures.push({ method, ...params });
    if (method === "Page.getLayoutMetrics") return { cssContentSize: f.page.documentSize };
    if (method === "Page.captureScreenshot") {
      const clip = params.clip || { width: 1, height: 1 };
      const bytes = await sharp({ create: { width: Math.ceil(clip.width), height: Math.ceil(clip.height), channels: 3, background: "white" } }).webp().toBuffer();
      return { data: bytes.toString("base64") };
    }
    return {};
  };
  return { ...f, captures, layouts };
}

test("unchanged screenshots detect small pixel changes and keep frame streams separate", async (t) => {
  const f = await screenshotFixture(t, 640, 480);
  Object.assign(f.page.viewport, { width: 640, height: 480 });
  const white = await sharp({ create: { width: 640, height: 480, channels: 3, background: "white" } }).png().toBuffer();
  let pixels = white;
  const raw = f.chrome.cdp;
  f.chrome.cdp = async (...args) => args[1] === "Page.captureScreenshot" ? { data: pixels.toString("base64") } : raw(...args);
  const first = await f.observe(); await f.chrome.capture(first, {});
  const same = await f.observe(); await f.chrome.capture(same, {}, first);
  assert.equal(same.images[0].unchanged, true);
  assert.equal(same.images[0].blobId, first.images[0].blobId);
  for (const [value, unchanged] of [[239, true], [238, false], [0, false]] as const) {
    const patch = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: value, g: value, b: value } } }).png().toBuffer();
    pixels = await sharp(white).composite([{ input: patch, left: 100, top: 100 }]).png().toBuffer();
    const next = await f.observe(); await f.chrome.capture(next, {}, first);
    assert.equal(next.images[0].unchanged, unchanged, `pixel delta ${255 - value}`);
    assert.equal(next.images[0].blobId === first.images[0].blobId, unchanged);
  }
  pixels = white;
  const full = await f.observe(); await f.chrome.capture(full, { fullPage: true }, first);
  assert.equal(full.images[0].frameStream, "tab:document:0");
  assert.equal(full.images[0].unchanged, false);
  const fullAgain = await f.observe(); await f.chrome.capture(fullAgain, { fullPage: true }, full);
  assert.equal(fullAgain.images[0].unchanged, true);
  for (const args of [{ region: { x: 0, y: 0, width: 640, height: 480 } }, { expandScroll: true }]) {
    const standalone = await f.observe(); await f.chrome.capture(standalone, args, first);
    assert.equal(standalone.images[0].frameStream, undefined);
    assert.equal(standalone.images[0].unchanged, false);
  }
  f.page.document = "new-document";
  const navigated = await f.observe(); await f.chrome.capture(navigated, {}, first);
  assert.equal(navigated.images[0].unchanged, false);
});

test("expanded scroll retains original pixels and remains read-only; ordinary images stay bounded", async (t) => {
  const f = await screenshotFixture(t);
  let o = await f.observe();
  const result = await f.chrome.capture(o, { expandScroll: true });
  assert.equal(o.images[0].pixelHeight, 3000); assert.equal(o.images[0].pixelWidth, 800); assert.equal(o.images[0].readOnlyImage, true);
  assert(result.screenshotComplete); assert(f.layouts.includes("__novaWebview.captureLayout(false)"));
  o = await f.observe(); await f.chrome.capture(o, { fullPage: true });
  assert(o.images[0].pixelHeight <= 1568);
});

test("full-page screenshots paginate both axes and fall back before unsafe renderer capture", async (t) => {
  const f = await screenshotFixture(t, 5000, 9000), o = await f.observe();
  const r = await f.chrome.capture(o, { fullPage: true });
  assert.equal(r.totalTiles, 9); assert.equal(r.nextTile, 4); assert.equal(o.images.length, 4); assert.equal(r.screenshotComplete, false);
  assert.equal(o.images[1].x, 2048); assert.equal(o.images[3].y, 4096);
  f.page.documentSize = { width: 20000, height: 500 };
  const unsafe = await f.observe(); const fallback = await f.chrome.capture(unsafe, { fullPage: true });
  assert.equal(fallback.fullPage, false); assert.match(fallback.fullPageFallback!, /安全上限/);
  assert(f.captures.filter((c) => c.clip).every((c) => c.clip.width <= 2048));
});

test("viewport crops keep viewport coordinates after scrolling; restoration runs after failed capture", async (t) => {
  const f = await screenshotFixture(t); f.page.viewport.scrollY = 500;
  const o = await f.observe(); await f.chrome.capture(o, { region: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(o.images[0].y, 0); assert.equal(f.captures.find((c) => c.clip)!.clip.y, 500);
  const raw = f.chrome.cdp; let attempts = 0;
  f.chrome.cdp = async (...args) => {
    if (args[1] === "Page.captureScreenshot" && args[2]?.captureBeyondViewport) { attempts++; throw Error("capture failed"); }
    return raw(...args);
  };
  await assert.rejects(f.chrome.capture(await f.observe(), { fullPage: true }), /capture failed/);
  assert.equal(attempts, 1); assert.equal(f.layouts.at(-1), "__novaWebview.captureLayout(false)");
  assert(f.captures.some((c) => c.method === "Page.captureScreenshot" && c.captureBeyondViewport === false));
});

test("run does not treat tooltip/ref changes as progress and never blindly repeats a step", async (t) => {
  const f = fixture(t); await f.observe();
  const before = runState([f.page]); f.page.visibleText += " tooltip"; f.page.items[0].ref = "fresh-save";
  assert.equal(runState([f.page]), before);
  await f.observe();
  f.chrome.mouse = async () => { f.sent.push({ action: "click" }); f.page.visibleText += " new tooltip"; };
  const r = await f.run([{ action: "click", name: "Save", expect: "never appears", repeat: 1 }]);
  assert.equal(r.altairRun.status, "needs_review");
  assert.equal(f.sent.filter((v) => v.action === "click").length, 1);
});

test("run when failure waits without input; expectation failure keeps completed actions out of remaining steps", async (t) => {
  const f = fixture(t); await f.observe();
  const blocked = await f.run([{ action: "click", name: "Save", when: "absent" }]);
  assert.equal(blocked.altairRun.guided.completedSteps, 0); assert.equal(f.sent.length, 0);
  assert(blocked.altairRun.checks[0].ms >= 3000);
  const after = await f.run([{ action: "click", name: "Save", expect: "absent" }, { action: "press", key: "Enter" }]);
  assert.equal(after.altairRun.guided.completedSteps, 1); assert.equal(after.altairRun.guided.remainingSteps[0].action, "press");
  assert.equal(f.sent.filter((v) => v.action === "click").length, 1);
  assert(after.altairRun.checks[0].ms >= 6000);
});

test("run explicit repeat rebinds only after a changed state and observes its budget", async (t) => {
  const f = fixture(t); f.page.items[0].sort = "none"; await f.observe();
  f.chrome.mouse = async () => {
    f.sent.push({ action: "click" });
    f.page.items[0].sort = f.sent.filter((v) => v.action === "click").length === 1 ? "ascending" : "descending";
    if (f.page.items[0].sort === "descending") f.page.visibleText = "descending";
  };
  const r = await f.run([{ action: "click", name: "Save", expect: "descending", repeat: 1 }], { maxActions: 2 });
  assert.equal(r.altairRun.status, "completed", JSON.stringify(r.altairRun)); assert.equal(r.altairRun.executedActions, 2);
  const budget = await f.run([{ action: "press", key: "Tab" }, { action: "press", key: "Enter" }], { maxActions: 1 });
  assert.equal(budget.altairRun.status, "needs_review"); assert.equal(budget.altairRun.executedActions, 1);
});

test("expanded layout restores the viewport and reports incomplete scroll expansion", async (t) => {
  const f = await screenshotFixture(t); let height = 600;
  const raw = f.chrome.cdp;
  f.chrome.cdp = async (...args) => {
    if (args[1] === "Emulation.setDeviceMetricsOverride") height = args[2]!.height;
    if (args[1] === "Emulation.clearDeviceMetricsOverride") height = 600;
    return raw(...args);
  };
  f.chrome.evaluate = async (_tag, _frame, expression) => expression.includes("innerScrollOverflow") ? 900 : true;
  const r = await f.chrome.capture(await f.observe(), { expandScroll: true });
  assert.equal(height, 600); assert.equal(r.scrollExpanded?.complete, false);
  assert(f.captures.some((c) => c.method === "Emulation.setDeviceMetricsOverride"));
  assert(f.captures.some((c) => c.method === "Emulation.clearDeviceMetricsOverride"));
});

test("failed optional screenshots preserve DOM while explicit screenshots report failure", async (t) => {
  const f = fixture(t); f.chrome.capture = async () => { throw Error("capture failed"); };
  const r: Obj = await f.chrome.feedback("owner", "tab", {});
  assert(r.pages[0].items.length); assert.equal(r.screenshotError, "capture failed"); assert.equal(f.chrome.observations.get("owner:tab")!.screenshot, false);
  await assert.rejects(f.chrome.feedback("owner", "tab", {}, "screenshot"), /capture failed/);
});


test("terra-style placeholder region/ref are omitted so inspect and tabs can proceed", async (t) => {
  const { sanitizeChromeArgs, usableChromeRegion } = await import("../server/core/chrome");
  assert.equal(usableChromeRegion({ x: 0, y: 0, width: 0, height: 0 }), undefined);
  assert.deepEqual(usableChromeRegion({ x: 1, y: 2, width: 10, height: 20 }), { x: 1, y: 2, width: 10, height: 20 });
  const cleaned = sanitizeChromeArgs({
    operation: "inspect",
    tabTag: "C2-tab",
    url: "",
    ref: "",
    region: { x: 0, y: 0, width: 0, height: 0 },
    feedback: "none",
    observe: "none",
    action: { action: "wait", button: "left", click_count: 1, delta: 0, delta_x: 0, duration_ms: 0, files: [], frame: 0, key: "Enter", ms: 0, ref: null, selector: "", text: "", to_x: 0, to_y: 0, x: 0, y: 0 },
    actions: [],
    devtools: { clear: false, kind: "all", level: "", limit: 0, query: "", requestId: "" },
    experience: { task: "", steps: [] },
    plan: { task: "", steps: [] },
  });
  assert.deepEqual(cleaned, { operation: "inspect", tabTag: "C2-tab", feedback: "none", observe: "none" });

  const f = fixture(t);
  f.tabs.splice(0, f.tabs.length, { tag: "only", active: true, controllable: true, loading: false });
  const tabs = await f.chrome.execute("owner", ".", {
    operation: "tabs",
    tabTag: "",
    url: "",
    ref: "",
    region: { x: 0, y: 0, width: 0, height: 0 },
    feedback: "none",
    visual: "none",
    action: { action: "wait", button: "left", click_count: 1, ms: 0, x: 0, y: 0 },
    actions: [],
  });
  assert.equal(tabs.tabTag, "only");
  assert.ok(tabs.snapshotId);

  f.chrome.capture = async (o) => ({ screenshot: true, images: [], fullPage: false });
  const shot = await f.chrome.execute("owner", ".", {
    operation: "screenshot",
    tabTag: "only",
    region: { x: 0, y: 0, width: 0, height: 0 },
    ref: "",
  });
  assert.equal(shot.tabTag, "only");
  assert.equal(shot.screenshot, true);

  await assert.rejects(
    f.chrome.feedback("owner", "only", { region: { x: 0, y: 0, width: 40, height: 40 } }, "inspect"),
    /inspect does not accept region\/ref/,
  );
});
