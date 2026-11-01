import { randomUUID } from "node:crypto";
import { assert, type Obj } from "./util";
import type { Auth, Principal } from "./auth";

export class LocalAgentUnavailable extends Error {
  constructor(message = "所选客户端连接中断，操作结果不确定。请先检查该客户端的实际结果并修复连接，再回复「继续」；本轮已暂停，不会自动重试、切换到其他客户端或改在服务端执行。") {
    super(message);
  }
}
type Pending = { resolve: (result: Obj) => void; reject: (error: Error) => void };
export type Agent = {
  userId: string;
  clientId: string;
  name: string;
  instance: string;
  cwd: string;
  platform: string;
  pending: Map<string, Pending>;
  onlineUntil: number;
  heartbeat?: ReturnType<typeof setTimeout>;
  transport?: { send: (job: Obj) => void; close: () => void };
};

export function validateClient(a: Obj) {
  assert(typeof a.instance === "string" && /^[a-f0-9-]{32,36}$/.test(a.instance), "Invalid agent instance");
  // Registrations without a durable ID remain scoped to their connection instance.
  const clientId = a.clientId ?? a.instance;
  assert(typeof clientId === "string" && /^[a-f0-9-]{32,36}$/.test(clientId), "Invalid client ID");
  assert(a.name === undefined || (typeof a.name === "string" && a.name.trim().length > 0 && a.name.length <= 128 && !/[\x00-\x1f]/.test(a.name)), "Invalid client name");
  assert(typeof a.cwd === "string" && a.cwd.length > 0 && a.cwd.length <= 4096 && !a.cwd.includes("\0"), "Invalid agent cwd");
  assert(["windows", "linux", "darwin"].includes(a.platform), "Invalid agent platform");
  return clientId;
}

// Jobs for native clients use their own authenticated socket, never a website connection.
export class LocalAgents {
  private agents = new Map<string, Agent>();
  private tickets = new Map<string, { hash: string; instance: string; until: number }>();
  constructor(private emit: (value: Obj) => void = () => {}) {}
  ticket(principal: Principal, instance: unknown) {
    assert(typeof instance === "string" && /^[a-f0-9-]{32,36}$/.test(instance), "Invalid agent instance");
    for (const [id, ticket] of this.tickets) if (ticket.until < Date.now()) this.tickets.delete(id);
    assert(this.tickets.size < 256, "Too many local agent connection tickets");
    const ticket = randomUUID() + randomUUID();
    this.tickets.set(ticket, { hash: principal.hash, instance, until: Date.now() + 15000 });
    return { ticket };
  }
  verify(ticket: unknown, auth: Auth) {
    assert(typeof ticket === "string", "Invalid agent ticket");
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    const principal = entry && entry.until >= Date.now() && auth.resolveHash(entry.hash);
    assert(principal, "Local agent ticket expired or login revoked");
    return { userId: principal.user.id, instance: entry!.instance, expiresAt: principal.expiresAt };
  }
  list(userId?: string) {
    const online: Agent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.userId !== userId) continue;
      if (agent.onlineUntil <= Date.now()) this.disconnect(agent.userId, agent.instance);
      else online.push(agent);
    }
    return online.map(({ clientId: id, name, cwd, platform }) => ({ id, name, cwd, platform }));
  }
  active(userId?: string, clientId?: string) {
    if (!userId) return;
    if (clientId === undefined) {
      const online = this.list(userId);
      if (online.length !== 1) return;
      clientId = online[0].id;
    }
    const agent = this.agents.get(userId + ":" + clientId);
    if (agent && agent.onlineUntil <= Date.now()) {
      this.disconnect(userId, agent.instance);
      return;
    }
    return agent;
  }
  connect(userId: string, a: Obj, transport?: Agent["transport"]) {
    const clientId = validateClient(a);
    let agent = this.active(userId, clientId);
    assert(!agent || agent.instance === a.instance, "此客户端已由另一个浏览器连接");
    if (!agent) {
      assert(this.list(userId).length < 8, "Too many connected clients");
      assert(![...this.agents.values()].some((item) => item.userId === userId && item.instance === a.instance), "Agent instance already registered");
      agent = { userId, clientId, name: a.name?.trim() || "客户端 " + clientId.slice(0, 8), instance: a.instance, cwd: a.cwd, platform: a.platform, pending: new Map(), onlineUntil: Date.now() + 15000, transport };
      this.agents.set(userId + ":" + clientId, agent);
      this.emit({ type: "clients_changed", targetUser: userId });
    }
    clearTimeout(agent.heartbeat);
    agent.onlineUntil = Date.now() + 15000;
    agent.heartbeat = setTimeout(() => this.disconnect(userId, a.instance), 15000);
    agent.heartbeat.unref();
    return { ok: true };
  }
  result(userId: string, a: Obj) {
    const agent = [...this.agents.values()].find((item) => item.userId === userId && item.instance === a.instance);
    assert(agent && this.active(userId, agent.clientId) === agent, "Agent disconnected");
    assert(typeof a.id === "string" && a.result && typeof a.result === "object" && !Array.isArray(a.result), "Invalid agent result");
    // Late results are acknowledged but never recreate or replay an operation.
    agent.pending.get(a.id)?.resolve(a.result);
    return { ok: true };
  }
  private send(agent: Agent, job: Obj) {
    if (agent.transport) agent.transport.send(job);
    else this.emit({ type: "local_agent_request", targetUser: agent.userId, data: { instance: agent.instance, ...job } });
  }
  request(agent: Agent, op: "exec" | "file", args: Obj, signal: AbortSignal) {
    signal.throwIfAborted();
    assert(agent.pending.size < 16, "Too many local operations");
    if (this.active(agent.userId, agent.clientId) !== agent) throw new LocalAgentUnavailable();
    const id = randomUUID();
    return new Promise<Obj>((resolve, reject) => {
      const finish = (error?: Error, value?: Obj) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        agent.pending.delete(id);
        if (error) reject(error);
        else resolve(value!);
      };
      const cancel = (error: Error) => {
        try { this.send(agent, { id, op: "cancel" }); } catch {}
        finish(error);
      };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new LocalAgentUnavailable()), op === "exec" ? (args.timeout + 15) * 1000 : 30000);
      agent.pending.set(id, { resolve: (r) => finish(undefined, r), reject: (e) => finish(e) });
      signal.addEventListener("abort", abort, { once: true });
      try { this.send(agent, { id, op, args }); }
      catch { finish(new LocalAgentUnavailable()); }
    });
  }
  disconnect(userId: string, instance?: string) {
    let changed = false;
    for (const [key, agent] of this.agents) {
      if (agent.userId !== userId || (instance && agent.instance !== instance)) continue;
      this.agents.delete(key);
      clearTimeout(agent.heartbeat);
      for (const pending of [...agent.pending.values()]) pending.reject(new LocalAgentUnavailable());
      try { agent.transport?.close(); } catch {}
      changed = true;
    }
    if (changed) this.emit({ type: "clients_changed", targetUser: userId });
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
