import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

const source = readFileSync("local/assistant_page.html", "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

// 蝴蝶面板不订阅事件，只靠轮询；这里只跑 pollMessages，其余 DOM 更新用空函数替代。
function panel(state: any, responses: any[]) {
  const calls: any[] = [], opened: string[] = [];
  const context: any = {
    state,
    api: async (op: string, body: any) => { calls.push([op, body]); return responses.shift(); },
    open: async (thread: string) => { opened.push(thread); },
    updateHead() {}, renderStream() {},
  };
  context.pollMessages = vm.runInNewContext(between("async function pollMessages(", "async function pollThreads(") + "\npollMessages", context);
  return { ...context, calls, opened };
}

const empty = () => ({ current: "employee:ea", messages: [], lastSeq: 0, running: false, avatar: "", authors: {} });

test("清空聊天或重置后序号倒退，面板整段重开会话而不是拿着旧 seq 干等", async () => {
  const state = { ...empty(), messages: [{ seq: 120, text: "old" }], lastSeq: 120, running: true };
  const p = panel(state, [{ messages: [], lastSeq: 0, running: false }]);
  await p.pollMessages();
  // 面板在 vm 里构造的请求对象与宿主的原型不同，按内容比。
  assert.equal(JSON.stringify(p.calls[0]), JSON.stringify(["messages", { thread: "employee:ea", after: 120 }]));
  assert.deepEqual(p.opened, ["employee:ea"], "历史被删：重开会话拉新历史");
});

test("正常追加只合并新消息，不重开会话", async () => {
  const state = { ...empty(), messages: [{ seq: 120, text: "old" }], lastSeq: 120 };
  const p = panel(state, [{ messages: [{ seq: 121, text: "new" }], lastSeq: 121, running: false }]);
  await p.pollMessages();
  assert.deepEqual(p.opened, []);
  assert.deepEqual(state.messages.map((m: any) => m.seq), [120, 121]);
  assert.equal(state.lastSeq, 121);
});

test("刚清空的空会话不会被反复重开", async () => {
  const state = empty();
  const p = panel(state, [{ messages: [], lastSeq: 0, running: false }]);
  await p.pollMessages();
  assert.deepEqual(p.opened, []);
});

test("蝴蝶对话把步骤内容和文件画成独立产物卡", () => {
  const render = vm.runInNewContext(between("function stepOutputOf(", "function messageHTML(") + "\nstepOutputHTML", {
    esc: (value: unknown) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!),
    marked: { parse: (text: string) => `<p>${text}</p>` }, sanitize: (html: string) => html,
  });
  const html = render({ seq: 10, stepOutput: { step: 1, label: "独立方案", text: "完整内容", files: [{ name: 'app".zip', blobId: "blob-" + "a".repeat(32) }] } });
  assert.match(html, /ta-step-output/);
  assert.match(html, /<details><summary>查看内容/);
  assert.match(html, /完整内容/);
  assert.match(html, /data-step-export="10"/);
  assert.match(html, /data-step-file="blob-/);
  assert.match(html, /app&amp;quot;\.zip|app&quot;\.zip/);
  const legacy = render({ seq: 11, stepOutput: true, text: "**步骤产物（任务未完成）**\n\n旧方案\n\n旧的完整内容" });
  assert.match(legacy, /旧方案/);
  assert.match(legacy, /旧的完整内容/);
  assert.match(legacy, /data-step-export="11"/);
  assert.equal(render({ stepOutput: true, text: "不符合旧格式" }), "", "无法识别的旧消息保持原样");
});

test("蝴蝶面板实际渲染独立产物，并能分别下载文件和导出文本", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 60000 }, async () => {
  const blobId = "blob-" + "a".repeat(32), requests: any[] = [];
  const probe = `<script type="module">
    (async () => {
      const downloads = [], names = [];
      let downloaded;
      const downloadDone = new Promise(resolve => { downloaded = resolve; });
      URL.createObjectURL = (blob) => { downloads.push(blob); if (downloads.length === 2) downloaded(); return 'blob:fixture'; };
      HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
      await new Promise(resolve => {
        if (document.querySelector('[data-step-file]')) return resolve();
        const observer = new MutationObserver(() => { if (document.querySelector('[data-step-file]')) { observer.disconnect(); resolve(); } });
        observer.observe(document.body, { subtree: true, childList: true });
        setTimeout(() => { observer.disconnect(); resolve(); }, 5000);
      });
      const bubble = document.querySelector('.ta-message .ta-bubble');
      const artifact = document.querySelector('.ta-step-output');
      if (!artifact) { const result = document.createElement('pre'); result.id = 'probe'; result.textContent = JSON.stringify({ error: 'missing artifact', stream: document.querySelector('#stream')?.textContent, rail: document.querySelector('#empList')?.textContent, page: document.readyState }); document.body.append(result); return; }
      const separate = bubble.textContent.includes('继续执行') && !bubble.textContent.includes('独立方案正文') && artifact.textContent.includes('独立方案正文');
      artifact.querySelector('[data-step-export]').click();
      artifact.querySelector('[data-step-file]').click();
      await Promise.race([downloadDone, new Promise(resolve => setTimeout(resolve, 5000))]);
      const markdown = downloads[0] && await downloads[0].text();
      const bytes = downloads[1] && [...new Uint8Array(await downloads[1].arrayBuffer())];
      const result = document.createElement('pre'); result.id = 'probe'; result.textContent = JSON.stringify({ separate, names, markdown, bytes }); document.body.append(result);
    })();
  </script>`;
  const page = source.replace("</body>", probe + "</body>");
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/marked.js")) { response.setHeader("Content-Type", "text/javascript"); response.end(readFileSync("local/assistant_marked.js")); return; }
    if (request.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const op = request.url?.split("/").at(-1);
      let value: any = {};
      if (op === "threads") value = { employees: [{ thread: "employee:e1", kind: "employee", id: "e1", name: "牛马" }], groups: [] };
      if (op === "messages") value = { title: "牛马", lastSeq: 1, running: false, messages: body.after ? [] : [{ seq: 1, role: "assistant", text: "继续执行", stepOutput: { step: 1, label: "独立方案", text: "**独立方案正文**", files: [{ blobId, name: "app.zip", size: 3 }] } }] };
      if (op === "file") { requests.push(body); value = { data: Buffer.from([1, 2, 255]).toString("base64") }; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(page);
  });
  const dir = await mkdtemp(join(tmpdir(), "vega-assistant-output-"));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const { stdout } = await promisify(execFile)(process.env.VEGA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu", "--user-data-dir=" + dir,
      "--virtual-time-budget=12000", "--dump-dom", `http://127.0.0.1:${address.port}/assistant/test/`,
    ], { encoding: "utf8", timeout: 40000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const match = stdout.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
    assert(match?.[1], "the panel must finish the download fixture");
    const result = JSON.parse(match[1]);
    assert(!result.error, JSON.stringify(result));
    assert.equal(result.separate, true);
    assert.deepEqual(result.names, ["独立方案.md", "app.zip"]);
    assert.equal(result.markdown, "**独立方案正文**");
    assert.deepEqual(result.bytes, [1, 2, 255]);
    assert.deepEqual(requests, [{ blobId }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// 头像的动静：只有左栏卡片在任务执行中动；本地输入中（这一轮还在跑）与聊天气泡里的头像都静止。
test("左栏头像只在任务执行中动，输入中与聊天气泡头像保持静止", () => {
  assert(source.includes('avatarHTML(item.avatar, seed, !!item.runningTasks, "ta-session-face")'), "左栏卡片看任务状态");
  assert(!/avatarHTML\([^)]*,\s*true\s*\)/.test(source), "没有头像写死开动画");
  const route = readFileSync("server/routes/api/[...path].ts", "utf8");
  assert(route.includes('runningTasks: s.tasks.filter((task) => task.status === "running").length'), "左栏动画跟着任务，而不是聊天这一轮");
});
