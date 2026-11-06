import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ref } from "vue";
import { useStreamingText } from "../web/src/streaming-text.js";
import { renderMarkdown } from "../web/src/markdown.js";

const source = readFileSync("web/src/App.vue", "utf8");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function mount() {
  const timers = new Map<number, () => void>(), frames = new Map<number, () => void>();
  let serial = 0;
  const pending: Array<{ name: string; resolve: () => void }> = [], calls: string[] = [];
  const slow = (name: string) => () => {
    calls.push(name);
    return new Promise<void>((resolve) => pending.push({ name, resolve }));
  };
  const context: any = {
    Promise, Date, confirm: () => true,
    document: { visibilityState: "visible" },
    setTimeout: (fn: any) => { timers.set(++serial, fn); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: any) => { frames.set(++serial, fn); return serial; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    view: ref("chat"), debugRevision: ref(0), employee: ref({ chatSession: "employee-chat" }), employeeEvent: ref(null),
    current: ref({ id: "s1" }), live: ref(""), thinking: ref(""), model: ref(""), activeTools: ref([]), error: ref(""),
    running: ref({}), contextBudget: ref(null), fireState: ref(null), draft: ref(""), attachments: ref([]),
    employeeSession: ref(""), employeeSessionVersion: ref(0), selectedEmployee: ref(""), activeTaskCount: ref(0), employeeError: ref(""),
    transcript: ref({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }),
    refreshCurrent: slow("refreshCurrent"), bootstrap: slow("bootstrap"), refreshEmployee: slow("refreshEmployee"),
    loadModels: async () => {}, selectSession: async () => {}, queueEmployeeRefresh() {}, toast() {}, api: async () => {}, unread: { onEvent() {} },
    scrollBottom: async () => { calls.push("scroll"); },
  };
  const start = source.indexOf("/** Runs fn at most once at a time;");
  const end = source.indexOf("let employeeLoadVersion = 0;");
  const { handleEvent } = vm.runInNewContext(source.slice(start, end) + "\n({handleEvent})", context);
  const runFrames = () => { const list = [...frames.values()]; frames.clear(); list.forEach((fn) => fn()); };
  const runTimers = () => { const list = [...timers.values()]; timers.clear(); list.forEach((fn) => fn()); };
  return { handleEvent, context, pending, calls, frames, timers, runFrames, runTimers };
}

test("streamed tokens are painted once per frame, not once per token", () => {
  const s = mount();
  for (let i = 0; i < 50; i++) s.handleEvent({ type: "text_delta", session: "s1", data: "x" });
  assert.equal(s.context.live.value, "", "nothing is painted before the frame");
  assert.equal(s.frames.size, 1, "one frame is scheduled for 50 tokens");
  s.runFrames();
  assert.equal(s.context.live.value, "x".repeat(50));
  assert.equal(s.calls.filter((c) => c === "scroll").length, 1, "one scroll per frame while near the bottom");
  s.context.transcript.value.scrollTop = 0; // the reader scrolled up
  s.handleEvent({ type: "text_delta", session: "s1", data: "y" });
  s.runFrames();
  assert.equal(s.calls.filter((c) => c === "scroll").length, 1, "a reader who scrolled up is not yanked down");
});

test("a hidden tab still paints buffered tokens via the timer", () => {
  const s = mount();
  s.context.document.visibilityState = "hidden";
  s.handleEvent({ type: "thinking_delta", session: "s1", data: "hmm" });
  assert.equal(s.frames.size, 0);
  s.runTimers();
  assert.equal(s.context.thinking.value, "hmm");
});

test("events are not held up by refreshes, and refreshes coalesce", async () => {
  const s = mount();
  s.handleEvent({ type: "message_end", session: "s1" });
  for (let i = 0; i < 5; i++) s.handleEvent({ type: "done", session: "s1" });
  s.handleEvent({ type: "message_start", session: "s1", data: { model: "m2" } });
  s.handleEvent({ type: "text_delta", session: "s1", data: "next" });
  s.runFrames();
  assert.equal(s.context.live.value, "next", "the next message streams while the refresh is still in flight");
  assert.equal(s.context.model.value, "m2");
  assert.equal(s.calls.filter((c) => c === "refreshCurrent").length, 1, "one refresh in flight");
  for (const p of s.pending.splice(0)) p.resolve();
  await tick(); await tick();
  assert.equal(s.calls.filter((c) => c === "refreshCurrent").length, 2, "later calls collapse into one trailing refresh");
  for (const p of s.pending.splice(0)) p.resolve();
  await tick(); await tick();
  assert.equal(s.context.live.value, "next", "a finished refresh does not wipe text from a message that started after it");
});


test("user and steer events refresh the selected session so another tab's message appears before the reply", async () => {
  const s = mount();
  s.handleEvent({ type: "user", session: "s1" });
  assert.equal(s.calls.filter((c) => c === "refreshCurrent").length, 1, "user triggers a history refresh");
  for (const p of s.pending.splice(0)) p.resolve();
  await tick(); await tick();
  s.handleEvent({ type: "steer", session: "s1" });
  assert.equal(s.calls.filter((c) => c === "refreshCurrent").length, 2, "steer also refreshes");
  s.handleEvent({ type: "user", session: "other" });
  assert.equal(s.calls.filter((c) => c === "refreshCurrent").length, 2, "other sessions do not refresh this transcript");
});

test("events for another session or the employee chat never touch the live transcript", () => {
  const s = mount();
  s.handleEvent({ type: "text_delta", session: "other", data: "x" });
  s.handleEvent({ type: "text_delta", session: "employee-chat", data: "y" });
  s.runFrames(); s.runTimers();
  assert.equal(s.context.live.value, "");
  assert.equal(s.context.employeeEvent.value.data, "y");
});

test("markdown re-renders at most every interval while streaming and catches up when it stops", async () => {
  const text = ref(""), streaming = ref(true);
  const shown = useStreamingText(() => text.value, () => streaming.value, 40);
  let renders = 0, last = shown.value, updates = 0;
  const started = Date.now();
  while (Date.now() - started < 400) {
    text.value += "token ";
    updates++;
    if (shown.value !== last) { renders++; last = shown.value; }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(updates > 50, String(updates));
  assert.ok(renders <= 12, `rendered ${renders} times for ${updates} tokens`);
  streaming.value = false;
  assert.equal(shown.value, text.value, "the final text is shown at once");
});

test("timing: markdown work for a 30k-char streamed answer, per token vs throttled", { timeout: 120000 }, () => {
  const tokens = Array.from({ length: 1500 }, (_, i) => (i % 40 === 39 ? "\n\n```js\nconst x = 1;\n```\n\n" : "word **bold** ")).slice(0, 1500);
  let text = "", perToken = 0;
  const t0 = performance.now();
  for (const token of tokens) { text += token; renderMarkdown(text); perToken++; }
  const before = performance.now() - t0;
  // 1500 tokens over ~30s of streaming at 120ms throttle is ~250 renders; frames also batch tokens.
  text = "";
  const every = Math.ceil(tokens.length / 250);
  const t1 = performance.now();
  tokens.forEach((token, i) => { text += token; if (i % every === every - 1) renderMarkdown(text); });
  renderMarkdown(text);
  const after = performance.now() - t1;
  console.log(`markdown for ${text.length} chars: per token ${perToken} renders ${before.toFixed(0)}ms; throttled ${after.toFixed(0)}ms`);
  assert.ok(after < before);
});
