import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { normalizeAction } from "../server/core/browser-actions";
import { Store } from "../server/core/store";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import type { Obj } from "../server/core/util";

test("pointer action normalizes down/move/up and rejects bad phase", () => {
  assert.equal(normalizeAction({ action: "pointer", phase: "down", x: 1, y: 2 }).phase, "down");
  assert.equal(normalizeAction({ action: "pointer", phase: "move", x: 3, y: 4, duration_ms: 80 }).duration_ms, 80);
  assert.equal(normalizeAction({ action: "pointer", phase: "up", x: 5, y: 6 }).phase, "up");
  assert.throws(() => normalizeAction({ action: "pointer", x: 1, y: 2 } as any), /phase/);
  assert.throws(() => normalizeAction({ action: "pointer", phase: "hold", x: 1, y: 2 } as any), /phase/);
});

async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), chrome = new Chrome(store, new ChromeBridge(), "");
  t.after(async () => await store.close());
  await store.saveSession({ id: "owner", title: "", cwd: ".", createdAt: 0 });
  const sent: Obj[] = [];
  const page: Obj = {
    url: "https://example.test/", title: "Fixture", document: "doc", stamp: "stamp", text: "ready", visibleText: "ready", frame: 0,
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }, documentSize: { width: 400, height: 300 },
    items: [], focus: {},
  };
  chrome.observe = async (tag) => ({
    id: "snap", tabTag: tag, frames: [{ id: "main", context: 1 }], pages: [structuredClone(page)],
    images: [{ imageId: "image", x: 0, y: 0, width: 400, height: 300, pixelWidth: 400, pixelHeight: 300 }],
    coverageGaps: [], captured: Date.now(), fullPage: false, screenshot: true,
  });
  chrome.bridge.request = async () => ({ tabs: [{ tag: "tab", active: true, controllable: true, loading: false }] });
  chrome.evaluate = async (_tag, _frame, expression) => {
    if (expression.startsWith("__novaWebview.coordinate(")) {
      const [x, y] = JSON.parse(`[${expression.slice("__novaWebview.coordinate(".length, -1)}]`);
      return { x, y, identity: "coordinate", editable: false };
    }
    return {};
  };
  chrome.cdp = async (_tag, method, params = {}) => { sent.push({ method, ...params }); return {}; };
  const o = await chrome.observe("tab");
  chrome.observations.set("owner:tab", o);
  const act = (actions: Obj[]) => chrome.execute("owner", ".", { tabTag: "tab", operation: "act", visual: "none", settleMs: 0, imageId: "image", actions });
  return { chrome, sent, act };
}

test("segmented pointer keeps the button held across chrome_act calls until up", async (t) => {
  const { chrome, sent, act } = await fixture(t);
  const down = await act([{ action: "pointer", phase: "down", x: 40, y: 200 }]);
  assert.equal(down.status, "executed", down.reason);
  assert(chrome.holds.has("tab"));
  assert(sent.some((e) => e.type === "mousePressed" && e.x === 40 && e.y === 200 && e.buttons === 1));

  sent.length = 0;
  const move = await act([{ action: "pointer", phase: "move", x: 120, y: 200, duration_ms: 80 }]);
  assert.equal(move.status, "executed", move.reason);
  assert(!sent.some((e) => e.type === "mouseReleased"), "must not release between segments");
  assert(sent.some((e) => e.type === "mouseMoved" && e.buttons === 1));
  assert.equal(chrome.holds.get("tab")?.x, 120);

  sent.length = 0;
  const blocked = await act([{ action: "click_at", x: 10, y: 10 }]);
  assert.notEqual(blocked.status, "executed");
  assert.match(String(blocked.reason || ""), /分段拖拽|pointer/);
  assert(chrome.holds.has("tab"), "failed interleaved action must not clear the hold");

  sent.length = 0;
  const up = await act([{ action: "pointer", phase: "up", x: 160, y: 200, duration_ms: 80 }]);
  assert.equal(up.status, "executed", up.reason);
  assert.equal(chrome.holds.has("tab"), false);
  assert.deepEqual(sent.at(-1), { method: "Input.dispatchMouseEvent", type: "mouseReleased", x: 160, y: 200, button: "left", clickCount: 1 });
});
