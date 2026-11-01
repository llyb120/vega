import { randomBytes } from "node:crypto";
import type { Peer } from "crossws";
import { Auth, digest } from "./auth";
import type { Store } from "./store";
import { LocalAgents, validateClient } from "./local-agent";
import { assert, type Obj } from "./util";

export const CLIENT_BODY_LIMIT = 48 << 20;
type Socket = Pick<Peer, "id" | "request" | "send" | "close">;
type Grant = { hash: string; userId: string; clientId: string; createdAt: number };
type Connection = { socket: Socket; grant: Grant; lastAt: number; details?: Obj };

export class ClientSockets {
  private connections = new Map<string, Connection>();
  private timer: ReturnType<typeof setInterval>;
  private onRevoke = (userId: string) => this.revoke(userId);
  constructor(private store: Store, private auth: Auth, private hub: LocalAgents) {
    auth.events.on("revoke", this.onRevoke);
    this.timer = setInterval(() => {
      for (const [id, connection] of this.connections) {
        if (Date.now() - connection.lastAt > 20000 || !this.valid(connection.grant)) this.close(id);
      }
    }, 5000);
    this.timer.unref();
  }
  pair(a: Obj) {
    assert(typeof a.clientId === "string" && /^[a-f0-9]{32}$/.test(a.clientId), "Invalid client ID");
    const proof = this.hub.verify(a.ticket, this.auth), user = this.auth.user(proof.userId);
    assert(user && !user.disabled && user.role !== "viewer", "Client pairing requires execution permission");
    const existing = typeof a.deviceToken === "string" ? this.record(a.deviceToken) : undefined;
    if (existing && existing.userId === user.id && existing.clientId === a.clientId)
      return { ...proof, clientId: a.clientId, deviceToken: a.deviceToken };
    const grants = this.store.objects<Grant>("client-token").filter((item) => item.userId === user.id);
    assert(grants.filter((item) => item.clientId !== a.clientId).length < 8, "Too many authorized clients");
    this.revoke(user.id, a.clientId);
    const deviceToken = randomBytes(32).toString("base64url"), hash = digest(deviceToken);
    this.store.save("client-token", hash, { hash, userId: user.id, clientId: a.clientId, createdAt: Date.now() } satisfies Grant);
    return { ...proof, clientId: a.clientId, deviceToken };
  }
  private record(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const grant = this.store.object<Grant>("client-token", digest(token));
    return grant && this.valid(grant) ? grant : undefined;
  }
  private valid(grant: Grant) {
    const stored = this.store.object<Grant>("client-token", grant.hash), user = this.auth.user(grant.userId);
    return !!stored && stored.clientId === grant.clientId && stored.userId === grant.userId && !!user && !user.disabled && user.role !== "viewer";
  }
  authorize(request: Socket["request"]) {
    assert(!request.headers.get("origin") && !new URL(request.url).search, "Native client connection required");
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") || "")?.[1];
    const grant = token && this.record(token);
    assert(grant, "Client credential invalid or revoked");
    return grant;
  }
  open(socket: Socket) {
    const grant = this.authorize(socket.request);
    assert(this.connections.size < 128, "Too many native client connections");
    this.connections.set(socket.id, { socket, grant, lastAt: Date.now() });
  }
  message(socket: Socket, raw: string) {
    const connection = this.connections.get(socket.id);
    if (!connection) return;
    try {
      assert(this.valid(connection.grant), "Client authorization revoked");
      assert(Buffer.byteLength(raw) <= CLIENT_BODY_LIMIT, "Client message too large");
      const value = JSON.parse(raw);
      assert(value && typeof value === "object" && !Array.isArray(value), "Invalid client message");
      connection.lastAt = Date.now();
      const { grant } = connection;
      if (!connection.details) {
        assert(value.type === "hello" && value.clientId === grant.clientId, "Client identity mismatch");
        validateClient(value);
        const previous = this.hub.active(grant.userId, grant.clientId);
        if (previous) this.hub.disconnect(grant.userId, previous.instance);
        this.hub.connect(grant.userId, value, {
          send: (job) => socket.send(JSON.stringify(job)),
          close: () => this.close(socket.id),
        });
        connection.details = { instance: value.instance, clientId: value.clientId, name: value.name, cwd: value.cwd, platform: value.platform };
        socket.send(JSON.stringify({ type: "ready", userId: grant.userId, clientId: grant.clientId }));
        return;
      }
      if (value.type === "ping") {
        this.hub.connect(grant.userId, connection.details);
        socket.send(JSON.stringify({ type: "pong" }));
      } else {
        assert(value.type === "result", "Client may only send heartbeats and job results");
        this.hub.result(grant.userId, { id: value.id, result: value.result, instance: connection.details.instance });
      }
    } catch { this.close(socket.id); }
  }
  revoke(userId: string, clientId?: string) {
    for (const grant of this.store.objects<Grant>("client-token")) {
      if (grant.userId === userId && (!clientId || grant.clientId === clientId)) this.store.remove("client-token", grant.hash);
    }
    for (const [id, connection] of this.connections) {
      if (connection.grant.userId === userId && (!clientId || connection.grant.clientId === clientId)) this.close(id);
    }
  }
  close(id: string) {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    if (connection.details) this.hub.disconnect(connection.grant.userId, connection.details.instance);
    connection.socket.close(1000, "Client connection closed");
  }
  closeAll() {
    clearInterval(this.timer);
    this.auth.events.off("revoke", this.onRevoke);
    for (const id of this.connections.keys()) this.close(id);
  }
}
