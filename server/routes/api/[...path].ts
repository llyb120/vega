import { updateEmployeeAvatar, updateUserAvatar } from "../../core/employee-avatar";
import { employeeMoodWeather } from "../../core/soul";
import { userExperienceGraph } from "../../core/experience-access";
import { chatHistory, withoutStepOutputs } from "../../core/chat-page";
import { canConfigureEmployee, employeeCapabilities } from "../../core/employee-capabilities";
import { getWorkPrinciples, setWorkPrinciples } from "../../core/work-principles";
import {
  browserTabs,
  browserScreenshot,
  browserControl,
} from "../../core/browser-preview";
import { externalMcpApi } from "../../core/external-mcp";
import { triggersApi } from "../../core/triggers";
import { publicOrigin, publicSiteURL, principal } from "../../core/http-auth";
import { authRoute, bodyJSON } from "../../core/http-auth-routes";
import { AuthError, check } from "../../core/auth";
import { sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  defineEventHandler,
  getRequestURL,
  getRequestHeaders,
  readBody,
  createError,
  setHeader,
  send,
} from "h3";
import { app, employeeLive } from "../../core/application";
import { ended } from "../../core/employee";
import { ATTACHMENT_BYTES, safeFileName, storeAttachments } from "../../core/attachments";
import { cloudFor, cloudEnabled, cloudHealthy } from "../../core/cloud";
import { newCommand } from "../../core/new-session";
import { clientBaseName, clientPackage } from "../../core/client-package";
import { CLIENT_BODY_LIMIT } from "../../core/client-socket";
import { installBrowserExtension } from "../../core/local-extension";
import { assert, filterAsync, object, type Obj } from "../../core/util";
import { parseStage, Context } from "../../core/context";
import { maskedConfig, mergeSecrets, modelEntries } from "../../core/config";
import type { Session } from "../../core/store";
import type { ChatTaskRef } from "../../../shared/chat-quote";
import presets from "../../../shared/provider-presets.json";
async function inputMessage(
  a: Obj,
  store: ReturnType<typeof app>["store"],
  sessionId: string,
) {
  assert(typeof a.text === "string" || Array.isArray(a.images) || Array.isArray(a.files), "Message required");
  assert((a.text || "").trim() || a.images?.length || a.files?.length, "Empty message");
  assert((a.text || "").length <= 2 << 20, "Message too large");
  const quote = a.quoteSeq === undefined ? undefined : await store.quote(sessionId, a.quoteSeq);
  const { images, files } = await storeAttachments(store, sessionId, a);
  return { role: "user" as const, text: a.text || "", images, files: files.length ? files : undefined, quote };
}
async function sessionRecord(engine: ReturnType<typeof app>["engine"], session: Session, query: URLSearchParams, canWrite: boolean) {
  const store = engine.store, key = session.id;
  const history = await chatHistory(store, key, query);
  const parentId = session.spawnParent || session.phaseParent || (session.agentChild || session.phaseRole ? session.stageSource : undefined);
  const parent = parentId && parentId !== key ? await store.session(parentId).catch(() => undefined) : undefined;
  const siblings = await store.sessionsByStageSource(parentId || key);
  const agentSessions = siblings.filter((item) => item.agentChild || item.phaseRole).map((item) => ({
    id: item.id,
    title: item.title,
    agentName: item.agentName,
    phaseRole: item.phaseRole,
    phaseSeq: item.phaseSeq,
    status: engine.active.has(item.id) ? "running" : "idle",
    running: engine.active.has(item.id),
    updated: item.createdAt,
  }));
  // Full session export (unpaginated): include isolated child phase transcripts alongside the coordinator transcript.
  const fullExport = !query.has("limit") && !query.has("before") && !query.has("after");
  const childPhases = fullExport && !session.phaseRole ? siblings.filter((item) => item.phaseRole) : [];
  const phaseTranscripts = childPhases.length
    ? Object.fromEntries(await Promise.all(childPhases.map(async (item) => [item.id, await store.messages(item.id)])))
    : undefined;
  return {
    session,
    parentSession: parent ? { id: parent.id, title: parent.title || "主会话", status: engine.active.has(parent.id) ? "running" : "idle" } : undefined,
    agentSessions,
    ...(phaseTranscripts ? { phaseTranscripts } : {}),
    canWrite,
    ...history,
    folds: (await store.all("SELECT data FROM folds WHERE session=?", key)).map((r) => JSON.parse(r.data)),
    fire: await engine.fire.forSession(key),
    running: engine.active.has(key),
    // Incremental refreshes (`after`) get the budget from context_budget events instead.
    ...(query.has("after") && query.get("context") !== "1"
      ? {}
      : { context: await (await Context.open(store, key, (await engine.config()).contextMode === "acp" ? "acp" : "auto")).status() }),
  };
}
export default defineEventHandler(async (event) => {
  const { store, engine, auth } = app(),
    method = event.method,
    path = getRequestURL(event)
      .pathname.replace(/^\/api\/?/, "")
      .split("/")
      .filter(Boolean);
  if (path[0] === "health")
    return cloudEnabled() ? { connected: false, ready: await cloudHealthy() === true, isolated: true } : { connected: engine.chrome.bridge.status().connected, ready: true };
  if (["auth", "users"].includes(path[0])) return authRoute(event, path);
  // 客户端安装包仅固定站点，首次启动时由用户在站点授权设备。
  if (path[0] === "clients" && path.length === 2) {
    check(method === "GET", 405, "GET required");
    const file = clientBaseName(path[1]), body = await clientPackage(file, publicSiteURL(event));
    setHeader(event, "Content-Type", "application/zip");
    setHeader(event, "Content-Disposition", `attachment; filename="${file}.zip"`);
    setHeader(event, "Cache-Control", "no-store");
    return send(event, body);
  }
  if (path[0] === "local-agent" && path[1] === "device" && ["start", "token"].includes(path[2]) && path.length === 3 && method === "POST") {
    check(!getRequestHeaders(event).origin && !getRequestURL(event).search, 403, "Native client request required");
    const body = await bodyJSON(event, 4096);
    setHeader(event, "Cache-Control", "no-store");
    try {
      return path[2] === "start" ? app().clientSockets.deviceStart(body, event.node.req.socket.remoteAddress || "unknown") : await app().clientSockets.deviceToken(body);
    } catch { throw createError({ statusCode: 401, statusMessage: "Device authorization invalid or expired" }); }
  }
  if (path[0] === "local-agent" && path[1] === "verify" && method === "POST") {
    const body = await bodyJSON(event, 4096);
    setHeader(event, "Cache-Control", "no-store");
    try {
      return body.clientId ? await app().clientSockets.pair(body) : await engine.localAgents.verify(body.ticket, auth);
    }
    catch { throw createError({ statusCode: 401, statusMessage: "Local agent ticket invalid or expired" }); }
  }
  if (path[0] === "local-agent" && path[1] === "result" && method === "POST") {
    setHeader(event, "Cache-Control", "no-store");
    // Only headers and URL are needed; reading the body stays with bodyJSON.
    const request = { headers: new Headers(getRequestHeaders(event) as Record<string, string>), url: getRequestURL(event).href } as unknown as Request;
    try { await app().clientSockets.authorize(request); }
    catch { throw createError({ statusCode: 403, statusMessage: "Client credential invalid or revoked" }); }
    const body = await bodyJSON(event, CLIENT_BODY_LIMIT);
    try { return await app().clientSockets.upload(request, body); }
    catch (e: any) { throw createError({ statusCode: 409, statusMessage: e.message }); }
  }
  if (path[0] === "local-agent" && path[1] === "chat" && method === "POST") {
    // 桌面客户端自验设备凭据，不使用网站 cookie 或请求体提供的设备 ID。
    setHeader(event, "Cache-Control", "no-store");
    const request = { headers: new Headers(getRequestHeaders(event) as Record<string, string>), url: getRequestURL(event).href } as unknown as Request;
    let grant: { userId: string; clientId: string };
    try { grant = await app().clientSockets.authorize(request); }
    catch { throw createError({ statusCode: 403, statusMessage: "Client credential invalid or revoked" }); }
    const body = await bodyJSON(event, 1 << 20);
    try { return await clientChat(path[2], body, grant.userId, grant.clientId); }
    catch (e: any) { throw createError({ statusCode: e.statusCode || 400, statusMessage: String(e.message || e).slice(0, 500) }); }
  }
  if (path[0] === "local-agent" && path[1] === "extension" && method === "POST") {
    // 本机客户端「更新浏览器扩展」：设备凭据自己验，然后把安装任务交给这个账号名下的第一位热心市民。
    setHeader(event, "Cache-Control", "no-store");
    const request = { headers: new Headers(getRequestHeaders(event) as Record<string, string>), url: getRequestURL(event).href } as unknown as Request;
    let grant: { userId: string; clientId: string };
    try { grant = await app().clientSockets.authorize(request); }
    catch { throw createError({ statusCode: 403, statusMessage: "Client credential invalid or revoked" }); }
    const body = await bodyJSON(event, 4096);
    try { return await installBrowserExtension({ auth, engine }, grant, body); }
    catch (e: any) { throw createError({ statusCode: e.statusCode || 409, statusMessage: String(e.message || e).slice(0, 500) }); }
  }
  const who = principal(event),
    user = who.user;
  const principlesRoute = path[0] === "me" && path[1] === "work-principles" && path.length === 2;
  let a: Obj = {};
  if (["POST", "PUT", "PATCH"].includes(method))
    a = await bodyJSON(event, principlesRoute ? 1 << 16 : 90 << 20);
  if (path[0] === "local-agent") {
    setHeader(event, "Cache-Control", "no-store");
    if (path[1] === "device" && path.length === 3) {
      try {
        if (path[2] === "request" && method === "GET") return app().clientSockets.deviceInfo(getRequestURL(event).searchParams.get("requestId"));
        if (path[2] === "decision" && method === "POST") return await app().clientSockets.deviceDecision(who, a);
      } catch (e: any) { throw createError({ statusCode: 400, statusMessage: String(e.message || e).slice(0, 300) }); }
    }
    check(method === "POST", 405, "POST required");
    if (path[1] === "ticket") return engine.localAgents.ticket(who, a.instance);
    if (path[1] === "revoke") {
      check(typeof a.clientId === "string" && /^[a-f0-9]{32}$/.test(a.clientId), 400, "clientId required");
      await app().clientSockets.revoke(user.id, a.clientId);
      return { ok: true };
    }
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  try {
    if (["config", "providers", "skills", "employee"].includes(path[0]))
      check(user.role === "admin", 403, "Administrator permission required");
    if (path[0] === "debug") {
      check(user.role === "admin", 403, "Administrator permission required");
      check(method === "GET" && path[1] === "sessions" && (path.length === 2 || path.length === 3), 404, "Debug route not found");
      setHeader(event, "Cache-Control", "no-store");
      if (path.length === 3) {
        const session = await store.session(path[2]).catch(() => undefined);
        check(session, 404, "Debug session not found");
        const narrator = session.groupId && !session.employeeId && !session.taskId
          ? (await engine.groups.get(session.groupId))?.narrator?.session : undefined;
        check(session.employeeId || session.taskId || narrator === session.id, 404, "Debug session not found");
        return await sessionRecord(engine, session, getRequestURL(event).searchParams, false);
      }
      const [employees, users, groups, sessions] = await Promise.all([engine.employee.all(), auth.users(), engine.groups.all(), store.employeeSessions()]);
      const profiles = new Map(await Promise.all(employees.map(async (employee) => {
        const { id, name, ownerId } = await employee.profile();
        return [id, { name, ownerId }] as const;
      })));
      const usernames = new Map(users.map(({ id, username }) => [id, username]));
      const owner = (ownerId = "") => ({ ownerId, ownerName: usernames.get(ownerId) || ownerId });
      // Each group's 旁白 session too (it belongs to no employee).
      const narrators = groups.filter((g) => g.narrator?.session).map((g) => [g.narrator!.session, g.name] as const);
      const narratorSessions = (await Promise.all(narrators.map(async ([id, name]) => {
        if (!await store.hasSession(id)) return;
        const session = await store.session(id);
        return { ...session, ...owner(session.ownerId), employeeId: "", employeeName: "旁白 · " + name, taskText: "", kind: "narrator", running: false };
      }))).filter(Boolean);
      return [...narratorSessions, ...await Promise.all(sessions.filter((session) => !session.phaseRole).map(async (session) => {
        const linked = session.taskId ? await store.employeeTask(session.taskId) : undefined;
        const employeeId = session.employeeId || linked?.employee || "";
        const profile = profiles.get(employeeId);
        return { ...session, ...owner(profile?.ownerId || session.ownerId), employeeId, employeeName: profile?.name || "未关联热心市民", taskText: linked?.task.text || "", kind: !session.taskId ? (session.groupId ? "group" : "chat") : linked?.task.computerSession === session.id || session.scene === "computer" ? "computer" : "work", running: engine.active.has(session.id), taskStatus: linked?.task.status };
      }))];
    }
    if (path[0] === "bootstrap" && method === "GET") {
      // 首次进入时自动创建一位热心市民；失败不阻断登录，下次再试。
      if (user.role !== "viewer")
        await engine.employee.ensureOwned(user.id, user.username).catch((error) => console.warn("[Vega] 自动创建热心市民失败：" + error.message));
      let cwd = "", cloudError = "";
      if (user.role !== "viewer") {
        try { cwd = await cloudFor({ ownerId: user.id })?.cwd() || process.cwd(); }
        catch (error: any) { cloudError = "云端工作区初始化失败，云端执行已禁止：" + String(error.message); }
      }
      return {
        user,
        // Admins also see unowned conversations; everyone else only their own (indexed by owner).
        sessions: await filterAsync(user.role === "admin" ? await store.plainSessions() : await store.sessionsBy("owner", user.id),
          async (s) => !s.taskId && !s.employeeId && !s.groupId && await auth.canRead(user, s)),
        running: Object.fromEntries(
          (await filterAsync([...engine.active.keys()], async (key) => {
            try {
              const session = await store.session(key);
              return !session.taskId && await auth.canRead(user, session);
            } catch {
              return false;
            }
          })).map((id) => [id, true]),
        ),
        avatar: (await store.object<{ avatar: string }>("user-avatar", user.id))?.avatar || "",
        config:
          user.role === "admin"
            ? maskedConfig(await engine.config())
            : { model: (await engine.config()).model, provider: {} },
        cloudIsolated: cloudEnabled(),
        cwd,
        ...(cloudError ? { cloudError } : {}),
        clients: engine.localAgents.list(user.id),
        runtime: await engine.clientsView(user.id),
        stack: {
          frontend: "Vue 3.6 Vapor",
          backend: "Nitro",
          storage: "SQLite",
        },
      };
    }
    if (path[0] === "files" && method === "GET") {
      const file = store.files.fromUrl(path.slice(1)), parts = file.slice(store.files.root.length + 1).split(sep), mime = store.files.mime(file);
      check(mime && await auth.canFile(user, parts), 404, "File not found");
      let data: Buffer;
      try { data = await store.files.read(file); } catch { throw new AuthError(404, "File not found"); }
      setHeader(event, "Content-Type", mime!);
      setHeader(event, "Cache-Control", "private, max-age=31536000, immutable");
      return send(event, data);
    }
    if (path[0] === "blobs" && method === "GET") {
      check(await auth.canBlob(user, path[1]), 404, "Blob not found");
      const blob = await store.blobData(path[1]);
      assert(blob, "Blob not found");
      setHeader(event, "X-Content-Type-Options", "nosniff");
      // Only known image types render inline; any other attachment is a download, never same-origin HTML or script.
      if (/^image\/[\w.+-]+$/.test(blob.mime) && !blob.mime.startsWith("image/svg")) setHeader(event, "Content-Type", blob.mime);
      else {
        setHeader(event, "Content-Type", "application/octet-stream");
        setHeader(event, "Content-Disposition", `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(safeFileName(getRequestURL(event).searchParams.get("name")))}`);
      }
      return send(event, Buffer.from(blob.data));
    }
    if (path[0] === "employees") {
      if (path.length === 1) {
        if (method === "GET") return Promise.all((await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user))).map(async (employee) => {
          const s = await employee.state();
          return { id: s.id, name: s.name, avatar: s.avatar || "", instruction: s.instruction, ownerId: s.ownerId, mine: s.ownerId === user.id, chatSession: s.chatSession || "", unread: s.chatSession ? await store.unread(user.id, s.chatSession) : 0, canManage: await employee.manageable(user), activeTasks: s.tasks.filter((t) => !ended(t.status)).length, runningTasks: s.tasks.filter((t) => t.status === "running").length, attentionTasks: s.tasks.filter((task) => ["waiting", "approval"].includes(task.status)).length };
        }));
        if (method === "POST") {
          check(user.role !== "viewer", 403, "Execution permission required");
          return await engine.employee.create(a, user.id);
        }
      }
      const employee = (await engine.employee.all()).find((employee) => employee.employeeId === path[1]);
      // Group members see each other's employee avatars.
      const avatarOnly = path[2] === "avatar" && path.length === 3 && method === "GET" && !!employee && await engine.groups.sharesGroup(user.id, { employee: employee.employeeId });
      check(employee && (avatarOnly || await employee.accessible(user)), 404, "Employee not found");
      check(!employee.deleting, 409, "正在删除这位热心市民，请稍候");
      const state = await employee.state();
      // Marking the chat read is reading: read-only accounts may do it.
      if (path[2] === "chat" && path[3] === "read" && path.length === 4 && method === "POST") return { seq: state.chatSession ? await store.markRead(user.id, state.chatSession) : 0 };
      if (method !== "GET") check(user.role !== "viewer", 403, "只读账号不能执行操作");
      if (["capabilities", "skills", "mcp"].includes(path[2]))
        return await employeeCapabilities(employee, user, method, path.slice(2), a);
      if (path[2] === "avatar") {
        if (method === "GET") {
          check(/^blob-[a-f\d]{32}$/.test(state.avatar || ""), 404, "Avatar not found");
          const image = await store.blobData(state.avatar!);
          check(image && image.mime === "image/webp", 404, "Avatar not found");
          setHeader(event, "Content-Type", "image/webp");
          setHeader(event, "Cache-Control", "private, max-age=86400");
          return send(event, Buffer.from(image.data));
        }
        if (method === "POST") {
          check(await employee.manageable(user), 403, "只有热心市民的管理者可以修改头像");
          return await updateEmployeeAvatar(employee, a);
        }
        check(false, 405, "Method not allowed");
      }
      // 任务执行权：同一个任务同一时刻只在一个位置跑，交接是唯一改变它的方式。
      if (path[2] === "tasks" && path[4] === "handoff" && method === "POST") {
        check(await employee.manageable(user), 403, "只有热心市民的管理者可以交接执行权");
        const taskId = String(path[3] || "");
        if (a.action === "status") return engine.handoffs.status(employee.employeeId, taskId);
        if (a.action === "to-cloud") return engine.handoffs.toCloud(employee.employeeId, taskId, { source: "manual" });
        if (a.action === "to-local") return engine.handoffs.toLocal(employee.employeeId, taskId, { clientId: a.clientId });
        check(false, 400, "action 是 to-cloud、to-local 或 status");
      }
      if (path[2] === "handoff" && path.length === 3 && method === "POST") {
        check(await employee.manageable(user), 403, "只有热心市民的管理者可以配置接力");
        return engine.handoffs.configure(employee.employeeId, a);
      }
      if (path.length === 2 && method === "DELETE") {
        check(await employee.manageable(user), 403, "只有管理者可以删除这位热心市民");
        check(getRequestURL(event).searchParams.get("confirmed") === "true", 400, "请确认删除这位热心市民，以及相关任务、会话和浏览器登录数据");
        check(!employee.busy.size && !(state.chatSession && engine.active.has(state.chatSession)), 409, "请先停止这位热心市民的任务和当前对话，再删除");
        await engine.removeEmployee(employee.employeeId, async () => {
          // Shared owner browser stays; only drop a live keyed by this employee if any legacy entry exists.
          const live = app().employeeLives.get(employee.employeeId);
          if (live) { await live.close(); app().employeeLives.delete(employee.employeeId); }
        });
        return { ok: true };
      }
      if (path[2] === "reset" && path.length === 3 && method === "POST") {
        check(await employee.manageable(user), 403, "只有管理者可以重置这位热心市民");
        check(getRequestURL(event).searchParams.get("confirmed") === "true", 400, "请确认清空这位热心市民的全部会话和任务");
        return await engine.resetEmployee(employee.employeeId);
      }
      if (path[2] === "chat" && path[3] === "clear" && method === "POST") {
        check(await employee.manageable(user), 403, "只有热心市民的管理者可以清空聊天记录");
        check(getRequestURL(event).searchParams.get("confirmed") === "true", 400, "请确认清空这位热心市民的聊天记录");
        check(!(state.chatSession && engine.active.has(state.chatSession)), 409, "对话仍在进行，请先停止后再清空聊天记录");
        return await engine.clearEmployeeChat(employee.employeeId);
      }
      if (path[2] === "chat" && method === "GET") {
        const session = await employee.chat(user.id);
        const moodWeather = await employeeMoodWeather(store, employee.employeeId, state.ownerId, user.id).catch(() => undefined);
        return { session, ...await chatHistory(store, session.id, getRequestURL(event).searchParams), running: engine.active.has(session.id), ...(moodWeather ? { moodWeather } : {}) };
      }
      if (path[2] === "messages" && method === "POST") {
        check(a.clientMessageId === undefined || (typeof a.clientMessageId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(a.clientMessageId)), 400, "Invalid message ID");
        const session = await employee.chat(user.id);
        // /new [text]: run as a new independent task while keeping the conversation context.
        const command = newCommand(a.text);
        let newTask = false;
        if (command) {
          check(!employee.deleting && !employee.resetting, 409, "正在删除或重置这位热心市民，请稍候");
          const alone = !command.rest && !a.images?.length && !a.files?.length;
          if (alone) {
            check(!engine.active.has(session.id), 409, "对话仍在进行，请先停止后再标记新任务");
            if (a.clientMessageId && await store.clientMessage(session.id, user.id, a.clientMessageId)) return { id: session.id, newTask: true };
            await engine.markNewTask(session.id, { actorId: user.id, clientMessageId: a.clientMessageId });
            return { id: session.id, newTask: true };
          }
          newTask = true;
          a = { ...a, text: command.rest };
        } else {
          const last = (await store.messagePage(session.id, { limit: 10 })).messages
            .filter((m) => !m.delivery && !m.progress && !m.stepOutput).at(-1);
          if (last?.notice && last?.newTask && (!last.actorId || last.actorId === user.id)) newTask = true;
        }
        let taskRefs: ChatTaskRef[] | undefined;
        if (Array.isArray(a.taskRefs) && a.taskRefs.length) {
          const tasks = (await employee.state({ runs: false })).tasks;
          const byId = new Map(tasks.map((item) => [item.id, item]));
          const seen = new Set<string>();
          const hydrated: ChatTaskRef[] = [];
          for (const item of a.taskRefs) {
            const refId = typeof item === "string" ? item : typeof item?.id === "string" ? item.id : "";
            if (!refId || seen.has(refId)) continue;
            const task = byId.get(refId);
            if (!task) continue;
            seen.add(refId);
            const intent = item?.intent && ["follow_up", "retry", "fork"].includes(item.intent) ? item.intent : undefined;
            hydrated.push({
              id: task.id,
              title: task.title || String(task.text || "").replace(/\s+/g, " ").trim().slice(0, 80),
              status: task.status,
              ...(task.chainId ? { chainId: task.chainId } : {}),
              ...(typeof task.chainSeq === "number" ? { chainSeq: task.chainSeq } : {}),
              employeeId: employee.employeeId,
              ...(intent ? { intent } : {}),
            });
            if (hydrated.length >= 5) break;
          }
          if (hydrated.length) taskRefs = hydrated;
        }
        const message = {
          ...await inputMessage(a, store, session.id), actorId: user.id,
          ...(newTask ? { newTask: true } : {}),
          ...(taskRefs ? { taskRefs } : {}),
          clientMessageId: a.clientMessageId,
          clientMessageHash: a.clientMessageId ? createHash("sha256").update(JSON.stringify([a.text || "", a.images || [], a.files || [], a.quoteSeq ?? null, taskRefs?.map((r) => [r.id, r.intent || ""]) || []])).digest("hex") : undefined,
        };
        check(!employee.deleting && !employee.resetting, 409, "正在删除或重置这位热心市民，请稍候");
        await engine.submitChat(session.id, message);
        return { id: session.id };
      }
      if (path[2] === "cancel" && method === "POST") {
        if (state.chatSession) engine.cancel(state.chatSession);
        return { ok: true };
      }
      if (path[2] === "chrome") {
        check(await employee.manageable(user), 403, "只有热心市民的管理者可以查看和控制浏览器登录环境");
        const profileKey = engine.browserProfileKey(state.ownerId);
        if (method === "POST" && a.operation === "close") {
          check(!employee.busy.size, 409, "Stop browser tasks first");
          const live = app().employeeLives.get(profileKey);
          if (live) { await live.close(); app().employeeLives.delete(profileKey); }
          await engine.browsers.stop(profileKey);
          return { ok: true };
        }
        const browser = await engine.browsers.get(profileKey);
        check(!employee.deleting, 409, "正在删除这位热心市民，请稍候");
        if (path[3] === "tabs" && method === "GET") return browserTabs(browser);
        if (path[3] === "live" && method === "POST") return (await employeeLive(employee.employeeId)).ticket(who, a.tabTag);
        if (path[3] === "screenshot" && method === "POST") return browserScreenshot(browser, "employee-view:" + user.id, a.tabTag);
        if (path[3] === "control" && method === "POST") return browserControl(browser, "employee-view:" + user.id, a);
        if (path[3] === "tool" && method === "POST") return browser.execute("employee-view:" + user.id, state.cwd, a);
        if (path.length === 3) return browser.bridge.status();
        check(false, 404, "Browser route not found");
      }
      if (path[2] === "control" && method === "POST") {
        if (a.action === "settings") check(await employee.manageable(user), 403, "只有热心市民的管理者可以修改设置");
        if (a.action === "fire") check(false, 400, "职责配置已移除");
        return employee.control(a);
      }
      if (path[2] === "transcript" && method === "POST") return await employee.transcript(a.threadId);
      if (path.length === 2 && method === "GET") {
        const { enabled, workStart, workEnd, ...visible } = state;
        const tasks = getRequestURL(event).searchParams.get("stepSummaries") === "1" ? visible.tasks.map(withoutStepOutputs) : visible.tasks;
        return { ...visible, tasks, canManage: await employee.manageable(user), canConfigure: await canConfigureEmployee(employee, user), executionClients: await employee.manageable(user) ? engine.localAgents.list(state.ownerId || user.id) : [], busy: [...employee.busy.keys()], chatRunning: !!state.chatSession && engine.active.has(state.chatSession) };
      }
      if (path.length === 2 && method === "POST") {
        if (!await employee.manageable(user)) check(a.action === "list" || a.action === "memory_search" || (a.action === "add" && a.kind === "todo"), 403, "只有热心市民的管理者可以修改记忆和凭据");
        // Same owner-only rule as the vault page: managing an employee does not open its vault.
        if (typeof a.action === "string" && a.action.startsWith("vault_")) check(await canConfigureEmployee(employee, user), 403, "只有创建者可以使用适用于这位热心市民的密码本条目");
        const result = await employee.execute("", a);
        return result.secret ? JSON.parse(result.secret) : result.value;
      }
      check(false, 404, "Employee route not found");
    }
    if (principlesRoute) {
      setHeader(event, "Cache-Control", "no-store");
      if (method === "GET") return { workPrinciples: await getWorkPrinciples(store, user.id) };
      check(method === "PUT", 405, "GET or PUT required");
      return { workPrinciples: await setWorkPrinciples(store, user.id, a.workPrinciples) };
    }
    if (path[0] === "me" && path[1] === "external-mcp")
      return await externalMcpApi(engine, user, method, path.slice(2), a, publicOrigin(event));
    if (path[0] === "me" && path[1] === "triggers")
      return await triggersApi(engine.triggers, user, method, path.slice(2), a, method === "POST" ? publicOrigin(event) : "");
    if (path[0] === "me" && path[1] === "vault") {
      // 本人的密码本：热心市民在任务里按适用范围取用；用户只能管理自己的密码本。
      const vault = engine.vault.book(user.id);
      if (method === "GET" && path.length === 2) return { entries: await vault.list() };
      if (method === "POST" && path.length === 2) {
        if (a.employees !== undefined) {
          assert(Array.isArray(a.employees) && a.employees.length <= 50 && a.employees.every((value) => typeof value === "string" && value), "employees 必须是热心市民 ID 数组");
          const mine = new Set((await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user))).map((employee) => employee.employeeId));
          assert((a.employees as string[]).every((value) => mine.has(value)), "只能选择你名下的热心市民");
        }
        return await vault.save({ id: a.id, type: a.type, name: a.name, condition: a.condition, content: a.content, employees: a.employees });
      }
      check(method === "DELETE" && path.length === 3, 404, "Vault route not found");
      await vault.remove(decodeURIComponent(path[2]));
      return { ok: true };
    }
    if (path[0] === "me" && path[1] === "avatar" && path.length === 2 && method === "POST")
      return await updateUserAvatar(store, user.id, a);
    if (path[0] === "avatars" && path[1] === "users" && path.length === 3 && method === "GET") {
      check(path[2] === user.id || await engine.groups.sharesGroup(user.id, { user: path[2] }), 404, "Avatar not found");
      const blob = (await store.object<{ avatar: string }>("user-avatar", path[2]))?.avatar;
      const image = blob && await store.blobData(blob);
      check(image && image.mime === "image/webp", 404, "Avatar not found");
      setHeader(event, "Content-Type", "image/webp");
      setHeader(event, "Cache-Control", "private, max-age=86400");
      return send(event, Buffer.from(image.data));
    }
    if (path[0] === "groups") return await groupRoute(path, method, a, user, getRequestURL(event).searchParams);
    if (path[0] === "runtime") {
      check(method === "GET" && path.length === 1, 405, "GET required");
      return await engine.clientsView(user.id);
    }
    if (path[0] === "sessions") {
      if (path.length === 1 && method === "POST") {
        assert(!a.model || typeof a.model === "string", "Invalid model");
        if (a.model) await engine.catalog.resolve(await engine.config(), a.model);
        assert(a.clientId === undefined || (typeof a.clientId === "string" && /^[a-f0-9-]{32,36}$/.test(a.clientId)), "Invalid client ID");
        // 网站不再提供服务端/客户端切换；未指定时普通会话在服务端创建。显式 localAgent 仅供兼容接口。
        const localAgent = a.localAgent === true,
          agent = localAgent ? engine.localAgents.active(user.id, a.clientId) : undefined;
        assert(!localAgent || agent, "客户端未连接或存在多个客户端，请选择在线执行客户端");
        // 浏览器位置与执行位置解耦：显式要求本机执行的兼容会话，默认也用这台客户端的浏览器。
        const localBrowser = !!agent && (agent.browser || "local") !== "cloud";
        return await store.newSession({
                  cwd: localAgent ? agent!.cwd : a.cwd,
                  localAgent,
                  ...(localBrowser ? { localBrowser, browserClientId: agent!.clientId } : {}),
                  localPlatform: localAgent ? agent!.platform : undefined,
                  clientId: localAgent ? agent!.clientId : undefined,
                  clientName: localAgent ? agent!.name : undefined,
                  ownerId: user.id,
                  model: a.model,
                  title: a.title,
                  readOnly: a.readOnly === true,
                });
      }
      const key = path[1],
        session = await auth.session(user, key, method !== "GET");
      if (session.employeeId && method !== "GET") check(false, 400, "Use the employee workspace to manage its conversations");
      if (session.groupId && method !== "GET") check(false, 400, "群聊请在群聊页面操作");
      if (path[2] === "access")
        check(false, 404, "Private sessions cannot be shared");

      if (path.length === 2 && method === "GET")
        return await sessionRecord(engine, session, getRequestURL(event).searchParams, !session.taskId && !session.agentChild && !session.phaseRole && auth.canWrite(user, session));
      if (path.length === 2 && method === "DELETE") {
        const family = await store.sessionFamily(key);
        assert(
          (await filterAsync(family, async (s) =>
            !engine.active.has(s.id) &&
            (await engine.fire.forSession(s.id))?.status !== "running" &&
            !s.taskId && !s.employeeId)).length === family.length,
          "Cannot delete running or employee-owned session",
        );
        await store.deleteSession(key);
        for (const s of family) await engine.releaseSession(s.id);
        return { ok: true };
      }
      if (path[2] === "execution" && method === "POST")
        return await engine.switchExecution(key, a.localAgent, a.clientId, user.id);
      if (path[2] === "stage" && method === "POST")
        return await store.stage(key, a.inheritModel === true);
      if (path[2] === "cancel" && method === "POST") {
        assert(!session.taskId, "Use employee controls to stop tasks");
        await engine.fire.pause(key);
        engine.cancel(key);
        return { ok: true };
      }
      if (["messages", "steer"].includes(path[2]) && method === "POST") {
        assert(!session.agentChild && !session.phaseRole, "分身或阶段子记录只读，不能继续发消息");
        assert(!session.taskId, "Use employee controls to resume tasks");
        const message = await inputMessage(a, store, key);
        if (path[2] === "steer") {
          engine.steer(key, message);
          return { ok: true };
        }
        if (
          path[2] === "messages" &&
          /^\s*\/fire(?:\s|$)/i.test(message.text)
        ) {
          assert(!engine.active.has(key), "Session already running");
          assert(!message.files?.length, "/fire does not support attachments");
          return await engine.fire.start(key, message.text, message.images);
        }
        if (
          path[2] === "messages" &&
          /^\s*\/target(?:\s|$)/i.test(message.text)
        )
          throw Error("/target must be used inside /fire");
        if (path[2] === "messages" && await engine.fire.resume(key, message))
          return { id: key, fire: await engine.fire.forSession(key) };
        const stage = parseStage(message.text);
        let target = key;
        if (stage) {
          assert(
            !message.images?.length && !message.files?.length,
            "/stage does not support attachments",
          );
          if (stage.current)
            await engine.launch(key, { ...message, text: stage.current });
          target = (await store.stage(key)).id;
          message.text = stage.prompt;
        }
        await engine.launch(target, message);
        return { id: target };
      }
      if (path[2] === "rename" && method === "POST") {
        assert(
          typeof a.title === "string" &&
            a.title.trim() &&
            a.title.length <= 200,
          "Title required",
        );
        session.title = a.title;
        await store.saveSession(session);
        return { ok: true };
      }
      if (path[2] === "fork" && method === "POST") {
        assert(
          !engine.active.has(key),
          "Wait until the session stops before forking",
        );
        return await store.fork(key);
      }
    }
    if (path[0] === "usage" && method === "GET") {
      const query = getRequestURL(event).searchParams;
      const requested = query.get("userId") || undefined;
      const userId = user.role === "admin" ? requested : user.id;
      if (user.role !== "admin") check(!requested || requested === user.id, 403, "只能查看自己的用量");
      const from = query.get("from") ? Number(query.get("from")) : undefined;
      const to = query.get("to") ? Number(query.get("to")) : undefined;
      // Sequential: both statements may create the usage table on a fresh database.
      const summary = await store.tokenUsageSummary({ userId, from, to }),
        tasks = await store.tokenUsageTasks({ userId, from, to, page: Number(query.get("page")) || 1 });
      // The filter lists account names, not opaque ids; only administrators may see other accounts at all.
      const names = new Map((await store.all("SELECT id,username FROM web_users")).map((row) => [String(row.id), String(row.username)]));
      const employeeIds = [...new Set(tasks.tasks.map((row) => row.employee).filter(Boolean))],
        employees = new Map<string, string>();
      for (const id of employeeIds)
        employees.set(id, await engine.employee.for(id).then((item) => item.profile()).then((profile) => profile.name, () => ""));
      const rows = await Promise.all(tasks.tasks.map(async (row) => ({
        ...row,
        userName: names.get(row.user) || row.user,
        employeeName: employees.get(row.employee) || "",
        text: String(row.task ? (await store.employeeTask(row.task))?.task?.text || "" : "").slice(0, 200),
      })));
      return {
        ...summary,
        users: (user.role === "admin" ? summary.users : [user.id]).map((id) => ({ id, name: names.get(id) || id })),
        taskPage: { tasks: rows, total: tasks.total, page: tasks.page, pageSize: tasks.pageSize },
        self: user.id, admin: user.role === "admin",
      };
    }
    if (path[0] === "config" && method === "PUT")
      return engine.saveConfig(a as any);
    if (path[0] === "providers") {
      if (path[1] === "discover" && method === "POST") {
        check(
          a.provider &&
            typeof a.id === "string" &&
            /^[a-zA-Z0-9_.-]{1,80}$/.test(a.id),
          400,
          "服务商信息无效",
        );
        const raw = structuredClone(a.provider);
        mergeSecrets(raw, (await engine.config()).provider?.[a.id]);
        const p = await engine.catalog.provider(raw, await engine.config()),
          fetched = await engine.catalog.models(p, true),
          models = { ...fetched.models, ...modelEntries(p.models) };
        return { models };
      }
      if (path[1] === "presets") return presets;
      if (path[1] === "models")
        return engine.catalog.list(
          await engine.config(),
          a.force === true ||
            getRequestURL(event).searchParams.get("force") === "true",
        );
      if (path[1] === "login") {
        if (a.action === "start")
          return engine.catalog.auth.loginStart(a.source, a.site, {
            callbackOrigin: a.manual === true ? undefined : publicSiteURL(event),
            owner: user.id,
          });
        if (a.action === "poll")
          return {
            complete: await engine.catalog.auth.loginPoll(
              a.source,
              a.state,
              a.pasted,
              user.id,
            ),
          };
        if (a.action === "logout") {
          await engine.catalog.auth.logout(a.source);
          return { ok: true };
        }
        if (a.action === "status") {
          try {
            await engine.catalog.auth.load(a.source, await store.get("paths", {}));
            return { available: true };
          } catch (e: any) {
            return { available: false, reason: e.message };
          }
        }
        throw Error("Unknown subscription action");
      }
      if (path[1] === "import" && method === "POST") {
        const cfg = await engine.config(),
          key = a.id || a.source;
        assert(
          [
            "codex",
            "claude-code",
            "codebuddy",
            "workbuddy",
            "devin",
                      ].includes(a.source),
          "Unknown local source",
        );
        const preset =
          a.source === "codex"
            ? "local-codex"
            : a.source === "claude-code"
              ? "local-claude-code"
              : a.source === "workbuddy" ? "codebuddy" : a.source;
        const buddyOptions = ["codebuddy", "workbuddy"].includes(a.source) ? { codebuddySource: a.source } : {};
        const p = await engine.catalog.provider({ preset, options: buddyOptions, models: {} }, cfg);
        const dynamic = await engine.catalog.models(p, true);
        const first =
          Object.keys(dynamic.models)[0] || Object.keys(p.models)[0];
        assert(first, "No usable models in provider catalog");
        cfg.provider ??= {};
        cfg.provider[key] = {
          ...cfg.provider[key],
          preset,
          options: { ...cfg.provider[key]?.options, ...buddyOptions },
          name:
            typeof a.name === "string" && a.name.trim()
              ? a.name.trim().slice(0, 200)
              : cfg.provider[key]?.name || key,
          models: { ...cfg.provider[key]?.models },
        };
        if (!cfg.model) cfg.model = key + "/" + first;
        await engine.saveConfig(cfg);
        return {
          config: maskedConfig(cfg),
          models: await engine.catalog.list(cfg),
        };
      }
      if (path[1] === "paths" && method === "PUT") {
        await store.put("paths", {
                    devinPath: a.devinPath || "",
                  });
        return { ok: true };
      }
    }
    if (path[0] === "skills") check(false, 410, "请在对应热心市民的「技能 / MCP」页面管理技能");
    if (path[0] === "employee") {
      if (method === "GET")
        return {
          ...(({ orbit, ...state }) => state)(await engine.employee.state()),
          systemPresence: engine.employee.nativePresence,
          busy: [...engine.employee.busy.keys()],
          takeovers: [...engine.employee.takeovers].map(([id, v]) => ({
            id,
            ...v,
          })),
        };
      if (path[1] === "control") return engine.employee.control(a);
      if (path[1] === "takeover") {
        await engine.employee.takeover(a);
        return { ok: true };
      }
      if (path[1] === "activity") {
        engine.employee.lastActivity = Date.now() - (Number(a.idleMs) || 0);
        engine.employee.locked = a.locked === true;
        engine.employee.schedule();
        return { ok: true };
      }
      if (path[1] === "transcript")
        return await engine.employee.transcript(a.threadId);
      const out = await engine.employee.execute("", a);
      return out.secret ? JSON.parse(out.secret) : out.value;
    }
    if (path[0] === "chrome") {
      const cloud = cloudFor({ ownerId: user.id });
      const browser = cloud ? await engine.browsers.get(engine.browserProfileKey(user.id)) : engine.chrome;
      if (path.length === 2 && path[1] === "tabs" && method === "GET")
        return browserTabs(browser);
      if (path.length === 2 && path[1] === "screenshot" && method === "POST") {
        check(
          Object.keys(a).every((key) => key === "tabTag"),
          400,
          "Screenshot requests only accept tabTag",
        );
        return await browserScreenshot(
          browser,
          "browser-view:" + user.id,
          a.tabTag,
        );
      }
      if (path.length === 2 && path[1] === "control" && method === "POST")
        return await browserControl(
          browser,
          "browser-view:" + user.id,
          a,
        );
      if (path[1] === "tool")
        return browser.execute("browser-view:" + user.id, cloud ? await cloud.cwd(a.cwd) : a.cwd || process.cwd(), a);
      if (a.operation === "close") {
        if (cloud) await engine.browsers.stop(engine.browserProfileKey(user.id));
        else browser.bridge.close();
        return { ok: true };
      }
      await browser.bridge.start();
      return browser.bridge.status();
    }
    if (path[0] === "experiences" && method === "GET") {
      const employees = await filterAsync(await engine.employee.all(), async (employee) => (await employee.profile()).ownerId === user.id);
      return userExperienceGraph(store, user.id, employees.map((employee) => employee.employeeId));
    }
    throw createError({
      statusCode: 404,
      statusMessage: "API route not found",
    });
  } catch (e: any) {
    if (e.statusCode) throw e;
    throw createError({
      statusCode: 400,
      statusMessage: String(e.message).slice(0, 1000),
      data: { error: e.message },
    });
  }
});

/**
 * 蝴蝶面板（原生客户端凭据）的聊天接口：thread = "employee:<id>" | "group:<id>"。
 * 只做三件事：列会话、读历史（after/limit）、发一条用户消息。
 */
async function clientChat(op: string, a: Obj, userId: string, clientId?: string) {
  const { engine, store } = app(), user = await app().auth.user(userId);
  assert(user, "User not found");
  if (op === "file") {
    assert(typeof a.blobId === "string" && /^blob-[a-f\d]{32}$/.test(a.blobId) && await app().auth.canBlob(user, a.blobId), "File not found");
    const blob = await store.blobData(a.blobId);
    assert(blob && blob.data.length <= ATTACHMENT_BYTES, "File unavailable");
    return { data: Buffer.from(blob.data).toString("base64") };
  }
  if (op === "threads") {
    const employees = await Promise.all((await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user))).map(async (employee) => {
      const s = await employee.state(), last = s.chatSession ? await store.lastMessage(s.chatSession) : undefined;
      const unread = s.chatSession ? await store.unread(user.id, s.chatSession) : 0, lastAt = last?.at || 0;
      return {
        thread: "employee:" + s.id, kind: "employee", id: s.id, name: s.name, avatar: s.avatar || "", mine: s.ownerId === user.id,
        unread, lastViewedAt: s.chatSession ? await store.lastViewedAt(user.id, s.chatSession, lastAt, unread) : lastAt,
        running: !!s.chatSession && engine.active.has(s.chatSession),
        runningTasks: s.tasks.filter((task) => task.status === "running").length,
        attention: s.tasks.filter((task) => ["waiting", "approval"].includes(task.status)).length,
        lastText: last ? String(last.text || "").slice(0, 60) : "", lastAt,
      };
    }));
    const groups = (await engine.groups.list(user)).map((g) => ({
      thread: "group:" + g.id, kind: "group", id: g.id, name: g.name,
      users: g.users?.length || 0, employees: g.employees?.length || 0,
      unread: g.unread, lastViewedAt: g.lastViewedAt, running: Array.isArray(g.running) && g.running.length > 0,
      lastText: g.lastText || "", lastAt: g.lastAt || 0,
    }));
    return { employees, groups };
  }
  const thread = String(a.thread || ""), colon = thread.indexOf(":"), kind = thread.slice(0, colon), id = thread.slice(colon + 1);
  assert((kind === "employee" || kind === "group") && id, "Invalid thread");
  if (op === "messages") {
    const receiptFor = a.receiptFor;
    assert(receiptFor === undefined || typeof receiptFor === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(receiptFor), "Invalid message ID");
    const receipt = async (session: string, messageId: string) => {
      const row = await store.clientMessage(session, user.id, messageId);
      return { receiptFor: messageId, receipt: row?.role === "user" ? { seq: row.seq } : null };
    };
    const query = new URLSearchParams();
    if (typeof a.after === "number") query.set("after", String(Math.max(0, Math.floor(a.after))));
    else query.set("limit", String(Math.min(200, Math.max(1, Number(a.limit) || 100))));
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      if (receiptFor !== undefined) return receipt(session.id, receiptFor);
      const page = await chatHistory(store, session.id, query);
      // 待确认气泡里的任务状态会随作答翻转：返回前把它刷成当前值，面板按它决定还能不能点。
      const live = new Map((await employee.state()).tasks.map((task) => [task.id, task.status]));
      for (const message of page.messages || [])
        for (const task of message.tasks || [])
          if (live.has(task.id)) task.status = live.get(task.id)!;
      const state = await employee.state();
      return { thread, title: state.name, avatar: state.avatar || "", running: engine.active.has(session.id), readSeq: await store.readSeq(user.id, session.id), ...page };
    }
    const group = await engine.groups.mine(user, id);
    if (receiptFor !== undefined) return receipt(group.session, receiptFor);
    // 群聊作者头像是预设字符串（pixel:role:color 或旧 bot:shape:color），给面板解析成像素小人；key 为 kind:id。
    const view = await engine.groups.view(group, user);
    const authors = Object.fromEntries([
      ...(view.employees || []).map((p) => ["employee:" + p.id, { avatar: p.avatar || "" }]),
      ...(view.users || []).map((p) => ["user:" + p.id, { avatar: p.avatar || "" }]),
    ]);
    return { thread, title: group.name, authors, running: Object.values(group.memberSessions || {}).some((s) => engine.active.has(String(s))), readSeq: await store.readSeq(user.id, group.session), ...await chatHistory(store, group.session, query) };
  }
  if (op === "read") {
    assert(a.through === undefined || Number.isSafeInteger(a.through) && a.through >= 0, "Invalid read cursor");
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      return { seq: await store.markRead(user.id, session.id, a.through) };
    }
    const group = await engine.groups.mine(user, id);
    return { seq: await store.markRead(user.id, group.session, a.through) };
  }
  if (op === "control") {
    // 面板上的待确认气泡：只允许审批或回复自己名下的热心市民的任务（群聊任务不在这里控制）。
    assert(kind === "employee", "Panel control only applies to an employee thread");
    const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
    assert(employee && await employee.accessible(user), "Employee not found");
    assert(["approve", "answer", "stop"].includes(String(a.action || "")), "Unsupported control action");
    return await employee.control({ id: a.id, action: a.action, approved: a.approved, text: a.text }, { token: "", name: user.username || "用户" });
  }
  if (op === "send") {
    check(user.role !== "viewer", 403, "只读账号不能发送消息");
    const text = typeof a.text === "string" ? a.text.trim() : "", clientMessageId = a.clientMessageId;
    assert(text && text.length <= 2 << 20, "Message required");
    assert(clientMessageId === undefined || typeof clientMessageId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(clientMessageId), "Invalid message ID");
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      check(!employee.deleting && !employee.resetting, 409, "正在删除或重置这位热心市民，请稍候");
      await engine.submitChat(session.id, {
        role: "user", text, actorId: user.id, clientMessageId,
        clientMessageHash: clientMessageId ? createHash("sha256").update(JSON.stringify([text, [], [], null])).digest("hex") : undefined,
      }, clientId);
      return { ok: true };
    }
    return { ok: true, ...await engine.groups.send(user, id, { text, clientMessageId }) };
  }
  throw createError({ statusCode: 404, statusMessage: "Chat route not found" });
}

/** 群聊 (groups.ts). Reading is open to every user in the group; changing anything needs a non-viewer account. */
async function groupRoute(path: string[], method: string, a: Obj, user: { id: string; role: string }, query: URLSearchParams) {
  const { engine, store } = app(), groups = engine.groups;
  if (path.length === 1 && method === "GET") return await groups.list(user);
  if (path[1] === "directory" && method === "GET") return await groups.directory();
  // Marking read is reading: read-only accounts may do it.
  if (path[2] === "read" && path.length === 3 && method === "POST") return { seq: await store.markRead(user.id, (await groups.mine(user, path[1])).session) };
  const leaving = method === "DELETE" && path[2] === "users" && path[3] === user.id;
  if (method !== "GET" && !leaving) check(user.role !== "viewer", 403, "只读账号不能在群聊中操作");
  if (path.length === 1 && method === "POST") return await groups.create(user, a);
  const id = path[1];
  if (path.length === 2) {
    if (method === "GET") return await groups.view(await groups.mine(user, id), user);
    if (method === "PATCH") return await groups.update(user, id, a);
    if (method === "DELETE") return await groups.remove(user, id);
  }
  if (path[2] === "messages" && path.length === 3) {
    const group = await groups.mine(user, id);
    if (method === "GET") {
      const topicTaskId = query.get("topicTaskId");
      const scoped = topicTaskId === null ? undefined : await groups.topicMessages(group, topicTaskId);
      const page = await chatHistory(store, group.session, query, scoped);
      const [taskStatus, taskMeta] = await Promise.all([groups.taskStatus(page.messages), groups.taskMeta(group, page.messages)]);
      for (const [taskId, info] of Object.entries(taskMeta)) if (!(taskId in taskStatus)) taskStatus[taskId] = info.status;
      return { ...page, group: await groups.view(group, user), taskStatus, taskMeta };
    }
    if (method === "POST") {
      const input = await inputMessage({ text: typeof a.text === "string" ? a.text : "", images: a.images, files: a.files, quoteSeq: a.quoteSeq }, store, group.session);
      return await groups.send(user, id, { ...input, clientMessageId: a.clientMessageId, topicTaskId: a.topicTaskId, taskRefs: a.taskRefs });
    }
  }
  if (path[2] === "users") {
    if (path.length === 3 && method === "POST") { await groups.addUsers(user, id, Array.isArray(a.userIds) ? a.userIds : []); return { ok: true }; }
    if (path.length === 4 && method === "DELETE") return await groups.removeUser(user, id, path[3]);
  }
  if (path[2] === "employees") {
    if (path.length === 3 && method === "POST") { await groups.addEmployee(user, id, a.employeeId); return { ok: true }; }
    if (path.length === 4 && method === "DELETE") return await groups.removeEmployee(user, id, path[3]);
  }
  if (path[2] === "tasks" && path.length === 3 && method === "GET") {
    const result = await groups.tasks(user, id);
    return query.get("stepSummaries") === "1" ? { ...result, members: result.members.map((member) => ({ ...member, tasks: member.tasks.map(withoutStepOutputs) })) } : result;
  }
  if (path[2] === "tasks" && path.length === 5) {
    if (method === "GET") return await groups.task(user, id, path[3], path[4]);
    if (method === "POST") return await groups.controlTask(user, id, path[3], path[4], a);
  }
  if (path[2] === "cancel" && method === "POST") return await groups.cancel(user, id, String(a.employeeId || ""));
  throw createError({ statusCode: 404, statusMessage: "Group route not found" });
}
