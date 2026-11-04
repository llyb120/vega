import {
  getCookie,
  getHeader,
  setCookie,
  deleteCookie,
  createError,
  type H3Event,
} from "h3";
import { app, authenticated } from "./application";
import { AuthError, check, equal, type Principal, type User } from "./auth";
export const COOKIE = "vega_session";
export function publicOrigin(event: H3Event) {
  const configured = process.env.VEGA_PUBLIC_URL;
  if (configured) {
    const url = new URL(configured);
    check(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash,
      500,
      "VEGA_PUBLIC_URL must be an HTTP(S) origin",
    );
    return url.origin;
  }
  const host = getHeader(event, "host");
  check(host && !/[\\/\s]/.test(host), 400, "Valid Host header required");
  return new URL(
    ((event.node.req.socket as any).encrypted ? "https://" : "http://") + host,
  ).origin;
}
export function sameOrigin(event: H3Event) {
  const origin = getHeader(event, "origin");
  if (origin)
    check(
      origin === publicOrigin(event),
      403,
      "Cross-origin API access denied",
    );
  check(
    !["cross-site", "same-site"].includes(
      getHeader(event, "sec-fetch-site") || "",
    ),
    403,
    "Cross-site API access denied",
  );
}
export function principal(event: H3Event) {
  return event.context.principal as Principal;
}
function cookieOptions(event: H3Event) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: publicOrigin(event).startsWith("https:"),
    path: "/",
  };
}
export function setLogin(event: H3Event, token: string, expiresAt: number) {
  setCookie(event, COOKIE, token, {
    ...cookieOptions(event),
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}
export function clearLogin(event: H3Event) {
  deleteCookie(event, COOKIE, cookieOptions(event));
}
export async function gate(event: H3Event, path: string) {
  const { auth, token } = app();
  // OAuth returns cross-site without a website cookie; callback validates its one-time state.
  if (path === "/api/providers/callback/devin" && event.method === "GET")
    return;
  if (path === "/api/local-agent/verify" && event.method === "POST") return;
  if (path === "/api/local-agent/socket" && event.method === "GET") return;
  sameOrigin(event);
  if (path === "/api/health") {
    check(
      event.method === "GET" &&
        authenticated(
          (getHeader(event, "authorization") || "").replace(/^Bearer /, ""),
          token,
        ),
      401,
      "Health token required",
    );
    return;
  }
  if (path === "/api/auth/me" && event.method === "GET") return;
  if (
    ["/api/auth/login", "/api/auth/setup"].includes(path) &&
    event.method === "POST"
  )
    return;
  const session = await auth.authenticate(getCookie(event, COOKIE));
  check(session, 401, "Please sign in");
  event.context.principal = session;
  if (!["GET", "HEAD", "OPTIONS"].includes(event.method))
    check(
      equal(getHeader(event, "x-csrf-token") || "", session.csrf),
      403,
      "Invalid CSRF token; reload and sign in again",
    );
  if (path.startsWith("/api/auth/")) return;
  if (/^\/api\/local-agent\/(ticket|revoke)$/.test(path) && event.method === "POST") return;
  const role = session.user.role;
  if (role === "admin") return;
  if (/^\/api\/employees(?:\/|$)/.test(path) && (role === "operator" || event.method === "GET")) return;
  if (
    (path === "/api/bootstrap" && event.method === "GET") ||
    (path === "/api/events" && ["GET", "POST"].includes(event.method))
  )
    return;
  if (/^\/api\/blobs\/[^/]+$/.test(path) && event.method === "GET") return;
  if (/^\/api\/sessions\//.test(path) && event.method === "GET") return;
  if (
    role === "operator" &&
    ((path === "/api/sessions" && event.method === "POST") ||
      (/^\/api\/sessions\//.test(path) &&
        ["POST", "DELETE"].includes(event.method)))
  )
    return;
  if (
    role === "operator" &&
    path === "/api/providers/models" &&
    event.method === "GET"
  )
    return;
  throw new AuthError(403, "Administrator permission required");
}
export async function eventAllowed(user: User, value: any) {
  if (value.targetUser) return value.targetUser === user.id;
  const { auth } = app();
  if (value.session) {
    try {
      return await auth.canRead(user, await app().store.session(value.session));
    } catch {
      return false;
    }
  }
  if (value.data?.employeeId) {
    if (value.data.deleted) return user.role === "admin" || value.data.scope === "team" || value.data.ownerId === user.id;
    try { return await (await app().engine.employee.for(value.data.employeeId)).accessible(user); }
    catch { return false; }
  }
  if (value.type === "fire") {
    try {
      return await auth.canRead(user, await app().store.session(value.data.root));
    } catch {
      return false;
    }
  }
  if (value.data?.fireRoot) {
    try {
      return await auth.canRead(user, await app().store.session(value.data.fireRoot));
    } catch {
      return false;
    }
  }
  return user.role === "admin" || value.type === "config_changed";
}
export function httpError(error: any): never {
  if (error.statusCode)
    throw createError({
      statusCode: error.statusCode,
      statusMessage: error.message || error.statusMessage,
    });
  throw createError({ statusCode: 400, statusMessage: "Invalid request" });
}
