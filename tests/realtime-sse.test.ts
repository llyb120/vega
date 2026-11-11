import { test } from "node:test";
import assert from "node:assert/strict";
import { SseChannel, wire, type Sink } from "../server/core/sse";

/** A lane sink that keeps every SSE frame and its backlog under the test's control. */
function lane() {
  const frames: any[] = [], raw: string[] = [], state: { ended: number; buffered: number; close?: () => void } = { ended: 0, buffered: 0 };
  const sink: Sink = {
    write(chunk) {
      raw.push(chunk);
      for (const block of chunk.split("\n\n")) {
        if (!block.startsWith("data: ")) continue;
        frames.push(JSON.parse(block.slice("data: ".length)));
      }
      return true;
    },
    end() { state.ended++; },
    buffered: () => state.buffered,
    onclose(fn) { state.close = fn; },
  };
  return { sink, frames, raw, state };
}
const request = { url: "http://local/api/events", headers: new Headers() };

test("one channel: control keeps its order on lane 0, bulk payloads spread over the data lanes", () => {
  const channel = new SseChannel({ lanes: 3 }),
    control = lane(),
    data = lane();
  channel.attach(0, control.sink);
  channel.requested.add(1);
  channel.attach(1, data.sink);
  channel.control({ type: "ready" });
  channel.data({ type: "frame", n: 1 });
  channel.control({ type: "mode" });
  channel.data({ type: "frame", n: 2 });
  assert.deepEqual(control.frames.map((v) => v.type), ["ready", "mode"], "control never leaves lane 0");
  assert.deepEqual(data.frames.map((v) => v.n), [1, 2]);
  // Without any data lane the payload still goes out, just on lane 0: a picture must not wait for expansion.
  const plain = new SseChannel(),
    only = lane();
  plain.attach(0, only.sink);
  plain.data({ type: "frame", n: 3 });
  assert.deepEqual(only.frames, [{ type: "frame", n: 3 }]);
});

test("without a data lane a full lane 0 asks for the first one, and that lane takes traffic at once", () => {
  const channel = new SseChannel({ lanes: 3 }),
    control = lane();
  channel.attach(0, control.sink);
  channel.data({ type: "frame", n: 1 });
  assert.deepEqual(control.frames, [{ type: "frame", n: 1 }], "a small payload never expands");
  // A blocked lane 0 is exactly the case the extra lanes exist for: ask for one instead of growing memory.
  control.state.buffered = 512 * 1024;
  channel.data({ type: "frame", n: 2 });
  assert.equal((control.frames as any[]).filter((v) => v.type === "lane" && v.open === 1).length, 1, "the first data lane is requested");
  assert.deepEqual(control.frames.at(-1), { type: "frame", n: 2 }, "the blocked payload still goes out meanwhile");
  channel.data({ type: "frame", n: 3 });
  assert.equal((control.frames as any[]).filter((v) => v.type === "lane" && v.open === 1).length, 1, "one request per round trip");
  const data = lane();
  channel.attach(1, data.sink);
  channel.data({ type: "frame", n: 4 });
  assert.deepEqual(data.frames, [{ type: "frame", n: 4 }], "the new lane takes traffic straight away");
});

test("the same key sticks to one lane, so one conversation's deltas never overtake each other", () => {
  const channel = new SseChannel({ lanes: 4 }),
    lanes = [lane(), lane(), lane(), lane()];
  channel.attach(0, lanes[0].sink);
  for (const index of [1, 2, 3]) {
    channel.requested.add(index);
    channel.attach(index, lanes[index].sink);
  }
  for (let i = 0; i < 20; i++) channel.data({ type: "text_delta", i }, "session-s1");
  const carrying = lanes.filter((page) => page.frames.length);
  assert.equal(carrying.length, 1, "a sticky key never splits across lanes");
  assert.deepEqual(carrying[0].frames.map((v) => v.i), Array.from({ length: 20 }, (_, i) => i));
  // Different keys spread, so one busy session cannot stall another.
  for (const key of ["a", "b", "c", "d", "e", "f"]) channel.data({ type: "frame", key }, key);
  assert(lanes.filter((page) => page.frames.length).length > 1, "independent keys use more than one lane");
});

test("a backed-up data lane asks the peer for one more lane, once, and only that lane may attach", () => {
  const channel = new SseChannel({ lanes: 3 }),
    control = lane(),
    data = lane();
  channel.attach(0, control.sink);
  channel.requested.add(1);
  channel.attach(1, data.sink);
  data.state.buffered = 4 << 20;
  channel.data({ type: "frame", n: 1 });
  channel.data({ type: "frame", n: 2 });
  const openings = control.frames.filter((v) => v.type === "lane" && v.open === 2);
  assert.equal(openings.length, 1, "exactly one expansion request per round trip");
  assert.equal(data.frames.length, 2, "the payload is still delivered while the extra lane is missing");
  assert.throws(() => channel.attach(5, lane().sink), /not requested/, "a lane nobody asked for is refused");
  const extra = lane();
  channel.attach(2, extra.sink);
  channel.data({ type: "frame", n: 3 });
  assert.equal(extra.frames.length + data.frames.length, 3, "the new lane takes traffic straight away");
  assert.throws(() => channel.attach(2, lane().sink), /already attached/);
});

test("closing ends every lane with one final closed event and tells the owner when lane 0 goes away", () => {
  const gone: string[] = [],
    channel = new SseChannel({ lanes: 2, ongone: () => gone.push("gone") }),
    control = lane(),
    data = lane();
  channel.attach(0, control.sink);
  channel.requested.add(1);
  channel.attach(1, data.sink);
  channel.close(4401, "登录已失效");
  assert.deepEqual(control.frames.at(-1), { type: "closed", code: 4401, reason: "登录已失效" });
  assert.deepEqual(data.frames.at(-1), { type: "closed", code: 4401, reason: "登录已失效" });
  assert.equal(control.state.ended, 1);
  assert.equal(data.state.ended, 1);
  assert.deepEqual(gone, ["gone"]);
  assert.equal(channel.open, false);
  // The peer dropped lane 0: the owner is told so it can forget the channel.
  const second = new SseChannel({ ongone: () => gone.push("dropped") }),
    only = lane();
  second.attach(0, only.sink);
  only.state.close?.();
  assert.deepEqual(gone, ["gone", "dropped"]);
  assert.equal(second.open, false);
});

test("an idle extra lane is closed again, and the channel reports its whole backlog", () => {
  const channel = new SseChannel({ lanes: 3 }),
    control = lane(),
    first = lane(),
    second = lane();
  channel.attach(0, control.sink);
  channel.requested.add(1);
  channel.attach(1, first.sink);
  channel.requested.add(2);
  channel.attach(2, second.sink);
  first.state.buffered = 4 << 20;
  second.state.buffered = 4 << 20;
  assert.equal(channel.buffered, 8 << 20, "the backlog is the sum of every lane");
  first.state.buffered = second.state.buffered = 0;
  (channel as any).prune();
  assert.equal(control.frames.filter((v) => v.type === "lane" && v.close).length, 1, "one idle lane is released");
  assert.equal(channel.lanes.size, 2, "lane 0 and the busiest extra lane stay");
  // A wire reads the same backlog, so the events hub can shed token streams for a slow peer.
  const only = new SseChannel(),
    page = lane();
  only.attach(0, page.sink);
  page.state.buffered = 2 << 20;
  assert.equal(wire(only, request).buffered, 2 << 20);
});
