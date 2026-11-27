import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Session } from "./store";
import { assert } from "./util";

export const IMAGE_TYPES: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

const TASK_SHOT = /^[a-f\d]{32}(?:-\d+)?\.(?:webp|png|jpe?g)$/i;
const SOM_SHOT = /^([a-f\d]{32}(?:-\d+)?|appuse-[\w.-]+)-som\.(webp|png|jpe?g)$/i;
const TASK_SHOT_URL = /^\/api\/(?:[\w-]+\/)*files\/employees\/([\w%-]+)\/([\w-]+)\/([\w.-]+)([?#].*)?$/;
// shortcut: task reports use inline images, extend alongside the renderer if reference-style images are added.
const INLINE_IMAGE = /(`+)[^\n]*?\1|\\!|(!\[[^\]\n]*\]\([ \t]*)(<[^<>\r\n]+>|[^()<>\s]+)([ \t]*(?:(?:"[^"\r\n]*"|'[^'\r\n]*')[ \t]*)?\))/g;

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
  preview(employeeId: string, taskId: string, previewId: string) { return join(this.task(employeeId, taskId), "previews", previewId); }
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
  async write(owner: Session | string, name: string, data: Uint8Array | string) {
    const dir = this.dir(owner), path = join(dir, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
    return path;
  }
  /** The web address of a file under root. */
  url(path: string) { return "/api/files/" + relative(this.root, path).split(sep).map(encodeURIComponent).join("/"); }
  private async taskShotUrl(employeeId: string, taskId: string, value: string) {
    const link = TASK_SHOT_URL.exec(value), rawName = link ? link[3] : value;
    const som = SOM_SHOT.exec(rawName);
    const name = som ? `${som[1]}.${som[2]}` : rawName;
    if (som) {
      if (link && link[1] === encodeURIComponent(employeeId)) {
        const targetTaskId = link[2] || taskId;
        const cleanPath = join(this.task(employeeId, targetTaskId), name);
        if (await lstat(cleanPath).then((file) => file.isFile(), () => false)) return this.url(cleanPath) + (link[4] || "");
      } else if (!link) {
        const cleanPath = join(this.task(employeeId, taskId), name);
        if (await lstat(cleanPath).then((file) => file.isFile(), () => false)) return this.url(cleanPath);
      }
      return;
    }
    if (!TASK_SHOT.test(name) || (link && (link[1] !== encodeURIComponent(employeeId) || link[2] === taskId))) return;
    const path = join(this.task(employeeId, taskId), name);
    if (!await lstat(path).then((file) => file.isFile(), () => false)) return;
    // An explicit link to another real archive wins. Only fix missing targets using this task's actual file.
    if (link && await lstat(join(this.task(employeeId, link[2]), name)).then(() => true,
      (e: NodeJS.ErrnoException) => e.code !== "ENOENT" && e.code !== "ENOTDIR")) return;
    return this.url(path) + (link?.[4] || "");
  }
  /** Resolve a task-scoped screenshot/archive/blob image reference into a safe web URL, or undefined if invalid/external. */
  async resolveTaskImageUrl(scope: Pick<Session, "employeeId" | "taskId">, raw: string): Promise<string | undefined> {
    const value = String(raw || "").trim();
    if (!value || /\s|[\u0000-\u001f\u007f]/.test(value) || value.includes("..")) return undefined;
    const blob = /^(?:\/api\/blobs\/|sqlite:blob\/)(blob-[a-f\d]{32})$/i.exec(value);
    if (blob) return "/api/blobs/" + blob[1];
    if (scope.employeeId && scope.taskId) {
      const resolved = await this.taskShotUrl(scope.employeeId, scope.taskId, value);
      if (resolved) return resolved;
    }
    if (/^\/api\/files\/(?:[\w.%-]+\/)*[\w.%-]+\.(?:webp|png|jpe?g)$/i.test(value) && !/(^|\/)\.\.?(\/|$)/.test(value.slice(11))) {
      return value;
    }
    const own = this.own(value);
    if (own && this.mime(own) && await lstat(own).then((file) => file.isFile(), () => false)) {
      return this.url(own);
    }
    return undefined;
  }
  async resolveTaskScreenshots({ employeeId, taskId }: Pick<Session, "employeeId" | "taskId">, text: string) {
    if (!employeeId || !taskId || !text.includes("![")) return text;
    const urls = new Map<string, Promise<string | undefined>>();
    let fence = "";
    const lines = text.split("\n").map((line) => {
      const mark = /^[ \t]*(`{3,}|~{3,})(.*)/.exec(line);
      if (fence) {
        if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = "";
        return line;
      }
      if (mark) { fence = mark[1]; return line; }
      const matches = [...line.matchAll(INLINE_IMAGE)];
      if (!matches.some((m) => m[3])) return line;
      return Promise.all(matches.map(async ([original, , prefix, dest, end]) => {
        if (!dest) return original;
        const value = dest.startsWith("<") ? dest.slice(1, -1) : dest;
        if (!urls.has(value)) urls.set(value, this.taskShotUrl(employeeId, taskId, value));
        const url = await urls.get(value);
        return url ? `${prefix}<${url}>${end}` : original;
      })).then((replacements) => {
        let i = 0;
        return line.replace(INLINE_IMAGE, () => replacements[i++]!);
      });
    });
    return (await Promise.all(lines)).join("\n");
  }
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
    assert(full && this.inside(full, this.scope(session)), "只能读取当前热心市民的存档文件（普通会话只能读本人的存档）");
    return full;
  }
  read(path: string) { return readFile(path); }
  /** A message attachment saved for a run (attachments.ts): read like an ordinary file, not as an archive record. */
  attachment(path: string) { return relative(this.root, path).split(sep).includes("attachments"); }
  mime(path: string) { return IMAGE_TYPES[extname(path).toLowerCase()]; }
  async remove(dir: string) {
    assert(this.inside(dir, this.root), "Invalid file directory");
    await rm(dir, { recursive: true, force: true });
  }
  /** Copy a directory (a forked session's files), if it exists. */
  async copy(from: string, to: string) {
    assert(this.inside(from, this.root) && this.inside(to, this.root), "Invalid file directory");
    await cp(from, to, { recursive: true }).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }
}
