import test from "node:test";
import assert from "node:assert/strict";
import { omitPlaceholders, omittable } from "../server/core/tool-args";
import { requestedTime } from "../server/core/employee";
import { boundSceneModel } from "../server/core/engine";

test("generic tools only omit values their own lower bound rejects", () => {
  const read = { properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"] };
  assert.deepEqual(omitPlaceholders({ path: "a.ts", offset: 0, limit: null, _after: ["x"] }, read), { path: "a.ts" });
  assert.deepEqual(omitPlaceholders({ path: "a.ts", offset: 5, limit: 10 }, read), { path: "a.ts", offset: 5, limit: 10 });
  const loose = { properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "array" }, n: { type: "integer", minimum: 0 } }, required: ["a"] };
  assert.deepEqual(omitPlaceholders({ a: "", b: "", c: [], n: 0 }, loose), { a: "", b: "", c: [], n: 0 }, "legal empty values are real values");
});

test("omittable follows the declared bound, never the value alone", () => {
  assert.equal(omittable({ minLength: 1 }, ""), true);
  assert.equal(omittable({}, ""), false);
  assert.equal(omittable({ minimum: 1 }, 0), true);
  assert.equal(omittable({ minimum: 0 }, 0), false);
  assert.equal(omittable({ minItems: 1 }, []), true);
  assert.equal(omittable({}, []), false);
  assert.equal(omittable({}, false), false);
  assert.equal(omittable({}, null), true);
});

test("a just-passed time means as soon as possible; older times explain how to run now", () => {
  const now = Date.parse("2026-11-03T02:05:30Z"); // 10:05 Beijing
  assert.ok(requestedTime({ nextAt: "2026-11-03 10:05" }, now) > now);
  assert.ok(requestedTime({ nextAt: "2026-11-03 10:00" }, now) > now);
  assert.throws(() => requestedTime({ nextAt: "2026-11-03 09:30" }, now), /省略时间参数/);
});

test("task sessions follow the scene's current primary model", () => {
  const config: any = { scenes: { lightweight: ["p/new", "p/old"], coding: ["p/code"] } };
  assert.equal(boundSceneModel(config, { model: "p/old", scene: "lightweight", employeeId: "e", taskId: "t" }), "p/new");
  assert.equal(boundSceneModel(config, { model: "p/old", scene: "lightweight" }), "p/old");
  assert.equal(boundSceneModel(config, { model: "p/gone", scene: "coding" }), "p/code");
});

test("Chrome actions are validated strictly: stray fields are rejected, not guessed away", async () => {
  const { normalizeAction } = await import("../server/core/browser-actions");
  assert.deepEqual(normalizeAction({ action: "click", ref: "e12" }), { action: "click", ref: "e12", frame: 0 });
  assert.deepEqual(normalizeAction({ action: "fill", ref: "e3", text: "" }), { action: "fill", ref: "e3", text: "", frame: 0 });
  assert.throws(() => normalizeAction({ action: "click", ref: "e1", x: 10, y: 20 }), /click: x, y/);
  assert.throws(() => normalizeAction({ action: "click", ref: "e1", text: "", ms: 0 }), /click: text, ms/);
});
