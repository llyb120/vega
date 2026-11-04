import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type Message } from "../server/core/store";
import { Context } from "../server/core/context";

const summary =
  "Finished inspection: required files were read, relevant evidence and decisions recorded. No changes or external submissions are inferred.";
async function turn(store: Store, id: string, n: number, size = 400) {
  await store.append(id, { role: "user", text: "question " + n });
  await store.append(id, { role: "assistant", calls: [{ id: "c" + n, name: "chrome_act", arguments: { action: "click", ref: "a." + n } }] });
  await store.append(id, {
        role: "tool",
        callId: "c" + n,
        name: "chrome_act",
        text: JSON.stringify({ tabTag: "t1", pages: [{ items: Array.from({ length: 20 }, (_, i) => ({ ref: "a." + i, text: "观察 item ".repeat(size / 40) })) }] }),
      });
  await store.append(id, { role: "assistant", text: "observed result " + n + " 结论".repeat(50) });
}
// The cached status must equal an uncached computation over freshly read rows after every kind of change.
async function same(store: Store, id: string, mode: "acp" | "auto" = "acp") {
  const cached = await (await Context.open(store, id, mode)).status();
  const fresh = await (await Context.open(store, id, mode)).computeStatus(await store.messages(id));
  assert.deepEqual(cached, fresh);
  return cached;
}

test("cached and incremental context status matches a full recomputation after appends, folds, usage and clears", async () => {
  const store = await Store.open(":memory:"),
    { id } = await store.newSession();
  await same(store, id);
  for (let n = 0; n < 12; n++) {
    await turn(store, id, n);
    await same(store, id);
    await same(store, id, "auto");
  }
  const ctx = await Context.open(store, id);
  const before = await same(store, id);
  await ctx.compress([{ startRef: "m00001", endRef: "m00007", summary }]);
  const folded = await same(store, id);
  assert.notDeepEqual(folded.blocks, before.blocks);
  await ctx.recordUsage(await ctx.promptView(), { input: 50000 });
  const anchored = await same(store, id);
  assert.notDeepEqual(anchored, folded, "recorded usage is reflected despite the cache");
  await turn(store, id, 99);
  await same(store, id);
  await ctx.configure(64000, 4000, 1000, "other");
  await same(store, id);
  // Clearing and re-appending the same number of rows must not reuse stale rows.
  const count = (await store.messages(id)).length;
  await store.clearSessionHistory(id);
  await same(store, id);
  for (let n = 0; (await store.messages(id)).length < count; n++) await store.append(id, { role: "user", text: "fresh " + n });
  assert.equal((await store.messages(id)).length, count);
  const cleared = await same(store, id);
  assert.equal(cleared.blocks.length, 0);
});

test("shared rows are frozen and loaded incrementally", async () => {
  const store = await Store.open(":memory:"),
    { id } = await store.newSession();
  await turn(store, id, 1);
  const first = await store.sharedMessages(id);
  assert.ok(Object.isFrozen(first.rows[0]));
  assert.throws(() => { (first.rows[0] as Message).text = "x"; });
  await turn(store, id, 2);
  const second = await store.sharedMessages(id);
  assert.equal(second.rows[0], first.rows[0], "earlier rows are reused, not re-parsed");
  assert.deepEqual(second.rows.map((m) => m.seq), (await store.messages(id)).map((m) => m.seq));
  assert.notEqual(second.revision, first.revision);
});

test("status on a long session is served from cache and recomputes far faster than the old full scan", async () => {
  const store = await Store.open(":memory:"),
    { id } = await store.newSession();
  for (let n = 0; n < 300; n++) await turn(store, id, n, 1200);
  const ctx = await Context.open(store, id, "auto");
  // Old behaviour: re-read every row and build the prompt view three times per call.
  const legacy = async () => {
    await ctx.promptTokens();
    await ctx.promptView();
    await ctx.promptView();
    return await ctx.computeStatus(await store.messages(id));
  };
  let t = performance.now();
  await legacy();
  const full = performance.now() - t;
  await ctx.status();
  t = performance.now();
  for (let i = 0; i < 10; i++) await ctx.status();
  const hit = (performance.now() - t) / 10;
  await turn(store, id, 1000, 1200);
  t = performance.now();
  await ctx.status();
  const miss = performance.now() - t;
  console.log(`context status: legacy ${full.toFixed(1)}ms, cache hit ${hit.toFixed(2)}ms, after append ${miss.toFixed(1)}ms`);
  assert.ok(hit * 10 < full, `cache hit ${hit}ms vs full ${full}ms`);
  assert.ok(miss < full, `incremental ${miss}ms vs full ${full}ms`);
});
