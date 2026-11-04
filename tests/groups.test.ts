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
function script(engine: Engine, replies: Record<string, (string | object)[]>) {
  const seen: { employeeId: string; system: string; messages: any[] }[] = [];
  engine.providers.chat = (async (_model: any, system: string, messages: any[], _tools: any, _signal: any, _emit: any, key: string) => {
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
    await engine.groups.send(u1, group.id, { text: "大家好" });
    await settle(engine);
    assert.equal(seen.length, 0, "nobody was @mentioned, nobody answers");
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
