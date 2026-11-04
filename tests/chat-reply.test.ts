import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { checkArgs, employeeTools, toInternal } from "../server/core/public-tools";
import { employeeChatMessages } from "../web/src/conversation.js";
import { employeeCall } from "./public-call";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Chat employee" }, "owner").id), chat = employee.chat("owner");
  return { store, engine, employee, chat };
}

test("text written alongside a task dispatch reaches the chat at once; the new task card rides once on the next text", async () => {
  const { store, engine, chat } = fixture();
  const visibleAtEnd: string[][] = [];
  engine.events.on("event", (event) => {
    if (event.session === chat.id && event.type === "message_end") visibleAtEnd.push(employeeChatMessages(store.messages(chat.id)).map((m: any) => m.text));
  });
  const replies = [
    { role: "assistant", text: "收到，我安排一条只读调查。", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Investigate endpoint" }) }] },
    { role: "assistant", text: "已安排，有结果第一时间告诉你。", calls: [{ id: "status", name: "employee_status", arguments: {} }] },
    { role: "assistant", text: "另外记下了你的偏好。" },
  ];
  let calls = 0;
  engine.providers.chat = async () => replies[calls++] as any;
  try {
    await engine.run(chat.id, { role: "user", text: "查一下接口地址" });
    assert.deepEqual(visibleAtEnd[0], ["查一下接口地址", "收到，我安排一条只读调查。"], "the first sentence is visible before the tool even runs");
    const shown = employeeChatMessages(store.messages(chat.id));
    assert.deepEqual(shown.map((m: any) => m.text), ["查一下接口地址", "收到，我安排一条只读调查。", "已安排，有结果第一时间告诉你。", "另外记下了你的偏好。"]);
    assert.deepEqual(shown.map((m: any) => m.tasks?.length || 0), [0, 0, 1, 0], "the card is attached once, to the first text after the task exists");
  } finally { await engine.close(); store.close(); }
});

test("a dispatch without any following text still puts the card on the final reply", async () => {
  const { store, engine, chat } = fixture();
  let calls = 0;
  engine.providers.chat = async () => (calls++ === 0
    ? { role: "assistant", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Investigate endpoint" }) }] }
    : { role: "assistant", text: "" }) as any;
  try {
    await engine.run(chat.id, { role: "user", text: "查一下" });
    assert.equal(store.messages(chat.id).at(-1)?.tasks?.length, 1);
  } finally { await engine.close(); store.close(); }
});

test("task_progress tellUser: null means omitted; true posts a quoted milestone to the chat at most every 10 minutes and 5 times per task", async () => {
  const { store, engine, employee, chat } = fixture();
  const ctx: any = { kind: "task", taskId: "x" };
  const schema = employeeTools(ctx).find((tool) => tool.name === "task_progress")!.parameters;
  const nulled = checkArgs(schema, { message: "进行中", plan: null, tellUser: null });
  assert.equal("tellUser" in nulled, false);
  assert.equal("tellUser" in toInternal("task_progress", nulled, ctx).args, false);
  assert.equal(toInternal("task_progress", checkArgs(schema, { message: "m", tellUser: true }), ctx).args.tellUser, true);
  try {
    store.append(chat.id, { role: "user", text: "帮我核对报表" });
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify report" });
    const id = created.value.id;
    employee.busy.set(id, { computer: false, session: "" });
    employee.update((state) => {
      Object.assign(state.tasks[0], { status: "running", chatSource: { session: chat.id, seq: 1 } });
    });
    const chatCount = () => store.messages(chat.id).filter((m) => m.progress).length;
    assert.equal((await employee.execute(id, { action: "progress", text: "silent" })).value.toldUser, false);
    assert.equal(chatCount(), 0);
    const first = await employee.execute(id, { action: "progress", text: "开始核对第二季度数据", tellUser: true });
    assert.equal(first.value.toldUser, true);
    const posted = store.messages(chat.id).at(-1)!;
    assert.deepEqual([posted.role, posted.text, posted.progress, posted.tasks?.[0].id, posted.quote?.seq], ["assistant", "开始核对第二季度数据", true, id, 1]);
    const early = await employee.execute(id, { action: "progress", text: "又一条", tellUser: true });
    assert.equal(early.value.toldUser, false);
    assert.match(early.value.tellUserSkipped, /10 分钟/);
    assert.equal(employee.state().tasks[0].progress.at(-1).text, "又一条", "progress is saved even when not told");
    for (let i = 0; i < 6; i++) {
      employee.update((state) => { state.tasks[0].toldUserAt = state.tasks[0].toldUserAt.map((at: number) => at - 11 * 60_000); });
      await employee.execute(id, { action: "progress", text: "里程碑 " + i, tellUser: true });
    }
    assert.equal(chatCount(), 5, "at most 5 milestones per task");
    const capped = await employee.execute(id, { action: "progress", text: "超出", tellUser: true });
    assert.equal(capped.value.toldUser, false);
    assert.match(capped.value.tellUserSkipped, /5 次/);
  } finally { await engine.close(); store.close(); }
});
