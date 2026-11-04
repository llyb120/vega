import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { colleagueAsk, colleagueHandoff, colleaguePrompt, colleaguesOf, parseMentions } from "../server/core/colleagues";
import type { Employee } from "../server/core/employee";
import { sleep } from "../server/core/util";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const make = async (name: string, owner: string, scope: "team" | "personal" = "personal", extra = {}) =>
    await engine.employee.for((await engine.employee.create({ name, ...extra }, owner, scope)).id);
  const close = async () => { await engine.close(); await store.close(); };
  return { store, engine, make, close };
}
const names = async (employee: Employee) => (await colleaguesOf(employee)).map((c) => c.profile.name).sort();
const settings = (employee: Employee, a: object) => employee.control({ action: "settings", ...a });
const task = async (employee: Employee, id: string) => employee.task(await employee.state(), id);
const finish = (employee: Employee, id: string, status: string, summary = "") =>
  employee.update((s) => { const t = employee.task(s, id); t.status = status; t.summary = summary; t.finishedAt = Date.now(); });
const todo = async (employee: Employee, text: string) => (await employee.execute("", { action: "add", kind: "todo", text })).value.id as string;
const until = async (ready: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !await ready(); i++) await sleep(5);
  assert(await ready());
};
const deferred = (employee: Employee, id: string) => employee.update((s) => { const t = employee.task(s, id); t.status = "deferred"; t.nextCheckAt = Date.now() + 3600_000; });
/** Deliver handoffs into the receiver's chat without running a model turn. */
const quietChats = (engine: Engine) => { engine.submitChat = async (session, message) => { await engine.store.append(session, message); }; };
/** The scripted model of each chat: a list of replies, one per model request, by session. */
function script(engine: Engine, replies: Record<string, any[]>) {
  const seen: { key: string; system: string; messages: any[] }[] = [];
  engine.providers.chat = (async (_model: any, system: string, messages: any[], _tools: any, _signal: any, _emit: any, key: string) => {
    seen.push({ key, system, messages });
    const next = replies[key]?.shift();
    assert(next, "unexpected model request in " + key);
    return { role: "assistant", model: "fixture/model", ...next };
  }) as any;
  return seen;
}
/** The colleague message last delivered into a chat (delivery runs after commit, so wait for it). */
async function delivered(engine: Engine, chat: string, count = 1) {
  const all = async () => (await engine.store.messages(chat)).filter((m) => m.colleague);
  await until(async () => (await all()).length >= count);
  return (await all()).at(-1)!;
}
const idle = (engine: Engine, session: string) => until(() => !engine.active.has(session));

test("reach rule: personal employees reach the owner's other personal employees and the team; team employees reach the team", async () => {
  const { make, close } = await fixture();
  try {
    const p1 = await make("P1", "u1"), q1 = await make("Q1", "u2"), t1 = await make("T1", "admin", "team");
    await make("P2", "u1"); await make("T2", "admin", "team");
    assert.deepEqual(await names(p1), ["P2", "T1", "T2", "默认牛马"]);
    assert.deepEqual(await names(q1), ["T1", "T2", "默认牛马"]);
    assert.deepEqual(await names(t1), ["T2", "默认牛马"]);
  } finally { await close(); }
});

test("names are unique across everything one user can see, on create and rename, also under concurrent creates", async () => {
  const { engine, make, close } = await fixture();
  try {
    const p1 = await make("小助手", "u1"); await make("发布员", "admin", "team");
    await assert.rejects(make("发布员", "u1"), /发布员.*团队牛马/);
    await assert.rejects(make(" 小助手 ", "u1"), /已被/);
    await assert.rejects(make("ABC", "u1").then(() => make("abc", "u1")), /同一用户能看到的牛马/);
    await make("小助手", "u2"); // another user's personal employee may reuse the name
    await assert.rejects(make("小助手", "admin", "team"), /小助手.*小助手/s); // a team name would clash for u1 and u2
    await assert.rejects(settings(p1, { name: "发布员" }), /已被/);
    await settings(p1, { name: "小助手" }); // unchanged name is fine
    const results = await Promise.allSettled([make("并发", "u3"), make("并发", "u3")]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((await Promise.all((await engine.employee.all()).map((e) => e.profile()))).filter((p) => p.name === "并发").length, 1);
  } finally { await close(); }
});

test("@mentions in instructions must name a reachable colleague, and follow renames", async () => {
  const { make, close } = await fixture();
  try {
    const p1 = await make("P1", "u1"), t1 = await make("发布 助手", "admin", "team"), q1 = await make("Q1", "u2");
    await settings(p1, { instruction: "发布问题交给 @发布 助手 处理；邮件发 ops@example.com" });
    await assert.rejects(settings(p1, { instruction: "问 @不存在的人" }), /@不存在的人.*不是可协作的牛马/);
    await assert.rejects(settings(p1, { instruction: "问 @Q1" }), /@Q1/); // another user's personal employee
    await assert.rejects(settings(t1, { instruction: "问 @P1" }), /团队牛马只能 @ 团队牛马/);
    await assert.rejects(settings(p1, { instruction: "@P1 自己" }), /不能 @ 自己/);
    await assert.rejects(make("P3", "u1", "personal", { instruction: "@没有" }), /@没有/);
    assert.equal((await names(q1)).includes("P3"), false); // the rejected create left nothing behind
    await settings(t1, { name: "上线员" });
    assert.equal((await p1.profile()).instruction, "发布问题交给 @上线员 处理；邮件发 ops@example.com");
    assert.deepEqual(parseMentions("a@上线员b", [{ id: "x", name: "上线员" }]).found, []);
    const prompt = await colleaguePrompt(p1);
    assert.match(prompt, new RegExp(`@上线员=${t1.employeeId}`));
  } finally { await close(); }
});

test("handoff from a task: a colleague message in B's chat starts B's turn; B's task carries the origin; reply, progress, question and result return to A's task", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1");
    const origin = await todo(a, "整理发布");
    await deferred(a, origin);
    const chatB = await b.chat("u1");
    const seen = script(engine, { [chatB.id]: [
      { text: "", calls: [{ id: "c1", name: "employee_task_create", arguments: { instructions: "发布 1.2 到预发" } }] },
      { text: "已安排发布任务" },
      { text: "收到，已转给任务" },
    ] });
    const sent = await colleagueHandoff(engine, a, { taskId: origin, session: "", chain: [] }, { colleagueId: b.employeeId, instructions: "发布 1.2", dedupeKey: "rel-1.2" });
    assert.equal(sent.status, "sent");
    await until(() => seen.length >= 2); await idle(engine, chatB.id);
    // B's chat holds the colleague message (labelled, not the human), and its model was told who asked.
    const asked = (await store.messages(chatB.id)).find((m) => m.role === "user")!;
    assert.equal(asked.text, "发布 1.2"); assert.equal(asked.colleague!.name, "A"); assert.equal(asked.colleague!.taskId, origin);
    assert.match(seen[0].messages.at(-1).text, /同事牛马「A」.*转交请求.*rel-1\.2[\s\S]*发布 1\.2$/);
    // The task B's chat created inherits the origin; A's record follows it and keeps B's reply as progress.
    const created = (await b.state()).tasks.find((t) => t.handoffFrom)!;
    assert.equal(created.text, "发布 1.2 到预发");
    assert.deepEqual(created.handoffFrom.chain, [a.employeeId]); assert.equal(created.chatSource.seq, asked.seq);
    let record = (await task(a, origin)).handoffs[0];
    assert.equal(record.taskId, created.id); assert.equal(record.status, "queued"); assert.match(record.progress, /已安排发布任务/);
    assert.equal((await task(a, origin)).status, "deferred", "progress does not wake the sender");
    // tellUser progress is recorded without waking A.
    await b.update((s) => { b.task(s, created.id).status = "running"; });
    b.busy.set(created.id, { session: "x" } as any);
    await b.execute(created.id, { action: "progress", text: "预发构建中", tellUser: true });
    assert.equal((await task(a, origin)).handoffs[0].progress, "预发构建中");
    assert.equal((await task(a, origin)).status, "deferred");
    // B asks: the question shows in B's chat and wakes A with the thread to answer on.
    await b.execute(created.id, { action: "help", text: "发哪个区域？" });
    b.busy.delete(created.id);
    let woken = await task(a, origin);
    assert.equal(woken.status, "queued"); assert.equal(woken.supplementPending, true);
    assert.match(woken.answer, /需要答复[\s\S]*发哪个区域？[\s\S]*dedupeKey=rel-1\.2/);
    assert.equal(woken.handoffs[0].status, "waiting");
    // A answers on the same thread: a follow-up in B's chat with the same handoff; the identical text again is a retry.
    const reply = await colleagueHandoff(engine, a, { taskId: origin, session: "", chain: [] }, { colleagueId: b.employeeId, instructions: "华东区", dedupeKey: "rel-1.2" });
    assert.equal((reply as any).followUp, true);
    assert.equal((await colleagueHandoff(engine, a, { taskId: origin, session: "", chain: [] }, { colleagueId: b.employeeId, instructions: "华东区", dedupeKey: "rel-1.2" }) as any).duplicate, true);
    await until(() => seen.length >= 3); await idle(engine, chatB.id);
    const followUps = (await store.messages(chatB.id)).filter((m) => m.colleague?.handoffId === record.id);
    assert.deepEqual(followUps.map((m) => m.text), ["发布 1.2", "华东区"]);
    assert.equal((await task(a, origin)).handoffs.length, 1);
    // B finishes: the result wakes A once; saving B again does not deliver twice; a re-finish reports again.
    await deferred(a, origin);
    await finish(b, created.id, "done", "已发布 1.2");
    woken = await task(a, origin);
    assert.equal(woken.status, "queued"); assert.match(woken.answer, /牛马「B」处理转交（编号 rel-1\.2）的任务 .* 已完成[\s\S]*已发布 1\.2/);
    record = woken.handoffs[0];
    assert.equal(record.status, "done"); assert.equal(record.result, "已发布 1.2");
    await b.update(() => {});
    assert.equal((await task(a, origin)).answer.match(/已发布 1\.2/g).length, 1);
    await b.update((s) => { b.task(s, created.id).status = "queued"; });
    await finish(b, created.id, "failed", "回滚了");
    assert.match((await task(a, origin)).answer, /已失败[\s\S]*回滚了/);
    // A's chat shows the whole exchange: A's handoff and follow-up, then B's reply, progress, question and results,
    // each from B and linked to A's task.
    const chatA = (await store.messages((await a.profile()).chatSession!)).map((m) => ({ from: m.colleague?.name || "", text: m.text!.split("（")[0], task: m.tasks?.[0]?.id }));
    assert.deepEqual(chatA.map((m) => [m.from, m.text]), [
      ["", "转交给牛马「B」"], ["B", "牛马「B」关于转交"], ["B", "牛马「B」关于转交"], ["B", "牛马「B」处理转交"],
      ["", "回复牛马「B」"], ["B", "牛马「B」关于转交"], ["B", "牛马「B」处理转交"], ["B", "牛马「B」处理转交"],
    ]);
    assert(chatA.every((m) => m.task === origin));
  } finally { await close(); }
});

test("handoff from chat: B answering directly goes back to A's chat as B's message; colleagues may only work on tasks; refused when requests are off", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1"), c = await make("C", "u1");
    const chatA = await a.chat("u1"), chatB = await b.chat("u1");
    script(engine, { [chatB.id]: [
      { text: "", calls: [{ id: "d1", name: "employee_duty_create", arguments: { instructions: "每天汇报", trigger: { kind: "manual" } } }] },
      { text: "生产库在 db-7，不需要派任务" },
    ] });
    const sent = await colleagueHandoff(engine, a, { session: chatA.id, chain: [] }, { colleagueId: b.employeeId, instructions: "查一下生产库在哪" });
    assert.ok(sent.dedupeKey, "a generated thread key comes back");
    await until(async () => (await store.messages(chatA.id)).some((m) => m.colleague));
    // A colleague's message may not change B's duties, memories or credentials.
    assert.match((await store.messages(chatB.id)).find((m) => m.role === "tool")!.text!, /来自同事牛马「A」.*只能派单/);
    assert.equal((await b.state()).duties.length, 0);
    const back = (await store.messages(chatA.id)).at(-1)!;
    assert.equal(back.role, "assistant"); assert.equal(back.colleague!.name, "B");
    assert.match(back.text!, /牛马「B」答复了转交[\s\S]*db-7/);
    const record = (await a.profile()).handoffs![0];
    assert.equal(record.status, "replied"); assert.match(record.result, /db-7/);
    await settings(c, { acceptsColleagues: false });
    assert.doesNotMatch(await colleaguePrompt(a), /C（id=/);
    await assert.rejects(colleagueHandoff(engine, a, { session: chatA.id, chain: [] }, { colleagueId: c.employeeId, instructions: "x" }), /未开启接受/);
    await assert.rejects(colleagueAsk(engine, a, { colleagueId: c.employeeId, question: "x" }, new AbortController().signal), /未开启接受/);
    await assert.rejects(settings(c, { publicSummary: "长".repeat(301) }), /最多 300 字/);
  } finally { await close(); }
});

test("a failed colleague turn and an undeliverable handoff still answer the sender", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1"), c = await make("C", "u1");
    const chatA = await a.chat("u1"), chatB = await b.chat("u1");
    engine.providers.chat = (async () => { throw Object.assign(Error("模型不可用"), { status: 400 }); }) as any;
    await colleagueHandoff(engine, a, { session: chatA.id, chain: [] }, { colleagueId: b.employeeId, instructions: "帮忙" });
    await until(async () => (await store.messages(chatA.id)).some((m) => m.colleague));
    await idle(engine, chatB.id);
    assert.match((await store.messages(chatA.id)).at(-1)!.text!, /这轮对话出错：.*模型不可用/);
    engine.submitChat = async () => { throw Error("执行位置正在切换"); };
    await colleagueHandoff(engine, a, { session: chatA.id, chain: [] }, { colleagueId: c.employeeId, instructions: "帮忙" });
    await until(async () => (await a.profile()).handoffs!.some((h) => h.employeeId === c.employeeId && h.status === "lost"));
    assert.match((await store.messages(chatA.id)).at(-1)!.text!, /没能送到牛马「C」.*执行位置正在切换/);
  } finally { await close(); }
});

test("ask is one tool-less model call on the colleague's side, built from its summary, instruction, duties and memories", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1", "personal", { instruction: "负责数据库" });
    await settings(b, { publicSummary: "管理数据库" });
    await b.update((s) => { s.memories.push({ id: "m1", kind: "fact", claim: "生产库在 db-7", scope: "global", scene: "any", status: "active", confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() }); });
    let seen: any;
    engine.providers.chat = (async (_model: any, system: string, messages: any[], tools: any[]) => { seen = { system, messages, tools }; return { role: "assistant", text: "生产库在 db-7" }; }) as any;
    const reply = await colleagueAsk(engine, a, { colleagueId: b.employeeId, question: "生产库在哪？" }, new AbortController().signal);
    assert.equal(reply.answer, "生产库在 db-7");
    assert.deepEqual(seen.tools, []);
    assert.match(seen.system, /同事牛马「A」/); assert.match(seen.system, /管理数据库/); assert.match(seen.system, /负责数据库/); assert.match(seen.system, /db-7/);
    assert.equal(seen.messages[0].text, "生产库在哪？");
    await assert.rejects(colleagueAsk(engine, a, { colleagueId: "nobody", question: "?" }, new AbortController().signal), /不是可协作的牛马/);
  } finally { await close(); }
});

test("depth and cycles follow the chain through chats; colleague tools hide handoff at the limit; complete warns about open handoffs", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    quietChats(engine);
    const a = await make("A", "u1"), b = await make("B", "u1"), c = await make("C", "u1"), d = await make("D", "u1");
    const chatA = await a.chat("u1"), model = { supportsImages: false } as any;
    const chatTools = await Tools.create(engine, chatA, await engine.config(chatA), new AbortController().signal, () => {});
    const visible = (await chatTools.definitions(model)).map((x) => x.name);
    assert(visible.includes("colleague_handoff") && visible.includes("colleague_ask"));
    const result = await chatTools.execute({ id: "h", name: "colleague_handoff", arguments: { colleagueId: b.employeeId, instructions: "帮忙核对", dedupeKey: "k1" } }, model);
    assert.equal(result.value.colleague.name, "B");
    // B's chat now answers A's message: its own handoffs carry the chain [A, B].
    const chatB = await b.chat("u1");
    assert.equal((await delivered(engine, chatB.id)).colleague!.session, chatA.id);
    const toolsB = await Tools.create(engine, chatB, await engine.config(chatB), new AbortController().signal, () => {});
    await toolsB.execute({ id: "h2", name: "colleague_handoff", arguments: { colleagueId: c.employeeId, instructions: "子工作" } }, model);
    const chatC = await c.chat("u1"), toC = (await delivered(engine, chatC.id)).colleague!;
    assert.deepEqual(toC.chain, [a.employeeId, b.employeeId]);
    await assert.rejects(colleagueHandoff(engine, c, { session: chatC.id, chain: toC.chain }, { colleagueId: a.employeeId, instructions: "回去" }), /循环/);
    await colleagueHandoff(engine, c, { session: chatC.id, chain: toC.chain }, { colleagueId: d.employeeId, instructions: "孙工作" });
    const chatD = await d.chat("u1"), toD = (await delivered(engine, chatD.id)).colleague!;
    assert.deepEqual(toD.chain, [a.employeeId, b.employeeId, c.employeeId]);
    await assert.rejects(colleagueHandoff(engine, d, { session: chatD.id, chain: toD.chain }, { colleagueId: (await engine.employee.profile()).id, instructions: "再转" }), /最多 3 层/);
    assert.match(await colleaguePrompt(d, toD as any), /已达层数上限/);
    const toolsD = await Tools.create(engine, chatD, await engine.config(chatD), new AbortController().signal, () => {});
    const deep = (await toolsD.definitions(model)).map((x) => x.name);
    assert(!deep.includes("colleague_handoff") && deep.includes("colleague_ask"));
    // A task created for the deep message inherits the chain, so its task session cannot hand on either.
    await toolsD.execute({ id: "t1", name: "employee_task_create", arguments: { instructions: "做孙工作" } }, model);
    const deepTask = (await d.state()).tasks.at(-1)!;
    assert.deepEqual(deepTask.handoffFrom.chain, toD.chain);
    assert.match(await colleaguePrompt(d, deepTask.handoffFrom, true), /本任务来自牛马「C」的转交请求/);

    const id = await todo(a, "主任务");
    await a.update((s) => { a.task(s, id).status = "running"; });
    const session = await store.newSession({ cwd: ".", employeeId: a.employeeId, taskId: id });
    a.busy.set(id, { session: session.id } as any);
    const taskTools = await Tools.create(engine, session, await engine.config(session), new AbortController().signal, () => {});
    await taskTools.execute({ id: "t", name: "colleague_handoff", arguments: { colleagueId: b.employeeId, instructions: "子工作", dedupeKey: "sub" } }, model);
    assert.equal((await delivered(engine, chatB.id, 2)).colleague!.taskId, id);
    const blocked = (await a.execute(id, { action: "complete", text: "done" })).value;
    assert.match(blocked.error, /1 项转交未返回结果（B（编号 sub，等待对方答复））/);
    assert.match(JSON.stringify((await a.execute(id, { action: "list" })).value.handoffs), /"key":"sub"/);
    await a.update((s) => { a.task(s, id).handoffFrom = { handoffId: "h", key: "k", employeeId: "x", name: "X", taskId: "", session: "", chain: ["x", "y", "z"] }; });
    const capped = (await taskTools.definitions(model)).map((x) => x.name);
    assert(!capped.includes("colleague_handoff") && capped.includes("colleague_ask"));
    a.busy.delete(id);
  } finally { await close(); }
});

test("handoff records self-heal: receiver deleted, its task gone, its chat cleared, or a result never reported", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    quietChats(engine);
    const a = await make("A", "u1"), b = await make("B", "u1"), c = await make("C", "u1");
    const link = async (receiver: Employee, text: string, handedOff: string) => {
      // What B's chat does for the colleague message: create a task linked to it.
      const chat = await receiver.chat("u1");
      await until(async () => (await store.lastMessage(chat.id, "user"))?.text === handedOff);
      const tools = await Tools.create(engine, chat, await engine.config(chat), new AbortController().signal, () => {});
      await tools.execute({ id: "x" + text, name: "employee_task_create", arguments: { instructions: text } }, { supportsImages: false } as any);
      return (await receiver.state()).tasks.at(-1)!;
    };
    const origin = await todo(a, "整理");
    await deferred(a, origin);
    await colleagueHandoff(engine, a, { taskId: origin, session: "", chain: [] }, { colleagueId: b.employeeId, instructions: "子任务 B" });
    await link(b, "B 的任务", "子任务 B");
    // Deleting the receiver ends the sender's record and wakes its task.
    b.deleting = true; await b.forget();
    let t = await task(a, origin);
    assert.equal(t.handoffs[0].status, "lost"); assert.equal(t.handoffs[0].result, "对方牛马已删除");
    assert.equal(t.status, "queued"); assert.equal(t.supplementPending, true); assert.match(t.answer, /不会再有结果：对方牛马已删除/);
    // Resetting the receiver drops its linked task: the chat-origin record ends with a notice in A's chat.
    const chatA = await a.chat("u1");
    await colleagueHandoff(engine, a, { session: chatA.id, chain: [] }, { colleagueId: c.employeeId, instructions: "子任务 C" });
    const linked = await link(c, "C 的任务", "子任务 C");
    assert.equal((await a.profile()).handoffs![0].taskId, linked.id);
    c.resetting = true; await c.clearWork(); c.resetting = false;
    assert.equal((await a.profile()).handoffs![0].status, "lost");
    assert.match((await store.messages(chatA.id)).at(-1)!.text!, /不会再有结果：对方任务已不存在/);
    // A handoff still waiting in C's chat (no task yet) is lost once that chat is cleared (after the delivery grace).
    await colleagueHandoff(engine, a, { session: chatA.id, chain: [] }, { colleagueId: c.employeeId, instructions: "再来", dedupeKey: "again" });
    const waiting = () => a.profile().then((p) => p.handoffs!.find((h) => h.key === "again")!);
    await engine.clearEmployeeChat(c.employeeId);
    assert.equal((await waiting()).status, "sent", "still inside the delivery grace");
    await a.reconcileHandoffs(Date.now() + 61_000);
    assert.equal((await waiting()).status, "lost"); assert.match((await waiting()).result, /聊天被清空或重置/);
    // A target that ended without reporting (e.g. a crash) is delivered as a normal result by the scheduler pass.
    const origin2 = await todo(a, "第二个");
    await colleagueHandoff(engine, a, { taskId: origin2, session: "", chain: [] }, { colleagueId: c.employeeId, instructions: "x" });
    const toC2 = await link(c, "C 的第二个任务", "x");
    await store.putEmployeeTask(c.employeeId, toC2.id, false, Date.now(), JSON.stringify({ ...toC2, status: "done", summary: "做完了" }));
    await a.tick();
    assert.equal((await task(a, origin2)).handoffs[0].status, "done");
    assert.match((await task(a, origin2)).answer, /做完了/);
    // A lost handoff no longer blocks task_complete.
    await a.update((s) => { a.task(s, origin).status = "running"; a.task(s, origin).supplementPending = false; });
    a.busy.set(origin, { session: "x" } as any);
    await assert.rejects(a.execute(origin, { action: "complete", text: "e" }), /settled plan/); // past the handoff check
    a.busy.delete(origin);
  } finally { await close(); }
});
