import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import sharp from "sharp";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Store } from "../server/core/store";
import { bindStep, chains, literalMet, runCandidates, runState, validatePlan } from "../server/core/browser-run";
import { CHROME_TOOL_DEFINITIONS, checkArgs, toInternal } from "../server/core/public-tools";
import type { Obj } from "../server/core/util";

async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), chrome = new Chrome(store, new ChromeBridge(), "");
  t.after(async () => await store.close());
  await store.saveSession({ id: "owner", title: "", cwd: ".", createdAt: 0 });
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
    if (expression.startsWith("__novaWebview.coordinate(")) {
      const [x, y] = JSON.parse(`[${expression.slice("__novaWebview.coordinate(".length, -1)}]`);
      return { x, y, identity: "coordinate", editable: false };
    }
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

test("Chrome intent notes are bounded metadata, never page input or proof of success", async (t) => {
  const f = await fixture(t), schema = CHROME_TOOL_DEFINITIONS.find(tool => tool.name === "chrome_act")!.parameters;
  const actions = [{ action: "click", ref: "save" }];
  const notes = "提交保存；这只是意图，不是成功回执";
  const mapped = toInternal("chrome_act", checkArgs(schema, { tabTag: "tab", notes, actions }), { kind: "normal" }).args;
  assert.equal(mapped.notes, notes);
  await f.observe();
  const result = await f.act(mapped);
  assert.equal(result.notes, notes);
  assert.equal(result.completedActions, 1);
  assert(!JSON.stringify(f.calls).includes(notes));
  assert(!JSON.stringify(f.sent).includes(notes));
  assert.equal((await f.act({ notes: "", actions: [{ action: "wait", ms: 0 }] })).notes, "");
  const count = f.sent.length;
  await assert.rejects(f.act({ notes: "字".repeat(12001), actions }), /notes/);
  await assert.rejects(f.act({ notes: { intent: "no" }, actions }), /notes/);
  assert.throws(() => checkArgs(schema, { tabTag: "tab", notes: "字".repeat(12001), actions }), /notes/);
  assert.equal(f.sent.length, count, "invalid notes cannot send any input");
  await f.observe();
  f.chrome.mouse = async () => { throw Error("fixture input failure"); };
  const failed = await f.act({ notes, actions });
  assert.equal(failed.notes, notes);
  assert.equal(failed.status, "needs_review");
  assert.equal(failed.completedActions, 0);
});

test("navigation invalidates all owners of its tab even without feedback", async (t) => {
  for (const operation of ["goto", "back", "forward", "reload", "close_tab"]) {
    for (const observe of ["none", "inspect"]) {
      const f = await fixture(t), old = await f.observe();
      f.chrome.observations.set("other:tab", old);
      f.chrome.observations.set("owner:unrelated", { ...old, tabTag: "unrelated" });
      const result = await f.chrome.execute("owner", ".", { operation, tabTag: "tab", url: "https://example.test/next", observe, visual: "none" });
      assert(!f.chrome.observations.has("other:tab"), operation);
      assert(f.chrome.observations.has("owner:unrelated"), operation);
      if (observe === "none" || operation === "close_tab") {
        assert(!f.chrome.observations.has("owner:tab"), operation);
        assert.equal(f.sent.length, 0);
      } else {
        assert.notEqual(result.snapshotId, old.id);
        assert.equal(f.chrome.observations.get("owner:tab")!.id, result.snapshotId);
      }
      assert.equal(f.calls.filter(call => call.operation === operation).length, 1);
    }
  }
});

test("after navigation without feedback, evaluate automatically reads the new page without binding it", async (t) => {
  for (const operation of ["goto", "back", "forward", "reload"]) {
    const f = await fixture(t), old = await f.observe();
    await f.chrome.execute("owner", ".", { operation, tabTag: "tab", url: "https://example.test/next", observe: "none" });
    f.page.document = "new-document"; f.page.url = "https://example.test/next";
    const result = await f.chrome.execute("owner", ".", { operation: "evaluate", tabTag: "tab", expression: "1", feedback: "none" });
    assert.equal(result.status, "executed", operation);
    assert.notEqual(result.basedOnSnapshotId, old.id, operation);
    assert(f.calls.some((call) => call.expression?.includes('"new-document"') && call.expression?.includes('"https://example.test/next"')), operation);
    assert(!f.chrome.observations.has("owner:tab"), "automatic reading does not bind an observation");
  }
});

test("automatic reading waits for a new page and never borrows another session's snapshot", async (t) => {
  const f = await fixture(t), old = await f.observe();
  f.chrome.observations.delete("owner:tab"); f.chrome.observations.set("other:tab", old);
  f.tabs[0].loading = true;
  const timer = setTimeout(() => { f.tabs[0].loading = false; f.page.document = "new-document"; }, 150);
  t.after(() => clearTimeout(timer));
  const result = await f.chrome.execute("owner", ".", { operation: "evaluate", tabTag: "tab", expression: "1", feedback: "none" });
  assert.equal(result.status, "executed");
  assert.notEqual(result.basedOnSnapshotId, old.id);
  assert(f.calls.some((call) => call.expression?.includes('"new-document"')));
  assert.equal(f.chrome.observations.get("other:tab"), old);
  assert(!f.chrome.observations.has("owner:tab"));
});

test("a still-loading page and stale refs or screenshot coordinates never send input", async (t) => {
  const f = await fixture(t), old = await f.observe();
  old.screenshot = true; old.images = [{ imageId: "old-image", pixelWidth: 800, pixelHeight: 600 }];
  await f.chrome.execute("owner", ".", { operation: "reload", tabTag: "tab", observe: "none" });
  f.page.items[0].ref = "new-save";
  const oldRef = await f.act({ action: { action: "click", ref: "save" } });
  assert.equal(oldRef.status, "not_executed"); assert.match(oldRef.reason, /ref not found/);
  const oldImage = await f.act({ imageId: "old-image", action: { action: "click_at", x: 20, y: 20 } });
  assert.equal(oldImage.status, "not_executed"); assert.match(oldImage.reason, /旧图片坐标未执行/);
  assert(!f.sent.some((item) => item.action === "click" || item.method?.startsWith("Input.")));
  f.chrome.settleNavigation = async () => [{ tag: "tab", loading: true }];
  await assert.rejects(f.act({ operation: "evaluate", expression: "1", feedback: "none" }), /仍在加载.*未执行/);
});

test("automatic reading refuses incomplete documents even when the tab reports loaded", async (t) => {
  for (const operation of ["act", "evaluate"]) for (const state of ["loading", "interactive"]) {
    const f = await fixture(t), cdp = f.chrome.cdp.bind(f.chrome), settle = f.chrome.settleNavigation.bind(f.chrome);
    let readyState = state, probes = 0, observations = 0;
    f.chrome.cdp = async (tag, method, params: Obj = {}, ...rest) => {
      if (method === "Runtime.evaluate" && params.expression === "document.readyState") {
        probes++;
        return { result: { value: readyState } };
      }
      return cdp(tag, method, params, ...rest);
    };
    f.chrome.settleNavigation = (tag, _ms, signal) => settle(tag, 20, signal);
    const observe = f.chrome.observe.bind(f.chrome);
    f.chrome.observe = async (...args) => { observations++; return observe(...args); };
    const args = { operation, expression: "1", actions: [{ action: "press", key: "Enter" }], feedback: "none" };
    await assert.rejects(f.act(args), /仍在加载.*未执行/, operation + ": " + state);
    assert(probes > 0, "document readiness was checked");
    assert.equal(observations, 0, "an incomplete document is not used as an automatic observation");
    assert.equal(f.sent.length, 0, "no input is sent");
    assert(!f.calls.some((call) => call.expression?.startsWith("__novaWebview.evaluate(")), "the requested script is not evaluated");
    readyState = "complete";
    assert.equal((await f.act(args)).status, "executed", "a later ready document can proceed");
    assert(observations > 0);
    if (operation === "act") assert.equal(f.sent.filter((item) => item.action === "press").length, 1, "the input is sent once after readiness");
    else assert.equal(f.calls.filter((call) => call.expression?.startsWith("__novaWebview.evaluate(")).length, 1, "the script is evaluated once after readiness");
  }
});

test("actions can start without an existing observation", async (t) => {
  const f = await fixture(t);
  const result = await f.act({ action: { action: "press", key: "Enter" } });
  assert.equal(result.status, "executed");
  assert(f.sent.some((item) => item.action === "press" && item.key === "Enter"));
});

test("selecting a tab preserves other owners, and failed navigation does not discard observations", async (t) => {
  const f = await fixture(t), old = await f.observe();
  f.chrome.observations.set("other:tab", old);
  await f.chrome.execute("owner", ".", { operation: "select_tab", tabTag: "tab", observe: "none" });
  assert.equal(f.chrome.observations.get("other:tab"), old);
  f.chrome.bridge.request = async () => { throw Error("navigation rejected"); };
  await assert.rejects(f.chrome.execute("owner", ".", { operation: "goto", tabTag: "tab", url: "https://example.test/next" }), /navigation rejected/);
  assert.equal(f.chrome.observations.get("owner:tab"), old);
  assert.equal(f.chrome.observations.get("other:tab"), old);
});

test("whole-batch preflight rejects unknown refs, uploads and screenshot bounds before any input", async (t) => {
  const f = await fixture(t); const o = await f.observe();
  f.chrome.workspaceFile = async () => { throw Error("Only regular workspace files"); };
  for (const action of [{ action: "click", ref: "invented" }, { action: "upload", selector: "input[type=file]", files: ["outside"] },
    ...[800, -1, NaN, Infinity].map(x => ({ action: "click_at", x, y: 1 })),
    { action: "drag", x: 1, y: 1, to_x: 2, to_y: 600 }]) {
    const r = await f.act({ actions: [{ action: "press", key: "Enter" }, action] });
    assert.equal(r.status, "not_executed"); assert.equal(r.completedActions, 0); assert.equal(r.inputAttempted, false);
  }
  o.screenshot = true; o.images = [{ imageId: "image", pixelWidth: 100, pixelHeight: 100 }];
  const r = await f.act({ imageId: "image", actions: [{ action: "press", key: "Enter" }, { action: "drag", x: 1, y: 1, to_x: 101, to_y: 2 }] });
  assert.equal(r.status, "not_executed"); assert.deepEqual(f.sent, []);
});

test("coordinate actions accept DOM-only observations with missing or stale image IDs", async (t) => {
  for (const imageId of [undefined, "old-image"]) {
    for (const action of [
      { action: "click_at", x: 20, y: 30 },
      { action: "move", x: 20, y: 30 },
      { action: "scroll_at", x: 20, y: 30, delta: 120 },
      { action: "drag", x: 20, y: 30, to_x: 40, to_y: 50, duration_ms: 80 },
    ]) {
      const f = await fixture(t); await f.observe();
      const r = await f.act({ imageId, action });
      assert.equal(r.status, "executed", r.reason); assert.equal(r.completedActions, 1); assert.equal(r.inputAttempted, true);
      assert.deepEqual(f.sent[0], { method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 20, y: 30 });
      if (action.action === "click_at") assert.equal(f.sent[1].action, "click");
      if (action.action === "scroll_at") assert.equal(f.sent[1].deltaY, 120);
      if (action.action === "drag") assert.deepEqual(f.sent.at(-1), {
        method: "Input.dispatchMouseEvent", type: "mouseReleased", x: 40, y: 50, button: "left", clickCount: 1,
      });
    }
  }
});

test("coordinate image IDs are optional hints while image scale and tile offsets are preserved", async (t) => {
  for (const imageId of [undefined, "old-image", "current", "second"]) {
    const f = await fixture(t), o = await f.observe();
    o.screenshot = true; o.fullPage = true;
    o.images = [
      { imageId: "current", x: 100, y: 200, width: 400, height: 300, pixelWidth: 200, pixelHeight: 150 },
      { imageId: "second", x: 500, y: 200, width: 400, height: 300, pixelWidth: 200, pixelHeight: 150 },
    ];
    const r = await f.act({ imageId, action: { action: "click_at", x: 10, y: 20 } });
    assert.equal(r.status, "executed", r.reason);
    const x = imageId === "second" ? 520 : 120;
    assert.deepEqual(f.sent[0], { method: "Input.dispatchMouseEvent", type: "mouseMoved", x, y: 240 });
    assert(f.calls.some(call => call.expression === `__novaWebview.coordinate(${x},240,true)`));
  }
});

test("read-only expanded screenshots still stop a whole coordinate batch before input", async (t) => {
  for (const imageId of [undefined, "old-image", "expanded"]) {
    const f = await fixture(t), o = await f.observe();
    o.screenshot = true;
    o.images = [{ imageId: "expanded", readOnlyImage: true, pixelWidth: 800, pixelHeight: 3000 }];
    const r = await f.act({ imageId, actions: [{ action: "press", key: "Enter" }, { action: "click_at", x: 20, y: 30 }] });
    assert.equal(r.status, "not_executed"); assert.equal(r.inputAttempted, false); assert.equal(r.completedActions, 0);
    assert.match(r.reason, /read-only/); assert.deepEqual(f.sent, []);
  }
});

test("a new child tab ends a batch; only a unique active child receives feedback", async (t) => {
  const f = await fixture(t); await f.observe();
  f.chrome.key = async (_tag, key) => { f.sent.push({ key }); f.tabs.push({ tag: "child", openerTag: "tab", active: true, controllable: true }); };
  const r = await f.act({ actions: [{ action: "press", key: "Enter" }, { action: "press", key: "Tab" }] });
  assert.equal(r.completedActions, 1); assert.equal(r.status, "needs_review"); assert.equal(r.tabTag, "child"); assert.equal(r.sourceTabTag, "tab");
  assert.deepEqual(f.sent, [{ key: "Enter" }]);
});

test("ambiguous or background children return inventory without recapturing the source", async (t) => {
  for (const multiple of [false, true]) {
    const f = await fixture(t); await f.observe(); let observed = 0;
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
  const f = await fixture(t); await f.observe();
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
  const f = await fixture(t); await f.observe(); let scripts = 0;
  f.chrome.evaluate = async () => { scripts++; throw Error("script failed after input"); };
  const r = await f.act({ operation: "evaluate", expression: "throw Error('fail')" });
  assert.equal(r.status, "needs_review"); assert.equal(r.inputAttempted, true); assert.equal(scripts, 1);
  f.chrome.observe = async () => { throw Error("renderer unavailable"); };
  const clicked = await f.act({ action: { action: "press", key: "Enter" } });
  assert.equal(clicked.status, "executed"); assert.equal(clicked.completedActions, 1); assert.match(clicked.observationError, /renderer unavailable/);
});

test("evaluate applies a CDP deadline and an independent bounded wait", async (t) => {
  const f = await fixture(t); let params: Obj = {}, calls = 0;
  f.chrome.cdp = async (_tag, _method, args) => { calls++; params = args!; return new Promise(() => {}); };
  await assert.rejects(Chrome.prototype.evaluate.call(f.chrome, "tab", { id: "main", context: 1 }, "new Promise(()=>{})", undefined, 20), /超时.*不要重放/);
  assert.equal(params.timeout, 20); assert.equal(params.awaitPromise, true); assert.equal(calls, 1);
});

test("guided runs wait for when/expect evidence without repeating input and match URL/title", async (t) => {
  const f = await fixture(t); f.page.text = f.page.visibleText = "loading"; await f.observe();
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
    const f = await fixture(t); await f.observe();
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
  const f = await fixture(t); f.page.items.push({ ref: "city", nodeId: "city", name: "City", role: "textbox", editable: true, inView: true }); await f.observe();
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
  const f = await fixture(t); await f.observe();
  await assert.rejects(f.run([{ action: "click", name: "Save" }, { action: "fill", name: "Email" }]), /fill requires text/);
  assert.equal(f.sent.length, 0);
  f.chrome.inner = async () => { f.sent.push({ uncertain: true }); return { status: "needs_review", inputAttempted: true, completedActions: 0, reason: "unknown" }; };
  const r = await f.run([{ action: "click", name: "Save" }]);
  assert.equal(r.altairRun.status, "needs_review"); assert.equal(f.sent.length, 1);
});

test("run resumes after a partial DOM preflight failure without replaying the completed fill", async (t) => {
  const f = await fixture(t); f.page.items.push({ ref: "city", nodeId: "city", name: "City", role: "textbox", editable: true, inView: true }); await f.observe();
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
  const f = await fixture(t), captures: Obj[] = [], layouts: string[] = [];
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

test("explicit screenshots return images even with the compatible visual=none flag", async (t) => {
  const f = await screenshotFixture(t), schema = CHROME_TOOL_DEFINITIONS.find(tool => tool.name === "chrome_screenshot")!.parameters;
  for (const visual of [undefined, "auto", "none"]) {
    const args = { tabTag: "tab", capture: { kind: "viewport" }, maxItems: 3, maxTextChars: 60, ...(visual ? { visual } : {}) };
    const mapped = toInternal("chrome_screenshot", checkArgs(schema, args), { kind: "normal" }).args;
    const result = await f.chrome.execute("owner", ".", mapped);
    assert.equal(result.images.length, 1, String(visual));
    assert(result.images[0].path && result.snapshotId);
    assert.equal(f.chrome.observations.get("owner:tab")!.screenshot, true);
  }
  const inspect = await f.chrome.execute("owner", ".", { operation: "inspect", tabTag: "tab", visual: "none" });
  assert.deepEqual(inspect.images, [], "visual=none still skips optional screenshots on inspect");
  assert.equal(f.captures.filter((call) => call.method === "Page.captureScreenshot").length, 3);
});

test("unchanged screenshots detect small pixel changes and keep frame streams separate", async (t) => {
  const f = await screenshotFixture(t, 640, 480);
  Object.assign(f.page.viewport, { width: 640, height: 480 });
  const white = await sharp({ create: { width: 640, height: 480, channels: 3, background: "white" } }).png().toBuffer();
  let pixels = white;
  const raw = f.chrome.cdp;
  f.chrome.cdp = async (...args) => args[1] === "Page.captureScreenshot" ? { data: pixels.toString("base64") } : raw(...args);
  const first = await f.observe(); await f.chrome.capture("owner", first, {});
  // Screenshots are files in the owner session's directory, served under /api/files.
  assert.equal(first.images[0].path, join(f.store.files.dir(await f.store.session("owner")), first.images[0].imageId + ".webp"));
  assert.equal(first.images[0].url, f.store.files.url(first.images[0].path));
  assert.equal((await sharp(await f.store.files.read(first.images[0].path)).metadata()).format, "webp");
  const same = await f.observe(); await f.chrome.capture("owner", same, {}, first);
  assert.equal(same.images[0].unchanged, true);
  assert.equal(same.images[0].path, first.images[0].path);
  for (const [value, unchanged] of [[239, true], [238, false], [0, false]] as const) {
    const patch = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: value, g: value, b: value } } }).png().toBuffer();
    pixels = await sharp(white).composite([{ input: patch, left: 100, top: 100 }]).png().toBuffer();
    const next = await f.observe(); await f.chrome.capture("owner", next, {}, first);
    assert.equal(next.images[0].unchanged, unchanged, `pixel delta ${255 - value}`);
    assert.equal(next.images[0].path === first.images[0].path, unchanged);
  }
  pixels = white;
  const full = await f.observe(); await f.chrome.capture("owner", full, { fullPage: true }, first);
  assert.equal(full.images[0].frameStream, "tab:document:0");
  assert.equal(full.images[0].unchanged, false);
  const fullAgain = await f.observe(); await f.chrome.capture("owner", fullAgain, { fullPage: true }, full);
  assert.equal(fullAgain.images[0].unchanged, true);
  for (const args of [{ region: { x: 0, y: 0, width: 640, height: 480 } }, { expandScroll: true }]) {
    const standalone = await f.observe(); await f.chrome.capture("owner", standalone, args, first);
    assert.equal(standalone.images[0].frameStream, undefined);
    assert.equal(standalone.images[0].unchanged, false);
  }
  f.page.document = "new-document";
  const navigated = await f.observe(); await f.chrome.capture("owner", navigated, {}, first);
  assert.equal(navigated.images[0].unchanged, false);
  // The browser view overwrites one file per tab; each new frame gets a new address.
  const live1 = await f.observe(); await f.chrome.capture("browser-view:u", live1, {});
  pixels = await sharp({ create: { width: 640, height: 480, channels: 3, background: "black" } }).png().toBuffer();
  const live2 = await f.observe(); await f.chrome.capture("browser-view:u", live2, {}, live1);
  assert.equal(live2.images[0].path, live1.images[0].path);
  assert.equal(live2.images[0].path, join(f.store.files.dir("browser-view:u"), "live-tab-0.webp"));
  assert.notEqual(live2.images[0].url, live1.images[0].url);
  assert.equal(live2.images[0].url, f.store.files.url(live2.images[0].path) + "?v=" + live2.id);
  const raw2 = await sharp(await f.store.files.read(live2.images[0].path)).raw().toBuffer();
  assert.equal(raw2[0], 0, "the file holds the latest frame");
});

test("expanded scroll retains original pixels and remains read-only; ordinary images stay bounded", async (t) => {
  const f = await screenshotFixture(t);
  let o = await f.observe();
  const result = await f.chrome.capture("owner", o, { expandScroll: true });
  assert.equal(o.images[0].pixelHeight, 3000); assert.equal(o.images[0].pixelWidth, 800); assert.equal(o.images[0].readOnlyImage, true);
  assert(result.screenshotComplete); assert(f.layouts.includes("__novaWebview.captureLayout(false)"));
  o = await f.observe(); await f.chrome.capture("owner", o, { fullPage: true });
  assert(o.images[0].pixelHeight <= 1568);
});

test("full-page screenshots paginate both axes and fall back before unsafe renderer capture", async (t) => {
  const f = await screenshotFixture(t, 5000, 9000), o = await f.observe();
  const r = await f.chrome.capture("owner", o, { fullPage: true });
  assert.equal(r.totalTiles, 9); assert.equal(r.nextTile, 4); assert.equal(o.images.length, 4); assert.equal(r.screenshotComplete, false);
  assert.equal(o.images[1].x, 2048); assert.equal(o.images[3].y, 4096);
  f.page.documentSize = { width: 20000, height: 500 };
  const unsafe = await f.observe(); const fallback = await f.chrome.capture("owner", unsafe, { fullPage: true });
  assert.equal(fallback.fullPage, false); assert.match(fallback.fullPageFallback!, /安全上限/);
  assert(f.captures.filter((c) => c.clip).every((c) => c.clip.width <= 2048));
});

test("viewport crops keep viewport coordinates after scrolling; restoration runs after failed capture", async (t) => {
  const f = await screenshotFixture(t); f.page.viewport.scrollY = 500;
  const o = await f.observe(); await f.chrome.capture("owner", o, { region: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(o.images[0].y, 0); assert.equal(f.captures.find((c) => c.clip)!.clip.y, 500);
  const raw = f.chrome.cdp; let attempts = 0;
  f.chrome.cdp = async (...args) => {
    if (args[1] === "Page.captureScreenshot" && args[2]?.captureBeyondViewport) { attempts++; throw Error("capture failed"); }
    return raw(...args);
  };
  await assert.rejects(f.chrome.capture("owner", await f.observe(), { fullPage: true }), /capture failed/);
  assert.equal(attempts, 1); assert.equal(f.layouts.at(-1), "__novaWebview.captureLayout(false)");
  assert(f.captures.some((c) => c.method === "Page.captureScreenshot" && c.captureBeyondViewport === false));
});

test("run does not treat tooltip/ref changes as progress and never blindly repeats a step", async (t) => {
  const f = await fixture(t); await f.observe();
  const before = runState([f.page]); f.page.visibleText += " tooltip"; f.page.items[0].ref = "fresh-save";
  assert.equal(runState([f.page]), before);
  await f.observe();
  f.chrome.mouse = async () => { f.sent.push({ action: "click" }); f.page.visibleText += " new tooltip"; };
  const r = await f.run([{ action: "click", name: "Save", expect: "never appears", repeat: 1 }]);
  assert.equal(r.altairRun.status, "needs_review");
  assert.equal(f.sent.filter((v) => v.action === "click").length, 1);
});

test("run when failure waits without input; expectation failure keeps completed actions out of remaining steps", async (t) => {
  const f = await fixture(t); await f.observe();
  const blocked = await f.run([{ action: "click", name: "Save", when: "absent" }]);
  assert.equal(blocked.altairRun.guided.completedSteps, 0); assert.equal(f.sent.length, 0);
  assert(blocked.altairRun.checks[0].ms >= 3000);
  const after = await f.run([{ action: "click", name: "Save", expect: "absent" }, { action: "press", key: "Enter" }]);
  assert.equal(after.altairRun.guided.completedSteps, 1); assert.equal(after.altairRun.guided.remainingSteps[0].action, "press");
  assert.equal(f.sent.filter((v) => v.action === "click").length, 1);
  assert(after.altairRun.checks[0].ms >= 6000);
});

test("run explicit repeat rebinds only after a changed state and observes its budget", async (t) => {
  const f = await fixture(t); f.page.items[0].sort = "none"; await f.observe();
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
  const r = await f.chrome.capture("owner", await f.observe(), { expandScroll: true });
  assert.equal(height, 600); assert.equal(r.scrollExpanded?.complete, false);
  assert(f.captures.some((c) => c.method === "Emulation.setDeviceMetricsOverride"));
  assert(f.captures.some((c) => c.method === "Emulation.clearDeviceMetricsOverride"));
});

test("failed optional screenshots preserve DOM while explicit screenshots report failure", async (t) => {
  const f = await fixture(t); f.chrome.capture = async () => { throw Error("capture failed"); };
  const r: Obj = await f.chrome.feedback("owner", "tab", {});
  assert(r.pages[0].items.length); assert.equal(r.screenshotError, "capture failed"); assert.equal(f.chrome.observations.get("owner:tab")!.screenshot, false);
  await assert.rejects(f.chrome.feedback("owner", "tab", {}, "screenshot"), /capture failed/);
});


test("inspect still rejects region/ref; screenshot validates region strictly", async (t) => {
  const f = await fixture(t);
  f.tabs.splice(0, f.tabs.length, { tag: "only", active: true, controllable: true, loading: false });
  await assert.rejects(
    f.chrome.feedback("owner", "only", { region: { x: 0, y: 0, width: 40, height: 40 } }, "inspect"),
    /inspect does not accept region\/ref/,
  );
  await assert.rejects(
    f.chrome.execute("owner", ".", { operation: "screenshot", tabTag: "only", region: { x: 0, y: 0, width: 0, height: 0 } }),
    /Invalid screenshot region/,
  );
});

test("navigation waits while the document is still loading, bounded, and reports tabs after settling", async (t) => {
  const f = await fixture(t);
  let probes = 0;
  f.chrome.cdp = async (_tag, method, params: Obj = {}) => {
    if (method === "Runtime.evaluate" && params.expression === "document.readyState") return { result: { value: ++probes < 3 ? "interactive" : "complete" } };
    return {};
  };
  f.chrome.bridge.request = async (operation) => {
    f.calls.push({ operation });
    if (operation === "goto") return { tabTag: "tab", tabs: [{ tag: "tab", title: "old page", loading: true }] };
    return { tabs: [{ tag: "tab", title: "new page", loading: false }] };
  };
  const result = await f.chrome.execute("owner", ".", { operation: "goto", tabTag: "tab", url: "https://example.test/next", visual: "none" });
  assert.equal(probes, 3, "waits until readyState is complete");
  assert.deepEqual(result.tabs, [{ tag: "tab", title: "new page", loading: false }], "tabs are the post-settle list, not the navigation-start one");

  // A page that never completes (long polling, streaming) returns at the settleMs bound.
  f.chrome.cdp = async () => ({ result: { value: "interactive" } });
  const started = Date.now();
  await f.chrome.execute("owner", ".", { operation: "goto", tabTag: "tab", url: "https://example.test/stream", visual: "none", settleMs: 300 });
  const took = Date.now() - started;
  assert(took >= 280 && took < 1500, `bounded wait, took ${took}ms`);

  // A tab stuck in loading is bounded the same way.
  f.chrome.bridge.request = async (operation) => operation === "goto" ? { tabTag: "tab" } : { tabs: [{ tag: "tab", loading: true }] };
  const again = Date.now();
  await f.chrome.execute("owner", ".", { operation: "reload", tabTag: "tab", visual: "none", settleMs: 200 });
  assert(Date.now() - again < 1500);
});
