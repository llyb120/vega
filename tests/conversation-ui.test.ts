import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { createChatHistory, mergeMessages } from "../web/src/chat-history.js";
import { employeeChatMessages } from "../web/src/conversation.js";

const chat = readFileSync("web/src/EmployeeChat.vue", "utf8");
const between = (start: string, end: string) => chat.slice(chat.indexOf(start), chat.indexOf(end));
function mount(api: any = async () => ({ messages: [], running: false })) {
  const messages = ref<any[]>([]), running = ref(false), hasMore = ref(false);
  const history = createChatHistory({ api, path: () => "/employees/fixture/chat", messages, running, hasMore });
  const context: any = {
    console, ref, computed, nextTick, history, messages, running, hasMore, runningFrom: ref(null), disposed: false, turn: 0, error: ref(""), transcript: ref(null), busy: ref(false),
    props: { employeeId: "fixture", api, composer: reactive({ text: "", images: [], quote: undefined }) },
    visible: computed(() => employeeChatMessages(messages.value, running.value)), employeeChatMessages, frozen: [] as any[],
  };
  context.easeIn = (seqs: number[]) => context.frozen.push(...seqs);
  const methods = vm.runInNewContext([
    "let turn = 0;",
    between("const draft = computed", "// While a turn runs"),
    between("const nearBottom =", "/** Prepend one older page"),
    between("async function refresh(apply", "async function upload("),
    between("async function send()", "async function stop()"),
    between("function handleEvent(event)", "watch(() => props.revision"),
    "({ refresh, handleEvent, finishTurn, send })",
  ].join("\n"), context);
  return { ...context, ...methods };
}

test("employee sends leave older history immediately and reveal the sent message after refresh", async () => {
  let release!: () => void, latest = false;
  const response = new Promise<void>((resolve) => release = resolve);
  const state = mount(async (_path: string, method: string) => {
    if (method === "POST") { await response; return {}; }
    return { session: { id: "s" }, messages: [{ seq: latest ? 2 : 1, role: "user", text: "work" }], running: false };
  });
  await state.history.load();
  latest = true;
  const transcript = state.transcript.value = { scrollTop: 100, scrollHeight: 1800, clientHeight: 600 };
  const stop = watch(state.messages, () => { transcript.scrollHeight = 2400; }, { flush: "post" });
  state.props.composer.text = "new message";
  const sending = state.send();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const immediateTop = transcript.scrollTop;
  transcript.scrollTop = 100;
  release();
  await sending;
  stop();
  assert.equal(immediateTop, 1800, "scrolling does not wait for the send request");
  assert.equal(transcript.scrollTop, 2400, "sending bypasses the near-bottom restriction after rendering");
  assert.equal(state.props.composer.text, "");
  assert.equal(state.busy.value, false);
});

test("incoming messages do not pull a reader away from older history", async () => {
  const state = mount(async () => ({ session: { id: "s" }, messages: [{ seq: 1, role: "assistant", text: "reply" }], running: false }));
  const transcript = state.transcript.value = { scrollTop: 100, scrollHeight: 1800, clientHeight: 600 };
  await state.refresh();
  assert.equal(transcript.scrollTop, 100);
});

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
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(state.running.value, false);
});

test("a delayed history response cannot clear a newer typing state", async () => {
  let finish!: (value: any) => void;
  const state = mount(() => new Promise((resolve) => finish = resolve));
  const pending = state.refresh();
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  assert(finish, "the history request is in flight");
  state.handleEvent({ type: "text_delta", data: "not shown until final" });
  finish({ session: { id: "s" }, messages: [{ seq: 1, role: "user", text: "work" }], running: false });
  await pending;
  assert.equal(state.running.value, true);
});

test("the typing row turns into the reply in one tick: reply merged, typing cleared and the reply avatar eases out of the typing glance", async () => {
  const replies: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const reply = { session: { id: "s" }, messages: [{ seq: 2, role: "assistant", text: "答复" }], running: false };
  const api = async (path: string) => { replies.push(path); if (replies.length === 1) return { session: { id: "s" }, messages: [{ seq: 1, role: "user", text: "work" }], running: true, hasMore: false }; await gate; return reply; };
  const state = mount(api);
  await state.refresh();
  state.handleEvent({ type: "started" });
  const seen: Array<[boolean, number]> = [];

  watch(() => [state.running.value, state.visible.value.length], ([running, count]: any) => seen.push([running, count]), { flush: "sync" });
  // message_end and done arrive back to back; the typing row must stay until the reply is in hand.
  state.handleEvent({ type: "message_end" });
  state.handleEvent({ type: "done" });
  assert.equal(state.running.value, true, "typing stays visible while the reply is fetched");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(state.running.value, true, "typing stays visible while the reply request is pending");
  release();
  for (let i = 0; i < 40 && state.running.value; i++) await Promise.resolve();
  assert.equal(state.running.value, false);
  assert.deepEqual(state.visible.value.map((message: any) => message.seq), [1, 2]);
  assert.equal(state.error.value, "");
  assert.deepEqual(state.frozen, [2], "only the new reply eases in from the typing avatar");
  assert(!seen.some(([running, count]) => !running && count < 2), "no state where typing is gone but the reply is not shown: " + JSON.stringify(seen));
  assert(replies.slice(1).every((path) => /\?after=[12]$/.test(path)), "only messages after the newest known sequence are fetched: " + replies.join(", "));
});

test("chat history pages backwards and merges without duplicates", async () => {
  const all = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", text: "m" + (i + 1) }));
  const paths: string[] = [];
  const api = async (path: string) => {
    paths.push(path);
    const query = new URLSearchParams(path.split("?")[1]);
    const before = Number(query.get("before") || Infinity), limit = Number(query.get("limit") || 60), after = query.get("after");
    if (after !== null) return { session: { id: "s" }, messages: all.filter((m) => m.seq > Number(after)), hasMore: true, running: false };
    const page = all.filter((m) => m.seq < before).slice(-limit);
    return { session: { id: "s" }, messages: page, hasMore: page[0]?.seq > 1, running: false };
  };
  const messages = ref<any[]>([]), running = ref(false), hasMore = ref(false);
  const history = createChatHistory({ api, path: () => "/chat", messages, running, hasMore, pageSize: 60 });
  await history.load();
  assert.equal(messages.value.length, 60);
  assert.equal(messages.value[0].seq, 941);
  assert.equal(hasMore.value, true);
  await history.older();
  assert.equal(messages.value.length, 120);
  assert.equal(messages.value[0].seq, 881);
  while (hasMore.value) await history.older();
  assert.deepEqual(messages.value.map((m: any) => m.seq), all.map((m) => m.seq));
  all.push({ seq: 1001, role: "assistant", text: "new" });
  await history.newer();
  assert.equal(messages.value.length, 1001);
  assert.deepEqual(mergeMessages([{ seq: 1 }, { seq: 3 }] as any, [{ seq: 2 }, { seq: 3, text: "x" }] as any), [{ seq: 1 }, { seq: 2 }, { seq: 3, text: "x" }]);
});

test("quoted replies send only a source sequence, preserve drafts on error, and do not clear a quote changed during submission", async () => {
  const calls: any[] = [];
  let fail = true, finish!: (value: any) => void;
  const props = { employeeId: "fixture", composer: reactive({ text: "explain this", images: [], quote: { seq: 7, text: "source" } as any }), api: async (...args: any[]) => {
    calls.push(args);
    if (fail) throw Error("offline");
    return new Promise((resolve) => finish = resolve);
  } };
  const context: any = { ref, computed, props, busy: ref(false), error: ref(""), refresh: async () => {}, scroll: async () => {} };
  const methods = vm.runInNewContext(between("const draft = computed", "// While a turn runs") + between("async function send()", "async function stop()") + "\n({send})", { ...context, nextTick: async () => {}, input: ref(null) });
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

test("reply avatars animate only while a linked task is live and actively in progress", async () => {
  const { isInProgress } = await import("../web/src/task-status.js");
  assert.deepEqual(["running", "recovering", "in_progress"].filter(isInProgress), ["running", "recovering", "in_progress"]);
  for (const status of ["queued", "pending", "deferred", "waiting", "approval", "blocked", "done", "completed", "failed", "stopped", "cancelled", undefined]) assert.equal(isInProgress(status), false, String(status));
  const bubble = readFileSync("web/src/ChatMessage.vue", "utf8");
  assert(bubble.includes("isInProgress(props.taskStatus?.[task.id])"), "only the live status (never the stored snapshot) can start the animation");
  assert(chat.includes(':task-status="taskStatus"') && readFileSync("web/src/App.vue", "utf8").includes(':tasks="employee.tasks"'));
  const avatar = readFileSync("web/src/BotAvatar.vue", "utf8");
  assert(avatar.includes("IntersectionObserver"), "off-screen avatars pause");
});
