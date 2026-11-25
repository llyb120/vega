/**
 * 任务执行权调度：一个任务同一时刻只有一个执行位置（本地客户端 / 云端），
 * 交接是唯一改变它的方式；每次交接递增 epoch，旧端的结果不再推进任务。
 *
 * 规则（与产品约定一致）：
 * - 文件系统与浏览器绑定到同一执行端，交接时同步工作区与浏览器登录态。
 * - 本地在线时必须现读工作区。执行中的安全点只把相对已确认基线的增量推进到云端影子副本，不切换执行权。
 * - 客户端硬退出（连接已不在）不要把云端旧副本当成当前活工作区。有已确认的文件检查点就按影子副本还原到新目录；从未确认过就仍是空目录加文本还原点，并说明本机文件没有带过来。
 * - 只有目标端真的拿到工作区，才切换执行权；否则保持原样并记失败原因。回合进行中（isRunning）拒绝切换。
 * - 回传只写文件、不抢执行权；冲突两边都留，不覆盖任何一方。没进已确认检查点的改动留在本机，回连后按最后那份基线三方合并。
 * - 登录态：交接时把授权站点的 Cookie 与 storage 从源端搬到目标端（补齐不删）。
 */
import * as filesystem from "node:fs/promises";
import { relativePath, allowed, hash, manifest, merge, checkpointPlan, LIMITS } from "../../shared/workspace-sync.mjs";
import { beijingDateTime } from "../../shared/time";
import { browserOrigins, captureBrowser, injectBrowser, restoreBrowser } from "./browser-handoff";
import type { Chrome } from "./chrome";
import { shell } from "./tools";
import type { CloudRuntime } from "./cloud";
import type { Employee, Task } from "./employee";
import type { LocalAgents, Agent } from "./local-agent";
import type { Session, Store } from "./store";
import { assert, type Obj } from "./util";

/** Terminal task states (mirrors employee.ts; declared here so this module stays loadable on its own). */
const ENDED = new Set(["done", "failed", "stopped", "cancelled", "sealed"]);
const ended = (status: string) => ENDED.has(status);

const RECORD = "task-handoff";
const CONFLICT_SUFFIX = ".vega-conflict-";
const SCAN_TIMEOUT_MS = 120_000;
const CLOUD_ROOT = ".vega/handoffs";
const CHECKPOINT_ROOT = ".vega/checkpoints";
/** 没有已确认的文件检查点时，硬退出沿用这句话，不把云端旧副本当成工作区。 */
const OFFLINE_NOTE = "本地客户端已离线，以还原点为准，离线期间的新文件不在其中；本机文件没有带过来，动手前先核对现场；缺少必要文件或无法核验时用 task_ask_user 问用户，不凭空补写";

export type HandoffWhere = "local" | "cloud";
export type HandoffFile = { path: string; size: number; hash: string };
export type CheckpointSkip = { path: string; reason: string };
/** 一次已确认的增量包：written 是本次新内容（按摘要寻址），removed 是相对上一份基线消失的路径。 */
export type CheckpointPack = { written: HandoffFile[]; removed: string[] };
export type FileCheckpoint = {
  seq: number;
  at: number;
  /** 确认时的执行代次。检查点本身不递增代次。 */
  epoch: number;
  note?: string;
  files: HandoffFile[];
  pack: CheckpointPack;
  skipped?: CheckpointSkip[];
};
export type HandoffPolicy = {
  /** Enabled by default once configured; `false` stops manual and automatic handoff. */
  enabled?: boolean;
  /** Take the task over in the cloud when its client goes offline for good. */
  auto?: boolean;
  /** Named commands pinned to one side (mixed execution for a single task). */
  commands?: { name: string; where: HandoffWhere }[];
  /** One-off command run in the cloud workspace before the execution right is handed over (install/build). */
  prepare?: string;
  /** 迁移登录态的授权站点（最多 20 个）：只导出这些站点的 Cookie 与页面存储。 */
  sites?: string[];
};
export type HandoffRecord = {
  taskId: string;
  employeeId: string;
  ownerId: string;
  where: HandoffWhere;
  phase: "ready" | "failed";
  epoch: number;
  source: "manual" | "auto";
  at: number;
  clientId?: string;
  /** The client-side workspace the transfer started from. */
  localCwd?: string;
  /** The cloud workspace the task continues in. */
  cloudCwd?: string;
  base: HandoffFile[];
  /** 已确认文件的云端影子目录。不是执行工作区，硬退出时复制出去，不在这里接着改。 */
  shadowCwd?: string;
  /** 最近一次确认的文件检查点。没有它，硬退出仍是空目录。 */
  checkpoint?: FileCheckpoint;
  /** 登录态密文（vault 加密）：不进入模型上下文、日志或经验库。 */
  browser?: string;
  browserNote?: string;
  browserSites?: string[];
  note?: string;
  error?: string;
  conflicts?: string[];
};
export type HandoffDeps = {
  store: Store;
  employees: () => Promise<Employee[]>;
  employeeFor: (employeeId: string) => Promise<Employee>;
  agents: LocalAgents;
  isRunning: (session?: string) => boolean;
  cloud: (ownerId: string) => CloudRuntime | undefined;
  browsers: { local: (session: Session) => Promise<Chrome>; cloud: (session: Session) => Promise<Chrome> };
  /** List online clientIds for this owner (same account only). */
  onlineClients?: (ownerId: string) => { id: string }[];
  /** Release a local browser lease taken for an on-demand login-state sync (keyed by session id). */
  releaseLocal?: (key: string) => Promise<void>;
  seal: (value: any, aad: string) => Promise<string>;
  open: (blob: string, aad: string) => Promise<any>;
};

const join = (cwd: string, path: string) => (cwd.endsWith("/") || cwd.endsWith("\\") ? cwd + path : cwd + "/" + path);
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const sameFiles = (left: HandoffFile[] = [], right: HandoffFile[] = []) => {
  if (left.length !== right.length) return false;
  const hashes = new Map(right.map((file) => [file.path, file.hash]));
  return left.every((file) => hashes.get(file.path) === file.hash);
};
const sameSkipped = (left: CheckpointSkip[] = [], right: CheckpointSkip[] = []) => {
  if (left.length !== right.length) return false;
  const reasons = new Map(right.map((item) => [item.path, item.reason]));
  return left.every((item) => reasons.get(item.path) === item.reason);
};

/** Handoff steps are serialised per task: two transfers must never interleave. */
export class TaskHandoffs {
  private locks = new Map<string, Promise<any>>();
  private settled = new Map<string, number>();
  constructor(private deps: HandoffDeps) {}

  async record(taskId: string) {
    return this.deps.store.object<HandoffRecord>(RECORD, taskId);
  }
  async policy(employeeId: string): Promise<HandoffPolicy> {
    const employee = await this.deps.employeeFor(employeeId);
    const state = await employee.state({ runs: false });
    return (state.handoffPolicy as HandoffPolicy) || {};
  }
  async configure(employeeId: string, input: Obj) {
    const current = await this.policy(employeeId);
    const commands = Array.isArray(input.commands)
      ? input.commands.map((item: Obj) => {
          const name = String(item?.name || "").trim();
          assert(name && ["local", "cloud"].includes(item?.where), "命令规则需要命令名和 local/cloud");
          return { name, where: item.where as HandoffWhere };
        })
      : current.commands;
    const next: HandoffPolicy = {
      enabled: input.enabled === undefined ? current.enabled ?? true : !!input.enabled,
      auto: input.auto === undefined ? current.auto !== false : !!input.auto,
      commands,
      prepare: input.prepare === undefined ? current.prepare : (String(input.prepare || "").trim() || undefined),
      sites: input.sites === undefined ? current.sites : (Array.isArray(input.sites) && input.sites.length ? browserOrigins(input.sites) : undefined),
    };
    assert(!next.prepare || next.prepare.length <= 2000, "环境准备命令太长（上限 2000 字）");
    const employee = await this.deps.employeeFor(employeeId);
    await employee.update((state) => {
      state.handoffPolicy = next;
      return state;
    });
    return next;
  }
  /** Which side an explicit named command must run on; undefined keeps the task's current side. */
  async commandSide(employeeId: string, command: string) {
    const rules = (await this.policy(employeeId)).commands || [];
    if (!rules.length) return undefined;
    const name = String(command || "").trim().split(/\s+/)[0] || "";
    return rules.find((rule) => rule.name === name)?.where;
  }
  async status(employeeId: string, taskId: string) {
    const employee = await this.deps.employeeFor(employeeId);
    const state = await employee.state({ runs: false });
    const task = employee.task(state, taskId);
    const record = await this.record(taskId);
    const clientId = task.execution?.clientId;
    const online = !!clientId && !!this.deps.agents.active(state.ownerId, clientId);
    return {
      taskId,
      where: task.execution?.localAgent ? "local" : "cloud",
      clientId,
      clientOnline: online,
      cloudReady: !!this.deps.cloud(state.ownerId || task.execution?.ownerId || ""),
      record,
      note: record?.note || "",
    };
  }

  async toCloud(employeeId: string, taskId: string, opts: Obj = {}) {
    return this.exclusive(taskId, async () => {
      const employee = await this.deps.employeeFor(employeeId);
      let state = await employee.state({ runs: false });
      const task = employee.task(state, taskId);
      assert(!ended(task.status), "任务已结束，不需要交接");
      assert(!this.running(task), "任务这一轮还在执行；等这一步结束或先停止任务再交接");
      const ownerId = state.ownerId || task.execution?.ownerId || task.owner?.token || "";
      const cloud = this.deps.cloud(ownerId);
      assert(cloud, "未启用云端隔离，无法交接到云端");
      const policy = await this.policy(employeeId);
      assert(policy.enabled !== false, "接力未启用");
      const record = (await this.record(taskId)) || this.fresh(taskId, employeeId, ownerId, "manual");
      const clientId = task.execution?.clientId;
      const agent = clientId ? this.deps.agents.active(ownerId, clientId) : undefined;
      const notes: string[] = [];
      let files: HandoffFile[] = [];
      const contents = new Map<string, Buffer>();

      let shadowCwd = record.shadowCwd;
      let checkpoint = record.checkpoint;
      if (agent) {
        const scanned = await this.scanLocal(agent, task.cwd);
        files = scanned.files;
        for (const [path, data] of scanned.contents) contents.set(path, data);
        notes.push("工作区按本地当前内容同步");
        try {
          const saved = await this.storeCheckpoint(cloud, taskId, record, files, contents, this.packOf(record.base, files), [], this.stepNote(task), record.epoch + 1);
          shadowCwd = saved.shadowCwd;
          checkpoint = saved.checkpoint;
        } catch { /* 执行副本已经写到云端工作区；影子没写上时，硬退出不会拿对不上的旧检查点 */ }
      } else {
        // 硬退出：连接已经不在。只还原最后一次确认的影子副本，不用云端旧的执行目录。
        const restored = await this.restoreCheckpoint(cloud, record);
        if (restored) {
          files = restored.files;
          for (const [path, data] of restored.contents) contents.set(path, data);
          notes.push(this.confirmedNote(restored.checkpoint));
        } else {
          notes.push(OFFLINE_NOTE);
          files = [];
        }
      }

      const cloudCwd = agent
        ? (record.cloudCwd || (await this.cloudRoot(cloud, taskId)))
        : await this.cloudRoot(cloud, taskId + "-restore-" + Date.now());
      const previousShadow = record.shadowCwd;
      await this.writeCloud(cloud, cloudCwd, contents);
      // 只在云端真的能继续时才交接：准备命令是一次性安装/构建，长驻服务由任务自己在云端启动。
      if (policy.prepare) {
        const prepared = await shell(cloudCwd, { command: policy.prepare, timeout: 600 }, AbortSignal.timeout(660_000), () => {}, cloud);
        assert(!prepared.error, "云端环境准备失败，未切换执行权：" + String((prepared.value as Obj)?.output || "").slice(-600));
        notes.push("已在云端完成环境准备");
      } else {
        notes.push("未配置环境准备命令：依赖本地服务的步骤需在云端重新启动后再继续");
      }
      // 登录态：执行权交到云端时，浏览器也回到云端——从刚离线/交接的本机浏览器采集授权站点。复制不等于登录成功，恢复后必须打开页面核对。
      const sites = policy.sites || [];
      const browserTarget = this.browserBinding(false);
      let sealed = "";
      let browserNote = "";
      let browserSites: string[] = [];
      if (task.execution?.localBrowser && !browserTarget.localBrowser) {
        try {
          const local = await this.browserChrome(task, "local");
          if (!local) browserNote = "本机浏览器未连接，登录态未迁移";
          else {
            const state = await captureBrowser(local, sites, AbortSignal.timeout(60_000));
            browserSites = state.origins;
            sealed = await this.deps.seal(state, "browser-handoff:" + taskId);
            browserNote = `已采集 ${state.cookies.length} 个 Cookie 与 ${state.pages.length} 个页面存储（${state.origins.join("，")}）`;
            if (state.warnings.length) browserNote += "（" + state.warnings.slice(0, 2).join("；") + "）";
          }
        } catch (error: any) {
          browserNote = "登录态未迁移：" + String(error?.message || error).slice(0, 200);
        }
      } else if (sites.length) browserNote = "浏览器已在云端，登录态不需要迁移";
      if (task.side === "computer") notes.push("这是电脑会话任务：浏览器与桌面默认在云端，本机专属能力仍需本地");

      const next: HandoffRecord = {
        ...record,
        where: "cloud",
        phase: "ready",
        epoch: record.epoch + 1,
        source: opts.source === "auto" ? "auto" : "manual",
        at: Date.now(),
        clientId,
        localCwd: record.where === "local" ? task.cwd : record.localCwd,
        cloudCwd,
        base: files,
        shadowCwd,
        checkpoint,
        note: notes.join("；"),
        error: undefined,
        conflicts: record.conflicts || [],
        browser: sealed || record.browser,
        browserNote,
        browserSites: browserSites.length ? browserSites : record.browserSites,
      };
      await this.switch(employee, taskId, next, { localAgent: false, clientId: undefined, cwd: cloudCwd, expectedStatus: task.status, ...this.browserBinding(false) });
      // 恢复在交接之后：执行权已在云端，页面停在授权站点上，下一次观察直接看到真实结果。
      if (next.browser && next.browserSites?.length) {
        try {
          const fresh = employee.task(await employee.state({ runs: false }), taskId);
          const remote = await this.browserChrome(fresh, "cloud");
          if (!remote) next.browserNote = browserNote + "；云端浏览器不可用，登录态未恢复";
          else {
            const state = await this.deps.open(next.browser, "browser-handoff:" + taskId);
            const restored = await restoreBrowser(remote, state, AbortSignal.timeout(150_000));
            next.browserNote = browserNote + "；云端" + (restored.ok ? "已恢复并核对：" : "恢复失败：") +
              restored.pages.map((page) => `${page.needLogin ? "需重新登录" : "已登录"} ${page.url}`).join("，") +
              (restored.warnings.length ? "（" + restored.warnings.slice(0, 2).join("；") + "）" : "");
          }
        } catch (error: any) {
          next.browserNote = browserNote + "；云端恢复失败：" + String(error?.message || error).slice(0, 200);
        }
      }
      next.note = [...notes, next.browserNote].filter(Boolean).join("；");
      await this.deps.store.save(RECORD, taskId, next);
      if (shadowCwd && previousShadow && previousShadow !== shadowCwd) await this.dropShadow(cloud, previousShadow);
      return next;
    });
  }

  async toLocal(employeeId: string, taskId: string, opts: Obj = {}) {
    return this.exclusive(taskId, async () => {
      const employee = await this.deps.employeeFor(employeeId);
      const state = await employee.state({ runs: false });
      const task = employee.task(state, taskId);
      assert((await this.policy(employeeId)).enabled !== false, "接力未启用");
      assert(!["done", "sealed"].includes(task.status), "任务已完成或封存，不能交接");
      assert(!task.execution?.localAgent, "任务已经在本机执行");
      assert(!this.running(task) && !employee.busy?.has(taskId), "任务这一轮还在执行；等这一步结束或再交接");
      const ownerId = state.ownerId || task.execution?.ownerId || task.owner?.token || "";
      const record = await this.record(taskId);
      const clientId = String(opts.clientId || record?.clientId || task.execution?.clientId || "");
      const agent = clientId ? this.deps.agents.active(ownerId, clientId) : this.deps.agents.active(ownerId);
      assert(agent, "本地客户端未在线，无法把执行权交回本机");
      const sameClient = !record?.clientId || record.clientId === agent.clientId;
      const sameCloud = !!record?.cloudCwd && record.cloudCwd === task.cwd;
      const cwd = (sameClient && sameCloud && record?.localCwd) || agent.cwd;
      const cloud = this.deps.cloud(ownerId);
      if (record?.cloudCwd) assert(cloud, "云端工作区不可用，未切换执行权");
      let scanned: { files: HandoffFile[]; contents: Map<string, Buffer> } = { files: [], contents: new Map() };
      let applied = { conflicts: [] as string[], changed: 0 };
      if (record?.cloudCwd || task.workSession || task.computerSession) {
        if (!record?.cloudCwd) assert(["stopped", "failed", "cancelled", "waiting", "approval"].includes(task.status), "云端任务已开始，请先停止再交到本机");
        scanned = await this.scanCloud(cloud || { fs: filesystem }, task.cwd);
        applied = await this.applyLocal(agent, cwd, sameClient && sameCloud ? record?.base || [] : [], scanned, "cloud");
      }
      let shadowCwd = record?.shadowCwd;
      let checkpoint = record?.checkpoint;
      const previousShadow = shadowCwd;
      if (record?.cloudCwd || task.workSession || task.computerSession) {
        const baseline = record || this.fresh(taskId, employeeId, ownerId, "manual");
        if (cloud) {
          try {
            const saved = await this.storeCheckpoint(cloud, taskId, baseline, scanned.files, scanned.contents, this.packOf(baseline.base, scanned.files), [], this.stepNote(task), (record?.epoch || 0) + 1);
            shadowCwd = saved.shadowCwd;
            checkpoint = saved.checkpoint;
          } catch {
            if (!sameFiles(checkpoint?.files, scanned.files)) { shadowCwd = undefined; checkpoint = undefined; }
          }
        } else if (!sameFiles(checkpoint?.files, scanned.files)) {
          shadowCwd = undefined;
          checkpoint = undefined;
        }
      }
      const next: HandoffRecord = {
        ...(record || this.fresh(taskId, employeeId, ownerId, "manual")),
        where: "local",
        phase: "ready",
        epoch: (record?.epoch || 0) + 1,
        source: opts.source === "auto" ? "auto" : "manual",
        at: Date.now(),
        clientId: agent.clientId,
        localCwd: cwd,
        cloudCwd: sameCloud ? record?.cloudCwd : undefined,
        base: scanned.files,
        shadowCwd,
        checkpoint,
        conflicts: applied.conflicts,
        note: [
          "执行权已交回本机",
          applied.conflicts.length ? `有 ${applied.conflicts.length} 个文件两边都改过，保留为 ${CONFLICT_SUFFIX}cloud 副本` : "",
        ].filter(Boolean).join("；"),
        error: undefined,
      };
      await this.switch(employee, taskId, next, { localAgent: true, clientId: agent.clientId, cwd, clientName: agent.name, localPlatform: agent.platform, expectedStatus: task.status, ...this.browserBinding(true, agent.clientId) });
      if (next.browser && next.browserSites?.length) {
        next.browserNote = "授权站点的登录态将在首次使用本机浏览器时按需补齐，不覆盖已有登录";
        next.note = [next.note, next.browserNote].filter(Boolean).join("；");
      }
      await this.deps.store.save(RECORD, taskId, next);
      if (cloud && shadowCwd && previousShadow && previousShadow !== shadowCwd) await this.dropShadow(cloud, previousShadow);
      return next;
    });
  }

  /** 设备回连：自动接到云端执行的任务，若它的工作区在这台回连的设备上，就搬回本机继续（手动交接的仍由用户决定，运行中的等这一轮结束）。 */
  async backHome(ownerId?: string) {
    for (const employee of await this.deps.employees()) {
      const state = await employee.state({ runs: false });
      if (ownerId && state.ownerId !== ownerId) continue;
      for (const task of state.tasks) {
        if (ended(task.status)) continue;
        const record = await this.record(task.id);
        if (!record || record.where !== "cloud" || record.phase !== "ready" || record.source !== "auto" || !record.clientId) continue;
        if (this.running(task)) continue;
        const agent = this.deps.agents.active(record.ownerId, record.clientId);
        // 设备不在线就继续留在云端：工作区本来就在这台设备上，回连后接回去。
        if (!agent) continue;
        try { await this.toLocal(employee.employeeId, task.id, { source: "auto", clientId: agent.clientId }); }
        catch { /* 没接住就留在云端，下次回连或手动接回 */ }
      }
    }
  }

  /** The client came back: merge cloud progress into its workspace without taking the execution right back. */
  async syncBack(clientId: string, ownerId?: string) {
    const employees = await this.deps.employees();
    for (const employee of employees) {
      const state = await employee.state({ runs: false });
      if (ownerId && state.ownerId !== ownerId) continue;
      for (const task of state.tasks) {
        if (ended(task.status)) continue;
        const record = await this.record(task.id);
        if (!record || record.where !== "cloud" || record.phase !== "ready") continue;
        if (record.source === "auto") continue; // 自动接管的由 backHome 搬回本机，不单独回传
        if (!record.clientId || record.clientId !== clientId) continue;
        const agent = this.deps.agents.active(state.ownerId, clientId);
        const cloud = this.deps.cloud(state.ownerId || "");
        if (!agent || !cloud || !record.cloudCwd || !record.localCwd) continue;
        await this.exclusive(task.id, async () => {
          const [local, remote] = await Promise.all([this.scanLocal(agent, record.localCwd!), this.scanCloud(cloud, record.cloudCwd!)]);
          const applied = await this.applyLocal(agent, record.localCwd!, record.base, remote, "cloud");
          const merged = manifest([
            ...local.files.map((file) => ({ ...file, data: local.contents.get(file.path) })),
            ...remote.files.filter((file) => !local.contents.has(file.path)).map((file) => ({ ...file, data: remote.contents.get(file.path) })),
          ]);
          await this.deps.store.save(RECORD, task.id, {
            ...record,
            base: merged,
            at: Date.now(),
            conflicts: applied.conflicts,
            note: applied.conflicts.length
              ? `已回传云端成果；${applied.conflicts.length} 个文件两边都改过，本地原文件保留，云端版本另存 ${CONFLICT_SUFFIX}cloud`
              : `已回传云端成果；执行权仍在云端，需要时手动接回本机`,
          } satisfies HandoffRecord);
        });
      }
    }
  }

  /**
   * 按需共享登录态：同一账号的云端与各客户端浏览器互通有无（多退少补）。
   * 任务选定浏览器端后、首次用浏览器前，把其余在线端在授权站点上的 Cookie 与 storage 补进目标端——
   * 补齐不删、不落盘、源端须在线；源端离线或没有授权站点就跳过，失败不阻断任务。
   */
  async ensureBrowserState(session: Session) {
    const employeeId = session.employeeId, taskId = session.taskId;
    if (!employeeId || !taskId) return;
    const employee = await this.deps.employeeFor(employeeId);
    const sites = (await this.policy(employeeId)).sites || [];
    if (!sites.length) return; // 没授权站点就不擅自搬登录态
    const targetLocal = !!session.localBrowser;
    const targetClient = session.browserClientId || session.clientId || "";
    return this.exclusive("browser:" + taskId, async () => {
      const task = employee.task(await employee.state({ runs: false }), taskId);
      if (task.browserSyncedAt && task.browserSyncVersion === 2) return;
      const ownerId = task.execution?.ownerId || task.owner?.token || "";
      const target = await this.browserChrome(task, targetLocal ? "local" : "cloud");
      assert(target, targetLocal ? "本机浏览器不可用，登录态未同步" : "云端浏览器不可用，登录态未同步");
      const sources: { side: "local" | "cloud"; clientId?: string }[] = [];
      if (targetLocal) sources.push({ side: "cloud" });
      for (const client of this.deps.onlineClients?.(ownerId) || [])
        if (!targetLocal || client.id !== targetClient) sources.push({ side: "local", clientId: client.id });
      const merged: string[] = [];
      const warnings: string[] = [];
      let complete = sources.length > 0, hasState = false;
      for (const source of sources) {
        const probeKey = session.id + ":sync";
        try {
          const origin = await this.browserChrome(task, source.side, source.clientId, probeKey);
          if (!origin) { complete = false; warnings.push(source.clientId ? `客户端 ${source.clientId.slice(0, 8)} 浏览器不可达` : "云端浏览器不可达"); continue; }
          const captured = await captureBrowser(origin, sites, AbortSignal.timeout(60_000));
          if (captured.incomplete) complete = false;
          if (!captured.cookies.length && !captured.pages.some((page) => Object.keys(page.localStorage).length || Object.keys(page.sessionStorage).length)) {
            complete = false;
            warnings.push(...captured.warnings);
            continue;
          }
          hasState = true;
          const applied = await injectBrowser(target, captured, AbortSignal.timeout(90_000));
          if (applied.ok || applied.cookies || applied.storage) merged.push(...captured.origins);
          if (!applied.ok) complete = false;
          warnings.push(...applied.warnings);
        } catch (error: any) {
          complete = false;
          warnings.push((source.clientId ? `客户端 ${source.clientId.slice(0, 8)}` : "云端") + "登录态未同步：" + String(error?.message || error).slice(0, 120));
        } finally {
          if (source.side === "local") await this.deps.releaseLocal?.(probeKey).catch(() => {});
        }
      }
      await employee.update((state) => {
        const current = employee.task(state, taskId);
        if (complete && hasState) {
          current.browserSyncedAt = Date.now();
          current.browserSyncVersion = 2;
        } else {
          delete current.browserSyncedAt;
          delete current.browserSyncVersion;
        }
        current.browserSyncNote = complete && hasState
          ? `已把 ${[...new Set(merged)].join("、")} 的登录态同步到${targetLocal ? "本机" : "云端"}浏览器`
          : "登录态同步未完成：" + (warnings.slice(0, 3).join("；") || "没有可用的登录态来源");
        return state;
      });
      return { ok: complete && hasState, origins: [...new Set(merged)], warnings };
    });
  }

  /** A client left for good (past the reconnect grace): take over its tasks unless auto handoff was turned off. */
  async clientsGone(clientId: string, ownerId?: string) {
    if (this.deps.agents.active(ownerId || "", clientId)) return;
    await this.takeOver(clientId, ownerId);
  }
  /** 客户端在线但本地改成了服务端优先：把绑定它的任务搬到云端继续。 */
  async preferCloud(clientId: string, ownerId?: string) {
    if (!this.deps.agents.active(ownerId || "", clientId)) return;
    await this.takeOver(clientId, ownerId);
  }
  /**
   * 用户在自己电脑上按了「下线」：连接还在就软交接（现读工作区与登录态），
   * 已经不在线就没东西可搬，服务端按最近还原点硬交接。
   */
  async offline(clientId: string, ownerId?: string) {
    const soft = !!this.deps.agents.active(ownerId || "", clientId);
    return { mode: soft ? "soft" : "hard", ...(await this.takeOver(clientId, ownerId)) };
  }
  private async takeOver(clientId: string, ownerId?: string) {
    const done = { tasks: 0, failed: [] as { taskId: string; error: string }[] };
    const employees = await this.deps.employees();
    for (const employee of employees) {
      const state = await employee.state({ runs: false });
      if (ownerId && state.ownerId !== ownerId) continue;
      const policy = await this.policy(employee.employeeId);
      // 默认接管：客户端退出或改到服务端优先后就在云端继续，不需要先配置开关。
      if (policy.auto === false || policy.enabled === false) continue;
      for (const task of state.tasks) {
        if (ended(task.status) || task.deviceOnly || task.execution?.localAgent !== true || task.execution?.clientId !== clientId) continue;
        const record = await this.record(task.id);
        if (record?.where === "cloud") continue;
        try {
          await this.toCloud(employee.employeeId, task.id, { source: "auto" });
          done.tasks++;
        } catch (error: any) {
          const message = String(error?.message || error).slice(0, 300);
          done.failed.push({ taskId: task.id, error: message });
          const failed: HandoffRecord = {
            ...(record || this.fresh(task.id, employee.employeeId, state.ownerId || "", "auto")),
            where: "local",
            phase: "failed",
            at: Date.now(),
            error: message,
          };
          await this.deps.store.save(RECORD, task.id, failed);
        }
      }
    }
    return done;
  }

  /** One entry point for clients_changed: take over tasks whose client is gone, merge progress on those back. */
  async clients(value: Obj) {
    if (value?.type !== "clients_changed") return;
    const userId = String(value.targetUser || "");
    if (!userId) return;
    // 一次连接/断开可能连发多个事件：同一用户短时间内只结算一次。
    const last = this.settled.get(userId) || 0;
    if (Date.now() - last < 400) return;
    this.settled.set(userId, Date.now());
    const clientIds = new Set<string>();
    for (const employee of await this.deps.employees()) {
      const state = await employee.state({ runs: false });
      if (state.ownerId !== userId) continue;
      for (const task of state.tasks) if (task.execution?.clientId) clientIds.add(task.execution.clientId);
    }
    for (const record of (await this.deps.store.objects<HandoffRecord>(RECORD)) || [])
      if (record.ownerId === userId && record.clientId) clientIds.add(record.clientId);
    for (const clientId of clientIds) {
      const agent = this.deps.agents.active(userId, clientId);
      if (agent) await this.syncBack(clientId, userId).catch(() => {});
      else await this.clientsGone(clientId, userId).catch(() => {});
    }
    // 回来的设备若仍有绑定它的任务：云端自动接管的那一轮结束后搬回本机继续。
    await this.backHome(userId).catch(() => {});
  }


  /** 浏览器端跟随任务工作区所在端：本机执行就用本机浏览器，云端执行就用云端浏览器。 */
  private browserBinding(local: boolean, clientId?: string) {
    return {
      localBrowser: local,
      browserClientId: local ? clientId || "" : "",
    };
  }

  private running(task: Task) {
    return [task.workSession, task.computerSession].some((session) => !!session && this.deps.isRunning(session));
  }
  private fresh(taskId: string, employeeId: string, ownerId: string, source: "manual" | "auto"): HandoffRecord {
    return { taskId, employeeId, ownerId, where: "local", phase: "ready", epoch: 0, source, at: Date.now(), base: [] };
  }
  private async exclusive<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) || Promise.resolve();
    const current = previous.then(run, run);
    this.locks.set(taskId, current.catch(() => {}));
    try {
      return await current;
    } finally {
      if (this.locks.get(taskId) === current) this.locks.delete(taskId);
    }
  }
  private async cloudRoot(cloud: CloudRuntime, taskId: string) {
    return this.ensureCloudDir(cloud, CLOUD_ROOT + "/" + taskId);
  }
  /** Switch the execution right on the task and every session it owns, then let the scheduler continue. */
  private async switch(employee: Employee, taskId: string, record: HandoffRecord, target: Obj) {
    await this.deps.store.transaction(async () => {
      const state = await employee.update((s) => {
        const task = employee.task(s, taskId);
        if (target.expectedStatus !== undefined)
          assert(task.status === target.expectedStatus && !this.running(task) && !employee.busy?.has(taskId), "任务状态已变化，请先停止后重新交接");
        if (target.localBrowser !== undefined && (!!task.execution?.localBrowser !== !!target.localBrowser || (task.execution?.browserClientId || "") !== (target.browserClientId || ""))) {
          delete task.browserSyncedAt;
          delete task.browserSyncVersion;
          delete task.browserSyncNote;
        }
        task.execution = {
          ...(task.execution || {}),
          localAgent: !!target.localAgent,
          clientId: target.clientId,
          clientName: target.clientName,
          localPlatform: target.localPlatform,
          ownerId: record.ownerId || task.execution?.ownerId,
          ...(target.localBrowser === undefined ? {} : { localBrowser: !!target.localBrowser }),
          ...(target.browserClientId === undefined ? {} : { browserClientId: target.browserClientId || undefined }),
        };
        task.cwd = String(target.cwd);
        task.handoffState = { where: record.where, epoch: record.epoch, at: record.at, note: record.note, error: record.error };
        // 只重新排期可自动调度的状态；等用户补充（waiting）不得被交接变成重新开工。
        if (["queued", "deferred", "recovering"].includes(task.status)) {
          task.queueReason = record.where === "cloud" ? "已交接到云端，继续执行" : "已交回本机，继续执行";
          task.status = "queued";
          task.nextCheckAt = 0;
        }
        return s;
      });
      const task = employee.task(state, taskId);
      for (const id of [task.workSession, task.computerSession]) if (id) {
        const session = await this.deps.store.session(id);
        session.localAgent = !!target.localAgent;
        session.clientId = target.clientId;
        session.clientName = target.clientName;
        session.localPlatform = target.localPlatform;
        if (target.localBrowser !== undefined) session.localBrowser = !!target.localBrowser;
        if (target.browserClientId !== undefined) session.browserClientId = target.browserClientId || undefined;
        session.cwd = String(target.cwd);
        await this.deps.store.saveSession(session);
      }
      await this.deps.store.save(RECORD, taskId, record);
    });
  }

  /** The browser this task would use on one side, if it can be reached at all. `probeKey` gives the local lease a separate key so a sync doesn't take over the task's own lease. */
  private async browserChrome(task: Task, side: "local" | "cloud", clientId?: string, probeKey?: string) {
    const sessionId = task.computerSession || task.workSession;
    if (!sessionId) return undefined;
    try {
      const session = await this.deps.store.session(sessionId);
      if (!session.ownerId) return undefined;
      if (side === "local") {
        const probe = { ...session, localBrowser: true };
        if (clientId) { probe.browserClientId = clientId; probe.clientId = clientId; }
        if (probeKey) probe.id = probeKey;
        return await this.deps.browsers.local(probe);
      }
      return await this.deps.browsers.cloud(session);
    } catch {
      return undefined;
    }
  }

  /**
   * 本机仍在执行时，把工作区相对已确认基线的增量推进到云端影子副本。
   * 只更新文件基线，不切换执行权，也不增加执行代次。客户端不在线就什么都不确认。
   */
  async checkpoint(employeeId: string, taskId: string, opts: { note?: string } = {}) {
    return this.exclusive(taskId, async () => {
      const employee = await this.deps.employeeFor(employeeId);
      const state = await employee.state({ runs: false });
      const task = employee.task(state, taskId);
      if (["done", "failed", "cancelled", "sealed"].includes(task.status)) return;
      if (task.execution?.localAgent !== true) return;
      const ownerId = state.ownerId || task.execution?.ownerId || task.owner?.token || "";
      const clientId = task.execution?.clientId || "";
      if (!ownerId || !clientId) return;
      const cloud = this.deps.cloud(ownerId);
      const agent = this.deps.agents.active(ownerId, clientId);
      if (!cloud || !agent) return;
      const record = (await this.record(taskId)) || this.fresh(taskId, employeeId, ownerId, "manual");
      const scanned = await this.scanDelta(agent, task.cwd, record.base || [], cloud, taskId);
      const note = opts.note !== undefined ? this.clipNote(opts.note) : this.stepNote(task);
      const saved = await this.storeCheckpoint(cloud, taskId, record, scanned.files, scanned.contents, scanned.pack, scanned.skipped, note, record.epoch);
      if (!saved.changed && record.checkpoint) return record;
      const previousShadow = record.shadowCwd;
      const next: HandoffRecord = {
        ...record,
        clientId: record.clientId || clientId,
        localCwd: record.localCwd || task.cwd,
        base: scanned.files,
        shadowCwd: saved.shadowCwd,
        checkpoint: saved.checkpoint,
      };
      await this.deps.store.save(RECORD, taskId, next);
      if (previousShadow && previousShadow !== saved.shadowCwd) await this.dropShadow(cloud, previousShadow);
      return next;
    });
  }

  private clipNote(value: unknown) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text ? [...text].slice(0, 500).join("") : undefined;
  }
  private stepNote(task: Task) {
    return this.clipNote(task.checkpoint || task.progress?.at(-1)?.text);
  }
  private confirmedNote(checkpoint: FileCheckpoint) {
    const when = checkpoint.at ? beijingDateTime(checkpoint.at) : "";
    return [
      `已按最近确认的文件检查点还原（序号 ${checkpoint.seq}${when ? "，" + when : ""}）；检查点之后的本机改动没有带过来`,
      checkpoint.note ? "文本还原点：" + checkpoint.note : "",
      checkpoint.skipped?.length ? `另有 ${checkpoint.skipped.length} 个文件超出上限或没能纳入检查点，仍留在本机` : "",
      "动手前先核对现场；缺少必要文件或无法核验时用 task_ask_user 问用户，不凭空补写",
    ].filter(Boolean).join("；");
  }
  private safeTask(taskId: string) {
    assert(/^[A-Za-z0-9_-]+$/.test(taskId), "任务编号无效");
    return taskId;
  }
  private packOf(base: HandoffFile[] = [], files: HandoffFile[]): CheckpointPack {
    const next = new Map(files.map((file) => [file.path, file.hash]));
    const previous = new Map(base.map((file) => [file.path, file.hash]));
    return {
      written: files.filter((file) => previous.get(file.path) !== file.hash),
      removed: base.filter((file) => !next.has(file.path)).map((file) => file.path),
    };
  }
  private async cloudDir(cloud: CloudRuntime, rel: string) {
    return this.ensureCloudDir(cloud, rel);
  }
  /** 目录还不存在时，从已确认的工作区根逐级创建，拒绝链接和上跳；已存在则沿用 cloud.cwd 的边界检查。 */
  private async ensureCloudDir(cloud: CloudRuntime, rel: string) {
    try {
      const cwd = await cloud.cwd(rel);
      await cloud.fs.mkdir(cwd, { recursive: true, mode: 0o700 });
      return cwd;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const root = await cloud.cwd();
    let current = root;
    for (const part of rel.split("/")) {
      if (!part || part === "." || part === "..") throw Error("云端路径无效");
      current = join(current, part);
      let info: any;
      try {
        info = typeof cloud.fs.lstat === "function" ? await cloud.fs.lstat(current) : undefined;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!info) {
        try { await cloud.fs.mkdir(current, { mode: 0o700 }); }
        catch (error: any) { if (error?.code !== "EEXIST") throw error; }
        if (typeof cloud.fs.lstat === "function") info = await cloud.fs.lstat(current);
      }
      if (info && (info.isSymbolicLink?.() || !info.isDirectory())) throw Error("云端路径含链接或不是目录");
    }
    return cloud.cwd(rel);
  }
  private async blobReady(cloud: CloudRuntime, dir: string, fileHash: string) {
    if (!/^[0-9a-f]{64}$/.test(fileHash)) return false;
    try {
      const data = Buffer.from(await cloud.fs.readFile(join(dir, fileHash)));
      return hash(data) === fileHash;
    } catch {
      return false;
    }
  }
  private async dropShadow(cloud: CloudRuntime, cwd?: string) {
    const remove = cloud.fs.rm;
    if (!cwd || typeof remove !== "function") return;
    await remove.call(cloud.fs, cwd, { recursive: true, force: true }).catch(() => {});
  }
  /** 把已确认清单写成新的影子目录；内容按摘要存一份，相同内容不重复写。失败则不改已保存的检查点。 */
  private async materialize(cloud: CloudRuntime, taskId: string, seq: number, files: HandoffFile[], contents: Map<string, Buffer>) {
    const id = this.safeTask(taskId);
    const objects = await this.cloudDir(cloud, CHECKPOINT_ROOT + "/" + id + "/objects");
    const shadow = await this.cloudDir(cloud, CHECKPOINT_ROOT + "/" + id + "/s" + seq);
    const written = new Map<string, Buffer>();
    for (const file of files) {
      if (!allowed(file.path) || !/^[0-9a-f]{64}$/.test(file.hash)) throw Error("检查点清单无效");
      let data = contents.get(file.path);
      if (data && hash(data) !== file.hash) data = undefined;
      if (!data) {
        const stored = Buffer.from(await cloud.fs.readFile(join(objects, file.hash)));
        if (hash(stored) !== file.hash || stored.length !== file.size) throw Error("检查点内容与摘要不一致");
        data = stored;
      } else if (!(await this.blobReady(cloud, objects, file.hash))) {
        await cloud.fs.writeFile(join(objects, file.hash), data, { mode: 0o600 });
      }
      written.set(file.path, data);
    }
    await this.writeCloud(cloud, shadow, written);
    return shadow;
  }
  private async storeCheckpoint(cloud: CloudRuntime, taskId: string, record: HandoffRecord, files: HandoffFile[], contents: Map<string, Buffer>, pack: CheckpointPack, skipped: CheckpointSkip[], note: string | undefined, epoch: number) {
    const listed = [...skipped].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const current = record.checkpoint;
    const reusable = !!record.shadowCwd && !!current && !pack.written.length && !pack.removed.length && sameFiles(current.files, files);
    if (reusable && current!.epoch === epoch && (current!.note || undefined) === note && sameSkipped(current!.skipped, listed))
      return { shadowCwd: record.shadowCwd!, checkpoint: current!, changed: false as const };
    if (reusable) {
      const checkpoint: FileCheckpoint = { ...current!, at: Date.now(), epoch, note, files, skipped: listed.length ? listed : undefined };
      return { shadowCwd: record.shadowCwd!, checkpoint, changed: true as const };
    }
    const seq = (current?.seq || 0) + 1;
    const shadowCwd = await this.materialize(cloud, taskId, seq, files, contents);
    const checkpoint: FileCheckpoint = { seq, at: Date.now(), epoch, note, files, pack, skipped: listed.length ? listed : undefined };
    return { shadowCwd, checkpoint, changed: true as const };
  }
  private async restoreCheckpoint(cloud: CloudRuntime, record: HandoffRecord) {
    const checkpoint = record.checkpoint;
    if (!checkpoint?.seq || !record.shadowCwd || !sameFiles(checkpoint.files, record.base)) return;
    try {
      const contents = await this.readShadow(cloud, record.shadowCwd, checkpoint.files);
      return { files: checkpoint.files, contents, checkpoint };
    } catch {
      return undefined;
    }
  }
  private async readShadow(cloud: CloudRuntime, shadowCwd: string, files: HandoffFile[]) {
    const contents = new Map<string, Buffer>();
    for (const file of files) {
      if (!allowed(file.path) || !/^[0-9a-f]{64}$/.test(file.hash)) throw Error("检查点清单无效");
      const data = await this.readConfirmed(cloud, shadowCwd, file.path);
      if (data.length !== file.size || hash(data) !== file.hash) throw Error("检查点内容与摘要不一致");
      contents.set(file.path, data);
    }
    return contents;
  }
  /** 只读影子目录里的普通文件，拒绝跑出目录的路径和符号链接。 */
  private async readConfirmed(cloud: CloudRuntime, root: string, rel: string) {
    const lstat = typeof cloud.fs.lstat === "function" ? cloud.fs.lstat.bind(cloud.fs) : undefined;
    let parent = root;
    for (const part of rel.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (!lstat) continue;
      const info = await lstat(parent);
      if (info.isSymbolicLink?.()) throw Error("交接路径含链接或不是目录");
    }
    const full = join(root, rel);
    if (lstat) {
      const info = await lstat(full);
      if (info.isSymbolicLink?.() || !info.isFile()) throw Error("交接路径不是普通文件");
    }
    return Buffer.from(await cloud.fs.readFile(full));
  }
  /** 相对已确认基线只读取变化的文件。超限文件跳过，不让整次检查点失败。 */
  private async scanDelta(agent: Agent, cwd: string, base: HandoffFile[], cloud: CloudRuntime, taskId: string) {
    const listed: Obj = await this.deps.agents.request(agent, "file", { op: "list", cwd, path: "." }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
    assert(!listed.error, String(listed.error || "无法读取本地工作区"));
    assert(Array.isArray(listed.files), "本地工作区清单无效");
    const objects = await this.cloudDir(cloud, CHECKPOINT_ROOT + "/" + this.safeTask(taskId) + "/objects");
    const known = new Map(base.map((file) => [file.path, file]));
    const seen = new Set<string>();
    const skipped: CheckpointSkip[] = [];
    const hold: string[] = [];
    const consider = async (path: string, reason: string) => {
      if (!path || !allowed(path) || seen.has(path)) return;
      seen.add(path);
      skipped.push({ path, reason });
      const old = known.get(path);
      if (old && !reason.includes("过大") && await this.blobReady(cloud, objects, old.hash)) hold.push(path);
    };
    if (Array.isArray(listed.skipped)) {
      for (const item of listed.skipped) await consider(relativePath(item?.path), String(item?.reason || "未纳入检查点"));
    }
    const entries: { path: string; data?: Buffer; size?: number; hash?: string }[] = [];
    const readData = new Map<string, Buffer>();
    for (const item of listed.files) {
      const path = relativePath(item?.path);
      if (!path || !allowed(path) || seen.has(path)) continue;
      const size = Number(item?.size);
      if (Number.isFinite(size) && size > LIMITS.fileBytes) { await consider(path, "文件过大"); continue; }
      const listedHash = typeof item?.hash === "string" && /^[0-9a-f]{64}$/.test(item.hash) ? item.hash : "";
      const old = known.get(path);
      if (old && listedHash && old.hash === listedHash && (!Number.isFinite(size) || old.size === size) && await this.blobReady(cloud, objects, old.hash)) {
        seen.add(path);
        entries.push({ path, size: old.size, hash: old.hash });
        continue;
      }
      const read: Obj = await this.deps.agents.request(agent, "file", { op: "read", cwd, path }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
      if (read.error || typeof read.content !== "string") { await consider(path, "无法读取"); continue; }
      const data = Buffer.from(read.content, "base64");
      if (data.length > LIMITS.fileBytes) { await consider(path, "文件过大"); continue; }
      seen.add(path);
      readData.set(path, data);
      entries.push({ path, data });
    }
    if (listed.truncated) {
      for (const old of base) if (!seen.has(old.path) && await this.blobReady(cloud, objects, old.hash)) hold.push(old.path);
    }
    const plan = checkpointPlan(entries, base, LIMITS, hold);
    const confirmed = new Map(plan.files.map((file) => [file.path, file]));
    const contents = new Map<string, Buffer>();
    for (const [path, data] of readData) {
      const file = confirmed.get(path);
      if (file && hash(data) === file.hash) contents.set(path, data);
    }
    const skipPaths = new Set(skipped.map((item) => item.path));
    for (const item of plan.skipped) if (!skipPaths.has(item.path)) skipped.push(item);
    return { files: plan.files, contents, pack: plan.pack, skipped };
  }

  private async scanLocal(agent: Agent, cwd: string) {
    const listed: Obj = await this.deps.agents.request(agent, "file", { op: "list", cwd, path: "." }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
    assert(!listed.error, String(listed.error || "无法读取本地工作区"));
    assert(Array.isArray(listed.files), "本地工作区清单无效");
    if (Array.isArray(listed.skipped) && listed.skipped.length) {
      const first = listed.skipped[0] || {};
      const reason = String(first.reason || "");
      throw Error(reason.includes("过大")
        ? `文件过大，无法交接：${first.path}（上限 ${LIMITS.fileBytes} 字节）`
        : `工作区超过交接上限（${LIMITS.files} 个文件 / ${LIMITS.bytes} 字节），请缩小范围后再交接`);
    }
    if (listed.truncated) throw Error(`工作区超过交接上限（${LIMITS.files} 个文件 / ${LIMITS.bytes} 字节），请缩小范围后再交接`);
    const contents = new Map<string, Buffer>();
    for (const item of listed.files) {
      const path = relativePath(item?.path);
      if (!path || !allowed(path)) continue;
      const read: Obj = await this.deps.agents.request(agent, "file", { op: "read", cwd, path }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
      assert(!read.error && typeof read.content === "string", String(read.error || "无法读取本地文件：" + path));
      contents.set(path, Buffer.from(read.content, "base64"));
    }
    return { files: manifest([...contents].map(([path, data]) => ({ path, data }))), contents };
  }
  private async scanCloud(cloud: Pick<CloudRuntime, "fs">, cwd: string) {
    const contents = new Map<string, Buffer>();
    let bytes = 0;
    const walk = async (dir: string, prefix = "") => {
      const entries = await cloud.fs.readdir(dir, { withFileTypes: true } as any);
      for (const entry of entries as any[]) {
        const path = prefix ? prefix + "/" + entry.name : entry.name;
        const full = join(dir, entry.name);
        if (!allowed(path) || entry.isSymbolicLink?.()) continue;
        if (entry.isDirectory?.()) {
          await walk(full, path);
          continue;
        }
        const stat = await cloud.fs.stat(full);
        if (!stat.isFile()) continue;
        assert(Number((stat as any).size || 0) <= LIMITS.fileBytes, `文件过大，无法交接：${path}`);
        const data = Buffer.from(await cloud.fs.readFile(full));
        bytes += data.length;
        assert(data.length <= LIMITS.fileBytes && bytes <= LIMITS.bytes, "云端工作区内容超过交接上限");
        contents.set(path, data);
        if (contents.size > LIMITS.files) throw Error(`云端工作区文件数超过上限 ${LIMITS.files}`);
      }
    };
    await walk(cwd);
    return { files: manifest([...contents].map(([path, data]) => ({ path, data }))), contents };
  }
  private async writeCloud(cloud: CloudRuntime, cwd: string, contents: Map<string, Buffer>) {
    for (const [path, data] of contents) {
      if (!allowed(path)) continue;
      const full = join(cwd, path);
      const parent = dirname(full);
      if (parent && parent !== cwd) await cloud.fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await cloud.fs.writeFile(full, data, { mode: 0o600 });
    }
  }
  /** Apply `remote` changes to the client workspace; conflicts keep both copies. */
  private async applyLocal(agent: Agent, cwd: string, base: HandoffFile[], remote: { files: HandoffFile[]; contents: Map<string, Buffer> }, source: "cloud" | "local") {
    const local = await this.scanLocal(agent, cwd);
    const plan = merge(base, manifest([...local.contents].map(([path, data]) => ({ path, data }))), remote.files);
    const conflicts: string[] = [];
    const hashes = new Map(local.files.map((file: HandoffFile) => [file.path, file.hash]));
    const names = new Set(hashes.keys());
    const write = async (path: string, data: Buffer) => {
      const result: Obj = await this.deps.agents.request(agent, "file", { op: "sync_write", cwd, path, content: data.toString("base64"), expectedHash: hashes.get(path) || "" }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
      assert(!result.error, String(result.error || "无法写入本地文件：" + path));
      names.add(path);
    };
    for (const change of plan.changes) {
      if (change.side !== "remote") continue;
      if (change.action === "delete") continue; // 首版不删除本机文件，避免误删用户未提交的内容
      const data = remote.contents.get(change.path);
      if (data) await write(change.path, data);
    }
    for (const path of plan.conflicts) {
      const data = remote.contents.get(path);
      if (!data) continue;
      const suffix = path + CONFLICT_SUFFIX + source;
      let copy = suffix;
      for (let n = 1; names.has(copy); n++) copy = suffix + "-" + n;
      await write(copy, data);
      conflicts.push(path);
    }
    return { conflicts, changed: plan.changes.length };
  }
}
