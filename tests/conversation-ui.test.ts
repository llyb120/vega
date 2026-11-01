import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { computed, ref } from "vue";

const chat = readFileSync("web/src/EmployeeChat.vue", "utf8");
const between = (start: string, end: string) => chat.slice(chat.indexOf(start), chat.indexOf(end));
function mount(api: any = async () => ({ messages: [], running: false })) {
  const context: any = {
    ref, disposed: false, request: 0, streamVersion: 0, props: { api, employeeId: "fixture" }, scroll: async () => {},
    messages: ref([]), running: ref(false), live: ref(""), thinking: ref(""), activeTools: ref([]), model: ref(""), error: ref(""),
  };
  const methods = vm.runInNewContext(between("async function refresh()", "async function upload(") + between("function handleEvent(event)", "watch(() => props.revision") + "\n({ refresh, handleEvent })", context);
  return { ...context, ...methods };
}

test("employee chat, task records and the retained chat all reuse the original Nova turn structure", () => {
  for (const file of ["App", "EmployeeChat", "EmployeeSessionView"]) {
    const source = readFileSync(`web/src/${file}.vue`, "utf8");
    assert(source.includes('import ConversationTimeline from "./ConversationTimeline.vue"'));
    assert(source.includes("<ConversationTimeline"));
  }
  assert(!chat.includes("turn.body.filter"));
  const timeline = readFileSync("web/src/ConversationTimeline.vue", "utf8");
  assert(timeline.includes("<UserMessage") && timeline.includes("<TurnProcess") && timeline.includes("<ToolSteps"));
  assert(timeline.includes("turn.conclusion") && timeline.includes("started-at"));
  assert(timeline.includes("entry.message.displayText || entry.message.text"));
  assert(timeline.includes("error: !!entry.message.error") && timeline.includes("entry.message.error ? 'alert'"), "persisted runtime failures must be visible as failures after reload");
  const debug = readFileSync("web/src/EmployeeSessionView.vue", "utf8");
  assert(debug.includes('raw = ref(false)') && debug.includes("原始消息") && debug.includes("JSON.stringify(message.calls"));
  assert(readFileSync("web/src/ToolSteps.vue", "utf8").includes("image.blobId ? `/api/blobs/${image.blobId}`"));
});

test("in-flight and persisted tool calls share a single entry instead of double-counted summary rows", () => {
  const source = readFileSync("web/src/ToolSteps.vue", "utf8");
  const props = { items: [{ role: "tool", id: "pending", name: "write", pending: true }, { role: "tool", callId: "finished", name: "read", text: "ok" }], active: [{ id: "pending", name: "write" }, { id: "finished", name: "read" }, { id: "new", name: "bash" }] };
  const items = vm.runInNewContext(source.slice(source.indexOf("const allItems ="), source.indexOf("const summary =")) + "\nallItems.value", { computed, props });
  assert.equal(items.length, 3);
  assert.equal(items.filter((item: any) => item.active).length, 2);
  assert.equal(items.find((item: any) => item.id === "pending").active, true);
  assert.equal(items.find((item: any) => item.callId === "finished").active, undefined);
});

test("employee streaming keeps thoughts, model identity and in-flight tools rather than flattening only final text", async () => {
  const state = mount();
  state.handleEvent({ type: "started" });
  state.handleEvent({ type: "message_start", data: { model: "fixture/model" } });
  state.handleEvent({ type: "thinking_delta", data: "Inspect first" });
  state.handleEvent({ type: "text_delta", data: "Checking" });
  state.handleEvent({ type: "tool_start", data: { id: "read", name: "read" } });
  assert.equal(state.thinking.value, "Inspect first");
  assert.equal(state.live.value, "Checking");
  assert.equal(state.model.value, "fixture/model");
  assert.equal(state.activeTools.value[0].name, "read");
  state.handleEvent({ type: "tool_end", data: { call: { id: "read" } } });
  assert.equal(state.activeTools.value.length, 0);
  state.handleEvent({ type: "done" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.running.value, false);
});

test("a delayed employee history read cannot erase a newer streaming thought or result", async () => {
  let finish!: (value: any) => void;
  const state = mount(() => new Promise((resolve) => finish = resolve));
  const request = state.refresh();
  state.handleEvent({ type: "thinking_delta", data: "new reasoning" });
  state.handleEvent({ type: "text_delta", data: "new answer" });
  finish({ messages: [{ seq: 1, role: "user", text: "work" }], running: false });
  await request;
  assert.equal(state.live.value, "new answer");
  assert.equal(state.thinking.value, "new reasoning");
  assert.equal(state.running.value, true);
});
