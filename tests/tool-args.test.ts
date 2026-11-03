import test from "node:test";
import assert from "node:assert/strict";
import { stripPlaceholderArgs } from "../server/core/tool-args";
import { requestedTime } from "../server/core/employee";
import { boundSceneModel } from "../server/core/engine";
import employeeDefinition from "../shared/employee-tool.json";

const schema = employeeDefinition.inputSchema as any;

test("schema-filled employee defaults are treated as absent", () => {
  const filled = { action: "defer", text: "稍后再看", scene: "computer", kind: "duty", key: "", id: "", name: "", condition: "", content: "", share: false, plan: [], note: "", profile: "", enabled: true, manual: false, times: [], everyMinutes: 0, nextAt: "", nextCheckInMinutes: 0, events: [], done: false, claim: "", ids: [], keepId: "", pinned: false, query: "" };
  assert.deepEqual(stripPlaceholderArgs("employee", filled, schema), { action: "defer", text: "稍后再看" });
});

test("task self-reschedule survives a schema fill", () => {
  const out = stripPlaceholderArgs("employee", { action: "update", id: "t1", text: "", note: "", profile: "", enabled: true, manual: false, times: [], everyMinutes: 0, nextAt: "", nextCheckInMinutes: 30, events: [], condition: "" }, schema);
  assert.deepEqual(out, { action: "update", id: "t1", nextCheckInMinutes: 30 });
});

test("hand-written update keeps deliberate clears", () => {
  const out = stripPlaceholderArgs("employee", { action: "update", id: "d1", note: "", times: [], everyMinutes: 0 }, schema);
  assert.deepEqual(out, { action: "update", id: "d1", note: "", times: [], everyMinutes: 0 });
});

test("deliberate non-default booleans and complete deliverableRef [] are kept", () => {
  assert.deepEqual(stripPlaceholderArgs("employee", { action: "update", id: "d1", enabled: false }, schema), { action: "update", id: "d1", enabled: false });
  assert.deepEqual(stripPlaceholderArgs("employee", { action: "complete", summary: "ok", deliverableRef: [] }, schema), { action: "complete", summary: "ok", deliverableRef: [] });
});

test("generic tools drop placeholders only when the schema was filled", () => {
  const s = { properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} }, required: ["a"] };
  assert.deepEqual(stripPlaceholderArgs("x", { a: "", b: "", c: [], d: { x: 0, y: 0 }, e: "keep" }, s), { a: "", e: "keep" });
  assert.deepEqual(stripPlaceholderArgs("x", { a: "1", b: "" }, s), { a: "1", b: "" });
});

test("nextAt just passed means as soon as possible; older times explain how to run now", () => {
  const now = Date.parse("2026-11-03T02:05:30Z"); // 10:05 Beijing
  assert.ok(requestedTime({ nextAt: "2026-11-03 10:05" }, now) > now);
  assert.ok(requestedTime({ nextAt: "2026-11-03 10:00" }, now) > now);
  assert.throws(() => requestedTime({ nextAt: "2026-11-03 09:30" }, now), /omit nextAt/);
});

test("task sessions follow the scene's current primary model", () => {
  const config: any = { scenes: { lightweight: ["p/new", "p/old"], coding: ["p/code"] } };
  assert.equal(boundSceneModel(config, { model: "p/old", scene: "lightweight", employeeId: "e", taskId: "t" }), "p/new");
  assert.equal(boundSceneModel(config, { model: "p/old", scene: "lightweight" }), "p/old");
  assert.equal(boundSceneModel(config, { model: "p/gone", scene: "coding" }), "p/code");
});
