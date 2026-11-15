import { createHash } from "node:crypto";
import type { AgentEvent } from "./engine";
import type { Message } from "./store";
import type { Application } from "./application";
import { check } from "./auth";
import { chatHistory } from "./chat-page";
import { ATTACHMENT_BYTES, storeAttachments } from "./attachments";
import { defaultBotAvatar, parseBotAvatar, isAvatarPreset } from "../../shared/employee-avatars";
import { SCENE_KEYS, modelEntries, sceneModelRows, schedulerLimits, type Config, type SceneModelRow } from "./config";
import { assert, filterAsync, type Obj } from "./util";

type ChatApplication = Pick<Application, "engine" | "store" | "auth">;

// Desktop chat must not expose the model's thinking, tool arguments/results, or runtime-only instructions.
// User-visible structure (quotes, files, step output, task state, errors) stays; unknown extras are named, not dumped.
const clientImageUrl = (url?: string) => !!url && /^(https?:|data:image\/)/.test(url);
export function clientChatMessage(message?: Message) {
  if (!message || (message.runtime && !(message.runtime === "steer" && message.clientMessageId)) || !["user", "assistant"].includes(message.role)) return null;
  const text = message.displayText ?? message.text ?? "";
  if (!(text.trim() || message.images?.length || message.files?.length || message.tasks?.length || message.stepOutput || message.notice || message.newSession)) return null;
  const images = message.images?.map((image) => ({
    mime: image.mime,
    ...(image.blobId ? { blobId: image.blobId } : {}),
    ...(image.data && !image.blobId ? { data: image.data } : {}),
    ...(clientImageUrl(image.url) ? { url: image.url } : {}),
  }));
  const quote = message.quote ? { seq: message.quote.seq, role: message.quote.role, text: [...message.quote.text].slice(0, 500).join(""), ...(message.quote.taskId ? { taskId: message.quote.taskId } : {}) } : undefined;
  return { seq: message.seq, role: message.role, text, at: message.at,
    clientMessageId: message.clientMessageId, tasks: message.tasks, images, files: message.files,
    ...(quote ? { quote } : {}),
    ...(message.stepOutput ? { stepOutput: message.stepOutput } : {}),
    ...(message.calls?.length ? { calls: message.calls.slice(0, 12).map((call) => ({ name: String(call.name || "工具").slice(0, 80) })) } : {}),
    ...(message.error ? { error: true } : {}),
    ...(message.notice ? { notice: true } : {}),
    ...(message.progress ? { progress: true } : {}),
    ...(message.delivery ? { delivery: true } : {}),
    ...(message.newSession ? { newSession: true } : {}) };
}

const SCENE_LABELS: Record<(typeof SCENE_KEYS)[number], string> = {
  lightweight: "沟通与任务起步", coding: "编码", computer: "浏览器操作",
};
function listedModels(config: Config) {
  const models: { id: string; name: string; supportsImages: boolean }[] = [];
  for (const [providerId, provider] of Object.entries(config.provider || {})) {
    const label = String((provider as Obj).name || providerId);
    for (const [modelId, raw] of Object.entries(modelEntries((provider as Obj).models || {}))) {
      const model = raw as Obj;
      const input = (model.modalities as Obj | undefined)?.input;
      const images = model.supportsImages === true || (Array.isArray(input) && input.includes("image"));
      models.push({ id: `${providerId}/${modelId}`, name: `${model.name || modelId} · ${label}`, supportsImages: images });
    }
  }
  return models;
}
async function readClientSettings(application: ChatApplication, user: { id: string; role: string }) {
  const employees = await filterAsync(await application.engine.employee.all(), (employee) => employee.accessible(user));
  const bots = await Promise.all(employees.map(async (employee) => {
    const state = await employee.state();
    return {
      id: state.id, name: state.name, instruction: state.instruction || "", cwd: state.cwd || "",
      idleMinutes: state.idleMinutes, takeoverSeconds: state.takeoverSeconds, editable: await employee.manageable(user),
    };
  }));
  if (user.role !== "admin") return { role: user.role, admin: false, bots };
  const config = await application.engine.config();
  const limits = schedulerLimits(config);
  return {
    role: user.role, admin: true, bots,
    scenes: Object.fromEntries(SCENE_KEYS.map((key) => [key, sceneModelRows(config, key)])),
    scheduler: { globalSlots: limits.global, perEmployeeSlots: limits.perEmployee },
    providers: Object.entries(config.provider || {}).map(([id, provider]) => ({ id, name: String((provider as Obj).name || id) })),
    models: listedModels(config),
  };
}
async function saveClientSettings(application: ChatApplication, user: { id: string; role: string; username?: string }, a: Obj) {
  if (a.save === "bot") {
    const bot = a.bot as Obj;
    assert(bot && typeof bot.id === "string" && bot.id, "Bot required");
    const employee = await application.engine.employee.for(bot.id);
    assert(await employee.accessible(user), "Employee not found");
    assert(await employee.manageable(user), "Only the owner may edit this bot");
    const patch: Obj = { action: "settings" };
    if ("instruction" in bot) {
      assert(typeof bot.instruction === "string" && bot.instruction.length <= 8000, "工作原则不能超过 8000 字");
      patch.instruction = bot.instruction;
    }
    if ("cwd" in bot && String(bot.cwd || "").trim()) {
      assert(typeof bot.cwd === "string" && bot.cwd.length <= 4096, "工作目录过长");
      patch.cwd = bot.cwd;
    }
    if ("idleMinutes" in bot) {
      assert(Number.isInteger(bot.idleMinutes) && bot.idleMinutes >= 0 && bot.idleMinutes <= 120, "空闲分钟数要在 0 到 120 之间");
      patch.idleMinutes = bot.idleMinutes;
    }
    if ("takeoverSeconds" in bot) {
      assert(Number.isInteger(bot.takeoverSeconds) && bot.takeoverSeconds >= 1 && bot.takeoverSeconds <= 120, "接管秒数要在 1 到 120 之间");
      patch.takeoverSeconds = bot.takeoverSeconds;
    }
    assert(Object.keys(patch).length > 1, "没有可保存的工作设置");
    await employee.control(patch);
    return { ok: true };
  }
  check(user.role === "admin", 403, "Administrator permission required");
  const previous = await application.engine.config();
  const next: Config = { ...previous, provider: previous.provider || {} };
  if (a.save === "scheduler") {
    const raw = (a.scheduler || {}) as Obj;
    assert(Number.isInteger(raw.globalSlots) && raw.globalSlots >= 1 && raw.globalSlots <= 64, "全站同时执行上限要在 1 到 64 之间");
    assert(Number.isInteger(raw.perEmployeeSlots) && raw.perEmployeeSlots >= 1 && raw.perEmployeeSlots <= 64, "单牛马同时执行上限要在 1 到 64 之间");
    next.scheduler = { globalSlots: raw.globalSlots, perEmployeeSlots: raw.perEmployeeSlots };
  } else if (a.save === "scenes") {
    const scenes = (a.scenes || {}) as Obj;
    const missing: string[] = [];
    next.scenes = { lightweight: [], coding: [], computer: [] };
    for (const key of SCENE_KEYS) {
      const rows = Array.isArray(scenes[key]) ? scenes[key] as (string | Obj)[] : [];
      const normalized: SceneModelRow[] = [];
      for (const row of rows) {
        const model = typeof row === "string" ? row.trim() : String(row?.model || "").trim();
        if (!model) continue;
        assert(model.length <= 200, "模型 ID 过长");
        normalized.push(key !== "computer" && row && typeof row === "object" && row.allowSpawn ? { model, allowSpawn: true } : model);
      }
      if (!normalized.length) missing.push(SCENE_LABELS[key]);
      next.scenes[key] = normalized;
    }
    assert(!missing.length, "请为全部场景配置至少一个模型后再保存（不再使用默认模型）：" + missing.join("、"));
  } else assert(false, "Unsupported settings action");
  await application.engine.saveConfig(next);
  return { ok: true };
}

export async function clientChat(application: ChatApplication, op: string, a: Obj, userId: string) {
  const { engine, store, auth } = application, user = await auth.user(userId);
  check(user && !user.disabled, 403, "User not found");
  if (op === "metadata") return { id: user.id, name: user.username };
  if (!["threads", "messages", "read", "file", "acceptance"].includes(op) && !(op === "settings" && !a.save))
    check(user.role !== "viewer", 403, "Execution permission required");
  if (op === "settings") return a.save ? saveClientSettings(application, user, a) : readClientSettings(application, user);
  if (op === "create") {
    assert(typeof a.clientNonce === "string" && /^[\w-]{16,80}$/.test(a.clientNonce), "Invalid creation ID");
    const key = user.id + "/" + a.clientNonce;
    const employee = await store.transaction(async () => {
      const previous = await store.object<{ id: string; hash: string }>("client-bot", key);
      const input = { name: a.name, instruction: a.instruction, avatar: a.avatar };
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (previous) {
        assert(previous.hash === hash, "Creation ID already used for different content");
        const employee = await engine.employee.for(previous.id);
        assert(await employee.accessible(user), "Employee not found");
        return employee;
      }
      const state = await engine.employee.create(input, user.id);
      await store.save("client-bot", key, { id: state.id, hash });
      return engine.employee.for(state.id);
    });
    return { id: employee.employeeId };
  }
  if (op === "file") {
    assert(typeof a.blobId === "string" && /^blob-[a-f\d]{32}$/.test(a.blobId) && await auth.canBlob(user, a.blobId), "File not found");
    const blob = await store.blobData(a.blobId);
    assert(blob && blob.data.length <= ATTACHMENT_BYTES, "File unavailable");
    return { data: Buffer.from(blob.data).toString("base64") };
  }
  if (op === "threads") {
    const employees = await Promise.all((await filterAsync(await engine.employee.all(), (employee) => employee.accessible(user))).map(async (employee) => {
      const s = await employee.state();
      const recent = s.chatSession ? (await store.messagePage(s.chatSession, { limit: 20 })).messages.map(clientChatMessage).filter(Boolean) : [];
      const last = recent.at(-1), reply = recent.filter((message) => message?.role === "assistant").at(-1);
      return {
        thread: "employee:" + s.id, kind: "employee", id: s.id, name: s.name, avatar: s.avatar || "", mine: s.ownerId === user.id,
        instruction: s.instruction, botAvatar: parseBotAvatar(s.avatar) || defaultBotAvatar(s.id),
        unread: s.chatSession ? await store.unread(user.id, s.chatSession) : 0,
        running: !!s.chatSession && engine.active.has(s.chatSession),
        runningTasks: s.tasks.filter((task) => task.status === "running").length,
        attention: s.tasks.filter((task) => ["waiting", "approval"].includes(task.status)).length,
        lastText: last?.text.slice(0, 60) || "", lastAt: last?.at || 0, lastMessageId: reply ? "entry-" + reply.seq : null,
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
  assert(colon > 0 && id && ["employee", "group"].includes(kind), "Invalid thread");
  if (op === "messages") {
    const query = new URLSearchParams();
    if (a.after !== undefined) {
      assert(a.before === undefined && a.limit === undefined, "after cannot be combined with before or limit");
      query.set("after", String(a.after));
    }
    else {
      query.set("limit", String(a.limit ?? 100));
      if (a.before !== undefined) query.set("before", String(a.before));
    }
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      const page = await chatHistory(store, session.id, query);
      // 待确认气泡里的任务状态会随作答翻转：返回前把它刷成当前值，面板按它决定还能不能点。
      // partialDelivery 只给一个布尔值，内部的步骤键不进客户端。
      const live = new Map((await employee.state()).tasks.map((task) => [task.id, task]));
      for (const message of page.messages || [])
        for (const task of message.tasks || []) {
          const current = live.get(task.id);
          if (!current) continue;
          task.status = current.status;
          if (current.partialDelivery) (task as { partialDelivery?: boolean }).partialDelivery = true;
        }
      const state = await employee.state();
      return { thread, title: state.name, avatar: state.avatar || "", running: engine.active.has(session.id), ...page,
        nextBeforeSeq: "hasMore" in page && page.hasMore ? page.messages[0]?.seq ?? null : null,
        messages: page.messages.map(clientChatMessage).filter(Boolean) };
    }
    const group = await engine.groups.mine(user, id);
    // 群聊作者头像是预设字符串（bot:shape:color），给面板解析成 BotAvatar；key 为 kind:id。
    const view = await engine.groups.view(group, user);
    const authors = Object.fromEntries([
      ...(view.employees || []).map((p) => ["employee:" + p.id, { avatar: p.avatar || "" }]),
      ...(view.users || []).map((p) => ["user:" + p.id, { avatar: p.avatar || "" }]),
    ]);
    const page = await chatHistory(store, group.session, query);
    return { thread, title: group.name, authors, running: Object.values(group.memberSessions || {}).some((s) => engine.active.has(String(s))), ...page,
      nextBeforeSeq: "hasMore" in page && page.hasMore ? page.messages[0]?.seq ?? null : null,
      messages: page.messages.map((message) => {
        const projected = clientChatMessage(message);
        return projected ? { ...projected, author: message.author } : null;
      }).filter(Boolean) };
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
  if (["update", "cancel", "acceptance"].includes(op)) {
    assert(kind === "employee", "Employee thread required");
    const employee = await engine.employee.for(id);
    assert(await employee.accessible(user), "Employee not found");
    const state = await employee.state();
    if (op === "cancel") {
      if (state.chatSession) engine.cancel(state.chatSession);
      return { ok: true };
    }
    if (op === "acceptance") {
      assert(typeof a.clientMessageId === "string" && /^[\w:.-]{16,200}$/.test(a.clientMessageId), "Invalid message ID");
      const message = state.chatSession ? await store.clientMessage(state.chatSession, user.id, a.clientMessageId) : undefined;
      return message ? { outcome: "found", record: { status: "accepted", echoEntryId: "entry-" + message.seq } } : { outcome: "unknown-durability" };
    }
    assert(await employee.manageable(user), "Only the owner may edit this bot");
    assert(a.avatar === undefined || isAvatarPreset(a.avatar), "Invalid employee avatar");
    assert(a.name !== undefined || a.instruction !== undefined || a.avatar !== undefined, "Profile required");
    await employee.control({ action: "settings", ...Object.fromEntries(["name", "instruction", "avatar"].filter((key) => a[key] !== undefined).map((key) => [key, a[key]])) });
    return { id };
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
    const text = typeof a.text === "string" ? a.text : "";
    const hasAttach = (Array.isArray(a.images) && a.images.length > 0) || (Array.isArray(a.files) && a.files.length > 0);
    assert((text.trim() || hasAttach) && text.length <= 2 << 20, "Message required");
    if (kind === "employee") {
      const employee = (await engine.employee.all()).find((e) => e.employeeId === id);
      assert(employee && await employee.accessible(user), "Employee not found");
      const session = await employee.chat(user.id);
      check(!employee.deleting && !employee.resetting, 409, "Bot is being reset or deleted");
      assert(typeof a.clientMessageId === "string" && /^[\w:.-]{16,200}$/.test(a.clientMessageId), "Invalid message ID");
      const quote = a.quoteSeq === undefined ? undefined : await store.quote(session.id, a.quoteSeq);
      const stored = hasAttach ? await storeAttachments(store, session.id, a) : { images: [], files: [] };
      const hash = !hasAttach && a.quoteSeq === undefined ? text : JSON.stringify([text, a.images || [], a.files || [], a.quoteSeq ?? null]);
      await engine.submitChat(session.id, { role: "user", text, actorId: user.id, clientMessageId: a.clientMessageId,
        clientMessageHash: createHash("sha256").update(hash).digest("hex"),
        ...(stored.images.length ? { images: stored.images } : {}),
        ...(stored.files.length ? { files: stored.files } : {}),
        ...(quote ? { quote } : {}) });
      return { ok: true };
    }
    assert(a.quoteSeq === undefined, "群聊暂不能引用");
    const stored = hasAttach ? await storeAttachments(store, (await engine.groups.mine(user, id)).session, a) : { images: [], files: [] };
    await engine.groups.send(user, id, { text, ...(stored.images.length ? { images: stored.images } : {}), ...(stored.files.length ? { files: stored.files } : {}) });
    return { ok: true };
  }
  check(false, 404, "Chat route not found");
}

/** One selected employee chat per stream; no task-session tokens or other users' events cross this boundary. */
export async function watchClientChat(application: ChatApplication, userId: string, thread: unknown, send: (event: Obj) => void) {
  const { engine, auth } = application, user = await auth.user(userId);
  check(user && !user.disabled, 403, "User not found");
  assert(typeof thread === "string" && thread.startsWith("employee:"), "Employee thread required");
  const employee = await engine.employee.for(thread.slice(9));
  check(await employee.accessible(user), 403, "Employee not found");
  const session = await employee.chat(user.id);
  const listener = (event: AgentEvent) => {
    if (event.type === "employee_changed") {
      if (event.data?.employeeId === employee.employeeId) send({ type: "roster-changed" });
      return;
    }
    if (event.session !== session.id) return;
    if (["message_start", "text_delta", "done", "started", "compacted"].includes(event.type))
      send({ type: event.type, ...(event.type === "text_delta" ? { data: event.data } : {}) });
    else if (["user", "steer", "message_end"].includes(event.type)) {
      const message = clientChatMessage(event.data);
      if (!event.data || (message && !message.seq)) send({ type: "history-changed" });
      else if (message) send({ type: "message", message });
    }
  };
  engine.events.on("event", listener);
  return () => { engine.events.off("event", listener); };
}

