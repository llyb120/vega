import { randomUUID } from "node:crypto";
import { assert, type Obj } from "./util";
import { assertShellCommand } from "./shell-policy";
import type { Auth, Principal } from "./auth";

export const CLIENT_HEARTBEAT_TIMEOUT = 30000;
export const CLIENT_RECONNECT_GRACE = 60000;

export class LocalAgentUnavailable extends Error {
  constructor(message = "所选客户端连接未能自动恢复，或原执行实例已失效，操作结果不确定。请先检查该客户端的实际结果并修复连接，再回复「继续」；本轮已暂停，不会自动重试操作、切换到其他客户端或改在服务端执行。") {
    super(message);
  }
}
type Pending = { resolve: (result: Obj) => void; reject: (error: Error) => void; suspend: () => void; resume: () => void };
export type Agent = {
  userId: string;
  clientId: string;
  name: string;
  instance: string;
  cwd: string;
  platform: string;
  supplement?: string;
  /** 客户端本地选择的执行位置偏好：client = 客户端优先（默认），cloud = 服务端优先。 */
  prefer?: "client" | "cloud";
  /** 浏览器位置由客户端自己配置：local（默认）= 用本机 Chrome 扩展，cloud = 用服务端浏览器。 */
  browser?: "local" | "cloud";
  pending: Map<string, Pending>;
  browserLeases: Set<string>;
  onlineUntil: number;
  reconnecting?: boolean;
  heartbeat?: ReturnType<typeof setTimeout>;
  transport?: { send: (job: Obj) => void; close: () => void };
  /** 登录顺序：同一账号只有一个设备干活，以最新登录的为准。 */
  order: number;
};

export function validateClient(a: Obj) {
  assert(typeof a.instance === "string" && /^[a-f0-9-]{32,36}$/.test(a.instance), "Invalid agent instance");
  // Registrations without a durable ID remain scoped to their connection instance.
  const clientId = a.clientId ?? a.instance;
  assert(typeof clientId === "string" && /^[a-f0-9-]{32,36}$/.test(clientId), "Invalid client ID");
  assert(a.name === undefined || (typeof a.name === "string" && a.name.trim().length > 0 && a.name.length <= 128 && !/[\x00-\x1f]/.test(a.name)), "Invalid client name");
  assert(typeof a.cwd === "string" && a.cwd.length > 0 && a.cwd.length <= 4096 && !a.cwd.includes("\0"), "Invalid agent cwd");
  assert(["windows", "linux", "darwin"].includes(a.platform), "Invalid agent platform");
  assert(a.supplement === undefined || (typeof a.supplement === "string" && Buffer.byteLength(a.supplement) <= 8192 && !a.supplement.includes("\0")), "Invalid client supplement");
  assert(a.prefer === undefined || a.prefer === "client" || a.prefer === "cloud", "Invalid client execution preference");
  assert(a.browser === undefined || a.browser === "local" || a.browser === "cloud", "Invalid client browser location");
  return clientId;
}

// Jobs for native clients use their own authenticated socket, never a website connection.
export class LocalAgents {
  private agents = new Map<string, Agent>();
  private tickets = new Map<string, { hash: string; instance: string; until: number }>();
  /** 当前生效的设备（最近登录的那台）；其它设备在线但待命，它退出后才轮到下一台。 */
  private primary = new Map<string, string>();
  private seq = 0;
  constructor(private emit: (value: Obj) => void = () => {}) {}
  ticket(principal: Principal, instance: unknown) {
    assert(typeof instance === "string" && /^[a-f0-9-]{32,36}$/.test(instance), "Invalid agent instance");
    for (const [id, ticket] of this.tickets) if (ticket.until < Date.now()) this.tickets.delete(id);
    assert(this.tickets.size < 256, "Too many local agent connection tickets");
    const ticket = randomUUID() + randomUUID();
    this.tickets.set(ticket, { hash: principal.hash, instance, until: Date.now() + 15000 });
    return { ticket };
  }
  async verify(ticket: unknown, auth: Auth) {
    assert(typeof ticket === "string", "Invalid agent ticket");
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    const principal = entry && entry.until >= Date.now() && await auth.resolveHash(entry.hash);
    assert(principal, "Local agent ticket expired or login revoked");
    return { userId: principal.user.id, instance: entry!.instance, expiresAt: principal.expiresAt };
  }
  list(userId?: string) {
    const online: { id: string; name: string; cwd: string; platform: string; browser: "local" | "cloud"; active: boolean }[] = [];
    const primary = userId ? this.primary.get(userId) : undefined;
    for (const agent of [...this.agents.values()]) {
      if (agent.userId !== userId) continue;
      this.expire(agent);
      if (!this.agents.has(agent.userId + ":" + agent.clientId)) continue;
      online.push({ id: agent.clientId, name: agent.name, cwd: agent.cwd, platform: agent.platform, browser: agent.browser || "local", active: agent.clientId === primary });
    }
    return online;
  }
  /**
   * 一个账号同时只有一个设备干活：以最新登录的为准，其余设备在线但待命。
   * 不传 clientId 时返回当前生效设备；传入的不是生效设备就返回 undefined（不派发任何操作）。
   */
  active(userId?: string, clientId?: string) {
    if (!userId) return;
    const primary = this.primary.get(userId);
    if (clientId === undefined) {
      if (!primary) return;
      clientId = primary;
    } else if (primary && clientId !== primary) return;
    const key = userId + ":" + clientId;
    const agent = this.agents.get(key);
    if (!agent) return;
    this.expire(agent);
    return this.agents.get(key);
  }
  /** 心跳过期：先宽限期恢复，过宽限就断开（不直接丢工作）。 */
  private expire(agent: Agent) {
    if (agent.onlineUntil > Date.now()) return;
    if (agent.reconnecting) this.disconnect(agent.userId, agent.instance);
    else this.suspend(agent.userId, agent.instance);
  }
  connect(userId: string, a: Obj, transport?: Agent["transport"]) {
    const clientId = validateClient(a), key = userId + ":" + clientId;
    // 不能用 active() 判断：待命设备也要能重连，否则会被当成新设备而撞 instance。
    let agent = this.agents.get(key);
    if (agent) this.expire(agent);
    if (!this.agents.has(key)) agent = undefined;
    assert(!agent || agent.instance === a.instance, "此客户端已由另一个浏览器连接");
    if (!agent) {
      assert(this.list(userId).length < 8, "Too many connected clients");
      assert(![...this.agents.values()].some((item) => item.userId === userId && item.instance === a.instance), "Agent instance already registered");
      agent = { userId, clientId, name: a.name?.trim() || "客户端 " + clientId.slice(0, 8), instance: a.instance, cwd: a.cwd, platform: a.platform, pending: new Map(), browserLeases: new Set(), onlineUntil: Date.now() + CLIENT_HEARTBEAT_TIMEOUT, transport, order: ++this.seq };
      this.agents.set(key, agent);
      // 最新登录的设备接管本账号的工作；其余设备保持在线但待命。
      this.primary.set(userId, clientId);
      this.emit({ type: "clients_changed", targetUser: userId });
    }
    agent.supplement = a.supplement || "";
    // 客户端配置决定浏览器位置；旧客户端不上报时按本机浏览器处理。
    agent.browser = a.browser === "cloud" ? "cloud" : "local";
    // 客户端本地的执行位置：切成服务端优先后立即安排接力，切回客户端优先时已有任务不动。
    const prefer = a.prefer === "cloud" ? "cloud" : "client";
    if (agent.prefer !== prefer) {
      const changed = agent.prefer !== undefined;
      agent.prefer = prefer;
      if (changed && prefer === "cloud") this.emit({ type: "clients_changed", targetUser: userId });
    }
    const recovering = agent.reconnecting, previous = agent.transport;
    if (transport) agent.transport = transport;
    // Ping/result refresh calls connect() without a transport. That must not clear a suspended
    // recovery: otherwise reconnecting=false with transport=undefined and every send() fails with
    // LocalAgentUnavailable while the UI can still list the device during the grace window.
    if (agent.reconnecting && !agent.transport) return { ok: true };
    agent.reconnecting = false;
    clearTimeout(agent.heartbeat);
    agent.onlineUntil = Date.now() + CLIENT_HEARTBEAT_TIMEOUT;
    agent.heartbeat = setTimeout(() => this.suspend(userId, a.instance), CLIENT_HEARTBEAT_TIMEOUT);
    agent.heartbeat.unref();
    if (transport && previous !== transport) try { previous?.close(); } catch {}
    if (recovering) {
      this.emit({ type: "clients_changed", targetUser: userId });
      // Let the socket send readiness before dispatching operations queued during recovery.
      const resumed = agent;
      queueMicrotask(() => {
        if (this.active(userId, clientId) === resumed && !resumed.reconnecting)
          for (const pending of resumed.pending.values()) pending.resume();
      });
    }
    return { ok: true };
  }
  result(userId: string, a: Obj) {
    const agent = [...this.agents.values()].find((item) => item.userId === userId && item.instance === a.instance);
    // 待命设备已发出的操作仍可回传结果：只停止新派发，不把在途结果丢掉。
    assert(agent, "Agent disconnected");
    assert(typeof a.id === "string" && a.result && typeof a.result === "object" && !Array.isArray(a.result), "Invalid agent result");
    // Late results are acknowledged but never recreate or replay an operation.
    agent.pending.get(a.id)?.resolve(a.result);
    return { ok: true };
  }
  private send(agent: Agent, job: Obj) {
    if (agent.reconnecting) throw new LocalAgentUnavailable();
    if (!agent.transport) throw new LocalAgentUnavailable();
    agent.transport.send(job);
  }
  request(agent: Agent, op: "exec" | "file" | "browser" | "key" | "appuse", args: Obj, signal: AbortSignal) {
    if (op === "exec") {
      assert(typeof args.command === "string" && args.command.trim(), "command required");
      assertShellCommand(args.command);
    }
    signal.throwIfAborted();
    assert(agent.pending.size < 16, "Too many local operations");
    if (this.active(agent.userId, agent.clientId) !== agent) throw new LocalAgentUnavailable("另一台设备已登录并接管本账号的工作，此客户端处于待命状态，不会派发新操作；请在新设备继续，或让新设备退出后再用这台。");
    const id = randomUUID();
    return new Promise<Obj>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined, sent = false, settled = false, recovered = false;
      // Browser: Nova pickup ≤30s + CDP budget ≤10s, plus margin for slow pages and occasional large-result HTTP upload (Tapd etc.).
      // A too-tight budget used to fire this timer while the socket was healthy, suspend the client
      // as if the link dropped, then surface LocalAgentUnavailable — even when the page later loaded.
      let remaining = op === "exec" ? (args.timeout + 15) * 1000 : op === "browser" || op === "appuse" ? 180000 : 30000, deadline = 0;
      const finish = (error?: Error, value?: Obj) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        agent.pending.delete(id);
        if (error) reject(error);
        else resolve(value!);
      };
      const cancel = (error: Error) => {
        if (sent) try { this.send(agent, { id, op: "cancel" }); } catch {}
        finish(error);
      };
      const abort = () => cancel(signal.reason);
      const timedOut = () => new LocalAgentUnavailable(op === "browser"
        ? "客户端浏览器操作超时。连接仍正常，本步未确认完成（本机 Chrome 直连，与流量中继无关）；请核对 Nova 扩展是否卡住或结果是否回传，检查页面实际状态后回复「继续」重试该步骤，不会自动改用其他客户端或服务端浏览器。"
        : "客户端操作超时。连接仍正常，本步未确认完成；请回复「继续」重试，不会自动切换执行位置。");
      const resume = () => {
        if (settled || agent.reconnecting || timer) return;
        deadline = Date.now() + remaining;
        timer = setTimeout(() => {
          // Live socket + slow op: time out the job only. Do NOT suspend — that closes a healthy
          // client and turns a timeout into the misleading "未能自动恢复" pause (see session dumps
          // where chrome_navigate/inspect fail ~60s later while chrome_tabs still works).
          if (!recovered && agent.transport && !agent.reconnecting) cancel(timedOut());
          else if (!recovered && agent.transport) this.suspend(agent.userId, agent.instance);
          else cancel(new LocalAgentUnavailable());
        }, remaining);
        if (sent) return;
        sent = true;
        try { this.send(agent, { id, op, args }); }
        catch { this.suspend(agent.userId, agent.instance); }
      };
      const suspend = () => {
        if (!timer) return;
        recovered = true;
        remaining = Math.max(10000, deadline - Date.now());
        clearTimeout(timer);
        timer = undefined;
      };
      agent.pending.set(id, { resolve: (r) => finish(undefined, r), reject: (e) => finish(e), suspend, resume });
      signal.addEventListener("abort", abort, { once: true });
      resume();
    });
  }
  suspend(userId: string, instance: string, transport?: Agent["transport"], keepSocket = false) {
    const agent = [...this.agents.values()].find((item) => item.userId === userId && item.instance === instance);
    if (!agent || agent.reconnecting || (transport && agent.transport !== transport)) return;
    const previous = agent.transport;
    agent.transport = undefined;
    agent.reconnecting = true;
    clearTimeout(agent.heartbeat);
    agent.onlineUntil = Date.now() + CLIENT_RECONNECT_GRACE;
    agent.heartbeat = setTimeout(() => this.disconnect(userId, instance), CLIENT_RECONNECT_GRACE);
    agent.heartbeat.unref();
    for (const pending of agent.pending.values()) pending.suspend();
    if (!keepSocket) try { previous?.close(); } catch {}
  }
  disconnect(userId: string, instance?: string, transport?: Agent["transport"]) {
    let changed = false;
    for (const [key, agent] of this.agents) {
      if (agent.userId !== userId || (instance && agent.instance !== instance) || (transport && agent.transport !== transport)) continue;
      this.agents.delete(key);
      clearTimeout(agent.heartbeat);
      for (const pending of [...agent.pending.values()]) pending.reject(new LocalAgentUnavailable());
      try { agent.transport?.close(); } catch {}
      changed = true;
      if (this.primary.get(userId) === agent.clientId) this.primary.delete(userId);
    }
    if (changed) {
      // 生效设备退出后，回退到最后登录的仍在线设备（旧设备可以重新工作）。
      if (!this.primary.get(userId)) {
        const next = [...this.agents.values()].filter((agent) => agent.userId === userId).sort((a, b) => b.order - a.order)[0];
        if (next) this.primary.set(userId, next.clientId);
      }
      this.emit({ type: "clients_changed", targetUser: userId });
    }
  }
  close() {
    this.tickets.clear();
    for (const userId of new Set([...this.agents.values()].map((agent) => agent.userId))) this.disconnect(userId);
  }
}

export async function localShell(hub: LocalAgents, agent: Agent, cwd: string, a: Obj, signal: AbortSignal) {
  assert(typeof a.command === "string" && a.command.trim(), "command required");
  const timeout = a.timeout ?? 120;
  assert(Number.isInteger(timeout) && timeout >= 1 && timeout <= 600, "Invalid timeout");
  const r = await hub.request(agent, "exec", { cwd, command: a.command, timeout }, signal);
  return { value: r, error: Number(r.exitCode) !== 0 || !!r.error };
}
export async function localRead(hub: LocalAgents, agent: Agent, cwd: string, path: string, signal: AbortSignal) {
  const r = await hub.request(agent, "file", { op: "read", cwd, path }, signal);
  assert(!r.error, r.error);
  assert(typeof r.path === "string" && typeof r.content === "string" && r.content.length <= Math.ceil((32 << 20) / 3) * 4, "Invalid local file result");
  return { path: r.path as string, data: Buffer.from(r.content, "base64") };
}
export async function localWrite(hub: LocalAgents, agent: Agent, cwd: string, a: Obj, signal: AbortSignal) {
  assert(typeof a.path === "string" && a.path && typeof a.content === "string", "path/content required");
  const r = await hub.request(agent, "file", { op: "write", cwd, path: a.path, content: Buffer.from(a.content).toString("base64") }, signal);
  assert(!r.error, r.error);
  return { value: r };
}
export async function localEdit(hub: LocalAgents, agent: Agent, cwd: string, a: Obj, signal: AbortSignal) {
  assert(typeof a.path === "string" && a.path && Array.isArray(a.edits) && a.edits.length, "path/edits required");
  const r = await hub.request(agent, "file", { op: "edit", cwd, path: a.path, edits: a.edits }, signal);
  assert(!r.error, r.error);
  return { value: r };
}
export async function localCwdExists(hub: LocalAgents, agent: Agent, cwd: string, path: string, signal: AbortSignal) {
  const r = await hub.request(agent, "file", { op: "stat", cwd, path }, signal);
  assert(r.isDir && typeof r.path === "string", "Existing local cwd directory required");
  return r.path as string;
}
/**
 * appuse：客户端真实鼠标键盘与桌面截图。只有绑定本机客户端的会话能派发；
 * 参数与快照由客户端严格校验，服务端只负责把返回的截图存进会话文件供模型和 read 使用。
 */
export async function localAppuse(hub: LocalAgents, agent: Agent, args: Obj, signal: AbortSignal) {
  const result = await hub.request(agent, "appuse", args, signal);
  if (result.error && result.status === undefined) throw Error(String(result.error));
  return result;
}
