/**
 * 任务执行权调度：一个任务同一时刻只有一个执行位置（本地客户端 / 云端），
 * 交接是唯一改变它的方式；每次交接递增 epoch，旧端的结果不再推进任务。
 *
 * 规则（与产品约定一致）：
 * - 文件系统 Master 与浏览器 Master 互相独立。切换 Master 时自动同步工作区，这就是交接。
 * - 本地在线时必须现读工作区；客户端硬退出（连接已不在）不要把云端旧副本当成当前活工作区，一律按还原点续做，并说明「以还原点为准，离线期间的新文件不在其中」。
 * - 只有目标端真的拿到工作区，才切换执行权；否则保持原样并记失败原因。回合进行中（isRunning）拒绝切换。
 * - 回传只写文件、不抢执行权；冲突两边都留，不覆盖任何一方。
 * - 登录态：云端是浏览器 Master 时可从 Follower 捕获授权站点状态；本机是浏览器 Master 时禁止把云端 Cookie 灌进本机 Chrome。
 */
import { relativePath, allowed, manifest, merge, LIMITS } from "../../shared/workspace-sync.mjs";
import { browserOrigins, captureBrowser, restoreBrowser } from "./browser-handoff";
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
  seal: (value: any, aad: string) => Promise<string>;
  open: (blob: string, aad: string) => Promise<any>;
  masters?: (employeeId: string) => { fsMaster: string; browserMaster: string };
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
      // 登录态：只在浏览器也交到云端时，从本机 Follower 采集授权站点；复制不等于登录成功，恢复后必须打开页面核对。
      const sites = policy.sites || [];
      const browserTarget = this.browserBinding(employeeId);
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
      await this.switch(employee, taskId, next, { localAgent: false, clientId: undefined, cwd: cloudCwd, ...this.browserBinding(employeeId) });
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
      assert(!ended(task.status), "任务已结束，不需要交接");
      assert(!this.running(task), "任务这一轮还在执行；等这一步结束或再交接");
      const ownerId = state.ownerId || task.execution?.ownerId || task.owner?.token || "";
      const record = await this.record(taskId);
      const clientId = String(opts.clientId || record?.clientId || task.execution?.clientId || "");
      const agent = clientId ? this.deps.agents.active(ownerId, clientId) : this.deps.agents.active(ownerId);
      assert(agent, "本地客户端未在线，无法把执行权交回本机");
      const cloud = this.deps.cloud(ownerId);
      if (!cloud || !record?.cloudCwd) assert(false, "没有可回传的云端副本；直接在本机继续即可");
      const scanned = await this.scanCloud(cloud, record!.cloudCwd);
      const cwd = record!.localCwd || task.cwd;
      const applied = await this.applyLocal(agent, cwd, record!.base, scanned, "cloud");
      const next: HandoffRecord = {
        ...record!,
        where: "local",
        phase: "ready",
        epoch: record!.epoch + 1,
        source: opts.source === "auto" ? "auto" : "manual",
        at: Date.now(),
        clientId: agent.clientId,
        base: scanned.files,
        conflicts: applied.conflicts,
        note: [
          "执行权已交回本机",
          applied.conflicts.length ? `有 ${applied.conflicts.length} 个文件两边都改过，保留为 ${CONFLICT_SUFFIX}cloud 副本` : "",
        ].filter(Boolean).join("；"),
        error: undefined,
      };
      await this.switch(employee, taskId, next, { localAgent: true, clientId: agent.clientId, cwd, clientName: agent.name, localPlatform: agent.platform, ...this.browserBinding(employeeId) });
      // 禁止把云端 Cookie 灌进本机 Chrome：本机若要借助云端登录态，以视口操作云端 profile。
      if (next.browser && next.browserSites?.length) {
        next.browserNote = "未把云端登录态写入本机 Chrome；需要云端身份时，请以视口操作云端浏览器 profile";
        next.note = [next.note, next.browserNote].filter(Boolean).join("；");
      }
      await this.deps.store.save(RECORD, taskId, next);
      return next;
    });
  }

  /** 设备回连：自动接到云端执行的任务搬回本机继续（手动交接的仍由用户决定，运行中的等这一轮结束）。 */
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
        // 设备不在线、或它已不再是文件系统 Master：继续留在云端。未注入账户运行时时，沿用旧的 prefer 判断。
        if (!agent) continue;
        const fsMaster = this.deps.masters?.(employee.employeeId)?.fsMaster;
        if (fsMaster ? fsMaster !== agent.clientId : agent.prefer === "cloud") continue;
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
   * 客户端执行 + 云端浏览器：本机的站点登录态对云端浏览器不可见，开演前先搬过去（每个任务一次）。
   * 只搬 policy.sites 授权的站点；密码本凭据本来就在服务端，不走这里。
   */
  async ensureBrowserState(session: Session) {
    const employeeId = session.employeeId, taskId = session.taskId;
    if (!employeeId || !taskId || session.localBrowser || !session.localAgent) return;
    // 客户端关掉「登录态」开关就不动它的 Cookie 和页面存储。
    const employee = await this.deps.employeeFor(employeeId);
    const task = employee.task(await employee.state({ runs: false }), taskId);
    if (task.browserSyncedAt) return;
    const sites = (await this.policy(employeeId)).sites || [];
    if (!sites.length) return; // 没授权站点就不擅自搬登录态
    return this.exclusive("browser:" + taskId, async () => {
      const local = await this.browserChrome(task, "local");
      const remote = await this.browserChrome(task, "cloud");
      assert(local, "本机浏览器不可用，登录态未同步到云端浏览器");
      assert(remote, "云端浏览器不可用，登录态未同步");
      const captured = await captureBrowser(local, sites, AbortSignal.timeout(60_000));
      const restored = await restoreBrowser(remote, captured, AbortSignal.timeout(150_000));
      await employee.update((state) => {
        const current = employee.task(state, taskId);
        current.browserSyncedAt = Date.now();
        current.browserSyncNote = restored.ok
          ? `已把 ${captured.origins.join("、")} 的登录态同步到云端浏览器`
          : "登录态同步后仍需处理：" + restored.warnings.slice(0, 3).join("；");
        return state;
      });
      return { ok: restored.ok, origins: captured.origins, warnings: restored.warnings };
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
    // 回来的设备若仍是文件系统 Master：云端自动接管的那一轮结束后搬回本机继续。
    await this.backHome(userId).catch(() => {});
  }

  /** 这头牛马还有任务在执行时拒绝切换 Master；不影响其它牛马。 */
  async assertIdle(employeeId: string) {
    const employee = await this.deps.employeeFor(employeeId);
    const state = await employee.state({ runs: false });
    for (const task of state.tasks) {
      if (ended(task.status)) continue;
      assert(!this.running(task), "这头牛马还有任务在执行；等这一步结束或先暂停再切换 Master");
    }
  }

  /** 切换某头牛马的 Master 后自动交接，只动这头牛马的任务。 */
  async onMasterChange(employeeId: string, kind: "fs" | "browser", from: string, to: string) {
    if (kind === "browser") return this.applyBrowserMaster(employeeId, to);
    const employee = await this.deps.employeeFor(employeeId);
    const state = await employee.state({ runs: false });
    const ownerId = state.ownerId || "";
    if (to === "cloud") {
      for (const task of state.tasks) {
        if (ended(task.status) || task.execution?.localAgent !== true) continue;
        if (from !== "cloud" && task.execution?.clientId && task.execution.clientId !== from) continue;
        try { await this.toCloud(employeeId, task.id, { source: "auto" }); }
        catch { /* 失败记在交接记录里 */ }
      }
      return;
    }
    if (from === "cloud") {
      for (const task of state.tasks) {
        if (ended(task.status) || task.execution?.localAgent) continue;
        try { await this.toLocal(employeeId, task.id, { source: "auto", clientId: to }); }
        catch { /* 没有可回传的云端副本时保持原样 */ }
      }
      return;
    }
    await this.toOtherClient(employeeId, ownerId, from, to);
  }

  /** 把仍绑在旧客户端上的任务工作区同步到新的文件系统 Master。 */
  private async toOtherClient(employeeId: string, ownerId: string, from: string, to: string) {
    const dest = this.deps.agents.active(ownerId, to);
    if (!dest) return;
    const employee = await this.deps.employeeFor(employeeId);
    const state = await employee.state({ runs: false });
    for (const task of state.tasks) {
        if (ended(task.status) || task.execution?.localAgent !== true || task.execution?.clientId !== from) continue;
        const source = this.deps.agents.active(ownerId, from);
        try {
          await this.exclusive(task.id, async () => {
            assert(!this.running(task), "任务这一轮还在执行；等这一步结束或先暂停再切换 Master");
            const cwd = dest.cwd;
            const notes: string[] = [];
            if (source) {
              const scanned = await this.scanLocal(source, task.cwd);
              const record = (await this.record(task.id)) || this.fresh(task.id, employee.employeeId, ownerId, "auto");
              const applied = await this.applyLocal(dest, cwd, record.base, scanned, "local");
              const next = {
                ...record,
                where: "local" as const,
                phase: "ready" as const,
                epoch: record.epoch + 1,
                source: "auto" as const,
                at: Date.now(),
                clientId: dest.clientId,
                localCwd: cwd,
                base: scanned.files,
                conflicts: applied.conflicts,
                note: ["工作区已从原 Master 同步到新的文件系统 Master", applied.conflicts.length ? `有 ${applied.conflicts.length} 个文件两边都改过，保留为冲突副本` : ""].filter(Boolean).join("；"),
                error: undefined,
              };
              await this.switch(employee, task.id, next, { localAgent: true, clientId: dest.clientId, cwd, clientName: dest.name, localPlatform: dest.platform, ...this.browserBinding(employeeId) });
              await this.deps.store.save(RECORD, task.id, next);
            } else {
              const record = (await this.record(task.id)) || this.fresh(task.id, employee.employeeId, ownerId, "auto");
              const next = {
                ...record,
                where: "local" as const,
                phase: "ready" as const,
                epoch: record.epoch + 1,
                source: "auto" as const,
                at: Date.now(),
                clientId: dest.clientId,
                localCwd: cwd,
                base: [],
                note: "原文件系统 Master 已离线，以还原点为准，离线期间的新文件不在其中；未把旧云端副本当成当前活工作区",
                error: undefined,
              };
              await this.switch(employee, task.id, next, { localAgent: true, clientId: dest.clientId, cwd, clientName: dest.name, localPlatform: dest.platform, ...this.browserBinding(employeeId) });
              await this.deps.store.save(RECORD, task.id, next);
            }
            notes.push("ok");
          });
        } catch { /* 单任务失败不阻断其余任务 */ }
      }
  }

  private async applyBrowserMaster(employeeId: string, to: string) {
    const employee = await this.deps.employeeFor(employeeId);
    const state = await employee.state({ runs: false });
    const binding = this.browserBinding(employeeId, to);
    for (const task of state.tasks) {
      if (ended(task.status)) continue;
      const record = (await this.record(task.id)) || this.fresh(task.id, employeeId, state.ownerId || "", "auto");
      await this.switch(employee, task.id, { ...record, at: Date.now(), note: to === "cloud" ? "浏览器 Master 已切到云端" : "浏览器 Master 已切到本机；不会把云端 Cookie 灌进本机 Chrome" }, {
        localAgent: !!task.execution?.localAgent,
        clientId: task.execution?.clientId,
        clientName: task.execution?.clientName,
        localPlatform: task.execution?.localPlatform,
        cwd: task.cwd,
        ...binding,
      });
    }
  }

  private browserBinding(employeeId: string, master?: string) {
    const browserMaster = master || this.deps.masters?.(employeeId)?.browserMaster || "cloud";
    return {
      localBrowser: browserMaster !== "cloud",
      browserClientId: browserMaster !== "cloud" ? browserMaster : "",
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
    const sessions: Session[] = [];
    const state = await employee.update((s) => {
      const task = employee.task(s, taskId);
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
    for (const id of [employee.task(state, taskId).workSession, employee.task(state, taskId).computerSession]) if (id) try { sessions.push(await this.deps.store.session(id)); } catch {}
    for (const session of sessions) {
      session.localAgent = !!target.localAgent;
      session.clientId = target.clientId;
      session.clientName = target.clientName;
      session.localPlatform = target.localPlatform;
      if (target.localBrowser !== undefined) session.localBrowser = !!target.localBrowser;
      if (target.browserClientId !== undefined) session.browserClientId = target.browserClientId || undefined;
      session.cwd = String(target.cwd);
      await this.deps.store.saveSession(session);
    }
  }

  /** The browser this task would use on one side, if it can be reached at all. */
  private async browserChrome(task: Task, side: "local" | "cloud") {
    const sessionId = task.computerSession || task.workSession;
    if (!sessionId) return undefined;
    try {
      const session = await this.deps.store.session(sessionId);
      if (!session.ownerId) return undefined;
      return side === "local" ? await this.deps.browsers.local(session) : await this.deps.browsers.cloud(session);
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
  private async scanCloud(cloud: CloudRuntime, cwd: string) {
    const contents = new Map<string, Buffer>();
    const walk = async (dir: string, prefix = "") => {
      const entries = await cloud.fs.readdir(dir, { withFileTypes: true } as any);
      for (const entry of entries as any[]) {
        const path = prefix ? prefix + "/" + entry.name : entry.name;
        const full = join(dir, entry.name);
        if (entry.isDirectory?.()) {
          if (relativePath(path)) await walk(full, path);
          continue;
        }
        if (!relativePath(path) || !allowed(path)) continue;
        const stat = await cloud.fs.stat(full);
        if (!stat.isFile() || Number((stat as any).size || 0) > LIMITS.fileBytes) continue;
        contents.set(path, Buffer.from(await cloud.fs.readFile(full)));
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
    const write = async (path: string, data: Buffer) => {
      const result: Obj = await this.deps.agents.request(agent, "file", { op: "write", cwd, path, content: data.toString("base64") }, AbortSignal.timeout(SCAN_TIMEOUT_MS));
      assert(!result.error, String(result.error || "无法写入本地文件：" + path));
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
      await write(path + CONFLICT_SUFFIX + source, data);
      conflicts.push(path);
    }
    return { conflicts, changed: plan.changes.length };
  }
}
