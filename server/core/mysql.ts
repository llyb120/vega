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

export class Mysql extends Db {
  readonly dialect = "mysql";
  private constructor(private pool: Pool, private dropOnClose?: string) { super(); }
  /** The configured database, or (temporary) a fresh database dropped on close. */
  static async connect(temporary = false) {
    const options = mysqlOptions();
    if (!temporary) return new Mysql(createPool(options));
    const name = "vega_tmp_" + id();
    const admin = await createConnection({ ...options, database: undefined });
    try { await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`); } finally { await admin.end(); }
    const pool = createPool({ ...options, database: name });
    return new Mysql(pool, name);
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
      if (this.dropOnClose) await this.pool.query(`DROP DATABASE IF EXISTS ${this.dropOnClose}`);
      await this.pool.end();
    });
  }
}
