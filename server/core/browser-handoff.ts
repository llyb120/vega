/**
 * 登录态迁移：只搬任务授权站点上的 Cookie 与页面存储，不复制用户整个浏览器。
 * 复制 Cookie 不等于登录成功：恢复后必须打开页面核对实际结果，失败要如实报告。
 */
import type { Chrome } from "./chrome";
import { assert, type Obj } from "./util";

const MAX_SITES = 20;
const MAX_PAGES = 10;
const MAX_COOKIES = 500;
const MAX_KEYS = 200;
const MAX_VALUE = 8 << 10;

export type BrowserState = {
  version: 1;
  origins: string[];
  cookies: Obj[];
  pages: { url: string; title: string; localStorage: Record<string, string>; sessionStorage: Record<string, string> }[];
  capturedAt: number;
  warnings: string[];
};
export type BrowserRestore = { ok: boolean; pages: { url: string; title: string; needLogin: boolean; storage: number }[]; warnings: string[] };
export type BrowserSync = { ok: boolean; cookies: number; storage: number; warnings: string[] };

/** Authorised sites, normalised to origins; anything else never leaves the browser. */
export function browserOrigins(value: unknown): string[] {
  assert(Array.isArray(value) && value.length <= MAX_SITES, `最多授权 ${MAX_SITES} 个站点`);
  const origins = value.map((item) => {
    let url: URL;
    try { url = new URL(String(item)); } catch { throw Error("站点必须是 http(s) 地址：" + String(item)); }
    assert(url.protocol === "https:" || url.protocol === "http:", "只支持 http(s) 站点");
    return url.origin;
  });
  return [...new Set(origins)];
}

const unwrap = (value: any) => value?.result ?? value ?? {};const originOf = (url: unknown) => { try { return new URL(String(url)).origin; } catch { return ""; } };
const httpTab = (tabs: Obj[]) => (tabs || []).filter((tab) => /^https?:/i.test(String(tab?.url || "")));

/** Cookies and storages of the authorised origins currently open in this browser. */
export async function captureBrowser(chrome: Chrome, origins: string[], signal: AbortSignal): Promise<BrowserState> {
  const warnings: string[] = [];
  const { tabs } = (await chrome.bridge.request("tabs", {}, signal)) as Obj;
  let allowed = new Set(browserOrigins(origins));
  if (!allowed.size) {
    // 未配置迁移站点时只拿任务当前所在的站点，不把用户的其它站点一并带走。
    const active = httpTab(tabs || []).find((tab) => tab.active) || httpTab(tabs || [])[0];
    const origin = originOf(active?.url);
    if (!origin) throw Error("本机浏览器没有可迁移的 http(s) 页面");
    allowed = new Set([origin]);
    warnings.push("未配置迁移站点，只迁移当前活动站点：" + origin);
  }
  const open = httpTab(tabs || []).filter((tab) => allowed.has(originOf(tab.url))).slice(0, MAX_PAGES);
  if (!open.length) throw Error("授权站点上没有打开的页面，无法读取登录态；请先在这些站点登录并保持页签打开");

  const pages: BrowserState["pages"] = [];
  for (const tab of open) {
    const storage = await chrome.cdp(tab.tag, "Runtime.evaluate", {
      expression: `(() => { const cut = (input) => Object.fromEntries(Object.entries(input).slice(0, ${MAX_KEYS}).map(([k, v]) => [k, String(v).slice(0, ${MAX_VALUE})])); return JSON.stringify({ local: cut(localStorage), session: cut(sessionStorage) }); })()`,
      returnByValue: true,
    }, undefined, signal);
    let parsed: Obj = {};
    try { parsed = JSON.parse(unwrap(storage).value || "{}"); } catch { warnings.push("页面存储无法读取：" + tab.url); }
    pages.push({ url: String(tab.url), title: String(tab.title || ""), localStorage: parsed.local || {}, sessionStorage: parsed.session || {} });
  }

  const cookies: Obj[] = [];
  const seen = new Set<string>();
  for (const tab of open) {
    const raw = unwrap(await chrome.cdp(tab.tag, "Network.getAllCookies", {}, undefined, signal));
    for (const cookie of raw.cookies || []) {
      const domain = String(cookie.domain || "").replace(/^\./, "");
      if (!domain || ![...allowed].some((origin) => { const host = new URL(origin).hostname; return host === domain || host.endsWith("." + domain); })) continue;
      const key = [cookie.name, cookie.domain, cookie.path].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      if (cookies.length >= MAX_COOKIES) throw Error(`Cookie 数量超过上限 ${MAX_COOKIES}，请缩小授权站点范围`);
      cookies.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || "/", secure: !!cookie.secure, httpOnly: !!cookie.httpOnly, sameSite: cookie.sameSite, expires: cookie.expires });
    }
  }
  if (!cookies.length && !pages.some((page) => Object.keys(page.localStorage).length)) warnings.push("没有读到可迁移的 Cookie 或页面存储");
  return { version: 1, origins: [...allowed], cookies, pages, capturedAt: Date.now(), warnings };
}

/** Put the state into this browser, then verify what the pages actually show. */
export async function restoreBrowser(chrome: Chrome, state: BrowserState, signal: AbortSignal): Promise<BrowserRestore> {
  assert(state?.version === 1 && Array.isArray(state.pages) && Array.isArray(state.cookies), "登录态数据无效");
  const warnings: string[] = [...(state.warnings || [])];
  const { tabs } = (await chrome.bridge.request("tabs", {}, signal)) as Obj;
  const target = httpTab(tabs || []).find((tab) => state.origins.includes(originOf(tab.url))) || httpTab(tabs || [])[0];
  if (!target) throw Error("目标浏览器没有可用页签，无法写入登录态；请先在云端打开一个页面");

  let applied = 0;
  for (const cookie of state.cookies.slice(0, MAX_COOKIES)) {
    const params: Obj = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || "/", secure: !!cookie.secure, httpOnly: !!cookie.httpOnly };
    if (cookie.sameSite) params.sameSite = cookie.sameSite;
    if (typeof cookie.expires === "number" && cookie.expires > 0) params.expires = cookie.expires;
    try { await chrome.cdp(target.tag, "Network.setCookie", params, undefined, signal); applied++; }
    catch (error: any) { warnings.push(`Cookie ${cookie.name} 写入失败：${String(error?.message || error).slice(0, 120)}`); }
  }

  const pages: BrowserRestore["pages"] = [];
  for (const page of state.pages.slice(0, MAX_PAGES)) {
    try {
      await chrome.cdp(target.tag, "Page.navigate", { url: page.url }, undefined, signal);
      await waitReady(chrome, target.tag, signal);
      await chrome.cdp(target.tag, "Runtime.evaluate", {
        expression: `(() => { const put = (store, data) => { for (const [k, v] of Object.entries(data || {})) { try { store.setItem(k, v); } catch {} } }; put(localStorage, ${JSON.stringify(page.localStorage)}); put(sessionStorage, ${JSON.stringify(page.sessionStorage)}); return true; })()`,
        returnByValue: true,
      }, undefined, signal);
      await chrome.cdp(target.tag, "Page.reload", {}, undefined, signal);
      await waitReady(chrome, target.tag, signal);
      const check = unwrap(await chrome.cdp(target.tag, "Runtime.evaluate", {
        expression: `JSON.stringify({ url: location.href, title: document.title, keys: Object.keys(localStorage).length + Object.keys(sessionStorage).length, needLogin: !!document.querySelector('input[type=password]') || /(login|signin|sso|登录|扫码登录)/i.test(location.href + ' ' + document.title) })`,
        returnByValue: true,
      }, undefined, signal));
      const value = JSON.parse(unwrap(check).value || "{}");
      pages.push({ url: value.url || page.url, title: value.title || "", needLogin: !!value.needLogin, storage: Number(value.keys || 0) });
      if (value.needLogin) warnings.push(`${page.url} 恢复后仍像登录页，可能需要用户重新登录或二次验证`);
    } catch (error: any) {
      warnings.push(`${page.url} 恢复失败：${String(error?.message || error).slice(0, 150)}`);
      pages.push({ url: page.url, title: page.title, needLogin: true, storage: 0 });
    }
  }
  const ok = applied > 0 || pages.some((page) => page.storage > 0);
  if (!ok) warnings.push("没有写入任何 Cookie 或页面存储");
  // 恢复后的页面停留在授权站点上，让下一次观察直接看到真实结果。
  return { ok, pages, warnings };
}

async function waitReady(chrome: Chrome, tag: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (signal.aborted) return;
    const ready = unwrap(await chrome.cdp(tag, "Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, undefined, signal));
    if (ready.value === true) return;
  }
}

/**
 * 按需补齐登录态（多退少补）：把 Cookie 写进目标浏览器，并向已打开的授权站点页补 localStorage/sessionStorage。
 * 只增不删、不导航也不重载：与 restoreBrowser 的整页迁移不同，这里不动用户页签。
 * storage 是 per-origin 的，目标端没打开该源页签时跳过这部分（Cookie 已写入，下次打开自动带）。
 */
export async function injectBrowser(chrome: Chrome, state: BrowserState, signal: AbortSignal): Promise<BrowserSync> {
  assert(state?.version === 1 && Array.isArray(state.pages) && Array.isArray(state.cookies), "登录态数据无效");
  const warnings: string[] = [...(state.warnings || [])];
  const { tabs } = (await chrome.bridge.request("tabs", {}, signal)) as Obj;
  const allowed = new Set(state.origins);
  const open = httpTab(tabs || []).filter((tab) => allowed.has(originOf(tab.url)));
  if (!open.length) {
    // 目标端一个授权站点页都没打开：Cookie 仍要写，借任意一个页签设进 jar（setCookie 按 domain 生效，不看当前页）。
    const any = httpTab(tabs || [])[0];
    if (!any) { warnings.push("目标浏览器没有可用页签"); return { ok: false, cookies: 0, storage: 0, warnings }; }
    open.push(any);
  }

  let cookies = 0;
  for (const cookie of state.cookies.slice(0, MAX_COOKIES)) {
    const params: Obj = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || "/", secure: !!cookie.secure, httpOnly: !!cookie.httpOnly };
    if (cookie.sameSite) params.sameSite = cookie.sameSite;
    if (typeof cookie.expires === "number" && cookie.expires > 0) params.expires = cookie.expires;
    try { await chrome.cdp(open[0].tag, "Network.setCookie", params, undefined, signal); cookies++; }
    catch (error: any) { warnings.push(`Cookie ${cookie.name} 写入失败：${String(error?.message || error).slice(0, 120)}`); }
  }

  // 页面存储按源页 origin 写进目标端同源的已开页签；setItem 只补不删。
  let storage = 0;
  for (const page of state.pages.slice(0, MAX_PAGES)) {
    const origin = originOf(page.url);
    const tab = open.find((item) => originOf(item.url) === origin);
    if (!tab) { warnings.push(`${origin} 的目标浏览器没有打开的页签，页面存储未同步（Cookie 已写入）`); continue; }
    try {
      const result = unwrap(await chrome.cdp(tab.tag, "Runtime.evaluate", {
        expression: `(() => { let n = 0; const put = (store, data) => { for (const [k, v] of Object.entries(data || {})) { try { store.setItem(k, v); n++; } catch {} } }; put(localStorage, ${JSON.stringify(page.localStorage)}); put(sessionStorage, ${JSON.stringify(page.sessionStorage)}); return n; })()`,
        returnByValue: true,
      }, undefined, signal));
      storage += Number(result.value || 0);
    } catch (error: any) { warnings.push(`${origin} 页面存储写入失败：${String(error?.message || error).slice(0, 120)}`); }
  }
  const ok = cookies > 0 || storage > 0;
  if (!ok) warnings.push("没有写入任何 Cookie 或页面存储");
  return { ok, cookies, storage, warnings };
}
