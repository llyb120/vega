// Regressions from a real task export: a design task whose full body was written (twice) but delivered as a
// summary only (task_complete deliverableRefs=[]), and a computer phase whose caller work was lost after a 429.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { ProviderError } from "../server/core/provider";
import { resolveDeliverable, type Task } from "../server/core/employee";
import { CHROME_TOOL_DEFINITIONS } from "../server/core/public-tools";
import { chromeCall, employeeCall } from "./public-call";

async function fixture(scenes = { lightweight: ["p/light"], coding: ["p/code"], computer: ["p/vision"] }) {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/code", scenes, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: Object.fromEntries(["light", "code", "vision"].map(id => [id, { modalities: { input: id === "vision" ? ["text", "image"] : ["text"] }, limit: { context: 128000, output: 8192 } }])) } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Delivery employee" }, "owner")).id);
  const chat = await employee.chat("owner");
  const driver: string[] = [];
  (engine as any).chromeFor = async () => ({ execute: async (_owner: string, _cwd: string, a: any) => { driver.push(a.operation || "op"); return { connected: true }; } });
  const add = async (text: string) => {
    const created = await employee.execute("", { action: "add", kind: "todo", text });
    return employee.task(await employee.state(), created.value.id);
  };
  const segment = async (job: Task) => {
    await employee.update(state => { employee.task(state, job.id).status = "running"; });
    const current = employee.task(await employee.state(), job.id);
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(current);
    return employee.task(await employee.state(), job.id);
  };
  const deliveries = async () => (await store.messages(chat.id)).filter(m => m.delivery);
  return { store, engine, employee, chat, driver, add, segment, deliveries };
}
const legacy = (name: string, args: any) => name === "employee" ? employeeCall(args) : name === "chrome" ? chromeCall(args) : { name, arguments: args };
const call = (id: string, name: string, args: any, text = "") => ({ role: "assistant", text, calls: [{ id, ...legacy(name, args) }] });
const plan = (...status: string[]) => call("plan-" + status.join("-"), "employee", { action: "progress", text: "交付类型：产出物（测试方案设计）", plan: status.map((s, i) => ({ content: `步骤${i + 1}`, status: s })) });
const shots = Array.from({ length: 7 }, (_, i) => `![S${i + 1} 页面截图](/api/files/employees/e/t/shot-${i + 1}.webp)`);
const BODY = "# 重做版测试用例方案\n\n" + Array.from({ length: 46 }, (_, i) => `| TC${String(i + 1).padStart(2, "0")} | P0 | 前置：已登录 | 步骤：打开页面并悬停指标 | 预期：显示配置文案 |`).join("\n") + "\n\n## 截图\n" + shots.join("\n") + "\n\n## 待确认\nB01–B09。";
/** Real providers stamp the serving model on each reply; deliverable citation relies on it. */
const withModel = (engine: Engine) => {
  const inner = engine.providers.chat;
  engine.providers.chat = (async (model: any, ...rest: any[]) => ({ model: model.selection, ...(await (inner as any)(model, ...rest)) })) as any;
};
const count = (text: string, part: string) => text.split(part).length - 1;
const lastTool = (messages: any[], name: string) => messages.findLast(m => m.role === "tool" && m.name === name);

test("export replay: 429 inside computer keeps the caller's resume, the browser phase returns to lightweight, the body is written once and delivered once with every screenshot", async () => {
  const { store, engine, employee, driver, add, segment, deliveries } = await fixture();
  const selected: string[] = [];
  let phase = 0, bodySeq = 0;
  engine.providers.chat = async (model, system, messages, definitions) => {
    selected.push(model.selection);
    phase++;
    if (phase === 1) return plan("in_progress", "pending");
    if (phase === 2) return call("enter", "switch_scene", { scene: "computer", message: "只读勘察 TAPD 与 DataBrain 并截图", resume: "回到原场景整理并交付完整测试方案正文（用例、矩阵、截图说明）" });
    // The provider quota error that ended the first run in the export (non-retryable here so the test does not back off).
    if (phase === 3) { assert.equal(model.selection, "p/vision"); throw new ProviderError("rate_limit_reached HTTP 429", 400); }
    if (phase === 4) {
      assert.equal(model.selection, "p/vision", "the resumed run continues the browser phase");
      assert.match(system, /\[场景栈\] 当前在「computer」场景.*自动返回「lightweight」继续调用方保留的工作：回到原场景整理并交付完整测试方案正文/s, "resume survived the failed run");
      return call("again", "switch_scene", { scene: "computer", message: "重新进入电脑场景" });
    }
    if (phase === 5) {
      const refused = lastTool(messages, "switch_scene");
      assert(refused.error && /当前已在「computer」场景.*无需再切换/.test(refused.text), refused.text);
      assert.deepEqual(definitions.filter((t: any) => t.name.startsWith("chrome_")).map((t: any) => t.name), CHROME_TOOL_DEFINITIONS.map(t => t.name), "chrome schemas stay stable");
      return call("status", "chrome", { operation: "status" });
    }
    if (phase === 6) return { role: "assistant", text: "浏览器勘察完成：7 张截图已保存。" };
    if (phase === 7) {
      assert.equal(model.selection, "p/light", "caller work runs on the caller's scene model");
      assert(messages.at(-1)!.text!.includes("Continue only caller retained work") && messages.at(-1)!.text!.includes("交付完整测试方案正文"));
      return { role: "assistant", text: BODY };
    }
    if (phase === 8) {
      bodySeq = (await store.messages((await employee.state()).tasks[0].workSession!)).findLast(m => m.text === BODY)!.seq!;
      const prompt = messages.findLast(m => m.role === "user")!.text!;
      assert(prompt.includes(`#${bodySeq}`) && prompt.includes("不要重写"), "the nudge points at the saved body instead of pasting it back");
      assert(!prompt.includes("TC46"), "the body is not echoed into the resume prompt");
      return plan("completed", "completed");
    }
    // Summary over 400 chars with [], as in the export: rejected by the schema first.
    if (phase === 9) return call("c1", "employee", { action: "complete", deliverableRef: [], text: "证据：TAPD 与 DataBrain 只读核对。", summary: "长".repeat(467) });
    if (phase === 10) {
      assert(lastTool(messages, "task_complete").error);
      return call("c2", "employee", { action: "complete", deliverableRef: [], text: "证据：TAPD 与 DataBrain 只读核对。", summary: "方案已交付。" });
    }
    if (phase === 11) {
      const refused = lastTool(messages, "task_complete");
      assert(refused.error && refused.text.includes(`deliverableRefs:[${bodySeq}]`) && refused.text.includes("不要重写"), refused.text);
      return call("c3", "employee", { action: "complete", deliverableRef: [bodySeq], text: "证据：TAPD 与 DataBrain 只读核对。", summary: "方案已交付。" });
    }
    throw Error("unexpected extra model turn " + phase);
  };
  withModel(engine);
  try {
    let job = await segment(await add("根据需求单重新设计测试用例，交付完整方案与截图，不仅给摘要"));
    assert.equal(job.status, "recovering");
    const work = job.workSession!;
    assert.equal((await store.session(work)).scene, "computer");
    assert.equal((await store.session(work)).sceneStack?.[0]?.resume, "回到原场景整理并交付完整测试方案正文（用例、矩阵、截图说明）", "persisted across the failed run");
    job = await segment(job);
    assert.equal(job.status, "queued", "body without task_complete is nudged, not recovered with a pasted copy");
    assert.equal(job.settleNudges, 1);
    job = await segment(job);
    assert.equal(job.status, "done");
    assert.equal(phase, 11);
    assert.deepEqual(driver.length, 1, "one browser operation, nothing replayed");
    assert.deepEqual(selected, ["p/light", "p/light", "p/vision", "p/vision", "p/vision", "p/vision", "p/light", "p/light", "p/light", "p/light", "p/light"]);

    assert.equal(job.deliverable, BODY);
    assert.deepEqual(job.deliverableRefs, [bodySeq]);
    for (const text of [job.result!, (await store.messages(work)).at(-1)!.text!]) {
      assert.equal(count(text, BODY), 1, "full body delivered exactly once");
      for (const shot of shots) assert.equal(count(text, shot), 1);
    }
    const rows = await store.messages(work);
    assert.equal(rows.filter(m => m.role === "assistant" && m.model && m.text === BODY).length, 1, "the long body was generated once");
    assert(!rows.some(m => m.role === "assistant" && !m.model && m.text?.includes("TC46") && m.text !== rows.at(-1)!.text), "no recovery message repeats the body");
    const sent = await deliveries();
    assert.equal(sent.length, 1, "one delivery to the chat");
    assert.match(sent[0].text!, /已交付[\s\S]*方案已交付。[\s\S]*完整交付物见任务详情/);
    assert.equal(sent[0].tasks?.[0]?.id, job.id);

    const session = await store.session(work);
    assert.equal(session.scene, "lightweight");
    assert.equal(session.model, "p/light");
    assert.equal(session.sceneStack, undefined);
    assert.equal((await store.sessions()).filter(s => s.taskId).length, 1, "same task session throughout");
  } finally { await engine.close(); await store.close(); }
});

test("stopped mid-computer and resumed: retained work survives, task_complete from computer returns to the caller first and is executed once", async () => {
  const { store, engine, employee, driver, add, segment, deliveries } = await fixture();
  let phase = 0, work = "", stopping: Promise<unknown> | undefined;
  engine.providers.chat = async (model, _system, messages) => {
    phase++;
    if (phase === 1) return plan("in_progress");
    if (phase === 2) return call("enter", "switch_scene", { scene: "computer", message: "打开页面截图", resume: "回到原场景写出完整清单正文" });
    if (phase === 3) {
      work = (await employee.state()).tasks[0].workSession!;
      stopping = employee.control({ action: "stop", id: (await employee.state()).tasks[0].id });
      while ((await employee.state()).tasks[0].status !== "stopped") await new Promise(resolve => setTimeout(resolve, 5));
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    if (phase === 4) { assert.equal(model.selection, "p/vision"); return call("shot", "chrome", { operation: "status" }); }
    if (phase === 5) return plan("completed");
    if (phase === 6) {
      assert.equal(model.selection, "p/vision");
      return call("early", "employee", { action: "complete", text: "已截图。", summary: "已完成。" });
    }
    if (phase === 7) {
      assert.equal(model.selection, "p/light", "returned to the caller before delivering");
      assert(lastTool(messages, "task_complete").error);
      assert(messages.at(-1)!.text!.includes("task_complete was not executed") && messages.at(-1)!.text!.includes("写出完整清单正文"));
      return { role: "assistant", text: BODY, calls: [{ id: "done", ...employeeCall({ action: "complete", text: "清单已写出。", summary: "清单已交付。" }) }] };
    }
    throw Error("unexpected extra model turn " + phase);
  };
  withModel(engine);
  try {
    let job = await segment(await add("截图后写出完整测试清单"));
    await stopping;
    assert.equal(job.status, "stopped");
    assert.equal((await store.session(work)).sceneStack?.[0]?.resume, "回到原场景写出完整清单正文", "stop keeps the caller frame");
    await employee.control({ action: "resume", id: job.id, text: "请继续" });
    job = await segment(employee.task(await employee.state(), job.id));
    assert.equal(job.status, "done");
    assert.equal(phase, 7);
    assert.equal(driver.length, 1);
    assert.equal(job.deliverable, BODY, "text written in the same message as task_complete is the delivered body");
    assert.equal((await store.messages(work)).filter(m => m.name === "task_complete" && !m.error).length, 1);
    assert.equal((await deliveries()).length, 1);
    assert.equal((await store.session(work)).scene, "lightweight");
    assert.equal((await store.session(work)).sceneStack, undefined);
  } finally { await engine.close(); await store.close(); }
});

test("no caller work: delivering straight from computer needs no extra model turn and restores the origin scene (shared model config)", async () => {
  const { store, engine, add, segment, deliveries } = await fixture({ lightweight: ["p/vision"], coding: ["p/code"], computer: ["p/vision"] });
  let phase = 0;
  engine.providers.chat = async () => {
    phase++;
    if (phase === 1) return call("enter", "switch_scene", { scene: "computer", message: "打开页面核实" });
    if (phase === 2) return call("status", "chrome", { operation: "status" });
    if (phase === 3) return plan("completed");
    if (phase === 4) return call("done", "employee", { action: "complete", deliverableRef: [], text: "已打开并核实标题。", summary: "页面已打开。" });
    throw Error("unexpected extra model turn " + phase);
  };
  withModel(engine);
  try {
    const job = await segment(await add("打开页面核实标题"));
    assert.equal(job.status, "done");
    assert.equal(phase, 4, "no round trip just to repeat the summary");
    assert.equal(job.deliverable, "", "execution-only task with no body stays summary-only");
    const sent = await deliveries();
    assert.equal(sent.length, 1);
    assert(!sent[0].text!.includes("完整交付物见任务详情"));
    const session = await store.session(job.workSession!);
    assert.equal(session.scene, "lightweight");
    assert.equal(session.model, "p/vision");
  } finally { await engine.close(); await store.close(); }
});

test("a plain reply mid-computer without caller work keeps the browser phase and its return scene for the next run", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  let phase = 0;
  engine.providers.chat = async (model, system) => {
    phase++;
    if (phase === 1) return call("enter", "switch_scene", { scene: "computer", message: "打开页面" });
    if (phase === 2) return { role: "assistant", text: "页面加载中。" };
    if (phase === 3) {
      assert.equal(model.selection, "p/vision", "browser capability is not hidden mid-work");
      assert.match(system, /任务交付后会话自动恢复到「lightweight」/);
      return plan("completed");
    }
    if (phase === 4) return call("done", "employee", { action: "complete", text: "已打开。", summary: "已打开。" });
    throw Error("unexpected extra model turn " + phase);
  };
  withModel(engine);
  try {
    let job = await segment(await add("打开页面"));
    assert.notEqual(job.status, "done");
    assert.equal((await store.session(job.workSession!)).scene, "computer");
    assert.equal((await store.session(job.workSession!)).sceneStack?.[0]?.scene, "lightweight");
    await employee.update(state => { const t = employee.task(state, job.id); t.status = "queued"; t.nextCheckAt = 0; });
    job = await segment(employee.task(await employee.state(), job.id));
    assert.equal(job.status, "done");
    assert.equal((await store.session(job.workSession!)).scene, "lightweight");
  } finally { await engine.close(); await store.close(); }
});

test("returning to a caller scene whose models were removed says so once and continues in place without looping", async () => {
  const { store, engine, add, segment } = await fixture();
  let phase = 0;
  engine.providers.chat = async (model, _system, messages) => {
    phase++;
    if (phase === 1) return call("enter", "switch_scene", { scene: "computer", message: "截图", resume: "整理结论" });
    if (phase === 2) {
      const config = await engine.config(); config.scenes!.lightweight = []; await store.put("config", config);
      return { role: "assistant", text: "截图完成。" };
    }
    if (phase === 3) {
      assert.equal(model.selection, "p/vision");
      assert.match(messages.at(-1)!.text!, /无法返回「lightweight」（场景「lightweight」未配置模型），留在当前「computer」场景完成下面的调用方工作[\s\S]*整理结论/);
      return plan("completed");
    }
    if (phase === 4) return call("done", "employee", { action: "complete", deliverableRef: [], text: "结论已整理。", summary: "完成。" });
    throw Error("unexpected extra model turn " + phase);
  };
  withModel(engine);
  try {
    const job = await segment(await add("截图并整理结论"));
    assert.equal(job.status, "done");
    assert.equal(phase, 4);
    const session = await store.session(job.workSession!);
    assert.equal(session.scene, "computer", "no origin model: stays where it can run");
    assert.equal(session.sceneStack, undefined);
  } finally { await engine.close(); await store.close(); }
});

test("deliverable citation contract: omitted, explicit [], confirmed [], valid and invalid refs, delivery window", () => {
  const body = "# 方案\n" + "TC 用例。\n".repeat(60);
  const rows: any[] = [
    { seq: 1, role: "user", text: "派单", at: 10 },
    { seq: 2, role: "assistant", model: "m", text: "旧交付正文。" + "旧".repeat(400), at: 20 },
    { seq: 3, role: "user", text: "后续补充", at: 40 },
    { seq: 4, role: "assistant", model: "m", text: "已核对。", at: 50 },
    { seq: 5, role: "assistant", model: "m", text: body, at: 60 },
    { seq: 6, role: "tool", text: "{\"ok\":true,\"textRef\":5}", at: 61 },
  ];
  assert.deepEqual(resolveDeliverable(rows, undefined, { since: 30 }).refs, [5], "omitted: latest body in this window");
  const empty = resolveDeliverable(rows, [], { since: 30 });
  assert.equal(empty.emptyGuard, 5);
  assert.match(empty.error!, /#5（\d+字）[\s\S]*deliverableRefs:\[5\][\s\S]*再次传 \[\] 确认/);
  assert.deepEqual(resolveDeliverable(rows, [], { since: 30, confirmEmpty: 5 }), { declared: true, refs: [], texts: [], later: [] }, "repeated [] confirms no body");
  assert.ok(resolveDeliverable(rows, [], { since: 30, confirmEmpty: 2 }).error, "a confirmation for another body does not count");
  assert.deepEqual(resolveDeliverable(rows, [6], { since: 30 }).refs, [5], "receipt textRef remaps");
  assert.ok(resolveDeliverable(rows, [3], { since: 30 }).error, "a user message is not a body");
  const followUp = rows.filter(m => m.seq <= 4);
  assert.deepEqual(resolveDeliverable(followUp, undefined, { since: 30 }).refs, [], "previous delivery's body is never re-sent implicitly");
  assert.equal(resolveDeliverable(followUp, [], { since: 30 }).error, undefined, "[] with only notes in the window is a legitimate no-body delivery");
  assert.deepEqual(resolveDeliverable(followUp, [2], { since: 30 }).refs, [2], "an explicit valid citation of an earlier body still works");
});

test("employee task_complete: [] with a written body is refused once naming it, repeated [] confirms; summary and citation errors come together", async () => {
  const { store, engine, employee, add } = await fixture();
  try {
    const job = await add("写清单");
    const session = await store.newSession({ cwd: process.cwd(), employeeId: employee.employeeId, taskId: job.id, scene: "lightweight", model: "p/light", ownerId: "owner" });
    const written = await store.append(session.id, { role: "assistant", model: "p/light", text: BODY });
    await employee.update(state => Object.assign(employee.task(state, job.id), { status: "running", workSession: session.id, plan: [{ content: "write", status: "completed" }], planRevision: 0, revision: 0 }));
    employee.busy.set(job.id, { computer: false, session: session.id });
    await assert.rejects(employee.execute(job.id, { action: "complete", deliverableRef: [], text: "e", summary: " " }), (e: any) => /summary/.test(e.message) && e.message.includes(`deliverableRefs:[${written.seq}]`));
    assert.equal(employee.task(await employee.state(), job.id).deliverableNeeded?.emptyGuard, written.seq, "the refusal record persists");
    const done = await employee.execute(job.id, { action: "complete", deliverableRef: [], text: "全部内容在证据里。", summary: "已完成。" });
    assert.equal(done.stop, true);
    const task = employee.task(await employee.state(), job.id);
    assert.equal(task.deliverable, "");
    assert.equal(task.deliverableNeeded, undefined);
  } finally { await engine.close(); await store.close(); }
});
