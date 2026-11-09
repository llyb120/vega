import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { sleep } from "../server/core/util";

test("work panel keeps long task titles, requests and reply controls inside narrow cards", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-work-panel-"));
  try {
    const [component, global] = await Promise.all([readFile("web/src/WorkPanel.vue", "utf8"), readFile("web/src/style.css", "utf8")]);
    const styles = component.match(/<style scoped>([\s\S]*?)<\/style>/)![1];
    const long = "接单 Tapd 需求：https://tapd.tencent.com/tapd_fe/20427644/story/detail/" + "112042764413955".repeat(30);
    const file = join(dir, "panel.html");
    await writeFile(file, `<!doctype html><meta charset="utf-8"><style>${global}\n${styles}</style>
      <div id="fixture" style="position:relative;display:flex;height:500px">
        <aside class="work-panel"><header class="panel-head"><h3>工作面板</h3><button class="link">全部任务</button><button class="icon sm">×</button></header>
          <div class="panel-scroll"><section class="panel-section">
            <article class="attention-card"><button class="task-title">${long}</button><p class="attention-text">需要补充：${long}\nTAPD_ACCESS_TOKEN_${"token".repeat(100)}</p><form class="answer"><textarea rows="2" placeholder="补充信息后，牛马会继续原任务"></textarea><button class="primary sm">回复并继续</button></form></article>
            <article class="attention-card"><button class="task-title">${long}</button><p class="attention-text">需要确认：${long}</p><div class="actions"><button class="primary sm">批准执行</button><button class="sm">驳回</button></div></article>
            <button class="task-row"><span class="task-row-head"><span class="badge">进行中</span><time>刚刚</time></span><strong>${long}</strong><span class="task-row-note">${long}</span><span class="mini-progress"><span style="width:50%"></span></span></button>
          </section></div>
        </aside>
      </div><pre id="result"></pre><script>
        const fixture = document.querySelector('#fixture'), panel = document.querySelector('.work-panel'), results = [];
        for (const width of [280, 320, 360]) {
          fixture.style.width = width + 'px';
          for (const overlay of [false, true]) {
            panel.classList.toggle('overlay', overlay);
            const bounds = panel.getBoundingClientRect();
            const overflow = [...panel.querySelectorAll('.panel-scroll,.attention-card,.task-title,.attention-text,.answer,.answer textarea,.actions,.task-row,.task-row strong,.task-row-note')].filter(element => {
              const rect = element.getBoundingClientRect();
              return element.scrollWidth > element.clientWidth + 1 || rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
            }).map(element => element.className || element.tagName);
            results.push({ width, overlay, overflow });
          }
        }
        document.querySelector('#result').textContent = JSON.stringify(results);
      </script>`);
    const output = execFileSync(process.env.VEGA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu", "--user-data-dir=" + join(dir, "profile"), "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 20000, windowsHide: true });
    const results = JSON.parse(output.match(/<pre id="result">([\s\S]*?)<\/pre>/)![1]);
    assert.equal(results.length, 6);
    for (const result of results) assert.deepEqual(result.overflow, [], JSON.stringify(result));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

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
    if (body.tools?.some((tool: any) => tool.function?.name === "compile_duty_trigger")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "ui-duty", type: "function", function: { name: "compile_duty_trigger", arguments: '{"mode":"manual"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    const final = body.messages.at(-1)?.role === "tool";
    res.setHeader("Content-Type", "text/event-stream"); res.write(": heartbeat\n\n");
    providerTimers.push(setTimeout(() => res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: final ? { content: "引用内容已核对，结论：只查看已验证的结果。" } : { content: "中间工具过程不应显示", reasoning_content: "internal thought", tool_calls: [{ index: 0, id: "ui-list", type: "function", function: { name: "employee_status", arguments: '{}' } }] }, finish_reason: final ? "stop" : "tool_calls" }] }) + "\n\ndata: [DONE]\n\n"), final ? 900 : 50));
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
    await until(`!!document.querySelector('.task-detail[data-task-id="${deliveryTask}"]')`);
    assert.equal(await evaluate("document.querySelector('.task-detail').textContent.includes('Full task-only verification details')"), true);
    await evaluate("[...document.querySelectorAll('.employee-tabs button')].find(button=>button.textContent==='对话').click()");
    await until("!!document.querySelector('.chat-message')");
    for (const width of [320, 390, 768, 1440]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      await command("Emulation.setTouchEmulationEnabled", { enabled: width < 768 });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      if (width <= 760) await until("document.querySelector('.sidebar').getBoundingClientRect().right<=1");
      const layout = await evaluate("(()=>{const q=s=>document.querySelector(s), r=q('.employee-composer').getBoundingClientRect();return {width:innerWidth,overflow:[...document.querySelectorAll('.workspace,.employee-workspace,.employee-header,.employee-chat-layout,.employee-chat')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth})),composerVisible:r.top>=0&&r.bottom<=innerHeight+1,history:[...document.querySelectorAll('nav button')].some(e=>/历史/.test(e.textContent)),debug:[...document.querySelectorAll('nav button')].some(e=>e.textContent.includes('调试会话'))}})()");
      assert.deepEqual(layout.overflow, [], JSON.stringify({ width, layout }));
      assert(layout.composerVisible, JSON.stringify({ width, layout }));
      assert(!layout.history && layout.debug);
      const bubbleLayout = await evaluate("(()=>{const user=document.querySelector('.chat-message.user .chat-bubble'),assistant=document.querySelector('.chat-message.assistant .chat-bubble');return {user:getComputedStyle(user).backgroundColor,assistant:getComputedStyle(assistant).backgroundColor,tools:document.querySelectorAll('.employee-chat .tool-steps').length}})()");
      assert(bubbleLayout.user !== bubbleLayout.assistant && bubbleLayout.tools === 0, JSON.stringify({width,bubbleLayout}));
      if (width <= 760) {
        const mobile = await evaluate("(()=>{const q=s=>document.querySelector(s);return {transcript:q('.employee-transcript').clientHeight/innerHeight,header:getComputedStyle(q('.employee-header')).display,menu:getComputedStyle(q('.header-menu')).display,composer:q('.employee-composer').getBoundingClientRect().height}})()");
        assert(mobile.transcript >= .60 && mobile.header !== 'none' && mobile.menu !== 'none' && mobile.composer <= 130, JSON.stringify({ width, mobile }));
      }
    }
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 480, deviceScaleFactor: 1, mobile: true });
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const keyboard = await evaluate("(()=>{const c=document.querySelector('.employee-composer').getBoundingClientRect(),t=document.querySelector('.employee-transcript').getBoundingClientRect();return {bottom:c.bottom,height:t.height}})()");
    assert(keyboard.bottom <= 481 && keyboard.height >= 200, JSON.stringify(keyboard));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.querySelector('[aria-label=\"牛马更多操作\"]').click();[...document.querySelectorAll('.popover-panel button')].find(button=>button.textContent==='牛马设置').click()");
    await until("!!document.querySelector('.settings-page form.profile')");
    assert(await evaluate("document.querySelectorAll('.shape-grid button').length") >= 15);
    assert.equal(await evaluate("document.querySelectorAll('.color-row button').length"), 12);
    await evaluate("document.querySelector('[aria-label=\"使用云朵形状\"]').click()");
    await until("document.querySelector('[aria-label=\"使用云朵形状\"]').getAttribute('aria-pressed')==='true' && document.querySelector('.avatar-current .bot-avatar')?.dataset.shape==='cloud'");
    await evaluate("document.querySelector('[aria-label=\"使用青色\"]').click()");
    await until("document.querySelector('[aria-label=\"使用青色\"]').getAttribute('aria-pressed')==='true' && document.querySelector('.avatar-current .bot-avatar path')?.getAttribute('fill')==='#0fb4a3' && document.querySelector('.avatar-current .bot-avatar')?.dataset.shape==='cloud'");
    const avatarFile = (await readFile("web/public/avatars/zodiac/leo.webp")).toString("base64");
    await evaluate(`(()=>{const input=document.querySelector('[aria-label="上传牛马头像图片"]'),transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(avatarFile)}),char=>char.charCodeAt(0))],'custom.webp',{type:'image/webp'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await until("document.querySelector('.avatar-current img')?.src.includes('/avatar?v=blob-') && document.querySelector('.avatar-current img').naturalWidth===512");
    await command("Page.reload");
    await until("document.querySelector('.chat-message.assistant .chat-avatar img')?.src.includes('/avatar?v=blob-') && document.querySelector('.chat-message.assistant .chat-avatar img').naturalWidth===512");
    await evaluate("document.querySelector('[aria-label=\"牛马更多操作\"]').click();[...document.querySelectorAll('.popover-panel button')].find(button=>button.textContent==='牛马设置').click()");
    await until("!!document.querySelector('.avatar-picker')");
    await evaluate("[...document.querySelectorAll('.avatar-actions button')].find(button=>button.textContent==='恢复默认头像').click()");
    await until("!document.querySelector('.avatar-current img') && !!document.querySelector('.avatar-current .bot-avatar')");
    await evaluate("document.querySelector('[aria-label=\"使用星星形状\"]').click()");
    await until("document.querySelector('.avatar-current .bot-avatar')?.dataset.shape==='star'");
    await evaluate("[...document.querySelectorAll('.employee-tabs button')].find(button=>button.querySelector('span')?.textContent==='职责').click()");
    await until("[...document.querySelectorAll('.section-heading button')].some(button=>button.textContent.includes('新增职责'))");
    await evaluate("[...document.querySelectorAll('.section-heading button')].find(button=>button.textContent.includes('新增职责')).click()");
    await until("!!document.querySelector('.duty-form')");
    assert.equal(await evaluate("document.querySelectorAll('.duty-form textarea').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('.duty-form input,.duty-form select').length"), 0);
    if (process.env.VEGA_EMPLOYEE_UI_SCREENSHOT) {
      const shot = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(process.env.VEGA_EMPLOYEE_UI_SCREENSHOT.replace(/\.png$/, "-duty.png"), Buffer.from(shot.data, "base64"));
    }
    const dutyText = "two-field-duty-ui-" + Date.now();
    await evaluate(`(()=>{const form=document.querySelector('.duty-form'),boxes=form.querySelectorAll('textarea');boxes[0].value='按交代的任务需要，不自动触发';boxes[1].value=${JSON.stringify(dutyText)};boxes.forEach(box=>box.dispatchEvent(new Event('input',{bubbles:true})));form.requestSubmit()})()`);
    const dutyCard = `[...document.querySelectorAll('.duty-list li')].find(card=>card.querySelector('.duty-main strong')?.textContent===${JSON.stringify(dutyText)})`;
    await until(`!document.querySelector('.duty-form') && !!(${dutyCard})`);
    const triggerCalls = providerRequests.filter(request => request.tools?.some((tool: any) => tool.function?.name === 'compile_duty_trigger')).length;
    assert.equal(triggerCalls, 1);
    await evaluate(`[...(${dutyCard}).querySelectorAll('button')].find(button=>button.textContent==='停用').click()`);
    await until(`!![...(${dutyCard}).querySelectorAll('button')].find(button=>button.textContent==='启用')`);
    await evaluate(`[...(${dutyCard}).querySelectorAll('button')].find(button=>button.textContent==='编辑').click()`);
    await until("!!document.querySelector('.duty-form')");
    assert.equal(await evaluate("document.querySelector('.duty-form textarea').value"), "按交代的任务需要，不自动触发");
    await evaluate("document.querySelector('.duty-form').requestSubmit()");
    await until(`!document.querySelector('.duty-form') && !![...(${dutyCard}).querySelectorAll('button')].find(button=>button.textContent==='启用')`);
    assert.equal(providerRequests.filter(request => request.tools?.some((tool: any) => tool.function?.name === 'compile_duty_trigger')).length, triggerCalls);
    await evaluate("document.querySelector('[aria-label=\"牛马更多操作\"]').click();[...document.querySelectorAll('.popover-panel button')].find(button=>button.textContent==='牛马设置').click()");
    await until("!!document.querySelector('.settings-page form.profile')");
    assert.equal(await evaluate("document.querySelectorAll('.place-options [role=radio]').length"), 0, "执行位置只在客户端配，网页不再提供这个开关");
    await evaluate("[...document.querySelectorAll('.employee-tabs button')].find(button=>button.textContent==='对话').click()");
    await until("!!document.querySelector('.employee-composer')");
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
    await evaluate("[...document.querySelectorAll('.employee-item')][0].click()");
    await until("!!document.querySelector('.employee-composer') && document.querySelector('.sidebar').getBoundingClientRect().right<=1");
    const originalURL = await evaluate("location.href"), originalID = new URL(originalURL).searchParams.get("employee");
    assert(originalID, "the current employee must be represented in the URL");
    const created = await fetch(base + "/api/employees", { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: "vega_session=" + cookie, "X-CSRF-Token": auth.csrfToken }, body: JSON.stringify({ name: "Employee URL refresh fixture " + Date.now() }) });
    assert(created.ok);
    const alternate = await created.json() as any;
    const alternateButton = `[...document.querySelectorAll('.employee-item')].find(button=>button.textContent.includes(${JSON.stringify(alternate.name)}))`;
    await until(`!!(${alternateButton})`);
    await evaluate(`${alternateButton}.click()`);
    const alternateReady = `new URL(location.href).searchParams.get('employee')===${JSON.stringify(alternate.id)} && !!document.querySelector('.employee-composer') && document.querySelector('.employee-header h2')?.textContent===${JSON.stringify(alternate.name)}`;
    await until(alternateReady);
    await command("Page.reload");
    await until(alternateReady);
    assert.equal(await evaluate(`document.querySelector('.employee-item.active')?.textContent.includes(${JSON.stringify(alternate.name)})`), true, "refresh must not reset to the default employee");
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
