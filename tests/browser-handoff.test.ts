import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { browserOrigins, captureBrowser, injectBrowser, restoreBrowser } from "../server/core/browser-handoff";

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
        if (String(params.expression).includes("let written = 0")) return { result: { value: { written: 2, failed: 0 } } };
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
  const chrome = fakeChrome([{ tag: "t1", url: "https://a.test/home", title: "首页" }], { cookies: [] });
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

test("inject merges cookies and storage into open pages without navigating or reloading", async () => {
  const chrome = fakeChrome([
    { tag: "t1", url: "https://a.test/home", title: "首页" },
    { tag: "t2", url: "https://b.test/other", title: "别的站点" },
  ], { cookies: [] });
  const state = {
    version: 1 as const, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [],
    cookies: [{ name: "sid", value: "1", domain: "a.test", path: "/", secure: true, httpOnly: true }],
    pages: [{ url: "https://a.test/home", title: "首页", localStorage: { token: "t" }, sessionStorage: { step: "2" } }],
  };
  const result = await injectBrowser(chrome, state, AbortSignal.timeout(5000));
  assert.equal(result.ok, true);
  assert(chrome.calls.some((call: any) => call.method === "Network.setCookie" && call.params.name === "sid"));
  assert(chrome.calls.some((call: any) => call.method === "Runtime.evaluate" && String(call.params.expression).includes("setItem")));
  // 按需同步不动用户页签：不导航也不重载。
  assert(!chrome.calls.some((call: any) => call.method === "Page.navigate" || call.method === "Page.reload"));
});

test("inject still writes cookies when the authorised origin has no open tab", async () => {
  const chrome = fakeChrome([{ tag: "t1", url: "https://b.test/other", title: "别的站点" }], { cookies: [] });
  const result = await injectBrowser(chrome, {
    version: 1, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [],
    cookies: [{ name: "sid", value: "1", domain: "a.test", path: "/", secure: true, httpOnly: true }],
    pages: [{ url: "https://a.test/home", title: "", localStorage: { token: "t" }, sessionStorage: {} }],
  }, AbortSignal.timeout(5000));
  assert.equal(result.cookies, 1);
  assert.match(result.warnings.join(), /页签/);
});

test("inject preserves valid target values and retries page storage after about:blank", async () => {
  const tabs = [{ tag: "t1", url: "about:blank" }];
  const cookies = new Map<string, any>([["sid", { name: "sid", value: "current", domain: "a.test", path: "/" }], ["expired", { name: "expired", value: "old", domain: "a.test", path: "/", expires: 1 }]]);
  const local = new Map<string, string>([["token", "current"], ["empty", ""]]), session = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const chrome: any = {
    bridge: { request: async () => ({ tabs }) },
    cdp: async (_tag: string, method: string, params: any) => {
      if (method === "Network.getAllCookies") return { cookies: [...cookies.values()] };
      if (method === "Network.setCookie") { cookies.set(params.name, params); return { success: true }; }
      if (method === "Runtime.evaluate") return { result: { value: vm.runInNewContext(params.expression, { localStorage: storage(local), sessionStorage: storage(session) }) } };
      throw Error("unexpected " + method);
    },
  };
  const state = {
    version: 1 as const, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [],
    cookies: [{ name: "sid", value: "stale", domain: "a.test", path: "/" }, { name: "expired", value: "fresh", domain: "a.test", path: "/" }, { name: "new", value: "new", domain: "a.test", path: "/" }],
    pages: [{ url: "https://a.test/home", title: "", localStorage: { token: "stale", empty: "stale", fresh: "new" }, sessionStorage: { step: "2" } }],
  };
  const first = await injectBrowser(chrome, state, AbortSignal.timeout(5000));
  assert.equal(first.ok, false, "storage must wait until the target opens the site");
  assert.equal(first.cookies, 2, "about:blank can write missing and expired cookies");
  assert.equal(cookies.get("sid").value, "current");
  assert.equal(cookies.get("expired").value, "fresh");
  tabs[0].url = "https://a.test/home";
  const second = await injectBrowser(chrome, state, AbortSignal.timeout(5000));
  assert.equal(second.ok, true);
  assert.equal(second.cookies, 0, "already copied cookies stay untouched");
  assert.equal(local.get("token"), "current");
  assert.equal(local.get("empty"), "", "an empty value is still present");
  assert.equal(local.get("fresh"), "new");
  assert.equal(session.get("step"), "2");
});

test("inject fails closed if existing cookies cannot be read", async () => {
  let writes = 0;
  const chrome: any = { bridge: { request: async () => ({ tabs: [{ tag: "t", url: "about:blank" }] }) }, cdp: async (_tag: string, method: string) => { if (method === "Network.getAllCookies") throw Error("read failed"); writes++; } };
  await assert.rejects(injectBrowser(chrome, { version: 1, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [], cookies: [{ name: "sid", value: "x", domain: "a.test" }], pages: [] }, AbortSignal.timeout(5000)), /read failed/);
  assert.equal(writes, 0);
});

test("capture reads authorised cookies even when the source has only about:blank", async () => {
  const chrome = fakeChrome([{ tag: "t", url: "about:blank" }], { cookies: [{ name: "sid", value: "x", domain: "a.test", path: "/" }, { name: "other", value: "x", domain: "b.test", path: "/" }] });
  const result = await captureBrowser(chrome, ["https://a.test"], AbortSignal.timeout(5000));
  assert.deepEqual(result.cookies.map((cookie) => cookie.name), ["sid"]);
  assert.deepEqual(result.pages, []);
  assert.match(result.warnings.join(), /只能采集 Cookie/);
});

test("capture never turns a partitioned cookie into an unpartitioned login", async () => {
  const chrome = fakeChrome([{ tag: "t", url: "https://a.test/" }], { cookies: [{ name: "p", value: "x", domain: "a.test", partitionKey: { topLevelSite: "https://other.test" } }, { name: "ok", value: "y", domain: "a.test" }] });
  const result = await captureBrowser(chrome, ["https://a.test"], AbortSignal.timeout(5000));
  assert.deepEqual(result.cookies.map((cookie) => cookie.name), ["ok"]);
  assert.match(result.warnings.join(), /分区 Cookie/);
});

test("restore keeps an existing login and only adds missing storage", async () => {
  const cookies = new Map<string, any>([["sid", { name: "sid", value: "current", domain: "a.test", path: "/" }]]);
  const local = new Map<string, string>([["token", "current"]]), session = new Map<string, string>([["step", "old"]]);
  const storage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const chrome: any = {
    bridge: { request: async () => ({ tabs: [{ tag: "t", url: "about:blank" }] }) },
    cdp: async (_tag: string, method: string, params: any) => {
      if (method === "Network.getAllCookies") return { cookies: [...cookies.values()] };
      if (method === "Network.setCookie") { cookies.set(params.name, params); return { success: true }; }
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("document.readyState")) return { result: { value: true } };
        if (params.expression.includes("needLogin")) return { result: { value: JSON.stringify({ url: "https://a.test/", keys: local.size + session.size, needLogin: false }) } };
        return { result: { value: vm.runInNewContext(params.expression, { localStorage: storage(local), sessionStorage: storage(session) }) } };
      }
      return {};
    },
  };
  const result = await restoreBrowser(chrome, {
    version: 1, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [],
    cookies: [{ name: "sid", value: "stale", domain: "a.test", path: "/" }, { name: "new", value: "added", domain: "a.test", path: "/" }],
    pages: [{ url: "https://a.test/", title: "", localStorage: { token: "stale", fresh: "new" }, sessionStorage: { step: "new" } }],
  }, AbortSignal.timeout(5000));
  assert.equal(result.ok, true);
  assert.equal(cookies.get("sid").value, "current");
  assert.equal(cookies.get("new").value, "added");
  assert.equal(local.get("token"), "current");
  assert.equal(local.get("fresh"), "new");
  assert.equal(session.get("step"), "old");
  const alreadyPresent = await restoreBrowser(chrome, {
    version: 1, origins: ["https://a.test"], capturedAt: Date.now(), warnings: [], pages: [],
    cookies: [{ name: "sid", value: "stale", domain: "a.test", path: "/" }],
  }, AbortSignal.timeout(5000));
  assert.equal(alreadyPresent.ok, true, "an already valid target login is not a failure");
});

test("capture marks an unreadable source storage as incomplete", async () => {
  const chrome: any = {
    bridge: { request: async () => ({ tabs: [{ tag: "t", url: "https://a.test/" }] }) },
    cdp: async (_tag: string, method: string) => method === "Network.getAllCookies" ? { cookies: [{ name: "sid", value: "x", domain: "a.test" }] } : { result: {}, exceptionDetails: { text: "denied" } },
  };
  const captured = await captureBrowser(chrome, ["https://a.test"], AbortSignal.timeout(5000));
  assert.equal(captured.incomplete, true);
  assert.match(captured.warnings.join(), /页面存储无法读取/);
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
