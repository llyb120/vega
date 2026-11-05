import * as filesystem from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { cloudRequest } from "../../shared/cloud-wire.mjs";
import type { Session } from "./store";

export type CloudIdentity = { owner: string; uid: number; name: string; home: string; cwd: string; tmp: string };
export const cloudEnabled = () => process.env.VEGA_CLOUD_ISOLATION === "1";
const socketPath = () => process.env.VEGA_CLOUD_SOCKET || "/run/vega/cloud.sock";
export const cloudHealthy = () => cloudRequest(socketPath(), { kind: "health" });
const identities = new Map<string, Promise<CloudIdentity>>();
const methods = ["access", "readFile", "writeFile", "stat", "lstat", "mkdir", "rm", "realpath", "rename", "unlink", "chmod", "readdir", "cp", "mkdtemp", "readlink"];
function entry(value: any) {
  return { ...value, isFile: () => value.file, isDirectory: () => value.directory, isSymbolicLink: () => value.symlink };
}
export function within(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part));
}

/** Files and commands never fall back to the service UID when the Docker executor fails. */
export class CloudRuntime {
  fs: typeof filesystem;
  constructor(readonly owner: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(owner || "")) throw Error("云端执行缺少所属用户；请先为历史会话/牛马确认归属");
    this.fs = Object.fromEntries(methods.map((method) => [method, async (...args: unknown[]) => {
      const value: any = await cloudRequest(socketPath(), { kind: "fs", owner, method, args });
      if (method === "stat" || method === "lstat") return entry(value);
      if (method === "readdir" && (args[1] as any)?.withFileTypes) return value.map(entry);
      return value;
    }])) as unknown as typeof filesystem;
  }
  signal(pid: number, signal: number | NodeJS.Signals) {
    return cloudRequest(socketPath(), { kind: "fs", owner: this.owner, method: "signal", args: [pid, signal] });
  }
  identity() {
    const key = socketPath() + ":" + this.owner;
    let pending = identities.get(key);
    if (!pending) {
      pending = cloudRequest(socketPath(), { kind: "ensure", owner: this.owner }) as Promise<CloudIdentity>;
      identities.set(key, pending);
      pending.catch(() => identities.delete(key));
    }
    return pending;
  }
  async cwd(input?: string) {
    const identity = await this.identity(), path = resolve(identity.cwd, input || ".");
    if (!within(identity.cwd, path)) throw Error("云端工作目录必须位于当前用户的私有工作区；旧公共目录需管理员确认归属后迁移");
    const actual = await this.fs.realpath(path);
    if (!within(identity.cwd, actual) || !(await this.fs.stat(actual)).isDirectory()) throw Error("云端工作目录越界或不存在");
    return actual;
  }
  launch(command: string, args: string[], cwd: string, env: Record<string, string> = {}, pipes = false) {
    return {
      command: process.execPath,
      args: [process.env.VEGA_CLOUD_EXEC || "/app/docker/cloud-exec.mjs"],
      cwd: "/",
      env: { PATH: process.env.PATH || "", VEGA_CLOUD_SOCKET: socketPath(),
        VEGA_CLOUD_REQUEST: JSON.stringify({ kind: "exec", owner: this.owner, command, args, cwd, env, pipes }) },
    };
  }
}
export function cloudFor(session: Pick<Session, "ownerId" | "localAgent">): CloudRuntime | undefined {
  if (!cloudEnabled() || session.localAgent) return;
  return new CloudRuntime(session.ownerId || "");
}
