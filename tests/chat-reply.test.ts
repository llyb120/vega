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

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Chat employee" }, "owner")).id), chat = await employee.chat("owner");
  return { store, engine, employee, chat };
}

test("a dispatch adds no separate announce; the card rides on the next text", async () => {
  const { store, engine, chat } = await fixture();
  const visibleAtEnd: string[][] = [];
  engine.events.on("event", async (event) => {
    if (event.session === chat.id && event.type === "message_end") visibleAtEnd.push(employeeChatMessages(await store.messages(chat.id)).map((m: any) => m.text));
  });
  const replies = [
    { role: "assistant", text: "收到，我去查接口。", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Investigate endpoint" }) }] },
    { role: "assistant", text: "查到了告诉你。" },
  ];
  let calls = 0;
  engine.providers.chat = async () => replies[calls++] as any;
  try {
    await engine.run(chat.id, { role: "user", text: "查一下接口地址" });
    assert.deepEqual(visibleAtEnd[0], ["查一下接口地址", "收到，我去查接口。"], "the first sentence is visible before the tool even runs");
    const shown = employeeChatMessages(await store.messages(chat.id));
    assert.deepEqual(shown.map((m: any) => m.text), ["查一下接口地址", "收到，我去查接口。", "查到了告诉你。"]);
    assert.ok(!shown.some((m: any) => /^已安排任务 /.test(m.text)), "no system-made announce bubble");
    assert.deepEqual(shown.map((m: any) => m.tasks?.length || 0), [0, 0, 1], "the card sits on the reply after dispatch");
  } finally { await engine.close(); await store.close(); }
});

test("a dispatch followed by a silent reply still shows the card once", async () => {
  const { store, engine, chat } = await fixture();
  let calls = 0;
  engine.providers.chat = async () => (calls++ === 0
    ? { role: "assistant", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Investigate endpoint" }) }] }
    : { role: "assistant", text: "" }) as any;
  try {
    await engine.run(chat.id, { role: "user", text: "查一下" });
    const withCard = employeeChatMessages(await store.messages(chat.id)).filter((m: any) => m.tasks?.length);
    assert.equal(withCard.length, 1);
    assert.equal(withCard[0].text, "已安排。");
  } finally { await engine.close(); await store.close(); }
});

test("task_progress tellUser: null means omitted; true posts a quoted milestone to the chat at most every 10 minutes and 5 times per task", async () => {
  const { store, engine, employee, chat } = await fixture();
  const ctx: any = { kind: "task", taskId: "x" };
  const schema = employeeTools(ctx).find((tool) => tool.name === "task_progress")!.parameters;
  const nulled = checkArgs(schema, { message: "进行中", plan: null, tellUser: null });
  assert.equal("tellUser" in nulled, false);
  assert.equal("tellUser" in toInternal("task_progress", nulled, ctx).args, false);
  assert.equal(toInternal("task_progress", checkArgs(schema, { message: "m", tellUser: true }), ctx).args.tellUser, true);
  try {
    await store.append(chat.id, { role: "user", text: "帮我核对报表" });
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify report" });
    const id = created.value.id;
    employee.busy.set(id, { computer: false, session: "" });
    await employee.update((state) => {
            Object.assign(state.tasks[0], { status: "running", chatSource: { session: chat.id, seq: 1 } });
          });
    const chatCount = async () => (await store.messages(chat.id)).filter((m) => m.progress).length;
    assert.equal((await employee.execute(id, { action: "progress", text: "silent" })).value.toldUser, false);
    assert.equal(await chatCount(), 0);
    const first = await employee.execute(id, { action: "progress", text: "开始核对第二季度数据", tellUser: true });
    assert.equal(first.value.toldUser, true);
    const posted = (await store.messages(chat.id)).at(-1)!;
    assert.deepEqual([posted.role, posted.text, posted.progress, posted.tasks?.[0].id, posted.quote?.seq], ["assistant", "开始核对第二季度数据", true, id, 1]);
    const early = await employee.execute(id, { action: "progress", text: "又一条", tellUser: true });
    assert.equal(early.value.toldUser, false);
    assert.match(early.value.tellUserSkipped, /10 分钟/);
    assert.equal((await employee.state()).tasks[0].progress.at(-1).text, "又一条", "progress is saved even when not told");
    for (let i = 0; i < 6; i++) {
      await employee.update((state) => { state.tasks[0].toldUserAt = state.tasks[0].toldUserAt.map((at: number) => at - 11 * 60_000); });
      await employee.execute(id, { action: "progress", text: "里程碑 " + i, tellUser: true });
    }
    assert.equal(await chatCount(), 5, "at most 5 milestones per task");
    const capped = await employee.execute(id, { action: "progress", text: "超出", tellUser: true });
    assert.equal(capped.value.toldUser, false);
    assert.match(capped.value.tellUserSkipped, /5 次/);
  } finally { await engine.close(); await store.close(); }
});
