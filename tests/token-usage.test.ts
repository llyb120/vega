import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";

test("token usage is recorded per user and admins can read everyone's rows", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.recordTokenUsage({ userId: "alice", model: "p/m", input: 10, output: 4, cacheRead: 2, cacheWrite: 1, session: "s1" });
    await store.recordTokenUsage({ userId: "bob", model: "p/n", input: 3, output: 1, session: "s2" });
    const alice = await store.tokenUsage({ userId: "alice" });
    assert.equal(alice.length, 1);
    assert.equal(alice[0].userId, "alice");
    const row = alice[0] as typeof alice[0] & { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    assert.equal(row.input, 10);
    assert.equal(row.output, 4);
    assert.equal(row.cacheRead, 2);
    assert.equal(row.cacheWrite, 1);
    assert.equal(row.total, 17);
    const all = await store.tokenUsage();
    assert.equal(all.length, 2);
    assert.deepEqual(new Set(all.map((row) => row.userId)), new Set(["alice", "bob"]));
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
