import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import type { Store } from "./store";
import type { Agent, LocalAgents } from "./local-agent";
import { decodeFrame, encodeFrame, type Wire } from "./sse";
import { assert } from "./util";

const FRAME = 32 << 10;
type Grant = { userId: string; clientId: string; hash: string };
type Record = Grant & { rules: string[]; on?: boolean };
/** 中继开关已取消：服务端可单向借用在线客户端出网（按账号隔离），忽略旧的 on 关闭记录。 */
const allowed = (_record: Record) => true;
type TunnelPeer = Wire;
type Flow = {
  grant: Grant;
  transport: Agent["transport"];
  socket: Socket;
  peer?: TunnelPeer;
  ready: boolean;
  window: number;
  maxFrame: number;
  inFlight: number;
  incomingQueue: Buffer[];
  draining: boolean;
  timer: ReturnType<typeof setTimeout>;
  finish: (reason?: string) => void;
};

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
  private directWaiters = new Map<string, Set<() => void>>();
  private closed = false;
  // 同一个地址最近从客户端走通过就不用再探：否则每个连接都要先直连失败或超时一次。
  private routes = new Map<string, number>();
  static ROUTE_TTL_MS = 10 * 60_000;
  static DIRECT_FALLBACK_TIMEOUT_MS = 2000;
  static DIRECT_ONLY_TIMEOUT_MS = 12000;
  static DIRECT_STAGGER_MS = 300;
  static FAST_FRAME = 256 << 10;
  static WINDOW = 8;
  static MAX_INCOMING_QUEUE = 16;
  /** 某账号的中继规则或在线状态变化时触发，用于动态刷新该账号私有浏览器的代理模式。 */
  onChange?: (userId: string) => void;
  /** DNS 多地址解析（可被单测覆盖以确定性验证多 IP 故障切换）。 */
  resolveHost: (host: string) => Promise<{ address: string; family: number }[]> = (host) =>
    lookup(host, { all: true, verbatim: false });
  /** 服务端可借客户端网络中继出网，按账号隔离；客户端永不借服务端。 */
  constructor(private store: Store, private hub: LocalAgents) {}
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
    if (!previous || changed) this.onChange?.(grant.userId);
    if (!changed) return;
    for (const key of this.routes.keys()) if (key.startsWith(grant.userId + ":")) this.routes.delete(key);
    for (const flow of this.flows.values()) if (flow.grant.userId === grant.userId) flow.finish();
    // Flush pooled direct connections too: a newly protected domain must not keep its old route.
    const proxy = this.proxies.get(grant.userId);
    if (proxy) for (const socket of (await proxy).sockets) socket.destroy();
  }
  async route(userId: string, host: string, port: number) {
    if (!userId) return;
    const records = (await this.store.objects<Record>("client-relay")).filter((r) => r.userId === userId && r.rules.some((rule) => rule.split(":")[0] === host));
    if (!records.length) return;
    assert(records.length === 1, "多个客户端配置了同一中继域名，请在客户端消除冲突");
    const record = records[0];
    assert(allowed(record), "客户端已关闭该账户的流量中继，不会回退直连");
    assert(record.rules.includes(`${host}:${port}`), "客户端未授权该域名端口");
    const agent = this.hub.active(userId, record.clientId);
    assert(agent && agent.userId === userId && agent.transport && !agent.reconnecting, "中继客户端离线，不会回退直连");
    return { record, agent };
  }
  /**
   * 没有规则命中的目标也会在服务端直连失败后走同账号的在线客户端：它是否有规则不影响兜底。
   * 严格按 userId 隔离，绝不跨账号借用其他用户的客户端。
   */
  async fallback(userId: string) {
    if (!userId) return;
    const records = (await this.store.objects<Record>("client-relay")).filter((item) => item.userId === userId && allowed(item));
    const candidates = records.map((record) => {
      const agent = this.hub.active(userId, record.clientId);
      return agent && agent.userId === userId && agent.transport && !agent.reconnecting ? { record, agent } : undefined;
    }).filter(Boolean) as { record: Record; agent: Agent }[];
    if (!candidates.length) return;
    if (candidates.length === 1) return candidates[0];
    candidates.sort((a, b) => b.agent.order - a.agent.order);
    return candidates[0];
  }
  /** 该账号是否配置了显式域名中继规则（即使客户端离线也要拦截保护这些域名，防止静默直连泄漏）。 */
  async hasRules(userId: string) {
    if (!userId) return false;
    return (await this.store.objects<Record>("client-relay")).some((item) => item.userId === userId && item.rules.length > 0);
  }
  /** 服务端命令要不要带上中继代理：该账号有在线且可借用的同账号客户端。 */
  async enabled(userId: string) {
    return !!(await this.fallback(userId));
  }
  /**
   * 服务端私有浏览器要不要启用 SOCKS5 代理：
   * 只有在该账号自己有可借用的在线客户端、或配置了显式域名中继规则时才开启；
   * 否则返回 undefined，让浏览器直接走原生直连，不受其他账号在线客户端影响。
   */
  async browserProxy(userId: string): Promise<string | undefined> {
    if (!userId || this.closed) return undefined;
    if (await this.enabled(userId) || await this.hasRules(userId)) return await this.proxy(userId);
    return undefined;
  }
  inUse(clientId: string) { return [...this.flows.values()].some((flow) => flow.grant.clientId === clientId); }
  disconnect(userId: string, clientId: string, transport?: Agent["transport"]) {
    for (const flow of this.flows.values())
      if (flow.grant.userId === userId && flow.grant.clientId === clientId && (!transport || flow.transport === transport)) flow.finish();
    // Keep rules when offline/revoked, including across restarts, to prevent accidental public fallback.
    if (userId) this.onChange?.(userId);
  }
  async proxy(userId: string) {
    assert(!this.closed && userId, "Relay stopped or missing owner");
    let starting = this.proxies.get(userId);
    if (!starting) {
      starting = (async () => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          if (sockets.size >= 256) { socket.destroy(); return; }
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
    const fallback = validRelayHost(host) ? await this.fallback(userId) : undefined;
    if (socket.destroyed || this.closed) return;
    if (this.viaClient(userId, host, port)) {
      if (fallback) return this.tunnel(socket, fallback.record, fallback.agent, host, port, true);
      this.routes.delete(this.routeKey(userId, host, port));
    }
    await this.direct(userId, socket, host, port, !!fallback);
  }
  /**
   * 没有规则命中时先由服务端多 IP 并发探测直连（Happy Eyeballs）：
   * 单个死 IP 不会拖垮连接；全部失败或超时后，仅在该账号有在线客户端时交由同账号客户端试一次（反向永不发生）。
   * 域名为准：IP 字面量和 localhost 客户端不接受，直接失败。
   */
  private async direct(userId: string, socket: Socket, host: string, port: number, hasFallback: boolean) {
    const timeoutMs = hasFallback ? NetworkRelay.DIRECT_FALLBACK_TIMEOUT_MS : NetworkRelay.DIRECT_ONLY_TIMEOUT_MS;
    const key = this.routeKey(userId, host, port);
    let targets: { address: string; family: number }[];
    const ipFamily = isIP(host);
    if (ipFamily) {
      targets = [{ address: host, family: ipFamily }];
    } else {
      let lookupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const resolved = await Promise.race([
          this.resolveHost(host),
          new Promise<never>((_, reject) => {
            lookupTimer = setTimeout(() => reject(Object.assign(Error("DNS 解析超时"), { code: "ETIMEDOUT" })), timeoutMs);
          }),
        ]);
        const seen = new Set<string>();
        targets = [];
        for (const item of resolved || []) {
          if (!item?.address || seen.has(item.address)) continue;
          seen.add(item.address);
          targets.push({ address: item.address, family: item.family || isIP(item.address) || 4 });
          if (targets.length >= 6) break;
        }
        if (!targets.length) throw Object.assign(Error("No address found"), { code: "ENOTFOUND" });
      } catch (error: any) {
        clearTimeout(lookupTimer);
        if (socket.destroyed || this.closed) return;
        this.retry(userId, socket, host, port, error?.code || error?.message || "DNS 解析失败");
        return;
      } finally {
        clearTimeout(lookupTimer);
      }
    }
    if (socket.destroyed || this.closed) return;
    if (hasFallback && !ipFamily && this.viaClient(userId, host, port)) {
      this.retry(userId, socket, host, port, "Cached client route");
      return;
    }

    let settled = false;
    let nextIdx = 0;
    let lastError = "连接超时";
    let staggerTimer: ReturnType<typeof setTimeout> | undefined;
    const active = new Set<Socket>();
    let waiters: Set<() => void> | undefined;
    let abortToFallback: (() => void) | undefined;

    const cleanup = (keep?: Socket) => {
      clearTimeout(overallTimer);
      clearTimeout(staggerTimer);
      staggerTimer = undefined;
      if (waiters && abortToFallback) {
        waiters.delete(abortToFallback);
        if (waiters.size === 0) this.directWaiters.delete(key);
      }
      for (const candidate of active) {
        if (candidate !== keep) candidate.destroy();
      }
      active.clear();
    };
    const onClientClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    socket.once("close", onClientClose);

    const overallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.off("close", onClientClose);
      cleanup();
      this.retry(userId, socket, host, port, lastError);
    }, timeoutMs);

    if (hasFallback && !ipFamily) {
      waiters = this.directWaiters.get(key);
      if (!waiters) { waiters = new Set(); this.directWaiters.set(key, waiters); }
      abortToFallback = () => {
        if (settled) return;
        settled = true;
        socket.off("close", onClientClose);
        cleanup();
        this.retry(userId, socket, host, port, "Concurrent probe failed over");
      };
      waiters.add(abortToFallback);
    }

    const tryNext = () => {
      if (settled || nextIdx >= targets.length) return;
      const target = targets[nextIdx++];
      const remote = connect({ host: target.address, port, family: target.family });
      active.add(remote);
      if (nextIdx < targets.length) {
        clearTimeout(staggerTimer);
        staggerTimer = setTimeout(tryNext, NetworkRelay.DIRECT_STAGGER_MS);
      }
      const onError = (error: NodeJS.ErrnoException) => {
        active.delete(remote);
        remote.destroy();
        if (settled) return;
        lastError = error.code || error.message;
        if (nextIdx < targets.length) {
          clearTimeout(staggerTimer);
          staggerTimer = undefined;
          tryNext();
        } else if (active.size === 0) {
          settled = true;
          socket.off("close", onClientClose);
          cleanup();
          this.retry(userId, socket, host, port, lastError);
        }
      };
      remote.once("error", onError);
      remote.once("connect", () => {
        if (settled || socket.destroyed) {
          active.delete(remote);
          remote.destroy();
          return;
        }
        settled = true;
        socket.off("close", onClientClose);
        remote.off("error", onError);
        remote.on("error", () => socket.destroy());
        cleanup(remote);
        socket.once("close", () => remote.destroy());
        remote.once("close", () => socket.destroy());
        reply(socket);
        socket.setTimeout(300000);
        socket.pipe(remote).pipe(socket);
      });
    };

    tryNext();
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
      if (!selected) return fail("该账号当前没有可借用的在线客户端，且服务端直连失败。");
      console.warn("[Vega relay] Direct dial failed; retrying through the account client", { userId, clientId: selected.record.clientId, host, port, reason });
      const key = this.routeKey(userId, host, port);
      this.routes.set(key, Date.now());
      const waiters = this.directWaiters.get(key);
      if (waiters) {
        this.directWaiters.delete(key);
        for (const wake of [...waiters]) wake();
      }
      this.tunnel(socket, selected.record, selected.agent, host, port, true);
    }).catch(() => socket.destroy());
  }
  private tunnel(socket: Socket, record: Record, agent: Agent, host: string, port: number, fallback = false) {
    assert(this.flows.size < 1024 && [...this.flows.values()].filter((f) => f.grant.userId === record.userId && f.grant.clientId === record.clientId).length < 128, "Too many relay connections");
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
    const flow: Flow = {
      grant: record,
      transport: agent.transport,
      socket,
      ready: false,
      window: 1,
      maxFrame: FRAME,
      inFlight: 0,
      incomingQueue: [],
      draining: false,
      timer: setTimeout(() => finish("Client readiness timed out"), 15000),
      finish,
    };
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
      const limit = (flow.ready ? flow.maxFrame : FRAME) + 1;
      assert(data.length > 0 && data.length <= limit, "Invalid relay frame");
      if (data[0] === 2) {
        assert(!flow.ready && (data.length === 1 || (data.length === 2 && data[1] === 1)), "Unexpected relay readiness");
        flow.ready = true;
        if (data.length === 2 && data[1] === 1) {
          flow.window = NetworkRelay.WINDOW;
          flow.maxFrame = NetworkRelay.FAST_FRAME;
        } else {
          flow.window = 1;
          flow.maxFrame = FRAME;
        }
        clearTimeout(flow.timer);
        flow.socket.setTimeout(300000);
        reply(flow.socket);
        flow.socket.on("readable", () => this.send(flow));
        flow.socket.once("end", flow.finish);
        this.send(flow);
      } else if (data[0] === 1) {
        assert(data.length === 1 && flow.ready && flow.inFlight > 0, "Unexpected acknowledgement");
        flow.inFlight--;
        clearTimeout(flow.timer);
        if (flow.inFlight > 0) {
          flow.timer = setTimeout(() => flow.finish("Acknowledgement timed out"), 30000);
        }
        this.send(flow);
      } else {
        assert(data[0] === 0 && data.length > 1 && flow.ready && flow.incomingQueue.length < NetworkRelay.MAX_INCOMING_QUEUE, "Unexpected relay data");
        flow.incomingQueue.push(Buffer.from(data.subarray(1)));
        this.drainIncoming(flow);
      }
    } catch { flow.finish("Invalid tunnel frame"); }
  }
  private drainIncoming(flow: Flow) {
    if (flow.draining || flow.socket.destroyed) return;
    const next = flow.incomingQueue.shift();
    if (!next) return;
    flow.draining = true;
    flow.socket.write(next, (error) => {
      flow.draining = false;
      if (error || flow.socket.destroyed) {
        flow.finish();
        return;
      }
      try {
        flow.peer!.send({ type: "relay", data: encodeFrame(Buffer.from([1])) }, { data: true });
      } catch {
        flow.finish("Tunnel send failed");
        return;
      }
      this.drainIncoming(flow);
    });
  }
  private send(flow: Flow) {
    while (flow.inFlight < flow.window && !flow.socket.destroyed && flow.ready) {
      const size = Math.min(flow.maxFrame, flow.socket.readableLength);
      if (!size) break;
      const data = flow.socket.read(size) as Buffer | null;
      if (!data) break;
      flow.inFlight++;
      if (flow.inFlight === 1) {
        flow.timer = setTimeout(() => flow.finish("Acknowledgement timed out"), 30000);
      }
      try {
        flow.peer!.send({ type: "relay", data: encodeFrame(Buffer.concat([Buffer.from([0]), data])) }, { data: true });
      } catch {
        flow.finish("Tunnel send failed");
        return;
      }
    }
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
    this.directWaiters.clear();
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
