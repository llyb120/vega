import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function preview() {
  const source = readFileSync("web/src/BrowserView.vue", "utf8");
  const sent: any[] = [];
  let clock = 10000, timerId = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const state: any = {
    zoom: { value: 1 }, panX: { value: 0 }, panY: { value: 0 }, operating: { value: false }, liveState: { value: "view" },
    busy: { value: false }, inputBusy: { value: false }, imageReady: { value: true }, screenshot: { value: { image: { width: 900, height: 600 } } },
    shownFrame: { frameId: "frame", inputSeq: 0, image: { width: 900, height: 600 } }, gesture: null, touchGesture: null, lastTouchAt: 0, suppressClick: false, DRAG_PX: 6,
    Date: { now: () => clock }, text: { value: "" },
    setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    socket: { readyState: 1, bufferedAmount: 0, send: (raw: string) => sent.push(JSON.parse(raw)) }, WebSocket: { OPEN: 1 },
    outbox: [], inflight: 0, sequence: 0, error: { value: "" }, info: { value: "" }, remoteDrag: null, afterInput: 0,
  };
  state.remote = { get value() { return state.operating.value && state.liveState.value === "control"; } };
  const functions = source.slice(source.indexOf("function resetInput()"), source.indexOf("function disconnect()")) +
    source.slice(source.indexOf("function resetView()"), source.indexOf("function loadedImage()")) +
    source.slice(source.indexOf("function flushInput()"), source.indexOf("function failedImage"));
  const handlers = vm.runInNewContext(functions + "\n({resetInput,resetView,zoomView,requestControl,releaseControl,control,flushInput,inputResult,clickImage,contextImage,pointerDown,pointerMove,pointerUp,pointerCancel,touchStart,touchMove,touchEnd,touchCancel,wheelImage,imageKey,sendText})", state);
  const image = { getBoundingClientRect: () => ({ left: 100 + state.panX.value, top: 50 + state.panY.value, width: 300 * state.zoom.value, height: 200 * state.zoom.value }) };
  const target = { querySelector: () => image, setPointerCapture: () => {} };
  const event = { currentTarget: target, clientX: 250, clientY: 150, preventDefault() {}, pointerId: 1, pointerType: "mouse", button: 0, detail: 1 };
  return { state, sent, handlers, event, source, advance: (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].fn();
    }
    clock = until;
  } };
}

test("preview zoom stays anchored at the pointer, is bounded and resets its position", () => {
  const { state, handlers, event } = preview();
  handlers.zoomView(event, 2);
  assert.equal(state.zoom.value, 2);
  assert.equal(state.panX.value, -150);
  assert.equal(state.panY.value, -100);
  assert.equal((event.clientX - (100 + state.panX.value)) / state.zoom.value, 150);
  handlers.zoomView(event, 100);
  assert.equal(state.zoom.value, 4);
  handlers.zoomView(event, 0.0001);
  assert.equal(state.zoom.value, 0.1);
  handlers.resetView();
  assert.equal(state.zoom.value, 1);
  assert.equal(state.panX.value, 0);
  assert.equal(state.panY.value, 0);
});

test("view mode clicks, keys, wheel zoom and pointer pans never claim control or send webpage input", () => {
  const { state, handlers, event, sent } = preview();
  handlers.clickImage(event);
  handlers.imageKey({ ...event, key: "Enter" });
  handlers.wheelImage({ ...event, deltaY: -120, deltaX: 0, deltaMode: 0 });
  assert(state.zoom.value > 1);
  const oldX = state.panX.value, oldY = state.panY.value;
  handlers.pointerDown(event);
  handlers.pointerMove({ ...event, clientX: 280, clientY: 170 });
  handlers.pointerUp({ ...event, clientX: 280, clientY: 170 });
  assert(Math.abs(state.panX.value - (oldX + 30)) < 1e-8);
  assert(Math.abs(state.panY.value - (oldY + 20)) < 1e-8);
  handlers.clickImage(event);
  assert.deepEqual(sent, []);
  assert.equal(state.operating.value, false);
});

for (const finish of ["pointerUp", "pointerCancel"]) test(`remote drag coalesces rapid moves across repaints and preserves its release on ${finish}`, () => {
  const { state, handlers, event, sent } = preview();
  state.operating.value = true; state.liveState.value = "control";
  handlers.pointerDown(event);
  for (let i = 0; i < 200; i++) {
    state.shownFrame = { ...state.shownFrame, frameId: "repaint-" + i };
    handlers.pointerMove({ ...event, clientX: 270 + i / 10, clientY: 170 });
  }
  handlers[finish]({ ...event, clientX: 290, clientY: 170 });
  handlers.clickImage(event);
  assert.equal(sent.length, 1, "only the press is sent while awaiting its result");
  assert.equal(state.remoteDrag.pending.phase, "up", "release replaces unsent old moves");
  assert.equal(state.outbox.length, 0);
  assert.equal(state.error.value, "");
  handlers.inputResult({ type: "input_result", seq: sent[0].seq, status: "executed" });
  assert.deepEqual(sent.map(m => m.action.phase), ["down", "up"]);
  assert(sent.every(m => m.frameId === "frame"), "the entire gesture uses the frame seen when it started");
  assert.equal(sent[1].action.x, finish === "pointerUp" ? 570 : 569, "release carries the final position instead of waiting for another movement round trip");
});

test("weak-network drag streams a bounded latest-position window and prioritizes release without another RTT", () => {
  const { state, handlers, event, sent, advance } = preview();
  state.operating.value = true; state.liveState.value = "control";
  handlers.pointerDown(event);
  handlers.pointerMove({ ...event, clientX: 270 });
  handlers.inputResult({ type: "input_result", seq: 1, status: "executed" });
  for (let i = 0; i < 100; i++) {
    handlers.pointerMove({ ...event, clientX: 270 + i });
    advance(40);
  }
  assert.equal(sent.length, 5, "only four movement samples may be unconfirmed");
  assert.equal(state.remoteDrag.sent.length, 4);
  assert.equal(state.outbox.length, 0);
  const lastAck = sent.at(-1);
  handlers.inputResult({ type: "pointer_result", seq: lastAck.seq, dragSeq: 1, status: "executed" });
  advance(40);
  assert.equal(sent.length, 6);
  assert.equal(sent.at(-1).action.x, 807, "after a delayed ACK, send the latest position, not 96 stale moves");
  handlers.pointerUp({ ...event, clientX: 380 });
  assert.equal(sent.length, 7, "release goes out immediately, before the final move is acknowledged");
  assert.equal(sent.at(-1).action.phase, "up");
  assert.equal(sent.at(-1).action.x, 840);
  assert.equal(sent.at(-1).dragSeq, 1);
  advance(5000);
  assert.equal(sent.length, 7, "no retry or delayed movement after release");
});

for (const touch of [false, true]) test(`second ${touch ? "touch" : "mouse"} drag starts only after the first release and its resulting frame, with fresh gesture identity`, () => {
  const { state, handlers, event, sent, advance } = preview();
  state.operating.value = true; state.liveState.value = "control";
  const start = () => {
    if (touch) { handlers.touchStart({ ...event, touches: [{ clientX: 250, clientY: 150 }] }); advance(600); handlers.touchMove({ ...event, touches: [{ clientX: 280, clientY: 150 }] }); }
    else { handlers.pointerDown(event); handlers.pointerMove({ ...event, clientX: 280 }); }
  };
  const finish = () => touch ? handlers.touchEnd({ ...event, touches: [], changedTouches: [{ clientX: 290, clientY: 150 }] }) : handlers.pointerUp({ ...event, clientX: 290 });
  start(); finish();
  handlers.inputResult({ type: "input_result", seq: 1, status: "executed" });
  const release = sent.at(-1);
  start(); finish();
  assert.equal(sent.length, 2, "do not queue a second gesture while the first release is outstanding");
  handlers.inputResult({ type: "pointer_result", seq: release.seq, dragSeq: 1, status: "executed" });
  start(); finish();
  assert.equal(sent.length, 2, "a release ACK alone cannot authorize the old pre-drag picture");
  assert.equal(state.inputBusy.value, true);
  state.screenshot.value.editable = true;
  state.text.value = "keep unsent text";
  handlers.sendText();
  assert.equal(state.text.value, "keep unsent text", "waiting for the post-release frame must not erase auxiliary drafts");
  state.shownFrame = { ...state.shownFrame, frameId: "after-release", inputSeq: release.seq };
  handlers.flushInput();
  assert.equal(state.inputBusy.value, false);
  start(); finish();
  assert.equal(sent[2].action.phase, "down");
  assert.equal(sent[2].frameId, "after-release");
  assert.notEqual(sent[2].seq, 1);
  handlers.inputResult({ type: "input_result", seq: sent[2].seq, status: "executed" });
  assert.equal(sent[3].action.phase, "up");
  assert.equal(sent[3].dragSeq, sent[2].seq);
  assert.equal(state.error.value, "");
});

test("stale-frame rejection stays soft: notice only, keeps control, and requests a full frame resend", () => {
  const { state, handlers, event, sent } = preview();
  state.operating.value = true; state.liveState.value = "control";
  handlers.pointerDown(event);
  handlers.pointerMove({ ...event, clientX: 280, clientY: 170 });
  assert.equal(sent.length, 1, "press is in flight before the soft rejection");
  handlers.inputResult({ type: "input_result", seq: 1, status: "not_executed", reason: "画面已过期，请等待实时画面更新" });
  assert.equal(state.error.value, "", "stale frames must not sticky-block with a hard error banner");
  assert.match(state.info.value, /画面已过期/);
  assert.equal(state.operating.value, true, "keep remote control so the user can retry after a fresh frame");
  assert.equal(state.remoteDrag, null);
  assert.equal(state.inputBusy.value, false);
  assert(sent.some((m) => m.type === "frame_ack" && m.resend === true), "ask the server for a full next frame");
  handlers.control({ action: "press", key: "Enter" });
  handlers.inputResult({ type: "input_result", seq: 2, status: "not_executed", reason: "网页或视口已变化，请等待实时画面更新" });
  assert.equal(state.error.value, "");
  assert.match(state.info.value, /视口已变化/);
  assert.equal(state.operating.value, true);
});

test("failed streamed input drops pending samples, releases control and never replays after a late acknowledgement", () => {
  const { state, handlers, event, sent, advance } = preview();
  state.operating.value = true; state.liveState.value = "control";
  handlers.pointerDown(event); handlers.pointerMove({ ...event, clientX: 280 });
  handlers.inputResult({ type: "input_result", seq: 1, status: "executed" });
  advance(40);
  handlers.pointerMove({ ...event, clientX: 290 });
  handlers.inputResult({ type: "pointer_result", seq: 2, dragSeq: 1, status: "needs_review", reason: "delivery uncertain" });
  const count = sent.length;
  advance(1000);
  handlers.inputResult({ type: "pointer_result", seq: 2, dragSeq: 1, status: "executed" });
  assert.equal(sent.length, count);
  assert.equal(state.remoteDrag, null);
  assert.equal(state.remote.value, false);
  assert.equal(sent.at(-1).mode, "view");
  assert.match(state.error.value, /结果不确定/);
});

test("touch pinches and one-finger pans change only the preview and continue smoothly after a finger lifts", () => {
  const { state, handlers, event, sent } = preview();
  const touches = (points: number[][]) => ({ currentTarget: event.currentTarget, touches: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  handlers.touchStart(touches([[200, 150], [300, 150]]));
  handlers.touchMove(touches([[150, 160], [350, 160]]));
  assert.equal(state.zoom.value, 2);
  assert.equal(state.panX.value, -150);
  assert.equal(state.panY.value, -90);
  handlers.touchEnd(touches([[150, 160]]));
  handlers.touchMove(touches([[180, 180]]));
  assert.equal(state.zoom.value, 2);
  assert.equal(state.panX.value, -120);
  assert.equal(state.panY.value, -70);
  handlers.touchEnd(touches([]));
  assert.deepEqual(sent, []);
  assert.equal(state.operating.value, false);
  assert.equal(state.touchGesture, null);
});

test("touch taps operate once but long presses, multi-touch, cancellation and synthetic context menus never click", () => {
  const { state, handlers, event, sent, advance } = preview();
  state.operating.value = true; state.liveState.value = "control";
  const touch = { currentTarget: event.currentTarget, touches: [{ clientX: 250, clientY: 150 }] };
  handlers.touchStart(touch);
  advance(600);
  handlers.contextImage({ ...event, pointerType: "", sourceCapabilities: { firesTouchEvents: true } });
  handlers.touchEnd({ ...touch, touches: [] });
  handlers.clickImage(event);
  assert.equal(sent.length, 0, "long press must not become either a right click or a delayed tap");
  handlers.touchStart(touch);
  handlers.touchCancel();
  handlers.touchEnd({ ...touch, touches: [] });
  assert.equal(sent.length, 0);
  handlers.touchStart(touch);
  handlers.touchStart({ ...touch, touches: [...touch.touches, { clientX: 300, clientY: 150 }] });
  handlers.touchEnd({ ...touch, touches: [] });
  assert.equal(sent.length, 0, "pinching in operation mode must not zoom or send an input");
  assert.equal(state.zoom.value, 1);
  handlers.touchStart(touch);
  state.shownFrame = { ...state.shownFrame, frameId: "later-frame" };
  advance(40);
  handlers.touchEnd({ ...touch, touches: [] });
  handlers.clickImage(event);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action.action, "click_at");
  assert.equal(sent[0].action.x, 450);
  assert.equal(sent[0].action.y, 300);
  assert.equal(sent[0].frameId, "frame", "a repaint must not relabel an old touch as a fresh observation");
});

for (const finish of ["touchEnd", "touchCancel", "secondFinger"]) test(`touch hold then drag uses scaled mouse coordinates, a pinned frame and one release on ${finish}`, () => {
  const { state, handlers, event, sent, advance } = preview();
  state.operating.value = true; state.liveState.value = "control";
  state.zoom.value = 2; state.panX.value = 40; state.panY.value = -20;
  const touch = (x: number, y: number) => ({ clientX: x, clientY: y });
  const touches = (points: any[]) => ({ currentTarget: event.currentTarget, touches: points });
  handlers.touchStart(touches([touch(250, 150)]));
  advance(600);
  for (let i = 0; i < 200; i++) {
    state.shownFrame = { ...state.shownFrame, frameId: "repaint-" + i };
    handlers.touchMove(touches([touch(270 + i / 10, 170)]));
  }
  assert.equal(sent.length, 1, "press goes first; moves wait for confirmation");
  assert.equal(state.remoteDrag.pending.x, 224, "unsent moves keep only the latest position");
  if (finish === "secondFinger") {
    handlers.touchStart(touches([touch(290, 170), touch(300, 180)]));
    handlers.touchEnd(touches([touch(290, 170)]));
    advance(600);
    handlers.touchMove(touches([touch(320, 190)]));
    handlers.touchEnd(touches([]));
  } else handlers[finish]({ ...touches([]), changedTouches: [touch(300, 190)] });
  handlers.touchEnd(touches([]));
  handlers.clickImage(event);
  handlers.inputResult({ type: "input_result", seq: sent[0].seq, status: "executed" });
  assert.deepEqual(sent.map((m) => m.action.phase), ["down", "up"]);
  assert(sent.every((m) => m.frameId === "frame"), "repaint must not relabel a touch gesture");
  assert.equal(sent[0].action.x, 165);
  assert.equal(sent[0].action.y, 180);
  assert.equal(sent[1].action.x, finish === "touchEnd" ? 240 : 224);
  assert.equal(state.zoom.value, 2, "remote drag must not pan or zoom the preview");
  assert.equal(state.panX.value, 40);
  assert.equal(state.panY.value, -20);
});

test("quick touch swipes, waiting touches and cancelled holds never become remote drags or taps", () => {
  const { state, handlers, event, sent, advance } = preview();
  state.operating.value = true; state.liveState.value = "control";
  const touch = { currentTarget: event.currentTarget, touches: [{ clientX: 250, clientY: 150 }] };
  handlers.touchStart(touch);
  advance(100);
  handlers.touchMove({ ...touch, touches: [{ clientX: 270, clientY: 150 }] });
  advance(600);
  handlers.touchMove({ ...touch, touches: [{ clientX: 290, clientY: 150 }] });
  handlers.touchEnd({ ...touch, touches: [] });
  state.liveState.value = "waiting";
  handlers.touchStart(touch);
  state.liveState.value = "control";
  advance(600);
  handlers.touchMove({ ...touch, touches: [{ clientX: 290, clientY: 150 }] });
  handlers.touchEnd({ ...touch, touches: [] });
  handlers.touchStart(touch);
  advance(600);
  handlers.touchCancel();
  handlers.touchMove({ ...touch, touches: [{ clientX: 290, clientY: 150 }] });
  handlers.touchEnd({ ...touch, touches: [] });
  assert.deepEqual(sent, []);
});

test("auxiliary text waits for an editable remote target and never adds Enter or replays a draft", () => {
  const { state, handlers, sent, source } = preview();
  state.text.value = "中文输入与粘贴";
  handlers.sendText();
  assert.equal(state.text.value, "中文输入与粘贴");
  state.operating.value = true; state.liveState.value = "control";
  handlers.sendText();
  assert.equal(sent.length, 0, "no editable webpage target selected");
  state.screenshot.value.editable = true;
  handlers.sendText();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action.text, "中文输入与粘贴");
  assert.equal(sent[0].action.action, "type");
  assert.equal(state.text.value, "");
  handlers.sendText();
  assert.equal(sent.length, 1);
  assert(source.indexOf('class="remote-text"') < source.indexOf('<details class="remote-input">'), "mobile keyboard input must be visible without opening advanced controls");
  assert.match(source, /@touchstart\.prevent="touchStart"/);
  assert.match(source, /pointer-events: none/);
  assert.match(source, /touch-action: none/);
});

test("only the explicit button starts control, preserves the viewport and exit blocks further remote input", () => {
  const { state, handlers, event, sent, source } = preview();
  state.zoom.value = 2; state.panX.value = 40; state.panY.value = -20;
  handlers.requestControl();
  assert.equal(state.operating.value, true);
  assert.equal(state.liveState.value, "waiting");
  assert.equal(state.zoom.value, 2);
  assert.equal(state.panX.value, 40);
  assert.equal(state.panY.value, -20);
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: "mode", mode: "control" }]));
  handlers.clickImage(event);
  assert.equal(sent.length, 1, "waiting does not queue an accidental click");
  state.liveState.value = "control";
  handlers.clickImage(event);
  assert.equal(sent[1].type, "input");
  assert.equal(sent[1].action.action, "click_at");
  assert.equal(sent[1].action.x, 165);
  assert.equal(sent[1].action.y, 180);
  handlers.releaseControl();
  assert.equal(state.remote.value, false);
  assert.equal(state.zoom.value, 2);
  assert.equal(state.panX.value, 40);
  assert.equal(state.panY.value, -20);
  assert.equal(state.outbox.length, 0);
  handlers.clickImage(event);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2], { type: "mode", mode: "view" });
  assert.match(source, /operating \? '退出操作' : '开始操作'/);
  assert.doesNotMatch(source, /点击画面即可开始操作/);
});
