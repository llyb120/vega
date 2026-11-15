// Grok Bot UI Bridge for Vega WebView2 Desktop Client
(function () {
  console.log("[Vega Grok Bridge] Starting initialization...");

  const basePrefix = window.location.pathname.replace(/\/?$/, "/");
  const apiPath = (endpoint) => `${basePrefix}api/${endpoint}`;
  const subscriptions = new Set();
  const emit = (event, value) => {
    for (const handlers of subscriptions) handlers[event]?.(value);
  };
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  const readTheme = () => {
    const stored = localStorage.getItem("vega-theme-preference");
    const preference = ["light", "dark"].includes(stored) ? stored : "system";
    return { preference, resolved: preference === "system" ? (systemTheme?.matches ? "dark" : "light") : preference };
  };
  const nativeWindow = (action) => window.chrome?.webview?.postMessage(`vega-window:${action}`);
  const zoomFactor = () => (window.devicePixelRatio || 1) / (window.vegaPanelDpiScale || window.devicePixelRatio || 1);
  const languages = ["en", "hi", "zh-CN", "zh-TW", "pl", "es", "pt", "ja", "fr", "ko", "de", "ru", "tr", "ar", "it", "sv", "uk", "nl", "el", "af", "he", "vi", "id", "ur", "th", "bn", "cs", "hu", "nb", "da", "fi", "mr", "te", "sw", "ha", "ta", "pt-PT", "sl"];
  const readLanguage = () => {
    const stored = localStorage.getItem("vega-language-preference");
    const preference = stored === "system" || languages.includes(stored) ? stored : "zh-CN";
    const system = window.navigator?.language || "zh-CN";
    const resolved = preference === "system" ? (languages.find((tag) => tag.toLowerCase() === system.toLowerCase()) || languages.find((tag) => tag === system.split("-")[0]) || "en") : preference;
    return { preference, resolved };
  };
  let windowState = { isFullscreen: false, isMaximized: false };

  let currentSelectedAgentId = null;

  // 1. 本地存储代理 (模拟 Electron 主进程的 ClientPersistence)
  const persistenceKey = (k) => `sand_client_p_${k}`;

  // 2. 双向通信 MessageChannel (模拟 CoordinatorPort)
  let coordinatorPortHandler = null;
  const channel = new MessageChannel();
  const clientPort = channel.port1;
  const serverPort = channel.port2;

  serverPort.onmessage = async function (e) {
    const data = e.data;
    if (!data) return;
    // console.log("[Grok Bridge Port Server Recv]", data);

    if (data.kind === "lifecycle") {
      if (data.phase === "hello") {
        serverPort.postMessage({
          kind: "lifecycle",
          phase: "ready",
          protocolVersion: 3,
        });
      }
      return;
    }

    if (data.kind === "request") {
      const { requestId, method, args } = data;
      try {
        const result = await dispatchCoordinatorRequest(method, args);
        serverPort.postMessage({
          kind: "reply",
          requestId,
          outcome: { status: "ok", value: result },
        });
      } catch (err) {
        console.error(`[Grok Bridge] Request ${method} failed:`, err);
        serverPort.postMessage({
          kind: "reply",
          requestId,
          outcome: { status: "failed", failure: { code: err.code || "internal", message: String(err.message || err),
            ...(err.code === "capability-unavailable" ? { failureCode: "gateway/unknown-method" } : {}) } },
        });
      }
      return;
    }
  };

  async function api(endpoint, body = {}, signal) {
    const response = await fetch(apiPath(endpoint), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.statusMessage || `Vega 请求失败 (${response.status})`);
    return result;
  }
  function unavailable(method) {
    return Object.assign(new Error(`Vega 暂未接入此功能：${method}`), { code: "capability-unavailable" });
  }
  const postEvent = (family, payload) => serverPort.postMessage({ kind: "event", family, payload });
  const nativeShapes = { round: "pebble", tile: "squircle", chonk: "tablet", drop: "teardrop", triangle: "wedge", cog: "flower", hexagon: "hex", apple: "pumpkin", ghost: "dome" };
  const nativeColors = { amber: "yellow", teal: "cyan", purple: "violet", pink: "magenta", sky: "cyan" };
  const agentRow = (employee) => ({
    id: employee.id, name: employee.name, description: employee.instruction || "", title: "Vega",
    avatarShape: nativeShapes[employee.botAvatar?.shape] || employee.botAvatar?.shape || "sparkle",
    avatarColor: nativeColors[employee.botAvatar?.color] || employee.botAvatar?.color || "blue",
    harness: "temporal", origin: "user", viewerIsOwner: employee.mine !== false,
    createdAt: employee.lastAt || 0, updatedAt: employee.lastAt || 0, lastActivityAt: employee.lastAt || 0,
    lastMessagePreview: employee.lastText || "", lastEntry: employee.lastText ? { kind: "text", text: employee.lastText } : null,
    lastMessageId: employee.lastMessageId || null,
    hasUnread: !!employee.unread, isUnread: !!employee.unread, unreadCount: employee.unread || 0,
    isGroup: false, memberIds: [], isRunning: !!employee.running, isRunningTurn: !!employee.running,
    isComposingMessage: !!employee.running, attentionCount: employee.attention || 0, threadId: employee.thread,
  });
  const TASK_LABELS = {
    queued: "排队中", running: "执行中", recovering: "自动恢复中", deferred: "等待外部结果",
    waiting: "待补充信息", approval: "待你确认", done: "已完成", failed: "失败", stopped: "已停止",
    cancelled: "已取消", sealed: "已封存", pending: "待执行", in_progress: "进行中", completed: "已完成", blocked: "受阻",
  };
  const KNOWN_FIELDS = new Set(["seq", "role", "text", "displayText", "at", "clientMessageId", "tasks", "images", "files", "stepOutput", "quote", "error", "notice", "progress", "delivery", "newSession", "calls", "author"]);
  const pendingBlobs = new Map();
  const clipText = (value, max) => {
    const chars = [...String(value || "")];
    return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
  };
  const formatSize = (bytes) => typeof bytes === "number" && bytes >= 0 ? (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`) : "";
  const fileLine = (file) => {
    const name = String(file?.name || "未命名文件").replace(/\s+/g, " ").trim() || "未命名文件";
    const detail = [typeof file?.mime === "string" ? file.mime : "", formatSize(file?.size)].filter(Boolean).join("，");
    return `- ${name}${detail ? `（${detail}）` : ""}`;
  };
  const imageUrl = (image) => {
    if (typeof image?.url === "string" && (/^data:image\//.test(image.url) || /^https?:\/\//.test(image.url))) return image.url;
    if (typeof image?.data === "string" && typeof image?.mime === "string" && image.mime.startsWith("image/") && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data))
      return `data:${image.mime};base64,${image.data}`;
    return "";
  };
  const legacyStep = (message) => {
    const prefix = "**步骤产物（任务未完成）**\n\n", text = String(message.text || "");
    if (message.stepOutput !== true || !text.startsWith(prefix)) return null;
    const rest = text.slice(prefix.length), split = rest.indexOf("\n\n");
    return { label: split < 0 ? "历史步骤产物" : rest.slice(0, split), text: split < 0 ? rest : rest.slice(split + 2) };
  };
  const composedText = (message) => {
    const legacy = legacyStep(message), parts = [];
    if (message.author?.name) parts.push(`**${String(message.author.name)}**`);
    if (message.newSession) parts.push("**已开启新会话**");
    if (message.error) parts.push("**出错**");
    if (message.quote?.text) parts.push(`> 引用${message.quote.role === "user" ? "我" : "对方"}：${clipText(message.quote.text, 240)}`);
    const text = legacy ? "步骤产物已保存。" : String(message.text || "");
    if (text.trim()) parts.push(text);
    const step = legacy || (message.stepOutput && typeof message.stepOutput === "object" ? message.stepOutput : null);
    if (step) {
      parts.push(`**${step.step ? `步骤产物 · 第 ${step.step} 步` : "步骤产物"}**${step.label ? `：${step.label}` : ""}`);
      if (step.text) parts.push(String(step.text));
      for (const file of step.files || []) parts.push(fileLine(file));
    }
    if (message.tasks?.length) parts.push(message.tasks.map((task) => {
      const label = TASK_LABELS[task.status] || (task.status ? `状态 ${task.status}` : "");
      return `- ${task.title || "任务"}${label ? `（${label}）` : ""}`;
    }).join("\n"));
    if (message.calls?.length) {
      const names = message.calls.map((call) => clipText(call?.name || "工具", 80)).filter(Boolean);
      if (names.length) parts.push(`工具调用：${names.join("、")}。调用参数和工具原文不在对话里显示；给你看的进展、步骤产物和交付会写在消息正文里。`);
    }
    if (message.files?.length) parts.push(["附件：", ...message.files.map(fileLine)].join("\n"));
    if ((message.images || []).some((image) => !imageUrl(image) && !image?.blobId)) parts.push("有一张附图暂时无法显示。");
    const unknown = Object.keys(message).filter((key) => !KNOWN_FIELDS.has(key) && message[key] != null && message[key] !== "");
    if (unknown.length) parts.push(`还有未能单独展示的内容：${unknown.slice(0, 8).join("、")}。`);
    if (!parts.length) return message.notice ? "通知" : message.newSession ? "已开启新会话" : (message.images || []).length ? "附图" : "";
    return parts.join("\n\n");
  };
  const rememberImages = (entry, message) => {
    const ready = [], pending = [];
    for (const image of message.images || []) {
      const url = imageUrl(image);
      if (url) ready.push({ url, alt: "消息附图" });
      else if (image?.blobId) pending.push({ blobId: image.blobId, mime: image.mime || "image/png" });
    }
    if (ready.length) {
      if (entry.kind === "send-message" && entry.message) entry.message.images = ready;
      else if (entry.kind === "message") entry.images = ready;
    }
    if (pending.length) pendingBlobs.set(entry.id, { pending, role: entry.kind });
    else pendingBlobs.delete(entry.id);
  };
  const projectEntries = (message) => {
    if (!message || typeof message !== "object") return [{ id: "entry-unknown", seq: 0, timestampMs: 0, kind: "notice", text: "收到一条无法识别的消息", tasks: [] }];
    const seq = Number.isInteger(message.seq) ? message.seq : 0;
    const text = composedText(message);
    const id = `entry-${seq}`;
    const shared = { seq, timestampMs: message.at || 0, tasks: Array.isArray(message.tasks) ? message.tasks : [], ...(message.clientMessageId ? { clientNonce: message.clientMessageId } : {}), ...(Number.isInteger(message.quote?.seq) ? { replyTo: `entry-${message.quote.seq}` } : {}) };
    let primary;
    if (message.notice || (message.newSession && !text.replace("**已开启新会话**", "").trim()))
      primary = { ...shared, id, kind: "notice", text: text || "通知" };
    else if (message.role === "user")
      primary = { ...shared, id, kind: "message", role: "user", content: text, isStreaming: false };
    else if (message.role === "assistant" || message.text != null || message.tasks || message.files || message.images || message.stepOutput)
      primary = { ...shared, id, kind: "send-message", streaming: false, message: { type: "text", content: text } };
    else primary = { ...shared, id, kind: "notice", text: text || "收到一条无法识别的消息" };
    rememberImages(primary, message);
    const actions = (message.tasks || []).flatMap((task) => {
      if (!task?.id || !["waiting", "approval"].includes(task.status)) return [];
      const actionId = `entry-${seq}:task:${task.id}`;
      if (task.status === "approval") {
        const partial = task.partialDelivery === true;
        return [{ id: actionId, seq, timestampMs: message.at || 0, kind: "send-message", streaming: false, tasks: [], message: { type: "widget", widget: {
          prompt: partial ? "请确认是否接受当前已完成的部分。" : "请确认是否批准继续执行。",
          options: partial
            ? [{ label: "接受部分交付", value: "approve" }, { label: "继续原任务", value: "reject" }]
            : [{ label: "批准执行", value: "approve" }, { label: "驳回", value: "reject" }],
        } } }];
      }
      return [{ id: actionId, seq, timestampMs: message.at || 0, kind: "send-message", streaming: false, tasks: [], message: { type: "user-form", formRequest: {
        title: "需要补充信息", fields: [{ id: "answer", label: task.title || "你的回复", type: "textarea", required: true }],
      } } }];
    });
    return [primary, ...actions];
  };
  const taskRef = (entryId) => {
    const match = /^entry-\d+:task:([\w-]+)$/.exec(String(entryId || ""));
    return match ? match[1] : "";
  };
  const threadOf = (id) => {
    if (typeof id !== "string" || !id) throw new Error("请选择 Vega Bot");
    return `employee:${id}`;
  };
  let streamController = null, reconnectTimer = null, rosterTimer = null;
  let entries = new Map(), live = null, streamGeneration = 0, transcriptSequence = 1;
  const transcriptStamp = (id) => ({ replicaKey: `transcript:${id}`, epoch: `vega-${streamGeneration}`, sequence: transcriptSequence });
  function publishTranscript(id, complete = false) {
    transcriptSequence++;
    // A tail snapshot is not a complete history: preserve the renderer's older-page cursor.
    postEvent("transcript", { type: "snapshot", activeAgentId: id, ordered: transcriptStamp(id),
      coverage: { kind: "transcript-live-range", fromSequence: complete ? 1 : transcriptSequence, throughSequence: transcriptSequence },
      entries: [...[...entries.values()].sort((a, b) => a.seq - b.seq || String(a.id).localeCompare(String(b.id))), ...(live ? [live] : [])] });
  }
  async function hydrateEntries(rows, agentId, generation) {
    let changed = false;
    for (const entry of rows) {
      const job = pendingBlobs.get(entry.id);
      if (!job?.pending.length) continue;
      const images = [];
      let failed = false;
      for (const image of job.pending) {
        try {
          const file = await api("file", { blobId: image.blobId });
          if (typeof file?.data === "string" && file.data) images.push({ url: `data:${image.mime};base64,${file.data}`, alt: "消息附图" });
          else failed = true;
        } catch { failed = true; }
      }
      pendingBlobs.delete(entry.id);
      if (generation !== streamGeneration || agentId !== currentSelectedAgentId) return;
      if (images.length) {
        if (entry.kind === "send-message" && entry.message) entry.message.images = [...(entry.message.images || []), ...images];
        else if (entry.kind === "message") entry.images = [...(entry.images || []), ...images];
        changed = true;
      }
      if (failed) {
        const note = "附图无法显示。";
        if (entry.message) entry.message.content = [entry.message.content, note].filter(Boolean).join("\n\n");
        else if ("content" in entry) entry.content = [entry.content, note].filter(Boolean).join("\n\n");
        else entry.text = [entry.text, note].filter(Boolean).join("\n\n");
        changed = true;
      }
    }
    if (changed && agentId === currentSelectedAgentId && generation === streamGeneration) publishTranscript(agentId);
  }
  const commitMessage = (message) => {
    if (!message || typeof message !== "object") return;
    for (const [key, entry] of entries) if (entry.seq === message.seq) entries.delete(key);
    for (const row of projectEntries(message)) entries.set(row.id, row);
    if (message.role !== "user") live = null;
  };
  async function refreshRoster() {
    const data = await api("threads");
    const agents = data.employees.map(agentRow);
    postEvent("agents", { agents, activeAgentId: currentSelectedAgentId });
    postEvent("server-roster-changed", { kind: "resync" });
    return agents;
  }
  async function refreshTranscript(id, generation) {
    const data = await api("messages", { thread: threadOf(id), limit: 100 });
    if (generation !== streamGeneration) return;
    // Keep loaded older pages when the live tail is refreshed, but replace complete or reset histories.
    const kept = [...entries.values()].filter((entry) => data.nextBeforeSeq != null && entry.seq < data.nextBeforeSeq);
    const fresh = (data.messages || []).flatMap((message) => projectEntries(message));
    entries = new Map([...kept, ...fresh].map((entry) => [entry.id, entry]));
    live = null;
    publishTranscript(id, data.nextBeforeSeq == null);
    await hydrateEntries(fresh, id, generation);
  }
  function stopStream() {
    streamGeneration++;
    streamController?.abort();
    streamController = null;
    clearTimeout(reconnectTimer);
    clearInterval(rosterTimer);
  }
  function follow(id) {
    if (id === currentSelectedAgentId && streamController) return;
    stopStream();
    currentSelectedAgentId = id;
    entries = new Map();
    live = null;
    transcriptSequence = 1;
    if (!id) return;
    const generation = streamGeneration;
    const connect = async () => {
      if (generation !== streamGeneration) return;
      const controller = new AbortController();
      streamController = controller;
      let reader;
      try {
        const response = await fetch(apiPath("stream"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread: threadOf(id) }), signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error("Vega 实时连接不可用");
        reader = response.body.getReader();
        await refreshTranscript(id, generation);
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          if (pending.length > 4 << 20) throw new Error("Vega 事件超出限制");
          for (let end; (end = pending.indexOf("\n\n")) >= 0;) {
            const block = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const text = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!text || generation !== streamGeneration) continue;
            const event = JSON.parse(text);
            if (event.type === "closed") throw new Error(event.reason || "实时连接已关闭");
            if (event.type === "message_start") live = null;
            if (event.type === "text_delta") {
              live ||= { kind: "send-message", id: `vega-live-${id}`, message: { type: "text", content: "" }, streaming: true, timestampMs: Date.now() };
              live.message.content += event.data;
              publishTranscript(id);
            } else if (event.type === "message") {
              commitMessage(event.message);
              publishTranscript(id);
              await hydrateEntries([...entries.values()].filter((entry) => entry.seq === event.message?.seq), id, generation);
            } else if (["done", "compacted", "history-changed"].includes(event.type)) {
              if (event.type === "compacted") entries.clear();
              await refreshTranscript(id, generation);
              if (generation === streamGeneration && document.hasFocus?.()) await api("read", { thread: threadOf(id) });
              await refreshRoster();
            } else if (event.type === "roster-changed" || event.type === "started") {
              await refreshRoster();
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[Vega] 实时连接中断；只重连读取，不重发操作", error);
      } finally {
        await reader?.cancel().catch(() => {});
        if (!controller.signal.aborted && generation === streamGeneration) reconnectTimer = setTimeout(connect, 2000);
      }
    };
    void connect();
    rosterTimer = setInterval(() => { void refreshRoster().catch((error) => console.error("[Vega] 会话更新失败", error)); }, 15000);
  }
  window.addEventListener?.("pagehide", stopStream);

  // Keep protocol adaptation here; release bundles and styles remain unchanged.
  async function dispatchCoordinatorRequest(method, args = {}) {
    if (["listAgents", "getTrays", "getAsyncTasks", "getSubagents", "takeTeachLearningPrompts", "getAgentAutomations", "getAgentTasks"].includes(method)) return [];
    if (method === "getForeverBoxStatus" || method === "getBotTemplateForSourceAgent") return null;
    if (method === "getTeachRecordingStatus") return { state: "idle" };
    if (method === "isEgressTunnelAvailable") return false;
    if (method === "getHostStatus") return { hostVersion: null, latestHostVersion: null, hostUpdateAvailable: false, isBusy: false, capabilities: [] };
    if (["restoreTemporalAgentRouting", "clearLocalToolPermissions"].includes(method)) return;
    if (method === "noteTranscriptOpened") return api("read", { thread: threadOf(args.id) });
    if (method === "resolveAgentCreation") return { kind: "temporal", scope: "vega" };
    if (method === "noteMountedAgent") { follow(args.id); return; }
    if (method === "countAgents") return (await api("threads")).employees.length;
    if (["getMainAgent", "ensureDefaultMainAgent"].includes(method)) {
      const agents = (await api("threads")).employees;
      const stored = localStorage.getItem("vega-main-agent");
      return { agentId: agents.find((agent) => agent.id === stored)?.id || agents[0]?.id || null,
        ...(method === "ensureDefaultMainAgent" ? { outcome: "present" } : {}) };
    }
    if (method === "setMainAgent") {
      const id = args.agentId || args.id;
      if (!(await api("threads")).employees.some((agent) => agent.id === id)) throw new Error("Bot 不存在");
      localStorage.setItem("vega-main-agent", id);
      postEvent("server-roster-changed", { kind: "settings", fields: ["mainAgent"], explicit: true });
      return { agentId: id };
    }
    if (method === "getServerAgentRoster" || method === "listTeamAgents") return { agents: (await api("threads")).employees.map(agentRow) };
    if (method === "openAgentTail" || method === "getAgentTranscriptTail") {
      if (args.sessionId || args.taskId) throw unavailable("分支或任务线程历史");
      const id = args.id || args.agentId;
      if (method === "openAgentTail") follow(id);
      const generation = streamGeneration, ordered = id === currentSelectedAgentId ? transcriptStamp(id) : null;
      const data = await api("messages", { thread: threadOf(id), limit: Math.min(500, args.limit || 100), ...(args.beforeSeq ? { before: args.beforeSeq } : {}) });
      if (method === "openAgentTail") await api("read", { thread: threadOf(id) });
      const rows = (data.messages || []).flatMap((message) => projectEntries(message));
      if (id === currentSelectedAgentId && generation === streamGeneration && (args.beforeSeq || ordered.sequence === transcriptSequence))
        for (const row of rows) entries.set(row.id, row);
      void hydrateEntries(rows, id, generation);
      return { entries: rows, nextBeforeSeq: data.nextBeforeSeq ?? (data.hasMore ? data.messages[0]?.seq ?? null : null),
        ...(ordered ? { ordered } : {}) };
    }
    if (method === "respondToWidget") {
      const taskId = taskRef(args.entryId);
      if (!taskId || (args.value !== "approve" && args.value !== "reject")) throw new Error(taskId ? "未知的确认选项" : "这条确认不属于 Vega 任务");
      await api("control", { thread: threadOf(args.agentId), id: taskId, action: "approve", approved: args.value === "approve" });
      const entry = entries.get(args.entryId);
      if (entry) entry.respondedValue = args.value;
      if (currentSelectedAgentId) {
        publishTranscript(currentSelectedAgentId);
        await refreshTranscript(currentSelectedAgentId, streamGeneration);
        await refreshRoster();
      }
      return { ok: true };
    }
    if (method === "submitUserForm") {
      const taskId = taskRef(args.entryId);
      const text = typeof args.values?.answer === "string" ? args.values.answer.trim() : "";
      if (!taskId) throw new Error("这条补充不属于 Vega 任务");
      if (!text) throw new Error("请填写回复");
      if ([...text].length > 8000) throw new Error("回复不能超过 8000 字");
      await api("control", { thread: threadOf(args.agentId), id: taskId, action: "answer", text });
      const entry = entries.get(args.entryId);
      if (entry) entry.formResolution = "submitted";
      if (currentSelectedAgentId) {
        publishTranscript(currentSelectedAgentId);
        await refreshTranscript(currentSelectedAgentId, streamGeneration);
        await refreshRoster();
      }
      return { ok: true };
    }
    if (method === "dismissUserForm") {
      const entry = entries.get(args.entryId);
      if (entry) entry.formResolution = "dismissed";
      if (currentSelectedAgentId) publishTranscript(currentSelectedAgentId);
      return { ok: true };
    }
    if (method === "sendPrompt") {
      if (args.attachmentPaths?.length || args.sessionId || args.taskId || args.isFork)
        throw unavailable("带本地路径、分支或任务线程的发送");
      let quoteSeq;
      if (args.replyToId) {
        const match = /^entry-(\d+)$/.exec(String(args.replyToId));
        if (!match) throw new Error("无法引用这条消息");
        quoteSeq = Number(match[1]);
      }
      const images = [], files = [];
      for (const item of args.attachments || []) {
        const data = item?.data || item?.base64;
        if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw unavailable("本地路径附件");
        const mime = typeof item.mime === "string" && item.mime ? item.mime : "application/octet-stream";
        if (mime.startsWith("image/")) images.push({ mime, data });
        else files.push({ name: item.name || item.file_name || "file", mime, data });
      }
      await api("send", { thread: threadOf(args.agentId), text: args.prompt || args.text || "", clientMessageId: args.clientNonce,
        ...(quoteSeq ? { quoteSeq } : {}), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) });
      return { accepted: true };
    }
    if (method === "promptAcceptanceStatus") return api("acceptance", { thread: threadOf(args.agentId), clientMessageId: args.clientNonce });
    if (method === "createAgent") {
      if (args.harness === "box" || args.creationRoute?.kind === "box" || args.purpose || args.templateId || args.avatarPngBase64)
        throw unavailable("特殊宿主、模板或图片头像的 Bot 创建");
      const result = await api("create", { name: args.name || "新 Bot", instruction: args.description || "", clientNonce: args.clientNonce,
        ...(args.avatarShape && args.avatarColor ? { avatar: `bot:${args.avatarShape}:${args.avatarColor}` } : {}) });
      const agent = (await refreshRoster()).find((agent) => agent.id === result.id);
      if (!agent) throw new Error("Bot 已创建，但列表尚未确认，请刷新，不要重复创建");
      return { agent, transcript: [] };
    }
    if (method === "updateAgent") {
      const profile = args.profile || {};
      const fields = args.editedFields || Object.keys(profile);
      if (fields.some((field) => !["name", "description", "avatarShape", "avatarColor"].includes(field))) throw unavailable("此 Bot 资料字段");
      const current = (await api("threads")).employees.find((employee) => employee.id === args.id);
      if (!current) throw new Error("Bot 不存在");
      const shape = profile.avatarShape ?? current.botAvatar?.shape;
      const color = profile.avatarColor ?? current.botAvatar?.color;
      const result = await api("update", { thread: threadOf(args.id),
        ...(profile.name === undefined ? {} : { name: profile.name }),
        ...(profile.description === undefined ? {} : { instruction: profile.description }),
        ...(profile.avatarShape !== undefined || profile.avatarColor !== undefined ? { avatar: `bot:${shape}:${color}` } : {}) });
      return (await refreshRoster()).find((agent) => agent.id === result.id) || null;
    }
    if (method === "setAgentUnread") {
      if (args.isUnread) throw unavailable("标为未读");
      return api("read", { thread: threadOf(args.id) });
    }
    if (method === "interruptAgentRun") {
      if (args.sessionId) throw unavailable("停止分支或任务线程");
      return api("cancel", { thread: threadOf(args.id) });
    }
    if (method === "seedConversationName") return { outcome: "unchanged" };
    if (method === "kickstartAgent") return null;
    throw unavailable(method);
  }

  // 4. 构建 window.desktop (Electron 兼容层)
  const desktop = {
    boot: {
      theme: readTheme(),
      language: readLanguage(),
      isAssistiveTechEnabled: false,
      isEgressTunnelEnabled: false,
      isWebauthnProxyEnabled: false,
      isBotColorInChatEnabled: localStorage.getItem("vega-bot-color") !== "false",
      egressTunnelStatus: "inactive",
      mainEdge: "served",
      rosterPhotos: null,
      computerUseHelperName: null,
      // Match the original renderer's typography and chat-layout release, not unrelated product gates.
      experiments: {
        isInitialized: true,
        featureGates: {
          sand_xvf_typeface: true,
          sand_chat_prose_15px: true,
          grok_bot_page_stage_chat: true,
          grok_bot_all_bots_color_theming: true,
          grok_bot_full_view_stage: false,
          grok_bot_stage_inset_modal: false,
          grok_bot_files_stage: true,
          grok_bot_library_pages: true,
          grok_bot_pages_search: true,
          sand_chat_popout: true,
          sand_grok_main_agent: true,
        },
      },
    },
    environment: {
      platform: "win32",
      isDev: false,
      isWaylandClient: false,
      usesProductionBackend: false,
      devVoiceHarness: "package",
    },
    local: {
      getZoomFactor: zoomFactor,
      noteRendererAlive: () => {},
      noteBootGateLanded: () => {},
      noteBootGateOpened: () => {},
      stageAttachmentFile: async () => { throw unavailable("附件上传"); },
    },
    main: new Proxy(
      {},
      {
        get: function (target, prop) {
          if (prop === "subscribe") return (handlers) => {
            subscriptions.add(handlers);
            return () => subscriptions.delete(handlers);
          };
          return async function (args) {
            if (prop === "hasMigratedClientPersistence") return true;
            if (prop === "readManyClientPersistence") {
              const matches = (key, prefixes) => Math.max(-1, ...prefixes.filter((prefix) => key.startsWith(prefix)).map((prefix) => prefix.length));
              return Object.fromEntries(Object.keys(localStorage)
                .filter((key) => key.startsWith(persistenceKey("")))
                .map((key) => [key.slice(persistenceKey("").length), localStorage.getItem(key)])
                .filter(([key]) => matches(key, args.include) >= 0 && matches(key, args.include) >= matches(key, args.exclude)));
            }
            if (prop === "readClientPersistence") {
              return localStorage.getItem(persistenceKey(args?.key));
            }
            if (prop === "writeClientPersistence") {
              localStorage.setItem(persistenceKey(args?.key), args?.value || "");
              return;
            }
            if (prop === "removeClientPersistence") {
              localStorage.removeItem(persistenceKey(args?.key));
              return;
            }
            if (prop === "listClientPersistenceKeys") {
              const prefix = args?.prefix || "";
              const keys = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith("sand_client_p_" + prefix)) {
                  keys.push(k.replace("sand_client_p_", ""));
                }
              }
              return keys;
            }
            if (prop === "getThemeState") return desktop.boot.theme;
            if (prop === "setThemePreference") {
              if (!["system", "light", "dark"].includes(args?.preference)) throw new Error("Invalid theme preference");
              localStorage.setItem("vega-theme-preference", args.preference);
              updateTheme();
              return desktop.boot.theme;
            }
            if (prop === "getExperimentsSnapshot") return desktop.boot.experiments;
            if (prop === "minimizeWindow") return nativeWindow("minimize");
            if (prop === "toggleMaximizeWindow") return nativeWindow("toggle-maximize");
            if (prop === "closeWindow") return nativeWindow("close");
            if (prop === "getLanguageState") return desktop.boot.language;
            if (prop === "setLanguagePreference") {
              if (args?.preference !== "system" && !languages.includes(args?.preference)) throw new Error("Invalid language preference");
              localStorage.setItem("vega-language-preference", args.preference);
              desktop.boot.language = readLanguage();
              emit("language-changed", desktop.boot.language);
              return desktop.boot.language;
            }
            if (prop === "getBotColorInChatEnabled") return localStorage.getItem("vega-bot-color") !== "false";
            if (prop === "setBotColorInChatEnabled") {
              if (typeof args?.enabled !== "boolean") throw new Error("Invalid bot color preference");
              localStorage.setItem("vega-bot-color", String(args.enabled));
              desktop.boot.isBotColorInChatEnabled = args.enabled;
              return;
            }
            if (prop === "setTitleBarOverlayTone") {
              if (typeof args?.isOverlayTone !== "boolean") throw new Error("Invalid overlay tone");
              const controls = document.getElementById("vega-window-controls");
              if (controls) controls.dataset.overlayTone = String(args.isOverlayTone);
              return;
            }
            if (prop === "getEgressTunnelStatus") return "inactive";
            if (prop === "getEgressTunnelEnabled" || prop === "getEgressTunnelForcedByAdmin" || prop === "getWebauthnProxyEnabled") return false;
            if (prop === "getWindowState") return windowState;
            if (prop === "isWindowShown") return true;
            if (prop === "getCursorAuthStatus") {
              const user = await api("metadata");
              return { kind: "logged-in", authId: user.id, displayName: user.name, profileReady: true };
            }
            if (prop === "getCursorLoginFlight") return { kind: "idle" };
            if (prop === "getOnboardingSeen") return true;
            if (prop === "getSandAccess" || prop === "getSandAccessFresh") return { state: "granted" };
            if (prop === "getGrokBotTermsRecord") return { seenAtMs: 0 };
            if (prop === "getCursorSelectedTeam") return { selectedTeamId: null, fallback: null };
            if (prop === "getHostSidebarSections") return [];
            if (prop === "listSecrets") return { keys: [] };
            if (prop === "getBoxHostPhase") return "settled";
            if (prop === "getLocalPitmanState") return { isRecorderReady: false, session: null };
            if (prop === "getCursorTrainingSetting") return "disallowed";
            if (prop === "getGrokBotUserProfile") {
              const user = await api("metadata");
              return { id: user.id, username: user.name, name: user.name, avatarUrl: null };
            }
            if (prop === "getVegaSettings") return api("settings", {});
            if (prop === "saveVegaBotSettings") return api("settings", { save: "bot", bot: args?.bot || args });
            if (prop === "saveVegaSceneSettings") return api("settings", { save: "scenes", scenes: args?.scenes || args });
            if (prop === "saveVegaSchedulerSettings") return api("settings", { save: "scheduler", scheduler: args?.scheduler || args });
            if (prop === "openVegaSettings") return openVegaSettings();
            if (prop === "updateGrokBotAgent") {
              if (args.avatarPngBase64 !== undefined) throw unavailable("自定义图片头像");
              const result = await dispatchCoordinatorRequest("updateAgent", { id: args.serverId, profile: args.changed?.fields || args.changed || args });
              return { updatedAtMs: result?.updatedAt || 0 };
            }
            if (prop === "getHostPinnedAgents" || prop === "getServerPinnedAgents") {
              const stored = localStorage.getItem("vega-pinned-agents");
              if (stored !== null) return JSON.parse(stored);
              const roster = await dispatchCoordinatorRequest("getServerAgentRoster", {});
              return roster.agents.length ? [roster.agents[0].id] : [];
            }
            if (prop === "setHostPinnedAgents") {
              if (!Array.isArray(args?.pinnedAgentIds) || args.pinnedAgentIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 64)) throw new Error("Invalid pinned agents");
              const ids = [...new Set(args.pinnedAgentIds)];
              localStorage.setItem("vega-pinned-agents", JSON.stringify(ids));
              return ids;
            }
            if (prop === "listGrokBotTeamAgents") return [];
            if (prop === "getCredentialsState") {
              return { hasValidCredentials: true };
            }
            if (prop === "getMcpState") {
              return { servers: [] };
            }
            if (prop === "getUpdateStatus") {
              return {
                state: { type: "disabled", reason: "not-packaged" },
                delivery: "in-app", currentVersion: "Vega", currentTrack: "stable",
                trackOverride: null, buildDefaultTrack: null, availableTracks: ["stable"],
                isTrackManagedByPolicy: false, isBelowMinimumVersion: false, autoUpdateWhenIdle: false,
              };
            }
            if (/^(get|list|read|is|has)/.test(String(prop))) return null;
            if (/^(note|report|log)/.test(String(prop))) return;
            throw unavailable(String(prop));
          };
        },
      }
    ),
  };

  // 5. 构建 window.coordinatorPort
  const coordinatorPort = {
    claim: function (handler) {
      coordinatorPortHandler = handler;
      setTimeout(() => {
        if (coordinatorPortHandler && coordinatorPortHandler.onPort) {
          coordinatorPortHandler.onPort({
            accountSlot: "vega-local",
            postMessage: (msg) => clientPort.postMessage(msg),
            close: () => clientPort.close(),
            start: () => clientPort.start(),
            addEventListener: (type, listener) => clientPort.addEventListener(type, listener),
          });
        }
      }, 0);
      return {
        request: () => {},
        release: stopStream,
      };
    },
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  const configHref = () => {
    const token = window.location.pathname.split("/").filter(Boolean)[1] || "";
    return token ? `/config/${encodeURIComponent(token)}` : "";
  };
  async function vegaSettingsMarkup() {
    let settings = { bots: [], admin: false, role: "" }, error = "";
    try { settings = await api("settings", {}); }
    catch (reason) { error = reason.message || String(reason); }
    const role = settings.role === "admin" ? "管理员" : settings.role === "viewer" ? "只读" : settings.role ? "普通用户" : "未知";
    const bots = (settings.bots || []).map((bot) => `<form data-bot="${esc(bot.id)}">
      <h3>${esc(bot.name || "牛马")}</h3>
      <label>工作原则<textarea name="instruction" maxlength="8000"${bot.editable ? "" : " disabled"}>${esc(bot.instruction || "")}</textarea></label>
      <small>保存后，新任务会使用更新的工作原则。最多 8000 字。</small>
      <label>工作目录<input name="cwd" maxlength="4096" value="${esc(bot.cwd || "")}"${bot.editable ? "" : " disabled"}></label>
      <small>留空表示不修改。</small>
      <label>桌面空闲多少分钟后可以接管<input name="idleMinutes" type="number" min="0" max="120" value="${Number(bot.idleMinutes) || 0}"${bot.editable ? "" : " disabled"}></label>
      <label>接管确认等待秒数<input name="takeoverSeconds" type="number" min="1" max="120" value="${Number(bot.takeoverSeconds) || 15}"${bot.editable ? "" : " disabled"}></label>
      ${bot.editable ? `<div class="row"><button type="submit">保存工作原则</button></div>` : `<small>只有这位牛马的主人可以修改。</small>`}
    </form>`).join("");
    const sceneBlock = (key, label, hint) => {
      const rows = (settings.scenes?.[key] || []).map((row, index) => `<div class="row"><input data-scene="${key}" data-index="${index}" value="${esc(row.model || "")}" aria-label="${esc(label)}模型 ${index + 1}">${key === "computer" ? "" : `<label><input type="checkbox" data-spawn="${key}" data-index="${index}"${row.allowSpawn ? " checked" : ""}>允许开启分身</label>`}</div>`).join("");
      return `<h3>${label}</h3><small>${hint}</small>${rows}<input data-scene-add="${key}" placeholder="添加模型 ID" aria-label="添加${label}模型">`;
    };
    const models = (settings.models || []).map((model) => esc(model.id)).slice(0, 12).join("、");
    const providers = (settings.providers || []).map((provider) => esc(provider.name || provider.id)).join("、");
    const admin = settings.admin ? `<h2>场景模型</h2><small>每个场景必须单独配置模型，不再使用默认模型回退。${models ? `已有模型：${models}` : "模型 ID 形如服务商/模型。"}</small>
      <form data-scenes="1">${sceneBlock("lightweight", "沟通与任务起步", "新任务与沟通会话从这里起步。")}${sceneBlock("coding", "编码", "实际进入编码工作时才升级。")}${sceneBlock("computer", "浏览器操作", "仅应填写支持图片的模型，不能开启分身。")}<div class="row"><button type="submit">保存场景</button></div></form>
      <h2>任务调度</h2><small>全站上限与单牛马上限同时生效，范围 1–64，默认各为 3。</small>
      <form data-scheduler="1"><label>全站同时执行上限<input name="globalSlots" type="number" min="1" max="64" value="${Number(settings.scheduler?.globalSlots) || 3}"></label>
      <label>单牛马同时执行上限<input name="perEmployeeSlots" type="number" min="1" max="64" value="${Number(settings.scheduler?.perEmployeeSlots) || 3}"></label>
      <div class="row"><button type="submit">保存调度</button></div></form>
      <h2>服务商</h2><small>只显示名称，密钥不进入客户端。${providers || "还没有服务商。请在网页设置里添加。"}</small>`
      : `<small>场景模型、任务调度和服务商只有管理员可以修改。</small>`;
    const link = configHref();
    return `<h2>设置</h2><p>当前身份：${esc(role)}。</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <small>已停用的工作职责不在这里恢复。密码本属于账号，不在客户端展开，以免把密钥带到这台电脑的页面上。</small>
      ${link ? `<p><a href="${esc(link)}">本机连接、浏览器和蝴蝶</a></p>` : ""}
      <h2>工作原则</h2>${bots || "<small>还没有你能查看的牛马。</small>"}${admin}
      <div class="row"><button type="button" class="secondary" data-close="1">关闭</button></div>`;
  }
  function bindVegaSettings(sheet) {
    sheet.querySelector("[data-close]")?.addEventListener("click", () => { sheet.hidden = true; });
    for (const form of sheet.querySelectorAll("form")) form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveVegaSettingsForm(form, sheet);
    });
  }
  async function saveVegaSettingsForm(form, sheet) {
    const show = (message) => {
      let node = sheet.querySelector(".error");
      if (!node && typeof document.createElement === "function") {
        node = document.createElement("p");
        node.className = "error";
        node.setAttribute("role", "alert");
        sheet.prepend(node);
      }
      if (node) node.textContent = message;
    };
    try {
      if (form.dataset.bot) {
        const bot = { id: form.dataset.bot, instruction: form.instruction.value, idleMinutes: Number(form.idleMinutes.value), takeoverSeconds: Number(form.takeoverSeconds.value) };
        if (form.cwd.value.trim()) bot.cwd = form.cwd.value.trim();
        await api("settings", { save: "bot", bot });
      } else if (form.dataset.scenes != null) {
        const scenes = {};
        for (const key of ["lightweight", "coding", "computer"]) {
          const rows = [...form.querySelectorAll(`[data-scene="${key}"]`)].flatMap((input) => {
            const model = input.value.trim();
            if (!model) return [];
            const spawn = form.querySelector(`[data-spawn="${key}"][data-index="${input.dataset.index}"]`);
            return [key !== "computer" && spawn?.checked ? { model, allowSpawn: true } : { model }];
          });
          const extra = form.querySelector(`[data-scene-add="${key}"]`)?.value.trim();
          if (extra) rows.push({ model: extra });
          scenes[key] = rows;
        }
        await api("settings", { save: "scenes", scenes });
      } else await api("settings", { save: "scheduler", scheduler: { globalSlots: Number(form.globalSlots.value), perEmployeeSlots: Number(form.perEmployeeSlots.value) } });
      sheet.innerHTML = await vegaSettingsMarkup();
      bindVegaSettings(sheet);
    } catch (reason) { show(reason.message || String(reason)); }
  }
  async function openVegaSettings() {
    const html = await vegaSettingsMarkup();
    if (typeof document.createElement !== "function" || !document.body?.append) return html;
    let sheet = document.getElementById("vega-settings");
    if (!sheet) {
      sheet = document.createElement("section");
      sheet.id = "vega-settings";
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-label", "设置");
      document.body.append(sheet);
    }
    sheet.hidden = false;
    sheet.innerHTML = html;
    bindVegaSettings(sheet);
    return html;
  }
  function updateTheme() {
    desktop.boot.theme = readTheme();
    nativeWindow(`theme-${desktop.boot.theme.resolved}`);
    document.documentElement?.style.setProperty("--vega-caption-symbol", desktop.boot.theme.resolved === "dark" ? "#fff" : "#000");
    emit("theme-changed", desktop.boot.theme);
  }
  systemTheme?.addEventListener("change", updateTheme);
  let lastZoom = zoomFactor();
  const updateZoom = () => {
    const factor = zoomFactor();
    if (factor !== lastZoom) {
      lastZoom = factor;
      emit("zoom-factor-changed", { factor });
    }
  };
  window.addEventListener?.("resize", updateZoom);
  window.addEventListener?.("vega-window-state", ({ detail }) => {
    windowState = { isFullscreen: false, isMaximized: detail.isMaximized };
    emit("window-state", windowState);
    updateZoom();
    const button = document.getElementById("vega-window-maximize");
    if (button) {
      button.setAttribute("aria-label", detail.isMaximized ? "还原窗口" : "最大化");
      button.dataset.maximized = String(detail.isMaximized);
    }
  });

  // WebView2 has no Electron titlebar overlay or draggable-region handling.
  if (window.chrome?.webview) {
    nativeWindow(`theme-${desktop.boot.theme.resolved}`);
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `
        #vega-window-controls{position:fixed;z-index:2147483647;right:0;top:0;display:flex;width:calc(186px / var(--sand-zoom-factor,1));height:calc(51px / var(--sand-zoom-factor,1));color:var(--vega-caption-symbol,#000);background:var(--sand-bg-chrome)}
        #vega-settings{position:fixed;z-index:2147483646;top:calc(51px / var(--sand-zoom-factor,1));right:0;bottom:0;width:min(420px,100%);overflow:auto;padding:16px 16px 28px;color:inherit;background:var(--sand-bg-chrome);border-left:1px solid color-mix(in srgb,currentColor 16%,transparent);font:inherit}
        #vega-settings h2{margin:0 0 8px;font-size:15px;font-weight:600}
        #vega-settings h3{margin:16px 0 6px;font-size:13px;font-weight:600}
        #vega-settings p,#vega-settings small{color:color-mix(in srgb,currentColor 72%,transparent)}
        #vega-settings small{display:block;margin:0 0 8px;line-height:1.45}
        #vega-settings label{display:block;margin:8px 0 4px;font-size:12px;font-weight:600}
        #vega-settings input,#vega-settings textarea{width:100%;box-sizing:border-box;margin:0 0 8px;padding:8px 10px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit}
        #vega-settings textarea{min-height:72px;resize:vertical}
        #vega-settings input[type=number]{width:96px}
        #vega-settings .row{display:flex;gap:8px;align-items:center;margin:8px 0 12px}
        #vega-settings button{font:inherit;padding:8px 12px;border:0;border-radius:8px;background:currentColor;color:var(--sand-bg-chrome);cursor:default}
        #vega-settings button.secondary{background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 24%,transparent)}
        #vega-settings .error{color:#c42b1c}
        #vega-window-controls[data-overlay-tone=true]{height:calc(43px / var(--sand-zoom-factor,1));background:#141414;color:#fff}
        #vega-window-controls button{all:unset;box-sizing:border-box;display:grid;place-content:center;flex:1;cursor:default}
        #vega-window-controls button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
        #vega-window-controls button:focus-visible{outline:2px solid currentColor;outline-offset:-3px}
        #vega-window-controls button:last-child:hover{background:#c42b1c;color:#fff}
        #vega-window-controls svg{width:calc(10px / var(--sand-zoom-factor,1));height:calc(10px / var(--sand-zoom-factor,1));fill:none;stroke:currentColor;stroke-width:1}
        #vega-window-maximize .restore{display:none}
        #vega-window-maximize[data-maximized=true] .maximize{display:none}
        #vega-window-maximize[data-maximized=true] .restore{display:block}
      `;
      const controls = document.createElement("div");
      controls.id = "vega-window-controls";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "窗口控制");
      for (const [action, label, shape] of [
        ["settings", "设置", '<circle cx="5" cy="5" r="1.6"/><path d="M5 .8v1.2M5 8v1.2M.8 5h1.2M8 5h1.2M2 2l.9.9M7.1 7.1 8 8M2 8l.9-.9M7.1 2.9 8 2"/>'],
        ["minimize", "最小化", '<path d="M0 5h10"/>'],
        ["toggle-maximize", "最大化", '<rect class="maximize" x=".5" y=".5" width="9" height="9" rx=".8"/><g class="restore"><path d="M2.5 2.5v-2h7v7h-2"/><rect x=".5" y="2.5" width="7" height="7" rx=".8"/></g>'],
        ["close", "关闭窗口", '<path d="m.5.5 9 9m0-9-9 9"/>'],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", label);
        if (action === "toggle-maximize") button.id = "vega-window-maximize";
        button.innerHTML = `<svg viewBox="0 0 10 10" aria-hidden="true">${shape}</svg>`;
        button.addEventListener("click", () => { if (action === "settings") void openVegaSettings(); else nativeWindow(action); });
        controls.append(button);
      }
      document.head.append(style);
      document.body.append(controls);
      document.documentElement.style.setProperty("--vega-caption-symbol", desktop.boot.theme.resolved === "dark" ? "#fff" : "#000");
    }, { once: true });
    document.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (!windowState.isMaximized) {
        const edge = 6 / zoomFactor();
        const horizontal = event.clientX < edge ? "left" : event.clientX >= window.innerWidth - edge ? "right" : "";
        const vertical = event.clientY < edge ? "top" : event.clientY >= window.innerHeight - edge ? "bottom" : "";
        if (vertical || horizontal) {
          event.preventDefault();
          nativeWindow(`resize-${vertical}${horizontal}`);
          return;
        }
      }
      if (event.target.closest("button,input,textarea,select,a,[contenteditable=true]")) return;
      for (let element = event.target; element; element = element.parentElement) {
        const css = getComputedStyle(element);
        const appRegion = css.getPropertyValue("app-region") || css.getPropertyValue("-webkit-app-region");
        // WebView2 reports "none" for Electron drag regions, so resolve the original classes too.
        const region = ["drag", "no-drag"].includes(appRegion) ? appRegion :
          element.matches(".sand-avu8j0,.sand-1wfn6di,.ui-avu8j0") ? "drag" :
            element.matches(".sand-lvsv26,.sand-482pwi,.ui-lvsv26") ? "no-drag" :
              element.matches(".sand-1a4o4su,.sand-17v0fby") ? css.getPropertyValue("--sand-app-region").trim() : "";
        if (!region) continue;
        if (region === "drag") {
          event.preventDefault();
          nativeWindow(event.detail === 2 ? "toggle-maximize" : "drag");
        }
        break;
      }
    });
  }

  // 注入全局对象
  window.desktop = desktop;
  window.coordinatorPort = coordinatorPort;
  window.sandPopout = { agentId: null };
  window.sandSpotlight = { isSpotlight: false };
  // 未实现的可选 Electron 能力不要声明，渲染器会据此跳过它们。

  console.log("[Vega Grok Bridge] Injected successfully.");
})();
