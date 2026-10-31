import type { Chrome } from "./chrome";
import { assert, type Obj } from "./util";

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
  return chrome.gate.run(async () => {
    assert(
      chrome.bridge.status().connected,
      "Browser extension disconnected; refresh the tab list",
    );
    const { tabs } = await chrome.bridge.request("tabs", {});
    const tab = tabs.find((t: Obj) => t.tag === tabTag);
    assert(tab, "Tab was closed or the browser changed; refresh the tab list");
    assert(
      tab.controllable === true && /^(https?:\/\/|about:blank$)/i.test(tab.url),
      "This browser page does not allow screenshots; choose an HTTP(S) tab",
    );
    const observed = await chrome.feedback(
      owner,
      tabTag,
      {
        fullPage: false,
        scope: "viewport",
        maxEdge: 1568,
        maxItems: 1,
        maxTextChars: 0,
      },
      "screenshot",
    );
    const image = observed.images[0],
      page = observed.pages[0] as Obj | undefined;
    assert(
      image,
      "Browser returned no screenshot; refresh the tab after it has loaded",
    );
    return {
      tabTag,
      title: page?.title || tab.title,
      url: page?.url || tab.url,
      capturedAt: Date.now(),
      snapshotId: observed.snapshotId,
      image: {
        url: image.url,
        width: image.pixelWidth,
        height: image.pixelHeight,
      },
      notice:
        "Static viewport screenshot, not a live stream. Capturing a background or minimized Chrome window may bring it to the foreground; no page click or keyboard input is sent.",
    };
  });
}
