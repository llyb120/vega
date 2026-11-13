import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { followUpOpen, type Task } from "../server/core/employee";
import { chromeCall, employeeCall } from "./public-call";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/code", scenes: { lightweight: ["p/light"], coding: ["p/code"], computer: ["p/vision"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: Object.fromEntries(["light", "code", "vision"].map(id => [id, { modalities: { input: id === "vision" ? ["text", "image"] : ["text"] }, limit: { context: 128000, output: 8192 } }])) } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Follow-up employee" }, "owner")).id);
  const chat = await employee.chat("owner");
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
  return { store, engine, employee, chat, add, segment, deliveries };
}
const legacy = (name: string, args: any) => name === "employee" ? employeeCall(args) : name === "chrome" ? chromeCall(args) : { name, arguments: args };
const call = (id: string, name: string, args: any) => ({ role: "assistant", calls: [{ id, ...legacy(name, args) }] });
const progress = (id: string, plan: { content: string; status: string }[]) => call(id, "employee", { action: "progress", text: "进度", plan });
const complete = (id: string, summary: string) => call(id, "employee", { action: "complete", deliverableRef: [], text: summary + "（证据）", summary });
const SEARCH = { content: "在百度搜索「你好」并核实结果页", status: "completed" };
const CLICK = { content: "点击第一条自然结果并核实目标页", status: "completed" };

/** First delivery: search done in the computer scene of the task's own work session. */
async function delivered(f: Awaited<ReturnType<typeof fixture>>) {
  let phase = 0;
  f.engine.providers.chat = async () => {
    if (phase++ === 0) return call("browser", "switch_scene", { scene: "computer", message: "百度搜索你好" });
    return phase === 2 ? progress("p1", [SEARCH]) : complete("c1", "已搜索你好，结果页首条为百度百科");
  };
  const job = await f.segment(await f.add("在服务端浏览器百度搜索「你好」"));
  assert.equal(job.status, "done");
  return job;
}

test("a direct follow-up long after delivery continues the original task and keeps the old result and plan", async () => {
  const f = await fixture();
  try {
    const first = await delivered(f);
    const work = first.workSession;
    await f.employee.update(state => { f.employee.task(state, first.id).finishedAt = Date.now() - 90 * 24 * 60 * 60_000; });
    assert.equal((await f.deliveries()).length, 1);

    const reply = await f.employee.control({ action: "resume", id: first.id, text: "在同一结果页点击第一条自然结果" });
    assert.equal(reply.reopened, true);
    let job = f.employee.task(await f.employee.state(), first.id);
    assert.equal(job.status, "queued");
    assert.equal(job.revision, 1);
    assert.equal(job.deliveries.length, 1);
    assert.equal(job.deliveries[0].summary, "已搜索你好，结果页首条为百度百科", "previous delivery is archived, not erased");
    assert.deepEqual(job.plan, [SEARCH], "plan kept");

    assert.equal((await f.store.session(work)).scene, "lightweight", "delivery restored the scene the task entered computer from");
    let phase = 0;
    f.engine.providers.chat = async (model, _system, messages, definitions) => {
      if (phase++ === 0) {
        assert.equal(model.selection, "p/light", "the follow-up starts from the restored origin scene");
        assert(definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("computer"), "the browser is one same-session switch away");
        assert(messages.some(m => m.calls?.some(c => c.name === "switch_scene")), "earlier history of the same session is present");
        const latest = messages.filter(m => m.role === "user" && m.runtime !== "dynamic").at(-1)!.text!;
        assert.match(latest, /在同一结果页点击第一条自然结果/);
        assert.match(latest, /已交付任务的直接后续.*不要重做/s);
        assert.match(latest, /在百度搜索「你好」并核实结果页/, "existing plan is shown to the run");
        return call("browser-again", "switch_scene", { scene: "computer", message: "在同一结果页点击第一条自然结果" });
      }
      if (phase === 2) {
        assert.equal(model.selection, "p/vision");
        assert(definitions.some(tool => tool.name === "chrome_navigate"));
        return complete("early", "未做新步骤就交付");
      }
      if (phase === 3) {
        const refused = messages.findLast(m => m.role === "tool" && m.name === "task_complete")!;
        assert(refused.error && /planRevision=0，revision=1/.test(refused.text!), "the old revision cannot be re-delivered before applying the supplement");
        return progress("p2", [SEARCH, CLICK]);
      }
      return complete("c2", "已点击首条结果，打开百度百科词条页");
    };
    job = await f.segment(job);
    assert.equal(job.status, "done");
    assert.equal(job.workSession, work, "same work session");
    assert.equal((await f.store.sessions()).filter(s => s.taskId).length, 1, "no new task session");
    assert.equal((await f.employee.state()).tasks.length, 1, "no new task");
    assert.deepEqual(job.plan, [SEARCH, CLICK]);
    assert.equal(job.summary, "已点击首条结果，打开百度百科词条页");
    assert.equal(job.deliveries[0].summary, "已搜索你好，结果页首条为百度百科");
    assert(job.finishedAt > 0);
    const sent = await f.deliveries();
    assert.equal(sent.length, 2, "exactly one new delivery for the new revision");
    assert.match(sent[1].text!, /百度百科词条页/);
    assert.doesNotMatch(sent[1].text!, /结果页首条为百度百科/, "the previous delivery is not replayed");

    const again = await f.employee.control({ action: "resume", id: first.id, text: "在同一结果页点击第一条自然结果" });
    assert.equal(again.duplicate, true, "the same supplement does not reopen a delivered revision");
    assert.equal(f.employee.task(await f.employee.state(), first.id).status, "done");
    assert.equal((await f.deliveries()).length, 2);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("follow-up eligibility depends on task state and original session, not delivery age", () => {
  const task = { status: "done", workSession: "w", finishedAt: 1 } as unknown as Task;
  assert.equal(followUpOpen(task), true, "an old delivery remains eligible");
  assert.equal(followUpOpen({ ...task, finishedAt: 0 } as Task), true, "legacy missing timestamps do not decide eligibility");
  for (const status of ["cancelled", "approval", "stopped", "failed", "running", "queued", "sealed"])
    assert.equal(followUpOpen({ ...task, status } as Task), false, status);
  assert.equal(followUpOpen({ ...task, dutyId: "d" } as Task), false, "duty runs are not reopened");
  assert.equal(followUpOpen({ ...task, side: "computer" } as Task), false);
  assert.equal(followUpOpen({ ...task, workSession: undefined } as Task), false);
});

test("without a supplement or for protected statuses a delivered task is not reopened", async () => {
  const f = await fixture();
  try {
    const job = await delivered(f);
    const set = (patch: Record<string, unknown>) => f.employee.update(s => { Object.assign(f.employee.task(s, job.id), patch); });
    const status = async () => f.employee.task(await f.employee.state(), job.id).status;

    await set({ finishedAt: Date.now() - 365 * 24 * 60 * 60_000 });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id }), /Only stopped\/failed\/cancelled tasks may continue/, "empty resume never reopens done");
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "   " }), /Invalid task supplement/);
    assert.equal(await status(), "done");

    await set({ dutyId: "duty-1" });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "再点一次" }), /职责触发.*不能直接续做/);
    await set({ dutyId: undefined });

    for (const blocked of ["cancelled", "approval"]) {
      await set({ status: blocked });
      await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "继续" }), /Use explicit approval or a new task/);
    }
    await set({ status: "stopped" });
    await f.employee.control({ action: "resume", id: job.id, text: "继续原任务" });
    assert.equal(await status(), "queued", "stopped tasks keep their existing supplement behavior");
    assert.equal(f.employee.task(await f.employee.state(), job.id).deliveries, undefined, "only a delivered task archives a delivery");
  } finally { await f.engine.close(); await f.store.close(); }
});

test("a supplement that lands after task_complete was accepted makes that completion stale: no delivery, the task runs again", async () => {
  const f = await fixture();
  try {
    const job = await f.add("搜索你好");
    const execute = f.employee.execute.bind(f.employee);
    let injected = false;
    (f.employee as any).execute = async (taskId: string, a: any) => {
      const result = await execute(taskId, a);
      if (a.action === "complete" && result.value?.ok && !injected) {
        injected = true;
        const reply = await f.employee.control({ action: "resume", id: job.id, text: "顺便点开第一条结果" });
        assert.match(String(reply.next), /Supplement saved/);
      }
      return result;
    };
    let phase = 0;
    f.engine.providers.chat = async () => phase++ === 0 ? progress("p1", [SEARCH]) : complete("c1", "已搜索你好");
    let current = await f.segment(job);
    assert.equal(current.status, "queued", "stale completion is not delivered");
    assert.equal((await f.deliveries()).length, 0);
    assert.match(current.answer, /未交付；在已验证结果基础上只做新增部分/);

    phase = 0;
    f.engine.providers.chat = async () => phase++ === 0 ? progress("p2", [SEARCH, CLICK]) : complete("c2", "已搜索并点开第一条结果");
    current = await f.segment(current);
    assert.equal(current.status, "done");
    const sent = await f.deliveries();
    assert.equal(sent.length, 1, "one delivery, for the newest revision only");
    assert.match(sent[0].text!, /点开第一条结果/);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("the communication session offers recent delivery candidates without an age deadline", async () => {
  const f = await fixture();
  try {
    const recent = await delivered(f);
    const old = await f.add("很久以前的任务");
    await f.employee.update(s => { Object.assign(f.employee.task(s, old.id), { status: "done", workSession: "w-old", finishedAt: Date.now() - 365 * 24 * 60 * 60_000 }); });
    let seen = "";
    f.engine.providers.chat = async (_model, system, messages) => { seen = system + "\n" + JSON.stringify(messages); return { role: "assistant", text: "好的" }; };
    await f.engine.run(f.chat.id, { role: "user", text: "点一下第一条结果" });
    const digest = seen.split("[近期已交付、可在原任务续做] ")[1]?.split("\n")[0] || "";
    assert(digest.includes(recent.id));
    assert(digest.includes(old.id), "age does not exclude a task");
    assert(!digest.includes("followUpUntil"));
    assert.match(seen, /不以时间决定/);
    assert.match(seen, /仍不明确则询问/);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("a quoted task is the primary reply target rather than other current tasks", async () => {
  const f = await fixture();
  try {
    const target = await delivered(f);
    const other = await f.add("另一条相似的任务");
    const newer: Task[] = [];
    for (let i = 0; i < 5; i++) newer.push(await f.add("另一条最近交付的任务 " + i));
    await f.employee.update(state => {
      for (const task of newer) Object.assign(f.employee.task(state, task.id), { status: "done", workSession: "other", finishedAt: Date.now() });
    });
    const delivery = (await f.deliveries())[0];
    const quote = await f.store.quote(f.chat.id, delivery.seq!);
    let calls = 0;
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      const focus = JSON.parse(input.split("[本次引用关联任务] ")[1].split("\n")[0]);
      assert.equal(focus.id, target.id);
      assert.equal(focus.status, "done", "the user-bound task snapshot stays pinned across tool rounds");
      if (calls) assert(messages.some(message => message.role === "tool" && message.callId === "resume-target" && !message.error), "the resume result is retained without rewriting the task snapshot");
      if (!calls) {
        assert.equal(focus.followUpOpen, true);
        const eligible = JSON.parse(input.split("[近期已交付、可在原任务续做] ")[1].split("\n")[0]);
        assert.deepEqual(eligible.map((task: Task) => task.id), [target.id], "the quoted task stays eligible even outside the five most recent deliveries");
      }
      for (const task of [other, ...newer]) assert(!input.includes(task.id), "unrelated tasks are not included in the target's injected summary");
      assert(!input.includes("[当前活跃任务摘要]"));
      if (calls++ === 0) return call("resume-target", "employee", { action: "resume", id: target.id, text: "改到 dev 分支" });
      return { role: "assistant", text: "只处理引用的任务。" };
    };
    await f.engine.run(f.chat.id, { role: "user", text: "后端改到 dev，我写错了", quote });
    const updated = f.employee.task(await f.employee.state(), target.id);
    assert.equal(updated.status, "queued");
    assert.equal(updated.workSession, target.workSession);
    assert.match(updated.answer, /改到 dev 分支/);
    assert.equal(f.employee.task(await f.employee.state(), other.id).answer, undefined);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("only unlinked or ambiguous quotes fall back to contextual task search", async () => {
  const f = await fixture();
  try {
    const first = await f.add("第一条任务"), second = await f.add("第二条任务");
    const sources = [
      { text: "没有任务链接" },
      { text: "链接了两条任务", tasks: [{ id: first.id, title: first.text, status: first.status }, { id: second.id, title: second.text, status: second.status }] },
      { text: "已不存在的任务", tasks: [{ id: "missing-task", title: "旧任务", status: "done" }] },
    ];
    const prompts: string[] = [];
    f.engine.providers.chat = async (_model, _system, messages) => {
      prompts.push(messages.findLast(m => m.role === "user")!.text!);
      return { role: "assistant", text: "先回答，不自动执行。" };
    };
    for (const source of sources) {
      const message = await f.store.append(f.chat.id, { role: "assistant", ...source });
      await f.engine.run(f.chat.id, { role: "user", text: "这是怎么回事？", quote: await f.store.quote(f.chat.id, message.seq!) });
    }
    for (const input of prompts.slice(0, 2)) {
      assert(input.includes("[引用消息未唯一关联任务]"));
      assert(input.includes("[当前活跃任务摘要]"));
      assert(input.includes(first.id) && input.includes(second.id));
      assert(!input.includes("[本次引用关联任务]"));
    }
    const missing = prompts[2];
    assert.match(missing, /\[本次引用关联任务\] {"id":"missing-task","status":"unavailable"}/);
    assert(!missing.includes("[当前活跃任务摘要]"), "a missing explicit task must not be substituted with a different task");
    const state = await f.employee.state();
    assert.equal(f.employee.task(state, first.id).status, "queued");
    assert.equal(f.employee.task(state, second.id).status, "queued");
  } finally { await f.engine.close(); await f.store.close(); }
});

test("quoting a task does not execute a question or override an explicit request about another task", async () => {
  const f = await fixture();
  try {
    const first = await f.add("第一条任务"), second = await f.add("第二条任务");
    const source = await f.store.append(f.chat.id, { role: "assistant", text: "第一条结果", tasks: [{ id: first.id, title: first.text, status: first.status }] });
    const quote = await f.store.quote(f.chat.id, source.seq!);
    let calls = 0;
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      assert.equal(JSON.parse(input.split("[本次引用关联任务] ")[1].split("\n")[0]).id, first.id);
      if (calls++ === 1) return call("stop-other", "employee", { action: "stop", id: second.id });
      return { role: "assistant", text: "已了解。" };
    };
    await f.engine.run(f.chat.id, { role: "user", text: "这是什么结果？", quote });
    assert.equal(f.employee.task(await f.employee.state(), first.id).status, "queued");
    await f.engine.run(f.chat.id, { role: "user", text: "另外请停掉第二条任务", quote });
    const state = await f.employee.state();
    assert.equal(f.employee.task(state, first.id).status, "queued");
    assert.equal(f.employee.task(state, second.id).status, "stopped");
  } finally { await f.engine.close(); await f.store.close(); }
});

test("an old quoted task remains the reply target and a question alone does not reopen it", async () => {
  const f = await fixture();
  try {
    const target = await delivered(f), other = await f.add("另一条任务");
    const delivery = (await f.deliveries())[0];
    await f.employee.update(state => { f.employee.task(state, target.id).finishedAt = Date.now() - 365 * 24 * 60 * 60_000; });
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      const focus = JSON.parse(input.split("[本次引用关联任务] ")[1].split("\n")[0]);
      assert.equal(focus.id, target.id);
      assert.equal(focus.followUpOpen, true);
      assert(input.includes("[近期已交付、可在原任务续做]"));
      assert(!input.includes(other.id));
      return { role: "assistant", text: "这是原任务的结果。" };
    };
    await f.engine.run(f.chat.id, { role: "user", text: "这条怎么处理？", quote: await f.store.quote(f.chat.id, delivery.seq!) });
    assert.equal(f.employee.task(await f.employee.state(), target.id).status, "done");
    assert.equal(f.employee.task(await f.employee.state(), other.id).status, "queued");
  } finally { await f.engine.close(); await f.store.close(); }
});

test("an older linked task is offered with all matching candidates and resumes its original goal through clarification waiting", async () => {
  const f = await fixture();
  const url = "https://example.test/stories/1120427644139799025";
  const clarify = { content: "澄清需求并等待回复", status: "cancelled" };
  const develop = { content: "开发并验证原需求", status: "cancelled" };
  try {
    const original = await delivered(f), work = original.workSession;
    const unrelated = await f.add("另一个站点的需求 https://other.test/stories/1120427644139799025");
    await f.employee.update(state => {
      const task = f.employee.task(state, original.id);
      Object.assign(task, { text: `开发 ${url}?from_iteration_id=old；澄清后开发并验证`, key: "tapd:1120427644139799025", finishedAt: Date.now() - 30 * 24 * 60 * 60_000, plan: [SEARCH, clarify, develop] });
      for (let i = 0; i < 35; i++) state.tasks.push({ ...task, id: `noise-${i}`, key: `noise:${i}`, text: `无关任务 ${i}`, status: "done" });
    });
    const sent = await f.add(`只发过澄清留言 ${url}?from_iteration_id=other`);
    await f.employee.update(state => Object.assign(f.employee.task(state, sent.id), { status: "done", workSession: "comment-session", summary: "留言已发布，@ 未生效" }));
    const chat = await f.store.session(f.chat.id);
    chat.frozenSystem = "旧规则：超过4小时应新建任务。";
    await f.store.saveSession(chat);
    let phase = 0;
    f.engine.providers.chat = async (_model, system, messages) => {
      assert.match(system, /\[任务续做规则\].*取代旧会话/s, "old frozen sessions receive the new policy");
      const input = messages.findLast(m => m.role === "user")!.text!;
      const candidates = JSON.parse(input.split("[按标识匹配的任务候选] ")[1].split("\n")[0]);
      assert.equal(candidates.total, 2);
      assert.deepEqual(new Set(candidates.tasks.map((task: Task) => task.id)), new Set([original.id, sent.id]));
      assert(!candidates.tasks.some((task: Task) => task.id === unrelated.id));
      assert.match(input, /多个候选.*仍不能区分/s);
      if (phase++ === 0) return call("resume-original", "employee", { action: "resume", id: original.id, text: "继续原需求：澄清留言已发布但 @ 未生效，先核对通知和回复，澄清后完成原开发与验证。" });
      return { role: "assistant", text: "继续原任务。" };
    };
    await f.engine.run(f.chat.id, { role: "user", text: `${url}?from_iteration_id=new 这个需求单没有在单里澄清吗？` });
    let current = f.employee.task(await f.employee.state(), original.id);
    assert.equal(current.status, "queued");
    assert.equal(current.workSession, work);
    assert.match(current.answer, /恢复仍需完成的步骤/);
    assert.match(current.answer, /留言已发布但 @ 未生效/);
    assert.deepEqual(current.plan, [SEARCH, clarify, develop], "the old plan stays available for evidence-based replanning");
    phase = 0;
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user" && m.runtime !== "dynamic")!.text!;
      assert.match(input, /留言已发布但 @ 未生效/);
      assert.match(input, /不要重复已执行的提交\/发送/);
      if (phase++ === 0) return progress("revise", [SEARCH, { ...clarify, status: "blocked" }, { ...develop, status: "pending" }]);
      return call("wait-for-reply", "task_wait", { checkpoint: "留言已发布但未确认触达；核对通知及回复，不重复发送", delayMinutes: 120 });
    };
    current = await f.segment(current);
    assert.equal(current.status, "deferred");
    assert.equal(current.workSession, work);
    assert.equal(current.plan[2].status, "pending");
    assert.match(current.checkpoint, /不重复发送/);
    const duplicate = await f.employee.execute("", { action: "add", kind: "todo", text: "继续原需求", key: "tapd:1120427644139799025" });
    assert.equal(duplicate.value.id, original.id);
    assert.equal(duplicate.value.exists, true);
    assert.match(duplicate.value.next, /没有自动续做/);
    assert.equal((await f.employee.state()).tasks.filter(task => task.id === original.id).length, 1);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("business keys and bare IDs identify historical candidates without prefix collisions", async () => {
  const f = await fixture();
  try {
    const task = await f.add("原开发任务"), other = await f.add("另一条任务"), legacy = await f.add("历史需求编号 1120427644139799025 的开发任务");
    await f.employee.update(state => {
      f.employee.task(state, task.id).key = "tapd:1120427644139799025";
      f.employee.task(state, other.id).key = "tapd:11204276441397990250";
    });
    const seen: string[] = [];
    f.engine.providers.chat = async (_model, _system, messages) => { seen.push(messages.findLast(m => m.role === "user")!.text!); return { role: "assistant", text: "收到。" }; };
    await f.engine.run(f.chat.id, { role: "user", text: "追问 tapd:1120427644139799025" });
    await f.engine.run(f.chat.id, { role: "user", text: "追问 1120427644139799025" });
    await f.engine.run(f.chat.id, { role: "user", text: "追问 112042764413979902599" });
    const exact = JSON.parse(seen[0].split("[按标识匹配的任务候选] ")[1].split("\n")[0]);
    assert.deepEqual(exact.tasks.map((item: Task) => item.id), [task.id]);
    const bare = JSON.parse(seen[1].split("[按标识匹配的任务候选] ")[1].split("\n")[0]);
    assert.deepEqual(new Set(bare.tasks.map((item: Task) => item.id)), new Set([task.id, legacy.id]), "legacy tasks without keys remain visible, and ambiguity is retained");
    assert(!seen[2].includes("[按标识匹配的任务候选]"), "a numeric prefix is not a business identity");
  } finally { await f.engine.close(); await f.store.close(); }
});

test("too many identifier matches are marked truncated instead of appearing unique", async () => {
  const f = await fixture();
  try {
    const task = await f.add("无关任务");
    await f.employee.update(state => {
      for (let i = 0; i < 21; i++) state.tasks.push({ ...task, id: `candidate-${i}`, text: `历史需求 1120427644139799025 第 ${i} 项` });
    });
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      const candidates = JSON.parse(input.split("[按标识匹配的任务候选] ")[1].split("\n")[0]);
      assert.equal(candidates.total, 21);
      assert.equal(candidates.truncated, true);
      assert.equal(candidates.tasks.length, 20);
      assert.match(input, /列表被截断时先问用户或按任务ID查询/);
      return { role: "assistant", text: "请指明要继续的任务。" };
    };
    await f.engine.run(f.chat.id, { role: "user", text: "继续 1120427644139799025" });
    assert((await f.employee.state()).tasks.every(item => item.status === "queued"));
  } finally { await f.engine.close(); await f.store.close(); }
});

test("identical supplements are idempotent within one user message but a later request can resume again", async () => {
  const f = await fixture();
  try {
    const task = await delivered(f);
    await f.engine.clearEmployeeChat(f.employee.employeeId);
    let calls = 0;
    f.engine.providers.chat = async () => calls++ < 2
      ? call(`same-${calls}`, "employee", { action: "resume", id: task.id, text: "继续" })
      : { role: "assistant", text: "继续。" };
    await f.engine.run(f.chat.id, { role: "user", text: "继续", at: 1000 });
    let current = f.employee.task(await f.employee.state(), task.id);
    assert.equal(current.revision, 1, "repeating a tool call from the same message is deduplicated");
    await f.employee.update(state => Object.assign(f.employee.task(state, task.id), { status: "done", finishedAt: Date.now() }));
    await f.engine.clearEmployeeChat(f.employee.employeeId);
    calls = 0;
    await f.engine.run(f.chat.id, { role: "user", text: "继续", at: 2000 });
    current = f.employee.task(await f.employee.state(), task.id);
    assert.equal(current.status, "queued");
    assert.equal(current.revision, 2, "a new user message is not the old request merely because its text is identical");
  } finally { await f.engine.close(); await f.store.close(); }
});

test("a quoted task is recalculated when a new message arrives during a chat turn", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await f.add("第一条任务"), second = await f.add("第二条任务");
    const source = async (task: Task) => f.store.quote(f.chat.id, (await f.store.append(f.chat.id, { role: "assistant", text: task.text, tasks: [{ id: task.id, title: task.text, status: task.status }] })).seq!);
    const firstQuote = await source(first), secondQuote = await source(second);
    let started!: () => void, calls = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      const focus = JSON.parse(input.split("[本次引用关联任务] ")[1].split("\n")[0]);
      assert.equal(focus.id, calls === 0 ? first.id : second.id);
      if (calls++ === 0) { started(); await gate; }
      return { role: "assistant", text: "已看到引用。" };
    };
    const running = f.engine.run(f.chat.id, { role: "user", text: "看第一条", quote: firstQuote });
    await ready;
    f.engine.steer(f.chat.id, { role: "user", text: "不，看第二条", quote: secondQuote });
    release();
    await running;
    assert.equal(calls, 2);
  } finally { release(); await f.engine.close(); await f.store.close(); }
});
