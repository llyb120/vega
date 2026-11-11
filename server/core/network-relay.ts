import { randomUUID } from "node:crypto";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import type { Store } from "./store";
import type { Agent, LocalAgents } from "./local-agent";
import { decodeFrame, encodeFrame, type Wire } from "./sse";
import { assert } from "./util";

const FRAME = 32 << 10;
type Grant = { userId: string; clientId: string; hash: string };
type Record = Grant & { rules: string[]; on?: boolean };
/** 中继开关已取消：只要云端是 Master，就允许借用在线 Follower，忽略旧的 on 关闭记录。 */
const allowed = (_record: Record) => true;
type TunnelPeer = Wire;
type Flow = { grant: Grant; transport: Agent["transport"]; socket: Socket; peer?: TunnelPeer; ready: boolean; sending: boolean; incoming: boolean; timer: ReturnType<typeof setTimeout>; finish: (reason?: string) => void };

export function relayRules(value: unknown): string[] {
  assert(Array.isArray(value) && value.length <= 64, "最多配置 64 条中继规则");
  return [...new Set(value.map((item) => {
    assert(typeof item === "string" && item.length <= 260, "Invalid relay rule");
    const parts = item.toLowerCase().split(":"), host = parts[0], port = Number(parts[1]);
    assert(parts.length === 2 && validRelayHost(host) && /^\d{1,5}$/.test(parts[1]) && port > 0 && port <= 65535, "中继规则必须是精确域名:端口");
    return `${host}:${port}`;
  }))].sort();
}
export function validRelayHost(host: string) {
  return host.length > 0 && host.length <= 253 && !isIP(host) && host !== "localhost" && !host.endsWith(".localhost") &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

// A tiny bounded SOCKS5 handshake; leave payload in the socket for the selected transport.
async function bytes(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off("readable", read); socket.off("close", closed); socket.off("error", failed); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => failed(Error("Proxy connection closed"));
    const read = () => { const data = socket.read(length); if (data) { cleanup(); resolve(data); } else if (socket.destroyed || socket.readableEnded) closed(); };
    socket.on("readable", read).once("close", closed).once("error", failed);
    read();
  });
}
async function destination(socket: Socket) {
  const greeting = await bytes(socket, 2);
  assert(greeting[0] === 5 && greeting[1] > 0, "SOCKS5 required");
  assert((await bytes(socket, greeting[1])).includes(0), "Unsupported proxy authentication");
  socket.write(Buffer.from([5, 0]));
  const request = await bytes(socket, 4);
  assert(request[0] === 5 && request[1] === 1 && request[2] === 0, "Only TCP CONNECT is supported");
  let host: string;
  if (request[3] === 3) {
    const length = (await bytes(socket, 1))[0];
    assert(length > 0, "Missing hostname");
    const name = await bytes(socket, length);
    assert(name.every((b) => b > 32 && b < 127), "Invalid hostname");
    host = name.toString("ascii").toLowerCase().replace(/\.$/, "");
    assert(validRelayHost(host) || isIP(host) || host === "localhost", "Invalid hostname");
  } else if (request[3] === 1) host = [...await bytes(socket, 4)].join(".");
  else if (request[3] === 4) {
    const ip = await bytes(socket, 16);
    host = Array.from({ length: 8 }, (_, i) => ip.readUInt16BE(i * 2).toString(16)).join(":");
  } else throw Error("Unsupported address type");
  const port = (await bytes(socket, 2)).readUInt16BE();
  assert(port > 0, "Invalid port");
  return { host, port };
}
const reply = (socket: Socket, code = 0) => socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));

export class NetworkRelay {
  private proxies = new Map<string, Promise<{ server: Server; port: number; sockets: Set<Socket> }>>();
  private flows = new Map<string, Flow>();
  private peers = new Map<string, string>();
  private closed = false;
  // 同一个地址最近从客户端走通过就不用再探：否则每个连接都要先直连失败或超时一次。
  private routes = new Map<string, number>();
  static ROUTE_TTL_MS = 10 * 60_000;
  /** 仅当云端是文件系统或浏览器 Master 时才允许经 Follower 出网；本机当 Master 时绝不借云端当出口。 */
  constructor(private store: Store, private hub: LocalAgents, private mayBorrow?: (userId: string, employeeId?: string) => boolean | Promise<boolean>) {}
  private routeKey(userId: string, host: string, port: number) { return `${userId}:${host}:${port}`; }
  private viaClient(userId: string, host: string, port: number) {
    const at = this.routes.get(this.routeKey(userId, host, port));
    return at !== undefined && Date.now() - at < NetworkRelay.ROUTE_TTL_MS;
  }

  async configure(grant: Grant, value: unknown, on?: unknown) {
    const rules = relayRules(value), key = grant.userId + ":" + grant.clientId;
    const enabled = typeof on === "boolean" ? on : rules.length > 0;
    const previous = await this.store.object<Record>("client-relay", key);
    if (previous?.hash === grant.hash && previous.on === enabled && JSON.stringify(previous.rules) === JSON.stringify(rules)) return;
    const changed = previous ? previous.hash !== grant.hash || previous.on !== enabled || JSON.stringify(previous.rules) !== JSON.stringify(rules) : rules.length > 0;
    await this.store.save("client-relay", key, { ...grant, rules, on: enabled });
    if (!changed) return;
    for (const key of this.routes.keys()) if (key.startsWith(grant.userId + ":")) this.routes.delete(key);
    for (const flow of this.flows.values()) if (flow.grant.userId === grant.userId) flow.finish();
    // Flush pooled direct connections too: a newly protected domain must not keep its old route.
    const proxy = this.proxies.get(grant.userId);
    if (proxy) for (const socket of (await proxy).sockets) socket.destroy();
  }
  async route(userId: string, host: string, port: number) {
    const records = (await this.store.objects<Record>("client-relay")).filter((r) => r.userId === userId && r.rules.some((rule) => rule.split(":")[0] === host));
    if (!records.length) return;
    assert(records.length === 1, "多个客户端配置了同一中继域名，请在客户端消除冲突");
    const record = records[0];
    assert(allowed(record), "客户端已关闭该账户的流量中继，不会回退直连");
    assert(record.rules.includes(`${host}:${port}`), "客户端未授权该域名端口");
    assert(await this.borrowAllowed(userId), "本机是 Master 时不能借云端当出口，流量中继仅在云端为文件系统或浏览器 Master 时单向借用 Follower");
    const agent = this.hub.active(userId, record.clientId);
    assert(agent?.transport && !agent.reconnecting, "中继客户端离线，不会回退直连");
    return { record, agent };
  }
  /**
   * 没有规则命中的目标也会在服务端直连失败后走这台在线客户端：它是否有规则不影响兜底，
   * 只要该账号的中继开关没关。
   */
  async fallback(userId: string) {
    if (!(await this.borrowAllowed(userId))) return;
    const records = (await this.store.objects<Record>("client-relay")).filter((item) => item.userId === userId && allowed(item));
    const candidates = records.map((record) => {
      const agent = this.hub.active(userId, record.clientId);
      return agent?.transport && !agent.reconnecting ? { record, agent } : undefined;
    }).filter(Boolean) as { record: Record; agent: Agent }[];
    if (candidates.length !== 1) return;
    return candidates[0];
  }
  private async borrowAllowed(userId: string, employeeId?: string) {
    return this.mayBorrow ? !!(await this.mayBorrow(userId, employeeId)) : true;
  }
  /** 服务端命令要不要带上中继代理：该牛马的云端是 Master，且有在线且开启中继的客户端。 */
  async enabled(userId: string, employeeId?: string) {
    if (!(await this.borrowAllowed(userId, employeeId))) return false;
    return !!(await this.fallback(userId));
  }
  inUse(clientId: string) { return [...this.flows.values()].some((flow) => flow.grant.clientId === clientId); }
  disconnect(userId: string, clientId: string, transport?: Agent["transport"]) {
    for (const flow of this.flows.values())
      if (flow.grant.userId === userId && flow.grant.clientId === clientId && (!transport || flow.transport === transport)) flow.finish();
    // Keep rules when offline/revoked, including across restarts, to prevent accidental public fallback.
  }
  async proxy(userId: string) {
    assert(!this.closed && userId, "Relay stopped or missing owner");
    let starting = this.proxies.get(userId);
    if (!starting) {
      starting = (async () => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          if (sockets.size >= 128) { socket.destroy(); return; }
          sockets.add(socket);
          socket.on("error", () => {}).once("close", () => sockets.delete(socket));
          socket.setTimeout(15000, () => socket.destroy());
          void this.accept(userId, socket).catch((error) => {
            console.warn("[Vega relay] SOCKS rejected", { userId, reason: error instanceof Error ? error.message : "Unknown proxy error" });
            if (!socket.destroyed) { reply(socket, 1); socket.end(); }
          });
        });
        await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => { server.off("error", no); yes(); }); });
        server.on("error", () => { for (const socket of sockets) socket.destroy(); });
        server.unref();
        return { server, port: (server.address() as { port: number }).port, sockets };
      })();
      this.proxies.set(userId, starting);
      void starting.catch(() => this.proxies.delete(userId));
    }
    return `socks5://127.0.0.1:${(await starting).port}`;
  }
  private async accept(userId: string, socket: Socket) {
    const { host, port } = await destination(socket);
    const selected = await this.route(userId, host, port).catch((error) => {
      throw Error(`${host}:${port}: ${error instanceof Error ? error.message : "Route rejected"}`);
    });
    if (socket.destroyed || this.closed) return;
    if (selected) return this.tunnel(socket, selected.record, selected.agent, host, port);
    if (this.viaClient(userId, host, port)) {
      const fallback = await this.fallback(userId);
      if (socket.destroyed || this.closed) return;
      if (fallback) return this.tunnel(socket, fallback.record, fallback.agent, host, port, true);
      this.routes.delete(this.routeKey(userId, host, port));
    }
    this.direct(userId, socket, host, port);
  }
  /**
   * 没有规则命中时先由服务端直连：失败或 5 秒没连上，再让该账号的在线客户端试一次（反向永不发生）。
   * 域名为准：IP 字面量和 localhost 客户端不接受，直接失败。
   */
  private direct(userId: string, socket: Socket, host: string, port: number) {
    let settled = false;
    const remote = connect({ host, port });
    const stop = () => (settled ? true : (settled = true, false));
    socket.once("close", () => remote.destroy());
    const timer = setTimeout(() => { if (!stop()) { remote.destroy(); this.retry(userId, socket, host, port, "连接超时"); } }, 5000);
    remote.once("error", (error: NodeJS.ErrnoException) => {
      if (stop()) return;
      clearTimeout(timer);
      remote.destroy();
      this.retry(userId, socket, host, port, error.code || error.message);
    });
    remote.once("connect", () => {
      if (settled) { remote.destroy(); return; }
      stop();
      clearTimeout(timer);
      remote.once("close", () => socket.destroy());
      reply(socket);
      socket.setTimeout(300000);
      socket.pipe(remote).pipe(socket);
    });
  }
  private retry(userId: string, socket: Socket, host: string, port: number, reason: string) {
    const fail = (tip: string) => {
      console.warn("[Vega relay] Direct connection failed", { userId, host, port, reason, tip });
      if (!socket.destroyed) try { reply(socket, 4); } catch {}
      socket.destroy();
    };
    if (!validRelayHost(host)) return fail("目标是 IP 或 localhost，域名中继无法匹配；请用域名访问，并确认反代转发 /api/local-agent/relay 与 X-Vega-Relay。");
    void this.fallback(userId).then((selected) => {
      if (socket.destroyed || this.closed) return;
      if (!selected) return fail("该账号没有在线且开启流量中继的客户端；请在客户端「连接授权 → 流量中继」打开开关后重试。");
      console.warn("[Vega relay] Direct dial failed; retrying through the account client", { userId, clientId: selected.record.clientId, host, port, reason });
      this.routes.set(this.routeKey(userId, host, port), Date.now());
      this.tunnel(socket, selected.record, selected.agent, host, port, true);
    }).catch(() => socket.destroy());
  }
  private tunnel(socket: Socket, record: Record, agent: Agent, host: string, port: number, fallback = false) {
    assert(this.flows.size < 512 && [...this.flows.values()].filter((f) => f.grant.userId === record.userId && f.grant.clientId === record.clientId).length < 64, "Too many relay connections");
    const id = randomUUID();
    const finish = (reason?: string) => {
      const flow = this.flows.get(id);
      if (!flow) return;
      if (reason) console.warn("[Vega relay] Tunnel failed", { userId: record.userId, clientId: flow.grant.clientId, id, host, port, stage: flow.ready ? "stream" : flow.peer ? "target_connect" : "stream_open", reason,
        tip: flow.ready ? undefined : "客户端未在时限内就绪：检查本机客户端在线、目标是否在流量中继规则中、反代是否转发 /api/local-agent/relay 与 X-Vega-Relay，以及客户端日志中的 relay 失败原因。" });
      this.flows.delete(id);
      clearTimeout(flow.timer);
      // 没就绪就断了，说明这条客户端路由此刻走不通：下次重新判断这个地址。
      if (!flow.ready) this.routes.delete(this.routeKey(record.userId, host, port));
      if (flow.peer) { this.peers.delete(flow.peer.id); flow.peer.close(1000, "Relay closed"); }
      socket.destroy();
    };
    const flow: Flow = { grant: record, transport: agent.transport, socket, ready: false, sending: false, incoming: false, timer: setTimeout(() => finish("Client readiness timed out"), 15000), finish };
    this.flows.set(id, flow);
    socket.once("close", () => finish(flow.ready ? undefined : "SOCKS connection closed before client readiness"));
    try { agent.transport!.send({ type: "relay", id, args: { host, port, ...(fallback ? { fallback: true } : {}) } }); }
    catch { finish("Control channel send failed"); }
  }
  open(peer: TunnelPeer, grant: Grant, id: string) {
    const flow = this.flows.get(id), agent = this.hub.active(grant.userId, grant.clientId);
    assert(flow && !flow.peer && flow.grant.hash === grant.hash && flow.grant.userId === grant.userId && flow.grant.clientId === grant.clientId && agent && agent.transport === flow.transport && !agent.reconnecting, "Invalid or expired relay connection");
    flow.peer = peer;
    this.peers.set(peer.id, id);
  }
  message(peer: TunnelPeer, data: Uint8Array) {
    const flow = this.flows.get(this.peers.get(peer.id) || "");
    if (!flow) { peer.close(1000, "Relay closed"); return; }
    try {
      assert(data.length > 0 && data.length <= FRAME + 1, "Invalid relay frame");
      if (data[0] === 2) {
        assert(data.length === 1 && !flow.ready, "Unexpected relay readiness");
        flow.ready = true;
        clearTimeout(flow.timer);
        flow.socket.setTimeout(300000);
        reply(flow.socket);
        flow.socket.on("readable", () => this.send(flow));
        flow.socket.once("end", flow.finish);
        this.send(flow);
      } else if (data[0] === 1) {
        assert(data.length === 1 && flow.ready && flow.sending, "Unexpected acknowledgement");
        flow.sending = false;
        clearTimeout(flow.timer);
        this.send(flow);
      } else {
        assert(data[0] === 0 && data.length > 1 && flow.ready && !flow.incoming, "Unexpected relay data");
        flow.incoming = true;
        flow.socket.write(Buffer.from(data.subarray(1)), (error) => {
          flow.incoming = false;
          if (error || flow.socket.destroyed) flow.finish();
          else peer.send({ type: "relay", data: encodeFrame(Buffer.from([1])) }, { data: true });
        });
      }
    } catch { flow.finish("Invalid tunnel frame"); }
  }
  private send(flow: Flow) {
    if (flow.sending || flow.socket.destroyed || !flow.ready) return;
    const size = Math.min(FRAME, flow.socket.readableLength);
    if (!size) return;
    const data = flow.socket.read(size) as Buffer | null;
    if (!data) return;
    // shortcut: one bounded frame in flight per direction; add a credit window if WAN throughput requires it.
    flow.sending = true;
    flow.timer = setTimeout(() => flow.finish("Acknowledgement timed out"), 30000);
    try { flow.peer!.send({ type: "relay", data: encodeFrame(Buffer.concat([Buffer.from([0]), data])) }, { data: true }); } catch { flow.finish("Tunnel send failed"); }
  }
  closePeer(id: string) {
    const flow = this.flows.get(this.peers.get(id) || "");
    flow?.finish(flow.ready ? undefined : "Client tunnel closed before target connection was ready");
  }
  /** One upstream frame posted by the client; the tunnel's byte order must never be reordered. */
  incoming(id: string, grant: Grant, text: unknown) {
    const flow = this.flows.get(id);
    assert(flow?.peer && flow.grant.hash === grant.hash && flow.grant.userId === grant.userId && flow.grant.clientId === grant.clientId, "Invalid or expired relay connection");
    this.message(flow.peer, decodeFrame(text));
  }
  async close() {
    this.closed = true;
    for (const flow of this.flows.values()) flow.finish();
    for (const pending of this.proxies.values()) {
      const proxy = await pending.catch(() => undefined);
      if (!proxy) continue;
      for (const socket of proxy.sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    }
    this.proxies.clear();
  }
}
