import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { FOLLOW_UP_WINDOW_MS, followUpOpen, type Task } from "../server/core/employee";
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

test("a direct follow-up within the window continues the delivered task in its own session, keeps the old result and plan, and delivers once more", async () => {
  const f = await fixture();
  try {
    const first = await delivered(f);
    const work = first.workSession;
    await f.employee.update(state => { f.employee.task(state, first.id).finishedAt = Date.now() - 3 * 60 * 60_000; });
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

test("follow-up window is a deterministic 4 hours from the latest delivery, inclusive at the boundary", () => {
  const now = 1_800_000_000_000;
  const task = { status: "done", workSession: "w", finishedAt: now - FOLLOW_UP_WINDOW_MS } as unknown as Task;
  assert.equal(FOLLOW_UP_WINDOW_MS, 4 * 60 * 60_000);
  assert.equal(followUpOpen(task, now), true, "exactly at the boundary");
  assert.equal(followUpOpen(task, now + 1), false, "one millisecond later");
  assert.equal(followUpOpen({ ...task, finishedAt: 0 } as Task, now), false);
  for (const status of ["cancelled", "approval", "stopped", "failed", "running", "queued"])
    assert.equal(followUpOpen({ ...task, status } as Task, now), false, status);
  assert.equal(followUpOpen({ ...task, dutyId: "d" } as Task, now), false, "duty runs are not reopened");
  assert.equal(followUpOpen({ ...task, side: "computer" } as Task, now), false);
});

test("outside the window, without a supplement or in other statuses the delivered task is not reopened and the error says to create a new task", async () => {
  const f = await fixture();
  try {
    const job = await delivered(f);
    const set = (patch: Record<string, unknown>) => f.employee.update(s => { Object.assign(f.employee.task(s, job.id), patch); });
    const status = async () => f.employee.task(await f.employee.state(), job.id).status;

    await set({ finishedAt: Date.now() - FOLLOW_UP_WINDOW_MS - 1000 });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "点击第一条结果" }), /超过 4 小时续做时限，未在原任务续做；请用 employee_task_create 新建任务/);
    assert.equal(await status(), "done");

    await set({ finishedAt: Date.now() - 1000 });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id }), /Only stopped\/failed\/cancelled tasks may continue/, "empty resume never reopens done");
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "   " }), /Invalid task supplement/);
    assert.equal(await status(), "done");

    await set({ dutyId: "duty-1" });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "再点一次" }), /职责触发.*employee_task_create/);
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

test("the communication session lists only recently delivered tasks as follow-up candidates and tells it to create new tasks otherwise", async () => {
  const f = await fixture();
  try {
    const recent = await delivered(f);
    const old = await f.add("很久以前的任务");
    await f.employee.update(s => { Object.assign(f.employee.task(s, old.id), { status: "done", workSession: "w-old", finishedAt: Date.now() - FOLLOW_UP_WINDOW_MS - 60_000 }); });
    let seen = "";
    f.engine.providers.chat = async (_model, system, messages) => { seen = system + "\n" + JSON.stringify(messages); return { role: "assistant", text: "好的" }; };
    await f.engine.run(f.chat.id, { role: "user", text: "点一下第一条结果" });
    const digest = seen.split("[近期已交付、可在原任务续做] ")[1]?.split("\n")[0] || "";
    assert(digest.includes(recent.id), "recent delivered task is offered");
    assert(digest.includes("followUpUntil"));
    assert(!digest.includes(old.id), "tasks outside the window are not offered");
    assert.match(seen, /目标不同、换了对象或已过 followUpUntil 的用 employee_task_create 新建/);
    assert.match(seen, /拿不准就新建；resume 被拒时改为新建，不要声称已在原任务续做/);
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

test("an expired quoted task remains the reply target without being reopened or replaced", async () => {
  const f = await fixture();
  try {
    const target = await delivered(f), other = await f.add("另一条任务");
    const delivery = (await f.deliveries())[0];
    await f.employee.update(state => { f.employee.task(state, target.id).finishedAt = Date.now() - FOLLOW_UP_WINDOW_MS - 1000; });
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      const focus = JSON.parse(input.split("[本次引用关联任务] ")[1].split("\n")[0]);
      assert.equal(focus.id, target.id);
      assert.equal(focus.followUpOpen, false);
      assert(!input.includes("[近期已交付、可在原任务续做]"));
      assert(!input.includes(other.id));
      return { role: "assistant", text: "原任务已过续做时限。" };
    };
    await f.engine.run(f.chat.id, { role: "user", text: "这条怎么处理？", quote: await f.store.quote(f.chat.id, delivery.seq!) });
    assert.equal(f.employee.task(await f.employee.state(), target.id).status, "done");
    assert.equal(f.employee.task(await f.employee.state(), other.id).status, "queued");
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
