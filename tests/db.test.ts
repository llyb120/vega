import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { mysqlOptions, translate } from "../server/core/mysql";

// Runs on the configured backend: DB_TYPE=sqlite (default) or DB_TYPE=mysql.

test("MySQL statements are SQLite statements with conflict clauses rewritten", () => {
  assert.equal(translate("INSERT OR IGNORE INTO t(a) VALUES(?)"), "INSERT IGNORE INTO t(a) VALUES(?)");
  assert.equal(translate("INSERT INTO t(a,b) VALUES(?,?) ON CONFLICT(a) DO UPDATE SET b=excluded.b"), "INSERT INTO t(a,b) VALUES(?,?) AS excluded ON DUPLICATE KEY UPDATE b=excluded.b");
  assert.equal(translate("SELECT 1"), "SELECT 1");
});

test("MySQL connection settings come from MYSQL_URL or MYSQL_* variables", () => {
  const saved = { ...process.env };
  try {
    process.env.MYSQL_URL = "mysql://vega:p%40ss@db.internal:3307/vega_prod";
    process.env.MYSQL_POOL_SIZE = "4";
    assert.deepEqual({ ...mysqlOptions() }, { host: "db.internal", port: 3307, user: "vega", password: "p@ss", database: "vega_prod", charset: "utf8mb4", supportBigNumbers: true, connectionLimit: 4 });
    delete process.env.MYSQL_URL; delete process.env.MYSQL_POOL_SIZE;
    Object.assign(process.env, { MYSQL_HOST: "h", MYSQL_PORT: "3310", MYSQL_USER: "u", MYSQL_PASSWORD: "x", MYSQL_DATABASE: "d" });
    assert.deepEqual({ ...mysqlOptions() }, { host: "h", port: 3310, user: "u", password: "x", database: "d", charset: "utf8mb4", supportBigNumbers: true, connectionLimit: 10 });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("concurrent appends get consecutive sequence numbers; a failed nested transaction rolls back alone", async (t) => {
  const store = await Store.open(":memory:");
  t.after(() => store.close());
  const { id } = await store.newSession();
  await Promise.all(Array.from({ length: 40 }, (_, n) => store.append(id, { role: "user", text: "m" + n })));
  assert.deepEqual((await store.messages(id)).map((m) => m.seq), Array.from({ length: 40 }, (_, n) => n + 1));
  await store.transaction(async () => {
    await store.put("outer", 1);
    await assert.rejects(store.transaction(async () => { await store.put("inner", 1); throw Error("undo inner"); }), /undo inner/);
  });
  assert.equal(await store.get("outer", 0), 1);
  assert.equal(await store.get("inner", 0), 0);
  await assert.rejects(store.transaction(async () => { await store.put("outer", 2); throw Error("undo all"); }), /undo all/);
  assert.equal(await store.get("outer", 0), 1);
});

test("a slow query does not block the event loop", async (t) => {
  const store = await Store.open(":memory:");
  t.after(() => store.close());
  // About a second of database work on either backend.
  const slow = store.db.dialect === "sqlite"
    ? "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3000000) SELECT count(*) c FROM n"
    : "SELECT SLEEP(1) c";
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = Date.now();
  await store.one(slow);
  clearInterval(timer);
  const elapsed = Date.now() - started;
  assert(elapsed > 200, "the query should take a while (" + elapsed + "ms)");
  assert(ticks >= elapsed / 10 / 3, `timers kept firing during the query: ${ticks} ticks in ${elapsed}ms`);
});

test("work a transaction starts but does not await never runs inside it or leaves a stray transaction", async (t) => {
  const store = await Store.open(":memory:");
  t.after(() => store.close());
  const db = store.db, seen: boolean[] = [];
  let late: Promise<unknown> | undefined, timer: Promise<unknown> | undefined;
  await db.transaction(async () => {
    await db.exec("CREATE TABLE IF NOT EXISTS leak_probe (n INTEGER)");
    // Fire-and-forget nested work still running when the outer transaction commits.
    late = db.transaction(async () => { await new Promise((r) => setTimeout(r, 30)); await db.run("INSERT INTO leak_probe VALUES (1)"); });
    late.catch(() => {});
    // A timer started inside the transaction, firing after it ended.
    timer = new Promise((resolve) => setTimeout(() => resolve(db.transaction(() => db.run("INSERT INTO leak_probe VALUES (2)"))), 10));
    db.afterCommit(() => seen.push(db.inTransaction));
  });
  await timer;
  await assert.rejects(late!, /outlived/);
  assert.deepEqual(seen, [false]);
  // The late write ran on its own after the commit (not inside a stray transaction), and the connection is clean.
  await db.transaction(() => db.run("INSERT INTO leak_probe VALUES (3)"));
  assert.deepEqual((await db.all("SELECT n FROM leak_probe ORDER BY n")).map((r) => Number(r.n)), [1, 2, 3]);
});

test("a stray open transaction on SQLite's connection does not wedge later writes", async (t) => {
  const store = await Store.open(":memory:");
  t.after(() => store.close());
  const db = store.db as any;
  if (db.dialect !== "sqlite") return;
  await db.exec("CREATE TABLE IF NOT EXISTS wedge_probe (n INTEGER)");
  await db.conn.query("exec", "BEGIN", []);
  await db.transaction(() => db.run("INSERT INTO wedge_probe VALUES (1)"));
  assert.equal((await db.all("SELECT n FROM wedge_probe")).length, 1);
});
