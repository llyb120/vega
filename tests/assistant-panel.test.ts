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
