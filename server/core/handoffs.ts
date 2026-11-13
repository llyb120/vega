/**
 * 任务执行权调度：一个任务同一时刻只有一个执行位置（本地客户端 / 云端），
 * 交接是唯一改变它的方式；每次交接递增 epoch，旧端的结果不再推进任务。
 *
 * 规则（与产品约定一致）：
 * - 文件系统与浏览器绑定到同一执行端，交接时同步工作区与浏览器登录态。
 * - 本地在线时必须现读工作区；客户端硬退出（连接已不在）不要把云端旧副本当成当前活工作区，一律按还原点续做，并说明「以还原点为准，离线期间的新文件不在其中」。
 * - 只有目标端真的拿到工作区，才切换执行权；否则保持原样并记失败原因。回合进行中（isRunning）拒绝切换。
 * - 回传只写文件、不抢执行权；冲突两边都留，不覆盖任何一方。
 * - 登录态：交接时把授权站点的 Cookie 与 storage 从源端搬到目标端（补齐不删）。
 */
import * as filesystem from "node:fs/promises";
import { relativePath, allowed, manifest, merge, LIMITS } from "../../shared/workspace-sync.mjs";
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

export type HandoffWhere = "local" | "cloud";
export type HandoffFile = { path: string; size: number; hash: string };
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
      assert(!this.running(task), "任务这一轮还在执行；等这一步结束或先暂停任务再交接");
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

      if (agent) {
        const scanned = await this.scanLocal(agent, task.cwd);
        files = scanned.files;
        for (const [path, data] of scanned.contents) contents.set(path, data);
        notes.push("工作区按本地当前内容同步");
      } else {
        // 硬退出：连接已经不在，不要把云端旧副本当成当前活工作区，也不发明文件。
        notes.push("本地客户端已离线，以还原点为准，离线期间的新文件不在其中；本机文件没有带过来，动手前先核对现场；缺少必要文件或无法核验时用 task_ask_user 问用户，不凭空补写");
        files = [];
      }

      const cloudCwd = agent
        ? (record.cloudCwd || (await this.cloudRoot(cloud, taskId)))
        : await this.cloudRoot(cloud, taskId + "-restore-" + Date.now());
      if (agent) await this.writeCloud(cloud, cloudCwd, contents);
      else await this.writeCloud(cloud, cloudCwd, new Map());
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
        if (!record?.cloudCwd) assert(["stopped", "failed", "cancelled", "waiting", "approval"].includes(task.status), "云端任务已开始，请先暂停再交到本机");
        scanned = await this.scanCloud(cloud || { fs: filesystem }, task.cwd);
        applied = await this.applyLocal(agent, cwd, sameClient && sameCloud ? record?.base || [] : [], scanned, "cloud");
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
    const task = employee.task(await employee.state({ runs: false }), taskId);
    if (task.browserSyncedAt) return;
    const sites = (await this.policy(employeeId)).sites || [];
    if (!sites.length) return; // 没授权站点就不擅自搬登录态
    const ownerId = task.execution?.ownerId || task.owner?.token || "";
    const targetLocal = !!session.localBrowser;
    const targetClient = session.browserClientId || session.clientId || "";
    return this.exclusive("browser:" + taskId, async () => {
      const target = await this.browserChrome(task, targetLocal ? "local" : "cloud");
      assert(target, targetLocal ? "本机浏览器不可用，登录态未同步" : "云端浏览器不可用，登录态未同步");
      // 对端源：目标在本机 => 云端 + 其余在线客户端；目标在云端 => 全部在线客户端。同一账号，只借自己的。
      const sources: { side: "local" | "cloud"; clientId?: string }[] = [];
      if (targetLocal) sources.push({ side: "cloud" });
      for (const client of this.deps.onlineClients?.(ownerId) || [])
        if (!targetLocal || client.id !== targetClient) sources.push({ side: "local", clientId: client.id });
      const merged: string[] = [];
      const warnings: string[] = [];
      for (const source of sources) {
        // 源端浏览器用独立的 sync 键租约，抓完即释放，不占/不断目标端（任务端）的浏览器租约。
        const probeKey = session.id + ":sync";
        try {
          const origin = await this.browserChrome(task, source.side, source.clientId, probeKey);
          if (!origin) { warnings.push(source.clientId ? `客户端 ${source.clientId.slice(0, 8)} 浏览器不可达` : "云端浏览器不可达"); continue; }
          const captured = await captureBrowser(origin, sites, AbortSignal.timeout(60_000));
          const applied = await injectBrowser(target, captured, AbortSignal.timeout(90_000));
          if (applied.cookies || applied.storage) merged.push(...captured.origins);
          warnings.push(...applied.warnings);
        } catch (error: any) {
          warnings.push((source.clientId ? `客户端 ${source.clientId.slice(0, 8)}` : "云端") + "登录态未同步：" + String(error?.message || error).slice(0, 120));
        } finally {
          if (source.side === "local") await this.deps.releaseLocal?.(probeKey).catch(() => {});
        }
      }
      await employee.update((state) => {
        const current = employee.task(state, taskId);
        current.browserSyncedAt = Date.now();
        current.browserSyncNote = merged.length
          ? `已把 ${[...new Set(merged)].join("、")} 的登录态同步到${targetLocal ? "本机" : "云端"}浏览器`
          : "登录态同步后仍需处理：" + warnings.slice(0, 3).join("；");
        return state;
      });
      return { ok: merged.length > 0, origins: [...new Set(merged)], warnings };
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
        if (ended(task.status) || task.execution?.localAgent !== true || task.execution?.clientId !== clientId) continue;
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
    const cwd = await cloud.cwd(CLOUD_ROOT + "/" + taskId);
    await cloud.fs.mkdir(cwd, { recursive: true, mode: 0o700 });
    return cwd;
  }
  /** Switch the execution right on the task and every session it owns, then let the scheduler continue. */
  private async switch(employee: Employee, taskId: string, record: HandoffRecord, target: Obj) {
    await this.deps.store.transaction(async () => {
      const state = await employee.update((s) => {
        const task = employee.task(s, taskId);
        if (target.expectedStatus !== undefined)
          assert(task.status === target.expectedStatus && !this.running(task) && !employee.busy?.has(taskId), "任务状态已变化，请先暂停后重新交接");
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

  private async scanLocal(agent: Agent, cwd: string) {
    const listed: Obj = await this.deps.agents.request(agent, "file", { op: "list", cwd, path: "." }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
    assert(!listed.error, String(listed.error || "无法读取本地工作区"));
    assert(Array.isArray(listed.files), "本地工作区清单无效");
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
