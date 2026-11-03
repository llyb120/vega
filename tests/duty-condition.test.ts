import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { prepareDutyInput } from "../server/core/duty-condition";
import { dutyCondition, dutyContent } from "../shared/duty-condition";
import { beijingDateTime } from "../shared/time";

function fixture() {
  const store = new Store(":memory:"), engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "p/code", scenes: { lightweight: ["p/light"], coding: ["p/code"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { limit: { context: 128000, output: 8192 } }, code: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Duty employee" }, "owner").id);
  const save = async (input: any) => employee.execute("", await prepareDutyInput(engine, employee, input));
  return { store, engine, employee, save };
}
const rule = (value: any) => ({ role: "assistant", calls: [{ id: "trigger", name: "compile_duty_trigger", arguments: value }] });

test("two-field duties compile only their trigger with the lightweight model and retain original responsibility text", async () => {
  const { store, engine, employee, save } = fixture();
  const plans = [
    { mode: "daily", times: ["18:30", "09:00"], text: "must not replace content", enabled: false },
    { mode: "interval", everyMinutes: 30 }, { mode: "manual" },
    { mode: "dynamic", nextAt: beijingDateTime(Date.now() + 86400000) },
  ];
  let calls = 0;
  engine.providers.chat = async (model, system, messages, definitions) => {
    assert.equal(model.selection, "p/light");
    assert.equal(definitions.length, 1); assert.equal(definitions[0].name, "compile_duty_trigger");
    assert(system.includes("不能偷偷改成轮询") && system.includes("不能用一次nextAt冒充长期周期"));
    assert(!JSON.stringify(messages).includes("Only original responsibility content"));
    return rule(plans[calls++]);
  };
  try {
    for (const condition of ["每天上午9点和18:30", "每30分钟检查新需求", "按交代的任务需要，不自动触发", "明天这个时刻执行一次"]) await save({ action: "add", kind: "duty", condition, text: "Only original responsibility content" });
    const duties = employee.state().duties;
    assert.deepEqual(duties[0].times, ["09:00", "18:30"]);
    assert.equal(duties[0].condition, "每天上午9点和18:30");
    assert.equal(duties[0].enabled, true); assert.equal(duties[0].text, "Only original responsibility content");
    assert.equal(duties[1].everyMinutes, 30);
    assert.equal(duties[2].manual, true); assert.deepEqual(duties[2].times, []); assert.equal(duties[2].nextCheckAt, 0);
    assert(duties[3].nextCheckAt > Date.now());
    assert.equal(store.sessions().length, 0, "trigger interpretation does not create chats or task execution sessions");
    assert.equal(employee.state().tasks.length, 0, "saving never executes the responsibility itself");
  } finally { await engine.close(); store.close(); }
});

test("trigger interpretation falls back only within configured lightweight candidates", async () => {
  const { store, engine, employee, save } = fixture();
  const config = engine.config(); config.scenes!.lightweight = ["p/light", "p/backup"]; config.provider.p.models.backup = config.provider.p.models.light; store.put("config", config);
  const selected: string[] = [];
  engine.providers.chat = async model => { selected.push(model.selection); if (model.selection === "p/light") throw Error("lightweight candidate unavailable"); return rule({ mode: "manual" }); };
  try {
    await save({ action: "add", kind: "duty", condition: "按交代任务需要", text: "work" });
    assert.deepEqual(selected, ["p/light", "p/backup"]);
    assert.equal(employee.state().duties.length, 1);
  } finally { await engine.close(); store.close(); }
});

test("editing legacy duties with only two fields preserves their existing schedule, disabled state and supplemental requirements without another model call", async () => {
  const { store, engine, employee, save } = fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "duty", text: "Original responsibility", note: "Legacy requirement", times: ["09:00"], enabled: false });
    const original = employee.state().duties[0];
    engine.providers.chat = async () => { throw Error("unchanged trigger must not be reinterpreted"); };
    await save({ action: "update", kind: "duty", id: created.value.id, condition: dutyCondition(original), text: dutyContent(original), note: "" });
    const updated = employee.state().duties[0];
    assert.equal(updated.enabled, false); assert.deepEqual(updated.times, ["09:00"]);
    assert.equal(updated.firedAt, original.firedAt);
    assert.match(updated.text, /Original responsibility\n\n补充要求：\nLegacy requirement/);
    assert.equal(updated.note, "");
    assert.equal(dutyContent(updated).match(/Legacy requirement/g)!.length, 1);
    assert.equal(dutyCondition({ manual: true }), "按交代的任务需要，不自动触发");
  } finally { await engine.close(); store.close(); }
});

test("unsupported events, malformed rules and invalid dates never save a duty or invent polling", async () => {
  const { store, engine, employee, save } = fixture();
  try {
    for (const value of [
      { mode: "unsupported", reason: "没有外部事件源，请写明检查频率" },
      { mode: "daily", times: ["99:00"] }, { mode: "daily", times: [] },
      { mode: "interval", everyMinutes: 0 }, { mode: "interval", everyMinutes: 10081 },
      { mode: "dynamic", nextAt: beijingDateTime(Date.now() - 30 * 60000) }, { mode: "unknown" },
    ]) {
      engine.providers.chat = async () => rule(value);
      await assert.rejects(save({ action: "add", kind: "duty", condition: "当外部事件发生时执行", text: "work" }));
      assert.equal(employee.state().duties.length, 0);
    }
    engine.providers.chat = async () => ({ role: "assistant", text: "我已经帮你订阅好了" });
    await assert.rejects(save({ action: "add", kind: "duty", condition: "需要时", text: "work" }), /未能识别/);
    engine.providers.chat = async () => { throw Error("invalid input cannot contact the provider"); };
    await assert.rejects(save({ action: "add", kind: "duty", condition: "x".repeat(2001), text: "work" }), /2000/);
    assert.equal(employee.state().tasks.length, 0);
  } finally { await engine.close(); store.close(); }
});

test("a running task cannot use natural-language condition compilation to bypass duty-management permissions", async () => {
  const { store, engine, employee } = fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "work" });
    employee.update(state => { state.tasks[0].status = "running"; }); employee.busy.set(created.value.id, { computer: false, session: "" });
    engine.providers.chat = async () => { throw Error("unauthorized calls cannot contact the provider"); };
    await assert.rejects(prepareDutyInput(engine, employee, { action: "add", kind: "duty", condition: "每天9点", text: "work" }, created.value.id), /cannot create duties/);
    assert.equal(employee.state().duties.length, 0); employee.busy.clear();
  } finally { await engine.close(); store.close(); }
});

test("cancellation and employee deletion during interpretation cannot persist a late configuration write", async () => {
  const { store, engine, employee, save } = fixture();
  try {
    const control = new AbortController();
    engine.providers.chat = async () => { control.abort(); return rule({ mode: "manual" }); };
    await assert.rejects(prepareDutyInput(engine, employee, { action: "add", kind: "duty", condition: "按需触发", text: "work" }, "", control.signal));
    engine.providers.chat = async () => { employee.deleting = true; return rule({ mode: "manual" }); };
    await assert.rejects(save({ action: "add", kind: "duty", condition: "按需触发", text: "work" }), /已删除|正在删除/);
    assert.equal(employee.state().duties.length, 0); employee.deleting = false;
  } finally { employee.deleting = false; await engine.close(); store.close(); }
});

test("fired tasks keep their original trigger condition even when the responsibility is later edited", async () => {
  const { store, engine, employee, save } = fixture();
  try {
    engine.providers.chat = async () => rule({ mode: "manual" });
    const created = await save({ action: "add", kind: "duty", condition: "按交代的任务需要检查原项目", text: "responsibility content" });
    const job = employee.update(state => employee.fire(state, state.duties[0], Date.now()));
    await employee.execute("", { action: "update", id: created.value.id, condition: "以后只检查新项目" });
    assert.equal(employee.state().tasks[0].triggerCondition, "按交代的任务需要检查原项目");
    employee.runtime.run = async (_session, prompt) => {
      assert(prompt.includes('"triggerCondition":"按交代的任务需要检查原项目"'));
      assert(prompt.includes("不因排队/续做晚于时刻而拒绝执行"));
      await employee.execute(job.id, { action: "progress", text: "verified", plan: [{ content: "verify", status: "completed" }] });
      await employee.execute(job.id, { action: "complete", deliverableRef: [], text: "verified result" });
    };
    employee.update(state => { state.tasks[0].status = "running"; }); employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    assert.equal(employee.state().tasks[0].status, "done");
  } finally { await engine.close(); store.close(); }
});


test("stray condition on todo add is ignored so dispatch still works", async () => {
  const { engine, store, employee } = fixture();
  try {
    const prepared = await prepareDutyInput(engine, employee, {
      action: "add",
      kind: "todo",
      text: "为 TAPD 需求设计用例",
      condition: "按交代任务需要",
    });
    assert.equal("condition" in prepared, false);
    const result = await employee.execute("", prepared);
    assert(result.value.id);
    const job = employee.task(employee.state(), result.value.id);
    assert.equal(job.kind || "todo", "todo");
    assert.match(job.text, /TAPD/);
  } finally {
    await engine.close();
    store.close();
  }
});
