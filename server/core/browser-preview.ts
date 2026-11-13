import type { Chrome } from "./chrome";
import { normalizeAction } from "./browser-actions";
import { assert, httpURL, type Obj } from "./util";

const consumed = new WeakSet<object>();
const screenshotOptions = {
  fullPage: false,
  scope: "viewport",
  maxEdge: 1568,
  maxItems: 1,
  maxTextChars: 0,
  feedback: "screenshot",
};
export const remoteKeys = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Ctrl+A",
  "Ctrl+Z",
  "Ctrl+Y",
];
export async function browserTarget(chrome: Chrome, tabTag: unknown) {
  assert(
    typeof tabTag === "string" && tabTag.length > 0 && tabTag.length <= 200,
    "请从浏览器列表选择标签页",
  );
  assert(
    chrome.bridge.status().connected,
    "浏览器扩展已断开，请刷新标签页列表",
  );
  const { tabs } = await chrome.bridge.request("tabs", {});
  const tab = tabs.find((t: Obj) => t.tag === tabTag);
  assert(tab, "标签页已关闭或浏览器已变化，请刷新列表");
  assert(
    tab.controllable === true && /^(https?:\/\/|about:blank$)/i.test(tab.url),
    "此浏览器页面不可操作，请选择HTTP(S)标签页",
  );
  return tab as Obj;
}
function screenshotResult(observed: Obj, tab: Obj) {
  const image = observed.images?.[0],
    page = observed.pages?.[0];
  return {
    tabTag: observed.tabTag || tab.tag,
    title: page?.title || tab.title,
    url: page?.url || tab.url,
    capturedAt: Date.now(),
    snapshotId: observed.snapshotId,
    editable:
      observed.pages?.some((page: Obj) => page.focus?.editable) === true,
    image: image
      ? { url: image.url, width: image.pixelWidth, height: image.pixelHeight }
      : undefined,
  };
}

export async function browserTabs(chrome: Chrome) {
  return chrome.gate.run(async () => {
    await chrome.bridge.start();
    const status = chrome.bridge.status();
    const tabs: Obj[] = status.connected
      ? (await chrome.bridge.request("tabs", {})).tabs
      : [];
    return {
      ...status,
      tabs: tabs.map(
        ({ tag, title, url, controllable, incognito, active, windowId }) => ({
          tag,
          title,
          url,
          controllable,
          incognito,
          active,
          windowId,
        }),
      ),
    };
  });
}

export async function browserScreenshot(
  chrome: Chrome,
  owner: string,
  tabTag: unknown,
) {
  assert(
    typeof tabTag === "string" && tabTag.length > 0 && tabTag.length <= 200,
    "Choose a tab from the current browser list",
  );
  return chrome.tabGate(tabTag).run(async () => {
    const tab = await browserTarget(chrome, tabTag);
    await chrome.protectTab?.(tab.tag);
    const observed = await chrome.feedback(
      owner,
      tabTag,
      screenshotOptions,
      "screenshot",
    );
    const result = screenshotResult(observed, tab);
    assert(result.image, "浏览器未返回截图，请等待页面加载后刷新");
    return { ...result, image: result.image };
  });
}

export async function browserControl(chrome: Chrome, owner: string, args: Obj) {
  assert(
    args &&
      typeof args === "object" &&
      Object.keys(args).every((key) =>
        ["tabTag", "snapshotId", "action"].includes(key),
      ),
    "远程操作参数无效",
  );
  assert(
    typeof args.snapshotId === "string" &&
      args.snapshotId.length > 0 &&
      args.snapshotId.length <= 200,
    "请刷新截图后操作",
  );
  const raw = args.action;
  assert(
    raw && typeof raw === "object" && !Array.isArray(raw),
    "请选择一种远程操作",
  );
  const navigation = ["goto", "back", "forward", "reload"].includes(raw.action);
  let action: Obj;
  if (navigation) {
    assert(
      Object.keys(raw).every((key) =>
        ["action", ...(raw.action === "goto" ? ["url"] : [])].includes(key),
      ),
      "导航参数无效",
    );
    action = { action: raw.action };
    if (raw.action === "goto") {
      assert(
        typeof raw.url === "string" && raw.url.length <= 8192,
        "请输入HTTP(S)网址",
      );
      action.url = httpURL(raw.url).href;
    }
  } else {
    assert(
      ["click_at", "drag", "scroll_at", "type", "press"].includes(raw.action),
      "不支持此远程操作",
    );
    action = normalizeAction(raw);
    if (action.action === "press")
      assert(remoteKeys.includes(action.key), "不支持此按键");
    if (action.action === "type") assert(action.text.length > 0, "请输入文字");
  }
  return chrome.tabGate(String(args.tabTag)).run(async () => {
    const tab = await browserTarget(chrome, args.tabTag),
      key = owner + ":" + tab.tag,
      o = chrome.observations.get(key);
    await chrome.protectTab?.(tab.tag);
    assert(
      o &&
        o.id === args.snapshotId &&
        Date.now() - o.captured <= 180000 &&
        !consumed.has(o),
      "截图已变化、过期或已经操作过，请刷新截图",
    );
    assert(
      o.screenshot &&
        !o.fullPage &&
        o.images.length === 1 &&
        !o.images[0].readOnlyImage,
      "请使用当前视口截图操作",
    );
    const image = o.images[0];
    for (const [x, y] of action.action === "drag"
      ? [
          [action.x, action.y],
          [action.to_x, action.to_y],
        ]
      : ["click_at", "scroll_at"].includes(action.action)
        ? [[action.x, action.y]]
        : [])
      assert(
        x >= 0 && y >= 0 && x < image.pixelWidth && y < image.pixelHeight,
        "操作位置超出截图",
      );
    const signal = AbortSignal.timeout(30000),
      page = o.pages[0];
    const current = await chrome.evaluate(
      tab.tag,
      o.frames[0],
      `__novaWebview.evaluate("__novaWebview.stamp()",${JSON.stringify(page.document)},${JSON.stringify(page.url)})`,
      signal,
    );
    assert(
      current?.status === "executed" && current.value === page.stamp,
      "网页或视口已变化，请刷新截图后操作",
    );
    if (action.action === "press") {
      for (const [i, frame] of o.frames.entries())
        if (await chrome.frameFocused(o, i)) {
          const focus = await chrome.evaluate(
            tab.tag,
            frame,
            "__novaWebview.inputState()",
            signal,
          );
          assert(
            focus.identity === o.pages[i].focus?.identity,
            "网页焦点已变化，请刷新截图后按键",
          );
        }
    }
    // Consume before sending any input: a lost HTTP response must never replay a click or submission.
    consumed.add(o);
    let result: Obj;
    try {
      result = await chrome.inner(
        owner,
        process.cwd(),
        {
          ...screenshotOptions,
          tabTag: tab.tag,
          snapshotId: o.id,
          imageId: image.imageId,
          ...(navigation
            ? {
                operation: action.action,
                ...(action.url ? { url: action.url } : {}),
                observe: "screenshot",
              }
            : { operation: "act", action }),
        },
        signal,
      );
      if (navigation)
        result = {
          status: "executed",
          inputAttempted: true,
          completedActions: 1,
          ...result,
        };
    } catch (e: any) {
      result = {
        status: "needs_review",
        inputAttempted: true,
        reason: e.message,
      };
      try {
        Object.assign(
          result,
          await chrome.feedback(
            owner,
            tab.tag,
            screenshotOptions,
            "screenshot",
          ),
        );
      } catch (error: any) {
        result.observationError = error.message;
      }
    }
    if (result.inputAttempted) {
      for (const [otherKey, observation] of chrome.observations)
        if (
          !otherKey.startsWith(owner + ":") &&
          [tab.tag, result.tabTag].includes(observation.tabTag)
        )
          chrome.observations.delete(otherKey);
    }
    return {
      ...screenshotResult(result, tab),
      status: result.status,
      inputAttempted: result.inputAttempted,
      reason: result.reason || result.observationError,
      openedTabs: result.openedTabs?.map(
        ({ tag, title, url, controllable, active }: Obj) => ({
          tag,
          title,
          url,
          controllable,
          active,
        }),
      ),
    };
  });
}
