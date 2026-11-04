import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent, LocalAgents } from "./local-agent";
import { assert } from "./util";

/** Server-side key files live under the files root but are never served (no image type) nor readable through `read` (no session scope). */
export const keyDir = (filesRoot: string) => join(filesRoot, "keys");

/** Host keys: trust a host on first contact, refuse one whose key changed; BatchMode so ssh never waits on a prompt. */
export function gitSshCommand(path: string) {
  const file = path.replaceAll("\\", "/"); // Git's sh (also on Windows) reads forward slashes
  assert(!file.includes("'"), "私钥临时文件路径含单引号，无法组成 GIT_SSH_COMMAND");
  return `ssh -i '${file}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
}

/**
 * Private keys (vault ssh_key) written as 0600 files where the run executes: the server, or the local client the session
 * runs on. One instance per run; clear() removes them when the run ends, startup cleanup catches crashes.
 */
export class KeyFiles {
  private written: { path: string; agent?: Agent }[] = [];
  constructor(private dir: string, private hub: LocalAgents) {}
  async write(key: string, agent: Agent | undefined, signal: AbortSignal) {
    let path: string;
    if (agent) {
      const r = await this.hub.request(agent, "key", { op: "write", content: Buffer.from(key).toString("base64") }, signal);
      assert(r.error !== "Unknown operation", "所选客户端版本过旧，不支持 SSH 私钥；请更新客户端后重试");
      assert(!r.error && typeof r.path === "string", "客户端未能写入私钥临时文件：" + (r.error || "无效结果"));
      path = r.path;
    } else {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      path = join(this.dir, randomUUID());
      await writeFile(path, key, { mode: 0o600, flag: "wx" });
    }
    this.written.push({ path, agent });
    return path;
  }
  async clear() {
    const written = this.written.splice(0);
    await Promise.all(written.map(({ path, agent }) => agent
      ? this.hub.request(agent, "key", { op: "remove", path }, AbortSignal.timeout(15000)).catch(() => {}) // the client also clears its key directory on start
      : rm(path, { force: true })));
  }
}
