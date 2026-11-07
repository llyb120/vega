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
import { CLIENT_BODY_LIMIT } from "../../core/client-socket";
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
      const names = new Map(await Promise.all((await engine.employee.all()).map(async (employee) => { const s = await employee.profile(); return [s.id, s.name] as const; })));
      // Each group's 旁白 session too (it belongs to no employee).
      const narrators = (await engine.groups.all()).filter((g) => g.narrator?.session).map((g) => [g.narrator!.session, g.name] as const);
      const narratorSessions = (await Promise.all(narrators.map(async ([id, name]) => await store.hasSession(id) ? { ...await store.session(id), employeeId: "", employeeName: "旁白 · " + name, taskText: "", kind: "narrator", running: false } : undefined))).filter(Boolean);
      return [...narratorSessions, ...await Promise.all((await store.employeeSessions()).map(async (session) => {
        const linked = session.taskId ? await store.employeeTask(session.taskId) : undefined;
        const employeeId = session.employeeId || linked?.employee || "";
        return { ...session, employeeId, employeeName: names.get(employeeId) || "未关联牛马", taskText: linked?.task.text || "", kind: !session.taskId ? (session.groupId ? "group" : "chat") : linked?.task.computerSession === session.id || session.scene === "computer" ? "computer" : "work", running: engine.active.has(session.id), taskStatus: linked?.task.status };
      }))];
    }
    if (path[0] === "bootstrap" && method === "GET") {
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
      if (["capabilities", "skills", "mcp", "vault"].includes(path[2]))
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
      if (path[2] === "execution" && method === "POST") {
        check(await employee.manageable(user), 403, "只有牛马管理者可以切换默认执行位置");
        return engine.switchEmployeeExecution(employee.employeeId, a.prefer, user.id, a.browserPlace);
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
        return { ...visible, canManage: await employee.manageable(user), canConfigure: await canConfigureEmployee(employee, user), executionClients: await employee.manageable(user) ? engine.localAgents.list(state.ownerId || user.id) : [], busy: [...employee.busy.keys()], chatRunning: !!state.chatSession && engine.active.has(state.chatSession) };
      }
      if (path.length === 2 && method === "POST") {
        if (!await employee.manageable(user)) check(a.action === "list" || (a.action === "add" && a.kind === "todo"), 403, "只有牛马管理者可以修改职责、记忆和凭据");
        // Same owner-only rule as the vault page: managing an employee does not open its vault.
        if (typeof a.action === "string" && a.action.startsWith("vault_")) check(await canConfigureEmployee(employee, user), 403, "只有牛马创建者可以使用这个牛马的密码本");
        const result = await employee.execute("", await prepareDutyInput(engine, employee, a));
        return result.secret ? JSON.parse(result.secret) : result.value;
      }
      check(false, 404, "Employee route not found");
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
    if (path[0] === "sessions") {
      if (path.length === 1 && method === "POST") {
        assert(!a.model || typeof a.model === "string", "Invalid model");
        if (a.model) await engine.catalog.resolve(await engine.config(), a.model);
        assert(a.clientId === undefined || (typeof a.clientId === "string" && /^[a-f0-9-]{32,36}$/.test(a.clientId)), "Invalid client ID");
        const clients = engine.localAgents.list(user.id),
          localAgent = a.localAgent === undefined ? clients.length > 0 : a.localAgent,
          agent = engine.localAgents.active(user.id, a.clientId);
        assert(typeof localAgent === "boolean", "Invalid execution mode");
        assert(!localAgent || agent, "客户端未连接或存在多个客户端，请选择在线执行客户端");
        return await store.newSession({
                  cwd: localAgent ? agent!.cwd : a.cwd,
                  localAgent,
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
        return {
          session,
          canWrite: !session.taskId && auth.canWrite(user, session),
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
