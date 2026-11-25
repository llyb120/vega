import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { canChainFrom, type Task } from "../server/core/employee";
import { setWorkPrinciples } from "../server/core/work-principles";
import { chromeCall, employeeCall } from "./public-call";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/code", scenes: { lightweight: ["p/light"], coding: ["p/code"], computer: ["p/vision"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: Object.fromEntries(["light", "code", "vision"].map(id => [id, { modalities: { input: id === "vision" ? ["text", "image"] : ["text"] }, limit: { context: 128000, output: 8192 } }])) } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Follow-up employee" }, "owner")).id);
  const chat = await employee.chat("owner");
  const add = async (text: string, extra: Record<string, unknown> = {}) => {
    const created = await employee.execute("", { action: "add", kind: "todo", text, ...extra });
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
const complete = (id: string, summary: string, extra: Record<string, unknown> = {}) => call(id, "employee", { action: "complete", deliverableRef: [], text: summary + "（证据）", summary, ...extra });
const SEARCH = { content: "在百度搜索「你好」并核实结果页", status: "completed" };

/** First delivery: search done in the computer scene of the task's own work session. */
async function delivered(f: Awaited<ReturnType<typeof fixture>>) {
  let phase = 0;
  f.engine.providers.chat = async (model) => {
    if (phase++ === 0) return call("browser", "browser_agent", { task: "百度搜索你好" });
    if (model.selection === "p/vision") return { role: "assistant", text: "已搜索你好，结果页首条为百度百科" };
    return phase === 3 ? progress("p1", [SEARCH]) : complete("c1", "已搜索你好，结果页首条为百度百科");
  };
  const job = await f.segment(await f.add("在服务端浏览器百度搜索「你好」"));
  assert.equal(job.status, "done");
  return job;
}

test("delivered tasks are frozen and cannot be resumed; follow-up creates a linked child task with inherited context", async () => {
  const f = await fixture();
  try {
    const first = await delivered(f);
    const work = first.workSession;
    const blobId = await f.store.blob("text/plain", Buffer.from("deliverable file"));
    await f.employee.update(state => {
      const task = f.employee.task(state, first.id);
      task.finishedAt = Date.now() - 90 * 24 * 60 * 60_000;
      task.deliverableFiles = [{ name: "report.txt", mime: "text/plain", size: 16, blobId }];
    });
    assert.equal((await f.deliveries()).length, 1);

    await assert.rejects(
      f.employee.control({ action: "resume", id: first.id, text: "在同一结果页点击第一条自然结果" }),
      /已完成并交付的任务不可重新启动/,
    );
    await assert.rejects(
      f.employee.control({ action: "resume", id: first.id }),
      /Only stopped\/failed tasks may continue/,
    );
    assert.equal(f.employee.task(await f.employee.state(), first.id).status, "done", "done task stays frozen");

    const created = await f.employee.execute("", {
      action: "add",
      kind: "todo",
      text: "在同一结果页点击第一条自然结果",
      parentTaskId: first.id,
      relation: "follow_up",
    });
    assert.ok(created.value.id && created.value.id !== first.id);
    assert.equal(created.value.parentId, first.id);
    assert.equal(created.value.edgeKind, "follow_up");
    assert.equal(created.value.chainSeq, 2);

    const stateAfterCreate = await f.employee.state();
    const frozenParent = f.employee.task(stateAfterCreate, first.id);
    assert.equal(frozenParent.status, "done");
    assert.equal(frozenParent.chainId, created.value.chainId);
    assert.equal(frozenParent.chainSeq, 1);

    let child = f.employee.task(stateAfterCreate, created.value.id);
    let phase = 0;
    f.engine.providers.chat = async (model, _system, messages) => {
      if (phase++ === 0) {
        assert.equal(model.selection, "p/light");
        const latest = messages.filter(m => m.role === "user" && m.runtime !== "dynamic").at(-1)!.text!;
        assert.match(latest, /\[前置任务链上下文\]/);
        assert.match(latest, /不得改动其历史交付物/);
        assert.match(latest, /已搜索你好，结果页首条为百度百科/);
        assert.match(latest, /report\.txt/);
        return progress("p2", [{ content: "点击第一条自然结果并核实", status: "completed" }]);
      }
      return complete("c2", "已点击首条结果，打开百度百科词条页");
    };
    child = await f.segment(child);
    assert.equal(child.status, "done");
    assert.notEqual(child.workSession, work, "follow-up gets its own clean work session");
    assert.ok(await f.store.one("SELECT 1 FROM blob_access WHERE blob_id=? AND session=?", blobId, child.workSession), "parent deliverable blobs are granted to child session");
    assert.equal(f.employee.task(await f.employee.state(), first.id).summary, "已搜索你好，结果页首条为百度百科", "parent summary untouched");
    const sent = await f.deliveries();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].tasks?.[0]?.id, first.id);
    assert.equal(sent[1].tasks?.[0]?.id, child.id);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("cancelled branch retry hangs under parent #1 (or sibling root when #1 cancelled) and inherits clean parent context", async () => {
  const f = await fixture();
  try {
    const t1 = await delivered(f);
    const t2Created = await f.employee.execute("", {
      action: "add", kind: "todo", text: "方案A补充", parentTaskId: t1.id, relation: "follow_up",
    });
    await f.employee.execute("", { action: "done", id: t2Created.value.id }); // cancelled
    const t2 = f.employee.task(await f.employee.state(), t2Created.value.id);
    assert.equal(t2.status, "cancelled");

    await assert.rejects(f.employee.control({ action: "resume", id: t2.id }), /Only stopped\/failed tasks may continue/);
    await assert.rejects(f.employee.control({ action: "resume", id: t2.id, text: "继续" }), /已取消的任务不可原地恢复/);

    const t3Created = await f.employee.execute("", {
      action: "add", kind: "todo", text: "方案B重做", parentTaskId: t2.id, relation: "retry", branchLabel: "改用方案B",
    });
    assert.equal(t3Created.value.chainId, t2Created.value.chainId);
    assert.equal(t3Created.value.parentId, t1.id, "retry of #2 hangs directly under #1");
    assert.equal(t3Created.value.retryOf, t2.id);
    assert.equal(t3Created.value.edgeKind, "retry");
    assert.equal(t3Created.value.chainSeq, 3);

    const t3 = f.employee.task(await f.employee.state(), t3Created.value.id);
    let sawContext = "";
    f.engine.providers.chat = async (_model, _system, messages) => {
      sawContext = messages.filter(m => m.role === "user" && m.runtime !== "dynamic").at(-1)!.text!;
      return complete("c3", "方案B完成");
    };
    await f.segment(t3);
    assert.match(sawContext, /直接前置交付任务.*已搜索你好/s);
    assert.match(sawContext, /被替代的分支任务.*方案A补充/s);

    // Root cancellation retry stays at root level under same chainId
    const root = await f.add("独立根任务");
    await f.employee.execute("", { action: "done", id: root.id });
    const rootRetry = await f.employee.execute("", {
      action: "add", kind: "todo", text: "根任务重做", parentTaskId: root.id, relation: "retry",
    });
    assert.equal(rootRetry.value.parentId, undefined);
    assert.equal(rootRetry.value.retryOf, root.id);
    assert.equal(rootRetry.value.chainSeq, 2);
    assert.equal(rootRetry.value.chainId, f.employee.task(await f.employee.state(), root.id).chainId);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("redispatch joins the task chain and /new forbids parentTaskId", async () => {
  const f = await fixture();
  try {
    await setWorkPrinciples(f.store, "owner", "核对条目总数");
    let round = 0;
    f.engine.providers.chat = async () => round++ === 0
      ? progress("p", [{ content: "整理资料", status: "completed" }])
      : complete("c", "已整理资料");
    const original = await f.segment(await f.add("整理指定资料"));
    assert.equal(original.status, "done");

    const redispatched = await f.employee.control({ action: "redispatch", id: original.id, confirmed: true });
    assert.equal(redispatched.parentId, original.id);
    assert.equal(redispatched.edgeKind, "follow_up");
    assert.equal(redispatched.chainSeq, 2);
    const copy = f.employee.task(await f.employee.state(), redispatched.id);
    assert.equal(copy.chainId, f.employee.task(await f.employee.state(), original.id).chainId);

    // /new rejects parentTaskId in communication session
    await f.store.append(f.chat.id, { role: "user", text: "用新任务重来", newTask: true });
    const config = await f.engine.config(), model = await f.engine.catalog.resolve(config, "p/light");
    const { Tools } = await import("../server/core/tools");
    const session = await f.store.session(f.chat.id);
    const tools = await Tools.create(f.engine, session, config, new AbortController().signal, () => {});
    await assert.rejects(
      tools.execute({ id: "new-chain-deny", name: "employee_task_create", arguments: { instructions: "全新任务", parentTaskId: original.id } }, model),
      /\/new.*不要传 parentTaskId/,
    );
  } finally { await f.engine.close(); await f.store.close(); }
});

test("canChainFrom and stopped vs done/cancelled/sealed control boundaries", async () => {
  const f = await fixture();
  try {
    const task = { status: "done", workSession: "w", finishedAt: 1 } as unknown as Task;
    assert.equal(canChainFrom(task), true);
    assert.equal(canChainFrom({ ...task, status: "cancelled" } as Task), true);
    assert.equal(canChainFrom({ ...task, status: "sealed" } as Task), false);
    assert.equal(canChainFrom({ ...task, dutyId: "d" } as Task), false);

    const job = await delivered(f);
    const set = (patch: Record<string, unknown>) => f.employee.update(s => { Object.assign(f.employee.task(s, job.id), patch); });
    const status = async () => f.employee.task(await f.employee.state(), job.id).status;

    await assert.rejects(f.employee.control({ action: "resume", id: job.id }), /Only stopped\/failed tasks may continue/);
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "   " }), /Invalid task supplement/);
    assert.equal(await status(), "done");

    await set({ status: "cancelled" });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id }), /Only stopped\/failed tasks may continue/);
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "继续" }), /已取消的任务不可原地恢复/);

    await set({ status: "approval" });
    await assert.rejects(f.employee.control({ action: "resume", id: job.id, text: "继续" }), /Use explicit approval or a new task/);

    await set({ status: "stopped" });
    await f.employee.control({ action: "resume", id: job.id, text: "继续原任务" });
    assert.equal(await status(), "queued", "stopped tasks keep their existing supplement behavior");
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
    f.engine.providers.chat = async (_model, _system, messages) => {
      phase++;
      if (phase === 1) return progress("p1", [SEARCH]);
      if (phase === 2) return complete("c1", "已搜索你好");
      const latest = [...messages].reverse().find((message) => message.role === "user" && message.runtime !== "dynamic")?.text || "";
      assert.match(latest, /顺便点开第一条结果/);
      assert.match(latest, /轮中补充/);
      assert.equal(f.employee.busy.has(job.id), true);
      assert.equal(phase, 3);
      return { role: "assistant", text: "已看到补充，本轮不交付。" };
    };
    let current = await f.segment(job);
    assert.equal(current.status, "queued");
    assert.equal((await f.deliveries()).length, 0);
    assert.match(current.answer, /未交付；在已验证结果基础上只做新增部分/);

    phase = 0;
    f.engine.providers.chat = async () => phase++ === 0
      ? progress("p2", [SEARCH, { content: "点开第一条结果", status: "completed" }])
      : complete("c2", "已搜索并点开第一条结果");
    current = await f.segment(current);
    assert.equal(current.status, "done");
    const sent = await f.deliveries();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text!, /点开第一条结果/);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("the communication session lists recent frozen done tasks and guides parentTaskId chaining", async () => {
  const f = await fixture();
  try {
    const recent = await delivered(f);
    const old = await f.add("很久以前的任务");
    await f.employee.update(s => { Object.assign(f.employee.task(s, old.id), { status: "done", workSession: "w-old", finishedAt: Date.now() - 365 * 24 * 60 * 60_000 }); });
    let seen = "";
    f.engine.providers.chat = async (_model, system, messages) => { seen = system + "\n" + JSON.stringify(messages); return { role: "assistant", text: "好的" }; };
    await f.engine.run(f.chat.id, { role: "user", text: "点一下第一条结果" });
    const digest = seen.split("[近期已完成任务（只读冻结，后续需求请用 parentTaskId 建链）] ")[1]?.split("\n")[0] || "";
    assert(digest.includes(recent.id));
    assert(digest.includes(old.id), "age does not exclude a task");
    assert.match(seen, /不要对 done 任务使用 resume/);
    assert.match(seen, /\[任务续做与任务链规则\]/);
  } finally { await f.engine.close(); await f.store.close(); }
});

test("explicit # taskRefs and quoted tasks focus the right task and guide follow_up creation for done tasks", async () => {
  const f = await fixture();
  try {
    const target = await delivered(f);
    const other = await f.add("另一条相似的任务");
    let calls = 0;
    f.engine.providers.chat = async (_model, _system, messages) => {
      const input = messages.findLast(m => m.role === "user")!.text!;
      const focus = JSON.parse(input.split("[本次 # 显式引用任务] ")[1].split("\n")[0]);
      assert.equal(focus.id, target.id);
      assert.equal(focus.status, "done");
      assert.equal(focus.intent, "follow_up");
      assert.match(input, /严禁调用 resume/);
      assert(!input.includes(other.id));
      if (calls++ === 0) return call("chain-next", "employee", { action: "add", kind: "todo", text: "改到 dev 分支", parentTaskId: target.id, relation: "follow_up" });
      return { role: "assistant", text: "已基于原交付建后续任务。" };
    };
    await f.engine.run(f.chat.id, {
      role: "user",
      text: "后端改到 dev，我写错了",
      taskRefs: [{ id: target.id, title: target.text, status: "done", intent: "follow_up" }],
    });
    const state = await f.employee.state();
    assert.equal(f.employee.task(state, target.id).status, "done");
    const child = state.tasks.find(t => t.parentId === target.id);
    assert.ok(child, "child task created on chain");
    assert.equal(child!.edgeKind, "follow_up");
    assert.equal(child!.chainId, f.employee.task(state, target.id).chainId);
    assert.equal(f.employee.task(state, other.id).answer, undefined);
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
    assert(!missing.includes("[当前活跃任务摘要]"));
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

test("dedupeKey blocks duplicate active tasks, blocks blind duplicate of done tasks, but allows explicit parentTaskId chaining", async () => {
  const f = await fixture();
  try {
    const first = await f.add("开发需求 123", { key: "tapd:123" });
    const dupActive = await f.employee.execute("", { action: "add", kind: "todo", text: "重复需求", key: "tapd:123" });
    assert.equal(dupActive.value.exists, true);
    assert.equal(dupActive.value.id, first.id);

    await f.employee.update(s => { f.employee.task(s, first.id).status = "done"; });
    const dupDone = await f.employee.execute("", { action: "add", kind: "todo", text: "没传parentTaskId的重开", key: "tapd:123" });
    assert.equal(dupDone.value.exists, true);
    assert.match(dupDone.value.next, /不可重启/);

    const chained = await f.employee.execute("", { action: "add", kind: "todo", text: "基于123后续完善", key: "tapd:123", parentTaskId: first.id, relation: "follow_up" });
    assert.equal(chained.value.exists, undefined);
    assert.equal(chained.value.parentId, first.id);
    assert.equal(chained.value.chainSeq, 2);
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
