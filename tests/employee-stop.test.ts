import { EMPLOYEE_CHAT_RULES } from "../server/core/prompt";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { employeeCall } from "./public-call";

async function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  store.db.prepare("INSERT INTO web_users(id,username,password,role,disabled,createdAt,lastLogin) VALUES(?,?,?,?,0,0,0)").run("member", "member", "fixture", "operator");
  const employee = engine.employee.for(engine.employee.create({ name: "Team" }, "admin", "team").id);
  const created = await employee.execute("", { action: "add", kind: "todo", text: "authorized task" });
  const task = employee.task(employee.state(), created.value.id);
  const chat = employee.chat("admin");
  const tools = new Tools(engine, chat, engine.config(), new AbortController().signal, () => {});
  tools.actorId = "member";
  const stop = () => tools.execute({ id: "stop", ...employeeCall({ action: "stop", id: task.id }) }, {} as any);
  return { store, engine, employee, task, chat, tools, stop };
}

test("chat stop aborts both execution sessions and confirms termination without steering or touching unrelated work", async () => {
  const { store, engine, employee, task, chat, tools, stop } = await fixture();
  const work = store.newSession({ taskId: task.id, employeeId: employee.employeeId, scene: "lightweight" });
  const computer = store.newSession({ taskId: task.id, employeeId: employee.employeeId, scene: "computer" });
  const unrelated = store.newSession({ title: "unrelated" });
  const controls = [new AbortController(), new AbortController()], other = new AbortController();
  try {
    store.append(chat.id, { role: "user", text: "original authorized task" });
    const source = { session: chat.id, seq: store.messages(chat.id).at(-1)!.seq! };
    store.append(chat.id, { role: "user", text: "停止，你搞错了" });
    employee.update((state) => Object.assign(state.tasks[0], { status: "running", workSession: work.id, computerSession: computer.id, side: "work", chatSource: source, answer: "prior supplement" }));
    employee.busy.set(task.id, { session: computer.id, computer: true });
    for (const [index, session] of [work, computer].entries()) {
      engine.active.set(session.id, { control: controls[index], steer: [] });
      controls[index].signal.addEventListener("abort", () => queueMicrotask(() => {
        engine.active.delete(session.id);
        if (!engine.active.has(work.id) && !engine.active.has(computer.id)) employee.busy.delete(task.id);
      }), { once: true });
    }
    engine.active.set(unrelated.id, { control: other, steer: [] });
    const definition = tools.definitions({} as any).find((tool) => tool.name === "employee_task_manage")!;
    assert(JSON.stringify(definition.parameters).includes('"stop"'));
    assert(EMPLOYEE_CHAT_RULES.includes("不能用resume") && definition.description.includes("executionStopped"));
    const result = await stop();
    assert(controls.every((control) => control.signal.aborted));
    assert.equal(other.signal.aborted, false);
    assert.equal(result.value.executionStopped, true);
    assert.equal(result.value.status, "stopped");
    assert.equal(result.task?.id, task.id);
    const current = employee.task(employee.state(), task.id);
    assert.equal(current.status, "stopped");
    assert.equal(current.answer, "prior supplement");
    assert.deepEqual(current.chatSource, source);
    assert.equal(employee.state().tasks.length, 1, "stop does not create replacement work or remove its history");
  } finally { engine.active.clear(); employee.busy.clear(); await engine.close(); store.close(); }
});

test("stop does not claim execution ended while the runtime is still unwinding", async () => {
  const { store, engine, employee, task, stop } = await fixture();
  const work = store.newSession({ taskId: task.id, employeeId: employee.employeeId });
  try {
    employee.update((state) => Object.assign(state.tasks[0], { status: "running", workSession: work.id }));
    employee.busy.set(task.id, { session: work.id, computer: false });
    const result = await stop();
    assert.equal(result.value.executionStopped, false);
    assert.equal(result.value.status, "stopping");
    assert.match(result.value.next, /不能宣称已经停止/);
    assert.equal(employee.task(employee.state(), task.id).status, "stopped", "terminal scheduling state prevents automatic recovery");
  } finally { employee.busy.clear(); await engine.close(); store.close(); }
});

test("queued work stops immediately and already completed work keeps its completed result", async () => {
  const { store, engine, employee, task, stop } = await fixture();
  try {
    const result = await stop();
    assert.equal(result.value.status, "stopped");
    assert.equal(result.value.executionStopped, true);
    employee.update((state) => Object.assign(state.tasks[0], { status: "done", result: "verified original result" }));
    const completed = await stop();
    assert.equal(completed.value.status, "done");
    assert.equal(employee.task(employee.state(), task.id).result, "verified original result");
  } finally { await engine.close(); store.close(); }
});

test("chat stopping respects task ownership instead of cancelling foreign work", async () => {
  const { store, engine, employee, stop } = await fixture();
  try {
    employee.update((state) => { state.tasks[0].owner = { token: "remote-member", name: "remote" }; });
    await assert.rejects(stop(), /assigning member/);
    assert.equal(employee.state().tasks[0].status, "queued");
  } finally { await engine.close(); store.close(); }
});
