import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { createChatHistory, mergeMessages } from "../web/src/chat-history.js";
import { employeeChatMessages, continuesPrevious } from "../web/src/conversation.js";
import { createLiveReply } from "../web/src/live-reply.js";

const chat = readFileSync("web/src/EmployeeChat.vue", "utf8");
const between = (start: string, end: string) => chat.slice(chat.indexOf(start), chat.indexOf(end));
function mount(api: any = async () => ({ messages: [], running: false }), crypto: any = webcrypto) {
  const messages = ref<any[]>([]), running = ref(false), hasMore = ref(false);
  const history = createChatHistory({ api, path: () => "/employees/fixture/chat", messages, running, hasMore });
  const context: any = {
    console, ref, computed, watch, crypto, nextTick, history, messages, running, hasMore, disposed: false, turn: 0, error: ref(""), transcript: ref(null), busy: ref(false),
    props: { employeeId: "fixture", api, composer: reactive({ text: "", images: [], quote: undefined }) },
    employeeChatMessages, continuesPrevious, createLiveReply, frozen: [] as any[],
  };
  context.easeIn = (seqs: number[]) => context.frozen.push(...seqs);
  const methods = vm.runInNewContext([
    "let turn = 0;",
    between("const draft = computed", "const visible ="),
    between("const visible =", "const history ="),
    between("const nearBottom =", "/** Prepend one older page"),
    between("async function refresh(apply", "async function upload("),
    between("async function send()", "async function stop()"),
    between("function handleEvent(event)", "watch(() => props.revision"),
    "({ refresh, handleEvent, finishTurn, send, retry, outbox, displayed, visible, reply, typingContinued })",
  ].join("\n"), context);
  return { ...context, ...methods, dispose: () => { context.disposed = true; } };
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

test("mobile HTTP contexts without randomUUID can send and retry with the same secure message ID", async () => {
  const calls: any[] = [];
  const state = mount(async (_path: string, method: string, body: any) => {
    if (method !== "POST") return { messages: [], running: true };
    calls.push(body);
    if (calls.length === 1) throw Error("offline");
    return {};
  }, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  state.props.composer.text = "手机消息";
  await state.send();
  const message = state.outbox.value[0];
  assert.equal(message.sendStatus, "failed");
  assert.match(message.clientMessageId, /^[a-zA-Z0-9_-]{16,80}$/);
  assert.equal(state.props.composer.text, "");
  await state.retry(message);
  assert.equal(message.sendStatus, "sent");
  assert.equal(calls[1].clientMessageId, calls[0].clientMessageId);
  state.props.composer.text = "下一条";
  await state.send();
  assert.notEqual(calls[2].clientMessageId, calls[0].clientMessageId);
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
  assert(chat.includes("employeeChatMessages(messages.value)"));
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

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const texts = (state: any) => Array.from(state.displayed.value, (row: any) => row.message.text);

test("streamed text shows as a live bubble at once; thinking and tool events never reach the chat", async () => {
  const state = mount();
  state.handleEvent({ type: "started" });
  state.handleEvent({ type: "message_start" });
  for (const type of ["thinking_delta", "tool_start", "tool_end"]) state.handleEvent({ type, data: "process details" });
  assert.equal(state.reply.writing.value, false, "no text yet: the typing dots stay");
  state.handleEvent({ type: "text_delta", data: "好的，" });
  state.handleEvent({ type: "text_delta", data: "我去安排" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(texts(state), ["好的，我去安排"], "deltas accumulate into one bubble, painted per frame");
  assert.equal(state.displayed.value[0].message.streaming, true);
  assert.equal(state.reply.writing.value, true, "the live bubble replaces the typing dots");
  assert.equal(state.running.value, true);
});

test("message_end swaps the live bubble for the persisted message in one tick, never showing it twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const persisted = { seq: 2, role: "assistant", text: "好的，我去安排", calls: [{ id: "c", name: "employee_task_create" }] };
  const api = async (path: string) => path.includes("after=") ? (await gate, { session: { id: "s" }, messages: [persisted], running: true })
    : { session: { id: "s" }, messages: [{ seq: 1, role: "user", text: "work" }], running: true };
  const state = mount(api);
  await state.refresh();
  state.handleEvent({ type: "started" });
  state.handleEvent({ type: "message_start" });
  state.handleEvent({ type: "text_delta", data: "好的，我去安排" });
  const seen: string[] = [];
  // Rendering flushes once per tick (pre-flush), like the chat page.
  watch(() => texts(state).join("|"), (value: string) => seen.push(value));
  state.handleEvent({ type: "message_end" });
  state.handleEvent({ type: "message_start" });
  assert.deepEqual(texts(state), ["work", "好的，我去安排"], "the ended text stays while the persisted copy loads");
  assert.equal(state.reply.writing.value, false, "the next message starts with typing dots");
  release();
  await tick(40);
  await nextTick();
  assert.deepEqual(texts(state), ["work", "好的，我去安排"]);
  assert.equal(state.displayed.value[1].message.seq, 2, "the persisted copy (with tool calls) is what remains");
  assert(!seen.some((value) => value.split("|").filter((text) => text === "好的，我去安排").length > 1), "never two copies: " + JSON.stringify(seen));
});

test("masked turns stream no deltas: the bubble appears when the persisted message is merged", async () => {
  const state = mount(async () => ({ session: { id: "s" }, messages: [{ seq: 1, role: "assistant", text: "已核对" }], running: true }));
  state.handleEvent({ type: "started" });
  state.handleEvent({ type: "message_start" });
  assert.deepEqual(texts(state), []);
  state.handleEvent({ type: "message_end" });
  await tick(40);
  assert.deepEqual(texts(state), ["已核对"]);
  state.handleEvent({ type: "done" });
  await tick(40);
  assert.equal(state.running.value, false);
});

test("consecutive bubbles of one reply run do not repeat avatar and name; deliveries stand alone", async () => {
  const state = mount(async () => ({ session: { id: "s" }, running: false, messages: [
    { seq: 1, role: "user", text: "work" },
    { seq: 2, role: "assistant", text: "收到，先核对", calls: [{ id: "a", name: "employee_status" }] },
    { seq: 3, role: "tool", callId: "a", text: "{}" },
    { seq: 4, role: "assistant", text: "已安排" },
    { seq: 5, role: "assistant", text: "**已交付**", delivery: true },
    { seq: 6, role: "assistant", text: "进展", progress: true },
  ] }));
  await state.refresh();
  assert.deepEqual(Array.from(state.displayed.value, (row: any) => [row.message.seq, row.continued]), [[1, false], [2, false], [4, true], [5, false], [6, false]]);
});

test("a delayed history response cannot clear a newer typing state", async () => {
  let finish!: (value: any) => void;
  const state = mount(() => new Promise((resolve) => finish = resolve));
  const pending = state.refresh();
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  assert(finish, "the history request is in flight");
  state.handleEvent({ type: "thinking_delta", data: "still working" });
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

test("offline messages appear immediately; retry preserves ID, images and quote without touching the next draft", async () => {
  const calls: any[] = [];
  let fail = true, finish!: (value: any) => void;
  const state = mount(async (_path: string, method: string, body: any) => {
    if (method !== "POST") return { session: { id: "s" }, messages: [], running: true };
    calls.push(body);
    if (fail) throw Error("offline");
    return new Promise((resolve) => finish = resolve);
  });
  const composer = state.props.composer;
  composer.text = "explain this";
  composer.images = [{ mime: "image/png", data: "YQ==" }];
  composer.quote = { seq: 7, text: "source" };
  const sending = state.send();
  assert.equal(state.outbox.value[0].text, "explain this");
  assert.equal(state.outbox.value[0].sendStatus, "sending");
  assert.equal(composer.text, "");
  assert.equal(composer.images.length, 0);
  await sending;
  const message = state.outbox.value[0];
  assert.equal(message.sendStatus, "failed");
  assert.equal(state.error.value, "", "delivery failures stay on the message, not in a banner");
  assert.equal(calls[0].quoteSeq, 7);
  assert.equal(calls[0].quote, undefined);
  fail = false;
  const retry = state.retry(message);
  state.retry(message);
  composer.text = "next draft";
  composer.quote = { seq: 8, text: "new source" };
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish({});
  await retry;
  assert.equal(calls.length, 2, "double-clicking retry sends only once");
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(message.sendStatus, "sent");
  assert.equal(composer.quote.seq, 8);
  assert.equal(composer.text, "next draft");
  state.messages.value = [{ seq: 1, role: "user", clientMessageId: message.clientMessageId }];
  await nextTick();
  assert.equal(state.outbox.value.length, 0, "server echo replaces the local bubble");
});

test("new messages stay sendable and ordered while an earlier delivery is pending", async () => {
  const sent: string[] = [];
  let finish!: () => void;
  const state = mount(async (_path: string, method: string, body: any) => {
    if (method !== "POST") return { messages: [], running: false };
    sent.push(body.text);
    if (sent.length === 1) await new Promise<void>((resolve) => finish = resolve);
    return {};
  });
  state.props.composer.text = "first";
  const first = state.send();
  state.props.composer.text = "second";
  const second = state.send();
  assert.equal(state.outbox.value.length, 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["first"]);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ["first", "second"]);
});

test("lost history refresh does not turn an acknowledged send into failure", async () => {
  const state = mount(async (_path: string, method: string) => {
    if (method !== "POST") throw Object.assign(Error("offline"), { network: true });
    return {};
  });
  state.props.composer.text = "accepted";
  await state.send();
  assert.equal(state.outbox.value[0].sendStatus, "sent");
  assert.equal(state.error.value, "");
});

test("unmount never sends queued messages into another workspace or login", async () => {
  let finish!: () => void, posts = 0;
  const state = mount(async (_path: string, method: string) => {
    if (method !== "POST") return { messages: [], running: false };
    posts++;
    await new Promise<void>((resolve) => finish = resolve);
    return {};
  });
  state.props.composer.text = "first";
  const first = state.send();
  state.props.composer.text = "second";
  const second = state.send();
  await new Promise<void>((resolve) => setImmediate(resolve));
  state.dispose();
  finish();
  await Promise.all([first, second]);
  assert.equal(state.outbox.value[0].sendStatus, "sent");
  assert.equal(state.outbox.value[1].sendStatus, "failed");
  assert.equal(posts, 1);
});

test("server echoes keep pending bubbles in place and a late failed acknowledgement cannot recreate a delivered message", async () => {
  let fail!: (error: Error) => void;
  const state = mount(async (_path: string, method: string) => {
    if (method !== "POST") return { messages: [], running: true };
    return new Promise((_resolve, reject) => fail = reject);
  });
  state.props.composer.text = "first";
  const first = state.send();
  state.props.composer.text = "second";
  const second = state.send();
  const firstId = state.outbox.value[0].clientMessageId;
  state.messages.value = [{ seq: 1, role: "user", text: "first", clientMessageId: firstId }];
  await nextTick();
  assert.deepEqual(Array.from(state.displayed.value, (row: any) => row.message.text), ["first", "second"]);
  assert.equal(state.outbox.value[0].afterSeq, 1);
  state.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fail(Error("acknowledgement lost"));
  await Promise.all([first, second]);
  assert.equal(state.outbox.value.length, 1);
  assert.equal(state.outbox.value[0].sendStatus, "failed");
});

test("failed earlier messages stay before later server messages, and interrupted queued messages become retryable", async () => {
  const state = mount(async () => { throw Error("offline"); });
  state.props.composer.text = "failed first";
  await state.send();
  state.props.composer.text = "later";
  await state.send();
  const later = state.outbox.value[1];
  state.messages.value = [{ seq: 1, role: "user", text: "later", clientMessageId: later.clientMessageId }];
  await nextTick();
  assert.deepEqual(Array.from(state.displayed.value, (row: any) => row.message.text), ["failed first", "later"]);
  const queued = state.outbox.value[0];
  queued.sendStatus = "sent";
  state.running.value = true;
  await nextTick();
  state.running.value = false;
  await nextTick();
  assert.equal(queued.sendStatus, "failed", "accepted but unprocessed messages can be resent after interruption");
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
