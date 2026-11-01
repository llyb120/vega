import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function preview() {
  const source = readFileSync("web/src/BrowserView.vue", "utf8");
  const sent: any[] = [];
  const state: any = {
    zoom: { value: 1 }, panX: { value: 0 }, panY: { value: 0 }, operating: { value: false }, liveState: { value: "view" },
    busy: { value: false }, inputBusy: { value: false }, imageReady: { value: true }, screenshot: { value: { image: { width: 900, height: 600 } } },
    shownFrame: { frameId: "frame", image: { width: 900, height: 600 } }, gesture: null, suppressClick: false, DRAG_PX: 6,
    socket: { readyState: 1, bufferedAmount: 0, send: (raw: string) => sent.push(JSON.parse(raw)) }, WebSocket: { OPEN: 1 },
    outbox: [], inflight: 0, sequence: 0, error: { value: "" }, resetInput: () => { state.outbox = []; state.gesture = null; state.suppressClick = false; },
  };
  state.remote = { get value() { return state.operating.value && state.liveState.value === "control"; } };
  const functions = source.slice(source.indexOf("function resetView()"), source.indexOf("function loadedImage()")) +
    source.slice(source.indexOf("function control("), source.indexOf("function sendText()"));
  const handlers = vm.runInNewContext(functions + "\n({resetView,zoomView,requestControl,releaseControl,clickImage,pointerDown,pointerMove,pointerUp,pointerCancel,wheelImage,imageKey})", state);
  const target = { getBoundingClientRect: () => ({ left: 100 + state.panX.value, top: 50 + state.panY.value, width: 300 * state.zoom.value, height: 200 * state.zoom.value }), setPointerCapture: () => {} };
  const event = { currentTarget: target, clientX: 250, clientY: 150, preventDefault() {}, pointerId: 1, pointerType: "mouse", button: 0, detail: 1 };
  return { state, sent, handlers, event, source };
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
