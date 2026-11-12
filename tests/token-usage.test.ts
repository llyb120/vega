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

test("token usage per task groups and pages in SQL", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.recordTokenUsage({ userId: "alice", at: 1000, task: "t1", employee: "e1", session: "s1", input: 10, output: 5, total: 15 });
    await store.recordTokenUsage({ userId: "alice", at: 2000, task: "t1", employee: "e1", session: "s1", input: 1, output: 1, cacheRead: 3, total: 5 });
    await store.recordTokenUsage({ userId: "alice", at: 3000, task: "t2", employee: "e1", session: "s2", input: 7, total: 7 });
    await store.recordTokenUsage({ userId: "bob", at: 4000, session: "s3", input: 2, total: 2 });
    const first = await store.tokenUsageTasks({ userId: "alice", pageSize: 1 });
    assert.deepEqual(first.tasks, [{ user: "alice", task: "t1", employee: "e1", n: 2, input: 11, output: 6, cacheRead: 3, cacheWrite: 0, total: 20, first: 1000, last: 2000 }]);
    assert.deepEqual([first.total, first.page, first.pageSize], [2, 1, 1]);
    const rest = await store.tokenUsageTasks({ userId: "alice", page: 2, pageSize: 1 });
    assert.deepEqual([rest.tasks[0].task, rest.tasks[0].total], ["t2", 7]);
    assert.equal((await store.tokenUsageTasks({ userId: "alice", page: 3, pageSize: 1 })).tasks.length, 0);
    // Rows without a task stay a separate bucket instead of being merged into another task.
    const all = await store.tokenUsageTasks({ pageSize: 20 });
    assert.equal(all.total, 3);
    assert(all.tasks.some((row) => row.user === "bob" && !row.task && row.total === 2));
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
