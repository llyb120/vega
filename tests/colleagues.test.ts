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

test("handoff from a task: dedupe, source on the new task, result wakes the waiting task, cycles and depth are refused", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("A", "u1", "personal"), b = await make("B", "u1"), c = await make("C", "u1"), d = await make("D", "u1");
    await settings(b, { publicSummary: "负责发布" });
    const origin = await todo(a, "整理发布");
    await a.update((s) => { const t = a.task(s, origin); t.status = "deferred"; t.nextCheckAt = Date.now() + 3600_000; });
    const sent = await colleagueHandoff(engine, a, { taskId: origin, session: "" }, { colleagueId: b.employeeId, instructions: "发布 1.2", dedupeKey: "rel-1.2" });
    assert.equal(sent.exists, undefined);
    const again = await colleagueHandoff(engine, a, { taskId: origin, session: "" }, { colleagueId: b.employeeId, instructions: "发布 1.2", dedupeKey: "rel-1.2" });
    assert.equal(again.taskId, sent.taskId); assert.equal(again.exists, true);
    const received = await task(b, sent.taskId);
    assert.equal(received.text, "发布 1.2");
    assert.deepEqual({ ...received.handoffFrom, at: 0 }, { employeeId: a.employeeId, name: "A", taskId: origin, session: "", chain: [a.employeeId], at: 0 });
    assert.equal((await task(a, origin)).handoffs.length, 1);
    // B hands to C, C to D: depth 3 reached, D cannot hand on; C cannot hand back to A (cycle).
    const toC = await colleagueHandoff(engine, b, { taskId: sent.taskId, session: "" }, { colleagueId: c.employeeId, instructions: "子任务" });
    await assert.rejects(colleagueHandoff(engine, c, { taskId: toC.taskId, session: "" }, { colleagueId: a.employeeId, instructions: "回去" }), /循环/);
    const toD = await colleagueHandoff(engine, c, { taskId: toC.taskId, session: "" }, { colleagueId: d.employeeId, instructions: "孙任务" });
    assert.deepEqual((await task(d, toD.taskId)).handoffFrom.chain, [a.employeeId, b.employeeId, c.employeeId]);
    await assert.rejects(colleagueHandoff(engine, d, { taskId: toD.taskId, session: "" }, { colleagueId: (await engine.employee.profile()).id, instructions: "再转" }), /最多 3 层/);
    assert.match(await colleaguePrompt(d, await task(d, toD.taskId)), /已达转交层数上限/);
    // B finishes: the result is a supplement on A's task, which wakes up.
    await finish(b, sent.taskId, "done", "已发布 1.2");
    const woken = await task(a, origin);
    assert.equal(woken.status, "queued"); assert.equal(woken.nextCheckAt, 0); assert.equal(woken.supplementPending, true);
    assert.match(woken.answer, /牛马「B」处理转交任务 .* 已完成[\s\S]*已发布 1\.2/);
    assert.equal(woken.handoffs[0].status, "done");
    // Saving B again does not deliver twice; a resumed and re-finished task reports again.
    await b.update(() => {});
    assert.equal((await task(a, origin)).answer.match(/已发布/g).length, 1);
    await b.update((s) => { b.task(s, sent.taskId).status = "queued"; });
    await finish(b, sent.taskId, "failed", "回滚了");
    assert.match((await task(a, origin)).answer, /已失败[\s\S]*回滚了/);
  } finally { await close(); }
});

test("handoff from chat posts the result to the chat; colleagues who turned requests off are hidden and refused", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1"), c = await make("C", "u1");
    const chat = await a.chat("u1");
    const sent = await colleagueHandoff(engine, a, { session: chat.id }, { colleagueId: b.employeeId, instructions: "查一下" });
    assert.equal((await a.profile()).handoffs![0].taskId, sent.taskId);
    await finish(b, sent.taskId, "cancelled");
    assert.match((await store.messages(chat.id)).at(-1)!.text!, /牛马「B」处理转交任务 .* 已被取消/);
    assert.equal((await a.profile()).handoffs![0].status, "cancelled");
    await settings(c, { acceptsColleagues: false });
    assert.doesNotMatch(await colleaguePrompt(a), /C（id=/);
    await assert.rejects(colleagueHandoff(engine, a, { session: chat.id }, { colleagueId: c.employeeId, instructions: "x" }), /未开启接受/);
    await assert.rejects(colleagueAsk(engine, a, { colleagueId: c.employeeId, question: "x" }, new AbortController().signal), /未开启接受/);
    await assert.rejects(settings(c, { publicSummary: "长".repeat(301) }), /最多 300 字/);
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

test("colleague tools: visible in chat and main task sessions, handoff hidden at the depth limit, complete warns about open handoffs", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1");
    const chat = await a.chat("u1");
    const model = { supportsImages: false } as any;
    const chatTools = await Tools.create(engine, chat, await engine.config(chat), new AbortController().signal, () => {});
    const visible = (await chatTools.definitions(model)).map((d) => d.name);
    assert(visible.includes("colleague_handoff") && visible.includes("colleague_ask"));
    const result = await chatTools.execute({ id: "h", name: "colleague_handoff", arguments: { colleagueId: b.employeeId, instructions: "帮忙核对", dedupeKey: "k1" } }, model);
    assert.equal(result.value.colleague.name, "B");
    assert.equal((await task(b, result.value.taskId)).handoffFrom.session, chat.id);

    const id = await todo(a, "主任务");
    await a.update((s) => { a.task(s, id).status = "running"; });
    const session = await store.newSession({ cwd: ".", employeeId: a.employeeId, taskId: id });
    a.busy.set(id, { session: session.id } as any);
    const taskTools = await Tools.create(engine, session, await engine.config(session), new AbortController().signal, () => {});
    const handed = await taskTools.execute({ id: "t", name: "colleague_handoff", arguments: { colleagueId: b.employeeId, instructions: "子工作" } }, model);
    assert.equal((await task(b, handed.value.taskId)).handoffFrom.taskId, id);
    const blocked = (await a.execute(id, { action: "complete", text: "done" })).value;
    assert.match(blocked.error, /1 项转交未返回结果/);
    assert.match(JSON.stringify((await a.execute(id, { action: "list" })).value.handoffs), new RegExp(handed.value.taskId));
    await a.update((s) => { a.task(s, id).handoffFrom = { employeeId: "x", name: "X", taskId: "", session: "", chain: ["x", "y", "z"] }; });
    const deep = (await taskTools.definitions(model)).map((d) => d.name);
    assert(!deep.includes("colleague_handoff") && deep.includes("colleague_ask"));
    a.busy.delete(id);
  } finally { await close(); }
});

test("handoff records self-heal: receiver deleted or reset, or the record vanished, ends them as lost and wakes the sender", async () => {
  const { engine, store, make, close } = await fixture();
  try {
    const a = await make("A", "u1"), b = await make("B", "u1"), c = await make("C", "u1");
    const origin = await todo(a, "整理");
    await a.update((s) => { const t = a.task(s, origin); t.status = "deferred"; t.nextCheckAt = Date.now() + 3600_000; });
    const toB = await colleagueHandoff(engine, a, { taskId: origin, session: "" }, { colleagueId: b.employeeId, instructions: "子任务 B" });
    const chat = await a.chat("u1");
    const toC = await colleagueHandoff(engine, a, { session: chat.id }, { colleagueId: c.employeeId, instructions: "子任务 C" });
    // Deleting the receiver ends the sender's record and wakes its task.
    b.deleting = true; await b.forget();
    let t = await task(a, origin);
    assert.equal(t.handoffs[0].status, "lost"); assert.equal(t.handoffs[0].result, "对方牛马已删除");
    assert.equal(t.status, "queued"); assert.equal(t.supplementPending, true); assert.match(t.answer, /不会再有结果：对方牛马已删除/);
    // Resetting the receiver: the chat-origin record ends and a notice lands in the chat.
    c.resetting = true; await c.clearWork(); c.resetting = false;
    assert.equal((await a.profile()).handoffs![0].status, "lost");
    assert.match((await store.messages(chat.id)).at(-1)!.text!, /不会再有结果：对方任务已不存在/);
    // Lazy path: a record whose target vanished without any hook (e.g. a crash) heals on the next status read.
    const again = await colleagueHandoff(engine, a, { session: chat.id }, { colleagueId: c.employeeId, instructions: "再来" });
    await store.dropEmployeeRows(c.employeeId);
    await a.execute("", { action: "list" });
    assert.equal((await a.profile()).handoffs!.find((h) => h.taskId === again.taskId)!.status, "lost");
    // A target that ended without reporting is delivered as a normal result by the scheduler pass.
    const origin2 = await todo(a, "第二个");
    const toC2 = await colleagueHandoff(engine, a, { taskId: origin2, session: "" }, { colleagueId: c.employeeId, instructions: "x" });
    await store.putEmployeeTask(c.employeeId, toC2.taskId, false, Date.now(), JSON.stringify({ ...(await task(c, toC2.taskId)), status: "done", summary: "做完了" }));
    await a.tick();
    assert.equal((await task(a, origin2)).handoffs[0].status, "done");
    assert.match((await task(a, origin2)).answer, /做完了/);
    // A lost handoff no longer blocks task_complete.
    await a.update((s) => { a.task(s, origin).status = "running"; a.task(s, origin).supplementPending = false; });
    a.busy.set(origin, { session: "x" } as any);
    await assert.rejects(a.execute(origin, { action: "complete", text: "e" }), /settled plan/); // past the handoff check
    a.busy.delete(origin);
    assert.equal(toC.exists, undefined);
  } finally { await close(); }
});
