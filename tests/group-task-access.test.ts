import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { Auth } from "../server/core/auth";
import type { Task } from "../server/core/employee";

const owner = { id: "u1", role: "operator" }, requester = { id: "u2", role: "operator" }, member = { id: "u3", role: "operator" }, viewer = { id: "u4", role: "viewer" };
async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  for (const user of [owner, requester, member, viewer])
    await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", user.id, "user-" + user.id, "unused", user.role, 0, Date.now(), 0);
  await store.put("config", { scenes: { lightweight: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "热心市民小周" }, owner.id)).id);
  const group = await engine.groups.create(member, { name: "协作", users: [owner.id, requester.id, viewer.id] });
  await engine.groups.addEmployee(owner, group.id, employee.employeeId);
  const shared: Task = { id: "task-shared", text: "群内请求", status: "waiting", createdAt: 1, profile: "lightweight", cwd: process.cwd(), owner: { token: "", name: "owner" }, waiting: "请补充", workSession: "private-session", memorySuggestions: [{ claim: "private" }],
    group: { groupId: group.id, name: group.name, hop: 0, requester: { kind: "user", id: requester.id, name: "requester" }, byOwner: false } };
  await employee.update((state) => { state.tasks.push(shared, { ...shared, id: "task-private", text: "私聊任务", group: undefined }); });
  const reset = async (status: string) => employee.update((state) => { Object.assign(employee.task(state, shared.id), { status, waiting: "请补充", approval: "批准操作", partialDelivery: undefined }); });
  const close = async () => { await engine.close(); await store.close(); };
  return { store, engine, employee, group, shared, reset, close };
}

test("group task access: members may read, only the original requester and employee owner may operate", async () => {
  const { engine, employee, group, shared, close } = await fixture();
  try {
    for (const [user, canControl] of [[owner, true], [requester, true], [member, false], [viewer, false]] as const) {
      const detail = await engine.groups.task(user, group.id, employee.employeeId, shared.id);
      assert.equal(detail.canControl, canControl);
      assert.equal(detail.waiting, "请补充");
      const board = await engine.groups.tasks(user, group.id);
      assert.equal(board.members[0].tasks[0].canControl, canControl, "board and direct detail use the same policy");
      if (user !== owner) for (const field of ["owner", "cwd", "workSession", "execution", "memorySuggestions"])
        assert.equal(detail[field], undefined, "private field: " + field);
    }
    assert.equal((await engine.groups.task(owner, group.id, employee.employeeId, shared.id)).workSession, "private-session");
    for (const user of [member, viewer]) await assert.rejects(engine.groups.controlTask(user, group.id, employee.employeeId, shared.id, { action: "stop" }), { statusCode: 403 });
    await assert.rejects(engine.groups.task({ id: "outsider", role: "admin" }, group.id, employee.employeeId, shared.id), /群聊不存在/);
    await assert.rejects(engine.groups.task(requester, group.id, employee.employeeId, "task-private"), { statusCode: 404 });
    await assert.rejects(engine.groups.task(requester, group.id, "another-employee", shared.id), { statusCode: 404 });
    const other = await engine.groups.create(member, { name: "另一个群", users: [owner.id, requester.id] });
    await engine.groups.addEmployee(owner, other.id, employee.employeeId);
    await assert.rejects(engine.groups.task(requester, other.id, employee.employeeId, shared.id), { statusCode: 404 });
    await assert.rejects(engine.groups.controlTask(requester, group.id, employee.employeeId, shared.id, { action: "settings", name: "hijack" }), { statusCode: 400 });
    assert.equal((await employee.findTask(shared.id))!.status, "waiting");
  } finally { await close(); }
});

test("older task links resolve directly even after they leave the recent work panel", async () => {
  const { engine, employee, group, shared, close } = await fixture();
  try {
    await employee.update((state) => {
      employee.task(state, shared.id).status = "done";
      for (let i = 0; i < 21; i++) state.tasks.push({ ...shared, id: "recent-" + i, status: "done", createdAt: 100 + i });
    });
    const board = await engine.groups.tasks(requester, group.id);
    assert(!board.members[0].tasks.some((task) => task.id === shared.id));
    assert.equal((await engine.groups.task(requester, group.id, employee.employeeId, shared.id)).id, shared.id);
  } finally { await close(); }
});

test("requesters can answer, approve, stop, resume and explicitly redispatch their own group task", async () => {
  const { engine, employee, group, shared, reset, close } = await fixture();
  const control = (input: Record<string, unknown>, user = requester) => engine.groups.controlTask(user, group.id, employee.employeeId, shared.id, input);
  try {
    await control({ action: "answer", text: "使用测试环境" });
    assert.equal((await employee.findTask(shared.id))!.status, "queued");
    assert.match((await employee.findTask(shared.id))!.answer, /使用测试环境/);
    await reset("approval");
    await control({ action: "approve", approved: true });
    assert.equal((await employee.findTask(shared.id))!.status, "queued");
    await reset("approval");
    await control({ action: "approve", approved: false });
    assert.equal((await employee.findTask(shared.id))!.status, "cancelled");
    await assert.rejects(control({ action: "resume" }), /Only stopped\/failed tasks may continue/);
    await reset("stopped");
    await control({ action: "resume" });
    assert.equal((await employee.findTask(shared.id))!.status, "queued");
    await control({ action: "stop", id: "task-private" }, owner);
    assert.equal((await employee.findTask(shared.id))!.status, "stopped");
    assert.equal((await employee.findTask("task-private"))!.status, "waiting", "body cannot override the authorized task id");
    await assert.rejects(control({ action: "redispatch" }), /Explicit confirmation/);
    const copy = await control({ action: "redispatch", confirmed: true });
    const copied = (await employee.findTask(copy.id))!;
    assert.equal(copied.group?.requester.id, requester.id);
    assert.equal(copied.group?.groupId, group.id, "redispatched work keeps its reporting and access scope");
    assert.equal((await engine.groups.task(requester, group.id, employee.employeeId, copy.id)).canControl, true);
    await control({ action: "seal", manual: true });
    await assert.rejects(control({ action: "resume" }), /已封存/);
    await control({ action: "remove" });
    assert.equal(await employee.findTask(shared.id), undefined);
  } finally { await close(); }
});

test("group chat task commands enforce the same authority and never replace the original requester", async () => {
  const { store, engine, employee, group, shared, reset, close } = await fixture();
  try {
    const session = await store.newSession({ employeeId: employee.employeeId, groupId: group.id, ownerId: owner.id });
    const config = await engine.config(), model = await engine.catalog.resolve(config, "fixture/model");
    const tools = await Tools.create(engine, session, config, new AbortController().signal, () => {});
    const source = async (user: typeof owner, byOwner: boolean) => store.append(session.id, { role: "user", text: "继续这个任务", group: { groupId: group.id, name: group.name, seq: 1, from: { kind: "user", id: user.id, name: user.id }, byOwner } });
    await reset("stopped");
    await source(owner, true);
    await tools.execute({ id: "owner-followup", name: "employee_task_manage", arguments: { taskId: shared.id, request: { command: "resume", supplement: "补充验收要求" } } }, model);
    assert.equal((await employee.findTask(shared.id))!.group?.requester.id, requester.id, "owner follow-up is not a new task assignment");
    await source(member, false);
    await assert.rejects(tools.execute({ id: "other-stop", name: "employee_task_manage", arguments: { taskId: shared.id, request: { command: "stop" } } }, model), /只有任务发起人或负责该任务的热心市民的归属用户/);
    await source(requester, false);
    await tools.execute({ id: "requester-stop", name: "employee_task_manage", arguments: { taskId: shared.id, request: { command: "stop" } } }, model);
    assert.equal((await employee.findTask(shared.id))!.status, "stopped");
    await employee.update((state) => { employee.task(state, "task-private").key = "private-key"; });
    await assert.rejects(tools.execute({ id: "private-dedupe", name: "employee_task_create", arguments: { instructions: "新请求", dedupeKey: "private-key" } }, model), /不能通过去重键接管/);
    assert.equal((await employee.findTask("task-private"))!.group, undefined);
    await assert.rejects(tools.execute({ id: "private-stop", name: "employee_task_manage", arguments: { taskId: "task-private", request: { command: "stop" } } }, model), /群任务不存在/);
  } finally { await close(); }
});

test("task screenshots are shared only within that task and current group membership; raw sessions remain private", async () => {
  const { store, engine, employee, group, shared, close } = await fixture();
  try {
    const auth = new Auth(store, "fixture-token-at-least-16-characters");
    const parts = ["employees", employee.employeeId, shared.id, "shot.webp"];
    for (const user of [owner, requester, member, viewer]) assert(await auth.canFile(user as any, parts));
    assert(!await auth.canFile({ id: "outside", role: "admin" } as any, parts));
    assert(!await auth.canFile(requester as any, ["employees", employee.employeeId, "task-private", "shot.webp"]));
    assert(!await auth.canFile(requester as any, ["employees", "another", shared.id, "shot.webp"]));
    assert(!await auth.canRead(requester as any, { employeeId: employee.employeeId, taskId: shared.id } as any));
    const stored = (await engine.groups.get(group.id))!;
    stored.users = stored.users.filter((id) => id !== requester.id);
    await store.save("group", group.id, stored);
    assert(!await auth.canFile(requester as any, parts), "leaving revokes shared screenshots");
    await assert.rejects(engine.groups.task(requester, group.id, employee.employeeId, shared.id), /群聊不存在/);
    stored.employees = [];
    await store.save("group", group.id, stored);
    assert(!await auth.canFile(member as any, parts), "removing the employee revokes access to its task files");
  } finally { await close(); }
});
