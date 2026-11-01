import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";
const source = readFileSync("web/src/App.vue", "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

test("employee deletion requires confirmation, removes only its own draft and chooses a remaining employee", async () => {
  const calls: any[] = [], context: any = {
    employee: ref({ id: "ea", name: "Delete" }), selectedEmployee: ref("ea"), employeeDeleting: ref(false),
    employeeComposers: ref({ ea: { text: "delete draft" }, eb: { text: "keep draft" } }), employeeSession: ref(""), employeeTab: ref("settings"), employeeError: ref(""),
    confirm: () => false, api: async (...args: any[]) => calls.push(args), toast() {},
  };
  context.loadEmployee = async () => { context.selectedEmployee.value = "eb"; context.employee.value = { id: "eb", name: "Keep" }; };
  const remove = vm.runInNewContext(between("async function deleteEmployee()", "async function employeeTaskAction") + "\ndeleteEmployee", context);
  await remove(); assert.equal(calls.length, 0);
  context.confirm = () => true;
  await remove();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["/employees/ea?confirmed=true", "DELETE"]);
  assert.equal(context.employeeComposers.value.ea, undefined);
  assert.equal(context.employeeComposers.value.eb.text, "keep draft");
  assert.equal(context.selectedEmployee.value, "eb");
  assert.equal(context.employeeDeleting.value, false);
});

test("execution switch never overwrites a different employee selected while defaults are being validated", async () => {
  let finish!: (value: any) => void;
  const response = new Promise((resolve) => finish = resolve);
  const calls: any[] = [];
  const context: any = {
    selectedEmployee: ref("ea"), employeeExecutionBusy: ref(false), employeeError: ref(""), employee: ref({ id: "ea", executionClients: [{ id: "client-a" }] }), toast() {},
    api: async (path: string, method = "GET", data?: any) => { calls.push({ path, method, data }); return method === "POST" ? {} : response; },
  };
  const change = vm.runInNewContext(between("async function changeEmployeeExecution(", "async function employeeTabChanged") + "\nchangeEmployeeExecution", context);
  const changing = change(true, "client-a");
  await Promise.resolve();
  context.selectedEmployee.value = "eb";
  context.employee.value = { id: "eb", name: "Keep" };
  finish({ id: "ea", execution: { localAgent: true } });
  await changing;
  assert.equal(context.employee.value.id, "eb");
  assert.equal(calls[0].path, "/employees/ea/execution");
  assert.equal(calls[0].data.localAgent, true);
});

test("ordinary users have no history/session dispatch navigation and task approvals have explicit reject and approve actions", () => {
  const nav = between('<nav aria-label="主导航"', "</nav>");
  assert(!nav.includes("历史") && !nav.includes("新建会话"));
  assert(nav.includes('v-if="isAdmin"') && nav.includes("调试会话"));
  assert(!source.includes('v-model="employee.enabled"'));
  assert(!source.includes('v-model="employee.workStart"'));
  const task = readFileSync("web/src/EmployeeTaskCard.vue", "utf8");
  assert(task.includes("run('approve')") && task.includes("run('reject')"));
  assert(task.includes("task.execution?.localAgent"));
});
