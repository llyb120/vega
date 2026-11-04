import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";

export type Row = Record<string, any>;
export type Dialect = "sqlite" | "mysql";
export type Op = "all" | "run" | "exec";
/** One connection: SQLite's worker, or a MySQL pool connection (released after its transaction). */
export type Conn = { query(op: Op, sql: string, params: unknown[]): Promise<any>; release?(): void };
type Tx = { db: Db; conn: Conn; open: boolean; depth: number };

/** FIFO async lock. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** The transaction the current async flow runs in (AsyncLocalStorage, so callees need no handle). */
const current = new AsyncLocalStorage<Tx>();

/**
 * Async database access shared by both backends. Statements use a portable subset of SQL (see Mysql.translate).
 *
 * Transactions run one at a time in this process (`writer`), like SQLite's single writer, so a read-modify-write
 * inside `transaction` cannot interleave with another one on either backend. Queries issued inside it, by any callee,
 * use its connection; outside a transaction they run on their own.
 */
export abstract class Db {
  abstract readonly dialect: Dialect;
  protected writer = new Mutex();
  /** A statement outside any transaction. */
  protected abstract direct(op: Op, sql: string, params: unknown[]): Promise<any>;
  /** A connection for a transaction. */
  protected abstract acquire(): Promise<Conn>;
  abstract close(): Promise<void>;
  private query(op: Op, sql: string, params: unknown[]) {
    const tx = current.getStore();
    return tx?.db === this && tx.open ? tx.conn.query(op, sql, params) : this.direct(op, sql, params);
  }
  all(sql: string, params: unknown[] = []): Promise<Row[]> { return this.query("all", sql, params); }
  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> { return (await this.all(sql, params))[0]; }
  run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastId: number }> { return this.query("run", sql, params); }
  exec(sql: string): Promise<void> { return this.query("exec", sql, []); }
  get inTransaction() { const tx = current.getStore(); return tx?.db === this && tx.open; }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const tx = current.getStore();
    if (tx?.db === this && tx.open) {
      const name = "vega_" + ++tx.depth;
      await tx.conn.query("exec", "SAVEPOINT " + name, []);
      try {
        const value = await fn();
        await tx.conn.query("exec", "RELEASE SAVEPOINT " + name, []);
        return value;
      } catch (e) {
        await tx.conn.query("exec", "ROLLBACK TO SAVEPOINT " + name, []);
        throw e;
      } finally { tx.depth--; }
    }
    return this.writer.run(async () => {
      const conn = await this.acquire(), next: Tx = { db: this, conn, open: true, depth: 0 };
      try {
        await conn.query("exec", this.dialect === "sqlite" ? "BEGIN IMMEDIATE" : "START TRANSACTION", []);
        try {
          const value = await current.run(next, fn);
          await conn.query("exec", "COMMIT", []);
          return value;
        } catch (e) {
          await conn.query("exec", "ROLLBACK", []).catch(() => {});
          throw e;
        }
      } finally {
        // Work the transaction started but did not await falls back to ordinary queries.
        next.open = false;
        conn.release?.();
      }
    });
  }
}

/** node:sqlite runs in a worker thread so statements never block the event loop. */
const SQLITE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.path), statements = new Map();
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
const prepare = (sql) => { let s = statements.get(sql); if (!s) statements.set(sql, s = db.prepare(sql)); return s; };
parentPort.on("message", ({ id, op, sql, params }) => {
  try {
    let value;
    if (op === "exec") db.exec(sql);
    else if (op === "all") value = prepare(sql).all(...params);
    else if (op === "run") { const r = prepare(sql).run(...params); value = { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; }
    else if (op === "close") db.close();
    parentPort.postMessage({ id, value });
  } catch (e) { parentPort.postMessage({ id, error: { message: e.message, code: e.code } }); }
});`;

export class Sqlite extends Db {
  readonly dialect = "sqlite";
  private worker: Worker;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private next = 0;
  private conn: Conn = { query: (op, sql, params) => this.send(op, sql, params) };
  constructor(path: string) {
    super();
    this.worker = new Worker(SQLITE_WORKER, { eval: true, workerData: { path } });
    this.worker.unref();
    this.worker.on("message", ({ id, value, error }) => {
      const call = this.pending.get(id)!;
      this.pending.delete(id);
      if (!this.pending.size) this.worker.unref();
      if (error) call.reject(Object.assign(new Error(error.message), { code: error.code }));
      else call.resolve(value);
    });
    this.worker.on("error", (e) => { for (const call of this.pending.values()) call.reject(e); this.pending.clear(); });
  }
  private send(op: string, sql: string, params: unknown[]) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.next;
      // The worker keeps the process alive only while a statement is in flight.
      if (!this.pending.size) this.worker.ref();
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, sql, params: params.map((p) => (p === undefined ? null : p)) });
    });
  }
  // One connection: a statement waits for a running transaction to finish.
  protected direct(op: Op, sql: string, params: unknown[]) { return this.writer.run(() => this.send(op, sql, params)); }
  protected async acquire() { return this.conn; }
  async close() {
    await this.writer.run(() => this.send("close", "", []));
    await this.worker.terminate();
  }
}
