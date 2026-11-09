import { createHash, randomUUID } from "node:crypto";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import type { Peer } from "crossws";
import type { Store } from "./store";
import type { Agent, LocalAgents } from "./local-agent";
import { assert } from "./util";

const FRAME = 32 << 10;
type Grant = { userId: string; clientId: string; hash: string };
type Record = Grant & { rules: string[] };
type TunnelPeer = Pick<Peer, "id" | "send" | "close">;
type Flow = { grant: Grant; transport: Agent["transport"]; socket: Socket; peer?: TunnelPeer; ready: boolean; sending: boolean; incoming: boolean; timer: ReturnType<typeof setTimeout>; finish: (reason?: string) => void; preview?: string };
export type PreviewBackend = { kind: "client"; clientId: string; host: string; port: number } | { kind: "cloud"; port: number };
/** A session's stable development origin; only its backend moves between the client relay and a cloud service. */
export type Preview = { host: string; userId: string; sessionId: string; backend: PreviewBackend; updatedAt: number };
export const PREVIEW_SUFFIX = ".preview.vega.internal";
export const previewHost = (sessionId: string) => "s" + createHash("sha256").update(sessionId).digest("hex").slice(0, 20) + PREVIEW_SUFFIX;
export const previewOrigin = (preview: Pick<Preview, "host">) => "http://" + preview.host;

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
  private previewSockets = new Map<string, Set<Socket>>();
  private closed = false;
  constructor(private store: Store, private hub: LocalAgents) {}

  async previews(sessionId: string) {
    return (await this.store.objects<Preview>("preview")).filter((preview) => preview.sessionId === sessionId);
  }
  async preview(host: string) { return await this.store.object<Preview>("preview", host); }
  /** Saving a new backend drops open connections to the origin so pages and WebSockets reconnect to it. */
  async savePreview(preview: Preview) {
    assert(preview.host.endsWith(PREVIEW_SUFFIX) && validRelayHost(preview.host), "Invalid preview host");
    const backend = preview.backend;
    assert(Number.isInteger(backend.port) && backend.port > 0 && backend.port <= 65535, "Invalid preview port");
    if (backend.kind === "client") assert(/^[a-f0-9-]{32,36}$/.test(backend.clientId) && validRelayHost(backend.host), "预览的客户端后端必须是精确域名:端口，不能是 localhost 或 IP");
    await this.store.save("preview", preview.host, { ...preview, updatedAt: Date.now() });
    for (const flow of this.flows.values()) if (flow.preview === preview.host) flow.finish();
    for (const socket of this.previewSockets.get(preview.host) || []) socket.destroy();
  }
  async removePreview(host: string) {
    await this.store.remove("preview", host);
    for (const flow of this.flows.values()) if (flow.preview === host) flow.finish();
    for (const socket of this.previewSockets.get(host) || []) socket.destroy();
  }

  async configure(grant: Grant, value: unknown) {
    const rules = relayRules(value), key = grant.userId + ":" + grant.clientId;
    const previous = await this.store.object<Record>("client-relay", key);
    if (previous?.hash === grant.hash && JSON.stringify(previous.rules) === JSON.stringify(rules)) return;
    const changed = previous ? previous.hash !== grant.hash || JSON.stringify(previous.rules) !== JSON.stringify(rules) : rules.length > 0;
    await this.store.save("client-relay", key, { ...grant, rules });
    if (!changed) return;
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
    assert(record.rules.includes(`${host}:${port}`), "客户端未授权该域名端口");
    const agent = this.hub.active(userId, record.clientId);
    assert(agent?.transport && !agent.reconnecting, "中继客户端离线，不会回退直连");
    return { record, agent };
  }
  /** A preview bound to a client never falls back to a direct or cloud connection while that client is away. */
  async client(userId: string, clientId: string, host: string, port: number) {
    const record = (await this.store.objects<Record>("client-relay")).find((r) => r.userId === userId && r.clientId === clientId);
    assert(record && record.rules.includes(`${host}:${port}`), "预览后端不在该客户端的流量中继规则中，未连接");
    const agent = this.hub.active(userId, clientId);
    assert(agent?.transport && !agent.reconnecting, "预览后端所在客户端离线，不会回退直连或改连云端");
    return { record: record as Record, agent };
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
    const requested = await destination(socket);
    let { host, port } = requested;
    const preview = host.endsWith(PREVIEW_SUFFIX) ? await this.preview(host) : undefined;
    if (host.endsWith(PREVIEW_SUFFIX)) assert(preview && preview.userId === userId && port === 80, `${host}:${port}: 预览地址未登记或不属于该用户`);
    if (preview?.backend.kind === "cloud") {
      const sockets = this.previewSockets.get(host) || new Set<Socket>(), origin = host;
      this.previewSockets.set(origin, sockets);
      sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); if (!sockets.size) this.previewSockets.delete(origin); });
      const remote = connect({ host: "127.0.0.1", port: preview.backend.port });
      remote.on("error", () => { if (!socket.destroyed) try { reply(socket, 5); } catch {} socket.destroy(); });
      socket.once("close", () => remote.destroy());
      remote.once("close", () => socket.destroy());
      remote.once("connect", () => { reply(socket); socket.setTimeout(300000); socket.pipe(remote).pipe(socket); });
      return;
    }
    if (preview?.backend.kind === "client") ({ host, port } = preview.backend);
    const selected = await (preview?.backend.kind === "client" ? this.client(userId, preview.backend.clientId, host, port) : this.route(userId, host, port)).catch((error) => {
      throw Error(`${requested.host}:${requested.port}: ${error instanceof Error ? error.message : "Route rejected"}`);
    });
    if (socket.destroyed || this.closed) return;
    if (!selected) {
      // Unmatched hosts dial from the server. Domain rules never match IP literals — employee
      // browsers send hostnames via host-resolver-rules; an IP here means those rules cannot apply.
      void this.store.objects<Record>("client-relay").then((rows) => {
        const ruled = rows.some((r) => r.userId === userId && r.rules.length > 0);
        console.warn("[Vega relay] No matching client rule; dialing from server", {
          userId, host, port, addressType: isIP(host) ? "ip" : "hostname",
          tip: isIP(host) && ruled
            ? "SOCKS 目标是 IP，域名中继规则无法匹配；服务端浏览器应通过域名访问。若反代未转发 /api/local-agent/relay，中继隧道也会失败并表现为 SOCKS 错误。"
            : ruled
              ? "已配置中继规则但未命中此域名:端口；未匹配时不会走客户端。请在客户端「流量中继」填写精确域名（裸域名自动含 80/443），并确认反代转发 /api/local-agent/relay 与 X-Vega-Relay。"
              : "未配置客户端中继规则；仅客户端可达的目标会失败。",
        });
      }).catch(() => {});
      const remote = connect({ host, port });
      remote.on("error", (error: NodeJS.ErrnoException) => {
        console.warn("[Vega relay] Direct connection failed", { userId, host, port, code: error.code });
        if (!socket.destroyed) try { reply(socket, 4); } catch {}
        socket.destroy();
      });
      socket.once("close", () => remote.destroy());
      remote.once("close", () => socket.destroy());
      remote.once("connect", () => { reply(socket); socket.setTimeout(300000); socket.pipe(remote).pipe(socket); });
      return;
    }
    assert(this.flows.size < 512 && [...this.flows.values()].filter((f) => f.grant.userId === userId && f.grant.clientId === selected.record.clientId).length < 64, "Too many relay connections");
    const id = randomUUID();
    const finish = (reason?: string) => {
      const flow = this.flows.get(id);
      if (!flow) return;
      if (reason) console.warn("[Vega relay] Tunnel failed", { userId, clientId: flow.grant.clientId, id, host, port, stage: flow.ready ? "stream" : flow.peer ? "target_connect" : "websocket_upgrade", reason,
        tip: flow.ready ? undefined : "客户端未在时限内就绪：检查本机客户端在线、目标是否在流量中继规则中、反代是否转发 /api/local-agent/relay 与 X-Vega-Relay，以及客户端日志中的 relay 失败原因。" });
      this.flows.delete(id);
      clearTimeout(flow.timer);
      if (flow.peer) { this.peers.delete(flow.peer.id); flow.peer.close(1000, "Relay closed"); }
      socket.destroy();
    };
    const flow: Flow = { grant: selected.record, transport: selected.agent.transport, socket, ready: false, sending: false, incoming: false, timer: setTimeout(() => finish("Client readiness timed out"), 15000), finish, preview: preview?.host };
    this.flows.set(id, flow);
    socket.once("close", () => finish(flow.ready ? undefined : "SOCKS connection closed before client readiness"));
    try { selected.agent.transport!.send({ type: "relay", id, args: { host, port } }); }
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
    if (!flow) { peer.close(); return; }
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
          else try { peer.send(Buffer.from([1])); } catch { flow.finish(); }
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
    try { flow.peer!.send(Buffer.concat([Buffer.from([0]), data])); } catch { flow.finish("Tunnel send failed"); }
  }
  closePeer(id: string) {
    const flow = this.flows.get(this.peers.get(id) || "");
    flow?.finish(flow.ready ? undefined : "Client tunnel closed before target connection was ready");
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
