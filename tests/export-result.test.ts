import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildDocxBytes,
  buildResultHtmlDocument,
  buildXlsxBytes,
  exportBasename,
  exportTitleOf,
  fetchArchivedImages,
} from "../web/src/export-result.js";

test("export basename keeps a readable title fragment and timestamp", () => {
  const name = exportBasename("三、测试用例清单 / Casual", Date.UTC(2026, 10, 3, 4, 52));
  assert.match(name, /^三、测试用例清单_Casual_/);
  assert.match(name, /2026/);
});

test("HTML export renders tables and absolute blob images", () => {
  const bare = "blob-" + "a".repeat(32);
  const markdown = [
    "## 用例",
    "",
    "| 用例号 | 步骤 |",
    "| --- | --- |",
    "| TC-01 | 刷新 |",
    "",
    `截图 ${bare}`,
  ].join("\n");
  const html = buildResultHtmlDocument({ title: "测试结果", markdown, origin: "https://vega.test" });
  assert.match(html, /<table>/);
  assert.match(html, /TC-01/);
  assert.match(html, new RegExp(`src="https://vega\.test/api/blobs/${bare}"`));
  assert.match(html, /<h1 class="doc-title">测试结果<\/h1>/);
});

test("XLSX export prefers markdown tables and falls back to plain lines", () => {
  const table = buildXlsxBytes("| 用例号 | 优先级 |\n| --- | --- |\n| TC-01 | P0 |");
  const files = unzipSync(table);
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /TC-01/);
  assert.match(sheet, /P0/);
  const plain = buildXlsxBytes("只有一行说明");
  assert.match(strFromU8(unzipSync(plain)["xl/worksheets/sheet1.xml"]), /只有一行说明/);
});

test("DOCX export keeps title and turns bare blob ids into absolute links", () => {
  const bare = "blob-" + "b".repeat(32);
  // location is undefined in node tests; links stay relative-ish via empty origin prefix
  const bytes = buildDocxBytes({ title: "结论", markdown: `见图 ${bare}` });
  const doc = strFromU8(unzipSync(bytes)["word/document.xml"]);
  assert.match(doc, /结论/);
  assert.match(doc, new RegExp(`/api/blobs/${bare}`));
});

test("HTML export embeds archived images and marks unavailable ones instead of dropping them", async () => {
  const ok = "blob-" + "c".repeat(32), gone = "blob-" + "d".repeat(32), notImage = "blob-" + "e".repeat(32);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVKkAAAAASUVORK5CYII=", "base64");
  const asked: string[] = [];
  const fetcher = async (url: string, init: any) => {
    asked.push(url);
    assert.equal(init.credentials, "same-origin", "uses the signed-in page session");
    if (url.endsWith(ok)) return new Response(png, { headers: { "Content-Type": "image/png" } });
    if (url.endsWith(notImage)) return new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } });
    return new Response("", { status: 404 });
  };
  const markdown = `![首屏](</api/blobs/${ok}>)\n\n再看一次 ${ok}\n\n![访问码步骤](</api/blobs/${gone}>)\n\n![登录页](sqlite:blob/${notImage})\n\n![外链](https://example.com/a.png)`;
  const images = await fetchArchivedImages(markdown, fetcher as any);
  assert.equal(asked.length, 3, "each archived image fetched once");
  const html = buildResultHtmlDocument({ title: "结论", markdown, origin: "https://vega.test", images });
  assert.equal((html.match(new RegExp(`src="data:image/png;base64,${png.toString("base64").replace(/[+/]/g, "\\$&")}"`, "g")) || []).length, 2);
  assert.doesNotMatch(html, /src="\/api\/blobs|src="https:\/\/vega\.test\/api\/blobs/);
  assert.match(html, new RegExp(`\\[图片无法导出：访问码步骤；原地址 https://vega\\.test/api/blobs/${gone}\\]`));
  assert.match(html, new RegExp(`\\[图片无法导出：登录页；原地址 https://vega\\.test/api/blobs/${notImage}\\]`));
  assert.match(html, /src="https:\/\/example\.com\/a\.png"/, "external images stay links");
  assert.doesNotMatch(html.replace(/https:\/\/example[^>]+>/, ""), /<img[^>]*loading="lazy"/, "embedded images are not lazy");
});

test("HTML export shows the request as a structured quoted block under a short title, not one bold run-on heading", () => {
  const request = [
    "目标：针对 TAPD 需求单设计测试用例。",
    "需求单地址：https://tapd.test/1",
    "（TAPD 地址 https://tapd.test）",
    "",
    "要做的事：",
    "1. 打开并完整阅读需求单。",
    "2. 定位到对应页面。",
    "3. 设计测试用例，要求：",
    "- 按功能点分组；",
    "- 截图要求：关键步骤各配一张。",
    "4. 交付：结构化测试用例清单。",
    "",
    "约束：",
    "- 只做只读查看。",
  ].join("\n");
  const title = exportTitleOf(request);
  assert.equal(title, "目标：针对 TAPD 需求单设计测试用例。");
  assert.equal(exportTitleOf("## **很长**" + "字".repeat(80)).length, 61);
  const markdown = "## 测试用例文档\n\n> 说明\n\n```js\n" + "x\n".repeat(20) + "```";
  const html = buildResultHtmlDocument({ title, request, markdown, origin: "https://vega.test" });
  assert.match(html, /<h1 class="doc-title">目标：针对 TAPD 需求单设计测试用例。<\/h1>/);
  const block = /<section class="request markdown-body">(.*?)<\/section>/.exec(html)?.[1] || "";
  assert.match(block, /^<div class="request-label">原始要求<\/div><p>目标：.*<br>需求单地址：.*<br>（TAPD 地址.*<\/p><p>要做的事：<\/p>/);
  assert.match(block, /<ol><li>打开并完整阅读需求单。<\/li><li>定位到对应页面。<\/li><li>设计测试用例，要求：<\/li><\/ol><ul><li>按功能点分组；<\/li><li>截图要求：关键步骤各配一张。<\/li><\/ul><ol start="4"><li>交付：结构化测试用例清单。<\/li><\/ol>/);
  assert.match(block, /<p>约束：<\/p><ul><li>只做只读查看。<\/li><\/ul>$/);
  assert.match(html, /<main class="markdown-body"><h2>测试用例文档<\/h2><blockquote>说明<\/blockquote>/);
  assert.match(html, /<details class="code-fold" open>/, "long code is expanded for print");
  assert.match(html, /\.code-copy\{display:none\}/);
  const doc = strFromU8(unzipSync(buildDocxBytes({ title, request, markdown: "结论" }))["word/document.xml"]);
  assert.match(doc, /原始要求：.*1\. 打开并完整阅读需求单。.*结论/);
});
