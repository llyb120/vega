import { test } from "node:test";
import assert from "node:assert/strict";
import { filterColleagues, insertMention, mentionQuery, moveActive } from "../web/src/mention.js";

const people = [
  { id: "1", name: "发布助手", publicSummary: "发布", acceptsColleagues: true },
  { id: "2", name: "Data Bot", publicSummary: "", acceptsColleagues: false },
  { id: "3", name: "数据助手", publicSummary: "数据" },
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

test("filterColleagues: prefix before substring, case-insensitive, disabled after enabled", () => {
  assert.deepEqual(filterColleagues(people, "").map((c: any) => c.id), ["1", "3", "4", "2"]);
  assert.deepEqual(filterColleagues(people, "DATA").map((c: any) => c.id), ["4", "2"]);
  assert.deepEqual(filterColleagues(people, "助手").map((c: any) => c.id), ["1", "3"]);
  assert.deepEqual(filterColleagues(people, "数").map((c: any) => c.id), ["3"]);
  assert.deepEqual(filterColleagues(people, "nobody"), []);
});

test("insertMention replaces the query with @名称 and a single space, caret after it", () => {
  assert.deepEqual(insertMention("交给 @发 处理", 3, 5, "发布助手"), { text: "交给 @发布助手 处理", caret: 9 });
  assert.deepEqual(insertMention("@", 0, 1, "Data Bot"), { text: "@Data Bot ", caret: 10 });
});

test("moveActive wraps and skips disabled colleagues", () => {
  const items = filterColleagues(people, "");
  assert.equal(moveActive(items, -1, 1), 0);
  assert.equal(moveActive(items, 2, 1), 0); // index 3 is disabled
  assert.equal(moveActive(items, 0, -1), 2);
  assert.equal(moveActive([{ acceptsColleagues: false }], -1, 1), -1);
});
