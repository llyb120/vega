import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("local/assistant_page.html", "utf8");
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

// 蝴蝶面板不订阅事件，只靠轮询；这里只跑 pollMessages，其余 DOM 更新用空函数替代。
function panel(state: any, responses: any[]) {
  const calls: any[] = [], opened: string[] = [];
  const context: any = {
    state,
    api: async (op: string, body: any) => { calls.push([op, body]); return responses.shift(); },
    open: async (thread: string) => { opened.push(thread); },
    updateHead() {}, renderStream() {},
  };
  context.pollMessages = vm.runInNewContext(between("async function pollMessages(", "async function pollThreads(") + "\npollMessages", context);
  return { ...context, calls, opened };
}

const empty = () => ({ current: "employee:ea", messages: [], lastSeq: 0, running: false, avatar: "", authors: {} });

test("清空聊天或重置后序号倒退，面板整段重开会话而不是拿着旧 seq 干等", async () => {
  const state = { ...empty(), messages: [{ seq: 120, text: "old" }], lastSeq: 120, running: true };
  const p = panel(state, [{ messages: [], lastSeq: 0, running: false }]);
  await p.pollMessages();
  // 面板在 vm 里构造的请求对象与宿主的原型不同，按内容比。
  assert.equal(JSON.stringify(p.calls[0]), JSON.stringify(["messages", { thread: "employee:ea", after: 120 }]));
  assert.deepEqual(p.opened, ["employee:ea"], "历史被删：重开会话拉新历史");
});

test("正常追加只合并新消息，不重开会话", async () => {
  const state = { ...empty(), messages: [{ seq: 120, text: "old" }], lastSeq: 120 };
  const p = panel(state, [{ messages: [{ seq: 121, text: "new" }], lastSeq: 121, running: false }]);
  await p.pollMessages();
  assert.deepEqual(p.opened, []);
  assert.deepEqual(state.messages.map((m: any) => m.seq), [120, 121]);
  assert.equal(state.lastSeq, 121);
});

test("刚清空的空会话不会被反复重开", async () => {
  const state = empty();
  const p = panel(state, [{ messages: [], lastSeq: 0, running: false }]);
  await p.pollMessages();
  assert.deepEqual(p.opened, []);
});

// 头像的动静：只有左栏卡片在任务执行中动；本地输入中（这一轮还在跑）与聊天气泡里的头像都静止。
test("左栏头像只在任务执行中动，输入中与聊天气泡头像保持静止", () => {
  assert(source.includes('avatarHTML(item.avatar, seed, !!item.runningTasks, "ta-session-face")'), "左栏卡片看任务状态");
  assert(!/avatarHTML\([^)]*,\s*true\s*\)/.test(source), "没有头像写死开动画");
  const route = readFileSync("server/routes/api/[...path].ts", "utf8");
  assert(route.includes('runningTasks: s.tasks.filter((task) => task.status === "running").length'), "左栏动画跟着任务，而不是聊天这一轮");
});
