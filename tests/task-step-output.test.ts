import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import type { TaskGroup } from "../server/core/employee";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { checkArgs, employeeTools, toInternal } from "../server/core/public-tools";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "测试牛马" }, "u1")).id);
  const chat = await employee.chat("u1");
  return { store, engine, employee, chat };
}

const plan = [
  { content: "设计测试场景用例", status: "completed" },
  { content: "执行测试并交付结果", status: "in_progress" },
];
const scenarios = "# 测试场景与用例\n\n" + "- 登录：验证正常、异常和边界条件；这是设计，尚未执行。\n".repeat(20);

test("步骤产物可在任务运行中完整交给用户，之后继续任务并独立完成最终交付", { timeout: 10000 }, async () => {
  const { store, engine, employee, chat } = await fixture();
  let release!: () => void, announce!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const published = new Promise<void>((resolve) => { announce = resolve; });
  let phase = 0;
  const reply = (name: string, args: any, text = "") => ({ role: "assistant", model: "fixture/model", text, calls: [{ id: "call-" + phase, name, arguments: args }] });
  engine.providers.chat = async (_model, _system, messages, definitions, _signal, _emit, sessionId) => {
    assert(definitions.some((tool) => tool.name === "task_progress"));
    assert.match(JSON.stringify(messages), /计划步骤需要输出成果/);
    assert.match(JSON.stringify(messages), /task_progress 不结束本轮/);
    phase++;
    if (phase === 1) return reply("task_progress", { message: "先设计用例", plan: [{ ...plan[0], status: "in_progress" }, { ...plan[1], status: "pending" }] });
    if (phase === 2) {
      engine.redactors.get(sessionId!)!.add("private-test-token");
      return reply("task_progress", { message: "测试用例已设计，接着执行", plan, stepOutput: { step: 1, text: scenarios } });
    }
    if (phase === 3) {
      const receipt = messages.findLast((message) => message.role === "tool" && message.name === "task_progress");
      assert.match(receipt?.text || "", /stepOutput/);
      announce();
      await gate;
      return reply("task_progress", { message: "执行完成", plan: [plan[0], { ...plan[1], status: "completed" }], stepOutput: { step: 2, text: "# 执行记录\n\n验证已完成。" } });
    }
    assert.equal(phase, 4);
    return reply("task_complete", { evidence: "已执行并核对测试结果。", summary: "测试完成。", deliverableRefs: [] });
  };
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "设计用例、执行测试并交付结果" });
    await employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    const running = employee.run(employee.task(await employee.state(), created.value.id));
    await Promise.race([published, new Promise<never>((_, reject) => setTimeout(() => reject(Error("步骤产物未送达")), 5000))]);
    const interim = employee.task(await employee.state(), created.value.id);
    assert.equal(interim.status, "running", "输出步骤产物不结束任务");
    assert.deepEqual(interim.plan, plan);
    assert.equal(interim.stepOutputs.length, 1);
    assert.equal(interim.stepOutputs[0].label, plan[0].content);
    assert.equal(interim.stepOutputs[0].text, scenarios, "产物完整保存在独立字段");
    const message = (await store.messages(chat.id)).find((item) => item.stepOutput)!;
    assert.equal(message.text, "测试用例已设计，接着执行", "对话正文只保留简短进度");
    assert.equal(typeof message.stepOutput === "object" && message.stepOutput.text, scenarios, "产物以独立数据交给用户");
    assert(!message.text?.includes(scenarios));
    assert.equal(message.delivery, undefined, "步骤产物不是最终交付");
    assert.equal(message.tasks?.[0].id, created.value.id);
    release();
    await running;
    const finished = employee.task(await employee.state(), created.value.id);
    assert.equal(finished.status, "done");
    assert.equal(finished.stepOutputs[0].text, scenarios, "后续计划更新和最终交付不会抹掉阶段产物");
    assert.equal(finished.stepOutputs[1].text, "# 执行记录\n\n验证已完成。", "同一任务可以有多个步骤产物");
    assert.equal((await employee.findTask(created.value.id))!.stepOutputs.length, 2, "产物已保存在任务记录中");
    assert.equal(finished.deliverable, "", "已发出的步骤产物不会被误判为最终正文");
    assert.equal(finished.result, "已执行并核对测试结果。");
    assert.equal((await store.messages(chat.id)).filter((item) => item.stepOutput).length, 2);
  } finally { release(); await engine.close(); await store.close(); }
});

test("步骤产物引用原任务正文，拒绝无效引用，重复引用不重复发消息，计划重排后保留原步骤说明", async () => {
  const { store, engine, employee, chat } = await fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "设计并测试" });
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, ownerId: "u1", cwd: process.cwd() });
    const body = await store.append(session.id, { role: "assistant", model: "fixture/model", text: scenarios });
    const receipt = await store.append(session.id, { role: "tool", text: JSON.stringify({ textRef: body.seq }) });
    await store.append(session.id, { role: "user", text: "不能作为产物引用" });
    await employee.update((state) => { Object.assign(state.tasks[0], { status: "running", workSession: session.id, plan }); });
    employee.busy.set(created.value.id, { computer: false, session: session.id });
    const submit = (stepOutput: any, extra: any = {}) => employee.execute(created.value.id, { action: "progress", text: "设计结果", stepOutput, ...extra });
    await assert.rejects(submit({ step: 3, ref: body.seq }), /有效步骤/);
    await assert.rejects(submit({ step: 1, ref: receipt.seq + 1 }), /模型写出的非空正文/);
    await assert.rejects(submit({ step: 1 }), /同一条回复/);
    assert.equal((await employee.state()).tasks[0].stepOutputs, undefined);
    const saved = await submit({ step: 1, ref: receipt.seq }, { tellUser: true });
    assert.equal(saved.value.stepOutput.ref, body.seq, "工具回执的 textRef 指向正文");
    assert.equal(saved.value.stepOutput.duplicate, false);
    const duplicate = await submit({ step: 1, ref: body.seq });
    assert.equal(duplicate.value.stepOutput.duplicate, true);
    assert.equal((await store.messages(chat.id)).filter((item) => item.stepOutput).length, 1);
    await employee.execute(created.value.id, { action: "progress", text: "调整计划", plan: [plan[1], plan[0]] });
    const output = (await employee.state()).tasks[0].stepOutputs[0];
    assert.deepEqual([output.step, output.label, output.text], [1, plan[0].content, scenarios]);
    const tooLong = await store.append(session.id, { role: "assistant", model: "fixture/model", text: "长".repeat(64001) });
    await assert.rejects(submit({ step: 1, ref: tooLong.seq }), /最多 64000/);
    assert.equal((await employee.state()).tasks[0].stepOutputs.length, 1);
  } finally { await engine.close(); await store.close(); }
});

for (const inGroup of [false, true]) test(`步骤产物与来源${inGroup ? "群聊" : "私聊"}卡片一起回滚，失败重试只交付一次`, async () => {
  const { store, engine, employee, chat } = await fixture();
  try {
    let destination = chat.id, group: TaskGroup | undefined;
    if (inGroup) {
      for (const [id, name] of [["u1", "alice"], ["u2", "bob"]]) await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", id, name, "x", "operator", 0, Date.now(), 0);
      const created = await engine.groups.create({ id: "u1", role: "operator" }, { name: "产物事务测试群", users: ["u2"], employees: [employee.employeeId] });
      destination = (await engine.groups.get(created.id))!.session;
      group = { groupId: created.id, name: "产物事务测试群", hop: 0, requester: { kind: "user", id: "u2", name: "bob" }, byOwner: false };
    }
    const created = await employee.execute("", { action: "add", kind: "todo", text: "交付步骤报告" });
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, ownerId: "u1", cwd: process.cwd() });
    const body = await store.append(session.id, { role: "assistant", model: "fixture/model", text: "步骤报告正文" });
    await employee.update((state) => { Object.assign(state.tasks[0], { status: "running", workSession: session.id, plan, group }); });
    employee.busy.set(created.value.id, { computer: false, session: session.id });
    const input = { action: "progress", text: "报告已准备", stepOutput: { step: 1, ref: body.seq, paths: ["report.txt"] } };
    const submit = () => employee.execute(created.value.id, input, undefined, undefined, [{ name: "report.txt", data: Buffer.from("report contents") }]);
    const blobCount = async () => Number((await store.one("SELECT count(*) AS n FROM blobs"))!.n);
    const before = await blobCount(), notices: boolean[] = [];
    engine.events.on("event", (event) => {
      if (event.type === "message_end" && event.session === destination) notices.push(store.db.inTransaction);
    });
    let failAppend = true, failSave = false;
    const append = store.append.bind(store), save = employee.save.bind(employee);
    store.append = async (key, message) => {
      if (key === destination && message.stepOutput && failAppend) { failAppend = false; throw Error("step card append failed"); }
      return append(key, message);
    };
    employee.save = async (state) => {
      await save(state);
      if (failSave) { failSave = false; throw Error("step task save failed"); }
    };
    for (const failure of ["append", "save"]) {
      failSave = failure === "save";
      await assert.rejects(submit(), failure === "append" ? /step card append failed/ : /step task save failed/);
      assert.equal((await employee.findTask(created.value.id))!.stepOutputs, undefined, "没有已落库但未交付的产物");
      assert.equal((await store.messages(destination)).filter((message) => message.stepOutput).length, 0, "失败事务不留下产物卡片");
      assert.equal(await blobCount(), before, "文件快照与授权也随事务回滚");
      assert.deepEqual(notices, [], "回滚时不提前通知来源对话");
    }
    const saved = await submit();
    assert.equal(saved.value.stepOutput.duplicate, false);
    assert.equal((await submit()).value.stepOutput.duplicate, true);
    const outputs = (await employee.findTask(created.value.id))!.stepOutputs;
    const cards = (await store.messages(destination)).filter((message) => message.stepOutput);
    assert.equal(outputs.length, 1);
    assert.equal(cards.length, 1);
    assert.equal(await blobCount(), before + 1);
    assert.equal(typeof cards[0].stepOutput === "object" && cards[0].stepOutput.files?.[0].blobId, outputs[0].files[0].blobId);
    if (!inGroup) assert.deepEqual(notices, [false], "仅在提交后通知一次");
  } finally { await engine.close(); await store.close(); }
});

test("公开工具接收步骤产物参数，缺失步骤或非法引用不会进入执行器", () => {
  const context: any = { kind: "task", taskId: "t" };
  const schema = employeeTools(context).find((tool) => tool.name === "task_progress")!.parameters;
  const args = checkArgs(schema, { message: "已设计", stepOutput: { step: 1, text: "产物", paths: ["dist/app.zip"] } });
  assert.deepEqual(toInternal("task_progress", args, context).args, { action: "progress", text: "已设计", stepOutput: { step: 1, text: "产物", paths: ["dist/app.zip"] } });
  const complete = employeeTools(context).find((tool) => tool.name === "task_complete")!;
  assert.match(complete.description, /步骤产物不会自动算作最终正文/);
  assert.throws(() => checkArgs(schema, { message: "已设计", stepOutput: {} }), /step/);
  assert.throws(() => checkArgs(schema, { message: "已设计", stepOutput: { step: 1, ref: "bad" } }), /ref/);
});

test("群聊成员能看到步骤产物但不能取得私有会话引用，产物中的 @ 不触发额外任务", async () => {
  const { store, engine, employee, chat } = await fixture();
  try {
    for (const [id, name] of [["u1", "alice"], ["u2", "bob"]]) await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", id, name, "x", "operator", 0, Date.now(), 0);
    const owner = { id: "u1", role: "operator" }, guest = { id: "u2", role: "operator" };
    const group = await engine.groups.create(owner, { name: "测试群", users: ["u2"], employees: [employee.employeeId] });
    const created = await employee.execute("", { action: "add", kind: "todo", text: "设计场景" });
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, ownerId: "u1", cwd: process.cwd() });
    const body = await store.append(session.id, { role: "assistant", model: "fixture/model", text: "用例：@测试牛马 不应触发新的工作。" });
    await employee.update((state) => { Object.assign(state.tasks[0], { status: "running", workSession: session.id, plan, group: { groupId: group.id, name: "测试群", hop: 0, requester: { kind: "user", id: "u2", name: "bob" }, byOwner: false } }); });
    employee.busy.set(created.value.id, { computer: false, session: session.id });
    let dispatches = 0;
    engine.groups.dispatch = async () => { dispatches++; };
    await employee.execute(created.value.id, { action: "progress", text: "已设计", stepOutput: { step: 1, ref: body.seq } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 0, "产物是数据，不按 @ 派单");
    const groupSession = (await engine.groups.get(group.id))!.session;
    const message = (await store.messages(groupSession)).find((item) => item.stepOutput)!;
    assert.equal(message?.text, "已设计");
    assert.equal(typeof message?.stepOutput === "object" && message.stepOutput.text, body.text, "群聊正文与产物分开");
    assert.equal((await store.messages(chat.id)).filter((item) => item.stepOutput).length, 0, "只发回来源群聊");
    const shared = (await engine.groups.tasks(guest, group.id)).members.find((member) => member.id === employee.employeeId)!.tasks[0] as any;
    assert.deepEqual(shared.stepOutputs.map((output: any) => [output.step, output.label, output.text]), [[1, plan[0].content, body.text]]);
    assert.equal(shared.stepOutputs[0].session, undefined);
    assert.equal(shared.stepOutputs[0].ref, undefined);
    assert.equal(shared.workSession, undefined);
  } finally { await engine.close(); await store.close(); }
});
