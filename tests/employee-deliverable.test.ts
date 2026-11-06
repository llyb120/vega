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
  { seq: 5, role: "tool", text: "{\"ok\":true,\"textRef\":4}" },
  { seq: 6, role: "assistant", text: "本轮未完成，将在原会话恢复。" },
  { seq: 7, role: "assistant", model: "m", text: "", calls: [{ id: "c", ...employeeCall({ action: "complete" }) }] },
];

test("omitted deliverableRefs auto-picks the latest substantial authored body", () => {
  const r = resolveDeliverable(session, undefined);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.auto, true);
  assert.deepEqual(r.refs, [4]);
  assert.deepEqual(r.texts, [body.trim()]);
});

test("omitted refs with no substantial body become an empty citation", () => {
  const short = session.filter((m) => m.seq !== 4);
  const r = resolveDeliverable(short, undefined);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.refs, []);
  assert.equal(r.auto, true);
});

test("cited replies are returned verbatim in the cited order", () => {
  for (const ref of [[4], ["#4"], 4]) assert.deepEqual(resolveDeliverable(session, ref).texts, [body.trim()]);
  assert.deepEqual(resolveDeliverable(session, [4, 2]).texts, [body.trim(), "先勘察页面。"]);
  assert.deepEqual(resolveDeliverable(session, []).texts, []);
});

test("tool results without textRef, scheduler notes and empty replies cannot be cited", () => {
  for (const ref of [[3], [6], [7], [99], ["x"]]) assert.ok(resolveDeliverable(session, ref).error, JSON.stringify(ref));
});

test("progress tool receipt with textRef remaps to the assistant body and completes", () => {
  const r = resolveDeliverable(session, [5]);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.refs, [4]);
  assert.deepEqual(r.texts, [body.trim()]);
  assert.deepEqual(r.remapped, ["#5→#4"]);
});

test("error hints say to retry task_complete with legal refs, not progress", () => {
  const r = resolveDeliverable(session, [3]);
  assert.match(r.error!, /立即再调 task_complete/);
  assert.match(r.error!, /不要改用 task_progress/);
});

test("a longer reply written after the cited one auto-upgrades to that newer body", () => {
  const later = [...session, { seq: 8, role: "assistant", model: "m", text: body + "TC-26 新增。" }];
  const upgraded = resolveDeliverable(later, [4]);
  assert.equal(upgraded.upgraded, true);
  assert.deepEqual(upgraded.refs, [8]);
  assert.deepEqual(upgraded.later, []);
  assert.deepEqual(resolveDeliverable(later, [8]).refs, [8]);
  // Remapped tool receipt also upgrades past the older body
  assert.deepEqual(resolveDeliverable(later, [5]).refs, [8]);
});

test("explicit empty deliverableRefs stay empty even when bodies exist", () => {
  assert.deepEqual(resolveDeliverable(session, []).refs, []);
  assert.equal(resolveDeliverable(session, []).auto, undefined);
});

test("memory claim limit fits path-heavy environment facts", () => {
  assert.equal(MEMORY_CLAIM_MAX, 200);
});
