import { randomUUID } from "node:crypto";
import { assert, type Obj } from "./util";
import type { Auth, Principal } from "./auth";

export class LocalAgentUnavailable extends Error {
  constructor() {
    super("本地执行端连接中断，操作结果不确定。请先检查本机实际结果并修复连接，再回复「继续」；本轮已暂停，不会自动重试或改在服务端执行。");
  }
}
type Pending = { resolve: (result: Obj) => void; reject: (error: Error) => void };
export type Agent = {
  userId: string;
  instance: string;
  cwd: string;
  platform: string;
  pending: Map<string, Pending>;
  heartbeat?: ReturnType<typeof setTimeout>;
};

// The logged-in frontend bridges requests to its own loopback WebSocket, never to another user's agent.
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
  active(userId?: string) {
    return userId ? this.agents.get(userId) : undefined;
  }
  connect(userId: string, a: Obj) {
    assert(typeof a.instance === "string" && /^[a-f0-9-]{32,36}$/.test(a.instance), "Invalid agent instance");
    assert(typeof a.cwd === "string" && a.cwd.length > 0 && a.cwd.length <= 4096 && !a.cwd.includes("\0"), "Invalid agent cwd");
    assert(["windows", "linux", "darwin"].includes(a.platform), "Invalid agent platform");
    let agent = this.active(userId);
    if (agent && agent.instance !== a.instance) throw Error("Another browser is already bridging the local agent");
    if (!agent) {
      this.disconnect(userId);
      agent = { userId, instance: a.instance, cwd: a.cwd, platform: a.platform, pending: new Map() };
      this.agents.set(userId, agent);
    }
    clearTimeout(agent.heartbeat);
    agent.heartbeat = setTimeout(() => this.disconnect(userId, a.instance), 15000);
    agent.heartbeat.unref();
    return { ok: true };
  }
  result(userId: string, a: Obj) {
    const agent = this.active(userId);
    assert(agent && agent.instance === a.instance, "Agent disconnected");
    assert(typeof a.id === "string" && a.result && typeof a.result === "object" && !Array.isArray(a.result), "Invalid agent result");
    // Late results are acknowledged but never recreate or replay an operation.
    agent.pending.get(a.id)?.resolve(a.result);
    return { ok: true };
  }
  private send(agent: Agent, job: Obj) {
    this.emit({ type: "local_agent_request", targetUser: agent.userId, data: { instance: agent.instance, ...job } });
  }
  request(agent: Agent, op: "exec" | "file", args: Obj, signal: AbortSignal) {
    signal.throwIfAborted();
    assert(agent.pending.size < 16, "Too many local operations");
    if (this.active(agent.userId) !== agent) throw new LocalAgentUnavailable();
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
    const agent = this.active(userId);
    if (!agent || (instance && agent.instance !== instance)) return;
    this.agents.delete(userId);
    clearTimeout(agent.heartbeat);
    for (const pending of [...agent.pending.values()]) pending.reject(new LocalAgentUnavailable());
  }
  close() {
    this.tickets.clear();
    for (const userId of this.agents.keys()) this.disconnect(userId);
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
