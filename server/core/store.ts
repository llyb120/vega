import { DatabaseSync, type StatementSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Files } from "./files";
import { assert, id } from "./util";
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
  localPlatform?: string;
  clientId?: string;
  clientName?: string;
  executionCwds?: Record<string, string | undefined>;
  readOnly?: boolean;
  ownerId?: string;
  readerIds?: string[];
  fireRoot?: string;
  fireRole?: "work" | "judge";
  createdAt: number;
};
export class Store {
  db: DatabaseSync;
  /** Screenshots, DOM records and oversized tool results live in files next to the database (see Files). */
  files: Files;
  private memory: boolean;
  private rowCache = new Map<string, { max: number; rows: Readonly<Message>[] }>();
  depth = 0;
  constructor(path = process.env.VEGA_DB || "vega.db") {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.memory = path === ":memory:";
    this.files = new Files(this.memory ? mkdtempSync(join(tmpdir(), "vega-files-")) : join(dirname(resolve(path)), "files"));
    const app = Number(
        (this.db.prepare("PRAGMA application_id").get() as any).application_id,
      ),
      version = Number(
        (this.db.prepare("PRAGMA user_version").get() as any).user_version,
      ),
      tables = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get() as any
        ).n,
      );
    assert(
      (app === 0 || app === 1447380801) &&
        !(app === 0 && tables > 0) &&
        (tables === 0 || version === 5),
      "Not a supported Vega database; existing data left unchanged",
    );
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN;
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated INTEGER NOT NULL,employee TEXT,task TEXT,owner TEXT,source TEXT);
   CREATE INDEX IF NOT EXISTS sessions_employee ON sessions(employee);
   CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task);
   CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner,updated);
   CREATE INDEX IF NOT EXISTS sessions_source ON sessions(source);
   CREATE TABLE IF NOT EXISTS employee_tasks(id TEXT PRIMARY KEY,employee TEXT NOT NULL,active INTEGER NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS employee_tasks_employee ON employee_tasks(employee,active,created);
   CREATE TABLE IF NOT EXISTS employee_runs(id INTEGER PRIMARY KEY,employee TEXT NOT NULL,task TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS employee_runs_employee ON employee_runs(employee,id);
   CREATE INDEX IF NOT EXISTS employee_runs_task ON employee_runs(task);
   CREATE TABLE IF NOT EXISTS messages(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session,seq));
   CREATE INDEX IF NOT EXISTS messages_client_id ON messages(session,json_extract(data,'$.actorId'),json_extract(data,'$.clientMessageId')) WHERE json_extract(data,'$.clientMessageId') IS NOT NULL;
   CREATE TABLE IF NOT EXISTS folds(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session,id));
   CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY,mime TEXT NOT NULL,data BLOB NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS web_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),disabled INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,lastLogin INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS web_sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS web_sessions_user ON web_sessions(userId);
   CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated DESC);
   CREATE TABLE IF NOT EXISTS blob_access(blob TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,PRIMARY KEY(blob,session));
   CREATE INDEX IF NOT EXISTS blob_access_session ON blob_access(session);
   CREATE TABLE IF NOT EXISTS blob_user_access(blob TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,user TEXT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,PRIMARY KEY(blob,user));
   PRAGMA application_id=1447380801; PRAGMA user_version=5; COMMIT;`);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  /** Prepared statements are compiled once per SQL text and reused (one long-lived connection). */
  private statements = new Map<string, StatementSync>();
  sql(text: string) {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }
  close() {
    this.db.close();
    // An in-memory database's files are as temporary as it is.
    if (this.memory) rmSync(this.files.root, { recursive: true, force: true });
  }
  transaction<T>(fn: () => T) {
    const outer = this.depth === 0,
      name = "vega_" + this.depth;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : "SAVEPOINT " + name);
    this.depth++;
    try {
      const v = fn();
      this.db.exec(outer ? "COMMIT" : "RELEASE " + name);
      return v;
    } catch (e) {
      this.db.exec(outer ? "ROLLBACK" : "ROLLBACK TO " + name);
      if (!outer) this.db.exec("RELEASE " + name);
      throw e;
    } finally {
      this.depth--;
    }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.sql("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    return row ? JSON.parse(row.value) : structuredClone(fallback);
  }
  put(key: string, value: any) {
    this.sql(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  objects<T = any>(kind: string): T[] {
    return this.sql("SELECT data FROM objects WHERE kind=?")
      .all(kind)
      .map((r: any) => JSON.parse(r.data));
  }
  object<T = any>(kind: string, key: string): T | undefined {
    const r = this.sql("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, key) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  save(kind: string, key: string, value: any) {
    this.sql(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, key, JSON.stringify(value));
  }
  remove(kind: string, key: string) {
    this.sql("DELETE FROM objects WHERE kind=? AND id=?").run(kind, key);
  }
  blob(mime: string, data: Uint8Array) {
    const key = id("blob-");
    this.sql("INSERT INTO blobs VALUES(?,?,?,?)")
      .run(key, mime, data, Date.now());
    return key;
  }
  grantBlob(blob: string, session: string) {
    if (this.sql("SELECT id FROM sessions WHERE id=?").get(session))
      this.sql("INSERT OR IGNORE INTO blob_access VALUES(?,?)")
        .run(blob, session);
  }
  grantBlobUser(blob: string, userId: string) {
    this.sql("INSERT OR IGNORE INTO blob_user_access VALUES(?,?)").run(blob, userId);
  }
  blobData(key: string) {
    return this.sql("SELECT mime,data FROM blobs WHERE id=?")
      .get(key) as { mime: string; data: Uint8Array } | undefined;
  }
  // Resolve an image reference ({mime,blobId} or legacy {mime,data}) to the
  // {mime,data:base64} the model providers expect. Central lazy materialization
  // point: only images that survive history trimming reach here.
  imageData(image: { mime: string; data?: string; blobId?: string; path?: string }): {
    mime: string;
    data: string;
  } {
    if (typeof image.data === "string") return { mime: image.mime, data: image.data };
    if (image.path) {
      try { return { mime: image.mime, data: this.files.read(image.path).toString("base64") }; }
      catch { return { mime: image.mime, data: "" }; }
    }
    if (!image.blobId) return { mime: image.mime, data: "" };
    const blob = this.blobData(image.blobId);
    if (!blob) return { mime: image.mime, data: "" };
    return {
      mime: blob.mime,
      data: Buffer.from(blob.data).toString("base64"),
    };
  }
  newSession(input: Partial<Session> = {}) {
    const cwd = input.localAgent ? input.cwd! : resolve(input.cwd || process.cwd());
    assert(typeof cwd === "string" && cwd.length > 0, "cwd required");
    if (!input.localAgent) assert(statSync(cwd).isDirectory(), "cwd must be an existing directory");
    const s: Session = {
      ...input,
      id: id(),
      title: input.title || "新会话",
      cwd,
      createdAt: Date.now(),
    };
    this.saveSession(s);
    return s;
  }
  saveSession(s: Session) {
    this.sql(
        "INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated,employee=excluded.employee,task=excluded.task,owner=excluded.owner,source=excluded.source",
      )
      .run(s.id, JSON.stringify(s), Date.now(), s.employeeId || null, s.taskId || null, s.ownerId || null, s.stageSource || null);
  }
  session(key: string): Session {
    const row = this.sql("SELECT data FROM sessions WHERE id=?")
      .get(key) as any;
    assert(row, "Session not found");
    return JSON.parse(row.data);
  }
  /** Every session, newest first: a full scan, so server paths use the indexed queries below instead. */
  sessions(): Session[] {
    return this.parseSessions(this.sql("SELECT data FROM sessions ORDER BY updated DESC").all());
  }
  private parseSessions(rows: unknown[]): Session[] {
    return rows.map((r: any) => JSON.parse(r.data));
  }
  /** Sessions of one employee, task, owner or stage source (indexed columns), newest first. */
  sessionsBy(column: "employee" | "task" | "owner" | "source", value: string): Session[] {
    return this.parseSessions(this.sql(`SELECT data FROM sessions WHERE ${column}=? ORDER BY updated DESC`).all(value));
  }
  /** Ordinary conversations (no employee or task), newest first. */
  plainSessions(): Session[] {
    return this.parseSessions(this.sql("SELECT data FROM sessions WHERE employee IS NULL AND task IS NULL ORDER BY updated DESC").all());
  }
  /** Employee chats and task sessions, newest first. */
  employeeSessions(): Session[] {
    return this.parseSessions(this.sql("SELECT data FROM sessions WHERE employee IS NOT NULL OR task IS NOT NULL ORDER BY updated DESC").all());
  }
  /** A session and the stage sessions derived from it, transitively. */
  sessionFamily(key: string): Session[] {
    const out = [this.session(key)];
    for (let i = 0; i < out.length; i++) out.push(...this.sessionsBy("source", out[i].id));
    return out;
  }
  deleteSession(key: string) {
    for (const s of this.sessionFamily(key)) {
      this.sql("DELETE FROM sessions WHERE id=?").run(s.id);
      this.files.remove(this.files.dir(s));
    }
  }
  /** Keep the session row; drop messages, folds, blob grants, context ledger and files. */
  clearSessionHistory(key: string) {
    this.files.remove(this.files.dir(this.session(key)));
    this.rowCache.delete(key);
    this.transaction(() => {
      this.sql("DELETE FROM messages WHERE session=?").run(key);
      this.sql("DELETE FROM folds WHERE session=?").run(key);
      this.sql("DELETE FROM blob_access WHERE session=?").run(key);
      this.remove("context-state", key);
      this.sql("UPDATE sessions SET updated=? WHERE id=?").run(Date.now(), key);
    });
  }
  // Employee tasks and runs (see employee-rows.ts): plain rows keyed by id, JSON data, indexed by employee.
  employeeTasks(employee: string) {
    return this.sql("SELECT id,data FROM employee_tasks WHERE employee=? ORDER BY created,rowid").all(employee) as { id: string; data: string }[];
  }
  putEmployeeTask(employee: string, id: string, active: boolean, created: number, data: string) {
    this.sql("INSERT INTO employee_tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET employee=excluded.employee,active=excluded.active,data=excluded.data")
      .run(id, employee, active ? 1 : 0, created, data);
  }
  deleteEmployeeTask(id: string) { this.sql("DELETE FROM employee_tasks WHERE id=?").run(id); }
  /** One task without loading the employee's others. */
  employeeTask(id: string): { employee: string; task: any } | undefined {
    const row = this.sql("SELECT employee,data FROM employee_tasks WHERE id=?").get(id) as { employee: string; data: string } | undefined;
    return row && { employee: row.employee, task: JSON.parse(row.data) };
  }
  activeTaskCount(employee: string) {
    return Number((this.sql("SELECT count(*) n FROM employee_tasks WHERE employee=? AND active=1").get(employee) as any).n);
  }
  employeeRuns(employee: string) {
    return this.sql("SELECT id,data FROM employee_runs WHERE employee=? ORDER BY id").all(employee) as { id: number; data: string }[];
  }
  insertEmployeeRun(employee: string, task: string, data: string) {
    return Number(this.sql("INSERT INTO employee_runs(employee,task,data) VALUES(?,?,?)").run(employee, task, data).lastInsertRowid);
  }
  updateEmployeeRun(id: number, data: string) { this.sql("UPDATE employee_runs SET data=? WHERE id=?").run(data, id); }
  deleteEmployeeRun(id: number) { this.sql("DELETE FROM employee_runs WHERE id=?").run(id); }
  dropEmployeeRows(employee: string) {
    this.sql("DELETE FROM employee_tasks WHERE employee=?").run(employee);
    this.sql("DELETE FROM employee_runs WHERE employee=?").run(employee);
  }
  /** Newest message of a session, optionally only an assistant message or one with images. */
  lastMessage(key: string, only?: "assistant" | "images"): Message | undefined {
    const where = only === "assistant" ? " AND json_extract(data,'$.role')='assistant'" : only === "images" ? " AND json_array_length(data,'$.images')>0" : "";
    const row = this.sql(`SELECT seq,data FROM messages WHERE session=?${where} ORDER BY seq DESC LIMIT 1`).get(key) as any;
    return row ? { ...JSON.parse(row.data), seq: row.seq } : undefined;
  }
  /** Newest-first messages whose JSON field equals value; parsed one at a time until `match` accepts one. */
  findMessage(key: string, field: string, value: string | number, match: (m: Message) => boolean = () => true): Message | undefined {
    assert(/^\$(\.\w+)+$/.test(field), "Invalid message field");
    for (const row of this.sql(`SELECT seq,data FROM messages WHERE session=? AND json_extract(data,'${field}')=? ORDER BY seq DESC`).all(key, value) as any[]) {
      const m = { ...JSON.parse(row.data), seq: row.seq };
      if (match(m)) return m;
    }
  }
  message(key: string, seq: number): Message | undefined {
    const row = this.sql("SELECT data FROM messages WHERE session=? AND seq=?").get(key, seq) as { data: string } | undefined;
    return row ? { ...JSON.parse(row.data), seq } : undefined;
  }
  quote(key: string, seq: number): NonNullable<Message["quote"]> {
    assert(Number.isSafeInteger(seq) && seq > 0, "Invalid quoted message");
    const message = this.message(key, seq);
    assert(message && ["user", "assistant"].includes(message.role) && (message.text?.trim() || message.images?.length), "Quoted message not found in this conversation");
    const text = (message.displayText || message.text || "[图片]").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
    return { seq, role: message.role, text: text.length > 160 ? text.slice(0, 160) + "…" : text, taskId: message.tasks?.length === 1 ? message.tasks[0].id : undefined };
  }
  messages(key: string): Message[] {
    return this.sql("SELECT seq,data FROM messages WHERE session=? ORDER BY seq")
      .all(key)
      .map((r: any) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  /**
   * Read-only rows shared across callers (frozen). Messages are append-only, so only rows after the cached maximum
   * are parsed; any other change (clear, delete) is detected by the count/maximum and reloads the session.
   */
  sharedMessages(key: string): { rows: readonly Readonly<Message>[]; revision: string } {
    const top = this.sql("SELECT COALESCE(MAX(seq),0) m, COUNT(*) n FROM messages WHERE session=?")
      .get(key) as { m: number; n: number };
    let cached = this.rowCache.get(key);
    if (cached && top.m > cached.max) {
      for (const r of this.sql("SELECT seq,data FROM messages WHERE session=? AND seq>? ORDER BY seq")
        .all(key, cached.max) as any[])
        cached.rows.push(Object.freeze({ ...JSON.parse(r.data), seq: r.seq }));
      cached.max = top.m;
    }
    if (!cached || cached.max !== top.m || cached.rows.length !== top.n) {
      cached = { max: top.m, rows: this.messages(key).map((m) => Object.freeze(m)) };
    }
    this.rowCache.delete(key);
    this.rowCache.set(key, cached);
    while (this.rowCache.size > 32) this.rowCache.delete(this.rowCache.keys().next().value!);
    return { rows: cached.rows, revision: `${cached.max}:${cached.rows.length}` };
  }
  /** Chat history window: the newest `limit` messages before `before`, or every message after `after`. */
  messagePage(key: string, { before, after, limit }: { before?: number; after?: number; limit?: number }): { messages: Message[]; hasMore: boolean } {
    const parse = (r: any) => ({ ...JSON.parse(r.data), seq: r.seq });
    if (after !== undefined) {
      const rows = this.sql("SELECT seq,data FROM messages WHERE session=? AND seq>? ORDER BY seq").all(key, after);
      const first = (rows[0] as any)?.seq ?? after + 1;
      return { messages: rows.map(parse), hasMore: !!this.sql("SELECT 1 FROM messages WHERE session=? AND seq<? LIMIT 1").get(key, first) };
    }
    const rows = this.sql("SELECT seq,data FROM messages WHERE session=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(key, before ?? Number.MAX_SAFE_INTEGER, limit ?? -1)
      .reverse();
    const first = (rows[0] as any)?.seq;
    return { messages: rows.map(parse), hasMore: first !== undefined && !!this.sql("SELECT 1 FROM messages WHERE session=? AND seq<? LIMIT 1").get(key, first) };
  }
  append(key: string, m: Message) {
    return this.transaction(() => {
      const seq = Number(
        (
          this.sql(
              "SELECT COALESCE(MAX(seq),0)+1 n FROM messages WHERE session=?",
            )
            .get(key) as any
        ).n,
      );
      const row = { ...m, seq, at: m.at || Date.now() };
      this.sql("INSERT INTO messages VALUES(?,?,?)")
        .run(key, seq, JSON.stringify(row));
      this.sql("UPDATE sessions SET updated=? WHERE id=?")
        .run(Date.now(), key);
      return row;
    });
  }
  fork(key: string) {
    const source = this.session(key);
    assert(
      !source.taskId && !source.employeeId,
      "Employee history must continue through its workspace",
    );
    return this.transaction(() => {
      const copy = this.newSession({
        ...source,
        title: source.title + "（分叉）",
        taskId: undefined,
        fireRoot: undefined,
        fireRole: undefined,
      });
      // The copy owns its files: copy the directory and point the copied history at it.
      const from = this.files.dir(source), to = this.files.dir(copy);
      if (existsSync(from)) cpSync(from, to, { recursive: true });
      const moved = (text: string) => [[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]].reduce((t, [a, b]) => t.replaceAll(a, b), text);
      for (const m of this.messages(key)) this.append(copy.id, JSON.parse(moved(JSON.stringify(m))));
      this.sql("INSERT INTO blob_access SELECT blob,? FROM blob_access WHERE session=?").run(copy.id, key);
      for (const row of this.sql("SELECT id,data FROM folds WHERE session=?")
        .all(key) as any[])
        this.sql("INSERT INTO folds VALUES(?,?,?)")
          .run(copy.id, row.id, row.data);
      const state = this.object<any>("context-state", key);
      if (state)
        this.save("context-state", copy.id, {
          ...state,
          model: "",
          anchor: undefined,
          calibration: 1,
          lastUsage: undefined,
          baseline: 0,
          nudgeShown: 0,
          shownByTier: [0, 0, 0, 0],
        });
      return copy;
    });
  }
  stage(key: string, inherit = false) {
    const source = this.session(key);
    assert(
      !source.taskId && !source.employeeId,
      "Employee history must continue through its workspace",
    );
    return this.newSession({
      cwd: source.cwd,
      title: "Stage",
      stageSource: key,
      ownerId: source.ownerId,
      localAgent: source.localAgent,
      localPlatform: source.localPlatform,
      clientId: source.clientId,
      clientName: source.clientName,
      executionCwds: source.executionCwds,
      readerIds: source.readerIds,
      model: inherit ? source.model : undefined,
      readOnly: source.readOnly,
    });
  }
}
