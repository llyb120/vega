import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import * as nodefs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Engine } from "./engine";
import type { Session } from "./store";
import { cloudEnabled, cloudFor, within, type CloudRuntime } from "./cloud";
import { LocalAgentUnavailable, type Agent } from "./local-agent";
import { assertShellCommand } from "./shell-policy";
import { previewHost, previewOrigin, validRelayHost, type PreviewBackend } from "./network-relay";
import { assert, sleep, type Obj } from "./util";
import { clientFileOps, exportClientFile, readRegularInside, workspaceRelative } from "./file-bridge";
import { usesLocalBrowser } from "./store";

export const SYNC_LIMITS = { files: 2000, bytes: 64 << 20 };
/** Never synced unless listed in `include`; .git internals and browser profiles are never synced at all. */
const SECRET = [/(^|\/)\.env(\.[^/]*)?$/i, /(^|\/)\.(ssh|aws|gnupg|docker|kube|azure|config\/gcloud)(\/|$)/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i, /(^|\/)\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i, /(^|\/)(credentials|secrets?)(\.[a-z0-9]+)?$/i];
const NEVER = [/(^|\/)\.git(\/|$)/, /(^|\/)node_modules\//, /(^|\/)(Cookies|Login Data|Web Data|Local State)$/, /(^|\/)(Default|Profile \d+)\//, /\.vega-(cloud|local)-\d+(\.|$)/];

export type FileEntry = { path: string; sha: string; size: number; blob: string; untracked: boolean } | { path: string; deleted: true };
export type Checkpoint = { rev: number; at: number; complete: boolean; clientId: string; cwd: string; head: string; files: FileEntry[]; skipped: { path: string; reason: string }[]; unknown: { tool: string; startedAt: number }[] };
export type Dependency = { kind: "files" | "service" | "preview" | "intranet" | "hardware" | "certificate" | "browser"; name: string; status: "cloud" | "local" | "blocked"; detail: string };
export type Service = { name: string; command: string; port: number; ready: string; preview?: boolean };
export type HandoffRecord = {
  key: string; userId: string; taskId?: string; employeeId?: string;
  owner: "local" | "cloud";
  phase: "idle" | "checkpointed" | "needs_confirmation" | "files_synced_local_dependent" | "cloud_owned" | "failed" | "returning" | "synced_back" | "local_owned";
  message: string;
  rev: number; lastComplete?: number;
  local?: { clientId: string; clientName?: string; cwd: string; platform?: string; browserLocation?: "local"; browserReason?: string };
  cloudCwd?: string;
  applied?: { rev: number; files: Record<string, string | null>; untracked: string[] };
  services: (Service & { pid?: number })[];
  previews: { host: string; previous: PreviewBackend }[];
  deps: Dependency[];
  /** Set only after takeover has checked every declared dependency. Empty or unchecked deps never mean the computer can be closed. */
  depsVerified?: boolean;
  conflicts: { path: string; copy: string; side: "cloud" | "local"; at: number }[];
  pendingDeletes: string[];
  unknown: { tool: string; startedAt: number }[];
  syncedBack?: { at: number; fingerprint: string };
  pending?: "sync_back" | "transfer_back";
  history: { at: number; phase: string; message: string }[];
};
export type HandoffOptions = {
  include?: string[]; services?: Service[]; setup?: string[]; requires?: { kind: Dependency["kind"]; name: string }[];
  acknowledgeReload?: boolean; migrateBrowser?: boolean; cloudCwd?: string;
};
type Inflight = { tool: string; startedAt: number; done: Promise<unknown> };
type Quiesce = { mode: "pause" | "handoff"; released: Promise<void>; release: () => void };

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'";
const missing = (error: any) => error?.code === "ENOENT" || /ENOENT|no such file|not exist|cannot find/i.test(String(error?.message || error));
const ADVICE = { local: "文件已同步，仍依赖本地", cloud: "云端已接管，可以关闭电脑" };
const AUTO_PHASES = new Set(["idle", "checkpointed", "local_owned", "files_synced_local_dependent", "synced_back", "failed"]);
/** True only when ownership is cloud and takeover verified a non-empty dependency list that is entirely cloud. */
export function canCloseComputer(record?: { owner?: string; depsVerified?: boolean; deps?: { status: string }[] }) {
  return !!record && record.owner === "cloud" && record.depsVerified === true && !!record.deps?.length && record.deps.every((dep) => dep.status === "cloud");
}

export function syncable(path: string, include: string[] = []): string | undefined {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some((part) => part === ".." || part === "" || part === "."))
    return "路径越界或不规范";
  if (NEVER.some((pattern) => pattern.test(path))) return "仓库内部、依赖目录、浏览器配置或冲突副本不同步";
  if (SECRET.some((pattern) => pattern.test(path)) && !include.includes(path)) return "疑似凭据或密钥文件，未在 include 中明确列出，不同步";
  return;
}
/** git status --porcelain=v1 -z: "XY path\0", renames add "\0old". */
export function porcelain(output: string) {
  const parts = output.split("\0"), entries: { path: string; deleted: boolean; untracked: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4) continue;
    const code = item.slice(0, 2), path = item.slice(3);
    if (code[0] === "R" || code[0] === "C") { entries.push({ path, deleted: false, untracked: false }); if (code[0] === "R") entries.push({ path: parts[++i], deleted: true, untracked: false }); else i++; continue; }
    entries.push({ path, deleted: code.includes("D"), untracked: code === "??" });
  }
  return entries;
}

/**
 * Moves execution of one session (and its task) between the user's client and the cloud. The browser is not part of
 * the move: it already runs in the cloud unless a local exception was recorded. The flow quiesces local work,
 * checkpoints the client workspace, rebuilds what the next steps need in the cloud and transfers ownership only when
 * every declared dependency is verified there.
 */
export class Handoffs {
  private inflight = new Map<string, Set<Inflight>>();
  private quiesced = new Map<string, Quiesce>();
  private locks = new Set<string>();
  private processes = new Map<number, ReturnType<typeof spawn>>();
  private checkpointTail = new Map<string, Promise<unknown>>();
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private watched = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  drainMs = 30000;
  readyMs = 60000;
  /** Automatic checkpoints coalesce for this long and never run on the model turn's stack. */
  debounceMs = 5000;
  intervalMs = 60000;
  keepRevisions = 3;
  constructor(private engine: Engine) {}

  private get store() { return this.engine.store; }
  private snapshotDir(key: string) { return join(this.store.files.root, "handoff", key.replace(/[^a-zA-Z0-9_-]/g, "_")); }
  async record(key: string): Promise<HandoffRecord | undefined> { return await this.store.object<HandoffRecord>("handoff", key); }
  private async save(record: HandoffRecord, phase: HandoffRecord["phase"], message: string) {
    record.phase = phase;
    record.message = message;
    record.history = [...record.history, { at: Date.now(), phase, message }].slice(-30);
    await this.store.save("handoff", record.key, record);
    this.engine.emit({ type: "handoff_changed", session: record.key, data: this.view(record) });
    return record;
  }
  view(record?: HandoffRecord) {
    if (!record) return { owner: "local", phase: "idle", message: "", canCloseComputer: false, deps: [] as Dependency[] };
    const { history, applied, ...rest } = record;
    const checkpointAt = [...history].reverse().find((item) => item.phase === "checkpointed")?.at;
    return { ...rest, appliedFiles: applied ? Object.keys(applied.files).length : 0, checkpointAt, canCloseComputer: canCloseComputer(record) };
  }

  /** Tools call this for every local operation of a session; a handoff refuses new ones and a checkpoint delays them. */
  async admit(key: string, tool: string) {
    const quiesce = this.quiesced.get(key);
    if (quiesce?.mode === "handoff") throw new LocalAgentUnavailable("正在把这项工作交接到云端，已暂停新的本地操作，本步未执行。交接完成后在新的执行位置继续，不重放已完成或结果不确定的操作。");
    if (quiesce) await Promise.race([quiesce.released, sleep(this.drainMs)]);
    let finish!: () => void;
    const entry: Inflight = { tool, startedAt: Date.now(), done: new Promise<void>((yes) => { finish = yes; }) };
    const set = this.inflight.get(key) || new Set();
    this.inflight.set(key, set);
    set.add(entry);
    return () => { set.delete(entry); if (!set.size) this.inflight.delete(key); finish(); };
  }
  private async quiesce(key: string, mode: Quiesce["mode"]) {
    let release!: () => void;
    const released = new Promise<void>((yes) => { release = yes; });
    this.quiesced.set(key, { mode, released, release });
    const pending = [...(this.inflight.get(key) || [])];
    await Promise.race([Promise.all(pending.map((entry) => entry.done)), sleep(this.drainMs)]);
    return [...(this.inflight.get(key) || [])].map(({ tool, startedAt }) => ({ tool, startedAt }));
  }
  private unquiesce(key: string) { this.quiesced.get(key)?.release(); this.quiesced.delete(key); }
  private async lock<T>(key: string, work: () => Promise<T>) {
    assert(!this.locks.has(key) && !this.engine.executionSwitches.has(key), "交接或执行位置切换正在进行，请稍后再试");
    this.locks.add(key);
    this.engine.executionSwitches.add(key);
    try {
      const pending = this.checkpointTail.get(key);
      if (pending) await Promise.race([pending, sleep(this.drainMs)]);
      return await work();
    }
    finally { this.locks.delete(key); this.engine.executionSwitches.delete(key); }
  }
  /** Serialise checkpoint work per session. A later call waits for the earlier one instead of interleaving revisions. */
  private enqueue(key: string, work: () => Promise<unknown>) {
    const previous = this.checkpointTail.get(key) || Promise.resolve();
    const next = previous.then(work, work);
    this.checkpointTail.set(key, next);
    void next.finally(() => { if (this.checkpointTail.get(key) === next) this.checkpointTail.delete(key); }).catch(() => {});
    return next;
  }

  private async fresh(session: Session): Promise<HandoffRecord> {
    const existing = await this.record(session.id);
    if (existing) return existing;
    return { key: session.id, userId: session.ownerId || "", taskId: session.taskId, employeeId: session.employeeId, owner: session.localAgent ? "local" : "cloud", phase: "idle", message: "", rev: 0,
      services: [], previews: [], deps: [], conflicts: [], pendingDeletes: [], unknown: [], history: [] };
  }
  private agent(session: Session) {
    assert(session.localAgent && session.clientId, "该会话不在客户端执行");
    const agent = this.engine.localAgents.active(session.ownerId, session.clientId);
    assert(agent && agent.transport && !agent.reconnecting, "客户端离线：无法在线交接；客户端已断开时用 recover 从最近完整检查点恢复");
    return agent;
  }
  private async client(agent: Agent, op: "exec" | "file", args: Obj) {
    return await this.engine.localAgents.request(agent, op, args, AbortSignal.timeout(op === "exec" ? 60000 : 45000));
  }
  private async clientGit(agent: Agent, cwd: string, command: string) {
    const r = await this.client(agent, "exec", { cwd, command, timeout: 30 });
    assert(Number(r.exitCode) === 0 && !r.error && !r.truncated, `客户端 git 命令失败：${String(r.error || r.output || "").slice(0, 300)}`);
    return String(r.output || "");
  }

  async checkpoint(key: string, options: HandoffOptions = {}) {
    const checkpoint = await this.lock(key, () => this.capture(key, options));
    assert(checkpoint, "检查点没有生成");
    return checkpoint;
  }
  /** Copies the client's uncommitted and untracked work into a content-addressed snapshot; only a fully stored one is complete. */
  private async capture(key: string, options: HandoffOptions = {}, unknown?: Checkpoint["unknown"], background = false) {
    const session = await this.store.session(key), record = await this.fresh(session);
    if (background && (this.locks.has(key) || this.engine.executionSwitches.has(key) || this.engine.closing || !AUTO_PHASES.has(record.phase) || record.owner !== "local")) return;
    const agent = this.agent(session);
    if (!background) assert(record.owner === "local", "执行权已在云端；本机检查点只在本机执行时生成");
    else if (record.owner !== "local") return;
    const ownQuiesce = !unknown && !background;
    if (ownQuiesce) unknown = await this.quiesce(key, "pause");
    try {
      const probe = await this.client(agent, "file", { op: "upload", cwd: session.cwd, path: "." });
      assert(probe.error !== "Unknown file operation", "客户端版本过旧，不支持交接所需的受控文件校验（upload），请升级客户端；本次未同步任何文件");
      const head = (await this.clientGit(agent, session.cwd, "git rev-parse HEAD")).trim();
      assert(/^[0-9a-f]{40,64}$/.test(head), "客户端工作目录不是 git 仓库；交接只同步 git 工作区的未提交改动和未跟踪文件");
      const status = porcelain(await this.clientGit(agent, session.cwd, "git status --porcelain=v1 -z --untracked-files=all"));
      for (const path of options.include || []) if (!status.some((entry) => entry.path === path)) status.push({ path, deleted: false, untracked: true });
      assert(status.length <= SYNC_LIMITS.files, `改动文件超过 ${SYNC_LIMITS.files} 个，未生成检查点；请先提交或清理生成物`);
      const rev = record.rev + 1, dir = this.snapshotDir(key), files: FileEntry[] = [], skipped: Checkpoint["skipped"] = [];
      await nodefs.mkdir(join(dir, "blobs"), { recursive: true, mode: 0o700 });
      let bytes = 0;
      for (const entry of status) {
        const reason = syncable(entry.path, options.include);
        if (reason) { skipped.push({ path: entry.path, reason }); continue; }
        if (entry.deleted) { files.push({ path: entry.path, deleted: true }); continue; }
        const checked = await this.client(agent, "file", { op: "upload", cwd: session.cwd, path: entry.path });
        const suffix = entry.path.split("/").join(session.localPlatform === "windows" ? "\\" : "/");
        if (checked.error || typeof checked.path !== "string" || !checked.path.endsWith(suffix)) {
          skipped.push({ path: entry.path, reason: checked.error ? "非普通文件或越出工作目录" : "符号链接，不跟随" });
          continue;
        }
        const read = await this.client(agent, "file", { op: "read", cwd: session.cwd, path: checked.path });
        assert(!read.error && typeof read.content === "string", `读取 ${entry.path} 失败：${read.error || "无内容"}`);
        const data = Buffer.from(read.content, "base64"), digest = sha(data);
        bytes += data.length;
        assert(bytes <= SYNC_LIMITS.bytes, `改动内容超过 ${SYNC_LIMITS.bytes >> 20} MiB，未生成检查点`);
        const blob = join(dir, "blobs", digest);
        await nodefs.writeFile(blob, data, { mode: 0o600, flag: "wx" }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
        files.push({ path: entry.path, sha: digest, size: data.length, blob: digest, untracked: entry.untracked });
      }
      const checkpoint: Checkpoint = { rev, at: Date.now(), complete: true, clientId: agent.clientId, cwd: session.cwd, head, files, skipped, unknown: unknown || [] };
      const temporary = join(dir, `rev-${rev}.json.tmp`);
      await nodefs.writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
      await nodefs.rename(temporary, join(dir, `rev-${rev}.json`));
      const latest = (await this.record(key)) || record;
      if (background && (this.locks.has(key) || this.engine.executionSwitches.has(key) || !AUTO_PHASES.has(latest.phase) || latest.owner !== "local")) return;
      latest.rev = rev;
      latest.lastComplete = rev;
      latest.local = { clientId: agent.clientId, clientName: session.clientName, cwd: session.cwd, platform: session.localPlatform, browserLocation: session.browserLocation, browserReason: session.browserReason };
      await this.save(latest, "checkpointed", `检查点 rev ${rev} 已完整保存：${files.length} 个改动文件${skipped.length ? `，跳过 ${skipped.length} 个（见 skipped）` : ""}${checkpoint.unknown.length ? `，${checkpoint.unknown.length} 个操作结果待核验` : ""}`);
      await this.prune(key).catch(() => {});
      return checkpoint;
    } finally { if (ownQuiesce) this.unquiesce(key); }
  }
  private async loadCheckpoint(key: string, rev: number) {
    const checkpoint = JSON.parse(await nodefs.readFile(join(this.snapshotDir(key), `rev-${rev}.json`), "utf8")) as Checkpoint;
    assert(checkpoint.complete && checkpoint.rev === rev, "检查点不完整");
    return checkpoint;
  }

  private async cloudTarget(session: Session, record: HandoffRecord, options: HandoffOptions) {
    const cloud = cloudFor({ ownerId: session.ownerId, localAgent: false });
    let saved = session.executionCwds?.server;
    if (!saved && session.employeeId) saved = (await (await this.engine.employeeFor(session)).state()).executionCwds?.server;
    const requested = options.cloudCwd || record.cloudCwd || saved;
    assert(requested || cloud, "需要指定云端工作目录（同一仓库在服务端的检出，cloudCwd）；不会猜测目录");
    const cwd = cloud ? await cloud.cwd(requested) : resolve(requested!);
    if (!cloud) assert((await nodefs.stat(cwd)).isDirectory(), "云端工作目录不存在");
    return { cloud, cwd, fs: (cloud?.fs || nodefs) as typeof nodefs };
  }
  private async serverRun(command: string, cwd: string, cloud: CloudRuntime | undefined, timeout = 120) {
    assertShellCommand(command);
    return await new Promise<{ output: string; exitCode: number }>((resolveRun) => {
      const launch = cloud?.launch("/bin/sh", ["-c", command], cwd);
      const child = spawn(launch?.command || "/bin/sh", launch?.args || ["-c", command], { cwd: launch?.cwd || cwd, ...(launch ? { env: launch.env } : {}), stdio: ["ignore", "pipe", "pipe"], detached: true });
      const decoder = new StringDecoder("utf8");
      let output = "";
      const collect = (chunk: Buffer) => { output = (output + decoder.write(chunk)).slice(-(4 << 20)); };
      child.stdout!.on("data", collect);
      child.stderr!.on("data", collect);
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, timeout * 1000);
      child.once("error", (error) => { clearTimeout(timer); resolveRun({ output: error.message, exitCode: -1 }); });
      child.once("close", (code) => { clearTimeout(timer); resolveRun({ output: output + decoder.end(), exitCode: code ?? -1 }); });
    });
  }
  private async serverGit(command: string, cwd: string, cloud?: CloudRuntime) {
    const r = await this.serverRun(command, cwd, cloud, 60);
    assert(r.exitCode === 0, `云端 git 命令失败：${r.output.slice(0, 300)}`);
    return r.output;
  }
  /** Resolves a workspace path in the cloud copy, refusing symlinked parents or targets. */
  private async target(fs: typeof nodefs, root: string, path: string) {
    const full = resolve(root, path);
    assert(within(root, full), `${path} 越出云端工作目录`);
    let dir = root;
    for (const part of path.split("/").slice(0, -1)) {
      dir = join(dir, part);
      try { const stat = await fs.lstat(dir); assert(!stat.isSymbolicLink() && stat.isDirectory(), `${path} 的上级目录是符号链接或文件，拒绝写入`); }
      catch (error) { if (missing(error)) break; throw error; }
    }
    try { assert(!(await fs.lstat(full)).isSymbolicLink(), `${path} 在云端是符号链接，拒绝覆盖`); }
    catch (error) { if (!missing(error)) throw error; }
    return full;
  }
  private async readMaybe(fs: typeof nodefs, full: string) {
    try { return Buffer.from(await fs.readFile(full)); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }

  /** Applies a checkpoint to the cloud copy. Cloud edits that differ are kept beside the file, never dropped. */
  private async apply(key: string, record: HandoffRecord, checkpoint: Checkpoint, place: Awaited<ReturnType<Handoffs["cloudTarget"]>>) {
    const { cwd, fs, cloud } = place, root = cloud ? cwd : await nodefs.realpath(cwd);
    const head = (await this.serverGit("git rev-parse HEAD", root, cloud)).trim();
    assert(head === checkpoint.head, `云端工作目录的提交 ${head.slice(0, 12)} 与本机 ${checkpoint.head.slice(0, 12)} 不一致；请先让两边处于同一提交（推送/拉取由用户决定），本次未写入任何文件`);
    const dirty = new Set(porcelain(await this.serverGit("git status --porcelain=v1 -z --untracked-files=all", root, cloud)).map((entry) => entry.path));
    const previous = record.applied?.files || {}, files: Record<string, string | null> = {}, untracked: string[] = [];
    for (const entry of checkpoint.files) {
      const full = await this.target(fs, root, entry.path), current = await this.readMaybe(fs, full), currentSha = current ? sha(current) : null;
      const incoming = "deleted" in entry ? null : entry.sha;
      files[entry.path] = incoming;
      if ("deleted" in entry ? false : entry.untracked) untracked.push(entry.path);
      if (currentSha === incoming) continue;
      const ours = entry.path in previous && previous[entry.path] === currentSha;
      if (dirty.has(entry.path) && !ours && current) {
        const copy = `${entry.path}.vega-cloud-${checkpoint.rev}`;
        await fs.writeFile(await this.target(fs, root, copy), current);
        record.conflicts.push({ path: entry.path, copy, side: "cloud", at: Date.now() });
      }
      if (incoming === null) { if (current) await fs.rm(full, { force: true }); continue; }
      await fs.mkdir(dirname(full), { recursive: true });
      await fs.writeFile(full, await nodefs.readFile(join(this.snapshotDir(key), "blobs", incoming)));
    }
    // Files an earlier handoff wrote that the client has since reverted go back to the commit.
    for (const [path, applied] of Object.entries(previous)) {
      if (path in files) continue;
      const full = await this.target(fs, root, path), current = await this.readMaybe(fs, full);
      if ((current ? sha(current) : null) !== applied) continue;
      if (record.applied?.untracked.includes(path)) await fs.rm(full, { force: true });
      else await this.serverGit(`git checkout HEAD -- ${quote(path)}`, root, cloud);
    }
    return { files, untracked, root };
  }

  private async startService(service: Service, cwd: string, key: string) {
    assertShellCommand(service.command);
    assert(!cloudEnabled() && process.platform !== "win32", "当前云端执行环境（隔离容器或 Windows 服务端）暂不支持由交接启动开发服务；未启动");
    const log = openSync(join(this.snapshotDir(key), `service-${service.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`), "a", 0o600);
    try {
      const child = spawn("/bin/sh", ["-c", service.command], { cwd, detached: true, stdio: ["ignore", log, log], env: { ...process.env, PORT: String(service.port) } });
      child.unref();
      child.once("error", () => {});
      if (child.pid) this.processes.set(child.pid, child);
      return child.pid;
    } finally { closeSync(log); }
  }
  private stopService(pid?: number) {
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
    this.processes.delete(pid);
  }
  private async ready(service: Service) {
    const deadline = Date.now() + this.readyMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${service.port}${service.ready}`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
        if (response.status < 500) return `HTTP ${response.status}`;
        last = `HTTP ${response.status}`;
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
      await sleep(250);
    }
    throw Error(`服务 ${service.name} 在 ${this.readyMs / 1000} 秒内未就绪（${last}）`);
  }
  private async reachable(host: string, port: number) {
    return await new Promise<boolean>((yes) => {
      const socket = connect({ host, port, timeout: 3000 });
      socket.once("connect", () => { socket.destroy(); yes(true); });
      socket.once("error", () => yes(false));
      socket.once("timeout", () => { socket.destroy(); yes(false); });
    });
  }
  private services(options: HandoffOptions, manifest?: Obj): Service[] {
    const list = options.services || manifest?.services || [];
    assert(Array.isArray(list) && list.length <= 8, "services 至多 8 个");
    return list.map((item: Obj) => {
      assert(item && typeof item.name === "string" && /^[\w.-]{1,40}$/.test(item.name) && typeof item.command === "string" && item.command.length <= 2000 &&
        Number.isInteger(item.port) && item.port >= 1024 && item.port <= 65535 && (item.ready === undefined || (typeof item.ready === "string" && item.ready.startsWith("/"))), "服务需要 name、command、port（1024–65535）和以 / 开头的 ready 路径");
      return { name: item.name, command: item.command, port: item.port, ready: item.ready || "/", preview: item.preview === true };
    });
  }

  private async previewTabs(session: Session, host: string) {
    const browser = this.engine.peekBrowser(session);
    if (!browser || this.engine.localBrowser(session)) return [];
    const result = await browser.execute(session.id, session.cwd, { operation: "tabs" }).catch(() => ({ tabs: [] }));
    return (result.tabs || []).filter((tab: Obj) => { try { return new URL(tab.url).host === host; } catch { return false; } }).map((tab: Obj) => ({ tag: tab.tag as string, url: tab.url as string }));
  }
  private async reloadVerify(session: Session, tabs: { tag: string; url: string }[], origin: string) {
    if (!tabs.length) return;
    const browser = await this.engine.chromeFor(session);
    for (const tab of tabs) {
      await browser.execute(session.id, session.cwd, { operation: "reload", tabTag: tab.tag, observe: "none" });
      const deadline = Date.now() + 15000;
      for (;;) {
        const state = await browser.cdp(tab.tag, "Runtime.evaluate", { expression: "JSON.stringify([location.origin, document.readyState])", returnByValue: true }).catch(() => undefined);
        const [actual, readyState] = state?.result?.value ? JSON.parse(state.result.value) : [];
        if (actual === origin && readyState === "complete") break;
        assert(Date.now() < deadline, `预览页面 ${tab.url} 切换后未能重新加载完成`);
        await sleep(200);
      }
    }
  }

  /** Exports only the task's tabs from the local exception browser and verifies them in the cloud browser. */
  private async migrateBrowser(session: Session) {
    const local = await this.engine.localBrowsers.get(session), cloud = await this.engine.chromeFor({ ...session, browserLocation: undefined });
    const tags = [...new Set([...local.observations.keys()].filter((key) => key.startsWith(session.id + ":")).map((key) => local.observations.get(key)!.tabTag))];
    assert(tags.length, "本机浏览器里没有本任务观察过的标签页可迁移");
    const listed = (await local.execute(session.id, session.cwd, { operation: "tabs" })).tabs as Obj[];
    const moved: string[] = [];
    for (const tag of tags) {
      const tab = listed.find((item) => item.tag === tag);
      if (!tab || !/^https?:/.test(tab.url)) continue;
      const cookies = (await local.cdp(tag, "Network.getCookies", { urls: [tab.url] })).cookies || [];
      const storage = await local.cdp(tag, "Runtime.evaluate", { expression: "JSON.stringify({local:Object.entries(localStorage),session:Object.entries(sessionStorage)})", returnByValue: true });
      const { local: localItems, session: sessionItems } = JSON.parse(storage?.result?.value || '{"local":[],"session":[]}');
      const opened = await cloud.execute(session.id, session.cwd, { operation: "open", url: new URL(tab.url).origin + "/", observe: "none" });
      const target = opened.tabTag as string;
      for (const cookie of cookies) await cloud.cdp(target, "Network.setCookie", { ...cookie, url: tab.url });
      await cloud.cdp(target, "Runtime.evaluate", { expression: `(${JSON.stringify({ l: localItems, s: sessionItems })}).l.forEach(([k,v])=>localStorage.setItem(k,v)),(${JSON.stringify({ s: sessionItems })}).s.forEach(([k,v])=>sessionStorage.setItem(k,v))`, returnByValue: true });
      await cloud.execute(session.id, session.cwd, { operation: "goto", tabTag: target, url: tab.url, observe: "none" });
      const names = new Set(((await cloud.cdp(target, "Network.getCookies", { urls: [tab.url] })).cookies || []).map((cookie: Obj) => cookie.name));
      const keys = JSON.parse((await cloud.cdp(target, "Runtime.evaluate", { expression: "JSON.stringify(Object.keys(localStorage))", returnByValue: true }))?.result?.value || "[]");
      assert(cookies.every((cookie: Obj) => names.has(cookie.name)) && localItems.every(([k]: string[]) => keys.includes(k)), `标签页 ${tab.url} 的登录态在云端浏览器中未能完整恢复`);
      moved.push(tab.url);
    }
    assert(moved.length, "没有可迁移的网页标签页");
    return moved;
  }

  private async dependencies(session: Session, options: HandoffOptions, services: Service[], recovering: boolean) {
    const deps: Dependency[] = [{ kind: "files", name: "工作区", status: "cloud", detail: "未提交改动与未跟踪文件已同步到云端副本" }];
    const previews = await this.engine.relay.previews(session.id);
    for (const preview of previews) {
      const service = services.find((item) => item.preview) || (services.length === 1 ? services[0] : undefined);
      deps.push(service ? { kind: "preview", name: previewOrigin(preview), status: "cloud", detail: `改由云端服务 ${service.name}:${service.port} 提供` }
        : { kind: "preview", name: previewOrigin(preview), status: "local", detail: "没有声明可在云端重建的预览服务，仍经流量中继访问本机" });
    }
    for (const require of options.requires || []) {
      assert(["intranet", "hardware", "certificate", "service"].includes(require.kind) && typeof require.name === "string" && require.name.length <= 260, "Invalid requirement");
      if (require.kind === "intranet") {
        const [host, port] = require.name.split(":");
        const ruled = (await this.store.objects<Obj>("client-relay")).some((row) => row.userId === session.ownerId && row.rules.includes(require.name));
        const open = !ruled && Number(port) > 0 && await this.reachable(host, Number(port));
        deps.push({ kind: "intranet", name: require.name, status: open ? "cloud" : "local", detail: ruled ? "仅本机可达（流量中继规则），客户端离线后不可用" : open ? "云端可直接访问" : "云端无法访问" });
      } else if (require.kind === "service") {
        deps.push({ kind: "service", name: require.name, status: services.some((item) => item.name === require.name) ? "cloud" : "local", detail: "需要在 services 中声明启动命令才能在云端重建" });
      } else deps.push({ kind: require.kind, name: require.name, status: "blocked", detail: "本机硬件或证书无法迁移；相关步骤需等待客户端或用户授权的替代方案" });
    }
    if (this.engine.localBrowser(session)) {
      const migrate = options.migrateBrowser && !recovering;
      deps.push({ kind: "browser", name: "本机浏览器（" + session.browserReason + "）", status: migrate ? "cloud" : recovering ? "blocked" : "local",
        detail: migrate ? "已授权迁移本任务标签页的 Cookie 与 Storage" : recovering ? "客户端离线，本机浏览器状态无法导出" : "例外留在本机的浏览器；未授权迁移" });
    }
    return deps;
  }

  /** Online handoff: quiesce → checkpoint → rebuild → reroute and verify → transfer ownership of the same session. */
  async handoff(key: string, options: HandoffOptions = {}) {
    return await this.lock(key, async () => {
      const session = await this.store.session(key), before = await this.fresh(session);
      assert(before.owner === "local", "执行权已在云端");
      this.agent(session);
      const previews = await this.engine.relay.previews(key);
      const tabs = (await Promise.all(previews.map((preview) => this.previewTabs(session, preview.host)))).flat();
      if (tabs.length && !options.acknowledgeReload)
        return this.view(await this.save(before, "needs_confirmation", `云端浏览器有 ${tabs.length} 个预览页面：切换后端后会刷新，WebSocket 会重连，未保存的草稿可能丢失。确认后带 acknowledgeReload 重试；本次未做任何改动。`));
      const unknown = await this.quiesce(key, "handoff");
      try {
        if (this.engine.active.has(key)) {
          this.engine.cancel(key);
          for (const deadline = Date.now() + 15000; this.engine.active.has(key);) { assert(Date.now() < deadline, "当前轮未能在安全边界停下，交接取消"); await sleep(25); }
        }
        const checkpoint = await this.capture(key, options, unknown);
        assert(checkpoint, "检查点没有生成");
        return await this.takeover(key, checkpoint, options, tabs, false);
      } finally { this.unquiesce(key); }
    });
  }
  /** Client vanished: rebuild only from the last complete checkpoint and say what is missing. */
  async recover(key: string, options: HandoffOptions = {}) {
    return await this.lock(key, async () => {
      const session = await this.store.session(key), record = await this.fresh(session);
      assert(record.owner === "local" && session.localAgent, "执行权不在本机，无需恢复");
      const agent = this.engine.localAgents.active(session.ownerId, session.clientId);
      assert(!agent || agent.reconnecting || !agent.transport, "客户端在线：请使用在线交接（handoff），它会先生成最新检查点");
      assert(!this.engine.active.has(key), "请先停止当前轮再恢复");
      assert(record.lastComplete, "没有完整的检查点，无法在云端恢复；等待客户端回来");
      const checkpoint = await this.loadCheckpoint(key, record.lastComplete);
      return await this.takeover(key, checkpoint, options, [], true);
    });
  }
  private async takeover(key: string, checkpoint: Checkpoint, options: HandoffOptions, tabs: { tag: string; url: string }[], recovering: boolean) {
    const session = await this.store.session(key), record = (await this.record(key))!;
    const place = await this.cloudTarget(session, record, options);
    const started: number[] = [], rerouted: { host: string; previous: PreviewBackend }[] = [];
    try {
      const applied = await this.apply(key, record, checkpoint, place);
      record.applied = { rev: checkpoint.rev, files: applied.files, untracked: applied.untracked };
      record.cloudCwd = place.cwd;
      let manifest: Obj | undefined;
      const manifestFile = await this.readMaybe(place.fs, join(applied.root, ".vega", "handoff.json"));
      if (manifestFile) try { manifest = JSON.parse(manifestFile.toString("utf8")); } catch { throw Error(".vega/handoff.json 不是合法 JSON"); }
      const services = this.services(options, manifest);
      const deps = await this.dependencies(session, options, services, recovering);
      if (recovering) deps.push({ kind: "files", name: "检查点之后的本机改动", status: "blocked", detail: `只恢复到 rev ${checkpoint.rev}（${new Date(checkpoint.at).toISOString()}）；之后的本机改动与进程状态不可得` });
      const unknown = [...checkpoint.unknown];
      if (deps.every((dep) => dep.status === "cloud" || (recovering && dep.name === "检查点之后的本机改动"))) {
        for (const command of [...(options.setup || manifest?.setup || [])]) {
          assert(typeof command === "string" && command.length <= 2000, "Invalid setup command");
          const r = await this.serverRun(command, applied.root, place.cloud, 600);
          assert(r.exitCode === 0, `云端准备命令失败：${command}\n${r.output.slice(-500)}`);
        }
        for (const service of services) {
          const pid = await this.startService(service, applied.root, key);
          if (pid) started.push(pid);
          await this.ready(service);
          record.services.push({ ...service, pid });
        }
        const target = services.find((item) => item.preview) || (services.length === 1 ? services[0] : undefined);
        for (const preview of await this.engine.relay.previews(key)) {
          rerouted.push({ host: preview.host, previous: preview.backend });
          await this.engine.relay.savePreview({ ...preview, backend: { kind: "cloud", port: target!.port } });
        }
        for (const preview of rerouted) await this.reloadVerify(session, tabs.filter((tab) => new URL(tab.url).host === preview.host), previewOrigin(preview));
        let moved: string[] = [];
        if (this.engine.localBrowser(session) && options.migrateBrowser) moved = await this.migrateBrowser(session);
        record.previews = [...record.previews.filter((item) => !rerouted.some((next) => next.host === item.host)), ...rerouted];
        record.deps = deps;
        record.depsVerified = deps.every((dep) => dep.status === "cloud");
        record.unknown = unknown;
        record.owner = "cloud";
        await this.transfer(session, { localAgent: false, cwd: place.cwd }, moved.length > 0);
        await this.note(session, `执行已${recovering ? "从检查点 rev " + checkpoint.rev + " 恢复" : "交接"}到云端，同一任务与会话继续。${unknown.length ? "以下操作结果不确定，先核验，不要重放：" + unknown.map((item) => item.tool).join("、") + "。" : ""}${record.conflicts.length ? "云端原有改动另存为 *.vega-cloud-* 副本。" : ""}浏览器保持原云端实例${moved.length ? "，已迁移本机标签页：" + moved.join("、") : ""}。`);
        const blocked = deps.filter((dep) => dep.status !== "cloud");
        return this.view(await this.save(record, "cloud_owned", blocked.length ? `已在云端继续，但以下内容缺失，相关步骤会阻塞：${blocked.map((dep) => dep.name).join("、")}` : ADVICE.cloud));
      }
      record.deps = deps;
      record.depsVerified = false;
      record.unknown = unknown;
      return this.view(await this.save(record, "files_synced_local_dependent", `${ADVICE.local}：${deps.filter((dep) => dep.status !== "cloud").map((dep) => `${dep.name}（${dep.detail}）`).join("；")}。执行权仍在本机，不要关闭电脑。`));
    } catch (error) {
      for (const pid of started) this.stopService(pid);
      record.services = record.services.filter((service) => !started.includes(service.pid!));
      for (const preview of rerouted) {
        const current = await this.engine.relay.preview(preview.host);
        if (current) await this.engine.relay.savePreview({ ...current, backend: preview.previous }).catch(() => {});
      }
      await this.save(record, "failed", `交接失败，已回滚服务与预览路由，执行权保持在本机：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  /** Moves the same session (and its task's future sessions) to the new execution location; browser stays cloud. */
  private async transfer(session: Session, to: { localAgent: false; cwd: string } | { localAgent: true; cwd: string; local: NonNullable<HandoffRecord["local"]> }, browserMoved = false) {
    const next = await this.store.session(session.id), previous = next.localAgent ? "client:" + next.clientId : "server";
    next.executionCwds = { ...next.executionCwds, [previous]: next.cwd, [to.localAgent ? "client:" + to.local.clientId : "server"]: to.cwd };
    next.cwd = to.cwd;
    next.localAgent = to.localAgent;
    next.clientId = to.localAgent ? to.local.clientId : undefined;
    next.clientName = to.localAgent ? to.local.clientName : undefined;
    next.localPlatform = to.localAgent ? to.local.platform : undefined;
    if (!to.localAgent || browserMoved) { next.browserLocation = undefined; next.browserReason = undefined; }
    await this.engine.releaseSession(next.id);
    await this.store.saveSession(next);
    this.engine.providers.reset(next.id);
    if (next.taskId && next.employeeId) {
      const employee = await this.engine.employee.for(next.employeeId);
      await employee.update((state) => {
        const task = employee.task(state, next.taskId!);
        task.cwd = to.cwd;
        task.execution = to.localAgent ? { localAgent: true, ownerId: next.ownerId, clientId: to.local.clientId, clientName: to.local.clientName, localPlatform: to.local.platform } : { localAgent: false, ownerId: next.ownerId };
        if (!to.localAgent || browserMoved) { task.browserLocation = undefined; task.browserReason = undefined; }
      });
    }
    this.engine.emit({ type: "execution_changed", session: next.id, data: next });
  }
  private async note(session: Session, text: string) {
    await this.store.append(session.id, { role: "assistant", notice: true, text: "[执行交接] " + text });
    if (session.taskId && session.employeeId) {
      const employee = await this.engine.employee.for(session.employeeId);
      await employee.update((state) => { const task = employee.task(state, session.taskId!); task.checkpoint = ((task.checkpoint || "") + "\n[执行交接] " + text).slice(-4000); });
    }
  }

  private async cloudFingerprint(record: HandoffRecord, session: Session) {
    const place = await this.cloudTarget(session, record, {});
    return createHash("sha256").update(await this.serverGit("git status --porcelain=v1 -z --untracked-files=all", place.cwd, place.cloud)).update(JSON.stringify(record.applied?.files || {})).digest("hex");
  }
  /** Copies cloud changes back to the client without moving execution; dirty local files are never overwritten. */
  async syncBack(key: string) {
    return await this.lock(key, async () => {
      const session = await this.store.session(key), record = await this.record(key);
      assert(record?.owner === "cloud" && record.local && record.applied, "执行权不在云端，无需回传");
      if (this.engine.active.has(key)) { record.pending = "sync_back"; return this.view(await this.save(record, record.phase, "云端任务正在执行；将在本轮结束的安全边界回传，不会打断它")); }
      return this.view(await this.reverseSync(session, record));
    });
  }
  private async reverseSync(session: Session, record: HandoffRecord) {
    const local = record.local!, agent = this.engine.localAgents.active(record.userId, local.clientId);
    assert(agent && agent.transport && !agent.reconnecting, "客户端离线，无法回传");
    const place = await this.cloudTarget(session, record, {}), root = place.cloud ? place.cwd : await nodefs.realpath(place.cwd);
    const cloudDirty = porcelain(await this.serverGit("git status --porcelain=v1 -z --untracked-files=all", root, place.cloud));
    const localDirty = new Set(porcelain(await this.clientGit(agent, local.cwd, "git status --porcelain=v1 -z --untracked-files=all")).map((entry) => entry.path));
    const applied = record.applied!.files, candidates = new Set([...cloudDirty.map((entry) => entry.path), ...Object.keys(applied)]);
    let copied = 0;
    const stamp = Date.now();
    for (const path of candidates) {
      if (syncable(path)) continue;
      const cloudData = await this.readMaybe(place.fs, await this.target(place.fs, root, path)), cloudSha = cloudData ? sha(cloudData) : null;
      if (path in applied && applied[path] === cloudSha) continue;
      const checked = await this.client(agent, "file", { op: "upload", cwd: local.cwd, path });
      const localData = checked.error ? undefined : Buffer.from((await this.client(agent, "file", { op: "read", cwd: local.cwd, path: checked.path })).content || "", "base64");
      const localSha = localData ? sha(localData) : null;
      if (localSha === cloudSha) continue;
      const untouched = path in applied ? applied[path] === localSha : !localDirty.has(path);
      if (cloudData === undefined) { if (untouched) record.pendingDeletes = [...new Set([...record.pendingDeletes, path])]; continue; }
      const write = async (target: string) => {
        const r = await this.client(agent, "file", { op: "write", cwd: local.cwd, path: target, content: cloudData.toString("base64") });
        assert(!r.error, `写回 ${target} 失败：${r.error}`);
      };
      if (untouched) { await write(path); copied++; }
      else { const copy = `${path}.vega-cloud-${stamp}`; await write(copy); record.conflicts.push({ path, copy, side: "local", at: stamp }); }
    }
    record.syncedBack = { at: Date.now(), fingerprint: await this.cloudFingerprint(record, session) };
    record.pending = undefined;
    const conflicts = record.conflicts.filter((item) => item.side === "local" && item.at === stamp).length;
    return await this.save(record, "synced_back", `已把 ${copied} 个云端改动回传本机${conflicts ? `；${conflicts} 个文件本机也有改动，云端版本另存为 *.vega-cloud-* 副本，本机文件未被覆盖` : ""}${record.pendingDeletes.length ? `；云端删除的 ${record.pendingDeletes.length} 个文件需在本机手动删除` : ""}。执行权仍在云端。`);
  }
  /** Returns execution to the client only on request and only at a safe boundary; a reconnect alone never does this. */
  async transferBack(key: string) {
    return await this.lock(key, async () => {
      const session = await this.store.session(key), record = await this.record(key);
      assert(record?.owner === "cloud" && record.local, "执行权不在云端");
      const agent = this.engine.localAgents.active(record.userId, record.local.clientId);
      assert(agent && agent.transport && !agent.reconnecting, "客户端离线，无法交回");
      if (this.engine.active.has(key)) { record.pending = "transfer_back"; return this.view(await this.save(record, "returning", "云端任务正在执行；将在本轮结束的安全边界交回本机，不会打断它")); }
      return this.view(await this.returnLocal(session, record));
    });
  }
  private async returnLocal(session: Session, record: HandoffRecord) {
    assert(record.syncedBack && record.syncedBack.fingerprint === await this.cloudFingerprint(record, session), "云端有尚未回传的改动；先执行 sync_back，再交回执行权");
    for (const preview of record.previews) {
      const current = await this.engine.relay.preview(preview.host);
      if (current) await this.engine.relay.savePreview({ ...current, backend: preview.previous });
    }
    for (const service of record.services) this.stopService(service.pid);
    const local = record.local!;
    await this.transfer(session, { localAgent: true, cwd: local.cwd, local });
    record.owner = "local";
    record.services = [];
    record.previews = [];
    record.pending = undefined;
    record.applied = undefined;
    await this.note(session, "执行权已交回本机；浏览器仍是云端浏览器。");
    return await this.save(record, "local_owned", "执行权已交回本机；预览恢复经流量中继访问本机服务。");
  }
  /**
   * Called only after a run has fully ended, including an in-run scene return.
   * A follow-up run (steer, or a later scene continuation that starts another turn) must not reach this:
   * pending ownership transfer waits until that turn ends, and a live turn is never interrupted.
   */
  async boundary(key: string) {
    const record = await this.record(key);
    if (!record?.pending || this.engine.active.has(key) || this.locks.has(key) || this.engine.closing) return;
    const pending = record.pending;
    await this.lock(key, async () => {
      if (this.engine.active.has(key)) return;
      const session = await this.store.session(key);
      try {
        if (pending === "sync_back") await this.reverseSync(session, record);
        else { await this.reverseSync(session, record); await this.returnLocal(session, (await this.record(key))!); }
      } catch (error) {
        record.pending = undefined;
        await this.save(record, record.owner === "cloud" ? "cloud_owned" : record.phase, `安全边界处理失败，执行权未变：${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch(() => {});
  }

  async preview(key: string, host: unknown, port: unknown) {
    const session = await this.store.session(key);
    assert(session.localAgent && session.clientId && session.ownerId, "预览后端经客户端流量中继访问本机服务；会话需在客户端执行");
    assert(typeof host === "string" && validRelayHost(host) && Number.isInteger(port) && (port as number) > 0 && (port as number) <= 65535, "预览后端需要客户端流量中继里的精确域名和端口，不能是 localhost 或 IP");
    await this.engine.relay.client(session.ownerId, session.clientId, host, port as number).catch((error) => {
      if (!/离线/.test(error.message)) throw error;
    });
    const preview = { host: previewHost(key), userId: session.ownerId, sessionId: key, backend: { kind: "client" as const, clientId: session.clientId, host, port: port as number }, updatedAt: Date.now() };
    await this.engine.relay.savePreview(preview);
    return { origin: previewOrigin(preview), backend: preview.backend };
  }
  async status(key: string) {
    const record = await this.record(key);
    const session = await this.store.session(key).catch(() => undefined);
    return {
      ...this.view(record),
      browser: { location: session?.browserLocation === "local" ? "local" : "cloud", reason: session?.browserReason || "" },
      previews: (await this.engine.relay.previews(key)).map((preview) => ({ origin: previewOrigin(preview), backend: preview.backend })),
    };
  }
  async control(key: string, a: Obj): Promise<any> {
    const options: HandoffOptions = {
      include: a.include, services: a.services, setup: a.setup, requires: a.requires, cloudCwd: a.cloudCwd,
      acknowledgeReload: a.acknowledgeReload === true, migrateBrowser: a.migrateBrowser === true,
    };
    assert(options.include === undefined || (Array.isArray(options.include) && options.include.length <= 50 && options.include.every((path) => typeof path === "string" && !syncable(path, [path]))), "include 只能列出工作区内的相对路径");
    assert(options.setup === undefined || (Array.isArray(options.setup) && options.setup.length <= 8), "setup 至多 8 条命令");
    assert(options.requires === undefined || (Array.isArray(options.requires) && options.requires.length <= 16), "requires 至多 16 项");
    assert(options.cloudCwd === undefined || typeof options.cloudCwd === "string", "Invalid cloudCwd");
    switch (a.action) {
      case "status": return await this.status(key);
      case "preview": return await this.preview(key, a.host, a.port);
      case "checkpoint": { const checkpoint = await this.checkpoint(key, options); return { rev: checkpoint.rev, files: checkpoint.files.length, skipped: checkpoint.skipped, unknown: checkpoint.unknown }; }
      case "handoff": return await this.handoff(key, options);
      case "recover": return await this.recover(key, options);
      case "sync_back": return await this.syncBack(key);
      case "transfer_back": return await this.transferBack(key);
    }
    throw Error("Unknown workspace action");
  }
  /** Coalesce a complete checkpoint. It does not run inline and does not take the execution-switch lock, so a follow-up turn can start. */
  scheduleCheckpoint(key: string) {
    if (!key || this.engine.closing) return;
    this.watched.add(key);
    this.dirty.add(key);
    const generation = (this.requestGen.get(key) || 0) + 1;
    this.requestGen.set(key, generation);
    if (this.debounce.has(key)) return;
    const timer = setTimeout(() => {
      this.debounce.delete(key);
      if (!this.dirty.has(key) || this.engine.closing) return;
      const started = this.requestGen.get(key);
      void this.enqueue(key, () => this.backgroundCapture(key)).then(() => {
        if (this.requestGen.get(key) === started) this.dirty.delete(key);
      }, () => { this.dirty.add(key); });
    }, this.debounceMs);
    timer.unref?.();
    this.debounce.set(key, timer);
    this.ensureTimer();
  }
  private dirty = new Set<string>();
  private requestGen = new Map<string, number>();
  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.engine.closing) return;
      for (const key of this.watched) {
        if (!this.dirty.has(key) && !this.engine.active.has(key)) continue;
        if (this.debounce.has(key) || this.checkpointTail.has(key)) continue;
        this.dirty.add(key);
        const started = this.requestGen.get(key) || 0;
        void this.enqueue(key, () => this.backgroundCapture(key)).then(() => {
          if ((this.requestGen.get(key) || 0) === started) this.dirty.delete(key);
        }, () => { this.dirty.add(key); });
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }
  private async backgroundCapture(key: string) {
    if (this.locks.has(key) || this.engine.executionSwitches.has(key) || this.engine.closing) return;
    let session: Session;
    try { session = await this.store.session(key); }
    catch { this.watched.delete(key); this.dirty.delete(key); return; }
    if (!session.localAgent) { this.watched.delete(key); this.dirty.delete(key); return; }
    await this.capture(key, {}, undefined, true);
  }
  /** Drop revision files older than the retained window. The newest complete revision is never removed first. */
  private async prune(key: string) {
    const record = await this.record(key);
    if (!record?.lastComplete || this.keepRevisions < 1) return;
    const dir = this.snapshotDir(key);
    const names = await nodefs.readdir(dir).catch(() => [] as string[]);
    const revs = names.flatMap((name) => { const match = /^rev-(\d+)\.json$/.exec(name); return match ? [Number(match[1])] : []; });
    const doomed = revs.filter((rev) => rev !== record.lastComplete && rev < record.lastComplete! - (this.keepRevisions - 1));
    if (!doomed.length) return;
    const kept = revs.filter((rev) => !doomed.includes(rev));
    const used = new Set<string>();
    for (const rev of kept) {
      const checkpoint = JSON.parse(await nodefs.readFile(join(dir, `rev-${rev}.json`), "utf8")) as Checkpoint;
      for (const file of checkpoint.files) if ("blob" in file) used.add(file.blob);
    }
    for (const rev of doomed) await nodefs.rm(join(dir, `rev-${rev}.json`), { force: true });
    for (const blob of await nodefs.readdir(join(dir, "blobs")).catch(() => [] as string[]))
      if (!used.has(blob) && /^[0-9a-f]{64}$/.test(blob)) await nodefs.rm(join(dir, "blobs", blob), { force: true });
  }
  /**
   * Copy one completed cloud-browser download into the client workspace.
   * The source must sit inside the browser profile; the client cwd is not a read root.
   */
  async exportDownload(key: string, a: Obj) {
    assert(a.authorize === true, "把云端浏览器的下载导回客户端需要显式授权");
    const destination = workspaceRelative(String(a.path || ""));
    assert(typeof a.downloadId === "string" && /^\d+$/.test(a.downloadId), "downloadId 必须是云端浏览器下载记录里的 ID");
    const session = await this.store.session(key);
    assert(!usesLocalBrowser(session), "本机浏览器的下载留在客户端，不会按服务器路径读取");
    const record = await this.record(key);
    const local = session.localAgent && session.clientId
      ? { userId: session.ownerId || record?.userId || "", clientId: session.clientId, cwd: session.cwd }
      : record?.owner === "cloud" && record.local
        ? { userId: record.userId, clientId: record.local.clientId, cwd: record.local.cwd }
        : undefined;
    assert(local?.clientId && local.cwd, "没有可写回的客户端工作区");
    const agent = this.engine.localAgents.active(local.userId, local.clientId);
    assert(agent?.transport && !agent.reconnecting, "客户端离线，下载不会改写服务器文件，也不会假称已导回");
    const chrome = this.engine.peekBrowser(session);
    assert(chrome, "云端浏览器未打开，没有可导出的下载");
    const listed = await chrome.bridge.request("downloads", { downloadId: a.downloadId });
    const item = (listed?.downloads || []).find((entry: Obj) => String(entry.id) === a.downloadId);
    assert(item?.state === "complete" && typeof item.path === "string", "下载未完成或不在云端浏览器的下载记录里");
    const ownerId = session.ownerId || local.userId;
    const roots = this.engine.browsers.downloadRoots(this.engine.browserProfileKey(ownerId));
    const entry = this.engine.browsers.entries.get(this.engine.browserProfileKey(ownerId));
    if (entry?.cloud) throw Error("隔离环境中的下载导回需要容器内路径复核，当前不会改从服务器同名路径读取");
    const data = await readRegularInside(roots, item.path);
    return await exportClientFile(clientFileOps(this.engine.localAgents, agent, AbortSignal.timeout(45000)), local.cwd, destination, data, true);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    this.watched.clear();
    this.dirty.clear();
    this.requestGen.clear();
    for (const quiesce of this.quiesced.values()) quiesce.release();
  }
}
