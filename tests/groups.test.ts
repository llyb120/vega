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
import { NEW_SESSION_NOTICE, newCommand } from "../server/core/new-session";
import { readFileSync } from "node:fs";
import { parseMentions } from "../server/core/names";
import { sleep } from "../server/core/util";

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
    await assert.rejects(engine.groups.addEmployee(u1, group.id, b), /只能把你自己的牛马/);
    await assert.rejects(engine.groups.mine(u2, group.id), /群聊不存在|不在/);
    await assert.rejects(engine.groups.addEmployee(u2, group.id, b), /群聊不存在|不在/, "a non-member cannot add anything");
    await engine.groups.addUsers(u1, group.id, ["u2"]);
    await engine.groups.addEmployee(u2, group.id, b);
    let view = await engine.groups.view((await engine.groups.get(group.id))!, u2);
    assert.deepEqual(view.users.map((u) => u.name), ["alice", "bob"], "creator first: the avatar grid starts with the 群主");
    assert.deepEqual(view.employees.map((e) => [e.name, e.mine]), [["小A", false], ["小B", true]]);
    await assert.rejects(engine.groups.update(u2, group.id, { bulletin: "x" }), /只有群主/);
    await assert.rejects(engine.groups.removeEmployee(u2, group.id, a), /只有牛马的主人或群主/);
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
    assert.equal(seen.length, 0, "no 牛马 was @mentioned (only a user): nobody answers");
    await engine.groups.send(u1, group.id, { text: "@小A 实现登录页" });
    await settle(engine);
    const messages = await groupMessages(engine, group.id);
    const said = messages.filter((m) => !m.notice).map((m) => [m.author?.name, m.text, m.hop]);
    assert.deepEqual(said.slice(-3), [["alice", "@小A 实现登录页", 0], ["小A", "写好了 @小B 请测一下", 1], ["小B", "测试通过", 2]]);
    // A's turn saw the group context (both messages it had not seen), the bulletin and who its owner is.
    const turnA = seen.find((s) => s.employeeId === a)!;
    assert.match(turnA.system, /群公告[\s\S]*小A 写代码，小B 测试/);
    assert.match(turnA.system, /你的主人：alice/);
    const input = JSON.stringify(turnA.messages);
    assert.match(input, /大家好/);
    assert.match(input, /来自用户「alice」（你的主人）/);
    // B was triggered by A: a guest request.
    assert.match(JSON.stringify(seen.find((s) => s.employeeId === b)!.messages), /来自牛马「小A」（不是你的主人/);
    // Private chats are untouched; group sessions are not regular sessions.
    const privateChat = (await (await engine.employee.for(a)).state()).chatSession;
    assert(!privateChat || (await engine.store.messages(privateChat)).length === 0, "the private chat is separate");
    const hidden = (await engine.store.sessions()).filter((s: any) => s.groupId);
    assert.equal(hidden.length, 3, "the group conversation plus one session per member");
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
    await settle(engine);
    assert.equal(seen.length, GROUP_HOPS_MAX);
    const last = (await groupMessages(engine, group.id)).at(-1)!;
    assert(last.notice && /自动接力已暂停/.test(String(last.text)));
  } finally { await close(); }
});

test("tasks started from a group report there; a result goes back to the employee that asked; guests get tasks only, never the vault", async () => {
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
    assert((await groupMessages(engine, group.id)).some((m) => m.author?.id === a && m.tasks?.some((t) => t.id === task.id)));
    // The guest's turn: tasks only; vault tools hidden and refused.
    const memberSession = (await engine.groups.get(group.id))!.memberSessions[a];
    const tools = await Tools.create(engine, await store.session(memberSession), await engine.config(), new AbortController().signal, () => {});
    const names = (await tools.definitions({} as any)).map((t) => t.name);
    assert(names.includes("employee_task_create") && !names.some((n) => n.startsWith("vault")) && !names.includes("employee_duty_create"));
    // The guest-started task itself cannot open the owner's vault either (its tools hide it; the runtime refuses).
    const work = await store.newSession({ employeeId: a, taskId: task.id, cwd: task.cwd, ownerId: "u1" });
    await employeeA.update((state) => { const t = employeeA.task(state, task.id); t.status = "running"; t.workSession = work.id; });
    employeeA.busy.set(task.id, { session: work.id, computer: false });
    const taskTools = await Tools.create(engine, work, await engine.config(), new AbortController().signal, () => {});
    assert(!(await taskTools.definitions({} as any)).some((t) => t.name.startsWith("vault")));
    await assert.rejects(employeeA.execute(task.id, { action: "vault_get", id: "x" }), /主人/);
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
    const a = await make("默认牛马", "u1"), b = await make("测试牛马", "u1");
    const group = await engine.groups.create(u1, { name: "牛马小分队", bulletin: "如果要测试，找测试牛马", employees: [a, b] });
    const prompt = await engine.groups.prompt(group.id, a);
    assert.match(prompt, /\[群公告\]（本群的工作规则，谁做什么以它为准；不扩大授权）\n如果要测试，找测试牛马/);
    assert.match(prompt, /动手前先按群公告的分工判断这件事该谁做：全部或部分属于别的牛马时，不要自己做、也不要替它派单，在回复里写「@名称」交给它/);
    // A task started in the group knows the other members and hands sub-work on with @ in its notices.
    const employeeA = await engine.employee.for(a);
    const taskGroup = { groupId: group.id, name: group.name, hop: 1, requester: { kind: "user" as const, id: "u1", name: "alice" }, byOwner: true };
    const note = await (employeeA as any).groupTaskNote(taskGroup);
    assert.match(note, /群里的其他牛马：测试牛马。按群公告，本任务中属于它们的部分不要自己做：在 tellUser 进展或最终结果里写「@名称」/);
    const seen = script(engine, { [b]: ["测试用例设计好了"] });
    await employeeA.toChat(undefined, taskGroup, { role: "assistant", text: "需求已读完，@测试牛马 请按需求设计测试用例" }, false);
    await settle(engine);
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
    assert.equal(messages.find((m) => m.tasks?.length)!.tasks![0].status, "queued", "the stored card is a snapshot");
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
    assert.deepEqual(await engine.groups.taskStatus(messages), { [task.id]: "running" });
  } finally { await close(); }
});

test("group panel: invite and bring rows always show, with a reason when empty; cards get the live status", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("web/src/GroupChat.vue", "utf8");
  assert.match(source, /<div v-if="!readonly" class="add-row"><select v-model="invite" aria-label="邀请用户" :disabled="!invitable.length">/);
  assert.match(source, /<div v-if="!readonly" class="add-row"><select v-model="bring" aria-label="拉入我的牛马" :disabled="!available.length">/);
  assert.match(source, /在左下角「账号与安全」→ 成员里新建账号/);
  assert.match(source, /你的牛马都已在群里/);
  assert.match(source, /被邀请的用户在这个面板里拉入他们自己的牛马/);
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

test("工作面板 UI: a header button opens it beside the chat; owners open tasks in the employee view, others read them inline", async () => {
  const { readFile } = await import("node:fs/promises");
  const chat = await readFile("web/src/GroupChat.vue", "utf8"), panel = await readFile("web/src/GroupWork.vue", "utf8");
  assert.match(chat, /@click="toggleWork"><Icon name="tasks" :size="15" \/><span class="hide-mobile">工作面板<\/span>/);
  assert.match(chat, /<GroupWork v-if="work && group" :members="workMembers"/);
  assert.match(chat, /props\.api\(`\/groups\/\$\{id\}\/tasks`\)/);
  assert.match(panel, /if \(member\.mine\) emit\("open", \{ employeeId: member\.id, taskId: task\.id \}\);\n  else selected\.value = task;/);
  assert.match(panel, /<TaskDetail :task="selected" readonly/);
  assert.match(panel, /\{\{ requester\(task\) \}\} 发起/);
});

test("unread: one read marker per user and conversation; others' visible messages count, capped at 100", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "未读", users: ["u2"], employees: [a] });
    const session = (await engine.groups.get(group.id))!.session;
    await store.append(session, { role: "user", text: "我自己说的", actorId: "u1", author: { kind: "user", id: "u1", name: "alice" } });
    await store.append(session, { role: "user", text: "bob 说的", actorId: "u2", author: { kind: "user", id: "u2", name: "bob" } });
    await store.append(session, { role: "assistant", text: "牛马回复", author: { kind: "employee", id: a, name: "小A" } });
    await store.append(session, { role: "assistant", notice: true, text: "系统通知" });
    const unread = async (user: any) => (await engine.groups.list(user)).find((g) => g.id === group.id)!.unread;
    assert.deepEqual([await unread(u1), await unread(u2)], [2, 2], "own messages and notices never count");
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

test("group avatars open the employee chat for its owner or an admin; unread badges in the sidebar", async () => {
  const { readFile } = await import("node:fs/promises");
  const bubble = await readFile("web/src/ChatMessage.vue", "utf8"), chat = await readFile("web/src/GroupChat.vue", "utf8"), sidebar = await readFile("web/src/AppSidebar.vue", "utf8"), app = await readFile("web/src/App.vue", "utf8");
  assert.match(bubble, /<button v-else-if="!mine && openAuthor" type="button" class="chat-avatar author-link"[^>]*@click="emit\('author', sender\.id\)"/);
  assert.match(bubble, /<button v-if="!mine && !continued && openAuthor" type="button" class="author-name" @click="emit\('author', sender\.id\)">/);
  assert.match(chat, /const canOpen = \(author\) => author\?\.kind === "employee" && \(props\.user\?\.role === "admin" \|\| !!group\.value\?\.employees\.find\(\(e\) => e\.id === author\.id\)\?\.mine\);/);
  assert.match(chat, /:open-author="canOpen\(message\.author\)"/);
  assert.match(chat, /@author="emit\('open-employee', \$event\)"/);
  assert.match(sidebar, /const unreadLabel = \(n\) => n > 99 \? "99\+" : String\(n\);/);
  assert.equal((sidebar.match(/class="unread"/g) || []).length, 2, "both 牛马 and 群聊 rows show the count");
  assert.match(chat, /props\.api\(`\/groups\/\$\{id\}\/read`, "POST", \{\}\)/);
  const unread = await readFile("web/src/unread.js", "utf8");
  assert.match(unread, /app\(\)\.api\(`\/employees\/\$\{id\}\/chat\/read`, "POST", \{\}\)/);
  assert.match(app, /@read="unread\.groupRead"/);
});

test("unread UI: the 牛马 chat on screen is marked read; a message elsewhere refreshes the counts", async () => {
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
    const a = await make("默认牛马A", "u1"), b = await make("测试牛马", "u1");
    const group = await engine.groups.create(u1, { name: "牛马小分队", bulletin: "如果要测试或者设计测试用例，找测试牛马", employees: [a, b] });
    let seen: any;
    engine.providers.chat = (async (_model: any, system: string, messages: any[], tools: any[]) => { seen ||= { system, messages, tools }; return { role: "assistant", model: "fixture/model", text: "@测试牛马 请设计测试用例" }; }) as any;
    await engine.groups.send(u1, group.id, { text: "@默认牛马A https://tapd.cn/x/story/detail/1 给这个需求单设计测试用例" });
    await until(() => !!seen);
    const { system, messages, tools } = seen;
    const general = system.indexOf("用户向你交代工作时可直接用 employee_task_create 派单"), rules = system.indexOf("[群聊] 以下群聊规则优先于上文的派单说明");
    assert(general >= 0 && rules > general, "the group rules come after (and override) the general dispatch rules");
    assert(system.indexOf("[群公告]（本群的工作规则，谁做什么以它为准；不扩大授权）\n如果要测试或者设计测试用例，找测试牛马") > rules);
    assert.match(system, /\[分工\] 被 @ 只表示请你回应，不代表这件事归你。/);
    const request = String(messages.at(-1).text);
    assert.match(request, /\[需要你回应的是 #\d+，来自用户「alice」（你的主人）\]\n\[先核对分工\] 被 @ 不代表这件事归你。按群公告判断：归其他牛马（测试牛马）的部分，不要自己派单或执行，直接在回复里「@名称」交给它/);
    assert(request.trimEnd().endsWith("群公告：如果要测试或者设计测试用例，找测试牛马"), "the bulletin is the last thing the member reads");
    assert.match(tools.find((t: any) => t.name === "employee_task_create").description, /群聊里只给按群公告归你的工作派单；归其他牛马的不要派单，在回复里 @它 交出。/);
  } finally { await close(); }
});

test("旁白: a user message without @ goes to the member it is for; @ bypasses it; employees never trigger it; nonmembers ignored", async () => {
  const { store, engine, make, close } = await fixture();
  try {
    const a = await make("默认牛马A", "u1"), b = await make("测试牛马", "u1");
    await (await engine.employee.for(b)).control({ action: "settings", instruction: "负责测试与测试用例设计" });
    const group = await engine.groups.create(u1, { name: "小分队", bulletin: "如果要测试或者设计测试用例，找测试牛马", employees: [a, b] });
    const seen = script(engine, { narrator: [{ targets: ["测试牛马", "不存在的牛马"], reason: "公告：测试用例找测试牛马" }], [b]: ["好的，我来设计测试用例"] });
    await engine.groups.send(u1, group.id, { text: "https://tapd.cn/x/story/detail/1 给这个需求单设计测试用例" });
    await settle(engine);
    assert.equal(narrated.length, 1);
    const input = narrated[0].setup;
    assert.equal(narrated[0].session, undefined, "the first judgement opens the session afterwards");
    assert.equal(input.群公告, "如果要测试或者设计测试用例，找测试牛马");
    assert.deepEqual(input.牛马.map((m: any) => [m.名称, m.守则]), [["默认牛马A", "（无）"], ["测试牛马", "负责测试与测试用例设计"]]);
    assert.match(narrated[0].last, /\[新消息\] #\d+ 用户「alice」：https:\S+ 给这个需求单设计测试用例/);
    assert.deepEqual(seen.map((s) => s.employeeId), [b], "only the real member it named answers");
    assert.match(JSON.stringify(seen[0].messages), /\[旁白\] 这条消息没有 @ 谁，旁白判断交给你：公告：测试用例找测试牛马/);
    const messages = await groupMessages(engine, group.id);
    assert(!messages.some((m) => /旁白|交给/.test(String(m.text)) && m.author?.kind !== "user"), "the 旁白 only judges: nothing is posted to the group");
    assert.deepEqual(messages.filter((m) => !m.notice).map((m) => m.author?.name), ["alice", "测试牛马"]);
    assert(!JSON.stringify(seen[0].messages).includes("旁白：交给"), "the member's turn does not rely on a group post");
    assert.deepEqual(messages.at(-1)?.[ "author" as "author"]?.name, "测试牛马");
    assert.equal(messages.at(-1)?.hop, 1, "a routed turn is one hop from the user message, as a mention would be");
    // An @ goes straight to that member; the 旁白 is not asked. The reply (no @) does not reach the 旁白 either.
    narrated.length = 0;
    const direct = script(engine, { [a]: ["收到"] });
    await engine.groups.send(u1, group.id, { text: "@默认牛马A 看下" });
    await settle(engine);
    assert.deepEqual([narrated.length, direct.length], [0, 1]);
    // An @ of a user is explicit too. No choice is never nobody: the 牛马 that spoke last answers.
    script(engine, { narrator: [{ targets: [], reason: "闲聊" }], [a]: ["不客气"] });
    await engine.groups.send(u1, group.id, { text: "@alice 你看看" });
    await engine.groups.send(u1, group.id, { text: "大家辛苦了" });
    await settle(engine);
    assert.equal(narrated.length, 1, "only the message without any @ is judged");
    const thanked = (await groupMessages(engine, group.id)).at(-1)!;
    assert.deepEqual([thanked.author?.name, thanked.text], ["默认牛马A", "不客气"], "the last speaker answers when the 旁白 picks nobody");
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
    await settle(engine);
    await engine.groups.send(u1, group.id, { text: "辛苦" });
    await settle(engine);
    const first = (await engine.groups.get(group.id))!.narrator!;
    assert.equal(narrated[1].session, first.session, "the second judgement continues the same session");
    const sent = (m: any) => ({ role: m.role, text: m.text, calls: m.calls, callId: m.callId });
    assert.deepEqual(narrated[1].messages.slice(0, narrated[0].messages.length).map(sent), narrated[0].messages.map(sent), "append-only: the earlier call is a prefix");
    assert.deepEqual(narrated[1].messages.slice(narrated[0].messages.length, -1).map((m: any) => m.role), ["assistant", "tool"], "its route_message call and result follow");
    assert.equal(narrated[1].setup, undefined, "the setup is not repeated");
    assert.match(narrated[1].last, /\[上次判断之后的群消息\]\n#\d+ 牛马「小A」：写好了\n\[新消息\] #\d+ 用户「alice」：辛苦/, "it learns who has been talking since");
    assert((await engine.store.session(first.session)).groupId === group.id, "hidden, tied to the group");
    // A changed bulletin starts a fresh session (no stale routing precedent); the old one is deleted.
    await engine.groups.update(u1, group.id, { bulletin: "小B 也写代码" });
    await engine.groups.send(u1, group.id, { text: "在吗" });
    await settle(engine);
    const second = (await engine.groups.get(group.id))!.narrator!;
    assert.notEqual(second.session, first.session);
    assert(!await engine.store.hasSession(first.session), "the old session is gone");
    assert.equal(narrated[2].messages.length, 1, "a fresh session starts with one message");
    assert.equal(narrated[2].setup.群公告, "小B 也写代码");
    assert.match(narrated[2].last, /\[此前的群消息\][\s\S]*辛苦[\s\S]*\n\[新消息\]/, "it carries the last few messages");
    // Too long: the next judgement starts over with only the last NARRATOR.carry messages.
    NARRATOR.tokens = 1; NARRATOR.carry = 2;
    await engine.groups.send(u1, group.id, { text: "再问一下" });
    await settle(engine);
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
  assert(route.includes("newCommand(a.text)") && route.includes("engine.newChatContext(session.id"), "the private chat route handles /new");
});

test("/new in a private chat: the visible history stays, the model only sees what follows the divider", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const session = await (await engine.employee.for(a)).chat("u1");
    const seen = script(engine, { [a]: ["旧的回答", "新的回答"] });
    await engine.submitChat(session.id, { role: "user", text: "旧的问题", actorId: "u1" });
    await settle(engine);
    await engine.newChatContext(session.id);
    await engine.submitChat(session.id, { role: "user", text: "新的问题", actorId: "u1" });
    await settle(engine);
    const second = JSON.stringify(seen[1].messages);
    assert(second.includes("新的问题") && !second.includes("旧的问题") && !second.includes(NEW_SESSION_NOTICE), "context starts after the divider");
    const rows = await engine.store.messages(session.id);
    assert.deepEqual(rows.filter((m) => m.role === "user").map((m) => m.text), ["旧的问题", "新的问题"], "the history is kept");
    assert(rows.some((m) => m.notice && m.newSession && m.text === NEW_SESSION_NOTICE));
  } finally { await close(); }
});

test("/new in a group: 旁白 and member sessions start over; members then see only messages after the divider", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("小A", "u1");
    const group = await engine.groups.create(u1, { name: "重开", users: ["u2"], employees: [a] });
    const seen = script(engine, { narrator: [{ targets: [], reason: "闲聊" }, { targets: ["小A"], reason: "点名" }], [a]: ["旧", "旧闻", "新"] });
    await engine.groups.send(u1, group.id, { text: "旧话题 @小A" });
    await settle(engine);
    await engine.groups.send(u1, group.id, { text: "聊聊旧事" });
    await settle(engine);
    const before = (await engine.groups.get(group.id))!;
    const oldSessions = [before.memberSessions[a], before.narrator!.session];
    // Any member user may use it; /new alone wakes nobody.
    await engine.groups.send(u2 as any, group.id, { text: "/new" });
    await settle(engine);
    const after = (await engine.groups.get(group.id))!;
    assert.deepEqual([after.memberSessions, after.narrator], [{}, undefined]);
    for (const id of oldSessions) assert(!await engine.store.hasSession(id), "old sessions deleted");
    assert.deepEqual([narrated.length, seen.length], [1, 2], "the divider is not judged and wakes nobody");
    const divider = (await groupMessages(engine, group.id)).at(-1)!;
    assert.deepEqual([divider.notice, divider.newSession, divider.text], [true, true, NEW_SESSION_NOTICE]);
    // /new <text>: the text follows in the new context; the 旁白 starts fresh with nothing carried over.
    await engine.groups.send(u1, group.id, { text: "/new 小A 来一下" });
    await settle(engine);
    const last = narrated.at(-1);
    assert(last.setup && !/此前的群消息/.test(last.last) && /\[新消息\] #\d+ 用户「alice」：小A 来一下$/.test(last.last), last.last);
    const turn = JSON.stringify(seen.at(-1)!.messages);
    assert(turn.includes("小A 来一下") && !turn.includes("旧话题") && !turn.includes("聊聊旧事") && !turn.includes("旧\""), "the member sees only what follows");
    assert.equal(seen.at(-1)!.messages.filter((m: any) => m.role === "user").length, 1, "in a new member session");
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

test("旁白 (reported: 「牛马们 起床啦」 got no reply): greetings go to a member; every judgement is recorded; a reply without the call is a visible failure; admins see the session", async () => {
  const { engine, make, close } = await fixture();
  try {
    const a = await make("默认牛马A", "u1"), b = await make("测试牛马", "u1");
    const group = await engine.groups.create(u1, { name: "牛马小分队", employees: [a, b] });
    assert.match(NARRATOR_SYSTEM, /打招呼、喊大家（如「起床啦」「有人吗」）[\s\S]*交给最合适的一个牛马/);
    assert.match(NARRATOR_SYSTEM, /每条消息至少交给一个牛马，不要没人理/);
    // The model follows the prompt for a greeting; a model answering in text instead of calling the tool is not silence.
    const seen = script(engine, { narrator: [{ targets: ["默认牛马A"], reason: "打招呼，交给默认牛马" }, { text: "没有人需要回应" }], [a]: ["早！我在"] });
    await engine.groups.send(u1, group.id, { text: "牛马们 起床啦" });
    await settle(engine);
    assert.deepEqual(seen.map((s) => s.employeeId), [a]);
    await engine.groups.send(u1, group.id, { text: "没人在吗" });
    await settle(engine);
    const last = (await groupMessages(engine, group.id)).at(-1)!;
    assert(last.notice && /旁白没能判断这条消息该交给谁（模型没有调用 route_message：没有人需要回应）/.test(String(last.text)), String(last.text));
    // The narrator's own session holds the judged message; the failed one is shown to the next judgement.
    const state = (await engine.groups.get(group.id))!.narrator!;
    const rows = await engine.store.messages(state.session);
    assert.match(String(rows[0].text), /牛马们 起床啦/);
    assert.deepEqual(rows.map((m) => m.role), ["user", "assistant", "tool"]);
    const route = readFileSync("server/routes/api/[...path].ts", "utf8");
    assert(route.includes('kind: "narrator"') && readFileSync("web/src/DebugSessions.vue", "utf8").includes('narrator: "旁白会话"'), "调试会话 lists the 旁白 session");
  } finally { await close(); }
});
