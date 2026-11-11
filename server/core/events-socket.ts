import { randomUUID } from "node:crypto";
import type { Auth, Principal } from "./auth";
import type { Engine } from "./engine";
import { eventAllowed } from "./http-auth";
import { SseChannels, type Request, type Wire } from "./sse";
import { assert, type Obj } from "./util";

type Socket = Wire;
type Ticket = { hash: string; until: number };
type Entry = { seq: number; at: number; value: Obj };
export type EventsOptions = {
  /** Server heartbeat and dead-peer check interval. */
  heartbeatMs?: number;
  /** Window in which streamed deltas of one session are merged into one event. */
  coalesceMs?: number;
  /** Live connections per account; zombies are reaped by the heartbeat so honest tabs are not starved. */
  perUser?: number;
  /** Replay window for reconnects. */
  replayMs?: number;
  replayEvents?: number;
};
/** Only the conversation(s) a page shows need token streams and per-tool detail. */
const STREAM = new Set(["text_delta", "thinking_delta", "tool_start", "context_budget"]);
const DELTAS = new Set(["text_delta", "thinking_delta"]);
const SOFT_BUFFER = 1 << 20,
  HARD_BUFFER = 8 << 20;

/** The page needs these events to know *that* something changed; payloads are fetched over HTTP. */
export function publicEvent(e: Obj): Obj | undefined {
  if (e.type === "tool_progress") return;
  if (e.type === "tool_end")
    return { ...e, data: { call: { id: e.data?.call?.id, name: e.data?.call?.name }, outcome: { error: !!e.data?.outcome?.error } } };
  // Lifecycle signals only: the page fetches the persisted message over HTTP (same as message_end).
  if (e.type === "message_end" || e.type === "user" || e.type === "steer") {
    const { data, ...rest } = e;
    return rest;
  }
  return e;
}

// Events-only channel: API calls use HTTP. Every event carries a process-wide seq so a reconnect can replay what a
// page missed instead of reloading everything; outside the replay window the page is told to reset.
export class EventsSocket {
  sessions = new Map<string, ReturnType<EventsSocket["session"]>>();
  /** Channels that extra lanes (bulk token deltas) may attach to. */
  channels = new SseChannels();
  tickets = new Map<string, Ticket>();
  epoch = randomUUID().slice(0, 8);
  seq = 0;
  log: Entry[] = [];
  private pending = new Map<string, Obj>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeat: ReturnType<typeof setInterval>;
  private options: Required<EventsOptions>;
  constructor(
    public engine: Pick<Engine, "events">,
    public auth: Auth,
    public allow: (...args: Parameters<typeof eventAllowed>) => boolean | Promise<boolean> = eventAllowed,
    options: EventsOptions = {},
  ) {
    this.options = { heartbeatMs: 20000, coalesceMs: 40, perUser: 12, replayMs: 120000, replayEvents: 5000, ...options };
    engine.events.on("event", this.ingest);
    this.heartbeat = setInterval(async () => await this.beat(), this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }
  async ticket(principal: Principal) {
    assert(await this.auth.resolveHash(principal.hash), "登录已失效");
    for (const [id, ticket] of this.tickets)
      if (ticket.until < Date.now()) this.tickets.delete(id);
    assert(this.tickets.size < 256, "实时连接票据过多");
    const id = randomUUID() + randomUUID();
    this.tickets.set(id, { hash: principal.hash, until: Date.now() + 15000 });
    return { ticket: id };
  }
  async identity(request: Request) {
    const url = new URL(request.url),
      origin = process.env.VEGA_PUBLIC_URL
        ? new URL(process.env.VEGA_PUBLIC_URL).origin
        : url.origin;
    assert(
      request.headers.get("origin") === origin &&
        !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") || ""),
      "不允许跨站连接",
    );
    const token = (request.headers.get("cookie") || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("vega_session="))
      ?.slice("vega_session=".length);
    const principal = await this.auth.authenticate(token);
    assert(principal, "登录已失效");
    return principal;
  }
  async authorize(request: Request, consume = false) {
    const principal = await this.identity(request),
      id = new URL(request.url).searchParams.get("ticket") || "",
      ticket = this.tickets.get(id);
    assert(principal && ticket?.hash === principal.hash, "连接票据已失效");
    assert(ticket.until >= Date.now(), "连接票据已过期");
    if (consume) this.tickets.delete(id);
    return { principal };
  }
  async open(socket: Socket, principal: Principal) {
    const mine = [...this.sessions.values()].filter((s) => s.principal.user.id === principal.user.id);
    if (mine.length >= this.options.perUser) {
      socket.close(4429, "实时连接过多，请关闭部分页面");
      return;
    }
    assert(this.sessions.size < 4096, "实时连接过多");
    const url = new URL(socket.request.url);
    const session = this.session(socket, principal);
    this.sessions.set(socket.id, session);
    this.auth.events.on("logout", session.logout);
    this.auth.events.on("revoke", session.revoke);
    session.subscribe((url.searchParams.get("sessions") || "").split(",").filter(Boolean));
    const [epoch, since] = (url.searchParams.get("since") || "").split(":"),
      from = Number(since),
      first = this.log[0]?.seq ?? this.seq + 1,
      replay = epoch === this.epoch && Number.isSafeInteger(from) && from >= first - 1 && from <= this.seq;
    if (replay) for (const entry of this.log) if (entry.seq > from) session.deliver(entry);
    const ready = { type: "ready", epoch: this.epoch, seq: this.seq, replayed: replay };
    session.ordered(() => session.send(ready));
  }
  session(socket: Socket, principal: Principal) {
    let tail: Promise<unknown> = Promise.resolve();
    const subscribed = new Set<string>(),
      allowed = new Map<string, { ok: boolean; until: number }>(),
      close = (code = 1000, reason = "连接已关闭") => {
        if (!this.sessions.has(socket.id)) return;
        this.close(socket.id);
        try { socket.close(code, reason); } catch {}
      },
      send = (value: Obj) => {
        if (this.sessions.has(socket.id)) socket.send(value);
      },
      permitted = async (value: Obj) => {
        // Session events dominate (token streams); their permission is stable for a few seconds.
        const key = typeof value.session === "string" && !value.targetUser ? value.session : "";
        const hit = key && allowed.get(key);
        if (hit && hit.until > Date.now()) return hit.ok;
        const ok = await this.allow(principal.user, value);
        if (key) {
          if (allowed.size > 256) allowed.clear();
          allowed.set(key, { ok, until: Date.now() + 5000 });
        }
        return ok;
      },
      // Permission checks may read the database; one chain per socket keeps events in order.
      ordered = (fn: () => unknown) => { tail = tail.then(fn).catch(() => {}); },
      deliver = (entry: Entry) => ordered(async () => {
        if (!this.sessions.has(socket.id)) return;
        const data = STREAM.has(entry.value.type);
        if (data && !subscribed.has(entry.value.session)) return;
        if (!(await permitted(entry.value))) return;
        const buffered = socket.buffered;
        if (buffered > HARD_BUFFER) return close(4408, "网络拥堵，实时连接已重置");
        // A slow link sheds token streams first; message_end/done still arrive and trigger a refresh.
        if (buffered > SOFT_BUFFER && data) return;
        socket.send(entry.value, data ? { data: true, key: entry.value.session } : undefined);
      }),
      subscribe = (ids: unknown) => {
        subscribed.clear();
        if (Array.isArray(ids))
          for (const id of ids.slice(0, 16))
            if (typeof id === "string" && /^[\w-]{1,80}$/.test(id)) subscribed.add(id);
      },
      logout = (hash: string) => {
        if (hash === principal.hash) close(4401, "登录已失效");
      },
      revoke = (userId: string) => {
        if (userId === principal.user.id) close(4401, "账号权限已变化");
      };
    return { close, send, deliver, ordered, subscribe, logout, revoke, principal, subscribed, get buffered() { return socket.buffered; } };
  }
  /** Engine event intake: merge token deltas briefly, keep per-session order, number and fan out. */
  ingest = (raw: Obj) => {
    const value = publicEvent(raw);
    if (!value) return;
    if (DELTAS.has(value.type) && typeof value.data === "string" && value.session) {
      const key = value.session + "\0" + value.type,
        held = this.pending.get(key);
      if (held) held.data += value.data;
      else this.pending.set(key, { ...value });
      this.flushTimer ??= setTimeout(() => this.flush(), this.options.coalesceMs);
      return;
    }
    if (value.session) this.flush(value.session);
    this.publish(value);
  };
  flush(session?: string) {
    for (const [key, value] of this.pending) {
      if (session && value.session !== session) continue;
      this.pending.delete(key);
      this.publish(value);
    }
    if (!this.pending.size && this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
  private publish(value: Obj) {
    const seq = ++this.seq,
      entry: Entry = { seq, at: Date.now(), value: { ...value, seq } };
    this.log.push(entry);
    const horizon = Date.now() - this.options.replayMs;
    let drop = 0;
    while (drop < this.log.length && (this.log.length - drop > this.options.replayEvents || this.log[drop].at < horizon)) drop++;
    if (drop) this.log.splice(0, drop);
    for (const session of [...this.sessions.values()]) session.deliver(entry);
  }
  /** Re-check logins, drop peers that stopped reading, and give every page a cursor when nothing it may see happened. */
  async beat() {
    for (const session of [...this.sessions.values()]) {
      if (!await this.auth.resolveHash(session.principal.hash)) {
        session.close(4401, "登录已失效");
        continue;
      }
      if (session.buffered > HARD_BUFFER) {
        session.close(4408, "网络拥堵，实时连接已重置");
        continue;
      }
      session.send({ type: "heartbeat", epoch: this.epoch, seq: this.seq });
    }
  }
  close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.auth.events.off("logout", session.logout);
    this.auth.events.off("revoke", session.revoke);
  }
  closeAll() {
    clearInterval(this.heartbeat);
    this.flush();
    this.engine.events.off("event", this.ingest);
    this.tickets.clear();
    for (const session of [...this.sessions.values()]) session.close(1001, "服务停止");
  }
}
