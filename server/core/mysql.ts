import { createHash } from "node:crypto";
import { createConnection, createPool, type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";
import { Db, type Op } from "./db";
import { id } from "./util";

/**
 * Statements are written once in a portable subset (SQLite syntax); MySQL differs only in conflict handling:
 * `INSERT OR IGNORE` → `INSERT IGNORE`, `ON CONFLICT(..) DO UPDATE SET x=excluded.x` → MySQL 8.0.19+ row alias
 * `AS excluded ON DUPLICATE KEY UPDATE x=excluded.x`.
 */
export const translate = (sql: string) =>
  sql.replace(/^INSERT OR IGNORE\b/i, "INSERT IGNORE").replace(/\s*ON CONFLICT\([^)]*\) DO UPDATE SET\b/i, " AS excluded ON DUPLICATE KEY UPDATE");

/** MYSQL_URL (mysql://user:password@host:port/database), or MYSQL_HOST/PORT/USER/PASSWORD/DATABASE. */
export function mysqlOptions(): PoolOptions {
  const env = process.env, url = env.MYSQL_URL ? new URL(env.MYSQL_URL) : undefined;
  const base: PoolOptions = url
    ? { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)) || "vega" }
    : { host: env.MYSQL_HOST || "127.0.0.1", port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER || "root", password: env.MYSQL_PASSWORD || "", database: env.MYSQL_DATABASE || "vega" };
  return { ...base, charset: "utf8mb4", supportBigNumbers: true, connectionLimit: Number(env.MYSQL_POOL_SIZE || 10) };
}

const param = (p: unknown) => (p === undefined ? null : p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p);
async function query(conn: Pool | PoolConnection, op: Op, sql: string, params: unknown[]) {
  const [result] = await conn.query(op === "exec" ? sql : translate(sql), params.map(param));
  if (op === "run") { const r = result as any; return { changes: r.affectedRows, lastId: Number(r.insertId) }; }
  return op === "all" ? result : undefined;
}

export function singletonLockName(database: string) {
  const db = String(database || "vega");
  const hash = createHash("sha256").update(db).digest("hex").slice(0, 16);
  const safe = db.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 32) || "vega";
  return `vega:inst:${safe}:${hash}`;
}

export function mysqlLockTimeout() {
  const raw = process.env.MYSQL_LOCK_TIMEOUT;
  if (raw === undefined || raw === "") return 30;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

export type LockConnection = {
  query(sql: string, params?: unknown[]): Promise<[any, ...any[]]>;
  end(): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): any;
  off?(event: string, listener: (...args: any[]) => void): any;
  removeListener?(event: string, listener: (...args: any[]) => void): any;
};

export type SingletonLockOptions = {
  timeoutSeconds?: number;
  keepaliveMs?: number;
  onLost?: (reason: string) => void;
};

const LOCK_ERROR = (database: string, lockName: string, timeoutSeconds: number) =>
  `另一个 Vega 实例正在使用当前 MySQL 数据库（${database}，锁 ${lockName} 等待 ${timeoutSeconds}s 超时）。Vega 仅支持单实例连接同一个库，请停止旧实例或检查是否配置了相同数据库后重试。`;

function lockFlag(rows: any, key: string): number | null {
  const row = Array.isArray(rows) ? rows[0] : rows;
  const raw = row?.[key];
  return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * Holds a session-scoped MySQL advisory lock (`GET_LOCK`) so at most one Vega process
 * runs against a given MySQL database at any time.
 */
export class MysqlSingletonLock {
  private conn?: LockConnection;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private lost = false;
  private recovering?: Promise<void>;
  private readonly timeoutSeconds: number;
  private readonly keepaliveMs: number;
  private readonly onLost?: (reason: string) => void;
  private readonly onDisconnect = () => {
    if (!this.closed) void this.recover("锁连接中断");
  };

  private constructor(
    private readonly connect: () => Promise<LockConnection>,
    readonly lockName: string,
    readonly database: string,
    opts: SingletonLockOptions = {},
  ) {
    this.timeoutSeconds = opts.timeoutSeconds ?? 30;
    this.keepaliveMs = opts.keepaliveMs ?? 30_000;
    this.onLost = opts.onLost;
  }

  static async acquire(
    connect: () => Promise<LockConnection>,
    lockName: string,
    database: string,
    opts: SingletonLockOptions = {},
  ): Promise<MysqlSingletonLock> {
    const lock = new MysqlSingletonLock(connect, lockName, database, opts);
    await lock.acquireInitial();
    return lock;
  }

  private attach(conn: LockConnection) {
    conn.on?.("error", this.onDisconnect);
    conn.on?.("end", this.onDisconnect);
  }

  private detach(conn: LockConnection | undefined) {
    if (!conn) return;
    if (conn.off) {
      conn.off("error", this.onDisconnect);
      conn.off("end", this.onDisconnect);
    } else {
      conn.removeListener?.("error", this.onDisconnect);
      conn.removeListener?.("end", this.onDisconnect);
    }
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async acquireInitial() {
    const conn = await this.connect();
    try {
      const [rows] = await conn.query("SELECT GET_LOCK(?, ?) AS locked", [this.lockName, this.timeoutSeconds]);
      if (lockFlag(rows, "locked") !== 1) {
        throw new Error(LOCK_ERROR(this.database, this.lockName, this.timeoutSeconds));
      }
    } catch (e) {
      await conn.end().catch(() => {});
      throw e;
    }
    this.conn = conn;
    this.attach(conn);
    this.timer = setInterval(() => { void this.check(); }, this.keepaliveMs);
    this.timer.unref?.();
  }

  async check() {
    if (this.closed || this.lost || !this.conn || this.recovering) return;
    try {
      const [rows] = await this.conn.query("SELECT CONNECTION_ID() AS me, IS_USED_LOCK(?) AS holder", [this.lockName]);
      const row = Array.isArray(rows) ? rows[0] : rows;
      const me = row?.me, holder = row?.holder;
      if (holder !== null && holder !== undefined && me !== null && me !== undefined && Number(holder) === Number(me)) return;
      await this.recover("锁保活检测失败或锁已不再由当前连接持有");
    } catch {
      await this.recover("锁保活检测失败或锁已不再由当前连接持有");
    }
  }

  private recover(cause: string): Promise<void> {
    if (this.closed || this.lost) return Promise.resolve();
    if (this.recovering) return this.recovering;
    const old = this.conn;
    this.conn = undefined;
    this.detach(old);
    const task = (async () => {
      await old?.end().catch(() => {});
      if (this.closed) return;
      let next: LockConnection | undefined;
      try {
        next = await this.connect();
        const [rows] = await next.query("SELECT GET_LOCK(?, 0) AS locked", [this.lockName]);
        if (this.closed) {
          await next.query("SELECT RELEASE_LOCK(?)", [this.lockName]).catch(() => {});
          await next.end().catch(() => {});
          return;
        }
        if (lockFlag(rows, "locked") === 1) {
          this.conn = next;
          this.attach(next);
          return;
        }
      } catch {
        // Fall through to mark lock lost.
      }
      await next?.end().catch(() => {});
      if (this.closed || this.lost) return;
      this.lost = true;
      this.stopTimer();
      this.onLost?.(`${cause}，且无法重新获取 MySQL 单活锁（${this.lockName}）`);
    })().finally(() => {
      if (this.recovering === task) this.recovering = undefined;
    });
    this.recovering = task;
    return task;
  }

  async release() {
    this.closed = true;
    this.stopTimer();
    await this.recovering?.catch(() => {});
    const conn = this.conn;
    this.conn = undefined;
    if (!conn) return;
    this.detach(conn);
    await conn.query("SELECT RELEASE_LOCK(?)", [this.lockName]).catch(() => {});
    await conn.end().catch(() => {});
  }
}

export class Mysql extends Db {
  readonly dialect = "mysql";
  private constructor(private pool: Pool, private dropOnClose?: string, private singletonLock?: MysqlSingletonLock) { super(); }
  /** The configured database, or (temporary) a fresh database dropped on close. */
  static async connect(temporary = false) {
    const options = mysqlOptions();
    if (temporary) {
      const name = "vega_tmp_" + id();
      const admin = await createConnection({ ...options, database: undefined });
      try { await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`); } finally { await admin.end(); }
      const pool = createPool({ ...options, database: name });
      return new Mysql(pool, name);
    }
    const database = String(options.database || "vega");
    const lockName = singletonLockName(database);
    let instance: Mysql | undefined;
    const lock = await MysqlSingletonLock.acquire(
      () => createConnection({ ...options, enableKeepAlive: true, keepAliveInitialDelay: 30000 }) as unknown as Promise<LockConnection>,
      lockName,
      database,
      {
        timeoutSeconds: mysqlLockTimeout(),
        onLost: (reason) => instance?.onLockLost?.(reason),
      },
    );
    try {
      instance = new Mysql(createPool(options), undefined, lock);
      return instance;
    } catch (e) {
      await lock.release().catch(() => {});
      throw e;
    }
  }
  protected direct(op: Op, sql: string, params: unknown[]) { return query(this.pool, op, sql, params); }
  protected async acquire() {
    const conn = await this.pool.getConnection();
    return { query: (op: Op, sql: string, params: unknown[]) => query(conn, op, sql, params), release: () => conn.release() };
  }
  private closed = false;
  async close() {
    await this.writer.run(async () => {
      if (this.closed) return;
      this.closed = true;
      try {
        if (this.dropOnClose) await this.pool.query(`DROP DATABASE IF EXISTS ${this.dropOnClose}`);
        await this.pool.end();
      } finally {
        await this.singletonLock?.release();
      }
    });
  }
}
