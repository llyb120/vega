import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Store } from "../server/core/store";
import { mysqlLockTimeout, mysqlOptions, MysqlSingletonLock, singletonLockName, translate, type LockConnection } from "../server/core/mysql";

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

test("afterCommit discards callbacks from rolled-back savepoints", async (t) => {
  const store = await Store.open(":memory:");
  t.after(() => store.close());
  const seen: string[] = [];
  await store.transaction(async () => {
    store.afterCommit(() => seen.push("outer"));
    await store.transaction(async () => {
      store.afterCommit(() => seen.push("kept"));
      await assert.rejects(store.transaction(async () => {
        store.afterCommit(() => seen.push("discarded"));
        await store.transaction(async () => { store.afterCommit(() => seen.push("discarded descendant")); });
        throw Error("undo inner");
      }), /undo inner/);
      store.afterCommit(() => seen.push("kept after rollback"));
    });
    await assert.rejects(store.transaction(async () => {
      store.afterCommit(() => seen.push("discarded sibling"));
      throw Error("undo sibling");
    }), /undo sibling/);
  });
  assert.deepEqual(seen, ["outer", "kept", "kept after rollback"]);
  await store.transaction(async () => {
    let resume!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const nested = store.transaction(async () => {
      store.afterCommit(() => seen.push("discarded concurrent"));
      started();
      await waiting;
      throw Error("undo concurrent inner");
    });
    await ready;
    store.afterCommit(() => seen.push("outer during inner"));
    resume();
    await assert.rejects(nested, /undo concurrent inner/);
  });
  assert.deepEqual(seen, ["outer", "kept", "kept after rollback", "outer during inner"]);
  await assert.rejects(store.transaction(async () => {
    await store.transaction(async () => { store.afterCommit(() => seen.push("outer rollback")); });
    throw Error("undo outer");
  }), /undo outer/);
  assert.deepEqual(seen, ["outer", "kept", "kept after rollback", "outer during inner"]);
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

test("MySQL singleton lock names stay within MySQL 64-char limit and distinguish long names", () => {
  const a = singletonLockName("a".repeat(60) + "_one");
  const b = singletonLockName("a".repeat(60) + "_two");
  assert(a.length <= 64 && b.length <= 64);
  assert.notEqual(a, b);
  assert.equal(singletonLockName(""), singletonLockName("vega"));
});

test("mysqlLockTimeout defaults to 30 and honors valid MYSQL_LOCK_TIMEOUT values", () => {
  const saved = process.env.MYSQL_LOCK_TIMEOUT;
  try {
    delete process.env.MYSQL_LOCK_TIMEOUT;
    assert.equal(mysqlLockTimeout(), 30);
    process.env.MYSQL_LOCK_TIMEOUT = "0";
    assert.equal(mysqlLockTimeout(), 0);
    process.env.MYSQL_LOCK_TIMEOUT = "45";
    assert.equal(mysqlLockTimeout(), 45);
    process.env.MYSQL_LOCK_TIMEOUT = "-5";
    assert.equal(mysqlLockTimeout(), 30);
    process.env.MYSQL_LOCK_TIMEOUT = "abc";
    assert.equal(mysqlLockTimeout(), 30);
  } finally {
    if (saved === undefined) delete process.env.MYSQL_LOCK_TIMEOUT;
    else process.env.MYSQL_LOCK_TIMEOUT = saved;
  }
});

function mockMysqlCluster() {
  let nextId = 1;
  const locks = new Map<string, number>();
  const connections: Array<EventEmitter & LockConnection & { id: number; ended: boolean; queries: string[] }> = [];
  const connect = async () => {
    const id = nextId++;
    const emitter = new EventEmitter();
    const conn = Object.assign(emitter, {
      id,
      ended: false,
      queries: [] as string[],
      async query(sql: string, params: unknown[] = []): Promise<[any]> {
        conn.queries.push(sql);
        if (conn.ended) throw new Error("Connection closed");
        if (sql.includes("GET_LOCK")) {
          const name = String(params[0]);
          const holder = locks.get(name);
          if (holder !== undefined && holder !== id) return [[{ locked: 0 }]];
          locks.set(name, id);
          return [[{ locked: 1 }]];
        }
        if (sql.includes("IS_USED_LOCK")) {
          const name = String(params[0]);
          return [[{ me: id, holder: locks.get(name) ?? null }]];
        }
        if (sql.includes("RELEASE_LOCK")) {
          const name = String(params[0]);
          if (locks.get(name) === id) { locks.delete(name); return [[{ released: 1 }]]; }
          return [[{ released: 0 }]];
        }
        return [[]];
      },
      async end() {
        if (conn.ended) return;
        conn.ended = true;
        for (const [name, holder] of locks) if (holder === id) locks.delete(name);
      },
    });
    connections.push(conn);
    return conn;
  };
  return { connect, locks, connections };
}

test("MysqlSingletonLock prevents a second instance from starting and releases on close", async () => {
  const cluster = mockMysqlCluster();
  const lockName = singletonLockName("vega_prod");
  const first = await MysqlSingletonLock.acquire(cluster.connect, lockName, "vega_prod", { timeoutSeconds: 5, keepaliveMs: 60_000 });
  assert.equal(cluster.locks.get(lockName), 1);

  await assert.rejects(
    MysqlSingletonLock.acquire(cluster.connect, lockName, "vega_prod", { timeoutSeconds: 5, keepaliveMs: 60_000 }),
    /另一个 Vega 实例正在使用当前 MySQL 数据库/,
  );
  assert.equal(cluster.connections[1].ended, true, "failed connection is closed");
  assert.equal(cluster.locks.get(lockName), 1, "first instance still holds the lock");

  await first.release();
  assert.equal(cluster.locks.has(lockName), false);
  assert(cluster.connections[0].queries.some((sql) => sql.includes("RELEASE_LOCK")));
  assert.equal(cluster.connections[0].ended, true);

  const second = await MysqlSingletonLock.acquire(cluster.connect, lockName, "vega_prod", { timeoutSeconds: 5, keepaliveMs: 60_000 });
  await second.release();
});

test("MysqlSingletonLock recovers transparently when reconnected cleanly and fires onLost once if stolen", async () => {
  const cluster = mockMysqlCluster();
  const lockName = singletonLockName("vega_prod");
  const lost: string[] = [];
  const lock = await MysqlSingletonLock.acquire(cluster.connect, lockName, "vega_prod", {
    timeoutSeconds: 5,
    keepaliveMs: 60_000,
    onLost: (reason) => lost.push(reason),
  });

  // Simulate transient disconnect where nobody else acquired the lock.
  cluster.connections[0].emit("error", new Error("ECONNRESET"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(lost, [], "transient disconnect that re-acquires the lock does not trigger onLost");
  assert.equal(cluster.locks.get(lockName), 2);

  // Now simulate another holder taking the lock before keepalive check.
  cluster.locks.set(lockName, 999);
  await lock.check();
  assert.equal(lost.length, 1);
  assert.match(lost[0], /无法重新获取 MySQL 单活锁/);

  // Subsequent checks do not double-fire onLost.
  await lock.check();
  assert.equal(lost.length, 1);
  await lock.release();
});
