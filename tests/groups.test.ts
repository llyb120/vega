import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { Auth } from "../server/core/auth";
import { GROUP_HOPS_MAX } from "../server/core/groups";
import { NARRATOR, NARRATOR_SYSTEM } from "../server/core/narrator";
import { NEW_TASK_NOTICE, newCommand } from "../server/core/new-session";
import { readFileSync } from "node:fs";
import { parseMentions } from "../server/core/names";
import { sleep } from "../server/core/util";
import { chatHistory } from "../server/core/chat-page";

const u1 = { id: "u1", role: "operator" }, u2 = { id: "u2", role: "operator" }, u3 = { id: "u3", role: "operator" };
async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  for (const [id, name] of [["u1", "alice"], ["u2", "bob"], ["u3", "carol"]]) await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", id, name, "x", "operator", 0, Date.now(), 0);
  const make = async (name: string, owner: string) => (await engine.employee.create({ name }, owner)).id as string;
  const close = async () => { await engine.close(); await store.close(); };
  return { store, engine, make, close };
}
const until = async (ready: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 600 && !await ready(); i++) await sleep(5);
  assert(await ready());
};
/** Scripted model replies, by employee id (each group member has its own hidden session). */
const narrated: any[] = [];
function script(engine: Engine, replies: Record<string, any[]>) {
  const seen: { employeeId: string; system: string; messages: any[] }[] = [];
  narrated.length = 0;
  engine.providers.chat = (async (_model: any, system: string, messages: any[], _tools: any, _signal: any, _emit: any, key: string) => {
    // The 旁白 (its own hidden session): scripted under "narrator"; by default it routes to nobody.
    if (system === NARRATOR_SYSTEM) {
      const last = String(messages.at(-1).text), setup = /^\[本群设定\]\n(.*)$/m.exec(last)?.[1];
      narrated.push({ session: key, messages: JSON.parse(JSON.stringify(messages)), last, setup: setup && JSON.parse(setup) });
      const next = replies.narrator?.shift();
      if (next instanceof Error) throw next;
      if (next?.text) return { role: "assistant", text: next.text };
      return { role: "assistant", calls: [{ id: "n", name: "route_message", arguments: next ?? { targets: [], reason: "闲聊" } }] };
    }
    const employeeId = (await engine.store.session(key)).employeeId!;
    seen.push({ employeeId, system, messages });
    const next = replies[employeeId]?.shift();
    assert(next !== undefined, "unexpected model request for " + employeeId);
    return { role: "assistant", model: "fixture/model", ...(typeof next === "string" ? { text: next } : next) };
  }) as any;
  return seen;
}
const groupMessages = async (engine: Engine, groupId: string) => (await engine.store.messages((await engine.groups.get(groupId))!.session));
const settle = async (engine: Engine) => { await sleep(20); await until(() => engine.active.size === 0); await sleep(20); await until(() => engine.active.size === 0); };
/** Dispatch runs after commit: wait until a turn actually starts before waiting for it to finish. */
const settleRuns = async (engine: Engine) => { await until(() => engine.active.size > 0); await settle(engine); };

test("mentions match the longest member name and ignore e-mail-like @", () => {
  const people = [{ kind: "employee", id: "a", name: "小A" }, { kind: "employee", id: "ab", name: "小AB" }, { kind: "user", id: "u", name: "bob" }] as any;
  assert.deepEqual(parseMentions("@小AB 看下，抄送 @bob，邮件 x@小A", people).map((m) => m.id), ["ab", "u"]);
});

test("membership: users join by invitation, bring only their own employees, and take them along when they leave", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u2"), a2 = await make("小A2", "u1");
    const group = await engine.groups.create(u1, { name: "发布群", bulletin: "小A 写代码，小B 测试", employees: [a] });
    assert.equal(group.isCreator, true);
    await assert.rejects(engine.groups.addEmployee(u1, group.id, b), /只能邀请你名下的热心市民/);
    await assert.rejects(engine.groups.mine(u2, group.id), /群聊不存在|不在/);
    await assert.rejects(engine.groups.addEmployee(u2, group.id, b), /群聊不存在|不在/, "a non-member cannot add anything");
    await engine.groups.addUsers(u1, group.id, ["u2"]);
    await engine.groups.addEmployee(u2, group.id, b);
    let view = await engine.groups.view((await engine.groups.get(group.id))!, u2);
    assert.deepEqual(view.users.map((u) => u.name), ["alice", "bob"], "creator first: the avatar grid starts with the 群主");
    assert.deepEqual(view.employees.map((e) => [e.name, e.mine]), [["小A", false], ["小B", true]]);
    await assert.rejects(engine.groups.update(u2, group.id, { bulletin: "x" }), /只有群主/);
    await assert.rejects(engine.groups.removeEmployee(u2, group.id, a), /归属用户或群主可以将其移出群聊/);
    // Names must stay unique in the group, also on rename.
    await assert.rejects((await engine.employee.for(a2)).control({ action: "settings", name: "小B" }).then(() => engine.groups.addEmployee(u1, group.id, a2)), /同名/);
    // bob leaves: his employee leaves with him.
    await engine.groups.removeUser(u2, group.id, "u2");
    view = await engine.groups.view((await engine.groups.get(group.id))!, u1);
    assert.deepEqual(view.employees.map((e) => e.name), ["小A"]);
    // Deleting an employee takes it out of every group.
    await engine.groups.addUsers(u1, group.id, ["u3"]);
    await engine.removeEmployee(a);
    assert.deepEqual((await engine.groups.get(group.id))!.employees, []);
    // The creator leaves: the next user becomes 群主; the last user leaving dissolves the group.
    await engine.groups.removeUser(u1, group.id, "u1");
    assert.equal((await engine.groups.get(group.id))!.creatorId, "u3");
    const session = (await engine.groups.get(group.id))!.session;
    await engine.groups.removeUser(u3, group.id, "u3");
    assert.equal(await engine.groups.get(group.id), undefined);
    assert.equal(await engine.store.hasSession(session), false);
    const texts = (await engine.groups.list(u1)).length;
    assert.equal(texts, 0);
  } finally { await close(); }
});

test("an @ starts that member's turn with the group context; members @ each other; no @ means no reply", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u2");
    const group = await engine.groups.create(u1, { name: "发布群", bulletin: "小A 写代码，小B 测试", users: ["u2"], employees: [a] });
    await engine.groups.addEmployee(u2, group.id, b);
    const seen = script(engine, { [a]: ["写好了 @小B 请测一下"], [b]: ["测试通过"] });
    await engine.groups.send(u1, group.id, { text: "@bob 大家好" });
    await settle(engine);
    assert.equal(seen.length, 0, "only a user was @mentioned: no employee answers");
    await engine.groups.send(u1, group.id, { text: "@小A 实现登录页" });
    await settleRuns(engine);
    const messages = await groupMessages(engine, group.id);
    const said = messages.filter((m) => !m.notice).map((m) => [m.author?.name, m.text, m.hop]);
    assert.deepEqual(said.slice(-3), [["alice", "@小A 实现登录页", 0], ["小A", "写好了 @小B 请测一下", 1], ["小B", "测试通过", 2]]);
    // A's turn saw the group context (both messages it had not seen), the bulletin and who its owner is.
    const turnA = seen.find((s) => s.employeeId === a)!;
    assert.match(turnA.system, /群公告[\s\S]*小A 写代码，小B 测试/);
    assert.match(turnA.system, /你的归属用户：alice/);
    const input = JSON.stringify(turnA.messages);
    assert.match(input, /大家好/);
    assert.match(input, /来自用户「alice」（你的归属用户）/);
    // B was triggered by A: a guest request.
    assert.match(JSON.stringify(seen.find((s) => s.employeeId === b)!.messages), /来自热心市民「小A」（不是你的归属用户/);
    // Private chats are untouched; group sessions are not regular sessions.
    const privateChat = (await (await engine.employee.for(a)).state()).chatSession;
    assert(!privateChat || (await engine.store.messages(privateChat)).length === 0, "the private chat is separate");
    const hidden = (await engine.store.sessions()).filter((s: any) => s.groupId);
    assert.equal(hidden.length, 3, "the group conversation plus one session per member");
  } finally { await close(); }
});

test("group replies surface a selected source once, and a user reply to an employee does not need an @", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u1");
    const group = await engine.groups.create(u1, { name: "回复群", users: [u2.id], employees: [a, b] });
    const session = (await engine.groups.get(group.id))!.session;
    // A referenced bot message must not replay an @mention from the quoted text.
    const source = await store.append(session, { role: "assistant", text: "@小B 以灰度批次三为准。" + "甲".repeat(180) + "末尾信息", author: { kind: "employee", id: a, name: "小A" } });
    for (let i = 0; i < 22; i++) await store.append(session, { role: "user", text: "其他话题", author: { kind: "user", id: u1.id, name: "alice" } });
    const seen = script(engine, { [a]: [`[[reply:${source.seq}]]\n这次核对的是批次三。`], [b]: ["不需要引用。", "[[reply:999999]]\n无效编号不会变成引用。"] });
    await engine.groups.send(u2, group.id, { text: "具体是哪个批次？", quote: await store.quote(session, source.seq!) });
    await until(async () => (await groupMessages(engine, group.id)).some((m) => m.text === "这次核对的是批次三。"));
    const rows = await groupMessages(engine, group.id);
    const reply = rows.at(-1)!;
    assert.equal(reply.quote?.seq, source.seq);
    assert.deepEqual(reply.quote?.author, source.author);
    assert.deepEqual(seen.map((r) => r.employeeId), [a]);
    assert.equal(narrated.length, 0);
    const ask = seen[0].messages.findLast((m) => m.role === "user" && !m.runtime).text;
    assert.match(ask, new RegExp(`回复 #${source.seq}`));
    assert.match(ask, /末尾信息/, "the cited source remains readable outside the recent window");
    assert.match(seen[0].system, /默认直接回复，不加引用/);
    await engine.groups.send(u2, group.id, { text: "@小B 看看这条", quote: await store.quote(session, source.seq!) });
    await until(async () => (await groupMessages(engine, group.id)).some((m) => m.text === "不需要引用。"));
    assert.equal((await groupMessages(engine, group.id)).at(-1)?.quote, undefined);
    await engine.groups.send(u2, group.id, { text: "@小B 再确认一下" });
    await until(async () => (await groupMessages(engine, group.id)).some((m) => m.text === "无效编号不会变成引用。"));
    assert.equal((await groupMessages(engine, group.id)).at(-1)?.quote, undefined);
    assert.deepEqual(seen.map((r) => r.employeeId), [a, b, b], "explicit mentions override quote routing");
  } finally { await close(); }
});

test("task topics collect linked group messages and address replies to the right employee without a new conversation", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u1");
    const room = await engine.groups.create(u1, { name: "话题群", users: [u2.id], employees: [a, b] });
    const group = (await engine.groups.get(room.id))!;
    const title = "核对第三批灰度";
    const seen = script(engine, { [a]: [{ text: "", calls: [{ id: "create", name: "employee_task_create", arguments: { instructions: title } }] }, "我来核对灰度。", "主聊天的状态回复。", "我按第三批核对。"] });
    const brief = await store.append(group.session, { role: "user", text: "本轮只核对灰度，不发布。", author: { kind: "user", id: u2.id, name: "bob" } });
    const source = await engine.groups.send(u2, group.id, { text: `@小A ${title}`, quote: await store.quote(group.session, brief.seq!) });
    const waitFor = (text: string) => until(async () => (await groupMessages(engine, group.id)).some((m) => m.text === text));
    await waitFor("我来核对灰度。");
    await settle(engine);
    const employee = await engine.employee.for(a), task = (await employee.state()).tasks.find((t) => t.text === title)!;
    assert.deepEqual(task.group?.sourceSeqs, [source.seq]);
    await engine.groups.send(u2, group.id, { text: `@小A ${task.id} 现在进度怎样？` });
    await waitFor("主聊天的状态回复。");
    await settle(engine);
    const progressText = "第四项核对中";
    await engine.groups.post(task.group!, a, { role: "assistant", text: progressText, progress: true, topicTaskId: task.id }, false);
    for (let i = 0; i < 202; i++) await store.append(group.session, { role: "user", text: "无关聊天", author: { kind: "user", id: u1.id, name: "alice" } });
    const quote = await store.quote(group.session, source.seq!);
    const followup = await engine.groups.send(u2, group.id, { text: "再补一项，请一并核对。", quote, topicTaskId: task.id });
    await waitFor("我按第三批核对。");
    const scoped = await engine.groups.topicMessages((await engine.groups.get(group.id))!, task.id);
    assert.deepEqual(scoped.map((m) => m.text), [brief.text, `@小A ${title}`, "我来核对灰度。", `@小A ${task.id} 现在进度怎样？`, "主聊天的状态回复。", progressText, "再补一项，请一并核对。", "我按第三批核对。"]);
    assert.equal(scoped.at(-2)?.quote?.seq, source.seq);
    assert.equal(scoped.at(-1)?.replyToSeq, followup.seq);
    assert((await groupMessages(engine, group.id)).some((m) => m.seq === followup.seq), "topic and main chat share the same transcript");
    const page = await chatHistory(store, group.session, new URLSearchParams("limit=1"), scoped);
    assert.equal(page.messages[0].text, "我按第三批核对。");
    assert.equal(page.hasMore, true);
    const request = seen.at(-1)!.messages.findLast((m) => m.role === "user" && !m.runtime);
    assert.match(request.text, /当前任务话题/);
    assert.doesNotMatch(request.text, /无关聊天/);
    assert.match(seen.at(-1)!.messages.at(-1).text, /本次话题关联群任务/);
    assert(seen.every((turn) => turn.employeeId === a) && narrated.length === 0);
    const armed = await engine.groups.send(u2, group.id, { text: "/new", topicTaskId: task.id });
    assert((await engine.groups.topicMessages((await engine.groups.get(group.id))!, task.id)).some((m) => m.seq === armed.seq && m.notice && m.newTask && m.text === NEW_TASK_NOTICE));
    const other = await engine.groups.create(u1, { name: "其他群", employees: [a] });
    await assert.rejects(engine.groups.topicMessages((await engine.groups.get(other.id))!, task.id), { statusCode: 404 });
    await assert.rejects(engine.groups.send(u1, other.id, { text: "错误的话题", topicTaskId: task.id }), { statusCode: 404 });
  } finally { await close(); }
});

test("topic restores an older kickoff after the chat source moves; reset only allows a unique verbatim recovery", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", u1.id);
    const room = await engine.groups.create(u1, { name: "旧话题", users: [u2.id], employees: [a] });
    const group = (await engine.groups.get(room.id))!, title = "统一指标口径";
    const original = "请检查看板里的全部指标，修复两种语言提示口径不一致的问题。";
    script(engine, { [a]: [{ calls: [{ id: "create", name: "employee_task_create", arguments: { instructions: title } }] }, "我来检查。"] });
    const first = await engine.groups.send(u2, group.id, { text: `@小A ${original}` });
    await until(async () => (await groupMessages(engine, group.id)).some((m) => m.text === "我来检查。"));
    await settle(engine);
    const employee = await engine.employee.for(a), task = (await employee.state()).tasks.find((t) => t.text === title)!;
    const current = (await engine.groups.get(group.id))!, member = current.memberSessions[a];
    const requester = task.group!.requester;
    const unrelated = await store.append(group.session, { role: "user", text: "检查另一个看板的提示文案", author: requester });
    const later = await store.append(group.session, { role: "user", text: "补充：沿用现有分支", author: requester });
    const latest = await store.append(member, { role: "user", text: later.text, group: { groupId: group.id, name: group.name, from: requester, seq: later.seq!, byOwner: false } });
    await employee.update((state) => {
      const record = employee.task(state, task.id);
      record.group!.sourceSeqs = [later.seq!];
      record.chatSource = { session: member, seq: latest.seq! };
    });
    const seqs = async () => (await engine.groups.topicMessages((await engine.groups.get(group.id))!, task.id)).map((m) => m.seq);
    let linked = await seqs();
    assert.equal(linked[0], first.seq, "the actual creation receipt restores the kickoff before the later supplement");
    assert(!linked.includes(unrelated.seq));
    await store.deleteSession(member);
    assert.equal(await store.hasSession(member), false);
    assert(!(await seqs()).includes(first.seq), "do not guess when the original and receipts are lost");
    const outsider = await store.append(group.session, { role: "user", text: original, at: task.createdAt - 1, author: { kind: "user", id: u1.id, name: "alice" } });
    await employee.update((state) => { employee.task(state, task.id).text = `目标：${title}\n用户原话：「${original}」`; });
    linked = await seqs();
    assert.equal(linked[0], first.seq, "legacy tasks with a copied original request can still be recovered after member session reset");
    assert(!linked.includes(outsider.seq), "only the original requester's text qualifies");
    await store.append(group.session, { role: "user", text: original, at: task.createdAt - 1, author: requester });
    assert(!(await seqs()).includes(first.seq), "identical repeated messages do not identify a unique kickoff");
  } finally { await close(); }
});

test("group task identifier matches are scoped to the same group and the current message", async () => {
  const { engine, make, close } = await fixture();
  try {
    const employeeId = await make("小A", "u1"), employee = await engine.employee.for(employeeId);
    const group = await engine.groups.create(u1, { name: "关联任务", employees: [employeeId] });
    const url = "https://example.test/stories/1120427644139799025";
    const grouped = (await employee.execute("", { action: "add", kind: "todo", text: `群内开发 ${url}` })).value.id;
    const privateTask = (await employee.execute("", { action: "add", kind: "todo", text: `私聊任务 ${url}` })).value.id;
    await employee.update(state => {
      employee.task(state, grouped).group = { groupId: group.id, name: group.name, hop: 0, requester: { kind: "user", id: "u1", name: "alice" }, byOwner: true };
    });
    const groupSession = (await engine.groups.get(group.id))!.session;
    await engine.store.append(groupSession, { role: "user", text: `上次讨论了 ${url}`, author: { kind: "user", id: "u1", name: "alice" } });
    const seen = script(engine, { [employeeId]: ["收到", "收到"] });
    await engine.groups.send(u1, group.id, { text: "@小A 你好" });
    await until(() => seen.length > 0);
    await settle(engine);
    assert(!seen[0].messages.findLast((message: any) => message.role === "user").text.includes("[按标识匹配的任务候选]"), "an older group message is not the current task request");
    await engine.groups.send(u1, group.id, { text: `@小A ${url}?from_iteration_id=1 请继续` });
    await until(() => seen.length > 1);
    await settle(engine);
    const input = seen[1].messages.findLast((message: any) => message.role === "user").text;
    const candidates = JSON.parse(input.split("[按标识匹配的任务候选] ")[1].split("\n")[0]);
    assert.equal(candidates.total, 1);
    assert.equal(candidates.tasks[0].id, grouped);
    assert(!candidates.tasks.some((task: any) => task.id === privateTask));
  } finally { await close(); }
});

test("the relay between employees stops after the hop cap with a notice", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u1");
    const group = await engine.groups.create(u1, { name: "乒乓", employees: [a, b] });
    const ping = Array.from({ length: 10 }, () => "@小B 你来"), pong = Array.from({ length: 10 }, () => "@小A 你来");
    const seen = script(engine, { [a]: ping, [b]: pong });
    await engine.groups.send(u1, group.id, { text: "@小A 开始" });
    // 接力逐跳串行：等每一跳都真的跑过再等尾部通知，跳与跳之间的空档不算结束。
    await until(() => seen.length >= GROUP_HOPS_MAX);
    await settle(engine);
    assert.equal(seen.length, GROUP_HOPS_MAX);
    const last = (await groupMessages(engine, group.id)).at(-1)!;
    assert(last.notice && /自动接力已暂停/.test(String(last.text)));
  } finally { await close(); }
});

test("tasks started from a group report there; a result goes back to the employee that asked; guests get tasks only, the employee always uses its own vault", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u2");
    const group = await engine.groups.create(u1, { name: "协作", users: ["u2"], employees: [a] });
    await engine.groups.addEmployee(u2, group.id, b);
    // bob asks alice's employee for work: the reply schedules a task.
    script(engine, { [a]: [{ text: "", calls: [{ id: "c1", name: "employee_task_create", arguments: { instructions: "整理周报" } }] }, "已安排"] });
    await engine.groups.send(u2, group.id, { text: "@小A 帮我整理周报" });
    await settle(engine);
    const employeeA = await engine.employee.for(a);
    const task = (await employeeA.state()).tasks.find((t) => t.text === "整理周报")!;
    assert.deepEqual([task.group?.groupId, task.group?.byOwner, task.group?.requester.name], [group.id, false, "bob"]);
    // Scheduling no longer writes a card into the group; only the delivery message carries one.
    assert.equal((await groupMessages(engine, group.id)).find((m) => m.tasks?.length), undefined, "scheduling must not write a task card into the group");
    // The guest's turn: tasks only, no duties; the employee's own vault stays available.
    const memberSession = (await engine.groups.get(group.id))!.memberSessions[a];
    const tools = await Tools.create(engine, await store.session(memberSession), await engine.config(), new AbortController().signal, () => {});
    const names = (await tools.definitions({} as any)).map((t) => t.name);
    assert(names.includes("employee_task_create") && names.includes("vault_get") && !names.includes("employee_duty_create") && !names.includes("memory_propose"), "group guest: tasks+vault, no duties/memory");
    // The guest-started task uses its own vault too (tools shown, the runtime allows it, the prompt does not forbid it).
    const work = await store.newSession({ employeeId: a, taskId: task.id, cwd: task.cwd, ownerId: "u1" });
    await employeeA.update((state) => { const t = employeeA.task(state, task.id); t.status = "running"; t.workSession = work.id; });
    employeeA.busy.set(task.id, { session: work.id, computer: false });
    for (const scene of ["lightweight", "computer"]) {
      const taskTools = await Tools.create(engine, { ...work, scene } as any, await engine.config(), new AbortController().signal, () => {});
      const taskNames = (await taskTools.definitions({} as any)).map((t) => t.name);
      assert(taskNames.includes("vault_list") && taskNames.includes("vault_get"), scene);
    }
    assert(Array.isArray((await employeeA.execute(task.id, { action: "vault_list" })).value.entries));
    assert.doesNotMatch(await (employeeA as any).groupTaskNote(task.group), /不使用密码本/);
    employeeA.busy.delete(task.id);
    await employeeA.update((state) => { employeeA.task(state, task.id).status = "queued"; });
    // A question from that task posts to the group without waking anyone; a result wakes the asking employee.
    await employeeA.toChat(undefined, task.group, { role: "assistant", text: "**需要处理**\n\n周报发给谁？" }, false);
    let last = (await groupMessages(engine, group.id)).at(-1)!;
    assert.equal(last.author?.name, "小A");
    const asked = await make("小C", "u1");
    await engine.groups.addEmployee(u1, group.id, asked);
    const seen = script(engine, { [asked]: ["收到周报，谢谢"] });
    await employeeA.toChat(undefined, { ...task.group!, requester: { kind: "employee", id: asked, name: "小C" } }, { role: "assistant", text: "**已交付**\n\n周报已整理" }, true);
    await settle(engine);
    assert.equal(seen.length, 1, "the requesting employee gets the result as its turn");
    last = (await groupMessages(engine, group.id)).at(-1)!;
    assert.deepEqual([last.author?.name, last.text], ["小C", "收到周报，谢谢"]);
    // Once A leaves the group, its notices fall back to its private chat (none open here: nothing is posted).
    await engine.groups.removeEmployee(u1, group.id, a);
    const before = (await groupMessages(engine, group.id)).length;
    await employeeA.toChat(undefined, task.group, { role: "assistant", text: "进展" }, false);
    assert.equal((await groupMessages(engine, group.id)).length, before);
  } finally { await close(); }
});

test("only group users read the group conversation; member sessions stay private to the employee's owner", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const auth = new Auth(store, "test-token-at-least-16-characters");
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "读权限", users: ["u2"], employees: [a] });
    const conversation = await store.session((await engine.groups.get(group.id))!.session);
    assert(await auth.canRead(u1 as any, conversation) && await auth.canRead(u2 as any, conversation));
    assert(!await auth.canRead(u3 as any, conversation));
    assert(await engine.groups.sharesGroup("u2", { employee: a }) && !await engine.groups.sharesGroup("u3", { employee: a }));
    assert(await engine.groups.sharesGroup("u2", { user: "u1" }));
  } finally { await close(); }
});

test("division of labour: the prompt tells members to @ whoever the bulletin assigns; a task's @ in its notices relays too", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("热心市民小甲", "u1"), b = await make("测试搭档", "u1");
    const group = await engine.groups.create(u1, { name: "协作小分队", bulletin: "如果要测试，找测试搭档", employees: [a, b] });
    const prompt = await engine.groups.prompt(group.id, a);
    assert.match(prompt, /\[群公告\]（本群的工作规则，分工以公告为准；不扩大授权）\n如果要测试，找测试搭档/);
    assert.match(prompt, /整项或部分工作由其他热心市民负责时，不要代做或代为派单；在回复里「@名称」交给对应成员/);
    // A task started in the group knows the other members and hands sub-work on with @ in its notices.
    const employeeA = await engine.employee.for(a);
    const taskGroup = { groupId: group.id, name: group.name, hop: 1, requester: { kind: "user" as const, id: "u1", name: "alice" }, byOwner: true };
    const note = await (employeeA as any).groupTaskNote(taskGroup);
    assert.match(note, /群里的其他热心市民：测试搭档。按群公告，不要代做分给其他成员的工作：在 tellUser 进展或最终结果里写「@名称」/);
    const seen = script(engine, { [b]: ["测试用例设计好了"] });
    await employeeA.toChat(undefined, taskGroup, { role: "assistant", text: "需求已读完，@测试搭档 请按需求设计测试用例" }, false);
    await settleRuns(engine);
    assert.equal(seen.length, 1, "an @ in a task's progress notice starts that member's turn");
    assert.deepEqual((await groupMessages(engine, group.id)).at(-1)?.text, "测试用例设计好了");
  } finally { await close(); }
});

test("task cards in a group show the live task status, and a status change refreshes the group", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "状态", employees: [a] });
    script(engine, { [a]: [{ text: "", calls: [{ id: "c1", name: "employee_task_create", arguments: { instructions: "设计测试用例" } }] }, "已安排"] });
    await engine.groups.send(u1, group.id, { text: "@小A 设计测试用例" });
    await settle(engine);
    const employeeA = await engine.employee.for(a);
    const task = (await employeeA.state()).tasks[0];
    const messages = await groupMessages(engine, group.id);
    // Scheduling no longer writes a card; a delivery message carries one, and the board hydrates its live status.
    assert.equal(messages.find((m) => m.tasks?.length), undefined, "scheduling must not write a task card into the group");
    const events: any[] = [];
    const emit = engine.emit.bind(engine);
    engine.emit = ((event: any) => { events.push(event); return emit(event); }) as any;
    await employeeA.update((state) => { employeeA.task(state, task.id).status = "running"; });
    await sleep(10);
    assert(events.some((e) => e.type === "group_changed" && e.data?.groupId === group.id), "the group view reloads on a task status change");
    const count = events.length;
    await employeeA.update((state) => { employeeA.task(state, task.id).queueReason = "x"; });
    await sleep(10);
    assert(!events.slice(count).some((e) => e.type === "group_changed"), "no reload when no group task changed status");
    const card = { ...messages[0], author: { kind: "employee", id: a, name: "小A" }, tasks: [{ id: task.id, title: task.text, status: "queued" }] } as any;
    assert.deepEqual(await engine.groups.taskStatus([card]), { [task.id]: "running" }, "the stored card is a snapshot; the board shows the live status");
    const liveGroup = (await engine.groups.get(group.id))!;
    const progressMsg = { seq: 99, role: "assistant", text: "进展中", progress: true, topicTaskId: task.id, author: { kind: "employee", id: a, name: "小A" } } as any;
    const userTopicMsg = { seq: 100, role: "user", text: "补充条件", topicTaskId: task.id, author: { kind: "user", id: u1.id, name: "alice" } } as any;
    const meta = await engine.groups.taskMeta(liveGroup, [progressMsg, userTopicMsg]);
    assert.deepEqual(meta[task.id], { id: task.id, title: task.text, status: "running", employeeId: a }, "taskMeta resolves live title, status and owner for topicTaskId-only messages");
    await employeeA.update((state) => { employeeA.task(state, task.id).status = "done"; });
    await sleep(10);
    const beforeRemove = events.length;
    await employeeA.control({ action: "remove", id: task.id });
    await until(() => events.slice(beforeRemove).some((e) => e.type === "group_changed" && e.data?.groupId === group.id));
    assert.deepEqual(await engine.groups.taskStatus([card]), { [task.id]: "deleted" }, "deleted cards do not retain a stale status");
    const deletedMeta = await engine.groups.taskMeta(liveGroup, [card, progressMsg]);
    assert.equal(deletedMeta[task.id].status, "deleted");
    assert.equal(deletedMeta[task.id].title, task.text, "deleted task retains snapshot title from linked card");
  } finally { await close(); }
});

test("group panel: invite and bring rows always show, with a reason when empty; cards get the live status", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("web/src/GroupChat.vue", "utf8");
  assert.match(source, /<div v-if="!readonly" class="add-row"><select v-model="invite" aria-label="邀请用户" :disabled="!invitable.length">/);
  assert.match(source, /<div v-if="!readonly" class="add-row"><select v-model="bring" aria-label="邀请我的热心市民" :disabled="!available.length">/);
  assert.match(source, /在左下角「账号与安全」→ 成员里新建账号/);
  assert.match(source, /你名下的热心市民都已在群里/);
  assert.match(source, /其他群成员也可以在这里邀请各自名下的热心市民/);
  assert.match(source, /<fieldset><legend>邀请用户<\/legend>/);
  assert.match(source, /:task-status="taskStatus"/);
});

test("工作面板: the group's tasks by member, open ones first; guests see a projection; members only", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u2");
    const group = await engine.groups.create(u1, { name: "面板", users: ["u2"], employees: [a] });
    await engine.groups.addEmployee(u2, group.id, b);
    const employeeA = await engine.employee.for(a);
    const from = (name: string, status: string, at: number) => ({ id: "t-" + name, text: name, status, createdAt: at, cwd: "/tmp", profile: "lightweight", owner: { token: "", name: "" }, workSession: "secret-session",
      group: { groupId: group.id, name: "面板", hop: 0, requester: { kind: "user", id: "u2", name: "bob" }, byOwner: false } });
    await employeeA.update((state) => {
      (state.tasks as any[]).push(from("done-old", "done", 1), from("queued", "queued", 2), from("waiting", "waiting", 3), from("running", "running", 4), from("done-new", "done", 5));
      state.tasks.push({ ...from("elsewhere", "queued", 6), group: undefined });
    });
    const owner = await engine.groups.tasks(u1, group.id), guest = await engine.groups.tasks(u2, group.id);
    assert.deepEqual(owner.members.map((m) => [m.name, m.mine]), [["小A", true], ["小B", false]]);
    assert.deepEqual(owner.members[0].tasks.map((t: any) => t.text), ["waiting", "running", "queued", "done-new", "done-old"], "needs-attention, running, queued, then newest ended; other tasks excluded");
    assert.equal((owner.members[0].tasks[0] as any).workSession, "secret-session", "the owner gets the full task");
    const seen = guest.members[0].tasks[0] as any;
    assert.deepEqual([seen.text, seen.status, seen.requester.name, seen.workSession, seen.cwd], ["waiting", "waiting", "bob", undefined, undefined], "other members see no sessions or location");
    await assert.rejects(engine.groups.tasks(u3, group.id), /群聊不存在|不在/);
  } finally { await close(); }
});

test("工作面板 UI: opening a task keeps the main chat beside its topic and task details", async () => {
  const { readFile } = await import("node:fs/promises");
  const chat = await readFile("web/src/GroupChat.vue", "utf8"), panel = await readFile("web/src/GroupWork.vue", "utf8");
  assert.match(chat, /@click="toggleWork"><Icon name="tasks" :size="15" \/><span class="hide-mobile">工作面板<\/span>/);
  assert.match(chat, /<GroupWork v-if="work && group" :members="workMembers"/);
  assert.match(chat, /props\.api\(`\/groups\/\$\{id\}\/tasks(?:\?[^`]+)?`\)/);
  assert.match(chat, /matchMedia\("\(min-width: 768px\)"\)/, "work panel defaults open when it sits beside the chat");
  assert(!/emit\(["']tab["']\)|:tab=|props\.tab/.test(chat) && !/GROUP_PANELS/.test(await readFile("web/src/router.js", "utf8")), "panels stay local; not in the route");
  assert.match(panel, /emit\("select", \{ employeeId: member\.id, taskId: task\.id, title: task\.text \}\)/);
  assert.match(panel, /v-if="owned\(\)"[^>]+emit\('open'/, "only owners can explicitly leave the group for the task workspace");
  assert.match(panel, /watch\(\(\) => props\.members/, "open detail reloads with live task updates");
  assert.match(panel, /<TaskDetail[^>]*:readonly="!selected\.canControl"/);
  assert.match(chat, /:focus="taskFocus" @select="selectTopic" @exit="exitTask"/);
  assert.doesNotMatch(chat, /只有[^。\n]*归属用户[^。\n]*查看详情/, "group members can view task details");
  assert.match(panel, /props\.api\(taskPath\(key\), "POST"/);
  assert.match(panel, /action === "redispatch" && !confirm/);
  assert.match(panel, /\{\{ requester\((?:task|group\.task)\) \}\} 发起/);
});

test("group sends deduplicate by sender and message ID, not by the text", async () => {
  const { engine, close } = await fixture();
  try {
    const group = await engine.groups.create(u1, { name: "回显测试", users: ["u2"] });
    const message = { text: "相同内容", clientMessageId: "desktop-msg-group-1" };
    const [one, retry] = await Promise.all([engine.groups.send(u1, group.id, message), engine.groups.send(u1, group.id, message)]);
    const same = await engine.groups.send(u1, group.id, { ...message, clientMessageId: "desktop-msg-group-2" });
    const peer = await engine.groups.send(u2, group.id, message);
    assert.equal(one.seq, retry.seq);
    assert.equal(new Set([one.seq, same.seq, peer.seq]).size, 3);
    assert.equal((await groupMessages(engine, group.id)).filter(row => row.role === "user").length, 3);
  } finally { await close(); }
});

test("unread: one read marker per user and conversation; others' visible messages count, capped at 100", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "未读", users: ["u2"], employees: [a] });
    const session = (await engine.groups.get(group.id))!.session;
    await store.append(session, { role: "user", text: "我自己说的", actorId: "u1", author: { kind: "user", id: "u1", name: "alice" } });
    const peer = await store.append(session, { role: "user", text: "bob 说的", actorId: "u2", author: { kind: "user", id: "u2", name: "bob" }, at: 1000 });
    await store.append(session, { role: "assistant", text: "热心市民回复", author: { kind: "employee", id: a, name: "小A" }, at: 2000 });
    await store.append(session, { role: "assistant", notice: true, text: "系统通知" });
    const unread = async (user: any) => (await engine.groups.list(user)).find((g) => g.id === group.id)!.unread;
    assert.deepEqual([await unread(u1), await unread(u2)], [2, 2], "own messages and notices never count");
    await store.markRead("u1", session, peer.seq);
    assert.equal(await unread(u1), 1, "desktop only marks what has been fetched");
    assert.equal((await engine.groups.list(u1)).find(g => g.id === group.id)?.lastViewedAt, 1000);
    await store.markRead("u1", session, peer.seq - 1);
    assert.equal(await store.readSeq("u1", session), peer.seq, "stale pages cannot roll back the shared marker");
    await store.markRead("u1", session);
    assert.equal(await unread(u1), 0);
    assert.equal(await unread(u2), 2, "markers are per user");
    assert.equal((await store.objects("read")).length, 1, "reading writes one marker row");
    // Employee chat: the employee's visible replies count; tool output and tool-only turns do not.
    const chat = await (await engine.employee.for(a)).chat("u1");
    await store.append(chat.id, { role: "user", text: "hi", actorId: "u1" });
    await store.append(chat.id, { role: "assistant", text: "", calls: [{ id: "c", name: "read", arguments: {} }] } as any);
    await store.append(chat.id, { role: "tool", text: "x", callId: "c", name: "read" } as any);
    await store.append(chat.id, { role: "assistant", text: "好的" });
    assert.equal(await store.unread("u1", chat.id), 1);
    for (let i = 0; i < 250; i++) await store.append(chat.id, { role: "assistant", text: "刷屏 " + i });
    assert.equal(await store.unread("u1", chat.id), 100, "counting stops at 100 (shown as 99+)");
    await store.markRead("u1", chat.id);
    assert.equal(await store.unread("u1", chat.id), 0);
  } finally { await close(); }
});

test("group avatars open the employee chat for its owner only; unread badges in the sidebar", async () => {
  const { readFile } = await import("node:fs/promises");
  const bubble = await readFile("web/src/ChatMessage.vue", "utf8"), chat = await readFile("web/src/GroupChat.vue", "utf8"), sidebar = await readFile("web/src/AppSidebar.vue", "utf8"), app = await readFile("web/src/App.vue", "utf8");
  assert.match(bubble, /<button v-else-if="!mine && openAuthor" type="button" class="chat-avatar author-link"[^>]*@click="emit\('author', sender\.id\)"/);
  assert.match(bubble, /<button v-if="!mine && !continued && openAuthor" type="button" class="author-name" @click="emit\('author', sender\.id\)">/);
  assert.match(chat, /const canOpen = \(author\) => author\?\.kind === "employee" && !!group\.value\?\.employees\.find\(\(e\) => e\.id === author\.id\)\?\.mine;/);
  assert.match(chat, /:open-author="canOpen\(message\.author\)"/);
  assert.match(chat, /@author="emit\('open-employee', \$event\)"/);
  assert.match(sidebar, /const unreadLabel = \(n\) => n > 99 \? "99\+" : String\(n\);/);
  assert.equal((sidebar.match(/class="unread"/g) || []).length, 2, "both employee and group rows show the count");
  assert.match(chat, /props\.api\(`\/groups\/\$\{id\}\/read`, "POST", \{\}\)/);
  const unread = await readFile("web/src/unread.js", "utf8");
  assert.match(unread, /app\(\)\.api\(`\/employees\/\$\{id\}\/chat\/read`, "POST", \{\}\)/);
  assert.match(app, /@read="unread\.groupRead"/);
});

test("unread UI: the employee chat on screen is marked read; a message elsewhere refreshes the counts", async () => {
  const { ref, nextTick } = await import("vue");
  const { useUnread } = await import("../web/src/unread.js");
  const calls: string[] = [];
  const state: any = {
    api: async (path: string, method = "GET") => { calls.push(method + " " + path); return method === "GET" ? [{ id: "a", unread: 3, chatSession: "chat-a" }, { id: "b", unread: 2, chatSession: "chat-b" }] : {}; },
    view: ref("employee"), creatingEmployee: ref(false), employeeSession: ref(""), employeeTab: ref("chat"), selectedEmployee: ref("a"),
    employees: ref([{ id: "a", unread: 1, chatSession: "chat-a" }, { id: "b", unread: 0, chatSession: "chat-b" }]), employee: ref({ chatSession: "chat-a" }),
    groups: ref([{ id: "g", unread: 4 }]), background: (p: Promise<unknown>) => p,
  };
  const warn = console.warn; console.warn = () => {};
  const unread = useUnread(() => state);
  console.warn = warn;
  state.selectedEmployee.value = "b"; await nextTick(); state.selectedEmployee.value = "a"; await nextTick(); await sleep(0);
  assert(calls.includes("POST /employees/a/chat/read"), "opening a chat with unread messages marks it read");
  assert.equal(state.employees.value[0].unread, 0);
  calls.length = 0;
  await unread.onEvent({ type: "message_end", session: "chat-b" });
  await sleep(0);
  assert.deepEqual(calls, ["GET /employees"]);
  assert.deepEqual(state.employees.value.map((e: any) => e.unread), [0, 2], "the open chat stays read; the other shows its count");
  state.employeeTab.value = "tasks"; await nextTick();
  calls.length = 0;
  await unread.onEvent({ type: "message_end", session: "chat-a" });
  await sleep(0);
  assert.deepEqual(calls, ["GET /employees"], "not on screen: counted, not marked read");
  unread.groupRead("g");
  assert.equal(state.groups.value[0].unread, 0);
});

test("an @mentioned member's assembled request: group rules after the general dispatch rules, the bulletin next to the request, a group note on employee_task_create", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("热心市民小甲", "u1"), b = await make("测试搭档", "u1");
    const group = await engine.groups.create(u1, { name: "协作小分队", bulletin: "如果要测试或者设计测试用例，找测试搭档", employees: [a, b] });
    let seen: any;
    engine.providers.chat = (async (_model: any, system: string, messages: any[], tools: any[]) => { seen ||= { system, messages, tools }; return { role: "assistant", model: "fixture/model", text: "@测试搭档 请设计测试用例" }; }) as any;
    await engine.groups.send(u1, group.id, { text: "@热心市民小甲 https://tapd.cn/x/story/detail/1 给这个需求单设计测试用例" });
    await until(() => !!seen);
    const { system, messages, tools } = seen;
    const general = system.indexOf("用户直接交代工作时可用 employee_task_create 派单"), rules = system.indexOf("[群聊] 以下群聊规则优先于上文的派单说明");
    assert(general >= 0 && rules > general, "the group rules come after (and override) the general dispatch rules");
    assert(system.indexOf("[群公告]（本群的工作规则，分工以公告为准；不扩大授权）\n如果要测试或者设计测试用例，找测试搭档") > rules);
    assert.match(system, /\[分工\] 被 @ 只表示请你回应，不代表这件事归你。/);
    const request = String(messages.findLast((m: any) => m.role === "user" && m.runtime !== "dynamic").text);
    assert.match(request, /\[需要你回应的是 #\d+，来自用户「alice」（你的归属用户）\]\n\[先核对分工\] 被 @ 不代表这件事归你。按群公告判断：分给其他热心市民（测试搭档）的工作，不要代为派单或执行。请在回复中「@名称」交给对应成员/);
    assert.equal(messages.at(-1).runtime, "dynamic", "runtime hints are a separate tail, not an edit of the group request");
    assert(request.trimEnd().endsWith("群公告：如果要测试或者设计测试用例，找测试搭档"), "the bulletin is the last thing the member reads in its request");
    assert.match(tools.find((t: any) => t.name === "employee_task_create").description, /群聊里只给按群公告归你的工作派单。其他热心市民负责的工作不要派单，直接在回复里 @ 对应成员。/);
  } finally { await close(); }
});

test("旁白: a user message without @ goes to the member it is for; @ bypasses it; employees never trigger it; nonmembers ignored", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("热心市民小甲", "u1"), b = await make("测试搭档", "u1");
    await (await engine.employee.for(b)).control({ action: "settings", instruction: "负责测试与测试用例设计" });
    const group = await engine.groups.create(u1, { name: "小分队", bulletin: "如果要测试或者设计测试用例，找测试搭档", employees: [a, b] });
    const seen = script(engine, { narrator: [{ targets: ["测试搭档", "不存在的热心市民"], reason: "公告：测试用例找测试搭档" }], [b]: ["好的，我来设计测试用例"] });
    await engine.groups.send(u1, group.id, { text: "https://tapd.cn/x/story/detail/1 给这个需求单设计测试用例" });
    await settleRuns(engine);
    assert.equal(narrated.length, 1);
    const input = narrated[0].setup;
    assert.equal(narrated[0].session, undefined, "the first judgement opens the session afterwards");
    assert.equal(input.群公告, "如果要测试或者设计测试用例，找测试搭档");
    assert.deepEqual(input.热心市民.map((m: any) => [m.名称, m.守则]), [["热心市民小甲", "（无）"], ["测试搭档", "负责测试与测试用例设计"]]);
    assert.match(narrated[0].last, /\[新消息\] #\d+ 用户「alice」：https:\S+ 给这个需求单设计测试用例/);
    assert.deepEqual(seen.map((s) => s.employeeId), [b], "only the real member it named answers");
    assert.match(JSON.stringify(seen[0].messages), /\[旁白\] 这条消息没有 @ 谁，旁白判断交给你：公告：测试用例找测试搭档/);
    const messages = await groupMessages(engine, group.id);
    assert(!messages.some((m) => /旁白|交给/.test(String(m.text)) && m.author?.kind !== "user"), "the 旁白 only judges: nothing is posted to the group");
    assert.deepEqual(messages.filter((m) => !m.notice).map((m) => m.author?.name), ["alice", "测试搭档"]);
    assert(!JSON.stringify(seen[0].messages).includes("旁白：交给"), "the member's turn does not rely on a group post");
    assert.deepEqual(messages.at(-1)?.[ "author" as "author"]?.name, "测试搭档");
    assert.equal(messages.at(-1)?.hop, 1, "a routed turn is one hop from the user message, as a mention would be");
    // An @ goes straight to that member; the 旁白 is not asked. The reply (no @) does not reach the 旁白 either.
    narrated.length = 0;
    const direct = script(engine, { [a]: ["收到"] });
    await engine.groups.send(u1, group.id, { text: "@热心市民小甲 看下" });
    await settleRuns(engine);
    assert.deepEqual([narrated.length, direct.length], [0, 1]);
    // An @ of a user is explicit too. If the narrator does not choose, the last employee to speak answers.
    script(engine, { narrator: [{ targets: [], reason: "闲聊" }], [a]: ["不客气"] });
    await engine.groups.send(u1, group.id, { text: "@alice 你看看" });
    await engine.groups.send(u1, group.id, { text: "大家辛苦了" });
    await settleRuns(engine);
    assert.equal(narrated.length, 1, "only the message without any @ is judged");
    const thanked = (await groupMessages(engine, group.id)).at(-1)!;
    assert.deepEqual([thanked.author?.name, thanked.text], ["热心市民小甲", "不客气"], "the last speaker answers when the 旁白 picks nobody");
    // A failing model leaves a short notice.
    script(engine, { narrator: [Error("model down")] });
    await engine.groups.send(u1, group.id, { text: "这个谁来看" });
    await settle(engine);
    assert.match(String((await groupMessages(engine, group.id)).at(-1)?.text), /旁白没能判断这条消息该交给谁（model down）/);
    void store;
  } finally { await close(); }
});

test("旁白 session: append-only per group (cache-friendly); setup change or too long history starts fresh; deleted with the group", async () => {
  const { engine, make, close } = await fixture();
  const limits = { ...NARRATOR };
  try {
    const a = await make("小A", "u1"), b = await make("小B", "u1");
    const group = await engine.groups.create(u1, { name: "旁白会话", bulletin: "小A 写代码，小B 测试", employees: [a, b] });
    script(engine, { narrator: [{ targets: ["小A"], reason: "写代码" }, { targets: [], reason: "闲聊" }, { targets: [], reason: "闲聊" }, { targets: [], reason: "闲聊" }, { targets: [], reason: "闲聊" }], [a]: ["写好了", "嗯", "嗯", "嗯", "嗯"] });
    await engine.groups.send(u1, group.id, { text: "写个登录页" });
    await settleRuns(engine);
    await engine.groups.send(u1, group.id, { text: "辛苦" });
    await settleRuns(engine);
    const first = (await engine.groups.get(group.id))!.narrator!;
    assert.equal(narrated[1].session, first.session, "the second judgement continues the same session");
    const sent = (m: any) => ({ role: m.role, text: m.text, calls: m.calls, callId: m.callId });
    assert.deepEqual(narrated[1].messages.slice(0, narrated[0].messages.length).map(sent), narrated[0].messages.map(sent), "append-only: the earlier call is a prefix");
    assert.deepEqual(narrated[1].messages.slice(narrated[0].messages.length, -1).map((m: any) => m.role), ["assistant", "tool"], "its route_message call and result follow");
    assert.equal(narrated[1].setup, undefined, "the setup is not repeated");
    assert.match(narrated[1].last, /\[上次判断之后的群消息\]\n#\d+ 热心市民「小A」：写好了\n\[新消息\] #\d+ 用户「alice」：辛苦/, "it learns who has been talking since");
    assert((await engine.store.session(first.session)).groupId === group.id, "hidden, tied to the group");
    // A changed bulletin starts a fresh session (no stale routing precedent); the old one is deleted.
    await engine.groups.update(u1, group.id, { bulletin: "小B 也写代码" });
    await engine.groups.send(u1, group.id, { text: "在吗" });
    await settleRuns(engine);
    const second = (await engine.groups.get(group.id))!.narrator!;
    assert.notEqual(second.session, first.session);
    assert(!await engine.store.hasSession(first.session), "the old session is gone");
    assert.equal(narrated[2].messages.length, 1, "a fresh session starts with one message");
    assert.equal(narrated[2].setup.群公告, "小B 也写代码");
    assert.match(narrated[2].last, /\[此前的群消息\][\s\S]*辛苦[\s\S]*\n\[新消息\]/, "it carries the last few messages");
    // Too long: the next judgement starts over with only the last NARRATOR.carry messages.
    NARRATOR.tokens = 1; NARRATOR.carry = 2;
    await engine.groups.send(u1, group.id, { text: "再问一下" });
    await settleRuns(engine);
    const third = (await engine.groups.get(group.id))!.narrator!;
    assert.notEqual(third.session, second.session);
    assert.equal(narrated[3].messages.length, 1);
    assert.equal(narrated[3].last.match(/^#\d+ /gm)?.length, 2, "carried: the last 2 messages");
    await engine.groups.remove(u1, group.id);
    assert(!await engine.store.hasSession(third.session), "dissolving the group deletes the 旁白's session");
  } finally { Object.assign(NARRATOR, limits); await close(); }
});

test("/new parsing: alone or with text; anything else is an ordinary message", () => {
  assert.deepEqual(newCommand("/new"), { rest: "" });
  assert.deepEqual(newCommand("  /new  帮我看下\n第二行 "), { rest: "帮我看下\n第二行" });
  for (const text of ["/news", "说 /new", "/New", "", undefined]) assert.equal(newCommand(text), undefined, String(text));
  const route = readFileSync("server/routes/api/[...path].ts", "utf8");
  assert(route.includes("newCommand(a.text)") && route.includes("engine.markNewTask(session.id"), "the private chat route handles /new as new task");
});

test("/new in a private chat: keeps conversation context, forbids resume, and creates a fresh task even with a reused dedupeKey", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const employee = await engine.employee.for(a);
    const session = await employee.chat("u1");
    const existing = await employee.execute("", { action: "add", kind: "todo", text: "旧单子查询 1020427644", key: "tapd-1020427644" });
    await employee.update((s) => { s.tasks[0].status = "done"; });
    const seen = script(engine, {
      [a]: [
        "已查过旧单子 1020427644。",
        { calls: [{ id: "try_resume", name: "employee_task_manage", arguments: { taskId: existing.value.id, request: { command: "resume", supplement: "重查" } } }] },
        { calls: [{ id: "create_new", name: "employee_task_create", arguments: { instructions: "重新查 1020427644", dedupeKey: "tapd-1020427644" } }] },
        "已用新任务重新查 1020427644。",
      ],
    });
    await engine.submitChat(session.id, { role: "user", text: "先记住单号 1020427644", actorId: "u1" });
    await settle(engine);
    await engine.markNewTask(session.id, { actorId: "u1" });
    await engine.submitChat(session.id, { role: "user", text: "重新查这个单子", newTask: true, actorId: "u1" });
    await settle(engine);
    const second = JSON.stringify(seen[1].messages);
    assert(second.includes("先记住单号 1020427644") && second.includes("重新查这个单子"), "prior conversation context is preserved");
    assert(!second.includes(NEW_TASK_NOTICE), "UI-only /new notice is excluded from model turns");
    assert(second.includes("[本轮指令：/new 新任务]"), "dynamic prompt carries /new new-task directive");
    const rows = await engine.store.messages(session.id);
    const refused = rows.find((m) => m.role === "tool" && m.callId === "try_resume");
    assert(refused?.error && /使用了 \/new.*employee_task_create/.test(String(refused.text)), String(refused?.text));
    const created = rows.find((m) => m.role === "tool" && m.callId === "create_new");
    assert(!created?.error && created?.text && !JSON.parse(created.text).exists, String(created?.text));
    assert.equal((await employee.state()).tasks.length, 2, "a genuinely new task was created");
    assert(rows.some((m) => m.notice && m.newTask && m.text === NEW_TASK_NOTICE));
  } finally { await close(); }
});

test("/new in a group: keeps 旁白 and member context, arms /new alone without waking anyone, and marks member turn as newTask", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "新任务群", users: ["u2"], employees: [a] });
    const seen = script(engine, { narrator: [{ targets: [], reason: "闲聊" }, { targets: ["小A"], reason: "点名" }], [a]: ["旧", "旧闻", "新"] });
    await engine.groups.send(u1, group.id, { text: "旧话题 @小A" });
    await settle(engine);
    await engine.groups.send(u1, group.id, { text: "聊聊旧事" });
    await settle(engine);
    const before = (await engine.groups.get(group.id))!;
    const oldSessions = [before.memberSessions[a], before.narrator!.session];
    // Any member user may use /new alone; it does NOT wipe sessions or wake anyone.
    await engine.groups.send(u2 as any, group.id, { text: "/new" });
    await settle(engine);
    const after = (await engine.groups.get(group.id))!;
    assert.deepEqual([after.memberSessions[a], after.narrator?.session], oldSessions, "sessions are preserved");
    for (const id of oldSessions) assert(await engine.store.hasSession(id), "old sessions stay intact");
    assert.deepEqual([narrated.length, seen.length], [1, 2], "the /new notice is not judged and wakes nobody");
    const notice = (await groupMessages(engine, group.id)).at(-1)!;
    assert.deepEqual([notice.notice, notice.newTask, notice.text], [true, true, NEW_TASK_NOTICE]);
    // /new <text>: keeps prior context and delivers newTask directive to the member.
    await engine.groups.send(u1, group.id, { text: "/new 小A 重新查一下上面的单子" });
    await settle(engine);
    const turn = JSON.stringify(seen.at(-1)!.messages);
    assert(turn.includes("旧话题") && turn.includes("重新查一下上面的单子"), "member keeps earlier conversation context");
    assert(!turn.includes(NEW_TASK_NOTICE), "UI-only /new notice is excluded from member prompt");
    assert(turn.includes("[本轮指令：/new 新任务]"), "member receives /new new-task directive");
    assert.equal(seen.at(-1)!.messages.at(-1).runtime, "dynamic");
  } finally { await close(); }
});

test("旁白 without a lightweight model: a notice every time (a missed one would leave the group silent); nothing runs", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "无模型", employees: [a] });
    await store.put("config", { ...(await store.get<any>("config", {})), scenes: { coding: ["fixture/model"] } });
    const seen = script(engine, {});
    await engine.groups.send(u1, group.id, { text: "帮我看看" });
    await engine.groups.send(u1, group.id, { text: "在吗" });
    await settle(engine);
    assert.deepEqual([narrated.length, seen.length], [0, 0]);
    const notices = (await groupMessages(engine, group.id)).filter((m) => m.notice && /未配置「沟通与任务起步」场景模型/.test(String(m.text)));
    assert.equal(notices.length, 2);
  } finally { await close(); }
});

test("旁白: greetings go to a member; every judgement is recorded; a reply without the call is a visible failure; admins see the session", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("热心市民小甲", "u1"), b = await make("测试搭档", "u1");
    const group = await engine.groups.create(u1, { name: "协作小分队", employees: [a, b] });
    assert.match(NARRATOR_SYSTEM, /打招呼、喊大家（如「起床啦」「有人吗」）[\s\S]*选择最合适的一位/);
    assert.match(NARRATOR_SYSTEM, /每条消息至少交给一位热心市民/);
    // The model follows the prompt for a greeting; a model answering in text instead of calling the tool is not silence.
    const seen = script(engine, { narrator: [{ targets: ["热心市民小甲"], reason: "打招呼，交给热心市民小甲" }, { text: "没有人需要回应" }], [a]: ["早！我在"] });
    await engine.groups.send(u1, group.id, { text: "各位热心市民，起床啦" });
    await settle(engine);
    assert.deepEqual(seen.map((s) => s.employeeId), [a]);
    await engine.groups.send(u1, group.id, { text: "没人在吗" });
    await settle(engine);
    const last = (await groupMessages(engine, group.id)).at(-1)!;
    assert(last.notice && /旁白没能判断这条消息该交给谁（模型没有调用 route_message：没有人需要回应）/.test(String(last.text)), String(last.text));
    // The narrator's own session holds the judged message; the failed one is shown to the next judgement.
    const state = (await engine.groups.get(group.id))!.narrator!;
    const rows = await engine.store.messages(state.session);
    assert.match(String(rows[0].text), /各位热心市民，起床啦/);
    assert.deepEqual(rows.map((m) => m.role), ["user", "assistant", "tool"]);
    const route = readFileSync("server/routes/api/[...path].ts", "utf8");
    assert(route.includes('kind: "narrator"') && readFileSync("web/src/DebugSessions.vue", "utf8").includes('narrator: "旁白"'), "调试会话 lists the 旁白 session");
  } finally { await close(); }
});
