import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const fields = ["task.text", "task.approval", "task.waiting", "task.progress.at(-1).text", "item.text"];

test("task descriptions, requests and progress use the shared Markdown renderer", async () => {
  const source = await readFile("web/src/TaskDetail.vue", "utf8");
  for (const field of fields)
    assert(source.includes(`:text="${field}"`), `${field} must render Markdown and images, not plain interpolation`);
  assert(!source.includes("<h2>{{ task.text }}</h2>"), "the whole description must not inherit heading weight");
});

test("task Markdown and archived images render inside desktop and narrow detail panes", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 60000 }, async () => {
  const [{ createServer }, { default: vue }, image] = await Promise.all([
    import("vite"), import("@vitejs/plugin-vue"), readFile("web/public/avatars/zodiac/leo.webp"),
  ]);
  const url = "/api/blobs/blob-" + "1".repeat(32);
  const task = {
    id: "markdown-fixture", status: "waiting", createdAt: Date.now(),
    text: `# 修复图片显示\n\n正文 **重点** 与 \`/api/blobs/示例\`。\n\n1. 检查 Markdown\n2. 检查图片\n\n证据截图：Bing 结果页 ${url}；新标签验证页 ${url}。`,
    waiting: `**补充信息**\n![补充截图](${url})`,
    approval: `**确认操作**\n![确认截图](${url})`,
    progress: [{ text: `**历史进展**\n![历史截图](${url})` }, { text: `**当前进展**\n![最新截图](${url})` }],
    result: `**验证结果**\n![结果截图](${url})`,
  };
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <div id="app"></div><pre id="result"></pre>
    <script type="module">
      import { createVaporApp, nextTick, reactive } from 'vue';
      import TaskDetail from '/src/TaskDetail.vue';
      import '/src/style.css';
      const task = reactive(${JSON.stringify(task)}), host = document.querySelector('#app');
      createVaporApp(TaskDetail, { task, act: async () => true }).mount(host);
      try {
        document.querySelectorAll('details').forEach(element => element.open = true);
        const images = [...host.querySelectorAll('img')];
        await Promise.all(images.map(image => { image.loading = 'eager'; return image.decode(); }));
        const result = {
          heading: !!host.querySelector('.detail-head .markdown h1'),
          bodyWeight: getComputedStyle(host.querySelector('.detail-head .markdown p')).fontWeight,
          list: host.querySelectorAll('.detail-head .markdown ol li').length,
          requests: !!host.querySelector('.attention-block .markdown strong'),
          latest: !!host.querySelector('.progress-latest .markdown-body strong'),
          history: !!host.querySelector('.progress-history .markdown strong'),
          result: !!host.querySelector('.result-box .markdown strong'),
          images: images.map(image => ({ path: new URL(image.src).pathname, width: image.naturalWidth })),
          layouts: [],
        };
        for (const width of [320, 390, 1440]) {
          host.style.width = width + 'px';
          const detail = host.querySelector('.task-detail'), bounds = detail.getBoundingClientRect();
          result.layouts.push({ width, overflow: [...host.querySelectorAll('.detail-head,.attention-block,.detail-section,.markdown,img')].filter(element => {
            const rect = element.getBoundingClientRect();
            return element.scrollWidth > element.clientWidth + 1 || rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
          }).map(element => element.className || element.tagName) });
        }
        task.status = 'approval';
        await nextTick();
        result.approval = host.querySelector('.attention-block .markdown strong')?.textContent === '确认操作';
        const approvalImage = host.querySelector('.attention-block img');
        approvalImage.loading = 'eager';
        await approvalImage.decode();
        result.approvalImage = approvalImage.naturalWidth;
        document.querySelector('#result').textContent = JSON.stringify(result);
      } catch (error) { document.querySelector('#result').textContent = JSON.stringify({ error: String(error) }); }
    </script>`;
  const server = await createServer({
    configFile: false, root: "web", plugins: [vue(), {
      name: "task-markdown-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === url) { res.setHeader("Content-Type", "image/webp"); res.end(image); return; }
          if (req.url !== "/task-markdown-fixture.html") { next(); return; }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(await server.transformIndexHtml(req.url, html));
        });
      },
    }], server: { host: "127.0.0.1", port: 0 },
  });
  const dir = await mkdtemp(join(tmpdir(), "vega-task-markdown-"));
  try {
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    const { stdout } = await promisify(execFile)(process.env.VEGA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu",
      "--user-data-dir=" + dir, "--virtual-time-budget=5000", "--dump-dom", `http://127.0.0.1:${address.port}/task-markdown-fixture.html`,
    ], { encoding: "utf8", timeout: 40000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const match = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);
    assert(match?.[1], "the actual TaskDetail component must finish rendering");
    const result = JSON.parse(match[1]);
    assert(!result.error, result.error);
    for (const field of ["heading", "requests", "latest", "history", "result", "approval"]) assert.equal(result[field], true, field);
    assert.equal(result.approvalImage, 512);
    assert.equal(result.bodyWeight, "400");
    assert.equal(result.list, 2);
    assert.equal(result.images.length, 7);
    assert(result.images.every((image: { path: string; width: number }) => image.path === url && image.width === 512));
    for (const layout of result.layouts) assert.deepEqual(layout.overflow, [], JSON.stringify(layout));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
