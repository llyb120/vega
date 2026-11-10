import { test } from "node:test";
import assert from "node:assert/strict";
import { browserOrigins, captureBrowser, restoreBrowser } from "../server/core/browser-handoff";

/** Minimal Chrome double: tabs + the CDP methods the migration uses. */
function fakeChrome(tabs: any[], options: { cookies?: any[]; storage?: { local: any; session: any }; page?: any } = {}) {
  const calls: any[] = [];
  const storage = options.storage || { local: { token: "t" }, session: { step: "2" } };
  const page = options.page || { url: "https://a.test/home", title: "首页", keys: 2, needLogin: false };
  const chrome: any = {
    calls,
    bridge: { request: async () => ({ tabs }) },
    cdp: async (_tag: string, method: string, params: any) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        if (String(params.expression).includes("cut(localStorage)")) return { result: { value: JSON.stringify(storage) } };
        if (String(params.expression).includes("document.readyState")) return { result: { value: true } };
        if (String(params.expression).includes("needLogin")) return { result: { value: JSON.stringify(page) } };
        return { result: { value: true } };
      }
      if (method === "Network.getAllCookies")
        return { result: { cookies: options.cookies || [
          { name: "sid", value: "1", domain: "a.test", path: "/", secure: true, httpOnly: true },
          { name: "foreign", value: "x", domain: "b.test", path: "/" },
        ] } };
      return { result: {} };
    },
  };
  return chrome;
}

test("sites must be http(s) and are normalised to origins", () => {
  assert.deepEqual(browserOrigins(["https://a.test/x/y", "https://a.test/z"]), ["https://a.test"]);
  assert.throws(() => browserOrigins(["ftp://a.test"]), /http/);
  assert.throws(() => browserOrigins(Array.from({ length: 21 }, (_, i) => `https://s${i}.test`)), /最多授权/);
});

test("capture keeps only the authorised origins, cookies included", async () => {
  const chrome = fakeChrome([
    { tag: "t1", url: "https://a.test/home", title: "首页" },
    { tag: "t2", url: "https://b.test/other", title: "别的站点" },
    { tag: "t3", url: "chrome://newtab", title: "新标签页" },
  ]);
  const state = await captureBrowser(chrome, ["https://a.test"], AbortSignal.timeout(5000));
  assert.deepEqual(state.origins, ["https://a.test"]);
  assert.deepEqual(state.pages.map((page) => page.url), ["https://a.test/home"]);
  assert.deepEqual(state.cookies.map((cookie) => cookie.name), ["sid"]);
  assert.deepEqual(state.pages[0].localStorage, { token: "t" });
});

test("capture without configured sites only takes the active site", async () => {
  const chrome = fakeChrome([
    { tag: "t1", url: "https://a.test/home", title: "首页" },
    { tag: "t2", url: "https://b.test/other", title: "别的站点" },
  ]);
  const state = await captureBrowser(chrome, [], AbortSignal.timeout(5000));
  assert.deepEqual(state.origins, ["https://a.test"]);
  assert.match(state.warnings.join(), /只迁移当前活动站点/);
});

test("restore writes cookies and storage, then reports what the page actually shows", async () => {
  const chrome = fakeChrome([{ tag: "t1", url: "https://a.test/home", title: "首页" }]);
  const state = {
    version: 1 as const, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [],
    cookies: [{ name: "sid", value: "1", domain: "a.test", path: "/", secure: true, httpOnly: true }],
    pages: [{ url: "https://a.test/home", title: "首页", localStorage: { token: "t" }, sessionStorage: { step: "2" } }],
  };
  const result = await restoreBrowser(chrome, state, AbortSignal.timeout(5000));
  assert.equal(result.ok, true);
  assert.equal(result.pages[0].needLogin, false);
  assert(result.warnings.length === 0, result.warnings.join());
  assert(chrome.calls.some((call: any) => call.method === "Network.setCookie" && call.params.name === "sid"));
  assert(chrome.calls.some((call: any) => call.method === "Page.navigate" && call.params.url === "https://a.test/home"));
  assert(chrome.calls.some((call: any) => call.method === "Page.reload"));
});

test("a page that still looks like a login form is reported, not called a success", async () => {
  const chrome = fakeChrome([{ tag: "t1", url: "https://a.test/home", title: "首页" }], {
    page: { url: "https://a.test/login", title: "登录", keys: 0, needLogin: true },
  });
  const result = await restoreBrowser(chrome, {
    version: 1, origins: ["https://a.test"], cookies: [], capturedAt: Date.now(), warnings: [],
    pages: [{ url: "https://a.test/home", title: "", localStorage: {}, sessionStorage: {} }],
  }, AbortSignal.timeout(5000));
  assert.equal(result.pages[0].needLogin, true);
  assert.match(result.warnings.join(), /登录/);
});
