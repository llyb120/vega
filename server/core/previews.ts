import { randomBytes } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { basename, extname, posix, resolve, win32 } from "node:path";
import type { Auth } from "./auth";
import { localRead, type Agent, type LocalAgents } from "./local-agent";
import type { Store } from "./store";
import { absoluteFilePath, assert, id, Redactor, withinRoot } from "./util";

export type PreviewRef = {
  id: string;
  title: string;
  entry: string;
  url: string;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
};

export type PreviewRecord = PreviewRef & {
  employeeId: string;
  taskId: string;
  ownerId: string;
  groupId?: string;
};

export type CollectedPreview = {
  title: string;
  entry: string;
  files: { relPath: string; data: Buffer }[];
  totalBytes: number;
};

export const PREVIEW_ID_RE = /^pv-[a-f\d]{32}$/;
export const PREVIEW_MAX_FILES = 200;
export const PREVIEW_MAX_FILE_BYTES = 25 << 20;
export const PREVIEW_MAX_TOTAL_BYTES = 64 << 20;
export const PREVIEW_MAX_DEPTH = 12;

const FORBIDDEN = /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa[^\\/]*)(?:[\\/]|$)|\.(?:pem|key|pfx|p12|keystore)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", "__MACOSX", ".svn", ".hg"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

export const PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

export function isSandboxedPreviewMime(ext: string) {
  return [".html", ".htm", ".svg", ".xml", ".xhtml"].includes(ext.toLowerCase());
}

export function normalizeEntryPath(raw?: string): string {
  const input = raw === undefined || raw === null || !String(raw).trim() ? "index.html" : String(raw).trim();
  assert(!input.includes("\0") && !/[\u0000-\u001f]/.test(input), "入口路径包含非法字符");
  const clean = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = clean.split("/");
  assert(
    clean.length > 0 && clean.length <= 256 && parts.every((seg) => seg && seg !== "." && seg !== ".."),
    "入口路径必须是静态目录内的相对 HTML 文件路径",
  );
  assert(/\.html?$/i.test(clean), "入口文件必须是 .html 或 .htm 文件");
  return clean;
}

export async function collectStaticDirectory(opts: {
  dir: string;
  entry?: string;
  title?: string;
  cwd: string;
  extraRoots?: string[];
  fs?: typeof filesystem;
  agent?: Agent;
  hub?: LocalAgents;
  redactor?: Redactor;
  signal?: AbortSignal;
  windows?: boolean;
}): Promise<CollectedPreview> {
  assert(typeof opts.dir === "string" && opts.dir.trim() && opts.dir.length <= 4096 && !FORBIDDEN.test(opts.dir), "静态预览目录无效或指向凭据路径");
  absoluteFilePath(opts.dir, opts.windows);
  const entry = normalizeEntryPath(opts.entry);
  const files: { relPath: string; data: Buffer }[] = [];
  let totalBytes = 0;

  const checkSecrets = (data: Buffer) => {
    for (const secret of opts.redactor?.values || []) {
      assert(!secret || !data.includes(Buffer.from(secret)), "预览目录文件含有本轮凭据，不能发布");
    }
  };

  const addFile = (relPath: string, data: Buffer) => {
    assert(!FORBIDDEN.test(relPath), `预览目录包含凭据文件（${relPath}），拒绝发布`);
    assert(files.length < PREVIEW_MAX_FILES, `静态预览最多包含 ${PREVIEW_MAX_FILES} 个文件`);
    assert(data.length <= PREVIEW_MAX_FILE_BYTES, `单个预览文件不能超过 ${Math.round(PREVIEW_MAX_FILE_BYTES / (1 << 20))}MiB`);
    totalBytes += data.length;
    assert(totalBytes <= PREVIEW_MAX_TOTAL_BYTES, `静态预览总大小不能超过 ${Math.round(PREVIEW_MAX_TOTAL_BYTES / (1 << 20))}MiB`);
    checkSecrets(data);
    files.push({ relPath, data });
  };

  if (opts.agent && opts.hub) {
    const signal = opts.signal!;
    const statRes = await opts.hub.request(opts.agent, "file", { op: "stat", cwd: opts.cwd, path: opts.dir }, signal);
    assert(statRes.isDir && typeof statRes.path === "string", "静态预览目录必须是执行端工作区内的已存在目录");
    const listed = await opts.hub.request(opts.agent, "file", { op: "list", cwd: opts.cwd, path: opts.dir }, signal);
    assert(!listed.error && Array.isArray(listed.files), String(listed.error || "无法列出本机静态预览目录"));
    const baseDir = String(listed.root || statRes.path);
    const joinLocal = (opts.windows ? win32 : posix).join;
    for (const item of listed.files) {
      const rel = String(item?.path || "").replace(/\\/g, "/");
      const parts = rel.split("/");
      if (!rel || parts.some((seg) => !seg || seg === "." || seg === "..")) continue;
      if (parts.length > PREVIEW_MAX_DEPTH) throw Error(`静态预览目录深度超过 ${PREVIEW_MAX_DEPTH} 层`);
      if (SKIP_FILES.has(parts[parts.length - 1])) continue;
      assert(!FORBIDDEN.test(rel), `预览目录包含凭据文件（${rel}），拒绝发布`);
      const local = await localRead(opts.hub, opts.agent, opts.cwd, joinLocal(baseDir, ...parts), signal, true);
      addFile(rel, local.data);
    }
  } else {
    const fs = opts.fs || filesystem;
    const cwdReal = await fs.realpath(opts.cwd);
    const dirReal = await fs.realpath(resolve(cwdReal, opts.dir));
    const roots = [cwdReal];
    for (const extra of opts.extraRoots || []) {
      if (!extra) continue;
      try {
        const r = await fs.realpath(extra);
        if (!roots.includes(r)) roots.push(r);
      } catch {}
    }
    assert(
      roots.some((r) => withinRoot(r, dirReal)) && (await fs.stat(dirReal)).isDirectory(),
      "静态预览目录必须是当前工作区内的已存在目录",
    );

    const walk = async (curDir: string, prefix: string, depth: number) => {
      assert(depth <= PREVIEW_MAX_DEPTH, `静态预览目录深度超过 ${PREVIEW_MAX_DEPTH} 层`);
      const entries = await fs.readdir(curDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of entries) {
        if (item.name === "." || item.name === "..") continue;
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        assert(!FORBIDDEN.test(item.name) && !FORBIDDEN.test(rel), `预览目录包含凭据文件（${rel}），拒绝发布`);
        const full = resolve(curDir, item.name);
        const isSym = typeof item.isSymbolicLink === "function" && item.isSymbolicLink();
        if (isSym) {
          const target = await fs.realpath(full);
          assert(withinRoot(dirReal, target), "预览目录包含指向目录外的符号链接，拒绝发布");
          const st = await fs.stat(target);
          if (st.isDirectory()) {
            if (!SKIP_DIRS.has(item.name)) await walk(target, rel, depth + 1);
          } else if (st.isFile() && !SKIP_FILES.has(item.name)) {
            assert(st.size <= PREVIEW_MAX_FILE_BYTES, `单个预览文件不能超过 ${Math.round(PREVIEW_MAX_FILE_BYTES / (1 << 20))}MiB`);
            addFile(rel, await fs.readFile(target));
          }
          continue;
        }
        if (item.isDirectory()) {
          if (!SKIP_DIRS.has(item.name)) await walk(full, rel, depth + 1);
        } else if (item.isFile() && !SKIP_FILES.has(item.name)) {
          const st = await fs.stat(full);
          assert(st.size <= PREVIEW_MAX_FILE_BYTES, `单个预览文件不能超过 ${Math.round(PREVIEW_MAX_FILE_BYTES / (1 << 20))}MiB`);
          addFile(rel, await fs.readFile(full));
        }
      }
    };
    await walk(dirReal, "", 1);
  }

  assert(files.length > 0, "静态预览目录为空");
  assert(files.some((f) => f.relPath === entry), `入口文件不存在：${entry}`);
  const title = typeof opts.title === "string" && opts.title.trim()
    ? opts.title.trim().slice(0, 120)
    : basename(opts.dir.replace(/[\\/]+$/, "")) || "网页预览";
  return { title, entry, files, totalBytes };
}

export async function materializePreview(
  store: Store,
  opts: { employeeId: string; taskId: string; ownerId: string; groupId?: string; collected: CollectedPreview },
): Promise<PreviewRef> {
  const previewId = "pv-" + id();
  const baseDir = store.files.preview(opts.employeeId, opts.taskId, previewId);
  const dirs = new Set<string>();
  await filesystem.mkdir(baseDir, { recursive: true, mode: 0o700 });
  dirs.add(baseDir);
  for (const file of opts.collected.files) {
    const target = resolve(baseDir, ...file.relPath.split("/"));
    assert(withinRoot(baseDir, target), "Invalid preview file path");
    const parent = resolve(target, "..");
    if (!dirs.has(parent)) {
      await filesystem.mkdir(parent, { recursive: true, mode: 0o700 });
      dirs.add(parent);
    }
    await filesystem.writeFile(target, file.data, { mode: 0o600 });
  }
  const ref: PreviewRef = {
    id: previewId,
    title: opts.collected.title,
    entry: opts.collected.entry,
    url: `/preview/${previewId}/`,
    fileCount: opts.collected.files.length,
    totalBytes: opts.collected.totalBytes,
    createdAt: Date.now(),
  };
  const record: PreviewRecord = {
    ...ref,
    employeeId: opts.employeeId,
    taskId: opts.taskId,
    ownerId: opts.ownerId,
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
  };
  await store.save("preview", previewId, record);
  return ref;
}

export async function removeTaskPreviews(store: Store, employeeId: string, taskId: string) {
  for (const row of await store.objects<PreviewRecord>("preview")) {
    if (row.employeeId === employeeId && row.taskId === taskId) {
      await store.remove("preview", row.id);
    }
  }
}

export async function removeEmployeePreviews(store: Store, employeeId: string) {
  for (const row of await store.objects<PreviewRecord>("preview")) {
    if (row.employeeId === employeeId) {
      await store.remove("preview", row.id);
    }
  }
}

export async function resolvePreviewAsset(
  baseDir: string,
  relParts: string[],
  defaultEntry = "index.html",
): Promise<{ path: string; ext: string } | undefined> {
  let baseReal: string;
  try {
    baseReal = await filesystem.realpath(baseDir);
  } catch {
    return undefined;
  }
  const cleanParts: string[] = [];
  for (const raw of relParts) {
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return undefined; }
    if (!seg || seg === "." || seg === ".." || seg.includes("\0") || seg.includes("/") || seg.includes("\\")) {
      return undefined;
    }
    cleanParts.push(seg);
  }
  let candidate = cleanParts.length ? resolve(baseReal, ...cleanParts) : resolve(baseReal, ...defaultEntry.split("/"));
  try {
    const st = await filesystem.stat(candidate);
    if (st.isDirectory()) candidate = resolve(candidate, "index.html");
    const targetReal = await filesystem.realpath(candidate);
    if (!withinRoot(baseReal, targetReal)) return undefined;
    const finalStat = await filesystem.stat(targetReal);
    if (!finalStat.isFile()) return undefined;
    return { path: targetReal, ext: extname(targetReal).toLowerCase() };
  } catch {
    return undefined;
  }
}

type TokenEntry = {
  previewId: string;
  sessionHash: string;
  userId: string;
  expiresAt: number;
};

export class PreviewTokens {
  private tokens = new Map<string, TokenEntry>();
  constructor(private ttlMs = 2 * 60 * 60 * 1000, private maxEntries = 4096) {}

  issue(previewId: string, sessionHash: string, userId: string): string {
    const now = Date.now();
    if (this.tokens.size >= this.maxEntries) {
      for (const [k, v] of this.tokens) {
        if (v.expiresAt <= now) this.tokens.delete(k);
      }
      while (this.tokens.size >= this.maxEntries) {
        this.tokens.delete(this.tokens.keys().next().value!);
      }
    }
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, { previewId, sessionHash, userId, expiresAt: now + this.ttlMs });
    return token;
  }

  verify(token: string, previewId: string): TokenEntry | undefined {
    if (!token || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) return undefined;
    const entry = this.tokens.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    if (entry.previewId !== previewId) return undefined;
    return entry;
  }
}

export type PreviewResponse = {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
};

const plain = (status: number, text: string): PreviewResponse => ({
  status,
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  },
  body: Buffer.from(text, "utf8"),
});

export async function handlePreviewRequest(
  deps: { store: Store; auth: Auth; previewTokens: PreviewTokens },
  req: { method: string; pathname: string; sessionCookie?: string },
): Promise<PreviewResponse> {
  if (!["GET", "HEAD"].includes(req.method)) return plain(405, "Method Not Allowed");
  if (!req.pathname.startsWith("/preview/")) return plain(404, "Preview not found");
  const rest = req.pathname.slice("/preview/".length);
  if (!rest) return plain(404, "Preview not found");
  const rawParts = rest.split("/");
  const previewId = rawParts[0];
  if (!PREVIEW_ID_RE.test(previewId)) return plain(404, "Preview not found");

  const isEntry = rawParts.length === 1 || (rawParts.length === 2 && rawParts[1] === "");
  if (isEntry) {
    const principal = await deps.auth.authenticate(req.sessionCookie);
    if (!principal) return plain(401, "Please sign in");
    const record = await deps.store.object<PreviewRecord>("preview", previewId);
    if (!record || !(await deps.auth.canFile(principal.user, ["employees", record.employeeId, record.taskId]))) {
      return plain(404, "Preview not found");
    }
    const token = deps.previewTokens.issue(previewId, principal.hash, principal.user.id);
    const entrySuffix = record.entry === "index.html"
      ? ""
      : record.entry.split("/").map(encodeURIComponent).join("/");
    return {
      status: 302,
      headers: {
        Location: `/preview/${previewId}/_t/${token}/${entrySuffix}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    };
  }

  if (rawParts[1] === "_t" && rawParts.length >= 3 && rawParts[2]) {
    const token = rawParts[2];
    const tok = deps.previewTokens.verify(token, previewId);
    if (!tok) {
      if (req.sessionCookie) {
        const principal = await deps.auth.authenticate(req.sessionCookie);
        if (principal) {
          const record = await deps.store.object<PreviewRecord>("preview", previewId);
          if (record && (await deps.auth.canFile(principal.user, ["employees", record.employeeId, record.taskId]))) {
            const fresh = deps.previewTokens.issue(previewId, principal.hash, principal.user.id);
            const suffix = rawParts.slice(3).join("/");
            return {
              status: 302,
              headers: {
                Location: `/preview/${previewId}/_t/${fresh}/${suffix}`,
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
              },
            };
          }
        }
      }
      return plain(401, "Preview session expired");
    }
    const principal = await deps.auth.resolveHash(tok.sessionHash);
    if (!principal) return plain(401, "Please sign in");
    const record = await deps.store.object<PreviewRecord>("preview", previewId);
    if (!record || !(await deps.auth.canFile(principal.user, ["employees", record.employeeId, record.taskId]))) {
      return plain(404, "Preview not found");
    }
    if (rawParts.length === 3) {
      return {
        status: 302,
        headers: {
          Location: `/preview/${previewId}/_t/${token}/`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      };
    }
    const tail = rawParts.slice(3);
    const assetParts = tail.at(-1) === "" ? tail.slice(0, -1) : tail;
    const baseDir = deps.store.files.preview(record.employeeId, record.taskId, previewId);
    const resolved = await resolvePreviewAsset(baseDir, assetParts, record.entry);
    if (!resolved) return plain(404, "File not found");
    const data = req.method === "HEAD" ? Buffer.alloc(0) : await filesystem.readFile(resolved.path);
    const mime = PREVIEW_MIME[resolved.ext] || "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
      "X-Frame-Options": "DENY",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    };
    if (isSandboxedPreviewMime(resolved.ext)) {
      headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";
    }
    return { status: 200, headers, body: data };
  }

  return plain(404, "Preview not found");
}
