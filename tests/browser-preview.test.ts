import { test } from "node:test";
import assert from "node:assert/strict";
import { browserTabs, browserScreenshot } from "../server/core/browser-preview";
import { Mutex, sleep, type Obj } from "../server/core/util";
import type { Chrome } from "../server/core/chrome";
function fixture() {
  const calls: Obj[] = [],
    tabs = [
      {
        tag: "C1-fixture",
        title: "first",
        url: "https://first.test/",
        active: true,
        incognito: false,
        controllable: true,
        windowId: 1,
      },
      {
        tag: "C2-fixture",
        title: "second",
        url: "https://second.test/",
        active: false,
        incognito: true,
        controllable: true,
        windowId: 2,
      },
      {
        tag: "C3-fixture",
        title: "extensions",
        url: "chrome://extensions",
        active: false,
        incognito: false,
        controllable: false,
        windowId: 1,
      },
    ];
  let connected = true,
    active = 0,
    maximum = 0;
  const chrome = {
    gate: new Mutex(),
    bridge: {
      start: async () => {},
      status: () => ({ connected, browser: "Google Chrome" }),
      request: async (operation: string, args: Obj) => {
        calls.push({ operation, args });
        assert.equal(operation, "tabs");
        return { tabs };
      },
    },
    feedback: async (owner: string, tag: string, args: Obj, mode: string) => {
      calls.push({ owner, tag, args, mode });
      active++;
      maximum = Math.max(maximum, active);
      await sleep(5);
      active--;
      return {
        snapshotId: "snapshot-" + tag,
        images: [
          {
            url: "/api/blobs/image-" + tag,
            pixelWidth: 1440,
            pixelHeight: 900,
          },
        ],
        pages: [
          { title: "current " + tag, url: "https://current.test/" + tag },
        ],
      };
    },
  } as unknown as Chrome;
  return {
    chrome,
    tabs,
    calls,
    disconnect: () => (connected = false),
    get maximum() {
      return maximum;
    },
  };
}
test("browser page lists stable tabs without observing or capturing pages and reports disconnected status", async () => {
  const f = fixture(),
    list = await browserTabs(f.chrome);
  assert.equal(list.connected, true);
  assert.equal(list.tabs.length, 3);
  assert.equal(list.tabs[1].tag, "C2-fixture");
  assert.equal(list.tabs[2].controllable, false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { operation: "tabs", args: {} });
  f.disconnect();
  const disconnected = await browserTabs(f.chrome);
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.tabs.length, 0);
  assert.equal(f.calls.length, 1);
});
test("tab screenshot captures only the chosen stable tag using the shared Chrome gate, without browser input", async () => {
  const f = fixture(),
    result = await browserScreenshot(
      f.chrome,
      "browser-view:admin",
      "C2-fixture",
    );
  assert.equal(result.tabTag, "C2-fixture");
  assert.equal(result.title, "current C2-fixture");
  assert.equal(result.url, "https://current.test/C2-fixture");
  assert.equal(result.image.url, "/api/blobs/image-C2-fixture");
  assert.equal(result.image.width, 1440);
  assert(result.capturedAt <= Date.now());
  assert.equal(f.calls[1].mode, "screenshot");
  assert.equal(f.calls[1].owner, "browser-view:admin");
  assert.equal(f.calls[1].args.fullPage, false);
  assert(
    !f.calls.some((c) =>
      ["act", "select_tab", "goto", "reload", "evaluate"].includes(c.operation),
    ),
  );
  const queued = await Promise.all([
    browserScreenshot(f.chrome, "viewer", "C1-fixture"),
    browserScreenshot(f.chrome, "viewer", "C2-fixture"),
  ]);
  assert.equal(queued[0].tabTag, "C1-fixture");
  assert.equal(f.maximum, 1);
});
test("unknown, protected, closed or disconnected tabs are not captured and actions cannot be supplied", async () => {
  const f = fixture();
  for (const value of [
    undefined,
    "",
    "invented-tag",
    "C3-fixture",
    { tabTag: "C1-fixture", operation: "act" },
  ])
    await assert.rejects(() => browserScreenshot(f.chrome, "owner", value));
  assert(!f.calls.some((c) => c.mode === "screenshot"));
  f.disconnect();
  await assert.rejects(() =>
    browserScreenshot(f.chrome, "owner", "C1-fixture"),
  );
  assert(!f.calls.some((c) => c.mode === "screenshot"));
});
