import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Session } from "./store";
import { assert } from "./util";

export const IMAGE_TYPES: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/**
 * Local files for results too large or too stale for the model context: Chrome screenshots, Chrome DOM records and
 * oversized tool results. History keeps a preview plus the absolute path; `read` loads it back.
 *
 * Layout under root: employees/<employeeId>/<taskId or sessionId>/… for employee sessions (one directory per task, shared
 * by its work and computer sessions), users/<ownerId>/<sessionId>/… for other sessions, views/<userId>/… for the
 * signed-in user's browser view. A session may read anything under its employee (or owner) directory.
 */
export class Files {
  constructor(readonly root: string) {}
  private user(id?: string) { return join(this.root, "users", id || "_"); }
  employee(id: string) { return join(this.root, "employees", id); }
  task(employeeId: string, taskId: string) { return join(this.employee(employeeId), taskId); }
  /** Where a session (or "browser-view:<userId>") writes. */
  dir(owner: Session | string) {
    if (typeof owner === "string") {
      assert(owner.startsWith("browser-view:"), "Unknown file owner");
      return join(this.root, "views", owner.slice("browser-view:".length) || "_");
    }
    return owner.employeeId ? this.task(owner.employeeId, owner.taskId || owner.id) : join(this.user(owner.ownerId), owner.id);
  }
  /** What a session may read back. */
  scope(session: Session) { return session.employeeId ? this.employee(session.employeeId) : this.user(session.ownerId); }
  write(owner: Session | string, name: string, data: Uint8Array | string) {
    const dir = this.dir(owner), path = join(dir, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    return path;
  }
  /** The web address of a file under root. */
  url(path: string) { return "/api/files/" + relative(this.root, path).split(sep).map(encodeURIComponent).join("/"); }
  /** A path under root, or undefined when it is outside (an ordinary file). */
  own(path: string) {
    const full = resolve(path);
    return full.startsWith(this.root + sep) ? full : undefined;
  }
  /** Absolute path for a web address segment list, kept inside root. */
  fromUrl(parts: string[]) {
    const full = resolve(this.root, ...parts.map(decodeURIComponent));
    assert(full.startsWith(this.root + sep), "Invalid file path");
    return full;
  }
  inside(path: string, dir: string) { return resolve(path).startsWith(dir + sep); }
  readable(session: Session, path: string) {
    const full = this.own(path);
    assert(full && this.inside(full, this.scope(session)), "只能读取本牛马（普通会话为本人）的存档文件");
    return full;
  }
  read(path: string) { return readFileSync(path); }
  mime(path: string) { return IMAGE_TYPES[extname(path).toLowerCase()]; }
  remove(dir: string) {
    assert(this.inside(dir, this.root), "Invalid file directory");
    rmSync(dir, { recursive: true, force: true });
  }
}
