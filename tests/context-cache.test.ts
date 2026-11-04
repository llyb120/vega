import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Message } from "../server/core/store";
import { Context } from "../server/core/context";

const summary =
  "Finished inspection: required files were read, relevant evidence and decisions recorded. No changes or external submissions are inferred.";
function turn(store: Store, id: string, n: number, size = 400) {
  store.append(id, { role: "user", text: "question " + n });
  store.append(id, { role: "assistant", calls: [{ id: "c" + n, name: "chrome_act", arguments: { action: "click", ref: "a." + n } }] });
  store.append(id, {
    role: "tool",
    callId: "c" + n,
    name: "chrome_act",
    text: JSON.stringify({ tabTag: "t1", pages: [{ items: Array.from({ length: 20 }, (_, i) => ({ ref: "a." + i, text: "观察 item ".repeat(size / 40) })) }] }),
  });
  store.append(id, { role: "assistant", text: "observed result " + n + " 结论".repeat(50) });
}
// The cached status must equal an uncached computation over freshly read rows after every kind of change.
function same(store: Store, id: string, mode: "acp" | "auto" = "acp") {
  const cached = new Context(store, id, mode).status();
  const fresh = new Context(store, id, mode).computeStatus(store.messages(id));
  assert.deepEqual(cached, fresh);
  return cached;
}

test("cached and incremental context status matches a full recomputation after appends, folds, usage and clears", () => {
  const store = new Store(":memory:"),
    { id } = store.newSession();
  same(store, id);
  for (let n = 0; n < 12; n++) {
    turn(store, id, n);
    same(store, id);
    same(store, id, "auto");
  }
  const ctx = new Context(store, id);
  const before = same(store, id);
  ctx.compress([{ startRef: "m00001", endRef: "m00007", summary }]);
  const folded = same(store, id);
  assert.notDeepEqual(folded.blocks, before.blocks);
  ctx.recordUsage(ctx.promptView(), { input: 50000 });
  const anchored = same(store, id);
  assert.notDeepEqual(anchored, folded, "recorded usage is reflected despite the cache");
  turn(store, id, 99);
  same(store, id);
  ctx.configure(64000, 4000, 1000, "other");
  same(store, id);
  // Clearing and re-appending the same number of rows must not reuse stale rows.
  const count = store.messages(id).length;
  store.clearSessionHistory(id);
  same(store, id);
  for (let n = 0; store.messages(id).length < count; n++) store.append(id, { role: "user", text: "fresh " + n });
  assert.equal(store.messages(id).length, count);
  const cleared = same(store, id);
  assert.equal(cleared.blocks.length, 0);
});

test("shared rows are frozen and loaded incrementally", () => {
  const store = new Store(":memory:"),
    { id } = store.newSession();
  turn(store, id, 1);
  const first = store.sharedMessages(id);
  assert.ok(Object.isFrozen(first.rows[0]));
  assert.throws(() => { (first.rows[0] as Message).text = "x"; });
  turn(store, id, 2);
  const second = store.sharedMessages(id);
  assert.equal(second.rows[0], first.rows[0], "earlier rows are reused, not re-parsed");
  assert.deepEqual(second.rows.map((m) => m.seq), store.messages(id).map((m) => m.seq));
  assert.notEqual(second.revision, first.revision);
});

test("status on a long session is served from cache and recomputes far faster than the old full scan", () => {
  const store = new Store(":memory:"),
    { id } = store.newSession();
  for (let n = 0; n < 300; n++) turn(store, id, n, 1200);
  const ctx = new Context(store, id, "auto");
  // Old behaviour: re-read every row and build the prompt view three times per call.
  const legacy = () => {
    ctx.promptTokens();
    ctx.promptView();
    ctx.promptView();
    return ctx.computeStatus(store.messages(id));
  };
  let t = performance.now();
  legacy();
  const full = performance.now() - t;
  ctx.status();
  t = performance.now();
  for (let i = 0; i < 10; i++) ctx.status();
  const hit = (performance.now() - t) / 10;
  turn(store, id, 1000, 1200);
  t = performance.now();
  ctx.status();
  const miss = performance.now() - t;
  console.log(`context status: legacy ${full.toFixed(1)}ms, cache hit ${hit.toFixed(2)}ms, after append ${miss.toFixed(1)}ms`);
  assert.ok(hit * 10 < full, `cache hit ${hit}ms vs full ${full}ms`);
  assert.ok(miss < full, `incremental ${miss}ms vs full ${full}ms`);
});
