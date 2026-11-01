import {
  randomBytes,
  scrypt as derive,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { EventEmitter } from "node:events";
import type { Store, Session } from "./store";
export type Role = "admin" | "operator" | "viewer";
export type User = {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  lastLogin: number;
};
export type Principal = {
  user: User;
  hash: string;
  csrf: string;
  expiresAt: number;
};
export class AuthError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function check(
  ok: unknown,
  status: number,
  message: string,
): asserts ok {
  if (!ok) throw new AuthError(status, message);
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const TTL = 7 * 24 * 60 * 60 * 1000;
const dummy =
  "scrypt1:" +
  Buffer.alloc(16).toString("hex") +
  ":" +
  Buffer.alloc(64).toString("hex");
const roles: Role[] = ["admin", "operator", "viewer"];
function username(value: unknown) {
  check(
    typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value),
    400,
    "Username must be 3–64 letters, digits, dot, underscore or hyphen",
  );
  return value.toLowerCase();
}
function password(value: unknown) {
  check(
    typeof value === "string" &&
      [...value].length >= 12 &&
      Buffer.byteLength(value) <= 256,
    400,
    "Password must contain at least12 characters and at most256 UTF-8 bytes",
  );
  return value;
}
async function key(value: string, salt: Buffer) {
  return new Promise<Buffer>((yes, no) =>
    derive(
      value,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 << 20 },
      (error, bytes) => (error ? no(error) : yes(bytes)),
    ),
  );
}
async function encoded(value: string) {
  const salt = randomBytes(16);
  return (
    "scrypt1:" +
    salt.toString("hex") +
    ":" +
    (await key(value, salt)).toString("hex")
  );
}
async function verify(value: string, stored: string) {
  const [version, salt, hash] = stored.split(":");
  if (
    version !== "scrypt1" ||
    !/^\w{32}$/.test(salt) ||
    !/^\w{128}$/.test(hash)
  )
    return false;
  return equal(
    (await key(value, Buffer.from(salt, "hex"))).toString("hex"),
    hash,
  );
}
export class Auth {
  events = new EventEmitter();
  running = 0;
  attempts = new Map<string, { count: number; expires: number }>();
  constructor(
    public store: Store,
    public setupToken: string,
  ) {
    this.events.setMaxListeners(256);
  }
  hasUsers() {
    return (
      Number(
        (this.store.db.prepare("SELECT count(*) n FROM web_users").get() as any)
          .n,
      ) > 0
    );
  }
  user(id: string): User | undefined {
    const row = this.store.db
      .prepare(
        "SELECT id,username,role,disabled,createdAt,lastLogin FROM web_users WHERE id=?",
      )
      .get(id) as any;
    return row ? { ...row, disabled: !!row.disabled } : undefined;
  }
  users() {
    return (
      this.store.db
        .prepare(
          "SELECT id,username,role,disabled,createdAt,lastLogin FROM web_users ORDER BY createdAt,id",
        )
        .all() as any[]
    ).map((row) => ({ ...row, disabled: !!row.disabled })) as User[];
  }
  async crypto<T>(fn: () => Promise<T>) {
    check(this.running < 4, 429, "Too many login requests; try again shortly");
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
    }
  }
  rate(ip: string, name: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.expires <= now) this.attempts.delete(key);
    check(this.attempts.size < 2048, 429, "Login temporarily rate limited");
    for (const [key, limit] of [
      ["ip:" + ip, 40],
      ["user:" + digest(name), 12],
    ] as [string, number][]) {
      const bucket = this.attempts.get(key) || {
        count: 0,
        expires: now + 15 * 60 * 1000,
      };
      check(
        bucket.count < limit,
        429,
        "Too many login attempts; try again in15 minutes",
      );
      bucket.count++;
      this.attempts.set(key, bucket);
    }
  }
  issue(user: User) {
    const token = randomBytes(32).toString("base64url"),
      hash = digest(token),
      csrf = randomBytes(32).toString("base64url"),
      expiresAt = Date.now() + TTL;
    this.store.db
      .prepare("DELETE FROM web_sessions WHERE expiresAt<=?")
      .run(Date.now());
    this.store.db
      .prepare(
        "DELETE FROM web_sessions WHERE hash IN (SELECT hash FROM web_sessions WHERE userId=? ORDER BY createdAt DESC LIMIT -1 OFFSET 19)",
      )
      .run(user.id);
    this.store.db
      .prepare("INSERT INTO web_sessions VALUES(?,?,?,?,?)")
      .run(hash, user.id, csrf, Date.now(), expiresAt);
    this.store.db
      .prepare("UPDATE web_users SET lastLogin=? WHERE id=?")
      .run(Date.now(), user.id);
    return {
      token,
      principal: { user: this.user(user.id)!, hash, csrf, expiresAt },
    };
  }
  resolveHash(hash: string): Principal | undefined {
    const row = this.store.db
      .prepare("SELECT userId,csrf,expiresAt FROM web_sessions WHERE hash=?")
      .get(hash) as any;
    if (!row || row.expiresAt <= Date.now()) return;
    const user = this.user(row.userId);
    if (!user || user.disabled) return;
    return { user, hash, csrf: row.csrf, expiresAt: row.expiresAt };
  }
  authenticate(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    return this.resolveHash(digest(token));
  }
  revoke(id: string) {
    this.store.db.prepare("DELETE FROM web_sessions WHERE userId=?").run(id);
    this.events.emit("revoke", id);
  }
  logout(hash: string) {
    this.store.db.prepare("DELETE FROM web_sessions WHERE hash=?").run(hash);
    this.events.emit("logout", hash);
  }
  async setup(a: Record<string, any>, ip = "local") {
    check(!this.hasUsers(), 409, "Initial administrator already exists");
    this.rate(ip, "initial-admin");
    check(
      typeof a.setupToken === "string" && equal(a.setupToken, this.setupToken),
      401,
      "Initial setup token invalid",
    );
    const name = username(a.username),
      pass = password(a.password),
      hash = await this.crypto(() => encoded(pass));
    return this.store.transaction(() => {
      check(!this.hasUsers(), 409, "Initial administrator already exists");
      const id = randomBytes(16).toString("hex");
      this.store.db
        .prepare("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)")
        .run(id, name, hash, "admin", 0, Date.now(), 0);
      return this.issue(this.user(id)!);
    });
  }
  async login(a: Record<string, any>, ip = "local") {
    const name =
      typeof a.username === "string"
        ? a.username.toLowerCase().slice(0, 64)
        : "";
    this.rate(ip, name);
    check(
      typeof a.password === "string" && Buffer.byteLength(a.password) <= 256,
      401,
      "Invalid username or password",
    );
    const row = this.store.db
      .prepare(
        "SELECT id,password FROM web_users WHERE username=? COLLATE NOCASE",
      )
      .get(name) as any;
    const stored = row?.password || dummy;
    const valid = await this.crypto(() => verify(a.password, stored));
    const user = row && this.user(row.id),
      current =
        row &&
        (this.store.db
          .prepare("SELECT password FROM web_users WHERE id=?")
          .get(row.id) as any);
    check(
      valid && user && !user.disabled && current?.password === stored,
      401,
      "Invalid username or password",
    );
    this.attempts.delete("user:" + digest(name));
    return this.issue(user);
  }
  async add(a: Record<string, any>) {
    const name = username(a.username),
      pass = password(a.password);
    check(roles.includes(a.role), 400, "Invalid role");
    const hash = await this.crypto(() => encoded(pass));
    return this.store.transaction(() => {
      check(this.users().length < 100, 400, "Maximum100 users");
      check(
        !this.users().some((u) => u.username === name),
        409,
        "Username already exists",
      );
      const id = randomBytes(16).toString("hex");
      this.store.db
        .prepare("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)")
        .run(id, name, hash, a.role, 0, Date.now(), 0);
      return this.user(id)!;
    });
  }
  async update(id: string, a: Record<string, any>) {
    check(
      Object.keys(a).every((k) => ["role", "disabled", "password"].includes(k)),
      400,
      "Only role,disabled orpassword can be updated",
    );
    if (a.role !== undefined)
      check(roles.includes(a.role), 400, "Invalid role");
    if (a.disabled !== undefined)
      check(typeof a.disabled === "boolean", 400, "disabled must be boolean");
    const hash =
      a.password !== undefined
        ? await this.crypto(() => encoded(password(a.password)))
        : undefined;
    const user = this.store.transaction(() => {
      const old = this.user(id);
      check(old, 404, "User not found");
      const next = {
        ...old,
        role: a.role ?? old.role,
        disabled: a.disabled ?? old.disabled,
      };
      if (
        old.role === "admin" &&
        !old.disabled &&
        (next.disabled || next.role !== "admin")
      )
        check(
          this.users().some(
            (u) => u.id !== id && u.role === "admin" && !u.disabled,
          ),
          409,
          "Cannot disable or demote the last enabled administrator",
        );
      this.store.db
        .prepare("UPDATE web_users SET role=?,disabled=? WHERE id=?")
        .run(next.role, next.disabled ? 1 : 0, id);
      if (hash)
        this.store.db
          .prepare("UPDATE web_users SET password=? WHERE id=?")
          .run(hash, id);
      return this.user(id)!;
    });
    this.revoke(id);
    return user;
  }
  async changePassword(id: string, current: unknown, next: unknown) {
    const row = this.store.db
      .prepare("SELECT password FROM web_users WHERE id=?")
      .get(id) as any;
    check(row, 401, "Please sign in again");
    check(
      typeof current === "string" && Buffer.byteLength(current) <= 256,
      400,
      "Current password required",
    );
    const valid = await this.crypto(() => verify(current, row.password));
    check(valid, 401, "Current password invalid");
    const hash = await this.crypto(() => encoded(password(next)));
    const latest = this.store.db
      .prepare("SELECT password FROM web_users WHERE id=?")
      .get(id) as any;
    check(
      latest?.password === row.password,
      409,
      "Password changed concurrently; sign in again",
    );
    this.store.db
      .prepare("UPDATE web_users SET password=? WHERE id=?")
      .run(hash, id);
    this.revoke(id);
  }
  canRead(user: User, session: Session) {
    if (session.employeeId) {
      const employee = session.employeeId === "default"
        ? this.store.get<any>("employee", {})
        : this.store.object<any>("employee", session.employeeId);
      if (employee) {
        const owner = employee.ownerId ? this.user(employee.ownerId) : undefined;
        if (employee.scope === "team" || (!employee.scope && (session.employeeId === "default" || owner?.role === "admin"))) return true;
        if (user.role === "admin" || employee.ownerId === user.id) return true;
      }
    }
    return (
      session.ownerId === user.id ||
      (user.role === "admin" && (!session.ownerId || !!session.taskId))
    );
  }
  canWrite(user: User, session: Session) {
    return (
      user.role !== "viewer" &&
      (user.role === "admin" || session.ownerId === user.id)
    );
  }
  session(user: User, id: string, write = false) {
    let session: Session;
    try {
      session = this.store.session(id);
    } catch {
      throw new AuthError(404, "Session not found");
    }
    check(this.canRead(user, session), 404, "Session not found");
    if (write)
      check(
        this.canWrite(user, session),
        403,
        "This session is read-only for your account",
      );
    return session;
  }
  canBlob(user: User, id: string) {
    if (this.store.db.prepare("SELECT 1 FROM blob_user_access WHERE blob=? AND user=?").get(id, user.id)) return true;
    const rows = this.store.db
      .prepare("SELECT session FROM blob_access WHERE blob=?")
      .all(id) as any[];
    return rows.some((row) => {
      try {
        return this.canRead(user, this.store.session(row.session));
      } catch {
        return false;
      }
    });
  }
}
