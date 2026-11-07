import { randomBytes } from "node:crypto";
import type { Peer } from "crossws";
import { Auth, digest } from "./auth";
import type { Store } from "./store";
import { CLIENT_HEARTBEAT_TIMEOUT, LocalAgents, validateClient, type Agent } from "./local-agent";
import { assert, type Obj } from "./util";
import type { NetworkRelay } from "./network-relay";

/** Large results are posted over HTTP (up to CLIENT_BODY_LIMIT); socket messages stay small so heartbeats never queue behind them. */
export const CLIENT_BODY_LIMIT = 48 << 20, CLIENT_SOCKET_LIMIT = 1 << 20;
/** Node-level compatibility gate: this deployment refuses older clients instead of failing mid-job. */
// 与 local/VERSION 同步：发布新客户端时一并抬高。环境变量覆盖；设成空串表示不限制。
export const MIN_CLIENT_VERSION = "0.3.5";
export const minClientVersion = () => process.env.VEGA_MIN_CLIENT_VERSION ?? MIN_CLIENT_VERSION;
const triple = (value?: string) => (/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value || "") ? value!.split(".").map(Number) : undefined);
/** Clients that never reported a version predate the gate, so they count as outdated. */
export function clientOutdated(minimum: string, actual?: string) {
  const floor = triple(minimum);
  assert(!minimum || floor, "VEGA_MIN_CLIENT_VERSION must be x.y.z");
  if (!floor) return false;
  const version = triple(actual);
  if (!version) return true;
  for (let i = 0; i < 3; i++) if (version[i] !== floor[i]) return version[i] < floor[i];
  return false;
}
type Socket = Pick<Peer, "id" | "request" | "send" | "close">;
type Grant = { hash: string; userId: string; clientId: string; createdAt: number };
type Connection = { socket: Socket; grant: Grant; lastAt: number; details?: Obj; transport?: Agent["transport"]; updating?: boolean; tail?: Promise<void> };

export class ClientSockets {
  private connections = new Map<string, Connection>();
  private timer: ReturnType<typeof setInterval>;
  private onRevoke = async (userId: string) => await this.revoke(userId);
  constructor(private store: Store, private auth: Auth, private hub: LocalAgents, private clientInUse: (clientId: string) => boolean | Promise<boolean>, private relay?: NetworkRelay) {
    auth.events.on("revoke", this.onRevoke);
    this.timer = setInterval(async () => {
      for (const [id, connection] of this.connections) {
        if (!await this.valid(connection.grant)) this.close(id, true);
        else if (Date.now() - connection.lastAt > CLIENT_HEARTBEAT_TIMEOUT) this.close(id);
      }
    }, 5000);
    this.timer.unref();
  }
  async pair(a: Obj) {
    assert(typeof a.clientId === "string" && /^[a-f0-9]{32}$/.test(a.clientId), "Invalid client ID");
    const proof = await this.hub.verify(a.ticket, this.auth), user = await this.auth.user(proof.userId);
    assert(user && !user.disabled && user.role !== "viewer", "Client pairing requires execution permission");
    const existing = typeof a.deviceToken === "string" ? await this.record(a.deviceToken) : undefined;
    if (existing && existing.userId === user.id && existing.clientId === a.clientId)
      return { ...proof, clientId: a.clientId, deviceToken: a.deviceToken };
    const grants = (await this.store.objects<Grant>("client-token")).filter((item) => item.userId === user.id);
    assert(grants.filter((item) => item.clientId !== a.clientId).length < 8, "Too many authorized clients");
    await this.revoke(user.id, a.clientId);
    const deviceToken = randomBytes(32).toString("base64url"), hash = digest(deviceToken);
    await this.store.save("client-token", hash, { hash, userId: user.id, clientId: a.clientId, createdAt: Date.now() } satisfies Grant);
    return { ...proof, clientId: a.clientId, deviceToken };
  }
  private async record(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const grant = await this.store.object<Grant>("client-token", digest(token));
    return grant && await this.valid(grant) ? grant : undefined;
  }
  private async valid(grant: Grant) {
    const stored = await this.store.object<Grant>("client-token", grant.hash), user = await this.auth.user(grant.userId);
    return !!stored && stored.clientId === grant.clientId && stored.userId === grant.userId && !!user && !user.disabled && user.role !== "viewer";
  }
  async authorize(request: Socket["request"]) {
    assert(!request.headers.get("origin") && !new URL(request.url).search, "Native client connection required");
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") || "")?.[1];
    const grant = token && await this.record(token);
    assert(grant, "Client credential invalid or revoked");
    return grant;
  }
  async open(socket: Socket, grant?: Grant) {
    // The upgrade hook supplies its verified grant so an immediate hello cannot outrun registration.
    grant ||= await this.authorize(socket.request);
    assert(this.connections.size < 128, "Too many native client connections");
    this.connections.set(socket.id, { socket, grant, lastAt: Date.now() });
  }
  /** Messages of one connection are handled one after another, in arrival order. */
  message(socket: Socket, raw: string) {
    const connection = this.connections.get(socket.id);
    if (!connection) return;
    return (connection.tail = (connection.tail || Promise.resolve()).then(() => this.handle(socket, raw)));
  }
  private async handle(socket: Socket, raw: string) {
    const connection = this.connections.get(socket.id);
    if (!connection) return;
    let accepted = false;
    try {
      assert(await this.valid(connection.grant), "Client authorization revoked");
      assert(Buffer.byteLength(raw) <= CLIENT_SOCKET_LIMIT, "Client message too large");
      const value = JSON.parse(raw);
      assert(value && typeof value === "object" && !Array.isArray(value), "Invalid client message");
      connection.lastAt = Date.now();
      const { grant } = connection;
      if (!connection.details) {
        assert(value.type === "hello" && value.clientId === grant.clientId, "Client identity mismatch");
        validateClient(value);
        assert(value.version === undefined || (typeof value.version === "string" && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value.version)), "Invalid client version");
        const minimum = minClientVersion();
        if (clientOutdated(minimum, value.version)) {
          // Say why before closing: a bare socket close only looks like a network fault on the client.
          socket.send(JSON.stringify({ type: "error", code: "client_outdated", message: `本节点要求客户端 ${minimum} 或更新，当前为 ${value.version || "未知版本"}，请到「资源」页下载并安装新客户端。` }));
          this.close(socket.id, true);
          return;
        }
        if (value.relay !== undefined) await this.relay?.configure(grant, value.relay);
        // Read before connecting, so nothing awaits between connect and "ready" (queued jobs follow "ready").
        const busy = value.autoUpdate === true && value.resume === true && !!value.version ? await this.clientInUse(grant.clientId) : false;
        const previous = this.hub.active(grant.userId, grant.clientId);
        if (previous && previous.instance !== value.instance) this.hub.disconnect(grant.userId, previous.instance);
        connection.transport = {
          send: (job) => socket.send(JSON.stringify(job)),
          close: () => this.close(socket.id),
        };
        this.hub.connect(grant.userId, value, connection.transport);
        connection.details = { instance: value.instance, clientId: value.clientId, name: value.name, cwd: value.cwd, platform: value.platform, supplement: value.supplement, resume: value.resume === true, autoUpdate: value.autoUpdate === true && value.resume === true && !!value.version };
        const agent = this.hub.active(grant.userId, grant.clientId)!;
        accepted = true;
        socket.send(JSON.stringify({ type: "ready", userId: grant.userId, clientId: grant.clientId, ...(connection.details.autoUpdate ? { autoUpdate: true, sessionIdle: true, busy } : {}), ...(value.resume === true ? { resume: true, pending: [...agent.pending.keys()], leases: [...agent.browserLeases] } : {}) }));
        return;
      }
      if (value.type === "update_prepare") {
        assert(connection.details.autoUpdate && !connection.updating, "Client update not negotiated");
        const inUse = await this.clientInUse(grant.clientId), agent = this.hub.active(grant.userId, grant.clientId);
        const idle = agent && agent.transport === connection.transport && !agent.reconnecting && !agent.pending.size && !agent.browserLeases.size && !inUse;
        if (idle) {
          connection.updating = true;
          // Reserve the same instance; new operations wait instead of racing the restart.
          this.hub.suspend(grant.userId, agent.instance, connection.transport, true);
        }
        accepted = true;
        socket.send(JSON.stringify({ type: idle ? "update_ready" : "update_busy" }));
      } else if (value.type === "ping") {
        if (value.relay !== undefined) await this.relay?.configure(grant, value.relay);
        if ("supplement" in value) {
          validateClient({ ...connection.details, supplement: value.supplement });
          connection.details.supplement = value.supplement;
        }
        if (!connection.updating) this.hub.connect(grant.userId, connection.details);
        accepted = true;
        socket.send(JSON.stringify({ type: "pong", ...(connection.details.autoUpdate ? { busy: await this.clientInUse(grant.clientId) } : {}) }));
      } else {
        assert(value.type === "result", "Client may only send heartbeats and job results");
        this.hub.result(grant.userId, { id: value.id, result: value.result, instance: connection.details.instance });
        // Results also prove the control channel is alive; refresh the agent heartbeat so a burst of
        // results without an interleaved ping cannot expire the LocalAgents timer and suspend the client.
        if (!connection.updating) this.hub.connect(grant.userId, connection.details);
        accepted = true;
        if (connection.details.resume) socket.send(JSON.stringify({ type: "ack", id: value.id }));
      }
    } catch { this.close(socket.id, !accepted); }
  }
  /** A result posted over HTTP; the response is its acknowledgement. */
  async upload(request: Socket["request"], value: Obj) {
    const grant = await this.authorize(request), instance = request.headers.get("x-vega-instance");
    assert(await this.valid(grant), "Client authorization revoked");
    assert(value && typeof value === "object" && value.type === "result", "Invalid client result");
    assert(this.hub.active(grant.userId, grant.clientId)?.instance === instance, "Agent disconnected");
    return this.hub.result(grant.userId, { id: value.id, result: value.result, instance });
  }
  async revoke(userId: string, clientId?: string) {
    for (const grant of await this.store.objects<Grant>("client-token")) {
      if (grant.userId === userId && (!clientId || grant.clientId === clientId)) await this.store.remove("client-token", grant.hash);
    }
    for (const [id, connection] of this.connections) {
      if (connection.grant.userId === userId && (!clientId || connection.grant.clientId === clientId)) this.close(id, true);
    }
    const agent = clientId ? this.hub.active(userId, clientId) : undefined;
    if (agent) this.hub.disconnect(userId, agent.instance);
    else if (!clientId) this.hub.disconnect(userId);
  }
  close(id: string, permanent = false) {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    if (connection.details) {
      this.relay?.disconnect(connection.grant.userId, connection.grant.clientId, connection.transport);
      if (permanent) this.hub.disconnect(connection.grant.userId, connection.details.instance, connection.transport);
      else this.hub.suspend(connection.grant.userId, connection.details.instance, connection.transport);
    }
    connection.socket.close(1000, "Client connection closed");
  }
  closeAll() {
    clearInterval(this.timer);
    this.auth.events.off("revoke", this.onRevoke);
    for (const id of this.connections.keys()) this.close(id, true);
  }
}
