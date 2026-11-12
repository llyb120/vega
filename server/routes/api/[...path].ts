import { updateEmployeeAvatar, updateUserAvatar } from "../../core/employee-avatar";
import { chatHistory } from "../../core/chat-page";
import { prepareDutyInput } from "../../core/duty-condition";
import { canConfigureEmployee, employeeCapabilities } from "../../core/employee-capabilities";
import {
  browserTabs,
  browserScreenshot,
  browserControl,
} from "../../core/browser-preview";
import { publicOrigin, principal } from "../../core/http-auth";
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
import { safeFileName, storeAttachments } from "../../core/attachments";
import { cloudFor, cloudEnabled, cloudHealthy } from "../../core/cloud";
import { newCommand } from "../../core/new-session";
import { clientBaseName, clientPackage } from "../../core/client-package";
import { CLIENT_BODY_LIMIT } from "../../core/client-socket";
import { installBrowserExtension } from "../../core/local-extension";
import { assert, filterAsync, object, type Obj } from "../../core/util";
import { parseStage, Context } from "../../core/context";
import { maskedConfig, mergeSecrets, modelEntries } from "../../core/config";
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
  // 安装包下载：公开（和静态的 /clients 一样），不需要登录，但每个站点打出来的 ZIP 只指向自己。
  if (path[0] === "clients" && path.length === 2) {
    check(method === "GET", 405, "GET required");
    const file = clientBaseName(path[1]), body = await clientPackage(file, publicOrigin(event));
    setHeader(event, "Content-Type", "application/zip");
    setHeader(event, "Content-Disposition", `attachment; filename="${file}.zip"`);
    setHeader(event, "Cache-Control", "no-store");
    return send(event, body);
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
    // 蝴蝶面板（原生客户端）：设备凭据自己验，不用网站 cookie，只碰它自己的牛马/群聊。
    setHeader(event, "Cache-Control", "no-store");
    const request = { headers: new Headers(getRequestHeaders(event) as Record<string, string>), url: getRequestURL(event).href } as unknown as Request;
    let grant: { userId: string };
    try { grant = await app().clientSockets.authorize(request); }
    catch { throw createError({ statusCode: 403, statusMessage: "Client credential invalid or revoked" }); }
    const body = await bodyJSON(event, 1 << 20);
    try { return await clientChat(path[2], body, grant.userId); }
    catch (e: any) { throw createError({ statusCode: e.statusCode || 400, statusMessage: String(e.message || e).slice(0, 500) }); }
  }
  if (path[0] === "local-agent" && path[1] === "extension" && method === "POST") {
    // 本机客户端「更新浏览器扩展」：设备凭据自己验，然后把安装任务交给这个账号的第一个牛马。
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
  let a: Obj = {};
  if (["POST", "PUT", "PATCH"].includes(method))
    a = await bodyJSON(event, 90 << 20);
  if (path[0] === "local-agent") {
    setHeader(event, "Cache-Control", "no-store");
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
      check(method === "GET" && path[1] === "sessions" && path.length === 2, 404, "Debug route not found");
      const mine = await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user));
      const names = new Map(await Promise.all(mine.map(async (employee) => { const s = await employee.profile(); return [s.id, s.name] as const; })));
      const own = new Set(mine.map((employee) => employee.employeeId));
      // Each group's 旁白 session too (it belongs to no employee).
      const narrators = (await engine.groups.all()).filter((g) => g.narrator?.session).map((g) => [g.narrator!.session, g.name] as const);
      const narratorSessions = (await Promise.all(narrators.map(async ([id, name]) => await store.hasSession(id) ? { ...await store.session(id), employeeId: "", employeeName: "旁白 · " + name, taskText: "", kind: "narrator", running: false } : undefined))).filter(Boolean);
      return [...narratorSessions, ...(await Promise.all((await store.employeeSessions()).map(async (session) => {
        const linked = session.taskId ? await store.employeeTask(session.taskId) : undefined;
        const employeeId = session.employeeId || linked?.employee || "";
        // Each administrator's debug view covers only their own employees.
        if (employeeId && !own.has(employeeId)) return undefined;
        return { ...session, employeeId, employeeName: names.get(employeeId) || "未关联牛马", taskText: linked?.task.text || "", kind: !session.taskId ? (session.groupId ? "group" : "chat") : linked?.task.computerSession === session.id || session.scene === "computer" ? "computer" : "work", running: engine.active.has(session.id), taskStatus: linked?.task.status };
      }))).filter(Boolean)];
    }
    if (path[0] === "bootstrap" && method === "GET") {
      // 新账号第一次进来就有一只自己的牛马；建失败不挡住登录，下次进入再试。
      if (user.role !== "viewer")
        await engine.employee.ensureOwned(user.id, user.username + " 的牛马").catch((error) => console.warn("[Vega] 自动创建牛马失败：" + error.message));
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
        runtime: await engine.runtimes.view(user.id),
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
          return { id: s.id, name: s.name, avatar: s.avatar || "", instruction: s.instruction, ownerId: s.ownerId, mine: s.ownerId === user.id, chatSession: s.chatSession || "", unread: s.chatSession ? await store.unread(user.id, s.chatSession) : 0, canManage: await employee.manageable(user), activeTasks: s.tasks.filter((t) => !["done", "failed", "stopped", "cancelled"].includes(t.status)).length, runningTasks: s.tasks.filter((t) => t.status === "running").length, attentionTasks: s.tasks.filter((task) => ["waiting", "approval"].includes(task.status)).length };
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
      check(!employee.deleting, 409, "牛马正在删除，请稍候");
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
          check(await employee.manageable(user), 403, "只有牛马管理者可以修改头像");
          return await updateEmployeeAvatar(employee, a);
        }
        check(false, 405, "Method not allowed");
      }
      // 任务执行权：同一个任务同一时刻只在一个位置跑，交接是唯一改变它的方式。
      if (path[2] === "tasks" && path[4] === "handoff" && method === "POST") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以交接执行权");
        const taskId = String(path[3] || "");
        if (a.action === "status") return engine.handoffs.status(employee.employeeId, taskId);
        if (a.action === "to-cloud") return engine.handoffs.toCloud(employee.employeeId, taskId, { source: "manual" });
        if (a.action === "to-local") return engine.handoffs.toLocal(employee.employeeId, taskId, { clientId: a.clientId });
        check(false, 400, "action 是 to-cloud、to-local 或 status");
      }
      if (path[2] === "handoff" && path.length === 3 && method === "POST") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以配置接力");
        return engine.handoffs.configure(employee.employeeId, a);
      }
      if (path.length === 2 && method === "DELETE") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以删除牛马");
        check(getRequestURL(event).searchParams.get("confirmed") === "true", 400, "请明确确认删除牛马及其任务、会话和浏览器登录数据");
        check(!employee.busy.size && !(state.chatSession && engine.active.has(state.chatSession)), 409, "牛马仍在执行，请先停止任务和当前对话，再删除牛马");
        await engine.removeEmployee(employee.employeeId, async () => {
          // Shared owner browser stays; only drop a live keyed by this employee if any legacy entry exists.
          const live = app().employeeLives.get(employee.employeeId);
          if (live) { await live.close(); app().employeeLives.delete(employee.employeeId); }
        });
        return { ok: true };
      }
      if (path[2] === "reset" && path.length === 3 && method === "POST") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以重置牛马");
        check(getRequestURL(event).searchParams.get("confirmed") === "true", 400, "请明确确认清空该牛马的全部会话和任务");
        return await engine.resetEmployee(employee.employeeId);
      }
      if (path[2] === "chat" && path[3] === "clear" && method === "POST") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以清空聊天记录");
        check(getRequestURL(event).searchParams.get("confirmed") === "true", 400, "请明确确认清空该牛马的聊天记录");
        check(!(state.chatSession && engine.active.has(state.chatSession)), 409, "对话仍在进行，请先停止后再清空聊天记录");
        return await engine.clearEmployeeChat(employee.employeeId);
      }
      if (path[2] === "chat" && method === "GET") {
        const session = await employee.chat(user.id);
        return { session, ...await chatHistory(store, session.id, getRequestURL(event).searchParams), running: engine.active.has(session.id) };
      }
      if (path[2] === "messages" && method === "POST") {
        check(a.clientMessageId === undefined || (typeof a.clientMessageId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(a.clientMessageId)), 400, "Invalid message ID");
        const session = await employee.chat(user.id);
        // /new [text]: a new model context first; the rest (or attachments), if any, is the first message in it.
        const command = newCommand(a.text);
        if (command) {
          check(!engine.active.has(session.id), 409, "对话仍在进行，请先停止后再开启新会话");
          check(!employee.deleting && !employee.resetting, 409, "牛马正在删除或重置，请稍候");
          if (a.clientMessageId && await store.clientMessage(session.id, user.id, a.clientMessageId)) return { id: session.id };
          const alone = !command.rest && !a.images?.length && !a.files?.length;
          await engine.newChatContext(session.id, alone ? { actorId: user.id, clientMessageId: a.clientMessageId } : {});
          if (alone) return { id: session.id, newSession: true };
          a = { ...a, text: command.rest };
        }
        const message = {
          ...await inputMessage(a, store, session.id), actorId: user.id,
          clientMessageId: a.clientMessageId,
          clientMessageHash: a.clientMessageId ? createHash("sha256").update(JSON.stringify([a.text || "", a.images || [], a.files || [], a.quoteSeq ?? null])).digest("hex") : undefined,
        };
        check(!employee.deleting && !employee.resetting, 409, "牛马正在删除或重置，请稍候");
        await engine.submitChat(session.id, message);
        return { id: session.id };
      }
      if (path[2] === "cancel" && method === "POST") {
        if (state.chatSession) engine.cancel(state.chatSession);
        return { ok: true };
      }
      if (path[2] === "chrome") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以查看和控制浏览器登录环境");
        const profileKey = engine.browserProfileKey(state.ownerId);
        if (method === "POST" && a.operation === "close") {
          check(!employee.busy.size, 409, "Stop browser tasks first");
          const live = app().employeeLives.get(profileKey);
          if (live) { await live.close(); app().employeeLives.delete(profileKey); }
          await engine.browsers.stop(profileKey);
          return { ok: true };
        }
        const browser = await engine.browsers.get(profileKey);
        check(!employee.deleting, 409, "牛马正在删除，请稍候");
        if (path[3] === "tabs" && method === "GET") return browserTabs(browser);
        if (path[3] === "live" && method === "POST") return (await employeeLive(employee.employeeId)).ticket(who, a.tabTag);
        if (path[3] === "screenshot" && method === "POST") return browserScreenshot(browser, "employee-view:" + user.id, a.tabTag);
        if (path[3] === "control" && method === "POST") return browserControl(browser, "employee-view:" + user.id, a);
        if (path[3] === "tool" && method === "POST") return browser.execute("employee-view:" + user.id, state.cwd, a);
        if (path.length === 3) return browser.bridge.status();
        check(false, 404, "Browser route not found");
      }
      if (path[2] === "control" && method === "POST") {
        if (["settings", "fire"].includes(a.action)) check(await employee.manageable(user), 403, "只有牛马管理者可以修改设置或触发职责");
        return employee.control(a);
      }
      if (path[2] === "transcript" && method === "POST") return await employee.transcript(a.threadId);
      if (path.length === 2 && method === "GET") {
        const { enabled, workStart, workEnd, ...visible } = state;
        return { ...visible, canManage: await employee.manageable(user), canConfigure: await canConfigureEmployee(employee, user), executionClients: await employee.manageable(user) ? engine.localAgents.list(state.ownerId || user.id) : [], runtime: await engine.runtimes.viewEmployee(employee.employeeId, state.ownerId || user.id), busy: [...employee.busy.keys()], chatRunning: !!state.chatSession && engine.active.has(state.chatSession) };
      }
      if (path.length === 2 && method === "POST") {
        if (!await employee.manageable(user)) check(a.action === "list" || a.action === "memory_search" || (a.action === "add" && a.kind === "todo"), 403, "只有牛马管理者可以修改职责、记忆和凭据");
        // Same owner-only rule as the vault page: managing an employee does not open its vault.
        if (typeof a.action === "string" && a.action.startsWith("vault_")) check(await canConfigureEmployee(employee, user), 403, "只有牛马创建者可以使用它的密码本条目");
        const result = await employee.execute("", await prepareDutyInput(engine, employee, a));
        return result.secret ? JSON.parse(result.secret) : result.value;
      }
      check(false, 404, "Employee route not found");
    }
    if (path[0] === "me" && path[1] === "vault") {
      // 本人的密码本：名下牛马在任务里按适用范围取用；什么角色都只碰自己这一本。
      const vault = engine.vault.book(user.id);
      if (method === "GET" && path.length === 2) return { entries: await vault.list() };
      if (method === "POST" && path.length === 2) {
        if (a.employees !== undefined) {
          assert(Array.isArray(a.employees) && a.employees.length <= 50 && a.employees.every((value) => typeof value === "string" && value), "employees 必须是牛马 ID 数组");
          const mine = new Set((await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user))).map((employee) => employee.employeeId));
          assert((a.employees as string[]).every((value) => mine.has(value)), "只能选择你自己的牛马");
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
      if (method === "GET" && path.length === 1) return await engine.runtimes.view(user.id);
      if (method === "POST" && path.length === 1) {
        assert(typeof a.employeeId === "string" && a.employeeId, "请指定要配置的牛马");
        assert(a.fsMaster === undefined || a.fsMaster === "cloud" || (typeof a.fsMaster === "string" && /^[a-f0-9-]{32,36}$/.test(a.fsMaster)), "无效的文件系统 Master");
        assert(a.browserMaster === undefined || a.browserMaster === "cloud" || (typeof a.browserMaster === "string" && /^[a-f0-9-]{32,36}$/.test(a.browserMaster)), "无效的浏览器 Master");
        assert(a.fsMaster !== undefined || a.browserMaster !== undefined, "请指定要更新的 Master");
        const employee = await engine.employee.for(a.employeeId);
        check(await employee.manageable(user), 403, "没有权限配置这头牛马的 Master");
        if (a.fsMaster !== undefined) await engine.runtimes.setMaster(a.employeeId, "fs", a.fsMaster);
        if (a.browserMaster !== undefined) await engine.runtimes.setMaster(a.employeeId, "browser", a.browserMaster);
        return await engine.runtimes.viewEmployee(a.employeeId, (await employee.state({ runs: false })).ownerId || user.id);
      }
      check(false, 405, "GET or POST required");
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

      if (path.length === 2 && method === "GET") {
        const query = getRequestURL(event).searchParams;
        const history = await chatHistory(store, key, query);
        const parentId = session.spawnParent || (session.agentChild ? session.stageSource : undefined);
        const parent = parentId && parentId !== session.id ? await store.session(parentId).catch(() => undefined) : undefined;
        const siblings = await store.sessionsByStageSource(parentId || key);
        const agentSessions = siblings.filter((item) => item.agentChild).map((item) => ({
          id: item.id,
          title: item.title,
          agentName: item.agentName,
          status: engine.active.has(item.id) ? "running" : "idle",
          running: engine.active.has(item.id),
          updated: item.createdAt,
        }));
        return {
          session,
          parentSession: parent ? { id: parent.id, title: parent.title || "主会话", status: engine.active.has(parent.id) ? "running" : "idle" } : undefined,
          agentSessions,
          canWrite: !session.taskId && !session.agentChild && auth.canWrite(user, session),
          ...history,
          folds: (await engine.store.all("SELECT data FROM folds WHERE session=?", key))
            .map((r: any) => JSON.parse(r.data)),
          fire: await engine.fire.forSession(key),
          running: engine.active.has(key),
          // Incremental refreshes (`after`) get the budget from context_budget events instead.
          ...(query.has("after") && query.get("context") !== "1"
            ? {}
            : {
                context: await (await Context.open(store, key, (await engine.config()).contextMode === "acp" ? "acp" : "auto")).status(),
              }),
        };
      }
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
        assert(!session.agentChild, "分身记录只读，不能继续发消息");
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
      return { ...(await store.tokenUsageSummary({ userId, from, to })), self: user.id, admin: user.role === "admin" };
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
            callbackOrigin: a.manual === true ? undefined : publicOrigin(event),
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
    if (path[0] === "skills") check(false, 410, "Skill 配置已移至各牛马，请在牛马的技能 / MCP 页面管理");
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
    if (path[0] === "experiences" && method === "GET")
      return engine.chrome.experiences.graph(
        (await engine.chrome.experiences.all()).filter((e) => !e.disabled),
      );
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
async function clientChat(op: string, a: Obj, userId: string) {
  const { engine, store } = app(), user = await app().auth.user(userId);
  assert(user, "User not found");
  if (op === "threads") {
    const employees = await Promise.all((await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user))).map(async (employee) => {
      const s = await employee.state(), last = s.chatSession ? await store.lastMessage(s.chatSession) : undefined;
      return {
        thread: "employee:" + s.id, kind: "employee", id: s.id, name: s.name, avatar: s.avatar || "", mine: s.ownerId === user.id,
        unread: s.chatSession ? await store.unread(user.id, s.chatSession) : 0,
        running: !!s.chatSession && engine.active.has(s.chatSession),
        runningTasks: s.tasks.filter((task) => task.status === "running").length,
        attention: s.tasks.filter((task) => ["waiting", "approval"].includes(task.status)).length,
        lastText: last ? String(last.text || "").slice(0, 60) : "", lastAt: last?.at || 0,
      };
    }));
    const groups = (await engine.groups.list(user)).map((g) => ({
      thread: "group:" + g.id, kind: "group", id: g.id, name: g.name,
      users: g.users?.length || 0, employees: g.employees?.length || 0,
      unread: g.unread, running: Array.isArray(g.running) && g.running.length > 0,
      lastText: g.lastText || "", lastAt: g.lastAt || 0,
    }));
    return { employees, groups };
  }
  const thread = String(a.thread || ""), colon = thread.indexOf(":"), kind = thread.slice(0, colon), id = thread.slice(colon + 1);
  assert(colon > 0 && id, "Invalid thread");
  if (op === "messages") {
    const query = new URLSearchParams();
    if (typeof a.after === "number") query.set("after", String(Math.max(0, Math.floor(a.after))));
    else query.set("limit", String(Math.min(200, Math.max(1, Number(a.limit) || 100))));
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      const page = await chatHistory(store, session.id, query);
      // 待确认气泡里的任务状态会随作答翻转：返回前把它刷成当前值，面板按它决定还能不能点。
      const live = new Map((await employee.state()).tasks.map((task) => [task.id, task.status]));
      for (const message of page.messages || [])
        for (const task of message.tasks || [])
          if (live.has(task.id)) task.status = live.get(task.id)!;
      const state = await employee.state();
      return { thread, title: state.name, avatar: state.avatar || "", running: engine.active.has(session.id), ...page };
    }
    const group = await engine.groups.mine(user, id);
    // 群聊作者头像是预设字符串（bot:shape:color），给面板解析成 BotAvatar；key 为 kind:id。
    const view = await engine.groups.view(group, user);
    const authors = Object.fromEntries([
      ...(view.employees || []).map((p) => ["employee:" + p.id, { avatar: p.avatar || "" }]),
      ...(view.users || []).map((p) => ["user:" + p.id, { avatar: p.avatar || "" }]),
    ]);
    return { thread, title: group.name, authors, running: Object.values(group.memberSessions || {}).some((s) => engine.active.has(String(s))), ...await chatHistory(store, group.session, query) };
  }
  if (op === "read") {
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      return { seq: await store.markRead(user.id, session.id) };
    }
    const group = await engine.groups.mine(user, id);
    return { seq: await store.markRead(user.id, group.session) };
  }
  if (op === "control") {
    // 面板上的待确认气泡：只允许对自己的牛马发 approve/answer（群聊任务不在这里控制）。
    assert(kind === "employee", "Panel control only applies to an employee thread");
    const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
    assert(employee && await employee.accessible(user), "Employee not found");
    assert(["approve", "answer", "stop"].includes(String(a.action || "")), "Unsupported control action");
    return await employee.control({ id: a.id, action: a.action, approved: a.approved, text: a.text }, { token: "", name: user.username || "用户" });
  }
  if (op === "send") {
    const text = String(a.text || "").trim();
    assert(text && text.length <= 2 << 20, "Message required");
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      await engine.submitChat(session.id, { role: "user", text, actorId: user.id });
      return { ok: true };
    }
    await engine.groups.send(user, id, { text });
    return { ok: true };
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
      const page = await chatHistory(store, group.session, query);
      return { ...page, group: await groups.view(group, user), taskStatus: await groups.taskStatus(page.messages) };
    }
    if (method === "POST") {
      const input = await inputMessage({ text: typeof a.text === "string" ? a.text : "", images: a.images, files: a.files }, store, group.session);
      return await groups.send(user, id, { text: input.text, clientMessageId: a.clientMessageId, images: input.images, files: input.files });
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
  if (path[2] === "tasks" && path.length === 3 && method === "GET") return await groups.tasks(user, id);
  if (path[2] === "cancel" && method === "POST") return await groups.cancel(user, id, String(a.employeeId || ""));
  throw createError({ statusCode: 404, statusMessage: "Group route not found" });
}
