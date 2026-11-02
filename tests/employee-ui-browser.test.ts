import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { sleep } from "../server/core/util";

test("employee production UI preserves Nova turns, gives mobile space to the transcript and keeps administrator records read-only", { skip: !process.env.VEGA_EMPLOYEE_UI_URL, timeout: 45000 }, async () => {
  const base = process.env.VEGA_EMPLOYEE_UI_URL!;
  assert.equal(new URL(base).hostname, "127.0.0.1", "Only an isolated local fixture may be used");
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ username: "preview-admin", password: "preview-only-password-123" }) });
  assert(login.ok, "The isolated preview administrator must exist");
  const auth = await login.json() as any;
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
    await until("document.querySelectorAll('.conversation-turn').length>0");
    const structure = await evaluate("(()=>{const t=document.querySelector('.conversation-turn'),p=t.querySelector('.turn-process'),f=t.querySelector('.turn-fold');return {folded:getComputedStyle(p).display==='none',foldLabel:f.textContent,final:t.querySelector(':scope > .message.assistant .markdown-body')?.textContent,processContainsFinal:p.textContent.includes('Nova fixture final result')}})()");
    assert(structure.folded && structure.foldLabel.includes('tokens'), JSON.stringify(structure));
    assert(structure.final.includes('Nova fixture final result') && !structure.processContainsFinal, JSON.stringify(structure));
    await evaluate("document.querySelector('.turn-fold').click()");
    const groups = await evaluate("(()=>{const p=document.querySelector('.turn-process');return {groups:p.querySelectorAll('.tool-steps').length,empty:[...p.querySelectorAll(':scope > .message')].filter(e=>!e.textContent.trim()&&!e.querySelector('img')).length,first:p.querySelector('.tool-steps-summary').textContent}})()");
    assert.equal(groups.groups, 2, JSON.stringify(groups));
    assert.equal(groups.empty, 0, JSON.stringify(groups));
    assert(groups.first.includes('读取文件 ×4'), JSON.stringify(groups));
    await evaluate("document.querySelector('.tool-steps-summary').click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.turn-process')).display!=='none' && !!document.querySelector('.tool-steps-body .tool-thought')"), true);
    assert.equal(await evaluate("document.querySelectorAll('.tool-steps-body .tool-step').length"), 5);
    await evaluate("document.querySelector('.tool-steps-summary').click()");
    for (const width of [320, 390, 768, 1440]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      await command("Emulation.setTouchEmulationEnabled", { enabled: width < 768 });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      if (width <= 760) await until("document.querySelector('.sidebar').getBoundingClientRect().right<=1");
      const layout = await evaluate("(()=>{const q=s=>document.querySelector(s), r=q('.employee-composer').getBoundingClientRect();return {width:innerWidth,overflow:[...document.querySelectorAll('.workspace,.employee-workspace,.employee-header,.employee-execution-bar,.employee-content,.employee-chat')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth})),composerVisible:r.top>=0&&r.bottom<=innerHeight+1,history:[...document.querySelectorAll('nav button')].some(e=>/历史/.test(e.textContent)),debug:[...document.querySelectorAll('nav button')].some(e=>e.textContent.includes('调试会话'))}})()");
      assert.deepEqual(layout.overflow, [], JSON.stringify({ width, layout }));
      assert(layout.composerVisible, JSON.stringify({ width, layout }));
      assert(!layout.history && layout.debug);
      const processLayout = await evaluate("(()=>{const p=document.querySelector('.turn-process'),groups=[...p.querySelectorAll('.tool-steps')],buttons=groups.map(e=>e.querySelector('.tool-steps-summary'));return {heights:groups.map(e=>e.getBoundingClientRect().height),targets:buttons.map(e=>e.getBoundingClientRect().height)}})()");
      assert(processLayout.heights.every((height:number)=>height<=56), JSON.stringify({width,processLayout}));
      if (width <= 760) {
        assert(processLayout.targets.every((height:number)=>height>=44), JSON.stringify({width,processLayout}));
        const mobile = await evaluate("(()=>{const q=s=>document.querySelector(s);return {transcript:q('.employee-transcript').clientHeight/innerHeight,header:getComputedStyle(q('.employee-header')).display,execution:getComputedStyle(q('.employee-execution-bar')).display,composer:q('.employee-composer').getBoundingClientRect().height}})()");
        assert(mobile.transcript >= .60 && mobile.header === 'none' && mobile.execution === 'none' && mobile.composer <= 130, JSON.stringify({ width, mobile }));
      }
    }
    await evaluate("document.querySelector('.turn-fold').click()");
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 480, deviceScaleFactor: 1, mobile: true });
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const keyboard = await evaluate("(()=>{const c=document.querySelector('.employee-composer').getBoundingClientRect(),t=document.querySelector('.employee-transcript').getBoundingClientRect();return {bottom:c.bottom,height:t.height}})()");
    assert(keyboard.bottom <= 481 && keyboard.height >= 200, JSON.stringify(keyboard));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.querySelector('.employee-mobile-menu summary').click();[...document.querySelectorAll('.employee-mobile-actions button')].find(button=>button.textContent==='员工设置').click()");
    await until("!!document.querySelector('.employee-settings-form')");
    await evaluate("[...document.querySelectorAll('.employee-tabs button')].find(button=>button.textContent==='对话').click();document.querySelector('.employee-mobile-menu summary').click();[...document.querySelectorAll('.employee-mobile-actions button')].find(button=>button.textContent.includes('新任务执行位置')).click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.employee-execution-bar')).display==='flex'"), true);
    await evaluate("document.querySelector('.employee-mobile-menu summary').click();[...document.querySelectorAll('.employee-mobile-actions button')].find(button=>button.textContent.includes('新任务执行位置')).click()");
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate("[...document.querySelectorAll('nav button')].find(e=>e.textContent.includes('调试会话')).click()");
    await until("document.querySelectorAll('.debug-session').length>0");
    await evaluate("document.querySelector('.debug-session').click()");
    await until("!!document.querySelector('.debug-metadata')");
    assert.equal(await evaluate("document.querySelectorAll('.workspace textarea,.workspace .composer').length"), 0);
    assert.equal(await evaluate("!!document.querySelector('.employee-session .conversation-turn') && !document.querySelector('.employee-session .tool-block')"), true);
    await evaluate("[...document.querySelectorAll('.topbar button')].find(button=>button.textContent==='原始消息').click()");
    assert.equal(await evaluate("!!document.querySelector('.employee-session .tool-block')"), true);
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("[...document.querySelectorAll('.employee-list button')][0].click()");
    await until("!!document.querySelector('.employee-composer') && document.querySelector('.sidebar').getBoundingClientRect().right<=1");
    const originalURL = await evaluate("location.href"), originalID = new URL(originalURL).searchParams.get("employee");
    assert(originalID, "the current employee must be represented in the URL");
    const created = await fetch(base + "/api/employees", { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: "vega_session=" + cookie, "X-CSRF-Token": auth.csrfToken }, body: JSON.stringify({ name: "Employee URL refresh fixture " + Date.now() }) });
    assert(created.ok);
    const alternate = await created.json() as any;
    const alternateButton = `[...document.querySelectorAll('.employee-list button')].find(button=>button.textContent.includes(${JSON.stringify(alternate.name)}))`;
    await until(`!!(${alternateButton})`);
    await evaluate(`${alternateButton}.click()`);
    const alternateReady = `new URL(location.href).searchParams.get('employee')===${JSON.stringify(alternate.id)} && !!document.querySelector('.employee-composer') && document.querySelector('.employee-header h2')?.textContent===${JSON.stringify(alternate.name)}`;
    await until(alternateReady);
    await command("Page.reload");
    await until(alternateReady);
    assert.equal(await evaluate(`document.querySelector('.employee-list button.active')?.textContent.includes(${JSON.stringify(alternate.name)})`), true, "refresh must not reset to the default employee");
    await evaluate("history.back()");
    await until(`new URL(location.href).searchParams.get('employee')===${JSON.stringify(originalID)} && !!document.querySelector('.conversation-turn')`);
    await evaluate("history.forward()");
    await until(alternateReady);
    await command("Page.navigate", { url: originalURL });
    await until("!!document.querySelector('.employee-composer') && !!document.querySelector('.conversation-turn')");
    const frame = await command("Page.captureScreenshot", { format: "png" });
    if (process.env.VEGA_EMPLOYEE_UI_SCREENSHOT) await writeFile(process.env.VEGA_EMPLOYEE_UI_SCREENSHOT, Buffer.from(frame.data, "base64"));
    for (const request of pending.values()) clearTimeout(request.timer);
  } finally {
    ws?.close(); browser.kill();
    if (browser.exitCode === null) await new Promise<void>((resolve) => { browser.once("exit", () => resolve()); setTimeout(resolve, 4000).unref(); });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
