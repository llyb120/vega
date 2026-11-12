import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { computed, nextTick, reactive, ref } from "vue";
import { CHAT_PAGE_SIZE, mergeMessages } from "../web/src/chat-history.js";
import { conversationTurns } from "../web/src/conversation.js";

const source = readFileSync("web/src/EmployeeSessionView.vue", "utf8");
function mount(api: any) {
  const props = { api, sessionId: "fixture", revision: 0, debug: false };
  let dispose = () => {};
  const state = vm.runInNewContext(source.slice(source.indexOf("const props ="), source.indexOf("</script>")) +
    "\n({ refresh, loadOlder, onScroll, messages, transcript, record, hasMore, loadingOlder, running, busy, error })", {
    ref, computed, nextTick, CHAT_PAGE_SIZE, mergeMessages, encodeURIComponent,
    defineProps: () => props, defineEmits: () => () => {}, watch: () => {}, onBeforeUnmount: (fn: any) => { dispose = fn; },
  });
  return { ...state, props, dispose: () => dispose() };
}
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ seq: i + 1, role: ["user", "assistant", "tool"][i % 3], text: `message ${i + 1}` }));
function server(messages: any[]) {
  const paths: string[] = [];
  return { paths, api: async (path: string) => {
    paths.push(path);
    const query = new URLSearchParams(path.split("?")[1]);
    const before = Number(query.get("before") || Infinity), after = query.get("after");
    const page = after === null ? messages.filter((m) => m.seq < before).slice(-Number(query.get("limit") || 60)) : messages.filter((m) => m.seq > Number(after));
    return { session: { id: path.split("/")[2].split("?")[0], taskId: "task" }, messages: page, hasMore: page[0]?.seq > 1, lastSeq: messages.at(-1)?.seq ?? 0, running: true };
  } };
}
function viewport(state: any, compact = false) {
  state.transcript.value = { scrollTop: 0, clientHeight: 600,
    get scrollHeight() { return compact && state.messages.value.every((m: any) => m.role === "tool") ? 100 : state.messages.value.length * 30; },
  };
  return state.transcript.value;
}
const settled = async () => { for (let i = 0; i < 20; i++) await nextTick(); };

test("execution history opens the last page of all roles and refresh preserves older pages and the reader's position", async () => {
  const messages = rows(180), mock = server(messages), state = mount(mock.api), el = viewport(state);
  await state.refresh();
  assert.equal(state.messages.value.length, 60);
  assert.equal(state.messages.value[0].seq, 121);
  assert.deepEqual([...new Set(state.messages.value.map((m: any) => m.role))].sort(), ["assistant", "tool", "user"]);
  assert.equal(el.scrollTop, el.scrollHeight);
  el.scrollTop = 100;
  await state.loadOlder();
  const oldest = state.messages.value[0];
  assert.equal(oldest.seq, 61);
  el.scrollTop = 200;
  messages.push({ seq: 181, role: "tool", text: "new result" });
  await state.refresh();
  assert.equal(state.messages.value[0], oldest);
  assert.equal(state.messages.value.length, 121);
  assert.equal(state.hasMore.value, true);
  assert.equal(el.scrollTop, 200);
  assert.equal(mock.paths.at(-1), "/sessions/fixture?after=180");
  await state.refresh();
  assert.equal(state.messages.value.length, 121, "refresh does not duplicate or discard loaded messages");
});

test("a tool-only compact page silently fetches older pages until ordinary messages make the viewport scrollable", async () => {
  const messages = rows(122).map((m, i) => ({ ...m, role: i === 0 ? "user" : i === 1 ? "assistant" : "tool" }));
  const mock = server(messages), state = mount(mock.api);
  viewport(state, true);
  await state.refresh();
  assert.equal(state.messages.value[0].role, "user");
  assert.equal(state.messages.value[1].role, "assistant");
  assert.equal(state.messages.value.length, 122);
  assert.deepEqual(mock.paths, ["/sessions/fixture?limit=60", "/sessions/fixture?before=63&limit=60", "/sessions/fixture?before=3&limit=60"]);
  assert.equal(state.hasMore.value, false);
});

test("scrolling up automatically prepends history without pulling the viewport to the newest records", async () => {
  const mock = server(rows(180)), state = mount(mock.api), el = viewport(state);
  await state.refresh();
  el.scrollTop = 90;
  state.onScroll();
  state.onScroll();
  await settled();
  assert.equal(state.messages.value[0].seq, 61);
  assert.equal(el.scrollTop, 1890);
  assert.equal(mock.paths.length, 2, "repeated scroll events share the in-flight older page");
});

test("an older page survives a simultaneous tool refresh and anchors to the position at response time", async () => {
  const messages = rows(180), mock = server(messages);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = mount(async (path: string) => { if (path.includes("before=")) await gate; return mock.api(path); }), el = viewport(state);
  await state.refresh();
  el.scrollTop = 100;
  const older = state.loadOlder();
  messages.push({ seq: 181, role: "tool", text: "completed" });
  await state.refresh();
  el.scrollTop = 150;
  release();
  await older;
  assert.equal(state.messages.value.length, 121);
  assert.equal(state.messages.value[0].seq, 61);
  assert.equal(state.messages.value.at(-1).seq, 181);
  assert.equal(el.scrollTop, 1950, "append height and user scrolling during the request are not counted as prepended height");
  assert.equal(state.loadingOlder.value, false);
});

test("a delayed refresh does not follow the tail after the reader has scrolled away", async () => {
  const messages = rows(180), mock = server(messages);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = mount(async (path: string) => { if (path.includes("after=")) await gate; return mock.api(path); }), el = viewport(state);
  await state.refresh();
  messages.push({ seq: 181, role: "tool", text: "completed" });
  const refresh = state.refresh();
  el.scrollTop = 100;
  release();
  await refresh;
  assert.equal(el.scrollTop, 100);
});

test("switching sessions discards an old pending page and resets its loading state", async () => {
  const mock = server(rows(180));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = mount(async (path: string) => { if (path.includes("before=")) await gate; return mock.api(path); });
  viewport(state);
  await state.refresh();
  const older = state.loadOlder();
  state.props.sessionId = "other";
  await state.refresh();
  release();
  await older;
  assert.equal(state.record.value.session.id, "other");
  assert.equal(state.messages.value[0].seq, 121);
  assert.equal(state.loadingOlder.value, false);
  state.dispose();
});

test("a failed background refresh leaves loaded history available and can be retried incrementally", async () => {
  const mock = server(rows(180));
  let fail = false;
  const state = mount(async (path: string) => { if (fail) throw Error("temporary failure"); return mock.api(path); });
  viewport(state);
  await state.refresh();
  await state.loadOlder();
  fail = true;
  await state.refresh();
  assert.equal(state.messages.value[0].seq, 61);
  assert.equal(state.error.value, "temporary failure");
  assert.equal(state.busy.value, false);
  fail = false;
  await state.refresh();
  assert.equal(state.messages.value[0].seq, 61);
  assert.equal(mock.paths.at(-1), "/sessions/fixture?after=180");
});

test("a server history rollback reloads the latest window rather than keeping deleted messages", async () => {
  const messages = rows(180), mock = server(messages), state = mount(mock.api);
  viewport(state);
  await state.refresh();
  messages.splice(120);
  await state.refresh();
  assert.equal(state.messages.value.at(-1).seq, 120);
  assert.equal(state.messages.value[0].seq, 61);
  assert.equal(state.busy.value, false);
  assert.deepEqual(mock.paths.slice(-2), ["/sessions/fixture?after=180", "/sessions/fixture?limit=60"]);
});

test("revoked access clears visible history and invalidates a pending older page", async () => {
  const mock = server(rows(180));
  let denied = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = mount(async (path: string) => {
    if (path.includes("before=")) { const response = await mock.api(path); await gate; return response; }
    if (denied) throw Object.assign(Error("forbidden"), { status: 403 });
    return mock.api(path);
  });
  viewport(state);
  await state.refresh();
  const older = state.loadOlder();
  denied = true;
  await state.refresh();
  release();
  await older;
  assert.equal(state.messages.value.length, 0);
  assert.equal(state.record.value, null);
  assert.equal(state.hasMore.value, false);
  assert.equal(state.loadingOlder.value, false);
  assert.equal(state.busy.value, false);
});

test("turn and process keys preserve mounted folds through refresh, tool completion, and prepending across a turn boundary", () => {
  const messages = [
    { seq: 1, role: "user", text: "earlier turn" },
    { seq: 2, role: "assistant", text: "done" },
    { seq: 3, role: "user", text: "current turn" },
    { seq: 4, role: "assistant", text: "checking" },
    { seq: 5, role: "tool", callId: "first", name: "read", text: "one" },
    { seq: 6, role: "tool", callId: "second", name: "read", text: "two" },
    { seq: 7, role: "assistant", text: "writing", calls: [{ id: "write", name: "write" }] },
    { seq: 8, role: "tool", callId: "write", name: "write", text: "done" },
  ];
  const props = reactive({ messages: messages.slice(5, 7), running: true, live: "", thinking: "" });
  const timeline = readFileSync("web/src/ConversationTimeline.vue", "utf8");
  const turns = vm.runInNewContext(timeline.slice(timeline.indexOf("const turns ="), timeline.indexOf("</script>")) + "\nturns", { computed, ref, watch: () => {}, conversationTurns, props });
  const initial = turns.value[0], firstKey = initial.process[0].key, pendingKey = initial.process.at(-1).key;
  props.messages = messages.slice(5);
  const completed = turns.value[0];
  assert.equal(completed.key, initial.key);
  assert.equal(completed.process.at(-1).key, pendingKey);
  assert.equal(completed.process[0].key, firstKey);
  props.messages = messages;
  const prepended = turns.value[1];
  assert.equal(prepended.key, initial.key, "revealing the missing user does not remount the turn");
  assert.equal(prepended.process[1].key, firstKey, "extending a tool group backwards does not remount it");
  assert.equal(prepended.process.at(-1).key, pendingKey);
  assert.equal(new Set(turns.value.map((turn: any) => turn.key)).size, 2);
  assert(timeline.includes(':key="turn.key"'));
  assert(readFileSync("web/src/ToolSteps.vue", "utf8").includes("m.callId || m.id || m.seq"));
});
