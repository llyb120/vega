import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";
import { dutyCondition, dutyContent } from "../shared/duty-condition";

const app = readFileSync("web/src/App.vue", "utf8");
const source = readFileSync("web/src/EmployeeDuties.vue", "utf8");
const between = (start: string, end: string) => { const offset = source.indexOf(start); return source.slice(offset, source.indexOf(end, offset)); };
function mount() {
  const calls: any[] = [], error = ref("");
  const context: any = { ref, dutyCondition, dutyContent, selectedEmployee: ref("ea"), user: ref({ id: "admin" }), employeeAction: async (input: any) => { calls.push(input); }, attempt: async (fn: any) => { try { return await fn(); } catch (failure: any) { error.value = failure.message; } } };
  const save = vm.runInNewContext("(" + app.slice(app.indexOf("async function saveDuty("), app.indexOf("function removeDuty(")) + ")", context);
  context.props = { canManage: true, save };
  const methods = vm.runInNewContext(between("const open =", "</script>") + "\n({ emptyDuty: empty, editDuty: edit, saveDuty: submit, duty, dutySaving: saving, dutyOpen: open })", context);
  Object.assign(context, methods);
  return { calls, error, context, ...methods };
}

test("the responsibility editor has exactly trigger condition and responsibility content, with no extra scheduling controls", () => {
  const form = between('<form v-if="open && canManage"', "</form>");
  assert.equal((form.match(/<textarea\b/g) || []).length, 2);
  assert(!/<input\b|<select\b/.test(form));
  assert(form.indexOf("触发条件") < form.indexOf("职责内容"));
  assert(!form.includes("duty.note") && !form.includes("duty.enabled") && !form.includes("duty.profile"));
  assert(source.includes("dutyCondition(d)") && source.includes("dutyContent(d)"));
  assert.match(app, /<EmployeeDuties :key="selectedEmployee"[^>]*:save="saveDuty"/);
  assert.match(source, /save\(\{ action: 'update', id: d.id, enabled: !d.enabled \}\)/);
});

test("a read-only responsibility editor cannot submit changes", async () => {
  const state = mount();
  state.editDuty({ text: "只读职责", manual: true });
  state.context.props.canManage = false;
  await state.saveDuty();
  assert.equal(state.calls.length, 0);
});

test("legacy supplemental requirements stay editable in the single content box and saving does not reset enabled state or expose schedule fields", async () => {
  const state = mount();
  state.editDuty({ id: "d1", text: "原职责", note: "旧补充要求", times: ["09:00"], enabled: false });
  assert.match(state.context.duty.value.condition, /每天 09:00/);
  assert.match(state.context.duty.value.text, /原职责\n\n补充要求：\n旧补充要求/);
  await state.saveDuty();
  const payload = state.calls[0];
  assert.equal(payload.note, ""); assert.equal(payload.condition, "每天 09:00（北京时间）");
  assert(payload.text.includes("旧补充要求"));
  for (const key of ["enabled", "profile", "manual", "times", "everyMinutes", "events", "nextAt"]) assert(!Object.hasOwn(payload, key), key);
  assert.equal(state.context.dutyOpen.value, false);
});

test("unrecognized trigger failures preserve both input boxes and release the save button", async () => {
  const state = mount();
  state.editDuty({ id: "d1", condition: "外部事件发生时", text: "原职责内容" });
  state.context.employeeAction = async () => { throw Error("请写明检查频率"); };
  await state.saveDuty();
  assert.equal(state.error.value, "请写明检查频率");
  assert.equal(state.context.duty.value.condition, "外部事件发生时");
  assert.equal(state.context.duty.value.text, "原职责内容");
  assert.equal(state.context.dutyOpen.value, true); assert.equal(state.context.dutySaving.value, false);
});

test("a slow trigger save is not submitted twice and cannot clear a different employee's or account's draft", async () => {
  const state = mount(); let finish!: () => void;
  state.editDuty({ text: "旧职责", manual: true });
  state.context.employeeAction = async (input: any) => { state.calls.push(input); await new Promise<void>(resolve => finish = resolve); };
  const pending = state.saveDuty(); await state.saveDuty();
  assert.equal(state.calls.length, 1);
  const draft = { condition: "每天10点", text: "另一牛马草稿" };
  state.context.selectedEmployee.value = "eb"; state.context.duty.value = draft;
  finish(); await pending;
  assert.equal(state.context.duty.value.text, draft.text); assert.equal(state.context.dutyOpen.value, true);
  assert.equal(state.context.dutySaving.value, false);

  let reject!: (reason: Error) => void;
  state.context.employeeAction = async () => { await new Promise<void>((_resolve, fail) => reject = fail); };
  const oldAccount = state.saveDuty(); state.context.user.value = { id: "another" };
  state.context.duty.value = { condition: "按需", text: "新账号草稿" };
  reject(Error("old account private trigger error")); await oldAccount;
  assert.equal(state.error.value, ""); assert.equal(state.context.duty.value.text, "新账号草稿");
});
