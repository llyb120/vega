import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMembers, filterTasks, insertMention, mentionQuery, moveActive, removeRange, taskHashQuery } from "../web/src/mention.js";
import { groupMembers, groupMentionPeople, groupTiles } from "../web/src/group.js";

const people = [
  { id: "1", name: "发布助手" },
  { id: "2", name: "Data Bot" },
  { id: "3", name: "数据助手" },
  { id: "4", name: "data team" },
];

test("mentionQuery finds the @query before the caret and ignores emails, newlines and selections past it", () => {
  assert.deepEqual(mentionQuery("交给 @发布", 6), { start: 3, query: "发布" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("问 @Data B", 9), { start: 2, query: "Data B" });
  assert.equal(mentionQuery("ops@example", 11), null);
  assert.equal(mentionQuery("@发布\n继续", 6), null);
  assert.equal(mentionQuery("没有提及", 4), null);
  assert.equal(mentionQuery("@" + "长".repeat(41), 42), null);
});

test("filterMembers: prefix before substring, case-insensitive, list order within a rank", () => {
  assert.deepEqual(filterMembers(people, "").map((c: any) => c.id), ["1", "2", "3", "4"]);
  assert.deepEqual(filterMembers(people, "DATA").map((c: any) => c.id), ["2", "4"]);
  assert.deepEqual(filterMembers(people, "助手").map((c: any) => c.id), ["1", "3"]);
  assert.deepEqual(filterMembers(people, "数").map((c: any) => c.id), ["3"]);
  assert.deepEqual(filterMembers(people, "nobody"), []);
});

test("insertMention replaces the query with @名称 and a single space, caret after it", () => {
  assert.deepEqual(insertMention("交给 @发 处理", 3, 5, "发布助手"), { text: "交给 @发布助手 处理", caret: 9 });
  assert.deepEqual(insertMention("@", 0, 1, "Data Bot"), { text: "@Data Bot ", caret: 10 });
});

test("moveActive wraps; nothing to highlight in an empty list", () => {
  assert.equal(moveActive(4, -1, 1), 0);
  assert.equal(moveActive(4, 3, 1), 0);
  assert.equal(moveActive(4, 0, -1), 3);
  assert.equal(moveActive(0, -1, 1), -1);
});

test("@名称 of known employees render as links; emails, code and unknown names do not", async () => {
  const { renderMarkdown } = await import("../web/src/markdown.js");
  const people = [{ id: "e1", name: "测试助手" }, { id: "e2", name: "测试" }, { id: "e3", name: "a.b" }];
  const { html } = renderMarkdown("转交给 @测试助手处理，问 @测试 和 @a.b；邮件 x@测试 `@测试助手` @路人", { mentions: people });
  assert.match(html, /<a class="mention" href="\/employees\/e1" data-employee="e1">@测试助手<\/a>处理/);
  assert.match(html, /data-employee="e2">@测试<\/a> 和/);
  assert.match(html, /data-employee="e3">@a\.b<\/a>/);
  assert.match(html, /x@测试 /);
  assert.match(html, /<code>@测试助手<\/code>/);
  assert.match(html, /@路人/);
  assert.doesNotMatch(renderMarkdown("@测试助手").html, /mention/);
});

test("group mentions: own employees link to their chat, users and other people's employees are highlighted only", async () => {
  const { renderMarkdown } = await import("../web/src/markdown.js");
  const group = { creatorId: "u1", users: [{ id: "u1", name: "alice" }, { id: "u2", name: "bob" }], employees: [{ id: "e1", name: "小A", mine: true }, { id: "e2", name: "小B", mine: false, ownerName: "bob" }] };
  const { html } = renderMarkdown("@小A 写代码，@小B 测试，@bob 看一下", { mentions: groupMentionPeople(group) });
  assert.match(html, /<a class="mention" href="\/employees\/e1" data-employee="e1">@小A<\/a>/);
  assert.match(html, /<span class="mention">@小B<\/span>/);
  assert.match(html, /<span class="mention">@bob<\/span>/);
  // The picker lists employees first, then the other users (the writer excluded).
  assert.deepEqual(groupMembers(group, "u1").map((m: any) => [m.name, m.hint]), [["小A", "我的热心市民"], ["小B", "bob的热心市民"], ["bob", "用户"]]);
});

test("group avatar: the 群主 is the first tile, then users, then employees; up to 9 tiles in a 1/2/3-column grid", () => {
  const user = (id: string) => ({ id, name: id }), employee = (id: string) => ({ id, name: id });
  const two = groupTiles({ creatorId: "u2", users: [user("u1"), user("u2")], employees: [employee("e1")] });
  assert.deepEqual(two.tiles.map((t: any) => t.kind + ":" + t.id), ["user:u2", "user:u1", "employee:e1"]);
  assert.equal(two.cols, 2);
  assert.equal(groupTiles({ creatorId: "u1", users: [user("u1")], employees: [] }).cols, 1);
  const many = groupTiles({ creatorId: "u1", users: [user("u1"), user("u2")], employees: Array.from({ length: 10 }, (_, i) => employee("e" + i)) });
  assert.equal(many.tiles.length, 9);
  assert.equal(many.cols, 3);
  assert.equal(many.tiles[0].id, "u1");
});

test("mentionSegments splits a plain message into text and known @mentions", async () => {
  const { mentionSegments } = await import("../web/src/mention.js");
  const people = [{ id: "e1", name: "小A", link: true }, { id: "e2", name: "小AB", link: false }];
  assert.deepEqual(mentionSegments("@小AB 和 @小A，x@小A", people), [
    { text: "@小AB", id: "e2", link: false }, { text: " 和 " }, { text: "@小A", id: "e1", link: true }, { text: "，x@小A" },
  ]);
  assert.deepEqual(mentionSegments("没有提及", people), [{ text: "没有提及" }]);
});

test("taskHashQuery detects #query before the caret and ignores URL anchors/newlines", () => {
  assert.deepEqual(taskHashQuery("基于 #搜索 改一下", 6), { start: 3, query: "搜索" });
  assert.deepEqual(taskHashQuery("#", 1), { start: 0, query: "" });
  assert.deepEqual(taskHashQuery("继续#2", 4), { start: 2, query: "2" });
  assert.equal(taskHashQuery("https://example.com/a#sec", 25), null);
  assert.deepEqual(taskHashQuery("color #fff", 10), { start: 6, query: "fff" });
  assert.equal(taskHashQuery("#abc\ndef", 8), null);
  assert.equal(taskHashQuery("#" + "长".repeat(41), 42), null);
});

test("filterTasks and removeRange match by id, seq, text and clean up the query", () => {
  const tasks = [
    { id: "t-old", text: "历史导出报告", status: "done", chainSeq: 1, createdAt: 100 },
    { id: "t-mid", text: "修登录问题", title: "OAuth 回调修复", key: "tapd:998877", status: "running", chainSeq: 2, createdAt: 200 },
    { id: "t-new", text: "生成登录报告", status: "done", chainSeq: 3, createdAt: 300, branchLabel: "方案B" },
  ];
  assert.deepEqual(filterTasks(tasks, "").map((t: any) => t.id), ["t-mid", "t-new", "t-old"]);
  assert.deepEqual(filterTasks(tasks, "2").map((t: any) => t.id), ["t-mid"]);
  assert.deepEqual(filterTasks(tasks, "t-old").map((t: any) => t.id), ["t-old"]);
  assert.deepEqual(filterTasks(tasks, "OAuth").map((t: any) => t.id), ["t-mid"]);
  assert.deepEqual(filterTasks(tasks, "998877").map((t: any) => t.id), ["t-mid"]);
  assert.deepEqual(filterTasks(tasks, "方案B").map((t: any) => t.id), ["t-new"]);
  assert.deepEqual(removeRange("帮我把 #登录 改下", 4, 7), { text: "帮我把 改下", caret: 4 });
  assert.deepEqual(removeRange("#t-old", 0, 6), { text: "", caret: 0 });
});
