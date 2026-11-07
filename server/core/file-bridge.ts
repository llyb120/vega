import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { LocalAgentUnavailable, type Agent, type LocalAgents } from "./local-agent";
import { assert, type Obj } from "./util";

/** Same ceiling as the native client's read/write operations. */
export const BRIDGE_MAX_BYTES = 32 << 20;

const MISSING = /ENOENT|no such file|not exist|cannot find|cannot find the file/i;

export type ClientFileOps = {
  upload(cwd: string, path: string): Promise<Obj>;
  read(cwd: string, path: string): Promise<Obj>;
  write(cwd: string, path: string, contentBase64: string): Promise<Obj>;
};

export type FileSource = (cwd: string, input: string) => Promise<string>;

/** Client workspace + cloud browser. A recorded local-browser exception keeps files on that client. */
export function needsClientFileBridge(session: { localAgent?: boolean; browserLocation?: string }) {
  return !!session.localAgent && session.browserLocation !== "local";
}

/**
 * Workspace-relative path only. Absolute paths, home shortcuts and `..` are rejected before any client or server IO,
 * so a same-named path on the server is never consulted.
 */
export function workspaceRelative(input: string) {
  assert(typeof input === "string" && input.trim() && !input.includes("\0"), "需要工作区内的相对路径");
  const trimmed = input.trim().replace(/\\/g, "/");
  assert(!trimmed.startsWith("/") && !trimmed.startsWith("~") && !/^[A-Za-z]:/.test(trimmed), "只接受工作区内的相对路径，不会读取服务器上的同名路径");
  const parts = trimmed.split("/").filter((part) => part && part !== ".");
  assert(parts.length > 0 && parts.every((part) => part !== ".."), "路径不能越出工作区");
  return parts.join("/");
}

function refused(result: Obj | undefined, fallback: string): never {
  throw Error((result?.error ? String(result.error) : fallback) + "；不会改读或改写服务器上的同名路径");
}

/** Validate with the client's upload check, then read bytes from the client. Never opens a server path. */
export async function importClientFile(client: ClientFileOps, cwd: string, input: string) {
  const relativePath = workspaceRelative(input);
  let checked: Obj;
  try { checked = await client.upload(cwd, relativePath); }
  catch (error) { if (error instanceof LocalAgentUnavailable) throw error; refused(undefined, error instanceof Error ? error.message : String(error)); }
  if (checked?.error || typeof checked?.path !== "string") refused(checked, "客户端拒绝该文件");
  const suffix = relativePath.split("/").join(checked.path.includes("\\") ? "\\" : "/");
  if (!checked.path.endsWith(suffix)) throw Error("客户端解析到工作区之外或符号链接，不会跟随，也不会改读服务器文件");
  let read: Obj;
  try { read = await client.read(cwd, relativePath); }
  catch (error) { if (error instanceof LocalAgentUnavailable) throw error; refused(undefined, error instanceof Error ? error.message : String(error)); }
  if (read?.error || typeof read?.content !== "string") refused(read, "客户端读取失败");
  assert(read.content.length <= Math.ceil(BRIDGE_MAX_BYTES / 3) * 4, "文件超过 32MiB");
  const data = Buffer.from(read.content, "base64");
  assert(data.length <= BRIDGE_MAX_BYTES, "文件超过 32MiB");
  return { relativePath, data, clientPath: checked.path as string };
}

/**
 * Write bytes into the client workspace. Requires explicit authorization, refuses an existing path, and checks the
 * client's upload result afterwards. The native write operation does not itself reject a parent symlink; a failed
 * post-check is reported and nothing is read from the server to compensate.
 */
export async function exportClientFile(client: ClientFileOps, cwd: string, destination: string, data: Buffer, authorized: boolean) {
  assert(authorized === true, "把云端浏览器的文件导回客户端需要显式授权");
  const relativePath = workspaceRelative(destination);
  assert(data.length > 0 && data.length <= BRIDGE_MAX_BYTES, "导出文件为空或超过 32MiB");
  let probe: Obj;
  try { probe = await client.read(cwd, relativePath); }
  catch (error) {
    if (error instanceof LocalAgentUnavailable) throw error;
    probe = { error: error instanceof Error ? error.message : String(error) };
  }
  if (!probe?.error) throw Error("目标文件已存在，不会覆盖；请换一个工作区内的新路径");
  if (!MISSING.test(String(probe.error))) throw Error("无法确认目标是否已存在（" + probe.error + "），不会写入");
  let written: Obj;
  try { written = await client.write(cwd, relativePath, data.toString("base64")); }
  catch (error) { if (error instanceof LocalAgentUnavailable) throw error; refused(undefined, error instanceof Error ? error.message : String(error)); }
  if (written?.error) refused(written, "写入客户端失败");
  let checked: Obj;
  try { checked = await client.upload(cwd, relativePath); }
  catch (error) { if (error instanceof LocalAgentUnavailable) throw error; refused(undefined, "写入后未能复核路径"); }
  const suffix = relativePath.split("/").join(typeof checked?.path === "string" && checked.path.includes("\\") ? "\\" : "/");
  if (checked?.error || typeof checked?.path !== "string" || !checked.path.endsWith(suffix))
    throw Error("写入结果越出工作区或不是普通文件；请在客户端检查该路径。服务器上的同名文件不会被当作结果。");
  return { path: checked.path as string, bytes: data.length, relativePath };
}

function inside(root: string, file: string) {
  const part = relative(root, file);
  return part === "" || (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part));
}

/** Read a regular file that stays inside one of the allowed roots after symlink resolution. */
export async function readRegularInside(roots: string[], file: string, max = BRIDGE_MAX_BYTES) {
  assert(typeof file === "string" && file && roots.length > 0, "没有允许读取的云端浏览器目录");
  const listed = await lstat(file);
  assert(!listed.isSymbolicLink(), "下载源是符号链接，不会跟随");
  assert(listed.isFile(), "下载源不是普通文件");
  const resolved = await realpath(file);
  const rootHits = await Promise.all(roots.map(async (root) => {
    try { return inside(await realpath(root), resolved); }
    catch { return false; }
  }));
  assert(rootHits.some(Boolean), "下载不在云端浏览器的受控目录内，不会读取服务器上的其他路径");
  const st = await stat(resolved);
  assert(st.isFile() && st.size > 0 && st.size <= max, "下载文件为空或超过 32MiB");
  return await readFile(resolved);
}

export function clientFileOps(hub: LocalAgents, agent: Agent, signal: AbortSignal): ClientFileOps {
  const call = (args: Obj) => hub.request(agent, "file", args, signal);
  return {
    upload: (cwd, path) => call({ op: "upload", cwd, path }),
    read: (cwd, path) => call({ op: "read", cwd, path }),
    write: (cwd, path, content) => call({ op: "write", cwd, path, content }),
  };
}
