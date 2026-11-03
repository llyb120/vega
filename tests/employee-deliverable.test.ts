import test from "node:test";
import assert from "node:assert/strict";
import { resolveDeliverable } from "../server/core/employee";
import { MEMORY_CLAIM_MAX } from "../server/core/memory";
import { employeeCall } from "./public-call";

const body = "# 测试用例清单\n" + "TC-01 指标卡标题取管理端配置。\n".repeat(30);
const session: any[] = [
  { seq: 1, role: "user", text: "[牛马任务] 派单" },
  { seq: 2, role: "assistant", model: "m", text: "先勘察页面。", calls: [{ id: "a", name: "chrome_inspect", arguments: {} }] },
  { seq: 3, role: "tool", text: "{\"ok\":true}" },
  { seq: 4, role: "assistant", model: "m", text: body, calls: [{ id: "b", ...employeeCall({ action: "progress" }) }] },
  { seq: 5, role: "tool", text: "{\"ok\":true}" },
  { seq: 6, role: "assistant", text: "本轮未完成，将在原会话恢复。" },
  { seq: 7, role: "assistant", model: "m", text: "", calls: [{ id: "c", ...employeeCall({ action: "complete" }) }] },
];

test("complete must declare the deliverable and gets candidates when it does not", () => {
  const r = resolveDeliverable(session, undefined);
  assert.match(r.error!, /deliverableRef/);
  assert.match(r.error!, /#4（/);
  assert.doesNotMatch(r.error!, /#6/, "scheduler notes are not candidates");
});

test("cited replies are returned verbatim in the cited order", () => {
  for (const ref of [[4], ["#4"], 4]) assert.deepEqual(resolveDeliverable(session, ref).texts, [body.trim()]);
  assert.deepEqual(resolveDeliverable(session, [4, 2]).texts, [body.trim(), "先勘察页面。"]);
  assert.deepEqual(resolveDeliverable(session, []).texts, []);
});

test("tool results, scheduler notes and empty replies cannot be cited", () => {
  for (const ref of [[3], [6], [7], [99], ["x"]]) assert.ok(resolveDeliverable(session, ref).error, JSON.stringify(ref));
});

test("a longer reply written after the cited one is surfaced as a possible newer version", () => {
  const later = [...session, { seq: 8, role: "assistant", model: "m", text: body + "TC-26 新增。" }];
  assert.deepEqual(resolveDeliverable(later, [4]).later.map((m) => m.seq), [8]);
  assert.deepEqual(resolveDeliverable(later, [8]).later, []);
});

test("memory claim limit fits path-heavy environment facts", () => {
  assert.equal(MEMORY_CLAIM_MAX, 200);
});
