import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { injectBrowser, restoreBrowser } from "../server/core/browser-handoff";

test("real Chrome retains its existing cookie and storage during both handoff paths", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-browser-handoff-"));
  const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<title>handoff fixture</title>"); });
  const binary = process.env.VEGA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = spawn(binary, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--remote-debugging-port=0", "--user-data-dir=" + dir, "about:blank"], { stdio: "ignore", windowsHide: true });
  let ws: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const site = `http://127.0.0.1:${(server.address() as any).port}/`, origin = new URL(site).origin;
    let port = "";
    for (let attempt = 0; attempt < 160 && !port; attempt++) {
      try { port = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await sleep(50); }
    }
    assert(port, "fixture Chrome did not start");
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
    ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()), request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
    });
    const command = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + " timeout")); }, 5000);
      pending.set(id, { resolve, reject, timer });
      ws!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await command("Network.enable");
    await command("Network.setCookie", { url: site, name: "sid", value: "target" });
    const tab = { tag: "fixture", url: "about:blank" };
    const chrome: any = { bridge: { request: async () => ({ tabs: [tab] }) }, cdp: async (_tag: string, method: string, params: any) => command(method, params) };
    const state = {
      version: 1 as const, origins: [origin], capturedAt: Date.now(), warnings: [],
      cookies: [{ name: "sid", value: "source", domain: "127.0.0.1", path: "/" }, { name: "added", value: "new", domain: "127.0.0.1", path: "/" }],
      pages: [{ url: site, title: "", localStorage: { token: "source", fresh: "new" }, sessionStorage: { step: "source" } }],
    };
    const first = await injectBrowser(chrome, state, AbortSignal.timeout(5000));
    assert.equal(first.ok, false, "about:blank cannot receive page storage yet");
    assert.equal(first.cookies, 1);
    let jar = (await command("Network.getAllCookies")).cookies;
    assert.equal(jar.find((cookie: any) => cookie.name === "sid").value, "target");
    assert.equal(jar.find((cookie: any) => cookie.name === "added").value, "new");
    await command("Page.navigate", { url: site });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`)) break;
      await sleep(50);
    }
    await evaluate("localStorage.setItem('token','target'); sessionStorage.setItem('step','target'); true");
    tab.url = site;
    assert.equal((await injectBrowser(chrome, state, AbortSignal.timeout(5000))).ok, true);
    assert.deepEqual(await evaluate("[localStorage.getItem('token'), localStorage.getItem('fresh'), sessionStorage.getItem('step')]"), ["target", "new", "target"]);
    await restoreBrowser(chrome, state, AbortSignal.timeout(10000));
    jar = (await command("Network.getAllCookies")).cookies;
    assert.equal(jar.find((cookie: any) => cookie.name === "sid").value, "target");
    assert.deepEqual(await evaluate("[localStorage.getItem('token'), localStorage.getItem('fresh'), sessionStorage.getItem('step')]"), ["target", "new", "target"]);
  } finally {
    ws?.close();
    browser.kill();
    if (browser.exitCode === null) await Promise.race([new Promise<void>((resolve) => browser.once("exit", () => resolve())), sleep(4000)]);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
