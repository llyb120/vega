/**
 * 按牛马（employee）存储的运行时：每头牛马各自有一套文件系统 Master 和浏览器 Master。
 * 选定某头牛马的 Master 只把这头牛马的其余节点降为 Follower，不影响其它牛马。
 * 源的真相在服务端；客户端本地只记住各牛马上次选择，供离线展示，不能擅自宣布自己是某头牛马的 Master。
 */
import type { Store } from "./store";
import type { LocalAgents } from "./local-agent";
import { assert, type Obj } from "./util";

export const CLOUD_MASTER = "cloud";
export type MasterId = typeof CLOUD_MASTER | string;
export type MasterKind = "fs" | "browser";

export type EmployeeMasters = {
  employeeId: string;
  ownerId: string;
  fsMaster: MasterId;
  browserMaster: MasterId;
  updatedAt: number;
};

export type RuntimeNode = {
  id: string;
  name: string;
  kind: "cloud" | "client";
  online?: boolean;
  platform?: string;
  cwd?: string;
};

export type EmployeeMasterView = {
  id: string;
  name: string;
  fsMaster: MasterId;
  browserMaster: MasterId;
};

export type RuntimeView = {
  nodes: RuntimeNode[];
  employees: EmployeeMasterView[];
};

const RECORD = "employee-runtime";

export function isMasterId(value: unknown): value is MasterId {
  return value === CLOUD_MASTER || (typeof value === "string" && /^[a-f0-9-]{32,36}$/.test(value));
}

export class MasterRuntimes {
  private cache = new Map<string, EmployeeMasters>();
  private known = new Set<string>();
  /** 旧客户端账户级 prefer/browser，只作为尚未配置的牛马的缺省，不能覆盖已配好的值。 */
  private fallback = new Map<string, { fsMaster: MasterId; browserMaster: MasterId }>();
  listEmployees?: (ownerId: string) => Promise<{ id: string; name: string }[]>;
  employeeInfo?: (employeeId: string) => Promise<{ ownerId: string; name: string } | undefined>;
  /** 切换前（例如该牛马还有任务在执行时）抛错则不写入。 */
  beforeSwitch?: (employeeId: string, kind: MasterKind, from: MasterId, to: MasterId) => void | Promise<void>;
  /** 写入成功后只交接这头牛马的工作区。 */
  afterSwitch?: (employeeId: string, kind: MasterKind, from: MasterId, to: MasterId) => void | Promise<void>;
  constructor(private store: Store, private agents: LocalAgents, private emit: (value: Obj) => void = () => {}) {}

  async loadAll() {
    for (const item of await this.store.objects<EmployeeMasters>(RECORD)) {
      if (!item?.employeeId || !isMasterId(item.fsMaster) || !isMasterId(item.browserMaster)) continue;
      this.cache.set(item.employeeId, item);
      this.known.add(item.employeeId);
    }
  }

  hasOnlineClient(ownerId: string) {
    return !!ownerId && this.agents.list(ownerId).length > 0;
  }

  private onlineIds(ownerId: string) {
    return new Set(ownerId ? this.agents.list(ownerId).map((item) => item.id) : []);
  }

  /** 所选 Master 必须当前在线；否则这端由云端担任。没有在线客户端时两端都是云端。 */
  resolveMaster(master: MasterId, ownerId = "") {
    if (master === CLOUD_MASTER) return master;
    return ownerId && this.onlineIds(ownerId).has(master) ? master : CLOUD_MASTER;
  }

  private stored(employeeId: string, ownerId = ""): EmployeeMasters {
    const saved = this.cache.get(employeeId);
    if (saved) return saved;
    const fallback = (ownerId && this.fallback.get(ownerId)) || { fsMaster: CLOUD_MASTER, browserMaster: CLOUD_MASTER };
    return { employeeId, ownerId, fsMaster: fallback.fsMaster, browserMaster: fallback.browserMaster, updatedAt: 0 };
  }

  private effective(runtime: EmployeeMasters, ownerId = ""): EmployeeMasters {
    const owner = ownerId || runtime.ownerId || "";
    const fsMaster = this.resolveMaster(runtime.fsMaster, owner);
    const browserMaster = this.resolveMaster(runtime.browserMaster, owner);
    if (fsMaster === runtime.fsMaster && browserMaster === runtime.browserMaster) return runtime;
    return { ...runtime, fsMaster, browserMaster };
  }

  /** 生效中的快照：未配置时用该账户旧客户端上报的缺省，否则两端都是云端；所选客户端不在线时也回落到云端。 */
  peek(employeeId: string, ownerId = ""): EmployeeMasters {
    return this.effective(this.stored(employeeId, ownerId), ownerId);
  }

  async get(employeeId: string, ownerId = ""): Promise<EmployeeMasters> {
    if (!employeeId) return this.peek("", ownerId);
    if (!this.known.has(employeeId)) {
      const saved = await this.store.object<EmployeeMasters>(RECORD, employeeId);
      if (saved && isMasterId(saved.fsMaster) && isMasterId(saved.browserMaster)) {
        this.cache.set(employeeId, saved);
      }
      this.known.add(employeeId);
    }
    return this.peek(employeeId, ownerId);
  }

  /**
   * 所选 Master 已不在线时，把该端写回云端并触发交接。
   * 没有在线客户端时，这头牛马的文件系统和浏览器都由云端当 Master。
   */
  async releaseUnavailable(ownerId: string) {
    if (!ownerId) return;
    const employees = await this.listEmployees?.(ownerId) || [];
    const online = this.onlineIds(ownerId);
    for (const item of employees) {
      if (!this.known.has(item.id)) await this.get(item.id, ownerId);
      const current = this.stored(item.id, ownerId);
      if (current.fsMaster !== CLOUD_MASTER && !online.has(current.fsMaster))
        await this.setMaster(item.id, "fs", CLOUD_MASTER, "unavailable");
      if (current.browserMaster !== CLOUD_MASTER && !online.has(current.browserMaster))
        await this.setMaster(item.id, "browser", CLOUD_MASTER, "unavailable");
    }
  }

  /** 这头牛马的云端是文件系统或浏览器 Master 时，才允许单向借助 Follower 出网。 */
  cloudMayBorrow(employeeId: string, ownerId = "") {
    if (!employeeId) return true;
    const runtime = this.peek(employeeId, ownerId);
    return runtime.fsMaster === CLOUD_MASTER || runtime.browserMaster === CLOUD_MASTER;
  }

  /** 该账户下是否有任何一头牛马需要云端出网（供共享的账户代理使用）。 */
  async ownerMayBorrow(ownerId: string) {
    const employees = await this.listEmployees?.(ownerId) || [];
    if (!employees.length) return true;
    return employees.some((item) => this.cloudMayBorrow(item.id, ownerId));
  }

  async view(ownerId: string): Promise<RuntimeView> {
    const nodes = await this.nodes(ownerId);
    const employees = await this.listEmployees?.(ownerId) || [];
    const views: EmployeeMasterView[] = [];
    for (const item of employees) {
      const runtime = await this.get(item.id, ownerId);
      views.push({ id: item.id, name: item.name, fsMaster: runtime.fsMaster, browserMaster: runtime.browserMaster });
    }
    return { nodes, employees: views };
  }

  async viewEmployee(employeeId: string, ownerId = ""): Promise<EmployeeMasterView & { nodes: RuntimeNode[]; hasClient: boolean }> {
    const info = await this.employeeInfo?.(employeeId);
    const owner = ownerId || info?.ownerId || "";
    const runtime = await this.get(employeeId, owner);
    const nodes: RuntimeNode[] = owner ? await this.nodes(owner) : [{ id: CLOUD_MASTER, name: "云端", kind: "cloud" }];
    return {
      id: employeeId,
      name: info?.name || "",
      fsMaster: runtime.fsMaster,
      browserMaster: runtime.browserMaster,
      hasClient: this.hasOnlineClient(owner),
      nodes,
    };
  }

  async nodes(ownerId: string): Promise<RuntimeNode[]> {
    const online = this.agents.list(ownerId);
    const seen = new Set(online.map((item) => item.id));
    const nodes: RuntimeNode[] = [{ id: CLOUD_MASTER, name: "云端", kind: "cloud" }];
    for (const item of online) {
      nodes.push({ id: item.id, name: item.name, kind: "client", online: true, platform: item.platform, cwd: item.cwd });
    }
    for (const grant of await this.store.objects<{ userId: string; clientId: string }>("client-token")) {
      if (grant.userId !== ownerId || seen.has(grant.clientId)) continue;
      seen.add(grant.clientId);
      nodes.push({ id: grant.clientId, name: "客户端 " + grant.clientId.slice(0, 8), kind: "client", online: false });
    }
    return nodes;
  }

  async allowedMaster(ownerId: string, master: MasterId) {
    assert(isMasterId(master), "无效的 Master");
    if (master === CLOUD_MASTER) return master;
    assert(this.onlineIds(ownerId).has(master), "没有在线客户端时由云端担任 Master，只能选择当前在线的客户端");
    return master;
  }

  /**
   * 把某头牛马的某一套配置的 Master 设为指定节点，只把这头牛马的其余节点降为 Follower。
   * 写入成功后才通知各端并开始交接这头牛马的工作。
   */
  async setMaster(employeeId: string, kind: MasterKind, master: MasterId, source: "explicit" | "legacy" | "unavailable" = "explicit") {
    assert(employeeId, "请指定牛马");
    assert(kind === "fs" || kind === "browser", "只能设置文件系统或浏览器 Master");
    const info = await this.employeeInfo?.(employeeId);
    assert(info?.ownerId, "找不到这头牛马");
    const to = await this.allowedMaster(info.ownerId, master);
    await this.get(employeeId, info.ownerId);
    const current = this.stored(employeeId, info.ownerId);
    const key = kind === "fs" ? "fsMaster" : "browserMaster";
    const from = current[key];
    if (from === to && current.updatedAt) return current;
    if (source !== "unavailable") await this.beforeSwitch?.(employeeId, kind, from, to);
    const next: EmployeeMasters = { ...current, employeeId, ownerId: info.ownerId, [key]: to, updatedAt: Date.now() };
    await this.store.save(RECORD, employeeId, next);
    this.cache.set(employeeId, next);
    this.known.add(employeeId);
    this.emit({ type: "clients_changed", targetUser: info.ownerId, employeeId, runtime: next, source });
    this.emit({ type: "employee_changed", employeeId, targetUser: info.ownerId, data: { employeeId, runtime: next } });
    try { await this.afterSwitch?.(employeeId, kind, from, to); }
    catch { /* 交接失败不影响已写入的 Master；错误记在交接记录里 */ }
    return next;
  }

  /**
   * 兼容旧客户端上报的账户级 prefer / browser：只作为尚未按牛马配置过的缺省，不能覆盖已经配好的值。
   * 新的选择必须带上 employeeId，走 setMaster。
   */
  async applyClientReport(userId: string, clientId: string, reported: { prefer?: "client" | "cloud"; browser?: "local" | "cloud" }) {
    if (!userId || !clientId) return;
    const fsMaster = reported.prefer === "cloud" ? CLOUD_MASTER : clientId;
    const browserMaster = reported.browser === "local" ? clientId : CLOUD_MASTER;
    this.fallback.set(userId, { fsMaster, browserMaster });
    const employees = await this.listEmployees?.(userId) || [];
    let seeded = false;
    for (const item of employees) {
      const current = await this.get(item.id, userId);
      if (current.updatedAt) continue;
      const next: EmployeeMasters = { employeeId: item.id, ownerId: userId, fsMaster, browserMaster, updatedAt: Date.now() };
      await this.store.save(RECORD, item.id, next);
      this.cache.set(item.id, next);
      this.known.add(item.id);
      seeded = true;
    }
    if (seeded) this.emit({ type: "clients_changed", targetUser: userId, source: "legacy" });
  }
}
