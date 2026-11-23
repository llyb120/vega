import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { normalizeAction } from "../server/core/browser-actions";

test("pointer.up may omit coordinates to release at the held point", () => {
  assert.deepEqual(normalizeAction({ action: "pointer", phase: "up" }), { action: "pointer", phase: "up" });
  assert.deepEqual(
    normalizeAction({ action: "pointer", phase: "up", x: 10, y: 20 }),
    { action: "pointer", phase: "up", x: 10, y: 20 },
  );
  assert.throws(() => normalizeAction({ action: "pointer", phase: "down" }), /Invalid coordinates/);
  assert.throws(() => normalizeAction({ action: "pointer", phase: "move", x: 1 }), /Invalid coordinates/);
});

test("browser-page prepare centers offscreen targets, avoids compact sticky headers, and refuses modal backdrops", async () => {
  const script = readFileSync(new URL("../server/assets/browser/browser-page.js", import.meta.url), "utf8");
  const runHarness = (overlayHeight: number, centerClears: boolean) => {
    let scrollY = 700;
    const scrollCalls: any[] = [];
    const header = {
      nodeType: 1, tagName: "NAV", isConnected: true, outerHTML: "<nav></nav>",
      getAttribute: () => null, hasAttribute: () => false, matches: () => false, closest: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: overlayHeight, width: 1280, height: overlayHeight }),
      getRootNode: () => doc,
    };
    const btn = {
      nodeType: 1, tagName: "BUTTON", isConnected: true, innerText: "团队套餐", tabIndex: 0, disabled: false,
      getAttribute: () => null, hasAttribute: () => false, matches: (sel: string) => /button/i.test(sel), closest: () => null,
      querySelectorAll: () => [],
      getRootNode: () => doc,
      scrollIntoView: (opts: any) => {
        scrollCalls.push(opts);
        // Simulate either centering clearing the header or landing at top still under a sticky header
        scrollY = centerClears && opts?.block === "center" ? 300 : 700;
      },
      getBoundingClientRect() {
        const top = 700 - scrollY;
        return { x: 100, y: top, left: 100, top, right: 200, bottom: top + 36, width: 100, height: 36 };
      },
      getClientRects() { return [this.getBoundingClientRect()]; },
    };
    const doc: any = {
      readyState: "complete", title: "Pricing", body: { innerText: "团队套餐", scrollWidth: 1280, scrollHeight: 3000 },
      documentElement: { scrollWidth: 1280, scrollHeight: 3000 },
      scrollingElement: { scrollLeft: 0, scrollTop: scrollY, scrollWidth: 1280, scrollHeight: 3000, clientWidth: 1280, clientHeight: 800 },
      querySelectorAll: (sel: string) => sel.includes("button") ? [btn] : [],
      createTreeWalker: () => ({ nextNode: () => null }),
      elementFromPoint: (_x: number, y: number) => (y < overlayHeight ? header : btn),
    };
    const sandbox: any = {
      document: doc, location: { href: "https://example.test/pricing" },
      innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, visualViewport: { scale: 1 },
      get scrollX() { return 0; }, get scrollY() { return scrollY; },
      window: { scrollBy: ({ top }: { top: number }) => { scrollY = Math.max(0, scrollY + top); } },
      getComputedStyle: (e: any) => e === header
        ? { position: "fixed", visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible", direction: "ltr" }
        : { position: "static", visibility: "visible", display: "inline-block", overflowX: "visible", overflowY: "visible", direction: "ltr" },
      MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
      NodeFilter: { SHOW_TEXT: 4 },
      CSS: { escape: (s: string) => s },
      performance: { now: () => Date.now() },
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 1),
      setTimeout, clearTimeout, WeakMap, WeakRef, Map, Set, Array, Object, Number, String, Math, Error, Promise, Date, RegExp, JSON,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(script, sandbox);
    const obs = sandbox.__novaWebview.observe("abcdef123456", 20, "all");
    assert.equal(obs.items.length, 1);
    return { api: sandbox.__novaWebview, ref: obs.items[0].ref, scrollCalls };
  };

  // Case 1: centering clears the sticky top header on first scroll
  const centered = runHarness(64, true);
  const p1 = await centered.api.prepare(centered.ref, "click");
  assert.equal(centered.scrollCalls[0]?.block, "center");
  assert.ok(p1.y >= 64);

  // Case 2: even if centering leaves the target under a compact sticky header, scrollBy nudges past the header edge
  const nudged = runHarness(64, false);
  const p2 = await nudged.api.prepare(nudged.ref, "click");
  assert.ok(p2.y >= 64, "second pass nudged past the 64px sticky navbar");

  // Case 3: full-screen modal backdrop (height >= 40% viewport) is NOT bypassed
  const modal = runHarness(600, false);
  await assert.rejects(modal.api.prepare(modal.ref, "click"), /目标被遮挡或在视口之外/);
});
