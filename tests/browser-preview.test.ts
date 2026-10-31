import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserTabs,
  browserScreenshot,
  browserControl,
} from "../server/core/browser-preview";
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

function controlFixture() {
  const f = fixture(),
    chrome = f.chrome,
    calls: Obj[] = [],
    observations = new Map();
  let serial = 0,
    stamp = "viewport-stamp",
    focus = 7,
    fail = false;
  chrome.observations = observations;
  chrome.feedback = async (owner, tag) => {
    const o = {
      id: "remote-snapshot-" + ++serial,
      tabTag: tag,
      captured: Date.now(),
      screenshot: true,
      fullPage: false,
      frames: [{ id: "root", context: 1 }],
      pages: [
        {
          title: "remote " + tag,
          url: "https://first.test/",
          document: "document",
          stamp: "viewport-stamp",
          focus: { identity: 7, editable: true },
        },
      ],
      images: [
        {
          imageId: "image-" + serial,
          url: "/api/blobs/" + serial,
          pixelWidth: 1000,
          pixelHeight: 600,
        },
      ],
    };
    observations.set(owner + ":" + tag, o);
    return {
      tabTag: tag,
      snapshotId: o.id,
      images: o.images,
      pages: o.pages,
    } as any;
  };
  chrome.evaluate = async (_tag, _frame, expression) =>
    expression.includes("inputState")
      ? { identity: focus, editable: true }
      : { status: "executed", value: stamp };
  chrome.frameFocused = async () => true;
  chrome.inner = async (owner, _cwd, args) => {
    calls.push(args);
    if (fail) throw Error("connection lost after input");
    return {
      status: "executed",
      inputAttempted: true,
      completedActions: 1,
      ...(await chrome.feedback(owner, args.tabTag, {}, "screenshot")),
    };
  };
  return {
    ...f,
    chrome,
    calls,
    observations,
    setStamp: (value: string) => (stamp = value),
    setFocus: (value: number) => (focus = value),
    fail: () => (fail = true),
  };
}
test("remote browser controls use a user-bound snapshot once, serialize with the agent gate, and invalidate other observations only after input", async () => {
  const f = controlFixture(),
    owner = "browser-view:admin",
    shot = await browserScreenshot(f.chrome, owner, "C1-fixture");
  const agent = { id: "agent-old", tabTag: "C1-fixture" };
  f.observations.set("agent:C1-fixture", agent);
  const args = {
    tabTag: shot.tabTag,
    snapshotId: shot.snapshotId,
    action: { action: "click_at", x: 200, y: 100 },
  };
  await assert.rejects(() => browserControl(f.chrome, "another-admin", args));
  assert.equal(f.calls.length, 0);
  assert.equal(f.observations.get("agent:C1-fixture"), agent);
  const results = await Promise.allSettled([
    browserControl(f.chrome, owner, args),
    browserControl(f.chrome, owner, args),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.length, 1);
  assert(!f.observations.has("agent:C1-fixture"));
  assert.equal(f.calls[0].operation, "act");
  assert.equal(f.calls[0].action.action, "click_at");
  assert.equal(f.calls[0].imageId, "image-1");
  const current = f.observations.get(owner + ":C1-fixture");
  const result = await browserControl(f.chrome, owner, {
    tabTag: "C1-fixture",
    snapshotId: current.id,
    action: { action: "type", text: "你好" },
  });
  assert.equal(result.status, "executed");
  assert.equal(result.editable, true);
  assert(result.image);
  assert.equal(f.calls[1].action.text, "你好");
});
test("remote controls reject stale view/focus, protected tabs, invalid pixels, arbitrary scripts and keyboard shortcuts before input", async () => {
  const f = controlFixture(),
    owner = "browser-view:admin",
    shot = await browserScreenshot(f.chrome, owner, "C1-fixture"),
    base = { tabTag: shot.tabTag, snapshotId: shot.snapshotId };
  for (const action of [
    { action: "evaluate", expression: "alert(1)" },
    { action: "upload", selector: "input", files: ["secret"] },
    { action: "press", key: "Ctrl+L" },
    { action: "goto", url: "javascript:alert(1)" },
    { action: "goto", url: "https://user:password@example.test/" },
    { action: "click_at", x: 1000, y: 1 },
    { action: "drag", x: 1, y: 1, to_x: 2, to_y: 600 },
    { action: "scroll_at", x: 2, y: 2, delta: 1201 },
  ])
    await assert.rejects(() =>
      browserControl(f.chrome, owner, { ...base, action }),
    );
  await assert.rejects(() =>
    browserControl(f.chrome, owner, {
      ...base,
      operation: "evaluate",
      action: { action: "press", key: "Enter" },
    }),
  );
  await assert.rejects(() =>
    browserControl(f.chrome, owner, {
      ...base,
      tabTag: "C3-fixture",
      action: { action: "press", key: "Enter" },
    }),
  );
  f.setStamp("moved");
  await assert.rejects(() =>
    browserControl(f.chrome, owner, {
      ...base,
      action: { action: "click_at", x: 2, y: 2 },
    }),
  );
  f.setStamp("viewport-stamp");
  f.setFocus(99);
  await assert.rejects(() =>
    browserControl(f.chrome, owner, {
      ...base,
      action: { action: "press", key: "Enter" },
    }),
  );
  f.setFocus(7);
  f.observations.get(owner + ":C1-fixture").captured = Date.now() - 180001;
  await assert.rejects(() =>
    browserControl(f.chrome, owner, {
      ...base,
      action: { action: "press", key: "Enter" },
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("remote input with an uncertain delivery returns a fresh view without replay; navigation is limited to validated HTTP(S)", async () => {
  const f = controlFixture(),
    owner = "browser-view:admin",
    shot = await browserScreenshot(f.chrome, owner, "C1-fixture");
  const next = await browserControl(f.chrome, owner, {
    tabTag: shot.tabTag,
    snapshotId: shot.snapshotId,
    action: { action: "goto", url: "https://example.test/new" },
  });
  assert.equal(f.calls[0].operation, "goto");
  assert.equal(f.calls[0].url, "https://example.test/new");
  assert.equal(next.status, "executed");
  f.fail();
  const args = {
    tabTag: next.tabTag,
    snapshotId: next.snapshotId,
    action: { action: "press", key: "Enter" },
  };
  const result = await browserControl(f.chrome, owner, args);
  assert.equal(result.status, "needs_review");
  assert.equal(result.inputAttempted, true);
  assert.match(result.reason, /connection lost/);
  assert(result.image);
  await assert.rejects(() => browserControl(f.chrome, owner, args));
  assert.equal(f.calls.length, 2);
});
