import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEE_MEMORY_RULES, EMPLOYEE_TASK_RULES, OWNER_RULES } from "../server/core/prompt";
import { VAULT_USAGE } from "../server/core/vault";

test("chat-provided credentials may be used for the current login without forcing the vault first", () => {
  assert.match(EMPLOYEE_TASK_RULES, /本轮对话已明确给出/);
  assert.match(EMPLOYEE_TASK_RULES, /可直接用于 chrome 填表\/登录/);
  assert.match(EMPLOYEE_TASK_RULES, /不必先写入密码本/);
  assert.match(EMPLOYEE_TASK_RULES, /未请你保存时不要把聊天凭据写入密码本/);
  assert.doesNotMatch(EMPLOYEE_MEMORY_RULES, /凭据只走密码本/);
  assert.match(EMPLOYEE_MEMORY_RULES, /凭据优先走密码本/);
  assert.match(OWNER_RULES, /本轮对话里明确给出的登录凭据可直接用于当前授权操作/);
  assert.match(VAULT_USAGE, /用户本轮已明文给出/);
  assert.match(VAULT_USAGE, /可直接填表，不必先入库/);
});
