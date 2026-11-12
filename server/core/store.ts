import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Db, Sqlite, type Dialect } from "./db";
import { cloudFor } from "./cloud";
import { Files } from "./files";
import type { FileRef } from "./attachments";
import { assert, id, type Obj } from "./util";
/** Unread counts stop here (the badge shows 99+). */
export const UNREAD_MAX = 100;
export type Part = { type: string; [key: string]: any };
export type Message = {
  seq?: number;
  role: string;
  text?: string;
  displayText?: string;
  actorId?: string;
  clientMessageId?: string;
  clientMessageHash?: string;
  taskInput?: { answer?: string; handoff?: string; handoffRevision?: number; quoteSeq?: number };
  quote?: { seq: number; role: string; text: string; taskId?: string };
  tasks?: { id: string; title: string; status: string }[];
  delivery?: boolean;
  /** Group chat (groups.ts): who said it, in the group's own session. */
  author?: { kind: "user" | "employee"; id: string; name: string };
  /**
   * Group chat relay depth: 0 for a user's message, n for the n-th employee turn handed on by @mentions since then.
   * In a member's own group session (role user) also the group message it answers (seq) and who sent it.
   */
  hop?: number;
  group?: { groupId: string; name: string; seq: number; from: { kind: "user" | "employee"; id: string; name: string }; byOwner: boolean };
  /** A group notice from the system (member joined/left, relay limit reached). */
  notice?: boolean;
  /** /new divider: the model context of this session starts after it (context.ts sinceNewSession). */
  newSession?: boolean;
  /** A task milestone the executing session chose to tell the user (task_progress tellUser). */
  progress?: boolean;
  thinking?: string;
  signature?: string;
  opaque?: any[];
  calls?: Call[];
  callId?: string;
  name?: string;
  /** blobId: attachments and normal tool images in SQLite; path/url: a Chrome screenshot file (see Files). */
  images?: { mime: string; data?: string; blobId?: string; path?: string; url?: string }[];
  /** Attached non-image files (stored as blobs; see attachments.ts for how a run gets them on disk). */
  files?: FileRef[];
  error?: boolean;
  model?: string;
  usage?: any;
  at?: number;
};
export type Call = { id: string; name: string; arguments: Record<string, any> };
export type Session = {
  id: string;
  title: string;
  cwd: string;
  model?: string;
  scene?: string;
  stageSource?: string;
  taskId?: string;
  employeeId?: string;
  localAgent?: boolean;
  /** 浏览器位置与执行位置解耦：由该牛马的浏览器 Master 决定，只有用本机浏览器时才为 true。 */
  localBrowser?: boolean;
  /** 托管真正 Chromium 的客户端（浏览器 Master）；可以与文件系统 Master 不是同一台。 */
  browserClientId?: string;
  localPlatform?: string;
  clientId?: string;
  clientName?: string;
  executionCwds?: Record<string, string | undefined>;
  readOnly?: boolean;
  ownerId?: string;
  readerIds?: string[];
  fireRoot?: string;
  fireRole?: "work" | "judge";
  /** A group chat's own session (no employee), or a member employee's session inside that group. */
  groupId?: string;
  /** Isolated computer session created by task_relay_computer (cannot switch_scene back). */
  relayComputer?: boolean;
  /** Employee main task: scenes to return to (caller work in `resume`), kept across runs so a 429/stop/resume does not drop them. */
  sceneStack?: SceneFrame[];
  /** Frozen OpenAI-compatible prompt cache key (parent's key is reused by 分身). */
  promptCacheKey?: string;
  /** Frozen stable system prefix for this session (including Epic BOOST if it was on at start). */
  frozenSystem?: string;
  boostFrozen?: boolean;
  /** Whether spawn_agent tools were in the schema at session start (kept stable mid-session). */
  allowSpawnFrozen?: boolean;
  /** Frozen switch_scene.enum for this session (configured scenes at start; not mutated mid-session). */
  sceneEnumFrozen?: string[];
  /** Parent session id when this is a 分身 Stage. */
  spawnParent?: string;
  agentName?: string;
  agentChild?: boolean;
  createdAt: number;
};
export type SceneFrame = { scene?: string; model?: string; resume?: string };
/** Schema version kept in settings; a database of another version is refused (no migrations). */
const SCHEMA = 6;
/**
 * The schema for either backend. Only key/indexed columns are VARCHAR on MySQL (index length limits); JSON documents
 * are LONGTEXT, timestamps BIGINT, and MySQL tables use utf8mb4 with binary (case-sensitive, like SQLite) collation.
 */
function schema(d: Dialect) {
  const my = d === "mysql", K = my ? "VARCHAR(255)" : "TEXT", T = my ? "LONGTEXT" : "TEXT", I = my ? "BIGINT" : "INTEGER";
  const auto = my ? "BIGINT AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY", table = my ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" : "";
  return [
    `CREATE TABLE settings(name ${K} PRIMARY KEY,value ${T} NOT NULL)`,
    `CREATE TABLE sessions(id ${K} PRIMARY KEY,data ${T} NOT NULL,updated ${I} NOT NULL,employee ${K},task ${K},owner ${K},source ${K})`,
    "CREATE INDEX sessions_employee ON sessions(employee)",
    "CREATE INDEX sessions_task ON sessions(task)",
    "CREATE INDEX sessions_owner ON sessions(owner,updated)",
    "CREATE INDEX sessions_source ON sessions(source)",
    "CREATE INDEX sessions_updated ON sessions(updated DESC)",
    // seq keeps insertion order for tasks created in the same millisecond.
    `CREATE TABLE employee_tasks(seq ${auto},id ${K} NOT NULL UNIQUE,employee ${K} NOT NULL,active ${I} NOT NULL,created ${I} NOT NULL,data ${T} NOT NULL)`,
    "CREATE INDEX employee_tasks_employee ON employee_tasks(employee,active,created)",
    `CREATE TABLE employee_runs(id ${auto},employee ${K} NOT NULL,task ${K} NOT NULL,data ${T} NOT NULL)`,
    "CREATE INDEX employee_runs_employee ON employee_runs(employee,id)",
    "CREATE INDEX employee_runs_task ON employee_runs(task)",
    // actor/client: the sender's idempotency key (actorId, clientMessageId), copied out of data for an index.
    `CREATE TABLE messages(session ${K} NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,seq ${I} NOT NULL,data ${T} NOT NULL,actor ${K},client ${K},PRIMARY KEY(session,seq))`,
    "CREATE INDEX messages_client ON messages(session,actor,client)",
    `CREATE TABLE folds(session ${K} NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,id ${K} NOT NULL,data ${T} NOT NULL,PRIMARY KEY(session,id))`,
    `CREATE TABLE objects(kind ${K} NOT NULL,id ${K} NOT NULL,data ${T} NOT NULL,PRIMARY KEY(kind,id))`,
    `CREATE TABLE blobs(id ${K} PRIMARY KEY,mime ${K} NOT NULL,data ${my ? "LONGBLOB" : "BLOB"} NOT NULL,created ${I} NOT NULL)`,
    `CREATE TABLE web_users(id ${K} PRIMARY KEY,username ${K} NOT NULL UNIQUE ${my ? "COLLATE utf8mb4_general_ci" : "COLLATE NOCASE"},password ${K} NOT NULL,role ${K} NOT NULL CHECK(role IN ('admin','operator','viewer')),disabled ${I} NOT NULL DEFAULT 0,createdAt ${I} NOT NULL,lastLogin ${I} NOT NULL DEFAULT 0)`,
    `CREATE TABLE web_sessions(hash ${K} PRIMARY KEY,userId ${K} NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,csrf ${K} NOT NULL,createdAt ${I} NOT NULL,expiresAt ${I} NOT NULL)`,
    "CREATE INDEX web_sessions_user ON web_sessions(userId)",
    `CREATE TABLE blob_access(blob_id ${K} NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,session ${K} NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,PRIMARY KEY(blob_id,session))`,
    "CREATE INDEX blob_access_session ON blob_access(session)",
    `CREATE TABLE blob_user_access(blob_id ${K} NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,user ${K} NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,PRIMARY KEY(blob_id,user))`,
    `CREATE TABLE token_usage(id ${auto},user ${K} NOT NULL,at ${I} NOT NULL,data ${T} NOT NULL)`,
    "CREATE INDEX token_usage_user ON token_usage(user,at)",
  ].map((statement) => (statement.startsWith("CREATE TABLE") ? statement + table : statement));
}

/**
 * All persistent state. Every method is async: SQLite runs in a worker thread and MySQL over a pool, so the event loop
 * never waits on the database. Read-modify-write sequences belong in `transaction` (see Db).
 */
export class Store {
  /** Screenshots, DOM records and oversized tool results live in files next to the database (see Files). */
  files: Files;
  private rowCache = new Map<string, { max: number; rows: Readonly<Message>[] }>();
  private constructor(readonly db: Db, files: string, private temporary: boolean) {
    this.files = new Files(files);
  }
  /**
   * Open the configured database: DB_TYPE=sqlite (default, file VEGA_DB or `target`) or DB_TYPE=mysql (see mysql.ts).
   * ":memory:" is a throwaway database (and file directory) removed on close, on either backend.
   */
  static async open(target = process.env.VEGA_DB || "vega.db") {
    const temporary = target === ":memory:";
    const files = temporary ? await mkdtemp(join(tmpdir(), "vega-files-")) : join(dirname(resolve(target)), "files");
    let db: Db;
    if ((process.env.DB_TYPE || "sqlite") === "mysql") {
      const { Mysql } = await import("./mysql");
      db = await Mysql.connect(temporary);
    } else {
      if (!temporary) await mkdir(dirname(resolve(target)), { recursive: true, mode: 0o700 });
      db = new Sqlite(target);
    }
    const store = new Store(db, files, temporary);
    try {
      await store.prepareSchema();
      if (db.dialect === "sqlite" && !temporary) await chmod(target, 0o600);
    } catch (e) {
      await store.close();
      throw e;
    }
    return store;
  }
  private async prepareSchema() {
    const tables = Number((await this.db.get(this.db.dialect === "sqlite"
      ? "SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      : "SELECT count(*) n FROM information_schema.tables WHERE table_schema=DATABASE()"))!.n);
    if (tables) {
      const version = await this.db.get("SELECT value FROM settings WHERE name='schema'").catch(() => undefined);
      assert(version && Number(version.value) === SCHEMA, "Not a supported Vega database; existing data left unchanged");
      await this.ensureTokenUsageTable();
      return;
    }
    await this.db.transaction(async () => {
      for (const statement of schema(this.db.dialect)) await this.db.exec(statement);
      await this.db.run("INSERT INTO settings VALUES(?,?)", ["schema", String(SCHEMA)]);
    });
  }
  async close() {
    await this.db.close();
    // A throwaway database's files are as temporary as it is.
    if (this.temporary) await rm(this.files.root, { recursive: true, force: true });
  }
  /** Run fn atomically, serialized with other transactions; nested calls become savepoints. */
  transaction<T>(fn: () => Promise<T>) { return this.db.transaction(fn); }
  afterCommit(fn: () => void) { this.db.afterCommit(fn); }
  // Raw statements in the portable SQL subset (see Db / Mysql.translate).
  all(sql: string, ...params: unknown[]) { return this.db.all(sql, params); }
  one(sql: string, ...params: unknown[]) { return this.db.get(sql, params); }
  run(sql: string, ...params: unknown[]) { return this.db.run(sql, params); }
  /** A JSON field of messages.data as text (the only dialect-specific expressions, used by lastMessage/findMessage). */
  private json(path: string) {
    assert(/^\$(\.\w+)+$/.test(path), "Invalid message field");
    return this.db.dialect === "sqlite" ? `json_extract(data,'${path}')` : `JSON_UNQUOTE(JSON_EXTRACT(data,'${path}'))`;
  }
  private jsonLength(path: string) {
    return (this.db.dialect === "sqlite" ? "json_array_length" : "JSON_LENGTH") + `(data,'${path}')`;
  }
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.one("SELECT value FROM settings WHERE name=?", key);
    return row ? JSON.parse(row.value) : structuredClone(fallback);
  }
  async put(key: string, value: any) {
    await this.run("INSERT INTO settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  }
  async unset(key: string) { await this.run("DELETE FROM settings WHERE name=?", key); }
  async objects<T = any>(kind: string): Promise<T[]> {
    return (await this.all("SELECT data FROM objects WHERE kind=?", kind)).map((r) => JSON.parse(r.data));
  }
  async object<T = any>(kind: string, key: string): Promise<T | undefined> {
    const r = await this.one("SELECT data FROM objects WHERE kind=? AND id=?", kind, key);
    return r ? JSON.parse(r.data) : undefined;
  }
  async save(kind: string, key: string, value: any) {
    await this.run("INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", kind, key, JSON.stringify(value));
  }
  async remove(kind: string, key: string) { await this.run("DELETE FROM objects WHERE kind=? AND id=?", kind, key); }
  async removeKind(kind: string) { await this.run("DELETE FROM objects WHERE kind=?", kind); }
  async blob(mime: string, data: Uint8Array) {
    const key = id("blob-");
    await this.run("INSERT INTO blobs VALUES(?,?,?,?)", key, mime, data, Date.now());
    return key;
  }
  async grantBlob(blob: string, session: string) {
    await this.run("INSERT OR IGNORE INTO blob_access SELECT ?,id FROM sessions WHERE id=?", blob, session);
  }
  async grantBlobUser(blob: string, userId: string) {
    await this.run("INSERT OR IGNORE INTO blob_user_access VALUES(?,?)", blob, userId);
  }
  async blobData(key: string) {
    return (await this.one("SELECT mime,data FROM blobs WHERE id=?", key)) as { mime: string; data: Uint8Array } | undefined;
  }
  // Resolve an image reference ({mime,blobId}, {mime,path} or inline {mime,data}) to the {mime,data:base64} the model
  // providers expect. Central lazy materialization point: only images that survive history trimming reach here.
  async imageData(image: { mime: string; data?: string; blobId?: string; path?: string }): Promise<{ mime: string; data: string }> {
    if (typeof image.data === "string") return { mime: image.mime, data: image.data };
    if (image.path) {
      try { return { mime: image.mime, data: (await this.files.read(image.path)).toString("base64") }; }
      catch { return { mime: image.mime, data: "" }; }
    }
    const blob = image.blobId ? await this.blobData(image.blobId) : undefined;
    if (!blob) return { mime: image.mime, data: "" };
    return { mime: blob.mime, data: Buffer.from(blob.data).toString("base64") };
  }
  async newSession(input: Partial<Session> = {}) {
    const cloud = cloudFor(input);
    const cwd = input.localAgent ? input.cwd! : cloud ? await cloud.cwd(input.employeeId && !input.taskId ? undefined : input.cwd) : resolve(input.cwd || process.cwd());
    assert(typeof cwd === "string" && cwd.length > 0, "cwd required");
    if (!input.localAgent && !cloud) assert((await stat(cwd)).isDirectory(), "cwd must be an existing directory");
    const s: Session = { ...input, id: id(), title: input.title || "新会话", cwd, createdAt: Date.now() };
    await this.saveSession(s);
    return s;
  }
  async saveSession(s: Session) {
    await this.run(
      "INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated,employee=excluded.employee,task=excluded.task,owner=excluded.owner,source=excluded.source",
      s.id, JSON.stringify(s), Date.now(), s.employeeId || null, s.taskId || null, s.ownerId || null, s.stageSource || null,
    );
  }
  async session(key: string): Promise<Session> {
    const row = await this.one("SELECT data FROM sessions WHERE id=?", key);
    assert(row, "Session not found");
    return JSON.parse(row.data);
  }
  async hasSession(key: string) { return !!(await this.one("SELECT 1 FROM sessions WHERE id=?", key)); }
  /** Every session, newest first: a full scan, so server paths use the indexed queries below instead. */
  async sessions(): Promise<Session[]> {
    return this.parseSessions(await this.all("SELECT data FROM sessions ORDER BY updated DESC"));
  }
  private parseSessions(rows: any[]): Session[] {
    return rows.map((r) => JSON.parse(r.data));
  }
  /** Sessions of one employee, task, owner or stage source (indexed columns), newest first. */
  async sessionsBy(column: "employee" | "task" | "owner" | "source", value: string): Promise<Session[]> {
    return this.parseSessions(await this.all(`SELECT data FROM sessions WHERE ${column}=? ORDER BY updated DESC`, value));
  }
  /** Ordinary conversations (no employee or task), newest first. */
  async plainSessions(): Promise<Session[]> {
    return this.parseSessions(await this.all("SELECT data FROM sessions WHERE employee IS NULL AND task IS NULL ORDER BY updated DESC"));
  }
  /** Employee chats and task sessions, newest first. */
  async employeeSessions(): Promise<Session[]> {
    return this.parseSessions(await this.all("SELECT data FROM sessions WHERE employee IS NOT NULL OR task IS NOT NULL ORDER BY updated DESC"));
  }
  /** A session and the stage sessions derived from it, transitively. */
  async sessionFamily(key: string): Promise<Session[]> {
    const out = [await this.session(key)];
    for (let i = 0; i < out.length; i++) out.push(...(await this.sessionsBy("source", out[i].id)));
    return out;
  }
  async deleteSession(key: string) {
    for (const s of await this.sessionFamily(key)) {
      this.rowCache.delete(s.id);
      await this.run("DELETE FROM sessions WHERE id=?", s.id);
      await this.files.remove(this.files.dir(s));
    }
  }
  /** Keep the session row; drop messages, folds, blob grants, context ledger and files. */
  async clearSessionHistory(key: string) {
    await this.files.remove(this.files.dir(await this.session(key)));
    this.rowCache.delete(key);
    await this.transaction(async () => {
      await this.run("DELETE FROM messages WHERE session=?", key);
      await this.run("DELETE FROM folds WHERE session=?", key);
      await this.run("DELETE FROM blob_access WHERE session=?", key);
      // 已读位置是按 seq 记的：新历史从 1 重新数，旧位置留着会让以后的未读永远算成 0。
      await this.run("DELETE FROM objects WHERE kind='read' AND id LIKE ?", "%/" + key);
      await this.remove("context-state", key);
      await this.run("UPDATE sessions SET updated=? WHERE id=?", Date.now(), key);
    });
  }
  // Employee tasks and runs (see employee-rows.ts): plain rows keyed by id, JSON data, indexed by employee.
  async employeeTasks(employee: string) {
    return (await this.all("SELECT id,data FROM employee_tasks WHERE employee=? ORDER BY created,seq", employee)) as { id: string; data: string }[];
  }
  async putEmployeeTask(employee: string, id: string, active: boolean, created: number, data: string) {
    await this.run(
      "INSERT INTO employee_tasks(id,employee,active,created,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET employee=excluded.employee,active=excluded.active,data=excluded.data",
      id, employee, active ? 1 : 0, created, data,
    );
  }
  async deleteEmployeeTask(id: string) { await this.run("DELETE FROM employee_tasks WHERE id=?", id); }
  /** One task without loading the employee's others. */
  async employeeTask(id: string): Promise<{ employee: string; task: any } | undefined> {
    const row = await this.one("SELECT employee,data FROM employee_tasks WHERE id=?", id);
    return row && { employee: row.employee, task: JSON.parse(row.data) };
  }
  async activeTaskCount(employee: string) {
    return Number((await this.one("SELECT count(*) n FROM employee_tasks WHERE employee=? AND active=1", employee))!.n);
  }
  /** Unfinished tasks whose status is running right now (drives the "working" avatar animation). */
  async runningTaskCount(employee: string) {
    const rows = await this.all("SELECT data FROM employee_tasks WHERE employee=? AND active=1", employee);
    return rows.filter((row: any) => JSON.parse(row.data).status === "running").length;
  }
  async employeeRuns(employee: string) {
    return (await this.all("SELECT id,data FROM employee_runs WHERE employee=? ORDER BY id", employee)) as { id: number; data: string }[];
  }
  async insertEmployeeRun(employee: string, task: string, data: string) {
    return (await this.run("INSERT INTO employee_runs(employee,task,data) VALUES(?,?,?)", employee, task, data)).lastId;
  }
  async updateEmployeeRun(id: number, data: string) { await this.run("UPDATE employee_runs SET data=? WHERE id=?", data, id); }
  async deleteEmployeeRun(id: number) { await this.run("DELETE FROM employee_runs WHERE id=?", id); }
  async dropEmployeeRows(employee: string) {
    await this.run("DELETE FROM employee_tasks WHERE employee=?", employee);
    await this.run("DELETE FROM employee_runs WHERE employee=?", employee);
  }
  private parseMessage(row: any): Message { return { ...JSON.parse(row.data), seq: Number(row.seq) }; }
  /**
   * Unread messages: one read marker (the last seq seen) per user and conversation, so reading writes one row per open,
   * never per message. Unread counts what others said after it: employees' visible replies and other users' messages in
   * a group (never tool output, system notices or the viewer's own messages); counting stops at UNREAD_MAX.
   */
  async markRead(user: string, session: string) {
    const last = (await this.one("SELECT MAX(seq) AS seq FROM messages WHERE session=?", session))?.seq;
    const seq = Number(last || 0), key = user + "/" + session;
    if (seq > ((await this.object<{ seq: number }>("read", key))?.seq || 0)) await this.save("read", key, { seq });
    return seq;
  }
  async unread(user: string, session: string) {
    let after = (await this.object<{ seq: number }>("read", user + "/" + session))?.seq || 0, count = 0;
    for (;;) {
      const rows = await this.all("SELECT seq,data FROM messages WHERE session=? AND seq>? ORDER BY seq LIMIT 200", session, after) as any[];
      for (const row of rows) {
        const m = this.parseMessage(row);
        const visible = m.role === "assistant" ? !!(m.text?.trim() || m.delivery || m.images?.length || m.tasks?.length) : m.role === "user" && !!m.author && m.actorId !== user;
        if (visible && !m.notice && ++count >= UNREAD_MAX) return count;
      }
      if (rows.length < 200) return count;
      after = Number(rows.at(-1).seq);
    }
  }
  /** Newest message of a session, optionally only an assistant message or one with images. */
  async lastMessage(key: string, only?: "assistant" | "user" | "images"): Promise<Message | undefined> {
    const where = only === "assistant" || only === "user" ? ` AND ${this.json("$.role")}='${only}'` : only === "images" ? ` AND ${this.jsonLength("$.images")}>0` : "";
    const row = await this.one(`SELECT seq,data FROM messages WHERE session=?${where} ORDER BY seq DESC LIMIT 1`, key);
    return row && this.parseMessage(row);
  }
  /**
   * Newest-first messages whose JSON field equals value (or is present, when value is undefined); parsed one at a time
   * until `match` accepts one.
   */
  async findMessage(key: string, field: string, value: string | number | boolean | undefined, match: (m: Message) => boolean = () => true): Promise<Message | undefined> {
    // Compare JSON values: SQLite extracts true as 1; MySQL compares against the value as JSON.
    const sqlite = this.db.dialect === "sqlite", extracted = this.json(field);
    const test = value === undefined ? `${extracted} IS NOT NULL` : sqlite ? `${extracted}=?` : `JSON_EXTRACT(data,'${field}')=CAST(? AS JSON)`;
    const params = value === undefined ? [] : [sqlite ? (typeof value === "boolean" ? Number(value) : value) : JSON.stringify(value)];
    for (const row of await this.all(`SELECT seq,data FROM messages WHERE session=? AND ${test} ORDER BY seq DESC`, key, ...params)) {
      const m = this.parseMessage(row);
      if (match(m)) return m;
    }
  }
  /** The message a sender already stored under its idempotency key (actorId + clientMessageId). */
  async clientMessage(key: string, actor: string, client: string) {
    const row = await this.one("SELECT seq,data FROM messages WHERE session=? AND actor=? AND client=?", key, actor, client);
    return row && this.parseMessage(row);
  }
  async lastSeq(key: string) {
    return Number((await this.one("SELECT COALESCE(MAX(seq),0) n FROM messages WHERE session=?", key))!.n);
  }
  async message(key: string, seq: number): Promise<Message | undefined> {
    const row = await this.one("SELECT seq,data FROM messages WHERE session=? AND seq=?", key, seq);
    return row && this.parseMessage(row);
  }
  async quote(key: string, seq: number): Promise<NonNullable<Message["quote"]>> {
    assert(Number.isSafeInteger(seq) && seq > 0, "Invalid quoted message");
    const message = await this.message(key, seq);
    assert(message && ["user", "assistant"].includes(message.role) && (message.text?.trim() || message.images?.length), "Quoted message not found in this conversation");
    const text = (message.displayText || message.text || "[图片]").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
    return { seq, role: message.role, text: text.length > 160 ? text.slice(0, 160) + "…" : text, taskId: message.tasks?.length === 1 ? message.tasks[0].id : undefined };
  }
  async messages(key: string): Promise<Message[]> {
    return (await this.all("SELECT seq,data FROM messages WHERE session=? ORDER BY seq", key)).map((r) => this.parseMessage(r));
  }
  /**
   * Read-only rows shared across callers (frozen). Messages are append-only, so only rows after the cached maximum
   * are parsed; any other change (clear, delete) is detected by the count/maximum and reloads the session.
   */
  async sharedMessages(key: string): Promise<{ rows: readonly Readonly<Message>[]; revision: string }> {
    const top = (await this.one("SELECT COALESCE(MAX(seq),0) m, COUNT(*) n FROM messages WHERE session=?", key)) as { m: number; n: number };
    const max = Number(top.m), count = Number(top.n);
    let cached = this.rowCache.get(key);
    if (cached && max > cached.max) {
      const from = cached.max, more = await this.all("SELECT seq,data FROM messages WHERE session=? AND seq>? ORDER BY seq", key, from);
      // Another caller may have extended the same cache meanwhile.
      if (cached.max === from) {
        for (const r of more) cached.rows.push(Object.freeze(this.parseMessage(r)));
        cached.max = Math.max(from, ...more.map((r) => Number(r.seq)));
      }
    }
    if (!cached || cached.max !== max || cached.rows.length !== count) {
      cached = { max, rows: (await this.messages(key)).map((m) => Object.freeze(m)) };
      cached.max = cached.rows.at(-1)?.seq ?? 0;
    }
    this.rowCache.delete(key);
    this.rowCache.set(key, cached);
    while (this.rowCache.size > 32) this.rowCache.delete(this.rowCache.keys().next().value!);
    return { rows: cached.rows, revision: `${cached.max}:${cached.rows.length}` };
  }
  /** Chat history window: the newest `limit` messages before `before`, or every message after `after`. */
  async messagePage(key: string, { before, after, limit }: { before?: number; after?: number; limit?: number }): Promise<{ messages: Message[]; hasMore: boolean }> {
    const older = async (seq: number | undefined) => seq !== undefined && !!(await this.one("SELECT 1 FROM messages WHERE session=? AND seq<? LIMIT 1", key, seq));
    if (after !== undefined) {
      const messages = (await this.all("SELECT seq,data FROM messages WHERE session=? AND seq>? ORDER BY seq", key, after)).map((r) => this.parseMessage(r));
      return { messages, hasMore: await older(messages[0]?.seq ?? after + 1) };
    }
    const rows = await this.all(`SELECT seq,data FROM messages WHERE session=? AND seq<? ORDER BY seq DESC${limit === undefined ? "" : " LIMIT " + Math.max(0, Math.floor(limit))}`, key, before ?? Number.MAX_SAFE_INTEGER);
    const messages = rows.reverse().map((r) => this.parseMessage(r));
    return { messages, hasMore: await older(messages[0]?.seq) };
  }
  async append(key: string, m: Message) {
    // In a transaction, so concurrent appends to one session get distinct, gapless seq numbers.
    return await this.transaction(async () => {
          const seq = (await this.lastSeq(key)) + 1, row = { ...m, seq, at: m.at || Date.now() };
          const client = m.actorId && m.clientMessageId ? [m.actorId, m.clientMessageId] : [null, null];
          await this.run("INSERT INTO messages VALUES(?,?,?,?,?)", key, seq, JSON.stringify(row), ...client);
          await this.run("UPDATE sessions SET updated=? WHERE id=?", Date.now(), key);
          return row;
        });
  }
  async fork(key: string) {
    const source = await this.session(key);
    assert(!source.taskId && !source.employeeId, "Employee history must continue through its workspace");
    const copy = await this.transaction(async () => {
      const copy = await this.newSession({ ...source, title: source.title + "（分叉）", taskId: undefined, fireRoot: undefined, fireRole: undefined });
      // The copy owns its files: the copied history points at its own directory (copied below).
      const from = this.files.dir(source), to = this.files.dir(copy);
      // 消息里可能嵌着已序列化的 JSON（工具结果），路径反斜杠会被多层转义：先换最深的一层，再往外换。
      const escaped = (value: string, depth: number) => value.replace(/\\/g, () => "\\".repeat(1 << depth));
      const rules = new Map<string, string>();
      for (let depth = 3; depth >= 0; depth--) rules.set(escaped(from, depth), escaped(to, depth));
      const moved = (text: string) => { for (const [a, b] of rules) text = text.replaceAll(a, b); return text; };
      for (const m of await this.messages(key)) await this.append(copy.id, JSON.parse(moved(JSON.stringify(m))));
      await this.run("INSERT INTO blob_access SELECT blob_id,? FROM blob_access WHERE session=?", copy.id, key);
      await this.run("INSERT INTO folds SELECT ?,id,data FROM folds WHERE session=?", copy.id, key);
      const state = await this.object<any>("context-state", key);
      if (state)
        await this.save("context-state", copy.id, { ...state, model: "", anchor: undefined, calibration: 1, lastUsage: undefined, baseline: 0, nudgeShown: 0, shownByTier: [0, 0, 0, 0] });
      return copy;
    });
    await this.files.copy(this.files.dir(source), this.files.dir(copy));
    return copy;
  }
  async stage(key: string, inherit = false) {
    const source = await this.session(key);
    assert(!source.taskId && !source.employeeId, "Employee history must continue through its workspace");
    return await this.newSession({
          cwd: source.cwd,
          title: "Stage",
          stageSource: key,
          ownerId: source.ownerId,
          localAgent: source.localAgent,
          localBrowser: source.localBrowser,
          localPlatform: source.localPlatform,
          clientId: source.clientId,
          clientName: source.clientName,
          browserClientId: source.browserClientId,
          executionCwds: source.executionCwds,
          readerIds: source.readerIds,
          model: inherit ? source.model : undefined,
          readOnly: source.readOnly,
        });
  }
  /** Read-only 分身 Stage for a parent session, including task/employee parents. Does not replace /stage. */
  async agentStage(source: Session, name: string) {
    return await this.newSession({
      cwd: source.cwd,
      title: `[分身] ${name}`,
      stageSource: source.id,
      spawnParent: source.id,
      agentName: name,
      agentChild: true,
      ownerId: source.ownerId,
      employeeId: source.employeeId,
      taskId: source.taskId,
      localAgent: source.localAgent,
      localBrowser: source.localBrowser,
      localPlatform: source.localPlatform,
      clientId: source.clientId,
      clientName: source.clientName,
      browserClientId: source.browserClientId,
      executionCwds: source.executionCwds,
      readerIds: source.readerIds,
      model: source.model,
      scene: source.scene,
      promptCacheKey: source.promptCacheKey || source.id,
      frozenSystem: source.frozenSystem,
      boostFrozen: source.boostFrozen,
      allowSpawnFrozen: source.allowSpawnFrozen,
      sceneEnumFrozen: source.sceneEnumFrozen,
      readOnly: false,
    });
  }
  async sessionsByStageSource(source: string) {
    const rows = await this.all("SELECT data FROM sessions WHERE source=? ORDER BY updated", source);
    return rows.map((row) => JSON.parse(row.data) as Session);
  }
  private async ensureTokenUsageTable() {
    const dialect = this.db.dialect;
    const exists = dialect === "sqlite"
      ? await this.one("SELECT name FROM sqlite_schema WHERE type='table' AND name='token_usage'")
      : await this.one("SELECT table_name name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='token_usage'");
    if (exists) return;
    const my = dialect === "mysql", K = my ? "VARCHAR(255)" : "TEXT", T = my ? "LONGTEXT" : "TEXT", I = my ? "BIGINT" : "INTEGER";
    const auto = my ? "BIGINT AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY";
    const table = my ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_bin" : "";
    await this.db.exec(`CREATE TABLE token_usage(id ${auto},user ${K} NOT NULL,at ${I} NOT NULL,data ${T} NOT NULL)${table}`);
    await this.db.exec("CREATE INDEX token_usage_user ON token_usage(user,at)");
  }
  async recordTokenUsage(row: {
    userId?: string;
    at?: number;
    model?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    session?: string;
    employee?: string;
    task?: string;
  }) {
    if (!row.userId) return;
    const at = row.at || Date.now();
    const total = row.total ?? (row.input || 0) + (row.output || 0) + (row.cacheRead || 0) + (row.cacheWrite || 0);
    await this.ensureTokenUsageTable();
    await this.run(
      "INSERT INTO token_usage(user,at,data) VALUES(?,?,?)",
      row.userId,
      at,
      JSON.stringify({ ...row, at, total }),
    );
  }
  private usageFilter(opts: { userId?: string; from?: number; to?: number }, withUser = true) {
    const params: unknown[] = [], where: string[] = [];
    if (withUser && opts.userId) { where.push("user=?"); params.push(opts.userId); }
    if (opts.from) { where.push("at>=?"); params.push(opts.from); }
    if (opts.to) { where.push("at<=?"); params.push(opts.to); }
    return { filter: where.length ? " WHERE " + where.join(" AND ") : "", params };
  }
  /** Totals for every row in the range, summed in SQL so a range never loads its rows into the process. */
  async tokenUsageSummary(opts: { userId?: string; from?: number; to?: number } = {}) {
    await this.ensureTokenUsageTable();
    const { filter, params } = this.usageFilter(opts);
    const sum = (key: string) => `COALESCE(SUM(${this.json("$." + key)}),0) ${key}`;
    const row = (await this.one(
      `SELECT COUNT(*) n,${["input", "output", "cacheRead", "cacheWrite", "total"].map(sum).join(",")} FROM token_usage${filter}`,
      ...params,
    ))!;
    const scope = this.usageFilter(opts, false);
    const users = (await this.all(`SELECT DISTINCT user FROM token_usage${scope.filter} ORDER BY user`, ...scope.params)).map((item) => String(item.user));
    return {
      n: Number(row.n) || 0, input: Number(row.input) || 0, output: Number(row.output) || 0,
      cacheRead: Number(row.cacheRead) || 0, cacheWrite: Number(row.cacheWrite) || 0, total: Number(row.total) || 0,
      users,
    };
  }
}
