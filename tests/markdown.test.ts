import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderInline } from "../web/src/markdown.js";
import {
  formatDuration,
  formatTokens,
  groupTurns,
  processLiveLines,
  processSummary,
  timelineOf,
  turnStats,
} from "../web/src/conversation.js";

test("conversation keeps conclusions visible and folds only completed process", () => {
  const messages = [
    { role: "user", seq: 1, text: "question" },
    { role: "assistant", seq: 2, thinking: "think" },
    { role: "tool", seq: 3, text: "result" },
    { role: "assistant", seq: 4, text: "answer" },
    { role: "user", seq: 5, text: "next" },
  ];
  const [turn, next] = groupTurns(messages) as any[];
  assert.deepEqual(turn.process.map((m: any) => m.seq), [2, 3]);
  assert.deepEqual(turn.conclusion.map((m: any) => m.seq), [4]);
  assert.equal(next.user.seq, 5);
  const timeline = timelineOf(turn.process) as any[];
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "process");
  assert.deepEqual(timeline[0].items.map((m: any) => m.role), ["thought", "tool"]);
  assert.equal(timelineOf(turn.conclusion)[0].continuation, false);
});

test("process folds use Nova summaries, live previews and measured turn usage", () => {
  const items = [
    { role: "thought", seq: 2, text: "先检查文件" },
    { role: "tool", seq: 3, name: "read", text: "ok" },
    { role: "tool", seq: 4, name: "bash", text: "one" },
    { role: "tool", seq: 5, name: "bash", text: "two", error: true },
  ];
  assert.equal(processSummary(items), "读取文件 ×1、执行命令 ×2（1 项失败）");
  assert.deepEqual(processLiveLines(items), ["已完成 · bash", "失败 · bash"]);
  assert.deepEqual(processLiveLines([...items, { role: "tool", name: "write", active: true }]).slice(-1), ["进行中 · write"]);

  const stats = turnStats([
    { role: "assistant", at: 2000, usage: { input: 100, output: 20, cacheRead: 10, totalTokens: 130 } },
    { role: "tool", at: 3000 },
    { role: "assistant", at: 4000, usage: { input: 50, output: 10, totalTokens: 60 } },
  ], 1000);
  assert.deepEqual(stats, {
    durationMs: 3000,
    totalTokens: 190,
    inputTokens: 150,
    outputTokens: 30,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
  });
  assert.equal(formatDuration(stats.durationMs), "3s");
  assert.equal(formatTokens(12500), "12.5k");
});

test("chat markdown escapes HTML and only links safe protocols", () => {
  const { html } = renderMarkdown(
    '<script>alert(1)</script> <img src=x onerror=alert(1)>\n[ok](https://example.com?a=1&b=2) [bad](javascript:alert(1))',
  );
  assert(!html.includes("<script>"));
  assert(!html.includes("<img"));
  assert(html.includes("&lt;script&gt;"));
  assert(html.includes('href="https://example.com?a=1&amp;b=2"'));
  assert(html.includes('rel="noopener noreferrer"'));
  assert(!html.includes('href="javascript:'));
  assert(!/<[a-z]+ on\w+=/i.test(html));
});

test("chat markdown renders blocks, lists and copyable code", () => {
  const { html, codes } = renderMarkdown(
    "# 标题\n- 一\n- 二\n1. 第一\n> 引用\n```js\nconst a = '<b>';\n```\n尾部",
  );
  assert(html.includes("<h1>标题</h1>"));
  assert(html.includes("<ul><li>一</li><li>二</li></ul>"));
  assert(html.includes("<ol><li>第一</li></ol>"));
  assert(html.includes("<blockquote>引用</blockquote>"));
  assert(html.includes('data-code="0"'));
  assert(html.includes("const a = &#39;") === false);
  assert(html.includes("&lt;b&gt;"));
  assert.deepEqual(codes, ["const a = '<b>';"]);
  assert(html.endsWith("<p>尾部</p>"));
});

test("long prompts and code stay compact until explicitly expanded", () => {
  const { html, codes } = renderMarkdown(
    "```js\n" + "const value = '<safe>';\n".repeat(19) + "```",
  );
  assert(html.includes('<details class="code-fold">'));
  assert(html.includes("展开 js 代码 · 19 行"));
  assert(html.includes("&lt;safe&gt;"));
  assert.equal(codes.length, 1);
});

test("chat markdown renders pipe tables with aligned headers, inline formatting and surrounding blocks", () => {
  const { html, codes } = renderMarkdown([
    "表格前说明", "",
    "| **项目** | 数量 | 状态 |",
    "| :--- | :---: | ---: |",
    "| `read` | 12 | [完成](https://example.com) |",
    "| write | 0 | 待处理 |", "", "表格后说明",
  ].join("\r\n"));
  assert.match(html, /<p>表格前说明<\/p><div class="markdown-table"/);
  assert.match(html, /role="region"[^>]*tabindex="0"/);
  assert.match(html, /<table><thead><tr><th scope="col" style="text-align:left"><strong>项目<\/strong><\/th><th scope="col" style="text-align:center">数量<\/th><th scope="col" style="text-align:right">状态<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /<td style="text-align:left"><code>read<\/code><\/td>/);
  assert.match(html, /<td style="text-align:center">12<\/td>/);
  assert.match(html, /<td style="text-align:right"><a href="https:\/\/example.com"/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.match(html, /<\/tbody><\/table><\/div><p>表格后说明<\/p>$/);
  assert.deepEqual(codes, []);
});

test("tables accept optional outer pipes, escaped pipes and short or excess rows without losing following text", () => {
  const { html } = renderMarkdown("名称 | 内容\n--- | ---\nA\\|B | `x\\|y`\nshort |\nC | first | extra\n\n结束");
  assert.match(html, /<td>A\|B<\/td><td><code>x\|y<\/code><\/td>/);
  assert.match(html, /<tr><td>short<\/td><td><\/td><\/tr>/);
  assert.match(html, /<tr><td>C<\/td><td>first<\/td><\/tr>/);
  assert(!html.includes("extra"));
  assert(html.endsWith("<p>结束</p>"));
  assert.match(renderMarkdown("| 标题 |\n| --- |\n| 内容 |").html, /<th scope="col">标题<\/th>/);
});

test("tables escape HTML and unsafe links and do not consume code blocks, invalid delimiters or incomplete streams", () => {
  const { html } = renderMarkdown('| <img src=x onerror=alert(1)> | 链接 |\n| --- | --- |\n| <script>alert(1)</script> | [bad](javascript:alert(1)) |');
  assert.match(html, /<table>/);
  assert(!/<(?:img|script)\b/i.test(html));
  assert(!html.includes('href="javascript:'));
  assert.match(html, /&lt;script&gt;/);
  for (const text of ["普通文字 | 不是表格", "a | b\n--- | invalid", "a | b\n| --- |", "a | b\n| --"]) {
    assert(!renderMarkdown(text).html.includes("<table>"), text);
  }
  const { html: code, codes } = renderMarkdown("```md\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```");
  assert(!code.includes("<table>"));
  assert.equal(codes[0], "| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.match(renderMarkdown("a | b\n--- | ---").html, /<tbody><\/tbody>/);
  assert.match(renderMarkdown("a | b\n--- | ---\n1 | 2").html, /<td>1<\/td><td>2<\/td>/);
});

test("inline code is protected from formatting and plain digits survive", () => {
  assert.equal(
    renderInline("`**not bold**` 与 **bold** 以及 0 和 12"),
    "<code>**not bold**</code> 与 <strong>bold</strong> 以及 0 和 12",
  );
  assert.equal(renderInline(""), "");
  assert.equal(renderMarkdown(null).html, "");
});
