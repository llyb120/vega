import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assert, id } from "./util";
export type Part = { type: string; [key: string]: any };
export type Message = {
  seq?: number;
  role: string;
  text?: string;
  displayText?: string;
  thinking?: string;
  signature?: string;
  opaque?: any[];
  calls?: Call[];
  callId?: string;
  name?: string;
  images?: { mime: string; data?: string; blobId?: string }[];
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
  localAgent?: boolean;
  localPlatform?: string;
  readOnly?: boolean;
  ownerId?: string;
  readerIds?: string[];
  fireRoot?: string;
  fireRole?: "work" | "judge";
  createdAt: number;
};
export class Store {
  db: DatabaseSync;
  depth = 0;
  constructor(path = process.env.VEGA_DB || "vega.db") {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
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
        version <= 4,
      "Not a supported Vega database; existing data left unchanged",
    );
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN;
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS messages(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session,seq));
   CREATE TABLE IF NOT EXISTS folds(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session,id));
   CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY,mime TEXT NOT NULL,data BLOB NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS web_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),disabled INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,lastLogin INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS web_sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS web_sessions_user ON web_sessions(userId);
   CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated DESC);
   CREATE TABLE IF NOT EXISTS blob_access(blob TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,PRIMARY KEY(blob,session));
   CREATE TABLE IF NOT EXISTS blob_user_access(blob TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,user TEXT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,PRIMARY KEY(blob,user));
   ${version < 4 ? "INSERT OR IGNORE INTO blob_access(blob,session) SELECT b.id,m.session FROM messages m,json_each(m.data,'$.images') image JOIN blobs b ON b.id=json_extract(image.value,'$.blobId');" : ""}
   PRAGMA application_id=1447380801; PRAGMA user_version=4; COMMIT;`);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  close() {
    this.db.close();
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
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as any;
    return row ? JSON.parse(row.value) : structuredClone(fallback);
  }
  put(key: string, value: any) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  objects<T = any>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM objects WHERE kind=?")
      .all(kind)
      .map((r: any) => JSON.parse(r.data));
  }
  object<T = any>(kind: string, key: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, key) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  save(kind: string, key: string, value: any) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, key, JSON.stringify(value));
  }
  remove(kind: string, key: string) {
    this.db.prepare("DELETE FROM objects WHERE kind=? AND id=?").run(kind, key);
  }
  blob(mime: string, data: Uint8Array) {
    const key = id("blob-");
    this.db
      .prepare("INSERT INTO blobs VALUES(?,?,?,?)")
      .run(key, mime, data, Date.now());
    return key;
  }
  grantBlob(blob: string, session: string) {
    if (this.db.prepare("SELECT id FROM sessions WHERE id=?").get(session))
      this.db
        .prepare("INSERT OR IGNORE INTO blob_access VALUES(?,?)")
        .run(blob, session);
  }
  grantBlobUser(blob: string, userId: string) {
    this.db.prepare("INSERT OR IGNORE INTO blob_user_access VALUES(?,?)").run(blob, userId);
  }
  blobData(key: string) {
    return this.db
      .prepare("SELECT mime,data FROM blobs WHERE id=?")
      .get(key) as { mime: string; data: Uint8Array } | undefined;
  }
  // Resolve an image reference ({mime,blobId} or legacy {mime,data}) to the
  // {mime,data:base64} the model providers expect. Central lazy materialization
  // point: only images that survive history trimming reach here.
  imageData(image: { mime: string; data?: string; blobId?: string }): {
    mime: string;
    data: string;
  } {
    if (typeof image.data === "string") return { mime: image.mime, data: image.data };
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
    this.db
      .prepare(
        "INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated",
      )
      .run(s.id, JSON.stringify(s), Date.now());
  }
  session(key: string): Session {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE id=?")
      .get(key) as any;
    assert(row, "Session not found");
    return JSON.parse(row.data);
  }
  sessions(): Session[] {
    return this.db
      .prepare("SELECT data FROM sessions ORDER BY updated DESC")
      .all()
      .map((r: any) => JSON.parse(r.data));
  }
  sessionFamily(key: string): Session[] {
    const all = this.sessions(),
      ids = new Set([key]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of all)
        if (s.stageSource && ids.has(s.stageSource) && !ids.has(s.id)) {
          ids.add(s.id);
          changed = true;
        }
    }
    return all.filter((s) => ids.has(s.id));
  }
  deleteSession(key: string) {
    for (const s of this.sessionFamily(key))
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(s.id);
  }
  messages(key: string): Message[] {
    return this.db
      .prepare("SELECT seq,data FROM messages WHERE session=? ORDER BY seq")
      .all(key)
      .map((r: any) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  append(key: string, m: Message) {
    return this.transaction(() => {
      const seq = Number(
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(seq),0)+1 n FROM messages WHERE session=?",
            )
            .get(key) as any
        ).n,
      );
      const row = { ...m, seq, at: m.at || Date.now() };
      this.db
        .prepare("INSERT INTO messages VALUES(?,?,?)")
        .run(key, seq, JSON.stringify(row));
      this.db
        .prepare("UPDATE sessions SET updated=? WHERE id=?")
        .run(Date.now(), key);
      return row;
    });
  }
  fork(key: string) {
    const source = this.session(key);
    assert(
      !source.taskId,
      "Employee task history must continue through task controls",
    );
    return this.transaction(() => {
      const copy = this.newSession({
        ...source,
        title: source.title + "（分叉）",
        taskId: undefined,
        fireRoot: undefined,
        fireRole: undefined,
      });
      for (const m of this.messages(key)) this.append(copy.id, m);
      this.db.prepare("INSERT INTO blob_access SELECT blob,? FROM blob_access WHERE session=?").run(copy.id, key);
      for (const row of this.db
        .prepare("SELECT id,data FROM folds WHERE session=?")
        .all(key) as any[])
        this.db
          .prepare("INSERT INTO folds VALUES(?,?,?)")
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
      !source.taskId,
      "Employee task history must continue through task controls",
    );
    return this.newSession({
      cwd: source.cwd,
      title: "Stage",
      stageSource: key,
      ownerId: source.ownerId,
      localAgent: source.localAgent,
      localPlatform: source.localPlatform,
      readerIds: source.readerIds,
      model: inherit ? source.model : undefined,
      readOnly: source.readOnly,
    });
  }
}
