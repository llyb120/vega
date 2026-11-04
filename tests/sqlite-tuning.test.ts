import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";

test("one connection in WAL with synchronous=NORMAL, reused statements and an index for per-session grant cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-sqlite-"));
  const store = new Store(join(dir, "vega.db"));
  try {
    assert.equal((store.db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
    assert.equal((store.db.prepare("PRAGMA synchronous").get() as any).synchronous, 1);
    assert.equal((store.db.prepare("PRAGMA busy_timeout").get() as any).timeout, 5000);
    assert.equal(store.sql("SELECT 1"), store.sql("SELECT 1"));
    const plan = store.db.prepare("EXPLAIN QUERY PLAN DELETE FROM blob_access WHERE session=?").all("s") as any[];
    assert(plan.some((row) => /blob_access_session/.test(row.detail)), JSON.stringify(plan));
    // Statements stay valid across transactions and repeated use.
    const session = store.newSession({ cwd: dir });
    for (let i = 0; i < 3; i++) store.append(session.id, { role: "user", text: "m" + i });
    assert.deepEqual(store.messages(session.id).map((m) => m.text), ["m0", "m1", "m2"]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
