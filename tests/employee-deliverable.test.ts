import test from "node:test";
import assert from "node:assert/strict";
import { pickDeliverable } from "../server/core/employee";
import { MEMORY_CLAIM_MAX } from "../server/core/memory";

const body = "# 测试用例清单\n" + "TC-01 指标卡标题取管理端配置。\n".repeat(30);

test("complete keeps the deliverable body written beside a tool call", () => {
  const messages: any[] = [
    { role: "user", text: "[牛马任务] 派单" },
    { role: "assistant", model: "m", text: body, calls: [{ id: "1", name: "employee", arguments: { action: "progress" } }] },
    { role: "tool", text: "{\"ok\":true}" },
    { role: "assistant", model: "m", text: "", calls: [{ id: "2", name: "employee", arguments: { action: "complete" } }] },
  ];
  assert.equal(pickDeliverable(messages, ["证据", "摘要"]), body.trim());
});

test("deliverable ignores scheduler notes, short text and evidence copies", () => {
  const messages: any[] = [
    { role: "user", text: "派单" },
    { role: "assistant", text: body },
    { role: "assistant", model: "m", text: "好的，开始。" },
    { role: "assistant", model: "m", text: body + "x" },
  ];
  assert.equal(pickDeliverable(messages, [body + "x"]), "");
});

test("deliverable falls back to an earlier run when the current run only completes", () => {
  const messages: any[] = [
    { role: "user", text: "派单" },
    { role: "assistant", model: "m", text: body },
    { role: "user", text: "[续做]" },
    { role: "assistant", model: "m", text: "", calls: [{ id: "c", name: "employee", arguments: {} }] },
  ];
  assert.equal(pickDeliverable(messages), body.trim());
});

test("memory claim limit fits path-heavy environment facts", () => {
  assert.equal(MEMORY_CLAIM_MAX, 200);
});
