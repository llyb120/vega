import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { computed, reactive, ref } from "vue";

const chat = readFileSync("web/src/EmployeeChat.vue", "utf8");
const between = (start: string, end: string) => chat.slice(chat.indexOf(start), chat.indexOf(end));
function mount(api: any = async () => ({ messages: [], running: false })) {
  const context: any = {
    ref, disposed: false, request: 0, streamVersion: 0, props: { api, employeeId: "fixture" }, scroll: async () => {},
    messages: ref([]), running: ref(false), transcript: ref(null), error: ref(""),
  };
  const methods = vm.runInNewContext(between("async function refresh()", "async function upload(") + between("function handleEvent(event)", "watch(() => props.revision") + "\n({ refresh, handleEvent })", context);
  return { ...context, ...methods };
}

test("employee chat uses conclusion bubbles and typing dots; process details remain available in execution/debug records", () => {
  assert(chat.includes('import ChatMessage from "./ChatMessage.vue"'));
  assert(!chat.includes("<ToolSteps") && !chat.includes("<TurnProcess") && !chat.includes("<ConversationTimeline"));
  assert(chat.includes("employeeChatMessages(messages.value, running.value)"));
  assert(chat.includes("正在输入中") && chat.includes("typing-dots") && chat.includes("prefers-reduced-motion"));
  const bubble = readFileSync("web/src/ChatMessage.vue", "utf8");
  assert(bubble.includes("<UserMessage") && bubble.includes("<MessageText") && bubble.includes("chat-quote") && bubble.includes("chat-task-link"));
  assert(bubble.includes("message.error ? 'alert'") && bubble.includes("data-message-seq"));
  for (const file of ["App", "EmployeeSessionView"]) assert(readFileSync(`web/src/${file}.vue`, "utf8").includes("<ConversationTimeline"));
  const timeline = readFileSync("web/src/ConversationTimeline.vue", "utf8");
  assert(timeline.includes("<TurnProcess") && timeline.includes("<ToolSteps"));
});

test("in-flight and persisted tool calls share a single entry in the detailed execution view", () => {
  const source = readFileSync("web/src/ToolSteps.vue", "utf8");
  const props = { items: [{ role: "tool", id: "pending", name: "write", pending: true }, { role: "tool", callId: "finished", name: "read", text: "ok" }], active: [{ id: "pending", name: "write" }, { id: "finished", name: "read" }, { id: "new", name: "bash" }] };
  const items = vm.runInNewContext(source.slice(source.indexOf("const allItems ="), source.indexOf("const summary =")) + "\nallItems.value", { computed, props });
  assert.equal(items.length, 3);
  assert.equal(items.filter((item: any) => item.active).length, 2);
});

test("employee stream events keep typing visible but never append partial text or process data to the chat", async () => {
  const state = mount();
  state.handleEvent({ type: "started" });
  for (const type of ["message_start", "thinking_delta", "text_delta", "tool_start", "tool_end"]) state.handleEvent({ type, data: "process details" });
  assert.equal(state.running.value, true);
  assert.equal(state.messages.value.length, 0);
  state.handleEvent({ type: "done" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.running.value, false);
});

test("a delayed history response cannot clear a newer typing state", async () => {
  let finish!: (value: any) => void;
  const state = mount(() => new Promise((resolve) => finish = resolve));
  const pending = state.refresh();
  state.handleEvent({ type: "text_delta", data: "not shown until final" });
  finish({ messages: [{ seq: 1, role: "user", text: "work" }], running: false });
  await pending;
  assert.equal(state.running.value, true);
});

test("quoted replies send only a source sequence, preserve drafts on error, and do not clear a quote changed during submission", async () => {
  const calls: any[] = [];
  let fail = true, finish!: (value: any) => void;
  const props = { employeeId: "fixture", composer: reactive({ text: "explain this", images: [], quote: { seq: 7, text: "source" } as any }), api: async (...args: any[]) => {
    calls.push(args);
    if (fail) throw Error("offline");
    return new Promise((resolve) => finish = resolve);
  } };
  const context: any = { ref, computed, props, busy: ref(false), error: ref(""), refresh: async () => {} };
  const methods = vm.runInNewContext(between("const draft = computed", "let disposed =") + between("async function send()", "async function stop()") + "\n({send})", { ...context, nextTick: async () => {}, input: ref(null) });
  await methods.send();
  assert.equal(props.composer.quote.seq, 7);
  assert.equal(props.composer.text, "explain this");
  assert.equal(calls[0][2].quoteSeq, 7);
  assert.equal(calls[0][2].quote, undefined, "quoted content is resolved by the server, not trusted from the browser");
  fail = false;
  const sending = methods.send();
  props.composer.quote = { seq: 8, text: "new source" };
  finish({});
  await sending;
  assert.equal(props.composer.quote.seq, 8);
  assert.equal(props.composer.text, "explain this");
});
