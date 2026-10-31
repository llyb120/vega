import { type H3Event, getCookie } from "h3";
import { app } from "./application";
import { check, type Principal } from "./auth";
import {
  COOKIE,
  setLogin,
  clearLogin,
  principal,
  httpError,
} from "./http-auth";
export async function bodyJSON(event: H3Event, max: number) {
  const length = Number(event.node.req.headers["content-length"] || 0);
  check(!length || length <= max, 413, "Request body too large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of event.node.req) {
    bytes += c.length;
    check(bytes <= max, 413, "Request body too large");
    chunks.push(Buffer.from(c));
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    check(false, 400, "Invalid JSON");
  }
  check(
    data && typeof data === "object" && !Array.isArray(data),
    400,
    "JSON object required",
  );
  return data as Record<string, any>;
}
const client = (event: H3Event) =>
  event.node.req.socket.remoteAddress || "unknown";
const publicSession = (p: Principal) => ({
  user: p.user,
  csrfToken: p.csrf,
  expiresAt: p.expiresAt,
  setupRequired: false,
});
export async function authRoute(event: H3Event, path: string[]) {
  const { auth } = app();
  try {
    if (path[0] === "auth") {
      const action = path[1],
        method = event.method;
      if (action === "me" && method === "GET") {
        const p = auth.authenticate(getCookie(event, COOKIE));
        return p
          ? publicSession(p)
          : { user: null, csrfToken: null, setupRequired: !auth.hasUsers() };
      }
      if (["setup", "login"].includes(action) && method === "POST") {
        const a = await bodyJSON(event, 4096);
        const result =
          action === "setup"
            ? await auth.setup(a, client(event))
            : await auth.login(a, client(event));
        setLogin(event, result.token, result.principal.expiresAt);
        return publicSession(result.principal);
      }
      const p = principal(event);
      if (action === "logout" && method === "POST") {
        auth.logout(p.hash);
        clearLogin(event);
        return { ok: true };
      }
      if (action === "password" && method === "POST") {
        const a = await bodyJSON(event, 4096);
        await auth.changePassword(p.user.id, a.currentPassword, a.newPassword);
        clearLogin(event);
        return { ok: true, signInAgain: true };
      }
      check(false, 404, "Authentication route not found");
    }
    const p = principal(event);
    check(p.user.role === "admin", 403, "Administrator permission required");
    if (event.method === "GET" && path.length === 1)
      return { users: auth.users() };
    if (event.method === "POST" && path.length === 1)
      return { user: await auth.add(await bodyJSON(event, 4096)) };
    if (event.method === "PUT" && path.length === 2)
      return { user: await auth.update(path[1], await bodyJSON(event, 4096)) };
    check(false, 404, "User management route not found");
  } catch (error) {
    httpError(error);
  }
}
