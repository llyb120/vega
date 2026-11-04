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
