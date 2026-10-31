<script setup vapor>
import SettingsView from "./SettingsView.vue";
import MessageText from "./MessageText.vue";
import ToolSteps from "./ToolSteps.vue";
import ExperiencesView from "./ExperiencesView.vue";
import { formatBeijing } from "../../shared/time";
import Team from "./Team.vue";
import EmployeeSessionView from "./EmployeeSessionView.vue";
import BrowserView from "./BrowserView.vue";
import Accounts from "./Accounts.vue";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
const confirm = window.confirm.bind(window);
const narrow = ref(false),
  navigationOpen = ref(false),
  navigation = ref(null),
  menuButton = ref(null),
  imageInput = ref(null),
  uploading = ref(false);
const mobileTitles = {
  chat: "对话",
  employee: "数字员工",
  browser: "浏览器",
  experiences: "经验图谱",
  account: "账号",
  settings: "设置",
};
function closeNavigation() {
  if (!navigationOpen.value) return;
  navigationOpen.value = false;
  nextTick(() => menuButton.value?.focus());
}
async function openNavigation() {
  navigationOpen.value = true;
  await nextTick();
  navigation.value?.querySelector("button")?.focus();
}
function navigationKey(event) {
  if (!navigationOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeNavigation();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [
    ...navigation.value.querySelectorAll(
      "button:not(:disabled),a[href],input,select",
    ),
  ].filter((el) => el.getClientRects().length);
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
onMounted(() => {
  const media = window.matchMedia("(max-width: 760px)"),
    viewport = window.visualViewport;
  const layout = () => {
    narrow.value = media.matches;
    if (!media.matches) closeNavigation();
    if (!viewport || viewport.scale === 1) {
      document.documentElement.style.setProperty(
        "--app-height",
        `${viewport?.height || window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--app-top",
        `${viewport?.offsetTop || 0}px`,
      );
    }
  };
  layout();
  media.addEventListener("change", layout);
  window.addEventListener("resize", layout);
  viewport?.addEventListener("resize", layout);
  viewport?.addEventListener("scroll", layout);
  onBeforeUnmount(() => {
    media.removeEventListener("change", layout);
    window.removeEventListener("resize", layout);
    viewport?.removeEventListener("resize", layout);
    viewport?.removeEventListener("scroll", layout);
    document.documentElement.style.removeProperty("--app-height");
    document.documentElement.style.removeProperty("--app-top");
  });
});
const user = ref(null),
  csrfToken = ref(""),
  setupRequired = ref(false),
  username = ref(""),
  password = ref(""),
  setupToken = ref(""),
  authBusy = ref(false);
const isAdmin = computed(() => user.value?.role === "admin"),
  canExecute = computed(() => !!user.value && user.value.role !== "viewer");
const canWriteCurrent = computed(
  () =>
    canExecute.value &&
    !sessionLoading.value &&
    !current.value?.taskId &&
    (!current.value ||
      isAdmin.value ||
      current.value.ownerId === user.value?.id),
);
const authenticated = ref(false),
  error = ref(""),
  notice = ref(""),
  view = ref("chat");
watch(view, closeNavigation);
const sessions = ref([]),
  current = ref(null),
  messages = ref([]),
  sessionLoading = ref(false),
  folds = ref([]),
  running = ref({}),
  draft = ref(""),
  attachments = ref([]),
  sending = ref(false);
const contextBudget = ref(null),
  fireState = ref(null);
const live = ref(""),
  thinking = ref(""),
  model = ref(""),
  activeTools = ref([]),
  transcript = ref(null),
  project = ref(""),
  chosenModel = ref(""),
  config = ref({});
const employee = ref({
    duties: [],
    tasks: [],
    memories: [],
    runs: [],
  }),
  employeeTab = ref("tasks"),
  employeeSession = ref(""),
  employeeSessionVersion = ref(0),
  employeeError = ref(""),
  taskText = ref(""),
  taskProfile = ref("lightweight"),
  memoryText = ref(""),
  memoryID = ref(""),
  importance = ref(1),
  activeTaskCount = ref(null);
const duty = ref(emptyDuty()),
  dutyOpen = ref(false),
  vault = ref([]),
  vaultForm = ref({ name: "", condition: "", content: "" });
let eventsSocket,
  eventsReady = false,
  eventsWasConnected = false,
  eventGeneration = 0,
  eventReconnect,
  eventsHeartbeat,
  eventQueue = Promise.resolve(),
  wsRequestSerial = 0,
  closed = false,
  sessionRequest = 0,
  employeeRefreshTimer;
const wsRequests = new Map(),
  WS_BODY_LIMIT = 240 * 1024;
function emptyDuty() {
  return {
    id: "",
    text: "",
    note: "",
    profile: "lightweight",
    trigger: "manual",
    times: "09:00",
    everyMinutes: 60,
    nextAt: "",
    enabled: true,
  };
}
const isRunning = computed(
  () => current.value && running.value[current.value.id],
);
const timeline = computed(() => {
  const groups = [];
  for (const m of messages.value) {
    const last = groups.at(-1);
    if (m.role === "tool") {
      if (last?.kind === "tools") last.items.push(m);
      else
        groups.push({
          kind: "tools",
          key: `tools-${m.seq ?? groups.length}`,
          items: [m],
        });
    } else
      groups.push({
        kind: "message",
        key: `${m.role}-${m.seq ?? groups.length}`,
        message: m,
      });
  }
  return groups;
});
const catalogModels = ref([]);
function configuredModels(models, prefix = "") {
  return Object.entries(models || {}).flatMap(([id, m]) =>
    Object.keys(m || {}).some((k) =>
      [
        "limit",
        "api",
        "name",
        "reasoning",
        "options",
        "supportsImages",
        "variants",
        "modalities",
        "contextWindow",
        "maxOutputTokens",
      ].includes(k),
    ) || !Object.keys(m || {}).length
      ? [prefix + id]
      : configuredModels(m, prefix + id + "/"),
  );
}
const models = computed(() => [
  ...new Set([
    ...catalogModels.value
      .filter((m) => m.id && m.available !== false)
      .flatMap((m) => [
        m.id,
        ...(m.variants || []).map((v) => m.id + "/variant/" + v),
      ]),
    ...Object.entries(config.value.provider || {}).flatMap(([id, p]) =>
      configuredModels(p.models).map((m) => id + "/" + m),
    ),
  ]),
]);
async function loadModels() {
  if (!canExecute.value) {
    catalogModels.value = [];
    return;
  }
  catalogModels.value = await api("/providers/models");
}
function providerSaved(value) {
  config.value = value;
  void attempt(loadModels);
}
let activityAt = Date.now(),
  presenceTimer;
const userActive = () => (activityAt = Date.now());
function stopPresence() {
  clearInterval(presenceTimer);
  window.removeEventListener("pointerdown", userActive);
  window.removeEventListener("keydown", userActive);
}
function startPresence() {
  stopPresence();
  window.addEventListener("pointerdown", userActive, { passive: true });
  window.addEventListener("keydown", userActive);
  presenceTimer = setInterval(() => {
    if (authenticated.value && isAdmin.value)
      void api("/employee/activity", "POST", {
        idleMs: Date.now() - activityAt,
      }).catch(() => {});
  }, 10000);
}
onBeforeUnmount(stopPresence);
const activeTasks = computed(() =>
  (employee.value.tasks || []).filter((t) => !ended(t.status)),
);
const historyTasks = computed(() =>
  (employee.value.tasks || []).filter((t) => ended(t.status)).toReversed(),
);
const labels = {
  queued: "排队中",
  running: "执行中",
  deferred: "等外部结果",
  waiting: "需要信息",
  approval: "需要确认",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  stopped: "已停止",
  pending: "待执行",
  in_progress: "执行中",
  completed: "已完成",
  blocked: "受阻",
};
function ended(s) {
  return ["done", "failed", "cancelled", "stopped"].includes(s);
}
function date(at) {
  return formatBeijing(at);
}
async function httpApi(path, method = "GET", data) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(!["GET", "HEAD"].includes(method) && csrfToken.value
        ? { "X-CSRF-Token": csrfToken.value }
        : {}),
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (response.status === 401 && authenticated.value) resetLogin();
  if (!response.ok)
    throw Error(
      result.data?.error ||
        result.statusMessage ||
        result.message ||
        (typeof result.error === "string" ? result.error : "") ||
        response.statusText,
    );
  return result;
}
async function api(path, method = "GET", data) {
  const size = data === undefined ? 0 : new Blob([JSON.stringify(data)]).size;
  if (
    size > WS_BODY_LIMIT ||
    /^\/(auth|blobs)(\/|$)/.test(path) ||
    path === "/chrome/live"
  )
    return httpApi(path, method, data);
  if (eventsReady && eventsSocket?.readyState === WebSocket.OPEN)
    return new Promise((resolve, reject) => {
      const id = String(++wsRequestSerial),
        timer = setTimeout(() => {
          wsRequests.delete(id);
          reject(
            Error(
              method === "GET"
                ? "实时请求超时"
                : "操作结果不确定，请核对后再操作，不要重复提交",
            ),
          );
        }, 60000);
      wsRequests.set(id, { resolve, reject, timer, path, method, data });
      try {
        eventsSocket.send(
          JSON.stringify({ type: "request", id, method, path, data }),
        );
      } catch (e) {
        clearTimeout(timer);
        wsRequests.delete(id);
        reject(e);
      }
    });
  if (eventsWasConnected && method !== "GET")
    throw Error("实时连接中断，请等待重连后再操作，不要重复提交");
  return httpApi(path, method, data);
}
function rejectSocketRequests(reason) {
  for (const request of wsRequests.values()) {
    clearTimeout(request.timer);
    request.reject(
      Error(
        request.method === "GET"
          ? reason
          : "连接中断，操作结果可能已提交，请核对后再操作",
      ),
    );
  }
  wsRequests.clear();
}
function socketMessage(value) {
  if (value.type === "response") {
    const request = wsRequests.get(value.id);
    if (!request) return;
    wsRequests.delete(value.id);
    clearTimeout(request.timer);
    if (value.httpFallback) {
      request.resolve(httpApi(request.path, request.method, request.data));
      return;
    }
    if (!value.status) {
      request.reject(Error(value.error || "实时请求失败"));
      return;
    }
    try {
      const result = value.body ? JSON.parse(value.body) : null;
      if (value.status === 401 && authenticated.value) resetLogin();
      if (value.status < 200 || value.status >= 300)
        throw Error(
          result?.data?.error ||
            result?.statusMessage ||
            result?.message ||
            (typeof result?.error === "string" ? result.error : "") ||
            value.statusText,
        );
      request.resolve(result);
    } catch (e) {
      request.reject(e);
    }
    return;
  }
  if (value.type === "error") {
    error.value = value.reason;
    return;
  }
  eventQueue = eventQueue
    .then(() => handleEvent(value))
    .catch((e) => (error.value = e.message));
}
function connectEvents() {
  const generation = ++eventGeneration;
  clearTimeout(eventReconnect);
  clearInterval(eventsHeartbeat);
  eventsReady = false;
  eventsSocket?.close();
  void httpApi("/events", "POST", {})
    .then(({ ticket }) => {
      if (generation !== eventGeneration) return;
      const url = new URL("/api/events", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      openEventSocket(url, generation);
    })
    .catch((e) => {
      if (generation !== eventGeneration || closed) return;
      error.value = `实时通道认证失败：${e.message}`;
      eventReconnect = setTimeout(() => {
        if (generation === eventGeneration) connectEvents();
      }, 1500);
    });
}
function openEventSocket(url, generation) {
  const ws = new WebSocket(url);
  eventsSocket = ws;
  ws.onopen = () => {
    if (generation !== eventGeneration) return;
    eventsHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "ping" }));
    }, 10000);
  };
  ws.onmessage = ({ data }) => {
    if (generation !== eventGeneration) return;
    try {
      const value = JSON.parse(data);
      if (value.type === "ready") {
        const reconnect = eventsWasConnected;
        eventsReady = true;
        eventsWasConnected = true;
        if (error.value.includes("实时")) error.value = "";
        if (reconnect)
          void attempt(async () => {
            await bootstrap();
            if (current.value) await refreshCurrent();
            if (view.value === "employee" && !employeeSession.value)
              await refreshEmployee();
          });
        return;
      }
      if (value.type !== "pong") socketMessage(value);
    } catch (e) {
      error.value = `实时消息无效：${e.message}`;
    }
  };
  ws.onerror = () => {
    if (generation === eventGeneration)
      error.value = "实时通道连接失败，请检查反向代理的 WebSocket 配置";
  };
  ws.onclose = (event) => {
    if (generation !== eventGeneration) return;
    eventsReady = false;
    clearInterval(eventsHeartbeat);
    rejectSocketRequests("实时连接已中断");
    if (closed || !authenticated.value) return;
    if (event.code === 4401) {
      resetLogin();
      error.value = "登录已过期或被撤销，请重新登录";
      return;
    }
    error.value = "实时连接中断，正在重连；未完成的操作不会自动重发。";
    eventReconnect = setTimeout(() => {
      if (generation === eventGeneration) connectEvents();
    }, 1500);
  };
}
async function attempt(fn) {
  error.value = "";
  notice.value = "";
  try {
    return await fn();
  } catch (e) {
    error.value = e.message;
  }
}
function toast(text) {
  notice.value = text;
}
async function bootstrap() {
  const b = await api("/bootstrap");
  user.value = b.user;
  sessions.value = (b.sessions || []).filter((session) => !session.taskId);
  running.value = b.running || {};
  config.value = b.config || {};
  if (!project.value) project.value = b.cwd;
  return b;
}
async function enter(result) {
  user.value = result.user;
  setupRequired.value = false;
  csrfToken.value = result.csrfToken;
  closed = false;
  authenticated.value = true;
  void connectEvents();
  await bootstrap();
  if (isAdmin.value) startPresence();
  await Promise.all([
    loadModels(),
    sessions.value.length ? selectSession(sessions.value[0]) : null,
  ]);
  try {
    const pending = JSON.parse(
      sessionStorage.getItem("vega:provider-login:" + user.value.id) || "null",
    );
    if (isAdmin.value && pending?.expires > Date.now()) view.value = "settings";
  } catch {}
  closed = false;
}
async function login() {
  if (authBusy.value) return;
  authBusy.value = true;
  await attempt(async () => {
    const result = await api(
      setupRequired.value ? "/auth/setup" : "/auth/login",
      "POST",
      {
        username: username.value,
        password: password.value,
        ...(setupRequired.value ? { setupToken: setupToken.value } : {}),
      },
    );
    password.value = "";
    setupToken.value = "";
    await enter(result);
  });
  authBusy.value = false;
}
function resetLogin() {
  try {
    sessionStorage.removeItem("vega:provider-login:" + user.value?.id);
  } catch {}
  closeNavigation();
  stopPresence();
  clearTimeout(employeeRefreshTimer);
  closed = true;
  eventGeneration++;
  clearTimeout(eventReconnect);
  clearInterval(eventsHeartbeat);
  eventsSocket?.close();
  eventsSocket = null;
  eventsReady = false;
  eventsWasConnected = false;
  rejectSocketRequests("连接已关闭");
  authenticated.value = false;
  user.value = null;
  csrfToken.value = "";
  password.value = "";
  setupToken.value = "";
  current.value = null;
  sessionRequest++;
  sessionLoading.value = false;
  sessions.value = [];
  messages.value = [];
  folds.value = [];
  running.value = {};
  vault.value = [];
  config.value = {};
  catalogModels.value = [];
  activeTaskCount.value = null;
  employeeSession.value = "";
  employeeError.value = "";
  draft.value = "";
  attachments.value = [];
  view.value = "chat";
}
async function logout() {
  try {
    await api("/auth/logout", "POST", {});
  } finally {
    resetLogin();
  }
}
onMounted(
  () =>
    void attempt(async () => {
      const result = await api("/auth/me");
      setupRequired.value = result.setupRequired;
      if (result.user) await enter(result);
    }),
);
async function selectSession(session) {
  if (session.taskId) {
    openEmployee(session.id);
    return;
  }
  const request = ++sessionRequest;
  closeNavigation();
  current.value = session;
  messages.value = [];
  folds.value = [];
  contextBudget.value = null;
  fireState.value = null;
  live.value = "";
  thinking.value = "";
  activeTools.value = [];
  draft.value = "";
  attachments.value = [];
  view.value = "chat";
  sessionLoading.value = true;
  try {
    const v = await api(`/sessions/${session.id}`);
    if (request !== sessionRequest) return;
    current.value = v.session;
    messages.value = v.messages || [];
    folds.value = v.folds || [];
    contextBudget.value = v.context;
    fireState.value = v.fire;
    running.value[session.id] = v.running;
    await scrollBottom();
  } finally {
    if (request === sessionRequest) sessionLoading.value = false;
  }
}
async function newSession() {
  await attempt(async () => {
    const s = await api("/sessions", "POST", {
      cwd: project.value,
      model: chosenModel.value,
    });
    await Promise.all([bootstrap(), selectSession(s)]);
  });
}
async function newStage() {
  if (!current.value) return;
  await attempt(async () => {
    const s = await api(`/sessions/${current.value.id}/stage`, "POST", {});
    await Promise.all([bootstrap(), selectSession(s)]);
    toast("已创建新对话");
  });
}
async function removeSession(s) {
  if (!confirm("删除该会话及其消息？此操作不可撤销。")) return;
  await attempt(async () => {
    await api(`/sessions/${s.id}`, "DELETE");
    if (current.value?.id === s.id) {
      current.value = null;
      messages.value = [];
    }
    await bootstrap();
  });
}
async function send() {
  if (!canWriteCurrent.value) return;
  if (sending.value || (!draft.value.trim() && !attachments.value.length))
    return;
  if (uploading.value) return;
  sending.value = true;
  const body = { text: draft.value, images: attachments.value };
  await attempt(async () => {
    if (!current.value) {
      const s = await api("/sessions", "POST", {
        cwd: project.value,
        model: chosenModel.value,
      });
      await Promise.all([bootstrap(), selectSession(s)]);
    }
    const id = current.value.id;
    const path = isRunning.value ? "steer" : "messages";
    const result = await api(`/sessions/${id}/${path}`, "POST", body);
    draft.value = "";
    attachments.value = [];
    if (result.id && result.id !== id) {
      await Promise.all([bootstrap(), selectSession({ id: result.id })]);
    } else {
      await refreshCurrent();
    }
    await scrollBottom();
  });
  sending.value = false;
}
function messageKey(event) {
  if (
    event.key !== "Enter" ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  if (narrow.value || window.matchMedia("(pointer: coarse)").matches) return;
  event.preventDefault();
  void send();
}
async function upload(event) {
  if (uploading.value) return;
  uploading.value = true;
  const target = attachments.value;
  await attempt(async () => {
    const files = [...event.target.files];
    if (files.length + attachments.value.length > 16)
      throw Error("每条消息最多16张图片");
    if (
      files.reduce((n, f) => n + f.size, 0) +
        attachments.value.reduce((n, f) => n + (f.data.length * 3) / 4, 0) >
      64 * 1024 * 1024
    )
      throw Error("图片总大小不能超过64MiB");
    for (const file of files) {
      if (
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/bmp",
        ].includes(file.type) ||
        file.size > 25 * 1024 * 1024
      )
        throw Error("请选择PNG、JPEG、WebP、GIF或BMP图片，单张不能超过25MiB");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      if (attachments.value !== target) return;
      target.push({ mime: file.type, data });
    }
  });
  event.target.value = "";
  uploading.value = false;
}
async function scrollBottom() {
  await nextTick();
  if (transcript.value)
    transcript.value.scrollTop = transcript.value.scrollHeight;
}
async function refreshCurrent() {
  if (!current.value) return;
  const id = current.value.id,
    request = sessionRequest;
  const data = await api(`/sessions/${id}`);
  if (current.value?.id !== id || request !== sessionRequest) return;
  current.value = data.session;
  messages.value = data.messages || [];
  folds.value = data.folds || [];
  contextBudget.value = data.context;
  fireState.value = data.fire;
  running.value[current.value.id] = data.running;
}
async function handleEvent(event) {
  if (event.type === "config_changed") {
    await Promise.all([bootstrap(), loadModels()]);
    return;
  }
  if (event.type === "fire") {
    const state = event.data;
    if (
      current.value &&
      (current.value.id === state.root || current.value.fireRoot === state.root)
    ) {
      fireState.value = state;
      await bootstrap();
      if (state.latest !== current.value.id) {
        const text = draft.value,
          files = attachments.value;
        await selectSession({ id: state.latest });
        draft.value = text;
        attachments.value = files;
      } else await refreshCurrent();
    }
    return;
  }
  if (event.type === "context_budget" && event.session === current.value?.id) {
    contextBudget.value = event.data;
    return;
  }
  if (event.type === "employee_takeover") {
    if (confirm(`数字员工申请控制 Chrome：\n${event.data.text}\n允许吗？`))
      await api("/employee/takeover", "POST", {
        id: event.data.id,
        accepted: true,
      });
    else
      await api("/employee/takeover", "POST", {
        id: event.data.id,
        accepted: false,
      });
    return;
  }
  if (event.taskId) {
    if (
      ["started", "message_end", "compacted", "error", "done"].includes(
        event.type,
      )
    ) {
      if (event.session === employeeSession.value)
        employeeSessionVersion.value++;
      queueEmployeeRefresh();
    }
    return;
  }
  const selected = event.session === current.value?.id;
  if (event.type === "started") running.value[event.session] = true;
  if (event.type === "employee_changed") {
    if (typeof event.data?.activeTasks === "number")
      activeTaskCount.value = event.data.activeTasks;
    queueEmployeeRefresh();
    return;
  }
  if (event.type === "employee_error") {
    employeeError.value = event.data;
    return;
  }
  if (!selected) {
    if (event.type === "done") {
      running.value[event.session] = false;
      await bootstrap();
    }
    return;
  }
  switch (event.type) {
    case "message_start":
      live.value = "";
      thinking.value = "";
      model.value = event.data.model;
      break;
    case "text_delta":
      live.value += event.data;
      await scrollBottom();
      break;
    case "thinking_delta":
      thinking.value += event.data;
      break;
    case "tool_start":
      activeTools.value.push(event.data);
      break;
    case "tool_end":
      activeTools.value = activeTools.value.filter(
        (t) => t.id !== event.data.call.id,
      );
      break;
    case "error":
      error.value = event.data;
      break;
    case "retry":
      toast(`模型请求重试 ${event.data.attempt}，尚未重放任何工具`);
      break;
    case "scene":
      toast(`当前场景：${event.data.scene} · ${event.data.model || ""}`);
      break;
    case "message_end":
    case "compacted":
      await refreshCurrent();
      live.value = "";
      thinking.value = "";
      await scrollBottom();
      break;
    case "done":
      running.value[event.session] = false;
      live.value = "";
      thinking.value = "";
      activeTools.value = [];
      await Promise.all([refreshCurrent(), bootstrap()]);
      await scrollBottom();
      break;
  }
}
async function loadEmployee() {
  if (!isAdmin.value) return;
  const owner = user.value.id;
  const data = await api("/employee");
  if (user.value?.id !== owner) return;
  employee.value = data;
  activeTaskCount.value = (data.tasks || []).filter(
    (t) => !ended(t.status),
  ).length;
}
function openEmployee(session = "") {
  employeeSession.value = session;
  view.value = "employee";
  closeNavigation();
  if (!session) void refreshEmployee();
}
async function refreshEmployee() {
  try {
    await loadEmployee();
  } catch (e) {
    employeeError.value = e.message;
  }
}
function queueEmployeeRefresh() {
  clearTimeout(employeeRefreshTimer);
  if (view.value !== "employee" || employeeSession.value) return;
  employeeRefreshTimer = setTimeout(() => {
    if (view.value === "employee" && !employeeSession.value)
      void refreshEmployee();
  }, 150);
}
async function employeeAction(data) {
  const result = await api("/employee", "POST", data);
  await loadEmployee();
  return result;
}
async function control(data) {
  await api("/employee/control", "POST", data);
  await loadEmployee();
}
async function addTask() {
  await attempt(async () => {
    await employeeAction({
      action: "add",
      kind: "todo",
      text: taskText.value,
      profile: taskProfile.value,
      cwd: project.value,
    });
    taskText.value = "";
  });
}
async function taskAction(t, action) {
  await attempt(async () => {
    if (action === "remove" && !confirm("永久删除此任务记录？")) return;
    const data = { id: t.id, action };
    if (action === "answer") {
      const text = prompt(t.waiting);
      if (!text) return;
      data.text = text;
    }
    if (action === "approve")
      data.approved = confirm(
        `仅批准以下操作？\n${t.approval}\n\n取消表示驳回。`,
      );
    await control(data);
  });
}
function editDuty(d) {
  duty.value = {
    ...emptyDuty(),
    ...d,
    trigger: d.manual
      ? "manual"
      : d.everyMinutes
        ? "interval"
        : d.times?.length
          ? "times"
          : "dynamic",
    times: (d.times || ["09:00"]).join(","),
  };
  dutyOpen.value = true;
}
async function saveDuty() {
  await attempt(async () => {
    const d = duty.value;
    const data = {
      action: d.id ? "update" : "add",
      kind: "duty",
      id: d.id || undefined,
      text: d.text,
      note: d.note,
      profile: d.profile,
      enabled: d.enabled,
      manual: d.trigger === "manual",
      times: [],
      everyMinutes: 0,
      events: [],
    };
    if (d.trigger === "times")
      data.times = d.times
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (d.trigger === "interval") data.everyMinutes = Number(d.everyMinutes);
    if (d.trigger === "dynamic") data.nextAt = d.nextAt.replace("T", " ");
    await employeeAction(data);
    dutyOpen.value = false;
    duty.value = emptyDuty();
  });
}
async function addMemory() {
  await attempt(async () => {
    await employeeAction({
      action: "remember",
      id: memoryID.value || undefined,
      text: memoryText.value,
      importance: Number(importance.value),
    });
    memoryText.value = "";
    memoryID.value = "";
  });
}
async function saveEmployeeSettings() {
  await attempt(async () => {
    await control({
      action: "settings",
      enabled: employee.value.enabled,
      workStart: employee.value.workStart,
      workEnd: employee.value.workEnd,
    });
    toast("员工设置已保存");
  });
}
async function loadVault() {
  const result = await api("/employee", "POST", { action: "vault_list" });
  vault.value = result.entries || result;
}
async function saveVault() {
  await attempt(async () => {
    await employeeAction({ action: "vault_save", ...vaultForm.value });
    vaultForm.value = { name: "", condition: "", content: "" };
    await loadVault();
    toast("凭据已加密保存");
  });
}

onBeforeUnmount(() => {
  closed = true;
  eventsController?.abort();
});
</script>

<template>
  <main v-if="!authenticated" class="login">
    <form class="login-card" @submit.prevent="login">
      <div class="brand-mark">V</div>
      <h1>Vega</h1>
      <p>{{ setupRequired ? "首次使用：创建管理员账号" : "登录你的工作台" }}</p>
      <template v-if="setupRequired"
        ><label for="setup-token">初始化令牌</label
        ><input
          id="setup-token"
          v-model="setupToken"
          type="password"
          required
          minlength="16"
          autocomplete="off"
          placeholder="服务端日志或VEGA_TOKEN中的初始化令牌"
        />
        <p class="hint">
          令牌只用于创建首个管理员，创建后不能替代账号登录。
        </p></template
      >
      <label for="username">用户名</label
      ><input
        id="username"
        v-model="username"
        required
        minlength="3"
        maxlength="64"
        autocomplete="username"
        pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}"
        autocapitalize="none"
        spellcheck="false"
        placeholder="用户名"
      />
      <label for="password">密码</label
      ><input
        id="password"
        v-model="password"
        type="password"
        required
        :minlength="setupRequired ? 12 : 1"
        maxlength="128"
        :autocomplete="setupRequired ? 'new-password' : 'current-password'"
        placeholder="密码（新账号至少12字符）"
      /><button class="primary" :disabled="authBusy">
        {{
          authBusy ? "正在验证…" : setupRequired ? "创建管理员并登录" : "登录 →"
        }}
      </button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </main>
  <div v-else class="shell">
    <header class="mobile-header">
      <button
        ref="menuButton"
        class="icon mobile-control"
        aria-label="打开导航与会话"
        aria-controls="navigation"
        :aria-expanded="navigationOpen"
        @click="openNavigation"
      >
        ☰
      </button>
      <strong>{{ current?.title || mobileTitles[view] }}</strong>
      <span
        v-if="narrow && view === 'chat' && isRunning"
        class="status-dot"
        role="status"
        aria-label="执行中"
      ></span>
      <button
        v-if="narrow && view === 'chat' && current && canWriteCurrent"
        class="mobile-stage"
        @click="newStage"
      >
        Stage
      </button>
      <button
        v-if="canExecute"
        class="icon mobile-control"
        aria-label="新建会话"
        @click="newSession"
      >
        ＋
      </button>
    </header>
    <button
      v-if="navigationOpen"
      class="navigation-backdrop"
      aria-label="关闭导航"
      tabindex="-1"
      @click="closeNavigation"
    ></button>
    <aside
      id="navigation"
      ref="navigation"
      :class="['sidebar', { 'mobile-open': navigationOpen }]"
      :role="narrow ? 'dialog' : undefined"
      :aria-modal="narrow && navigationOpen ? true : undefined"
      aria-label="导航与会话"
      :inert="narrow && !navigationOpen"
      @keydown="navigationKey"
    >
      <div class="brand">
        <span class="brand-mark small">V</span><strong>Vega</strong>
        <button
          class="icon close-navigation"
          aria-label="关闭导航"
          @click="closeNavigation"
        >
          ×
        </button>
      </div>
      <nav aria-label="主导航" @click="closeNavigation">
        <button :class="{ selected: view === 'chat' }" @click="view = 'chat'">
          <span class="nav-icon" aria-hidden="true">◈</span> <span>对话</span>
        </button>
        <button
          v-if="isAdmin"
          :class="{ selected: view === 'employee' }"
          @click="openEmployee()"
        >
          <span class="nav-icon" aria-hidden="true">◎</span> <span>数字员工</span
          ><span v-if="activeTaskCount !== null" class="count">{{
            activeTaskCount
          }}</span>
        </button>
        <button
          v-if="isAdmin"
          :class="{ selected: view === 'browser' }"
          @click="view = 'browser'"
        >
          <span class="nav-icon" aria-hidden="true">▣</span> <span>浏览器</span>
        </button>
        <button
          v-if="isAdmin"
          :class="{ selected: view === 'experiences' }"
          @click="view = 'experiences'"
        >
          <span class="nav-icon" aria-hidden="true">◇</span> <span>经验图谱</span>
        </button>
        <button
          :class="{ selected: view === 'account' }"
          @click="view = 'account'"
        >
          <span class="nav-icon" aria-hidden="true">♙</span> <span>账号</span>
        </button>
        <button
          v-if="isAdmin"
          :class="{ selected: view === 'settings' }"
          @click="view = 'settings'"
        >
          <span class="nav-icon" aria-hidden="true">⚙</span> <span>设置</span>
        </button>
      </nav>
      <div class="sidebar-heading">
        <span>会话</span
        ><button
          v-if="canExecute"
          class="icon"
          title="新建会话"
          @click="newSession"
        >
          ＋
        </button>
      </div>
      <div class="session-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="session-row"
          :class="{ active: current?.id === s.id && view === 'chat' }"
        >
          <button @click="attempt(() => selectSession(s))">
            <span :class="['dot', { working: running[s.id] }]"></span
            ><span class="truncate"
              >{{ s.stageSource ? "↳ " : "" }}{{ s.title }}</span
            ></button
          ><button
            v-if="
              !s.taskId &&
              !running[s.id] &&
              canExecute &&
              (isAdmin || s.ownerId === user.id)
            "
            class="delete icon"
            title="删除会话"
            @click="removeSession(s)"
          >
            ×
          </button>
        </div>
        <p v-if="!sessions.length" class="empty-small">从一个问题开始。</p>
      </div>
      <footer>
        <button class="link" @click="logout">退出</button>
      </footer>
    </aside>
    <section class="workspace" :inert="navigationOpen">
      <div v-if="error" class="banner error" role="alert">
        {{ error
        }}<button class="icon" aria-label="关闭错误" @click="error = ''">
          ×
        </button>
      </div>
      <div v-if="notice" class="banner notice" role="status">
        {{ notice
        }}<button class="icon" aria-label="关闭提示" @click="notice = ''">
          ×
        </button>
      </div>
      <template v-if="view === 'chat'">
        <header v-if="!narrow" class="topbar">
          <div>
            <h2>
              {{ current?.title || "对话" }}
              <span v-if="current?.stageSource" class="pill">Stage</span>
            </h2>
            <p v-if="!current">随时开始一个新对话</p>
          </div>
          <div class="actions">
            <span v-if="isRunning" class="pill green">执行中</span
            ><button v-if="current && canWriteCurrent" @click="newStage">
              ＋ Stage
            </button>
          </div>
        </header>
        <div ref="transcript" class="transcript" aria-live="polite">
          <div v-if="sessionLoading" class="context-note">正在加载会话…</div>
          <div
            v-if="!sessionLoading && !messages.length && !live"
            class="welcome"
          >
            <div class="welcome-symbol">✳</div>
            <h1>让想法开始运转。</h1>
            <p>编写代码、探索网页，或把一项工作交给数字员工。</p>
            <div v-if="canWriteCurrent" class="suggestions">
              <button @click="draft = '分析当前项目结构，提出最小改进方案'">
                ◈ 分析一个项目</button
              ><button @click="draft = '请用 Chrome 查看当前标签页'">
                ↗ 探索网页</button
              ><button v-if="isAdmin" @click="openEmployee()">
                ◎ 交给数字员工
              </button>
            </div>
          </div>
          <div v-if="fireState" class="context-note">
            Fire · 第 {{ fireState.attempt }} 次 ·
            {{ fireState.role === "judge" ? "独立验收" : "执行" }} ·
            {{ fireState.status }}
            <p v-if="fireState.reason">{{ fireState.reason }}</p>
          </div>
          <template v-for="(entry, i) in timeline" :key="`${current?.id}-${entry.key}`">
            <ToolSteps
              v-if="entry.kind === 'tools'"
              :items="entry.items"
              :active="i === timeline.length - 1 ? activeTools : []"
            />
            <article v-else :class="['message', entry.message.role]">
              <div v-if="entry.message.role !== 'user'" class="message-meta">
                <span>Vega</span><span>{{ entry.message.model || "" }}</span>
              </div>
              <details v-if="entry.message.thinking" class="reasoning">
                <summary>思考过程</summary>
                <pre>{{ entry.message.thinking }}</pre>
              </details>
              <MessageText
                v-if="entry.message.role === 'assistant' && entry.message.text"
                :text="entry.message.displayText || entry.message.text"
              />
              <div
                v-else-if="entry.message.text"
                class="message-text"
              >
                {{ entry.message.displayText || entry.message.text }}
              </div>
              <div v-if="entry.message.calls?.length" class="calls">
                <span v-for="c in entry.message.calls" :key="c.id">↳ {{ c.name }}</span>
              </div>
              <img
                v-for="(image, n) in entry.message.images || []"
                :key="n"
                :src="`data:${image.mime};base64,${image.data}`"
                alt="用户附图"
              />
            </article>
          </template>
          <article v-if="live || thinking" class="message assistant">
            <div class="message-meta">
              <span>Vega</span><span>{{ model }}</span
              ><span class="status-dot"></span>
            </div>
            <details v-if="thinking" class="reasoning">
              <summary>思考中</summary>
              <pre>{{ thinking }}</pre>
            </details>
            <MessageText v-if="live" :text="live" streaming />
          </article>
          <ToolSteps
            v-if="activeTools.length && timeline.at(-1)?.kind !== 'tools'"
            :active="activeTools"
          />
        </div>
        <p v-if="!canWriteCurrent" class="context-note">
          当前账号仅可查看此会话，不能发送消息、停止任务或执行工具。
        </p>
        <div v-if="canWriteCurrent" class="composer-wrap">
          <div class="context-controls">
            <select v-model="chosenModel" aria-label="新会话模型">
              <option value="">默认模型</option>
              <option v-for="m in models" :key="m">{{ m }}</option>
            </select>
          </div>
          <form class="composer" @submit.prevent="send">
            <div v-if="attachments.length" class="attachments">
              <button
                v-for="(im, i) in attachments"
                :key="i"
                type="button"
                @click="attachments.splice(i, 1)"
              >
                图片 {{ i + 1 }} ×
              </button>
            </div>
            <textarea
              v-model="draft"
              aria-label="消息"
              :placeholder="
                isRunning
                  ? '补充当前任务的约束，不会重开任务…'
                  : '写下你的问题，或 /stage 创建引用会话…'
              "
              rows="3"
              enterkeyhint="enter"
              @keydown="messageKey"
            ></textarea>
            <div class="composer-bottom">
              <button
                type="button"
                class="attach icon"
                aria-label="添加图片"
                :disabled="uploading"
                @click="imageInput.click()"
              >
                ＋
              </button>
              <input
                ref="imageInput"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                multiple
                hidden
                @change="upload"
              /><span class="hint">Enter 发送 · Shift + Enter 换行</span
              ><button
                v-if="isRunning"
                type="button"
                class="danger-text"
                @click="
                  attempt(() =>
                    api(`/sessions/${current.id}/cancel`, 'POST', {}),
                  )
                "
              >
                停止</button
              ><button
                class="primary"
                :disabled="
                  sending || uploading || (!draft.trim() && !attachments.length)
                "
              >
                {{
                  uploading
                    ? "读取图片…"
                    : sending
                      ? "提交中…"
                      : isRunning
                        ? "补充约束"
                        : "发送"
                }}
                ↑
              </button>
            </div>
          </form>
        </div>
      </template>
      <Accounts
        v-else-if="view === 'account'"
        :api="api"
        :user="user"
        :sessions="sessions"
        @error="error = $event"
        @notice="notice = $event"
        @signed-out="resetLogin"
        @changed="attempt(bootstrap)"
      />
      <EmployeeSessionView
        v-else-if="view === 'employee' && isAdmin && employeeSession"
        :api="api"
        :session-id="employeeSession"
        :revision="employeeSessionVersion"
        @back="openEmployee()"
      />
      <template v-else-if="view === 'employee' && isAdmin"
        ><header class="topbar">
          <div>
            <h2>数字员工</h2>
            <p>职责触发工作，任务独立推进。</p>
          </div>
          <span :class="['pill', employee.enabled ? 'green' : '']">{{
            employee.enabled ? "已启用" : "已停用"
          }}</span>
        </header>
        <div class="page-scroll">
          <p v-if="employeeError" class="banner error" role="alert">
            {{ employeeError
            }}<button
              class="icon"
              aria-label="关闭员工错误"
              @click="employeeError = ''"
            >
              ×
            </button>
          </p>
          <div class="employee-settings">
            <label
              ><input v-model="employee.enabled" type="checkbox" />
              启用员工</label
            ><label
              >工作时间 <input v-model="employee.workStart" type="time" /> —
              <input v-model="employee.workEnd" type="time" /></label
            ><button @click="saveEmployeeSettings">保存</button
            ><small>北京时间</small>
          </div>
          <div v-if="!employee.enabled" class="context-note">
            员工当前停用，新任务只保存、不执行。启用并进入工作时间后开始处理。
          </div>
          <div class="tabs" role="tablist">
            <button
              v-for="[id, label] in [
                ['tasks', '任务'],
                ['duties', '职责'],
                ['memories', '长期记忆'],
                ['team', '团队员工'],
                ['vault', '密码本'],
              ]"
              :key="id"
              :class="{ selected: employeeTab === id }"
              @click="
                employeeTab = id;
                id === 'vault' && attempt(loadVault);
              "
            >
              {{ label }}
            </button>
          </div>
          <Team
            v-if="employeeTab === 'team'"
            :api="api"
            @error="error = $event"
            @notice="notice = $event"
          />
          <template v-if="employeeTab === 'tasks'"
            ><form class="inline-form" @submit.prevent="addTask">
              <input
                v-model="taskText"
                required
                placeholder="交给员工：一件有明确目标的事"
              /><select v-model="taskProfile">
                <option value="lightweight">轻量化</option>
                <option value="coding">编码</option></select
              ><button class="primary">交给员工</button>
            </form>
            <div class="section-heading">
              <h3>
                待处理 <span>{{ activeTasks.length }}</span>
              </h3>
            </div>
            <div v-if="!activeTasks.length" class="empty-card">
              没有待处理任务，今天很从容。
            </div>
            <article
              v-for="t in [...activeTasks, ...historyTasks]"
              :key="t.id"
              class="task-card"
            >
              <div class="card-top">
                <span :class="['pill', t.status === 'done' ? 'green' : '']">{{
                  labels[t.status]
                }}</span
                ><small>{{ date(t.createdAt) }}</small
                ><span v-if="t.dutyId" class="hint">职责触发</span>
              </div>
              <h3>{{ t.text }}</h3>
              <p v-if="t.waiting || t.approval" class="attention">
                {{ t.waiting || t.approval }}
              </p>
              <p v-if="t.checkpoint" class="hint">恢复点：{{ t.checkpoint }}</p>
              <ol v-if="t.plan?.length" class="plan">
                <li v-for="(step, n) in t.plan" :key="n" :class="step.status">
                  <span>{{ labels[step.status] }}</span> {{ step.content }}
                </li>
              </ol>
              <p v-if="t.progress?.length" class="hint">
                {{ t.progress.at(-1).text }}
              </p>
              <details v-if="t.result">
                <summary>处理结果</summary>
                <pre>{{ t.result }}</pre>
              </details>
              <div class="card-actions">
                <button
                  v-if="t.status === 'running'"
                  @click="taskAction(t, 'stop')"
                >
                  停止</button
                ><button
                  v-if="t.status === 'waiting'"
                  class="primary"
                  @click="taskAction(t, 'answer')"
                >
                  补充信息</button
                ><button
                  v-if="t.status === 'approval'"
                  class="primary"
                  @click="taskAction(t, 'approve')"
                >
                  审批</button
                ><button
                  v-if="['stopped', 'failed', 'cancelled'].includes(t.status)"
                  @click="taskAction(t, 'resume')"
                >
                  原会话续做</button
                ><button
                  @click="
                    attempt(async () => {
                      if (
                        confirm('确定重新派发为新任务？此前外部操作不会回滚。')
                      )
                        await control({
                          action: 'redispatch',
                          id: t.id,
                          confirmed: true,
                        });
                    })
                  "
                >
                  重新派发</button
                ><button
                  v-if="t.workSession"
                  @click="
                    attempt(async () => {
                      const timeline = await api(
                        '/employee/transcript',
                        'POST',
                        { threadId: t.workSession },
                      );
                      toast(JSON.stringify(timeline.entries));
                    })
                  "
                >
                  时间线</button
                ><button
                  v-if="t.workSession"
                  @click="openEmployee(t.workSession)"
                >
                  主会话 ↗</button
                ><button
                  v-if="t.computerSession"
                  @click="openEmployee(t.computerSession)"
                >
                  Chrome 会话 ↗</button
                ><button
                  v-if="!ended(t.status) && t.status !== 'running'"
                  @click="
                    attempt(() => employeeAction({ action: 'done', id: t.id }))
                  "
                >
                  取消</button
                ><button
                  v-if="ended(t.status)"
                  class="link"
                  @click="taskAction(t, 'remove')"
                >
                  删除记录
                </button>
              </div>
            </article></template
          >
          <template v-if="employeeTab === 'duties'"
            ><div class="section-heading">
              <h3>职责模板</h3>
              <button
                class="primary"
                @click="
                  duty = emptyDuty();
                  dutyOpen = true;
                "
              >
                ＋ 新增职责
              </button>
            </div>
            <form
              v-if="dutyOpen"
              class="card form-grid"
              @submit.prevent="saveDuty"
            >
              <label
                >要做什么<textarea
                  v-model="duty.text"
                  required
                  rows="3"
                ></textarea></label
              ><label
                >补充要求<textarea v-model="duty.note" rows="2"></textarea>
              </label>
              <div class="inline-form">
                <label
                  >触发方式<select v-model="duty.trigger">
                    <option value="manual">不定时，手动匹配</option>
                    <option value="times">每天固定时刻</option>
                    <option value="interval">固定间隔</option>
                    <option value="dynamic">动态安排</option>
                  </select></label
                ><label
                  >初始场景<select v-model="duty.profile">
                    <option value="lightweight">轻量化</option>
                    <option value="coding">编码</option>
                  </select></label
                >
              </div>
              <label v-if="duty.trigger === 'times'"
                >时刻（逗号分隔）<input
                  v-model="duty.times"
                  placeholder="09:00,14:30"
                  required /></label
              ><label v-if="duty.trigger === 'interval'"
                >完成后间隔（分钟）<input
                  v-model="duty.everyMinutes"
                  type="number"
                  min="1"
                  max="10080"
                  required /></label
              ><label v-if="duty.trigger === 'dynamic'"
                >首次执行<input
                  v-model="duty.nextAt"
                  type="datetime-local"
                  required /></label
              ><label
                ><input v-model="duty.enabled" type="checkbox" />
                启用此职责</label
              >
              <div class="actions">
                <button class="primary">保存职责</button
                ><button type="button" @click="dutyOpen = false">取消</button>
              </div>
            </form>
            <div
              v-if="!employee.duties?.length && !dutyOpen"
              class="empty-card"
            >
              把重复的工作写成职责，只在真正触发时开工。
            </div>
            <article
              v-for="d in employee.duties || []"
              :key="d.id"
              class="card"
            >
              <div class="card-top">
                <span class="pill">{{
                  d.manual
                    ? "不定时"
                    : d.everyMinutes
                      ? `每 ${d.everyMinutes} 分钟`
                      : d.times?.join("、") ||
                        d.events?.join("、") ||
                        "动态安排"
                }}</span
                ><span class="hint">{{ d.enabled ? "启用" : "停用" }}</span>
              </div>
              <h3>{{ d.text }}</h3>
              <p>{{ d.note }}</p>
              <div class="card-actions">
                <button @click="editDuty(d)">编辑</button
                ><button
                  class="link"
                  @click="
                    attempt(async () => {
                      if (confirm('移除此职责并取消未开始的任务？'))
                        await employeeAction({ action: 'done', id: d.id });
                    })
                  "
                >
                  移除
                </button>
              </div>
            </article></template
          >
          <template v-if="employeeTab === 'memories'"
            ><form class="inline-form" @submit.prevent="addMemory">
              <input
                v-model="memoryText"
                required
                maxlength="200"
                placeholder="一条稳定、可跨任务复用的事实"
              /><select v-model="importance">
                <option :value="1">普通</option>
                <option :value="2">重要</option>
                <option :value="3">长期记住</option></select
              ><button class="primary">{{ memoryID ? "更新" : "记住" }}</button
              ><button
                v-if="memoryID"
                type="button"
                @click="
                  memoryID = '';
                  memoryText = '';
                "
              >
                取消
              </button>
            </form>
            <article
              v-for="m in employee.memories || []"
              :key="m.id"
              class="card"
            >
              <p>{{ m.text }}</p>
              <div class="card-actions">
                <span class="hint"
                  >{{ ["", "普通", "重要", "长期记住"][m.importance] }} · 强度
                  {{ m.strength }}</span
                ><button
                  @click="
                    memoryID = m.id;
                    memoryText = m.text;
                    importance = m.importance;
                  "
                >
                  编辑</button
                ><button
                  class="link"
                  @click="
                    attempt(() =>
                      employeeAction({ action: 'forget', id: m.id }),
                    )
                  "
                >
                  忘记
                </button>
              </div>
            </article></template
          >

          <template v-if="employeeTab === 'vault'">
            <form class="card form-grid" @submit.prevent="saveVault">
              <label
                >名称<input
                  v-model="vaultForm.name"
                  required
                  maxlength="100"
                  placeholder="不要包含密钥内容" /></label
              ><label
                >允许使用的条件<input
                  v-model="vaultForm.condition"
                  required
                  maxlength="500" /></label
              ><label
                >凭据<textarea
                  v-model="vaultForm.content"
                  required
                  rows="3"
                  maxlength="16000"
                  autocomplete="off"
                ></textarea></label
              ><button class="primary">加密保存</button>
            </form>
            <article v-for="item in vault" :key="item.id" class="card">
              <h3>{{ item.name }}</h3>
              <p>{{ item.condition }}</p>
              <button
                class="link"
                @click="
                  attempt(async () => {
                    if (confirm('永久删除此凭据？')) {
                      await employeeAction({
                        action: 'vault_delete',
                        id: item.id,
                      });
                      await loadVault();
                    }
                  })
                "
              >
                删除凭据
              </button>
            </article></template
          >
        </div></template
      >
      <BrowserView v-else-if="view === 'browser' && isAdmin" :api="api" />
      <ExperiencesView
        v-else-if="view === 'experiences' && isAdmin"
        :api="api"
      />
      <SettingsView
        v-else-if="view === 'settings' && isAdmin"
        :api="api"
        :config="config"
        :user-id="user.id"
        :models="catalogModels"
        @saved="providerSaved"
        @error="error = $event"
        @notice="notice = $event"
      />
    </section>
  </div>
</template>
