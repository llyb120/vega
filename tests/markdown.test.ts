import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderInline } from "../web/src/markdown.js";
import { groupTurns, timelineOf } from "../web/src/conversation.js";

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
  assert.equal(timelineOf(turn.process)[1].kind, "tools");
  assert.equal(timelineOf(turn.conclusion)[0].continuation, false);
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

test("inline code is protected from formatting and plain digits survive", () => {
  assert.equal(
    renderInline("`**not bold**` 与 **bold** 以及 0 和 12"),
    "<code>**not bold**</code> 与 <strong>bold</strong> 以及 0 和 12",
  );
  assert.equal(renderInline(""), "");
  assert.equal(renderMarkdown(null).html, "");
});
