import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";
const source = readFileSync("web/src/App.vue", "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

function employeeWorkspace(url = "https://vega.test/", list = [{ id: "ea", activeTasks: 0 }, { id: "eb", activeTasks: 0 }]) {
  const calls: string[] = [], navigation: string[] = [], location = { href: url };
  const window = { location, history: {
    pushState: (_state: any, _title: string, next: string) => { location.href = next; navigation.push("push"); },
    replaceState: (_state: any, _title: string, next: string) => { location.href = next; navigation.push("replace"); },
  } };
  const context: any = {
    URL, window, user: ref({ id: "alice" }), selectedEmployee: ref(""), employees: ref([]), activeTaskCount: ref(0), employee: ref({}),
    employeeSession: ref(""), employeeEvent: ref(null), employeeTab: ref("chat"), employeeExecutionOpen: ref(false),
    employeeTaskFilter: ref("active"), employeeTaskFocus: ref(""), dutyOpen: ref(false), memoryID: ref(""), taskText: ref(""), employeeError: ref(""),
    employeeComposers: ref({}), creatingEmployee: ref(false), view: ref("employee"), closeNavigation() {},
    api: async (path: string) => { calls.push(path); return path === "/employees" ? list : { id: path.split("/").at(-1) }; },
  };
  const methods = vm.runInNewContext(between("function employeeLocationChanged()", "function employeeApi(") + between("async function chooseEmployee(", "async function createEmployee(") + "\n({ loadEmployee, chooseEmployee, employeeLocationChanged })", context);
  context.refreshEmployee = methods.loadEmployee;
  return { ...context, ...methods, calls, navigation, location };
}

test("employee URLs distinguish workspaces and survive refresh or opening a shared link", async () => {
  const first = employeeWorkspace("https://vega.test/?keep=1#anchor");
  await first.loadEmployee();
  assert.equal(new URL(first.location.href).searchParams.get("employee"), "ea");
  await first.chooseEmployee("eb");
  assert.equal(first.location.href, "https://vega.test/?keep=1&employee=eb#anchor");
  assert.deepEqual(first.navigation, ["replace", "push"]);
  const refreshed = employeeWorkspace(first.location.href);
  await refreshed.loadEmployee();
  assert.equal(refreshed.selectedEmployee.value, "eb");
  assert.equal(refreshed.employee.value.id, "eb");
  assert.deepEqual(refreshed.calls, ["/employees", "/employees/eb"]);
  assert.equal(refreshed.navigation.length, 0, "loading an existing link does not add redundant history entries");
});

test("an inaccessible or deleted employee URL falls back only after checking the visible list", async () => {
  const state = employeeWorkspace("https://vega.test/?employee=hidden", [{ id: "ea", activeTasks: 0 }]);
  await state.loadEmployee();
  assert.equal(state.selectedEmployee.value, "ea");
  assert.equal(new URL(state.location.href).searchParams.get("employee"), "ea");
  assert(!state.calls.includes("/employees/hidden"), "URL IDs are not authorization to read another employee");
  const empty = employeeWorkspace("https://vega.test/?employee=hidden&keep=1", []);
  await empty.loadEmployee();
  assert.equal(empty.selectedEmployee.value, "");
  assert.equal(empty.location.href, "https://vega.test/?keep=1");
  assert.deepEqual(empty.calls, ["/employees"]);
});

test("browser back and forward restore the employee from the URL without adding history", async () => {
  const state = employeeWorkspace("https://vega.test/?employee=ea");
  await state.loadEmployee();
  await state.chooseEmployee("eb");
  state.location.href = "https://vega.test/?employee=ea";
  await state.employeeLocationChanged();
  assert.equal(state.selectedEmployee.value, "ea");
  assert.equal(state.employee.value.id, "ea");
  state.location.href = "https://vega.test/?employee=eb";
  await state.employeeLocationChanged();
  assert.equal(state.employee.value.id, "eb");
  assert.deepEqual(state.navigation, ["push"]);
  assert(source.includes('window.addEventListener("popstate", employeeLocationChanged)'));
  assert(source.includes('window.removeEventListener("popstate", employeeLocationChanged)'));
});

test("an employee link remains intact through login and is resolved after authentication", async () => {
  const state = employeeWorkspace("https://vega.test/?employee=eb");
  state.user.value = null;
  await state.loadEmployee();
  assert.equal(state.calls.length, 0);
  assert.equal(state.location.href, "https://vega.test/?employee=eb");
  state.user.value = { id: "bob" };
  await state.loadEmployee();
  assert.equal(state.employee.value.id, "eb");
});

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

test("chat task links reveal the matching task and refresh stale lists without jumping across employees", async () => {
  const card = { dataset: { taskId: "task" }, scrollIntoView() {}, focus() {} };
  const context: any = { selectedEmployee: ref("ea"), employee: ref({ tasks: [] }), employeeTaskFilter: ref("active"), employeeTaskFocus: ref(""), employeeTab: ref("chat"), ended: (status: string) => status === "done", nextTick: async () => {}, document: { querySelectorAll: () => [card] }, toast() {} };
  context.refreshEmployee = async () => { context.employee.value = { tasks: [{ id: "task", status: "done" }] }; };
  const open = vm.runInNewContext(between("async function openEmployeeTask(", "async function employeeTabChanged(") + "\nopenEmployeeTask", context);
  await open("task");
  assert.equal(context.employeeTab.value, "tasks");
  assert.equal(context.employeeTaskFilter.value, "history");
  assert.equal(context.employeeTaskFocus.value, "task");
  context.employee.value = { tasks: [] }; context.employeeTab.value = "chat";
  context.refreshEmployee = async () => { context.selectedEmployee.value = "eb"; };
  await open("task");
  assert.equal(context.employeeTab.value, "chat");
});

test("employee task creation never asks users to choose the initial model", () => {
  assert(!source.includes("taskProfile") && !source.includes('v-model="duty.profile"'));
  assert(source.includes("新任务先由轻量模型起步"));
  const scenes = readFileSync("web/src/SceneSettings.vue", "utf8");
  assert(scenes.includes("沟通与任务起步") && scenes.includes("实际进入编码工作时才升级"));
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
