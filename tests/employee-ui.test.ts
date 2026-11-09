import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";
const source = readFileSync("web/src/App.vue", "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

function employeeWorkspace(requested = "", list = [{ id: "ea", activeTasks: 0 }, { id: "eb", activeTasks: 0 }]) {
  const calls: string[] = [];
  const context: any = {
    user: ref({ id: "alice" }), selectedEmployee: ref(requested), employees: ref([]), activeTaskCount: ref(0), employee: ref({}),
    employeeSessionVersion: ref(0), pruneChatCache: async () => {},
    employeeSession: ref(""), employeeEvent: ref(null), employeeTab: ref("chat"), employeeExecutionOpen: ref(false),
    employeeTaskFilter: ref("active"), employeeTaskFocus: ref(""), dutyOpen: ref(false), memoryID: ref(""), taskText: ref(""), employeeError: ref(""),
    employeeComposers: ref({}), creatingEmployee: ref(false), view: ref("employee"), closeNavigation() {},
    api: async (path: string) => { calls.push(path); return path === "/employees" ? list : { id: path.split("/").at(-1) }; },
  };
  const methods = vm.runInNewContext(between("let employeeLoadVersion =", "function employeeApi(") + between("async function chooseEmployee(", "async function createEmployee(") + "\n({ loadEmployee, chooseEmployee })", context);
  context.refreshEmployee = methods.loadEmployee;
  return { ...context, ...methods, calls, setApi: (api: any) => { context.api = api; }, setPrune: (prune: any) => { context.pruneChatCache = prune; } };
}

test("a requested employee (from the address bar) is loaded directly on refresh", async () => {
  const refreshed = employeeWorkspace("eb");
  await refreshed.loadEmployee();
  assert.equal(refreshed.selectedEmployee.value, "eb");
  assert.equal(refreshed.employee.value.id, "eb");
  assert.deepEqual(refreshed.calls, ["/employees", "/employees/eb"]);
  const first = employeeWorkspace();
  await first.loadEmployee();
  assert.equal(first.selectedEmployee.value, "ea", "no request: the first visible employee");
});

test("switching to a known bot mounts its cached chat before workspace requests finish", async () => {
  const state = employeeWorkspace();
  await state.loadEmployee();
  let release!: (value: any) => void;
  state.setApi((path: string) => path === "/employees" ? new Promise((resolve) => release = resolve) : Promise.resolve({ id: "eb" }));
  const choosing = state.chooseEmployee("eb");
  assert.equal(state.employee.value.id, "eb");
  assert.equal(state.employeeComposers.value.eb.text, "");
  assert.equal(state.employee.value.canManage, false, "management waits for fresh authorized details");
  release([{ id: "ea", activeTasks: 0 }, { id: "eb", activeTasks: 0 }]);
  await choosing;
});

test("successful bot-list refresh prunes deleted bots; stale lists cannot undo a newer selection", async () => {
  const state = employeeWorkspace();
  await state.loadEmployee();
  const pruned: any[] = [];
  state.setPrune(async (...args: any[]) => pruned.push(args));
  let release!: (value: any) => void, lists = 0;
  state.setApi((path: string) => {
    if (path !== "/employees") return Promise.resolve({ id: "eb" });
    if (++lists === 1) return new Promise((resolve) => release = resolve);
    return Promise.resolve([{ id: "eb", activeTasks: 0 }]);
  });
  const stale = state.loadEmployee();
  await state.chooseEmployee("eb");
  release([{ id: "ea", activeTasks: 0 }]);
  await stale;
  assert.equal(state.selectedEmployee.value, "eb");
  assert.deepEqual(pruned.map(([user, ids]) => [user, Array.from(ids)]), [["alice", ["eb"]]]);
});

test("an inaccessible or deleted employee URL falls back only after checking the visible list", async () => {
  const state = employeeWorkspace("hidden", [{ id: "ea", activeTasks: 0 }]);
  await state.loadEmployee();
  assert.equal(state.selectedEmployee.value, "ea");
  assert(!state.calls.includes("/employees/hidden"), "URL IDs are not authorization to read another employee");
  const empty = employeeWorkspace("hidden", []);
  await empty.loadEmployee();
  assert.equal(empty.selectedEmployee.value, "");
  assert.deepEqual(empty.calls, ["/employees"]);
});

test("an employee link remains intact through login and is resolved after authentication", async () => {
  const state = employeeWorkspace("eb");
  state.user.value = null;
  await state.loadEmployee();
  assert.equal(state.calls.length, 0);
  assert.equal(state.selectedEmployee.value, "eb");
  state.user.value = { id: "bob" };
  await state.loadEmployee();
  assert.equal(state.employee.value.id, "eb");
});

test("employee deletion requires confirmation, removes only its own draft and chooses a remaining employee", async () => {
  const calls: any[] = [], cleared: any[] = [], context: any = {
    employee: ref({ id: "ea", name: "Delete" }), selectedEmployee: ref("ea"), employeeDeleting: ref(false),
    user: ref({ id: "alice" }), employeeLoadVersion: 0, clearChatCache: async (...args: any[]) => cleared.push(args),
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
  assert.deepEqual(cleared, [["alice", "ea"]]);
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

test("employee task lists direct new work to chat without a separate creation form", () => {
  const tasks = readFileSync("web/src/EmployeeTasks.vue", "utf8");
  assert(!tasks.includes("<form") && !tasks.includes('aria-label="新任务"'));
  assert(!tasks.includes("task-add") && !tasks.includes("上方直接创建任务"));
  assert(tasks.includes("在对话中交代工作。") && tasks.includes("emit('chat')"));
  assert(!source.includes(':add="addTask"') && !source.includes(":can-create="));
});

test("employee task creation never asks users to choose the initial model", () => {
  const workspace = source + ["EmployeeTasks", "EmployeeDuties", "TaskDetail", "WorkPanel"].map((file) => readFileSync(`web/src/${file}.vue`, "utf8")).join("\n");
  assert(!workspace.includes("taskProfile") && !workspace.includes('v-model="duty.profile"'));
  assert(readFileSync("web/src/EmployeeTasks.vue", "utf8").includes("新任务先由轻量模型起步"));
  const scenes = readFileSync("web/src/SceneSettings.vue", "utf8");
  assert(scenes.includes("沟通与任务起步") && scenes.includes("实际进入编码工作时才升级"));
});

test("work panel attention cards summarize long briefs and leave full detail to the opened task", () => {
  const panel = readFileSync("web/src/WorkPanel.vue", "utf8");
  assert(panel.includes("function brief(") && panel.includes("brief(task.text)"), "titles must be summarized");
  assert(panel.includes("brief(task.status === 'approval' ? task.approval : task.waiting"), "approval/waiting bodies must be summarized");
  assert(panel.includes('查看详情') && panel.includes("emit('open', task.id)"), "users open the task for the full brief");
  assert(panel.includes("-webkit-line-clamp: 2") && panel.includes("-webkit-line-clamp: 3"), "CSS clamps keep cards scannable");
  assert(!panel.match(/attention-text[^}]*white-space:\s*pre-wrap/), "pre-wrap would expand the whole brief in the panel");
});

test("ordinary users have no history/session dispatch navigation and task approvals have explicit reject and approve actions", () => {
  const sidebar = readFileSync("web/src/AppSidebar.vue", "utf8");
  const nav = sidebar.slice(sidebar.indexOf('aria-label="主导航"'), sidebar.indexOf("</nav>"));
  const adminNav = sidebar.slice(sidebar.indexOf("const adminNav ="), sidebar.indexOf("\n", sidebar.indexOf("const adminNav =")));
  assert(!nav.includes("历史") && !nav.includes("新建会话") && !adminNav.includes("历史"));
  assert(nav.includes('v-if="isAdmin"') && adminNav.includes("调试会话"));
  const settings = readFileSync("web/src/EmployeeSettings.vue", "utf8");
  assert(!source.includes('v-model="employee.enabled"') && !settings.includes('v-model="employee.enabled"'));
  assert(!source.includes('v-model="employee.workStart"') && !settings.includes('v-model="employee.workStart"'));
  for (const file of ["TaskDetail", "WorkPanel"]) {
    const task = readFileSync(`web/src/${file}.vue`, "utf8");
    assert(task.includes("'approve')") && task.includes("'reject')"));
  }
  assert(readFileSync("web/src/TaskDetail.vue", "utf8").includes("task.execution?.localAgent"));
});
