import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildDocxBytes,
  buildResultHtmlDocument,
  buildXlsxBytes,
  exportBasename,
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
  assert.match(html, /<h1>测试结果<\/h1>/);
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
