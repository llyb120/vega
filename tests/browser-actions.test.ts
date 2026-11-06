import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAction } from "../server/core/browser-actions";

test("pointer.up may omit coordinates to release at the held point", () => {
  assert.deepEqual(normalizeAction({ action: "pointer", phase: "up" }), { action: "pointer", phase: "up" });
  assert.deepEqual(
    normalizeAction({ action: "pointer", phase: "up", x: 10, y: 20 }),
    { action: "pointer", phase: "up", x: 10, y: 20 },
  );
  assert.throws(() => normalizeAction({ action: "pointer", phase: "down" }), /Invalid coordinates/);
  assert.throws(() => normalizeAction({ action: "pointer", phase: "move", x: 1 }), /Invalid coordinates/);
});
