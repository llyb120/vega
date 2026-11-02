import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { sleep } from "../server/core/util";

test("employee chat bubbles, citations and task jumps work on mobile while debug records retain Nova process details", { skip: !process.env.VEGA_EMPLOYEE_UI_URL, timeout: 45000 }, async () => {
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
  const providerRequests: any[] = [], providerTimers: NodeJS.Timeout[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); providerRequests.push(body);
    const final = body.messages.at(-1)?.role === "tool";
    res.setHeader("Content-Type", "text/event-stream"); res.write(": heartbeat\n\n");
    providerTimers.push(setTimeout(() => res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: final ? { content: "引用内容已核对，结论：只查看已验证的结果。" } : { content: "中间工具过程不应显示", reasoning_content: "internal thought", tool_calls: [{ index: 0, id: "ui-list", type: "function", function: { name: "employee", arguments: '{"action":"list"}' } }] }, finish_reason: final ? "stop" : "tool_calls" }] }) + "\n\ndata: [DONE]\n\n"), final ? 900 : 50));
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const configured = await fetch(base + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json", Origin: base, Cookie: "vega_session=" + cookie, "X-CSRF-Token": auth.csrfToken }, body: JSON.stringify({ model: "ui/model", provider: { ui: { api: "openai-completions", baseURL: `http://127.0.0.1:${(provider.address() as any).port}`, models: { model: { limit: { context: 128000, output: 8192 } } } } } }) });
    assert(configured.ok, "only the isolated UI fixture may be configured");
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
    await until("document.querySelectorAll('.chat-message').length>0");
    const structure = await evaluate("(()=>{const q=s=>document.querySelector(s);return {user:!!q('.chat-message.user .chat-bubble'),assistant:!!q('.chat-message.assistant .chat-bubble'),final:q('.employee-transcript').textContent.includes('Nova fixture final result'),tools:document.querySelectorAll('.employee-chat .tool-steps,.employee-chat .turn-fold,.employee-chat .reasoning').length,text:q('.employee-transcript').textContent}})()");
    assert(structure.user && structure.assistant && structure.final && structure.tools===0, JSON.stringify(structure));
    await evaluate("document.querySelector('.chat-quote').click()");
    assert.equal(await evaluate("document.activeElement?.classList.contains('chat-message')"), true, "delivery citations navigate to and focus the actual source message");
    await evaluate("[...document.querySelectorAll('.chat-message.assistant')].find(element=>element.textContent.includes('Nova fixture final result')).querySelector('.chat-reply').click()");
    assert.equal(await evaluate("document.querySelector('.composer-quote').textContent.includes('Nova fixture final result')"), true);
    await evaluate("document.querySelector('[aria-label=\"取消引用\"]').click()");
    const deliveryTask = await evaluate("document.querySelector('.chat-task-link').dataset.taskId");
    await evaluate("document.querySelector('.chat-task-link').click()");
    await until(`!!document.querySelector('.work-item.highlighted[data-task-id="${deliveryTask}"] .work-details[open]')`);
    assert.equal(await evaluate("document.querySelector('.work-item.highlighted').textContent.includes('Full task-only verification details')"), true);
    await evaluate("[...document.querySelectorAll('.employee-tabs button')].find(button=>button.textContent==='对话').click()");
    await until("!!document.querySelector('.chat-message')");
    for (const width of [320, 390, 768, 1440]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      await command("Emulation.setTouchEmulationEnabled", { enabled: width < 768 });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      if (width <= 760) await until("document.querySelector('.sidebar').getBoundingClientRect().right<=1");
      const layout = await evaluate("(()=>{const q=s=>document.querySelector(s), r=q('.employee-composer').getBoundingClientRect();return {width:innerWidth,overflow:[...document.querySelectorAll('.workspace,.employee-workspace,.employee-header,.employee-execution-bar,.employee-content,.employee-chat')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth})),composerVisible:r.top>=0&&r.bottom<=innerHeight+1,history:[...document.querySelectorAll('nav button')].some(e=>/历史/.test(e.textContent)),debug:[...document.querySelectorAll('nav button')].some(e=>e.textContent.includes('调试会话'))}})()");
      assert.deepEqual(layout.overflow, [], JSON.stringify({ width, layout }));
      assert(layout.composerVisible, JSON.stringify({ width, layout }));
      assert(!layout.history && layout.debug);
      const bubbleLayout = await evaluate("(()=>{const user=document.querySelector('.chat-message.user .chat-bubble'),assistant=document.querySelector('.chat-message.assistant .chat-bubble');return {user:getComputedStyle(user).backgroundColor,assistant:getComputedStyle(assistant).backgroundColor,tools:document.querySelectorAll('.employee-chat .tool-steps').length}})()");
      assert(bubbleLayout.user !== bubbleLayout.assistant && bubbleLayout.tools === 0, JSON.stringify({width,bubbleLayout}));
      if (width <= 760) {
        const mobile = await evaluate("(()=>{const q=s=>document.querySelector(s);return {transcript:q('.employee-transcript').clientHeight/innerHeight,header:getComputedStyle(q('.employee-header')).display,execution:getComputedStyle(q('.employee-execution-bar')).display,composer:q('.employee-composer').getBoundingClientRect().height}})()");
        assert(mobile.transcript >= .60 && mobile.header === 'none' && mobile.execution === 'none' && mobile.composer <= 130, JSON.stringify({ width, mobile }));
      }
    }
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
    await evaluate("[...document.querySelectorAll('.chat-message.assistant')].find(element=>element.textContent.includes('Nova fixture final result')).querySelector('.chat-reply').click();const textarea=document.querySelector('.employee-composer textarea');textarea.value='quote-ui-fixture: 请解释这条结论';textarea.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.employee-composer').requestSubmit()");
    await until("document.querySelector('.employee-typing .typing-dots i') && getComputedStyle(document.querySelector('.typing-dots i')).animationName.startsWith('typing-dot')");
    assert.equal(await evaluate("document.querySelector('.employee-chat').textContent.includes('中间工具过程不应显示')"), false);
    await until("!document.querySelector('.employee-typing') && document.querySelector('.employee-transcript').textContent.includes('引用内容已核对')");
    assert(providerRequests.some(request => request.messages.some((message:any) => message.role==='user' && message.content?.includes('用户引用的历史消息') && message.content?.includes('Nova fixture final result'))), "the actual cited source reaches the model");
    assert.equal(await evaluate("!!document.querySelector('.chat-message.user .chat-quote') && document.querySelectorAll('.employee-chat .tool-steps').length===0"), true);
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate("[...document.querySelectorAll('nav button')].find(e=>e.textContent.includes('调试会话')).click()");
    await until("document.querySelectorAll('.debug-session').length>0");
    await evaluate("[...document.querySelectorAll('.debug-session')].find(element=>element.textContent.includes('主执行会话')).click()");
    await until("!!document.querySelector('.debug-metadata')");
    assert.equal(await evaluate("document.querySelectorAll('.workspace textarea,.workspace .composer').length"), 0);
    assert.equal(await evaluate("!!document.querySelector('.employee-session .conversation-turn') && !document.querySelector('.employee-session .tool-block')"), true);
    await evaluate("document.querySelector('.turn-fold').click()");
    assert.equal(await evaluate("document.querySelectorAll('.employee-session .tool-steps').length"), 2, "detailed debug records retain merged tool process groups");
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
    await until(`new URL(location.href).searchParams.get('employee')===${JSON.stringify(originalID)} && !!document.querySelector('.chat-message')`);
    await evaluate("history.forward()");
    await until(alternateReady);
    await command("Page.navigate", { url: originalURL });
    await until("!!document.querySelector('.employee-composer') && !!document.querySelector('.chat-message')");
    const frame = await command("Page.captureScreenshot", { format: "png" });
    if (process.env.VEGA_EMPLOYEE_UI_SCREENSHOT) await writeFile(process.env.VEGA_EMPLOYEE_UI_SCREENSHOT, Buffer.from(frame.data, "base64"));
    for (const request of pending.values()) clearTimeout(request.timer);
  } finally {
    providerTimers.forEach(clearTimeout); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    ws?.close(); browser.kill();
    if (browser.exitCode === null) await new Promise<void>((resolve) => { browser.once("exit", () => resolve()); setTimeout(resolve, 4000).unref(); });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
