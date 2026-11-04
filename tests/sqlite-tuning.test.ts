import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";

test("SQLite runs in WAL with synchronous=NORMAL off the main thread, with an index for per-session grant cleanup", { skip: process.env.DB_TYPE === "mysql" && "SQLite only" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-sqlite-"));
  const store = await Store.open(join(dir, "vega.db"));
  try {
    assert.equal((await store.one("PRAGMA journal_mode") as any).journal_mode, "wal");
    assert.equal((await store.one("PRAGMA synchronous") as any).synchronous, 1);
    assert.equal((await store.one("PRAGMA busy_timeout") as any).timeout, 5000);
    const plan = await store.all("EXPLAIN QUERY PLAN DELETE FROM blob_access WHERE session=?", "s") as any[];
    assert(plan.some((row) => /blob_access_session/.test(row.detail)), JSON.stringify(plan));
    // Statements stay valid across transactions and repeated use.
    const session = await store.newSession({ cwd: dir });
    for (let i = 0; i < 3; i++) await store.append(session.id, { role: "user", text: "m" + i });
    assert.deepEqual((await store.messages(session.id)).map((m) => m.text), ["m0", "m1", "m2"]);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
