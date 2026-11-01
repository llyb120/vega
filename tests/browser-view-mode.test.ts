import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function preview() {
  const source = readFileSync("web/src/BrowserView.vue", "utf8");
  const sent: any[] = [];
  let clock = 10000;
  const state: any = {
    zoom: { value: 1 }, panX: { value: 0 }, panY: { value: 0 }, operating: { value: false }, liveState: { value: "view" },
    busy: { value: false }, inputBusy: { value: false }, imageReady: { value: true }, screenshot: { value: { image: { width: 900, height: 600 } } },
    shownFrame: { frameId: "frame", image: { width: 900, height: 600 } }, gesture: null, touchGesture: null, lastTouchAt: 0, suppressClick: false, DRAG_PX: 6,
    Date: { now: () => clock }, text: { value: "" },
    socket: { readyState: 1, bufferedAmount: 0, send: (raw: string) => sent.push(JSON.parse(raw)) }, WebSocket: { OPEN: 1 },
    outbox: [], inflight: 0, sequence: 0, error: { value: "" }, resetInput: () => { state.outbox = []; state.gesture = null; state.touchGesture = null; state.suppressClick = false; },
  };
  state.remote = { get value() { return state.operating.value && state.liveState.value === "control"; } };
  const functions = source.slice(source.indexOf("function resetView()"), source.indexOf("function loadedImage()")) +
    source.slice(source.indexOf("function control("), source.indexOf("function failedImage()"));
  const handlers = vm.runInNewContext(functions + "\n({resetView,zoomView,requestControl,releaseControl,control,clickImage,contextImage,pointerDown,pointerMove,pointerUp,pointerCancel,touchStart,touchMove,touchEnd,touchCancel,wheelImage,imageKey,sendText})", state);
  const image = { getBoundingClientRect: () => ({ left: 100 + state.panX.value, top: 50 + state.panY.value, width: 300 * state.zoom.value, height: 200 * state.zoom.value }) };
  const target = { querySelector: () => image, setPointerCapture: () => {} };
  const event = { currentTarget: target, clientX: 250, clientY: 150, preventDefault() {}, pointerId: 1, pointerType: "mouse", button: 0, detail: 1 };
  return { state, sent, handlers, event, source, advance: (ms: number) => { clock += ms; } };
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
  assert.equal(state.outbox.length, 2, "pending moves must collapse without dropping the release");
  assert.equal(state.error.value, "");
  while (state.outbox.length) {
    state.inflight = 0;
    const next = state.outbox.shift();
    handlers.control(next.action, next.frameId);
  }
  assert.deepEqual(sent.map(m => m.action.phase), ["down", "move", "up"]);
  assert(sent.every(m => m.frameId === "frame"), "the entire gesture uses the frame seen when it started");
  assert.equal(sent[1].action.x, 569, "only the latest unsent position is kept");
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

test("only the explicit button starts control, resets the viewport and exit blocks further remote input", () => {
  const { state, handlers, event, sent, source } = preview();
  state.zoom.value = 2; state.panX.value = 40;
  handlers.requestControl();
  assert.equal(state.operating.value, true);
  assert.equal(state.liveState.value, "waiting");
  assert.equal(state.zoom.value, 1);
  assert.equal(state.panX.value, 0);
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: "mode", mode: "control" }]));
  handlers.clickImage(event);
  assert.equal(sent.length, 1, "waiting does not queue an accidental click");
  state.liveState.value = "control";
  handlers.clickImage(event);
  assert.equal(sent[1].type, "input");
  assert.equal(sent[1].action.action, "click_at");
  assert.equal(sent[1].action.x, 450);
  assert.equal(sent[1].action.y, 300);
  handlers.releaseControl();
  assert.equal(state.remote.value, false);
  assert.equal(state.outbox.length, 0);
  handlers.clickImage(event);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2], { type: "mode", mode: "view" });
  assert.match(source, /operating \? '退出操作' : '开始操作'/);
  assert.doesNotMatch(source, /点击画面即可开始操作/);
});
