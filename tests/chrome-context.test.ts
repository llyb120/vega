import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Chrome, CONTEXT_RETRIES, contextLost } from "../server/core/chrome";
import type { Obj } from "../server/core/util";

/** A fake extension bridge over a fake CDP: `lost` makes the next calls fail as a navigation would. */
function fakeBridge(lost: { evaluate: number; frame: number; iframe?: number }) {
  let world = 0, context = 0;
  const calls: string[] = [];
  const page = (url: string) => ({ url, title: "TAPD", items: [], text: "登录", headings: [], tables: [], document: "d" + world, version: "v" + world,
    viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0, scale: 1 }, documentSize: { width: 800, height: 600 }, frame: 0 });
  const bridge = {
    calls,
    async request(kind: string, params: Obj) {
      if (kind === "tabs") return { tabs: [{ tag: "T1", url: "https://tapd.example/login", loading: false }] };
      if (kind === "goto") return { tabTag: "T1", tabs: [{ tag: "T1", url: params.url, loading: true }] };
      assert.equal(kind, "cdp");
      const { method, params: p, sessionId } = params;
      calls.push(method + (sessionId ? "@" + sessionId : ""));
      if (method === "Page.getFrameTree") return sessionId ? { frameTree: { frame: { id: "IF", parentId: "F" } } } : { frameTree: { frame: { id: "F" } } };
      if (method === "Target.getTargets") return { targetInfos: lost.iframe === undefined ? [] : [{ type: "iframe", targetId: "I" }] };
      if (method === "Target.attachToTarget") return { sessionId: "S" };
      if (method === "Page.createIsolatedWorld") {
        if (sessionId && lost.iframe! > 0) { lost.iframe!--; throw Error('Page.createIsolatedWorld: {"code":-32602,"message":"No frame for given id found"}'); }
        if (!sessionId && lost.frame > 0) { lost.frame--; throw Error('Page.createIsolatedWorld: {"code":-32602,"message":"No frame for given id found"}'); }
        return { executionContextId: (context = ++world) };
      }
      if (method === "Runtime.evaluate") {
        if (!p.contextId) return { result: { value: "complete" } };
        if (lost.evaluate > 0) { lost.evaluate--; throw Error('Runtime.evaluate: {"code":-32000,"message":"Cannot find context with specified id"}'); }
        assert.equal(p.contextId, context, "evaluates in the context just resolved");
        return { result: { value: page("https://tapd.example/login") } };
      }
      throw Error("unexpected " + method);
    },
  };
  return bridge;
}

test("contextLost recognises the CDP errors a navigation causes, not page errors", () => {
  assert(contextLost('Runtime.evaluate: {"code":-32000,"message":"Cannot find context with specified id"}'));
  assert(contextLost("Execution context was destroyed, most likely because of a navigation"));
  assert(contextLost('Page.createIsolatedWorld: {"code":-32602,"message":"No frame for given id found"}'));
  assert(!contextLost("ReferenceError: foo is not defined"));
});

test("chrome_navigate: a context destroyed by the redirect is re-resolved inside the tool, not surfaced", async () => {
  const store = await Store.open(":memory:");
  for (const lost of [{ evaluate: 2, frame: 0 }, { evaluate: 0, frame: 1 }]) {
    const bridge = fakeBridge(lost), chrome = new Chrome(store, bridge as any, "");
    const result = await chrome.execute("browser-view:test", "/tmp", { operation: "goto", tabTag: "T1", url: "https://tapd.example/story", visual: "none" });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.pages[0].url, "https://tapd.example/login");
    assert.deepEqual(result.coverageGaps, []);
    assert(bridge.calls.filter((c) => c === "Page.createIsolatedWorld").length >= 2, "a fresh world after the lost one");
  }
});

test("observe: an iframe replaced right after a click is observed again; a context that never comes back still errors after the bound", async () => {
  const store = await Store.open(":memory:");
  const bridge = fakeBridge({ evaluate: 0, frame: 0, iframe: 1 }), chrome = new Chrome(store, bridge as any, "");
  const o = await chrome.observe("T1");
  assert.deepEqual(o.coverageGaps, [], "the 'No frame for given id found' gap is gone after re-resolving");
  assert.equal(o.pages.length, 2);
  const stuck = fakeBridge({ evaluate: 99, frame: 0 }), broken = new Chrome(store, stuck as any, "");
  await assert.rejects(broken.observe("T1"), /Cannot find context/);
  assert.equal(stuck.calls.filter((c) => c === "Page.getFrameTree").length, CONTEXT_RETRIES, "bounded");
});
