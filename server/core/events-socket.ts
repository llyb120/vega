import { randomUUID } from "node:crypto";
import type { Peer } from "crossws";
import type { Auth, Principal } from "./auth";
import type { Engine } from "./engine";
import { eventAllowed } from "./http-auth";
import { assert, type Obj } from "./util";

type Socket = Pick<Peer, "id" | "send" | "close" | "request">;
type Dispatch = (
  method: string,
  path: string,
  body: string | undefined,
  signal: AbortSignal,
  csrf: string,
) => Promise<Response>;
type Pending = AbortController;
type Ticket = { hash: string; csrf: string; until: number };
export const WS_BODY_LIMIT = 240 * 1024;
const HTTP_FALLBACK_LIMIT = 256 * 1024;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

async function smallBody(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) return null;
  if (!response.body) return "";
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// HTTP remains the compatibility and large-payload boundary. A request is
// dispatched once; reconnecting never replays a mutation.
export class EventsSocket {
  sessions = new Map<string, ReturnType<EventsSocket["session"]>>();
  tickets = new Map<string, Ticket>();
  constructor(
    public engine: Pick<Engine, "events">,
    public auth: Auth,
    public allow: typeof eventAllowed = eventAllowed,
  ) {}
  ticket(principal: Principal) {
    assert(this.auth.resolveHash(principal.hash), "登录已失效");
    for (const [id, ticket] of this.tickets)
      if (ticket.until < Date.now()) this.tickets.delete(id);
    assert(this.tickets.size < 64, "实时连接票据过多");
    const id = randomUUID() + randomUUID();
    this.tickets.set(id, {
      hash: principal.hash,
      csrf: principal.csrf,
      until: Date.now() + 15000,
    });
    return { ticket: id };
  }
  authorize(request: Socket["request"], consume = false) {
    const url = new URL(request.url),
      origin = process.env.VEGA_PUBLIC_URL
        ? new URL(process.env.VEGA_PUBLIC_URL).origin
        : url.origin;
    assert(
      request.headers.get("origin") === origin &&
        !["cross-site", "same-site"].includes(
          request.headers.get("sec-fetch-site") || "",
        ),
      "不允许跨站连接",
    );
    const token = (request.headers.get("cookie") || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("vega_session="))
      ?.slice("vega_session=".length);
    const principal = this.auth.authenticate(token),
      id = url.searchParams.get("ticket") || "",
      ticket = this.tickets.get(id);
    assert(principal && ticket?.hash === principal.hash, "连接票据已失效");
    assert(ticket.until >= Date.now(), "连接票据已过期");
    if (consume) this.tickets.delete(id);
    return { principal, csrf: ticket.csrf };
  }
  open(socket: Socket) {
    const { principal, csrf } = this.authorize(socket.request, true);
    assert(this.sessions.size < 64, "实时连接过多");
    const session = this.session(socket, principal, csrf);
    this.sessions.set(socket.id, session);
    this.engine.events.on("event", session.event);
    this.auth.events.on("logout", session.logout);
    this.auth.events.on("revoke", session.revoke);
    socket.send(JSON.stringify({ type: "ready" }));
  }
  session(socket: Socket, principal: Principal, csrf: string) {
    const pending = new Map<string, Pending>(),
      completed = new Set<string>(),
      close = (code = 1000, reason = "连接已关闭") => {
        if (!this.sessions.has(socket.id)) return;
        this.close(socket.id);
        socket.close(code, reason);
      },
      send = (value: Obj) => {
        if (this.sessions.has(socket.id)) socket.send(JSON.stringify(value));
      },
      event = (value: Obj) => {
        const current = this.auth.resolveHash(principal.hash);
        if (!current) return close(4401, "登录已失效");
        if (this.allow(current.user, value)) send(value);
      },
      logout = (hash: string) => {
        if (hash === principal.hash) close(4401, "登录已失效");
      },
      revoke = (userId: string) => {
        if (userId === principal.user.id) close(4401, "账号权限已变化");
      };
    return { pending, completed, close, send, event, logout, revoke, principal, csrf };
  }
  message(socket: Socket, raw: string, dispatch: Dispatch) {
    const session = this.sessions.get(socket.id);
    if (!session) return;
    try {
      assert(Buffer.byteLength(raw) <= WS_BODY_LIMIT + 4096, "请求过大");
      const value = JSON.parse(raw);
      if (value?.type === "ping") return session.send({ type: "pong" });
      assert(value?.type === "request", "消息无效");
      const id = value.id;
      assert(
        typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id),
        "请求ID无效",
      );
      assert(
        !session.pending.has(id) && !session.completed.has(id),
        "请求ID重复",
      );
      const method = value.method || "GET",
        path = value.path;
      assert(METHODS.includes(method), "请求方法无效");
      assert(
        typeof path === "string" &&
          path.startsWith("/") &&
          !path.startsWith("//") &&
          path.length <= 8192 &&
          !path.includes("..") &&
          !/^\/(auth|blobs|events)(\/|$)/.test(path) &&
          path !== "/chrome/live",
        "该接口不能使用实时通道",
      );
      const body =
          value.data === undefined ? undefined : JSON.stringify(value.data),
        controller = new AbortController();
      assert(!body || Buffer.byteLength(body) <= WS_BODY_LIMIT, "请求过大");
      assert(session.pending.size < 32, "等待中的请求过多");
      session.pending.set(id, controller);
      void this.dispatch(
        session,
        id,
        method,
        path,
        body,
        controller,
        dispatch,
      ).finally(() => {
        session.pending.delete(id);
        session.completed.add(id);
        if (session.completed.size > 1024)
          session.completed.delete(session.completed.values().next().value!);
      });
    } catch (e: any) {
      session.send({ type: "error", reason: e.message });
    }
  }
  async dispatch(
    session: ReturnType<EventsSocket["session"]>,
    id: string,
    method: string,
    path: string,
    body: string | undefined,
    task: Pending,
    dispatch: Dispatch,
  ) {
    try {
      const response = await dispatch(method, path, body, task.signal, session.csrf),
        text = await smallBody(
          response,
          method === "GET" ? HTTP_FALLBACK_LIMIT : 4 * 1024 * 1024,
        );
      if (text === null && method === "GET") {
        session.send({ type: "response", id, httpFallback: true });
        return;
      }
      assert(text !== null, "响应过大，操作结果可能已完成，请核对后再操作");
      session.send({
        type: "response",
        id,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type") || "",
        body: text,
      });
    } catch (e: any) {
      session.send({
        type: "response",
        id,
        status: 0,
        error: task.signal.aborted
          ? "连接中断，操作结果可能已提交，请核对后再操作"
          : e.message,
      });
    }
  }
  close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.engine.events.off("event", session.event);
    this.auth.events.off("logout", session.logout);
    this.auth.events.off("revoke", session.revoke);
    for (const task of session.pending.values()) task.abort();
  }
  closeAll() {
    this.tickets.clear();
    for (const session of [...this.sessions.values()])
      session.close(1001, "服务停止");
  }
}
