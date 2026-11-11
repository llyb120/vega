import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";

test("token usage is recorded per user and totalled over the whole range in SQL", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.recordTokenUsage({ userId: "alice", at: 1000, model: "p/m", input: 10, output: 4, cacheRead: 2, cacheWrite: 1, session: "s1" });
    await store.recordTokenUsage({ userId: "bob", at: 2000, model: "p/n", input: 3, output: 1, session: "s2" });
    assert.deepEqual(await store.tokenUsageSummary({ userId: "alice" }), { n: 1, input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17, users: ["alice", "bob"] });
    const all = await store.tokenUsageSummary();
    assert.deepEqual([all.n, all.input, all.output, all.cacheRead, all.cacheWrite, all.total], [2, 13, 5, 2, 1, 21]);
    assert.deepEqual(all.users, ["alice", "bob"]);
    // A range totals every row inside it, not one page; its user list follows the same range.
    const recent = await store.tokenUsageSummary({ from: 1500 });
    assert.deepEqual([recent.n, recent.input, recent.output, recent.cacheRead, recent.cacheWrite, recent.total], [1, 3, 1, 0, 0, 4]);
    assert.deepEqual(recent.users, ["bob"]);
    assert.equal((await store.tokenUsageSummary({ to: 500 })).n, 0);
  } finally {
    await store.close();
  }
});

test("opening an existing SCHEMA 6 database still gains the token_usage table without a schema bump", async () => {
  const store = await Store.open(":memory:");
  try {
    const version = await store.one("SELECT value FROM settings WHERE name=?", "schema");
    assert.equal(String(version!.value), "6");
    const table = await store.one("SELECT name FROM sqlite_schema WHERE type='table' AND name='token_usage'");
    assert.equal(table!.name, "token_usage");
  } finally {
    await store.close();
  }
});
