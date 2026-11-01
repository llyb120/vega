import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { sleep } from "../server/core/util";

test("employee production UI fits narrow/desktop viewports and administrator debug sessions stay read-only", { skip: !process.env.VEGA_EMPLOYEE_UI_URL, timeout: 45000 }, async () => {
  const base = process.env.VEGA_EMPLOYEE_UI_URL!;
  assert.equal(new URL(base).hostname, "127.0.0.1", "Only an isolated local fixture may be used");
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ username: "preview-admin", password: "preview-only-password-123" }) });
  assert(login.ok, "The isolated preview administrator must exist");
  const cookie = login.headers.get("set-cookie")!.split(";")[0].split("=").slice(1).join("=");
  const dir = await mkdtemp(join(tmpdir(), "vega-employee-ui-"));
  const binary = process.env.VEGA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = spawn(binary, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--remote-debugging-port=0", "--user-data-dir=" + dir, "about:blank"], { stdio: "ignore", windowsHide: true });
  let ws: WebSocket | undefined;
  try {
    let port = "";
    for (let index = 0; index < 80 && !port; index++) {
      try { port = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await sleep(50); }
    }
    assert(port, "Fixture Chromium did not start");
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
    ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    let seq = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void; timer: NodeJS.Timeout }>();
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()), request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
    });
    const command = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(method + " timeout")); }, 5000);
      pending.set(id, { resolve, reject, timer });
      ws!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async (expression: string) => {
      for (let index = 0; index < 60; index++) { if (await evaluate(expression)) return; await sleep(50); }
      throw Error("UI did not reach expected condition: " + expression);
    };
    await command("Network.enable");
    await command("Network.setCookie", { name: "vega_session", value: cookie, url: base, httpOnly: true });
    await command("Page.navigate", { url: base });
    await until("!!document.querySelector('.employee-workspace .employee-composer')");
    for (const width of [320, 390, 768, 1440]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      await command("Emulation.setTouchEmulationEnabled", { enabled: width < 768 });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      if (width <= 760) await until("document.querySelector('.sidebar').getBoundingClientRect().right<=1");
      const layout = await evaluate("(()=>{const q=s=>document.querySelector(s), r=q('.employee-composer').getBoundingClientRect();return {width:innerWidth,overflow:[...document.querySelectorAll('.workspace,.employee-workspace,.employee-header,.employee-execution-bar,.employee-content,.employee-chat')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth})),composerVisible:r.top>=0&&r.bottom<=innerHeight+1,history:[...document.querySelectorAll('nav button')].some(e=>/历史/.test(e.textContent)),debug:[...document.querySelectorAll('nav button')].some(e=>e.textContent.includes('调试会话'))}})()");
      assert.deepEqual(layout.overflow, [], JSON.stringify({ width, layout }));
      assert(layout.composerVisible, JSON.stringify({ width, layout }));
      assert(!layout.history && layout.debug);
    }
    await evaluate("[...document.querySelectorAll('nav button')].find(e=>e.textContent.includes('调试会话')).click()");
    await until("document.querySelectorAll('.debug-session').length>0");
    await evaluate("document.querySelector('.debug-session').click()");
    await until("!!document.querySelector('.debug-metadata')");
    assert.equal(await evaluate("document.querySelectorAll('.workspace textarea,.workspace .composer').length"), 0);
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("[...document.querySelectorAll('.employee-list button')][0].click()");
    await until("!!document.querySelector('.employee-composer') && document.querySelector('.sidebar').getBoundingClientRect().right<=1");
    const frame = await command("Page.captureScreenshot", { format: "png" });
    if (process.env.VEGA_EMPLOYEE_UI_SCREENSHOT) await writeFile(process.env.VEGA_EMPLOYEE_UI_SCREENSHOT, Buffer.from(frame.data, "base64"));
    for (const request of pending.values()) clearTimeout(request.timer);
  } finally {
    ws?.close(); browser.kill();
    if (browser.exitCode === null) await new Promise<void>((resolve) => { browser.once("exit", () => resolve()); setTimeout(resolve, 4000).unref(); });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
