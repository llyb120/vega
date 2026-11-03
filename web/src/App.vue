<script setup vapor>
import SettingsView from "./SettingsView.vue";
import ResourcesView from "./ResourcesView.vue";
import { LocalAgentPairing, canBridgeLocal, pairingStatusText } from "./local-agent";
import ConversationTimeline from "./ConversationTimeline.vue";
import ExperiencesView from "./ExperiencesView.vue";
import { formatBeijing } from "../../shared/time";
import EmployeeSessionView from "./EmployeeSessionView.vue";
import EmployeeChat from "./EmployeeChat.vue";
import { clearChatCache, pruneChatCache } from "./chat-cache.js";
import EmployeeHeader from "./EmployeeHeader.vue";
import EmployeeTasks from "./EmployeeTasks.vue";
import EmployeeDuties from "./EmployeeDuties.vue";
import EmployeeMemories from "./EmployeeMemories.vue";
import EmployeeSettings from "./EmployeeSettings.vue";
import EmployeeCapabilities from "./EmployeeCapabilities.vue";
import WorkPanel from "./WorkPanel.vue";
import AppSidebar from "./AppSidebar.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
import DebugSessions from "./DebugSessions.vue";
import BrowserView from "./BrowserView.vue";
import Accounts from "./Accounts.vue";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  watch,
} from "vue";
const confirm = window.confirm.bind(window);
const narrow = ref(false),
  wide = ref(false),
  workPanelHidden = ref(false),
  navigationOpen = ref(false),
  navigation = ref(null),
  menuButton = ref(null),
  imageInput = ref(null),
  uploading = ref(false),
  onlineClients = ref([]),
  clientListReady = ref(false),
  localPairing = ref(null);
const localConnected = computed(() => onlineClients.value.length > 0);
const clientStatus = computed(() => !clientListReady.value ? "客户端状态同步中" : localConnected.value ? `客户端在线 · ${onlineClients.value.length} 台` : "无在线客户端");
const localPairingText = computed(() => pairingStatusText(localPairing.value));
let localBridge;
function startLocalPairing() {
  if (!localBridge && canBridgeLocal() && canExecute.value) {
    const bridge = new LocalAgentPairing(httpApi, user.value.id, (status) => {
      if (localBridge !== bridge) return;
      localPairing.value = status;
      if (status.code === "connected") void attempt(bootstrap);
    });
    localBridge = bridge;
    void bridge.connect();
  }
}
function retryLocalPairing() {
  localBridge?.close();
  localBridge = null;
  startLocalPairing();
}
const mobileTitles = {
  chat: "对话",
  employee: "数字牛马",
  debug: "调试会话",
  browser: "浏览器",
  experiences: "经验图谱",
  account: "账号",
  resources: "资源",
  settings: "设置",
};
function closeNavigation() {
  if (!navigationOpen.value) return;
  navigationOpen.value = false;
  nextTick(() => [...document.querySelectorAll("[data-nav-trigger]")].find((el) => el.getClientRects().length)?.focus());
}
async function openNavigation() {
  navigationOpen.value = true;
  await nextTick();
  (navigation.value?.querySelector(".close-navigation") || navigation.value?.querySelector("button"))?.focus();
}
provide("openNavigation", openNavigation);
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
  const media = window.matchMedia("(max-width: 767px)"),
    full = window.matchMedia("(min-width: 1100px)"),
    wideMedia = window.matchMedia("(min-width: 1280px)"),
    viewport = window.visualViewport;
  const layout = () => {
    narrow.value = media.matches;
    wide.value = wideMedia.matches;
    if (full.matches) closeNavigation();
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
  full.addEventListener("change", layout);
  wideMedia.addEventListener("change", layout);
  window.addEventListener("resize", layout);
  viewport?.addEventListener("resize", layout);
  viewport?.addEventListener("scroll", layout);
  onBeforeUnmount(() => {
    media.removeEventListener("change", layout);
    full.removeEventListener("change", layout);
    wideMedia.removeEventListener("change", layout);
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
    !!current.value?.employeeId &&
    !sessionLoading.value &&
    !current.value?.taskId &&
    (!current.value ||
      (current.value.ownerId
        ? current.value.ownerId === user.value?.id
        : isAdmin.value)),
);
const authenticated = ref(false),
  error = ref(""),
  notice = ref(""),
  view = ref("employee");
watch(view, closeNavigation);
let noticeTimer;
watch(notice, (text) => {
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { if (notice.value === text) notice.value = ""; }, 6000);
});
const sessions = ref([]),
  current = ref(null),
  messages = ref([]),
  sessionLoading = ref(false),
  folds = ref([]),
  running = ref({}),
  composer = ref({ text: "", images: [] }),
  draft = computed({
    get: () => composer.value.text,
    set: (text) => { composer.value.text = text; },
  }),
  attachments = computed({
    get: () => composer.value.images,
    set: (images) => { composer.value.images = images; },
  }),
  sending = ref(false),
  draftExecution = ref(null),
  draftClientId = ref(""),
  switchingExecution = ref(false);
// shortcut: drafts live only in this page; add persistence if reload recovery is required.
const drafts = new Map([["", composer.value]]);
function restoreDraft() {
  const id = current.value?.id || "";
  composer.value = drafts.get(id) || { text: "", images: [] };
  drafts.set(id, composer.value);
}
const contextBudget = ref(null),
  fireState = ref(null);
const live = ref(""),
  thinking = ref(""),
  model = ref(""),
  activeTools = ref([]),
  transcript = ref(null),
  project = ref(""),

  config = ref({});
const employee = ref({
    duties: [],
    tasks: [],
    memories: [],
    runs: [],
  }),
  employeeTab = ref("chat"),
  employeeTaskFilter = ref("active"),
  employeeTaskFocus = ref(""),
  employeeSaving = ref(false),
  employeeDeleting = ref(false), employeeClearing = ref(false),
  employeeExecutionBusy = ref(false),
  employeeExecutionOpen = ref(false),
  workRailOpen = ref(false),
  employeeMenu = ref(null),
  debugRevision = ref(0),
  employees = ref([]),
  selectedEmployee = ref(""),
  employeeEvent = ref(null),
  employeeComposers = ref({}),
  creatingEmployee = ref(false),
  newEmployeeName = ref(""),
  newEmployeeInstruction = ref(""),
  employeeSession = ref(""),
  employeeSessionVersion = ref(0),
  employeeError = ref(""),
  taskText = ref(""),
  memoryText = ref(""),
  memoryID = ref(""),
  importance = ref(1),
  activeTaskCount = ref(null);
const duty = ref(emptyDuty()),
  dutyOpen = ref(false);
watch(selectedEmployee, () => { workRailOpen.value = false; });

let eventsSocket,
  eventsReady = false,
  eventsWasConnected = false,
  eventGeneration = 0,
  eventReconnect,
  eventRetryDelay = 500,
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
const executionLocal = computed(
  () => current.value ? !!current.value.localAgent : (draftExecution.value ?? localConnected.value),
);
const executionClientId = computed(
  () => current.value ? (current.value.clientId || "") : (draftClientId.value || onlineClients.value[0]?.id || ""),
);
const selectedClient = computed(() => onlineClients.value.find((client) => client.id === executionClientId.value));
const executionUnavailable = computed(() => executionLocal.value && !selectedClient.value);
const executionBusy = computed(
  () => switchingExecution.value || sending.value || isRunning.value || fireState.value?.status === "running",
);
const executionHint = computed(() => {
  if (switchingExecution.value) return "正在校验执行环境，请稍候";
  if (executionBusy.value) return "当前轮执行结束后可切换执行位置";
  if (!executionLocal.value && !localConnected.value) return "当前在服务端执行；连接客户端后可切换";
  return `当前在${executionLocal.value ? "客户端" : "服务端"}执行，点击切换；两端文件不会自动同步`;
});
const rootSessions = computed(() =>
  sessions.value.filter((s) => !s.stageSource),
);
const rootSession = computed(() => {
  let session = current.value;
  const seen = new Set();
  while (session?.stageSource && !seen.has(session.id)) {
    seen.add(session.id);
    session = sessions.value.find((s) => s.id === session.stageSource);
  }
  return session || current.value;
});
const stagePath = computed(() => {
  const path = rootSession.value ? [rootSession.value] : [];
  const seen = new Set(path.map((s) => s.id));
  while (path.length) {
    const child = sessions.value.find(
      (s) => s.stageSource === path.at(-1).id && !seen.has(s.id),
    );
    if (!child) break;
    path.push(child);
    seen.add(child.id);
  }
  return path;
});
const conversationTitle = computed(
  () => rootSession.value?.title || current.value?.title || "对话",
);

const catalogModels = ref([]);
async function loadModels() {
  if (!isAdmin.value) {
    catalogModels.value = [];
    return;
  }
  catalogModels.value = await api("/providers/models");
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
const attentionTasks = computed(() => activeTasks.value.filter((task) => ["waiting", "approval"].includes(task.status)));
const visibleEmployeeTasks = computed(() => employeeTaskFilter.value === "history" ? historyTasks.value : employeeTaskFilter.value === "attention" ? attentionTasks.value : activeTasks.value);
const employeeStatus = computed(() => attentionTasks.value.length ? "需要你处理" : activeTasks.value.some((task) => task.status === "running") ? "正在工作" : "随时待命");
const employeeTabs = computed(() => [['chat', '对话'], ['tasks', '任务'], ...(employee.value.canManage ? [['browser', '浏览器']] : []), ['duties', '职责'], ['memories', '记忆'], ['capabilities', '技能 / MCP'], ...(employee.value.canManage ? [['settings', '设置']] : [])]);
const employeeTone = computed(() => attentionTasks.value.length ? "warn" : activeTasks.value.some((task) => task.status === "running") ? "info" : "ok");
const employeeCounts = computed(() => ({ tasks: attentionTasks.value.length || activeTasks.value.length, attention: attentionTasks.value.length, duties: employee.value.duties?.length || 0, memories: employee.value.memories?.length || 0 }));
const workPanelVisible = computed(() => wide.value ? !workPanelHidden.value : workRailOpen.value);
function toggleWorkPanel() {
  if (wide.value) workPanelHidden.value = !workPanelHidden.value;
  else workRailOpen.value = !workRailOpen.value;
}
function showTasks(filter = "active") {
  employeeTaskFilter.value = filter;
  employeeTaskFocus.value = "";
  workRailOpen.value = false;
  employeeTab.value = "tasks";
}
const employeeGroups = computed(() => [['team', '团队牛马'], ['personal', isAdmin.value ? '个人牛马' : '我的牛马']].map(([scope, label]) => ({ scope, label, entries: employees.value.filter((employee) => employee.scope === scope) })).filter((group) => group.entries.length));
const labels = {
  queued: "排队中",
  running: "执行中",
  recovering: "自动恢复中",
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
function isChatSend(path, method, data) {
  return method === "POST" && /^\/employees\/[^/]+\/messages$/.test(path) && !!data?.clientMessageId;
}
async function httpApi(path, method = "GET", data) {
  let response, result, timer;
  try {
    const timeout = path === "/events" ? 15000 : (method === "GET" || isChatSend(path, method, data)) ? 30000 : 0;
    // Older mobile WebViews support AbortController but not AbortSignal.timeout.
    const controller = timeout ? new AbortController() : undefined;
    if (controller) timer = setTimeout(() => controller.abort(), timeout);
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      signal: controller?.signal,
      headers: {
        ...(!["GET", "HEAD"].includes(method) && csrfToken.value
          ? { "X-CSRF-Token": csrfToken.value }
          : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.status === 401 && authenticated.value) resetLogin();
    result = await response.json();
  } catch {
    throw Object.assign(Error("网络暂时不可用，请稍后重试"), { network: true, status: response?.status });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok)
    throw Object.assign(Error(
      result.data?.error ||
        result.statusMessage ||
        result.message ||
        (typeof result.error === "string" ? result.error : "") ||
        response.statusText,
    ), { status: response.status });
  return result;
}
async function api(path, method = "GET", data) {
  const size = data === undefined ? 0 : new Blob([JSON.stringify(data)]).size;
  if (
    size > WS_BODY_LIMIT ||
    /^\/(auth|blobs)(\/|$)/.test(path) ||
    path === "/chrome/live" ||
    isChatSend(path, method, data)
  )
    return httpApi(path, method, data);
  if (eventsReady && eventsSocket?.readyState === WebSocket.OPEN)
    return new Promise((resolve, reject) => {
      const id = String(++wsRequestSerial).padStart(8, "0"),
        timer = setTimeout(() => {
          wsRequests.delete(id);
          if (method === "GET") { resolve(httpApi(path, method, data)); return; }
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
    if (request.method === "GET" && !closed && authenticated.value) {
      request.resolve(httpApi(request.path));
      continue;
    }
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
        throw Object.assign(Error(
          result?.data?.error ||
            result?.statusMessage ||
            result?.message ||
            (typeof result?.error === "string" ? result.error : "") ||
            value.statusText,
        ), { status: value.status });
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
    .catch((e) => { if (!e.network) error.value = e.message; });
}
function reconnectEvents(generation) {
  if (generation !== eventGeneration || closed || !authenticated.value) return;
  clearTimeout(eventReconnect);
  const delay = eventRetryDelay * (0.75 + Math.random() * 0.5);
  eventRetryDelay = Math.min(eventRetryDelay * 2, 10000);
  eventReconnect = setTimeout(() => {
    if (generation === eventGeneration) connectEvents();
  }, delay);
}
function connectEvents() {
  if (closed || !authenticated.value || navigator.onLine === false) return;
  const generation = ++eventGeneration;
  clearTimeout(eventReconnect);
  clearInterval(eventsHeartbeat);
  eventsReady = false;
  eventsSocket?.close();
  rejectSocketRequests("实时连接正在恢复");
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
      if (e.status === 401 || e.status === 403) {
        error.value = "实时通道认证失效，请重新登录";
        return;
      }
      reconnectEvents(generation);
    });
}
function openEventSocket(url, generation) {
  const ws = new WebSocket(url);
  eventsSocket = ws;
  let lastMessage = Date.now(), readyAt = 0;
  eventsHeartbeat = setInterval(() => {
    if (generation !== eventGeneration) return;
    if (Date.now() - lastMessage > 30000) { ws.close(); return; }
    if (readyAt && Date.now() - readyAt >= 30000) eventRetryDelay = 500;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "ping" })); }
      catch { ws.close(); }
    }
  }, 10000);
  ws.onmessage = ({ data }) => {
    if (generation !== eventGeneration) return;
    try {
      const value = JSON.parse(data);
      lastMessage = Date.now();
      if (value.type === "ready") {
        const reconnect = eventsWasConnected;
        eventsReady = true;
        eventsWasConnected = true;
        readyAt = Date.now();
        if (reconnect)
          void (async () => {
            await bootstrap();
            if (generation !== eventGeneration) return;
            if (current.value) await refreshCurrent();
            if (view.value === "employee" && !employeeSession.value) await loadEmployee();
            employeeSessionVersion.value++;
          })().catch((e) => {
            if (generation !== eventGeneration) return;
            if (e.network) ws.close();
            else error.value = e.message;
          });
        return;
      }
      if (value.type !== "pong") socketMessage(value);
    } catch (e) {
      error.value = `实时消息无效：${e.message}`;
    }
  };
  ws.onerror = () => { if (generation === eventGeneration) ws.close(); };
  ws.onclose = (event) => {
    if (generation !== eventGeneration) return;
    eventsReady = false;
    clearInterval(eventsHeartbeat);
    if (event.code === 4401) {
      resetLogin();
      error.value = "登录已过期或被撤销，请重新登录";
      return;
    }
    rejectSocketRequests("实时连接正在恢复");
    reconnectEvents(generation);
  };
}
function recoverEvents() {
  if (!document.hidden && !eventsReady && authenticated.value && !closed) connectEvents();
}
onMounted(() => {
  window.addEventListener("online", recoverEvents);
  document.addEventListener("visibilitychange", recoverEvents);
});
onBeforeUnmount(() => {
  window.removeEventListener("online", recoverEvents);
  document.removeEventListener("visibilitychange", recoverEvents);
});
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
  onlineClients.value = b.clients || [];
  clientListReady.value = true;
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
  startLocalPairing();
  if (isAdmin.value) startPresence();
  await Promise.all([loadModels(), refreshEmployee()]);
  view.value = "employee";
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
  void clearChatCache(user.value?.id);
  employeeLoadVersion++;
  try {
    sessionStorage.removeItem("vega:provider-login:" + user.value?.id);
    sessionStorage.removeItem("vega:session:" + user.value?.id);
  } catch {}
  closeNavigation();
  localBridge?.close();
  localBridge = null;
  localPairing.value = null;
  clientListReady.value = false;
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
  draftExecution.value = null;
  draftClientId.value = "";
  onlineClients.value = [];
  sessionRequest++;
  sessionLoading.value = false;
  sessions.value = [];
  messages.value = [];
  folds.value = [];
  running.value = {};
  config.value = {};
  catalogModels.value = [];
  activeTaskCount.value = null;
  employeeTab.value = "chat";
  creatingEmployee.value = false;
  newEmployeeName.value = "";
  newEmployeeInstruction.value = "";
  employee.value = { duties: [], tasks: [], memories: [], runs: [] };
  taskText.value = "";
  memoryText.value = "";
  memoryID.value = "";
  dutyOpen.value = false;
  duty.value = emptyDuty();
  employeeSession.value = "";
  employees.value = [];
  selectedEmployee.value = "";
  employeeEvent.value = null;
  employeeComposers.value = {};
  employeeError.value = "";
  drafts.clear();
  restoreDraft();
  view.value = "chat";
}
async function logout() {
  try {
    await api("/auth/logout", "POST", {});
  } finally {
    resetLogin();
  }
}
onMounted(() => {
  window.addEventListener("popstate", employeeLocationChanged);
  void attempt(async () => {
    const result = await api("/auth/me");
    setupRequired.value = result.setupRequired;
    if (result.user) await enter(result);
  });
});
onBeforeUnmount(() => window.removeEventListener("popstate", employeeLocationChanged));
async function selectSession(session) {
  if (session.taskId) {
    openEmployee(session.id);
    return;
  }
  const request = ++sessionRequest;
  closeNavigation();
  current.value = session;
  try {
    sessionStorage.setItem("vega:session:" + user.value.id, session.id);
  } catch {}
  messages.value = [];
  folds.value = [];
  contextBudget.value = null;
  fireState.value = null;
  live.value = "";
  thinking.value = "";
  activeTools.value = [];
  restoreDraft();
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
      localAgent: localConnected.value,
      clientId: onlineClients.value[0]?.id,
    });
    draftExecution.value = null;
    draftClientId.value = "";
    await Promise.all([bootstrap(), selectSession(s)]);
  });
}
async function toggleExecution() {
  await changeExecution(!executionLocal.value, selectedClient.value?.id || onlineClients.value[0]?.id);
}
async function changeClient(event) {
  await changeExecution(true, event.target.value);
  event.target.value = executionClientId.value;
}
async function changeExecution(localAgent, clientId) {
  if (!canWriteCurrent.value || executionBusy.value) return;
  if (localAgent && !onlineClients.value.some((client) => client.id === clientId)) {
    error.value = "所选客户端未在线，请选择在线客户端";
    return;
  }
  if (!current.value) {
    draftExecution.value = localAgent;
    draftClientId.value = localAgent ? clientId : "";
    return;
  }
  const id = current.value.id, request = ++sessionRequest;
  switchingExecution.value = true;
  try {
    await attempt(async () => {
      const session = await api(`/sessions/${id}/execution`, "POST", { localAgent, clientId: localAgent ? clientId : undefined });
      if (current.value?.id !== id || request !== sessionRequest) return;
      current.value = session;
      sessions.value = sessions.value.map((s) => s.id === id ? session : s);
      notice.value = `已切换到${localAgent ? "客户端 " + session.clientName : "服务端"}，工作目录：${session.cwd}。两端文件不会自动同步。`;
    });
  } finally {
    switchingExecution.value = false;
  }
}
async function removeSession(s) {
  if (!confirm("删除该会话及其 Stage 和消息？此操作不可撤销。")) return;
  await attempt(async () => {
    await api(`/sessions/${s.id}`, "DELETE");
    let selected = current.value;
    const seen = new Set();
    while (selected && !seen.has(selected.id) && selected.id !== s.id) {
      seen.add(selected.id);
      selected = sessions.value.find((item) => item.id === selected.stageSource);
    }
    if (selected?.id === s.id) {
      current.value = null;
      sessionRequest++;
      messages.value = [];
      folds.value = [];
      contextBudget.value = null;
      fireState.value = null;
      live.value = "";
      thinking.value = "";
      activeTools.value = [];
      restoreDraft();
    }
    await bootstrap();
    for (const id of drafts.keys())
      if (id && !sessions.value.some((session) => session.id === id)) drafts.delete(id);
  });
}
async function send() {
  if (!canWriteCurrent.value || switchingExecution.value) return;
  if (executionUnavailable.value) {
    error.value = "所选客户端已离线或尚未选择，请选择在线客户端，或手动切换到服务端；不会自动重试操作";
    return;
  }
  if (sending.value || (!draft.value.trim() && !attachments.value.length))
    return;
  if (uploading.value) return;
  sending.value = true;
  const pending = composer.value,
    body = { text: pending.text, images: [...pending.images] },
    account = csrfToken.value,
    request = sessionRequest;
  let session = current.value;
  void scrollBottom();
  await attempt(async () => {
    if (!session) {
      session = await api("/sessions", "POST", {
        cwd: project.value,
        localAgent: executionLocal.value,
        clientId: executionLocal.value ? executionClientId.value : undefined,
      });
      if (csrfToken.value !== account) return;
      drafts.set(session.id, pending);
      if (drafts.get("") === pending) drafts.delete("");
      draftExecution.value = null;
      draftClientId.value = "";
      if (!current.value && request === sessionRequest)
        await Promise.all([bootstrap(), selectSession(session)]);
      else await bootstrap();
    }
    if (csrfToken.value !== account) return;
    const id = session.id;
    const path = running.value[id] ? "steer" : "messages";
    const result = await api(`/sessions/${id}/${path}`, "POST", body);
    if (csrfToken.value !== account) return;
    if (pending.text === body.text && pending.images.length === body.images.length &&
        pending.images.every((image, i) => image === body.images[i])) {
      pending.text = "";
      pending.images = [];
    }
    if (current.value?.id !== id) return;
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
  const target = composer.value,
    id = current.value?.id || "",
    account = csrfToken.value;
  await attempt(async () => {
    const files = [...event.target.files];
    if (files.length + target.images.length > 16)
      throw Error("每条消息最多16张图片");
    if (
      files.reduce((n, f) => n + f.size, 0) +
        target.images.reduce((n, f) => n + (f.data.length * 3) / 4, 0) >
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
      if (csrfToken.value !== account || drafts.get(id) !== target) return;
      target.images.push({ mime: file.type, data });
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
  if (view.value === "debug" && ["started", "message_end", "tool_end", "done", "employee_changed"].includes(event.type)) debugRevision.value++;
  if (event.session && event.session === employee.value.chatSession) {
    employeeEvent.value = event;
    return;
  }
  if (event.type === "clients_changed") {
    await bootstrap();
    if (view.value === "employee") await refreshEmployee();
    return;
  }
  if (event.type === "execution_changed") {
    await bootstrap();
    if (event.session === current.value?.id) await refreshCurrent();
    return;
  }
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
    if (confirm(`数字牛马申请控制 Chrome：\n${event.data.text}\n允许吗？`))
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
    if (!event.data?.employeeId || event.data.employeeId === selectedEmployee.value) employeeSessionVersion.value++;
    if (typeof event.data?.activeTasks === "number")
      activeTaskCount.value = event.data.activeTasks;
    queueEmployeeRefresh();
    return;
  }
  if (event.type === "employee_error") {
    employeeError.value = typeof event.data === 'string' ? event.data : event.data?.message;
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
let employeeLoadVersion = 0;
function employeeLocationChanged() {
  if (user.value) return chooseEmployee(new URL(window.location.href).searchParams.get("employee") || "");
}
function setEmployeeURL(id, replace = false) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("employee", id);
  else url.searchParams.delete("employee");
  if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"](null, "", url.href);
}
function prepareEmployee(id) {
  const entry = employees.value.find((item) => item.id === id);
  if (!entry) return;
  employeeComposers.value[id] ||= { text: "", images: [] };
  if (employee.value.id !== id)
    employee.value = { ...entry, canManage: false, duties: [], tasks: [], memories: [], runs: [] };
}
async function loadEmployee() {
  if (!user.value) return;
  const owner = user.value.id, request = ++employeeLoadVersion;
  const list = await api("/employees");
  if (user.value?.id !== owner || request !== employeeLoadVersion) return;
  void pruneChatCache(owner, list.map((entry) => entry.id));
  employees.value = list;
  activeTaskCount.value = list.reduce((count, employee) => count + employee.activeTasks, 0);
  const requested = selectedEmployee.value || new URL(window.location.href).searchParams.get("employee");
  const id = list.find((entry) => entry.id === requested)?.id || list[0]?.id || "";
  selectedEmployee.value = id;
  setEmployeeURL(id, true);
  if (!id) {
    employee.value = { duties: [], tasks: [], memories: [], runs: [] };
    employeeSession.value = "";
    return;
  }
  prepareEmployee(id);
  const data = await api(`/employees/${id}`);
  if (user.value?.id !== owner || selectedEmployee.value !== id || request !== employeeLoadVersion) return;
  employeeSessionVersion.value++;
  if (employeeTab.value !== "settings" || employee.value.id !== id) employee.value = data;
  else { employee.value.tasks = data.tasks; employee.value.busy = data.busy; employee.value.chatRunning = data.chatRunning; employee.value.executionClients = data.executionClients; employee.value.execution = data.execution; employee.value.avatar = data.avatar; }
}
function employeeApi(path, method = "GET", data) {
  if (!selectedEmployee.value) throw Error("请先创建牛马");
  return api(path.replace(/^\/employee(?=\/|$)/, `/employees/${selectedEmployee.value}`), method, data);
}
function employeeBrowserApi(path, method = "GET", data) {
  return api(path.replace(/^\/chrome/, `/employees/${selectedEmployee.value}/chrome`), method, data);
}
async function chooseEmployee(id) {
  selectedEmployee.value = id;
  prepareEmployee(id);
  setEmployeeURL(id);
  employeeSession.value = "";
  employeeEvent.value = null;
  employeeTab.value = "chat";
  employeeExecutionOpen.value = false;
  employeeTaskFilter.value = "active";
  employeeTaskFocus.value = "";
  dutyOpen.value = false;
  memoryID.value = "";
  taskText.value = "";
  employeeError.value = "";
  creatingEmployee.value = false;
  view.value = "employee";
  closeNavigation();
  await refreshEmployee();
}
async function createEmployee() {
  if (employeeSaving.value) return;
  employeeSaving.value = true;
  try { await attempt(async () => {
    const created = await api("/employees", "POST", { name: newEmployeeName.value, instruction: newEmployeeInstruction.value, cwd: project.value });
    newEmployeeName.value = "";
    newEmployeeInstruction.value = "";
    await chooseEmployee(created.id);
  }); } finally { employeeSaving.value = false; }
}
async function deleteEmployee() {
  if (employeeDeleting.value || !employee.value.id) return;
  const id = employee.value.id, name = employee.value.name, owner = user.value.id;
  if (!confirm(`永久删除「${name}」？\n\n将删除该牛马的职责、记忆、所有任务和执行会话，并清除其浏览器登录数据。项目文件和共享密码本不会删除；已提交的外部作业不会自动取消。此操作不可撤销。`)) return;
  employeeDeleting.value = true;
  try {
    await api(`/employees/${id}?confirmed=true`, "DELETE");
    employeeLoadVersion++;
    void clearChatCache(owner, id);
    delete employeeComposers.value[id];
    if (selectedEmployee.value === id) {
      selectedEmployee.value = "";
      employee.value = { duties: [], tasks: [], memories: [], runs: [] };
      employeeSession.value = "";
      employeeTab.value = "chat";
    }
    await loadEmployee();
    toast(`已删除「${name}」`);
  } catch (error) { employeeError.value = error.message; }
  finally { employeeDeleting.value = false; }
}
async function clearEmployeeChat() {
  if (employeeClearing.value || employeeDeleting.value || !employee.value.id) return;
  const id = employee.value.id, name = employee.value.name, owner = user.value.id;
  if (!confirm(`清空「${name}」的全部聊天记录？\n\n对话消息将永久删除，任务、职责和记忆不受影响。此操作不可撤销。`)) return;
  employeeClearing.value = true;
  try {
    await api(`/employees/${id}/chat/clear?confirmed=true`, "POST");
    await clearChatCache(owner, id);
    employeeSessionVersion.value++;
    employeeEvent.value = null;
    toast(`已清空「${name}」的聊天记录`);
  } catch (error) { employeeError.value = error.message; }
  finally { employeeClearing.value = false; }
}
async function employeeTaskAction(task, action, text) {
  return attempt(async () => {
    if (action === "remove" && !confirm("永久删除此任务记录？")) return;
    if (action === "redispatch" && !confirm("重新派发为新任务？此前外部操作不会回滚。")) return;
    await control({ id: task.id, action: action === "reject" ? "approve" : action, ...(action === "approve" || action === "reject" ? { approved: action === "approve" } : {}), ...(text ? { text } : {}), ...(action === "redispatch" ? { confirmed: true } : {}) });
    return true;
  });
}
async function changeEmployeeExecution(localAgent, clientId) {
  if (employeeExecutionBusy.value) return;
  const id = selectedEmployee.value;
  employeeExecutionBusy.value = true;
  try {
    await api(`/employees/${id}/execution`, "POST", { localAgent, ...(localAgent ? { clientId: clientId || employee.value.executionClients?.[0]?.id } : {}) });
    const updated = await api(`/employees/${id}`);
    if (selectedEmployee.value === id) employee.value = updated;
    toast("已切换新任务的默认执行位置；已有和正在进行的任务不变。");
  } catch (error) { employeeError.value = error.message; }
  finally { employeeExecutionBusy.value = false; }
}
async function openEmployeeTask(id) {
  const owner = selectedEmployee.value;
  let task = employee.value.tasks?.find((entry) => entry.id === id);
  if (!task) {
    await refreshEmployee();
    if (selectedEmployee.value !== owner) return;
    task = employee.value.tasks?.find((entry) => entry.id === id);
  }
  if (!task) { toast("这条任务记录已不存在"); return; }
  employeeTaskFilter.value = ended(task.status) ? "history" : "active";
  employeeTaskFocus.value = id;
  employeeTab.value = "tasks";
}
async function employeeTabChanged(id) {
  employeeTab.value = id;
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
    if (!e.network) employeeError.value = e.message;
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
  const result = await employeeApi("/employee", "POST", data);
  await loadEmployee();
  return result;
}
async function control(data) {
  await employeeApi("/employee/control", "POST", data);
  await loadEmployee();
}
async function saveDuty(data) {
  const employeeId = selectedEmployee.value, actor = user.value?.id;
  return attempt(async () => {
    await employeeAction(data).catch(error => {
      if (selectedEmployee.value === employeeId && user.value?.id === actor) throw error;
    });
    return selectedEmployee.value === employeeId && user.value?.id === actor;
  });
}
function removeDuty(d) {
  return attempt(async () => {
    if (confirm("移除此职责并取消未开始的任务？"))
      await employeeAction({ action: "done", id: d.id });
  });
}
async function saveMemory(data) {
  return attempt(async () => {
    await employeeAction({ action: "memory_propose", source: "ui", ...data });
    return true;
  });
}
function forgetMemory(m) {
  return attempt(() => employeeAction({ action: "memory_forget", id: m.id }));
}
function resolveMemory(data) {
  return attempt(() => employeeAction({ action: "memory_resolve", ...data }));
}
function pinMemory(m, pinned = true) {
  return attempt(() => employeeAction({ action: "memory_pin", id: m.id, pinned }));
}
async function saveEmployeeSettings() {
  if (employeeSaving.value) return;
  const id = employee.value.id;
  employeeSaving.value = true;
  try { await attempt(async () => {
    await control({
      action: "settings",
      name: employee.value.name,
      instruction: employee.value.instruction,
      cwd: employee.value.cwd,
    });
    toast("牛马设置已保存");
    const updated = await api(`/employees/${id}`);
    if (selectedEmployee.value === id) employee.value = updated;
  }); } finally { employeeSaving.value = false; }
}

onBeforeUnmount(() => {
  closed = true;
  eventGeneration++;
  clearTimeout(eventReconnect);
  clearInterval(eventsHeartbeat);
  eventsSocket?.close();
  localBridge?.close();
});
</script>

<template>
  <main v-if="!authenticated" class="login">
    <aside class="login-aside" aria-hidden="true">
      <div class="login-brand"><span class="brand-mark">V</span>Vega</div>
      <div class="login-pitch">
        <h1>把目标交给数字牛马，<br />你只处理需要决定的事。</h1>
        <ul>
          <li><Icon name="chat" />用对话交代工作，牛马自己拆解成任务并持续推进。</li>
          <li><Icon name="hand" />需要审批或补充信息时，第一时间出现在你面前。</li>
          <li><Icon name="globe" />独立的浏览器与记忆，随时可以接手查看。</li>
        </ul>
      </div>
      <p class="login-foot">Vega 工作台</p>
    </aside>
    <div class="login-main">
      <form class="login-card" @submit.prevent="login">
        <header>
          <span class="brand-mark">V</span>
          <h2>{{ setupRequired ? "创建管理员账号" : "登录 Vega" }}</h2>
          <p>{{ setupRequired ? "首次使用：用初始化令牌创建第一个管理员。" : "登录你的工作台" }}</p>
        </header>
        <label v-if="setupRequired" for="setup-token">初始化令牌<input id="setup-token" v-model="setupToken" type="password" required minlength="16" autocomplete="off" placeholder="服务端日志或 VEGA_TOKEN 中的初始化令牌" /><span class="hint">令牌只用于创建首个管理员，创建后不能替代账号登录。</span></label>
        <label for="username">用户名<input id="username" v-model="username" required minlength="3" maxlength="64" autocomplete="username" pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,63}" autocapitalize="none" spellcheck="false" placeholder="用户名" /></label>
        <label for="password">密码<input id="password" v-model="password" type="password" required :minlength="setupRequired ? 12 : 1" maxlength="128" :autocomplete="setupRequired ? 'new-password' : 'current-password'" :placeholder="setupRequired ? '至少 12 个字符' : '密码'" /></label>
        <button class="primary" :disabled="authBusy"><span v-if="authBusy" class="spinner"></span>{{ authBusy ? "正在验证…" : setupRequired ? "创建管理员并登录" : "登录" }}</button>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
    </div>
  </main>
  <div v-else class="shell">
    <button v-if="navigationOpen" class="navigation-backdrop" aria-label="关闭导航" tabindex="-1" @click="closeNavigation"></button>
    <aside
      id="navigation"
      ref="navigation"
      :class="['sidebar', { 'mobile-open': navigationOpen }]"
      :role="navigationOpen ? 'dialog' : undefined"
      :aria-modal="navigationOpen ? true : undefined"
      aria-label="导航"
      :inert="narrow && !navigationOpen"
      @keydown="navigationKey"
    >
      <AppSidebar
        :user="user"
        :is-admin="isAdmin"
        :can-execute="canExecute"
        :groups="employeeGroups"
        :selected-employee="selectedEmployee"
        :view="view"
        :creating="view === 'employee' && creatingEmployee"
        :open="navigationOpen"
        :client-ready="clientListReady"
        :client-status="clientStatus"
        :clients="onlineClients"
        :pairing-text="localPairing ? localPairingText : ''"
        :pairing-code="localPairing?.code"
        :sessions="rootSessions"
        :running="running"
        :current-root="rootSession?.id"
        @choose="chooseEmployee"
        @create="creatingEmployee = true; openEmployee()"
        @navigate="view = $event"
        @logout="logout"
        @close="closeNavigation"
        @expand="openNavigation"
        @retry-pairing="retryLocalPairing"
        @select-session="(s) => { closeNavigation(); attempt(() => selectSession(s)); }"
        @remove-session="removeSession"
      />
    </aside>
    <section class="workspace" :inert="navigationOpen">
      <template v-if="view === 'chat'">
        <PageHeader :title="conversationTitle" :subtitle="current ? (current.cwd || project) : '随时开始一个新对话'">
          <template #title-extra><span v-if="current?.stageSource" class="pill">Stage</span><span v-if="isRunning" class="pill green"><span class="dot ok pulse"></span>执行中</span></template>
          <select v-if="stagePath.length > 1" class="stage-switch" aria-label="切换会话 Stage" :value="current?.id" @change="selectSession(stagePath.find((s) => s.id === $event.target.value))">
            <option :value="stagePath[0].id">主对话</option>
            <option v-for="(stage, i) in stagePath.slice(1)" :key="stage.id" :value="stage.id">Stage {{ i + 1 }} · {{ stage.title }}</option>
          </select>
          <button v-if="canExecute" class="primary sm" @click="openEmployee()"><Icon name="users" :size="15" /><span class="hide-mobile">交给牛马</span></button>
        </PageHeader>
        <div v-if="localPairing && localPairing.code !== 'connected'" class="banner notice" role="status"><span>{{ localPairingText }}</span><button type="button" class="sm" @click="retryLocalPairing">重新检测</button></div>
        <div ref="transcript" :key="current?.id ?? 'none'" class="transcript" aria-live="polite">
          <div v-if="sessionLoading" class="context-note">正在加载会话…</div>
          <div v-if="!sessionLoading && !messages.length && !live" class="welcome">
            <h1>今天想完成什么？</h1>
            <p>从一个问题开始。Vega 可以分析项目、探索网页，或把任务交给数字牛马。</p>
            <div v-if="canWriteCurrent" class="suggestions">
              <button @click="draft = '分析当前项目结构，提出最小改进方案'"><Icon name="code" /><span>分析一个项目<small>梳理结构，找到最小改进路径</small></span></button>
              <button @click="draft = '请用 Chrome 查看当前标签页'"><Icon name="globe" /><span>探索网页<small>查看当前页面并提取有效信息</small></span></button>
              <button v-if="isAdmin" @click="openEmployee()"><Icon name="users" /><span>交给数字牛马<small>创建可持续推进的独立任务</small></span></button>
            </div>
          </div>
          <div v-if="fireState" class="context-note">
            Fire · 第 {{ fireState.attempt }} 次 · {{ fireState.role === "judge" ? "独立验收" : "执行" }} · {{ fireState.status }}
            <p v-if="fireState.reason">{{ fireState.reason }}</p>
          </div>
          <ConversationTimeline :key="current?.id ?? 'none'" :messages="messages" :running="!!isRunning" :live="live" :thinking="thinking" :active-tools="activeTools" :model="model" />
        </div>
        <p v-if="!canWriteCurrent" class="context-note">历史会话仅供查阅；继续工作请交给牛马，执行会话由牛马管理。</p>
        <div v-if="canWriteCurrent" class="composer-wrap">
          <form class="composer" @submit.prevent="send">
            <div v-if="attachments.length" class="attachments"><button v-for="(im, i) in attachments" :key="i" type="button" @click="attachments.splice(i, 1)"><Icon name="image" :size="12" />图片 {{ i + 1 }}<Icon name="close" :size="12" /></button></div>
            <textarea v-model="draft" aria-label="消息" :placeholder="isRunning ? '补充当前任务的约束，不会重开任务…' : '输入消息，Enter 发送…'" rows="2" enterkeyhint="enter" @keydown="messageKey"></textarea>
            <div class="composer-bottom">
              <button type="button" class="attach icon" aria-label="添加图片" :disabled="uploading" @click="imageInput.click()"><Icon name="image" /></button>
              <input ref="imageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden @change="upload" />
              <button type="button" class="execution-switch" role="switch" aria-label="客户端执行（关闭时在服务端执行）" :aria-checked="executionLocal" :class="{ local: executionLocal }" :title="executionHint" :disabled="executionBusy || (!executionLocal && !localConnected)" @click="toggleExecution">
                <span :class="{ selected: !executionLocal }">服务端</span><span class="execution-track" aria-hidden="true"></span><span :class="{ selected: executionLocal }">客户端</span>
              </button>
              <select v-if="executionLocal" class="execution-client" aria-label="执行客户端" :value="executionClientId" :disabled="executionBusy" @change="changeClient">
                <option v-if="!selectedClient" :value="executionClientId" disabled>{{ current?.clientName ? current.clientName + ' · 离线' : '请选择在线客户端' }}</option>
                <option v-for="client in onlineClients" :key="client.id" :value="client.id">{{ client.name }} · {{ client.platform }} · {{ client.id.slice(0, 6) }} · 在线</option>
              </select>
              <span class="hint">Enter 发送 · Shift + Enter 换行</span>
              <button v-if="isRunning" type="button" class="danger-text" @click="attempt(() => api(`/sessions/${current.id}/cancel`, 'POST', {}))"><Icon name="stop" :size="14" />停止</button>
              <button class="primary" :disabled="sending || switchingExecution || uploading || executionUnavailable || (!draft.trim() && !attachments.length)">{{ uploading ? "读取图片…" : sending ? "提交中…" : isRunning ? "补充约束" : "发送" }}<Icon name="send" :size="14" /></button>
            </div>
          </form>
          <p v-if="executionUnavailable" class="execution-warning" role="status">所选客户端已离线或尚未选择，请选择在线客户端或切换到服务端；不会自动切换或重试操作。</p>
        </div>
      </template>
      <Accounts v-else-if="view === 'account'" :api="api" :user="user" @error="error = $event" @notice="notice = $event" @signed-out="resetLogin" @changed="attempt(bootstrap)" />
      <DebugSessions v-else-if="view === 'debug' && isAdmin" :api="api" :revision="debugRevision" />
      <EmployeeSessionView v-else-if="view === 'employee' && employeeSession" :api="api" :session-id="employeeSession" :revision="employeeSessionVersion" @back="openEmployee()" />
      <section v-else-if="view === 'employee'" class="employee-workspace" :aria-busy="employeeDeleting">
        <template v-if="(creatingEmployee || !employees.length)">
          <PageHeader :title="canExecute ? '创建新牛马' : '数字牛马'" :subtitle="canExecute ? '取个名字，交代工作方向，就可以开始了。' : ''" :back="employees.length ? '返回' : ''" @back="creatingEmployee = false" />
          <div class="page-scroll create-page">
            <p v-if="employeeError" class="banner error" role="alert"><span>{{ employeeError }}</span><button class="icon" aria-label="关闭牛马错误" @click="employeeError = ''"><Icon name="close" :size="14" /></button></p>
            <div v-if="!canExecute" class="empty-state"><Icon name="users" :size="28" /><strong>还没有团队牛马</strong><span>管理员创建的团队牛马会出现在这里。</span></div>
            <form v-else class="card create-card" @submit.prevent="createEmployee">
              <div class="create-head"><span class="create-icon" aria-hidden="true"><Icon name="users" :size="22" /></span><div><h3>你想把什么交给他？</h3><p class="hint">{{ isAdmin ? '团队牛马 · 所有成员可见' : '个人牛马 · 仅本人和管理员可见' }}</p></div></div>
              <div class="form-grid">
                <label>牛马名称<input v-model="newEmployeeName" required maxlength="80" placeholder="例如：研发助手、运营搭档" autofocus /></label>
                <label>工作方向<textarea v-model="newEmployeeInstruction" rows="5" maxlength="8000" placeholder="例如：负责项目开发，先检查现有实现，完成后验证并汇报结果。"></textarea></label>
              </div>
              <ul class="create-facts">
                <li><Icon name="check" :size="14" />创建后即可接活，无需设置启用或工作时间</li>
                <li><Icon name="check" :size="14" />独立的记忆、任务列表和浏览器会自动准备</li>
              </ul>
              <div class="actions end"><button v-if="employees.length" type="button" class="ghost" @click="creatingEmployee = false">取消</button><button class="primary" :disabled="employeeSaving">{{ employeeSaving ? '正在创建…' : '创建牛马' }}</button></div>
            </form>
          </div>
        </template>
        <template v-else>
          <EmployeeHeader
            :employee="employee"
            :status="employeeStatus"
            :tone="employeeTone"
            :tabs="employeeTabs"
            :tab="employeeTab"
            :counts="employeeCounts"
            :deleting="employeeDeleting"
            :busy="employeeExecutionBusy"
            :show-work="employeeTab === 'chat'"
            :work-open="workPanelVisible"
            :work-count="attentionTasks.length || activeTasks.length"
            @tab="employeeTabChanged"
            @delete="deleteEmployee"
            @execution="changeEmployeeExecution"
            @toggle-work="toggleWorkPanel"
            @menu="openNavigation"
          />
          <p v-if="employeeError" class="banner error" role="alert"><span>{{ employeeError }}</span><button class="icon" aria-label="关闭牛马错误" @click="employeeError = ''"><Icon name="close" :size="14" /></button></p>
          <div v-if="employeeTab === 'chat' && selectedEmployee && employee.id === selectedEmployee" class="employee-chat-layout" :class="{ 'panel-inline': wide && workPanelVisible }">
            <div class="chat-main">
              <button v-if="attentionTasks.length && !workPanelVisible" type="button" class="attention-strip" @click="attentionTasks.length === 1 ? openEmployeeTask(attentionTasks[0].id) : showTasks('attention')">
                <Icon name="hand" :size="16" /><span><strong>{{ attentionTasks.length }} 项需要你处理</strong><span class="truncate">{{ attentionTasks[0].text }}</span></span><Icon name="right" :size="16" />
              </button>
              <EmployeeChat :key="user.id + ':' + selectedEmployee" :api="api" :user-id="user.id" :employee-id="selectedEmployee" :name="employee.name" :avatar="employee.avatar" :readonly="!canExecute" :composer="employeeComposers[selectedEmployee]" :revision="employeeSessionVersion" :event="employeeEvent" :tasks="employee.tasks" :remember="employee.canManage ? saveMemory : undefined" @task="openEmployeeTask" />
            </div>
            <button v-if="workPanelVisible && !wide" type="button" class="panel-backdrop" aria-label="关闭当前工作" tabindex="-1" @click="workRailOpen = false"></button>
            <WorkPanel v-if="workPanelVisible" :attention="attentionTasks" :active="activeTasks" :readonly="!canExecute" :act="employeeTaskAction" :overlay="!wide" @open="(id) => { workRailOpen = false; openEmployeeTask(id); }" @all="showTasks" @close="wide ? (workPanelHidden = true) : (workRailOpen = false)" />
          </div>
          <div v-if="employeeTab === 'browser' && selectedEmployee" class="employee-browser"><BrowserView :key="selectedEmployee" :api="employeeBrowserApi" :employee-id="selectedEmployee" /></div>
          <EmployeeTasks
            v-if="employeeTab === 'tasks'"
            :key="selectedEmployee"
            :active="activeTasks"
            :attention="attentionTasks"
            :history="historyTasks"
            :filter="employeeTaskFilter"
            :focus="employeeTaskFocus"
            :readonly="!canExecute"
            :act="employeeTaskAction"
            :save-memory="saveMemory"
            @filter="employeeTaskFilter = $event"
            @select="employeeTaskFocus = $event"
            @inspect="openEmployee($event)"
            @chat="employeeTab = 'chat'"
          />
          <div v-if="employeeTab === 'duties'" class="page-scroll"><EmployeeDuties :key="selectedEmployee" :duties="employee.duties || []" :can-manage="employee.canManage" :save="saveDuty" :remove="removeDuty" /></div>
          <div v-if="employeeTab === 'memories'" class="page-scroll"><EmployeeMemories :key="selectedEmployee" :memories="employee.memories || []" :can-manage="employee.canManage" :save="saveMemory" :forget="forgetMemory" :resolve="resolveMemory" :pin="pinMemory" /></div>
          <EmployeeCapabilities v-if="employeeTab === 'capabilities'" :key="user.id + ':' + selectedEmployee" :api="api" :employee-id="selectedEmployee" @error="employeeError = $event" @notice="toast" />
          <EmployeeSettings
            v-if="employeeTab === 'settings' && employee.canManage"
            :employee="employee"
            :api="api"
            :saving="employeeSaving"
            :deleting="employeeDeleting"
            :clearing="employeeClearing"
            :busy="employeeExecutionBusy"
            @save="saveEmployeeSettings"
            @delete="deleteEmployee"
            @clear-chat="clearEmployeeChat"
            @execution="changeEmployeeExecution"
            @avatar="selectedEmployee === $event.employeeId && (employee.avatar = $event.avatar)"
            @cancel="employeeTab = 'chat'"
          />
        </template>
      </section>
      <ResourcesView v-else-if="view === 'resources'" />
      <BrowserView v-else-if="view === 'browser' && isAdmin" :api="api" />
      <ExperiencesView v-else-if="view === 'experiences' && isAdmin" :api="api" />
      <SettingsView v-else-if="view === 'settings' && isAdmin" :api="api" :config="config" :user-id="user.id" :models="catalogModels" @saved="config = $event" @error="error = $event" @notice="notice = $event" />
    </section>
    <div class="toasts" aria-live="polite">
      <div v-if="error" class="toast error" role="alert"><Icon name="alert" :size="16" /><span>{{ error }}</span><button type="button" class="icon" aria-label="关闭错误" @click="error = ''"><Icon name="close" :size="14" /></button></div>
      <div v-if="notice" class="toast notice" role="status"><Icon name="check" :size="16" /><span>{{ notice }}</span><button type="button" class="icon" aria-label="关闭提示" @click="notice = ''"><Icon name="close" :size="14" /></button></div>
    </div>
  </div>
</template>

<style scoped>
.employee-workspace { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.employee-workspace > .banner { flex: none; }
.employee-workspace > .page-scroll { padding: 20px 24px; }
.employee-chat-layout { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; }
.chat-main { position: relative; display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.attention-strip { display: flex; align-items: center; justify-content: flex-start; gap: 10px; flex: none; width: calc(100% - 24px); max-width: 796px; height: auto; min-height: 44px; margin: 10px auto 0; padding: 8px 12px; border: 1px solid var(--warn-border); border-radius: var(--r-lg); background: var(--warn-soft); color: var(--warn); text-align: left; }
.attention-strip:hover:not(:disabled) { border-color: var(--warn); background: var(--warn-soft); }
.attention-strip > span { display: grid; flex: 1; min-width: 0; gap: 1px; }
.attention-strip strong { font-size: 13px; }
.attention-strip span span { color: var(--text-2); font-size: 12px; font-weight: 400; }
.panel-backdrop { position: absolute; inset: 0; z-index: 19; border: 0; border-radius: 0; background: rgb(15 20 30 / 22%); animation: fade-in .15s ease; }
.panel-backdrop:hover:not(:disabled) { background: rgb(15 20 30 / 22%); }
.employee-browser { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.create-page { display: grid; align-content: start; justify-items: center; }
.create-card { display: grid; gap: 18px; width: 100%; max-width: 600px; margin-top: 8px; padding: 24px; box-shadow: var(--sh-sm); }
.create-head { display: flex; align-items: center; gap: 12px; }
.create-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--accent-soft); color: var(--accent); }
.create-head h3 { font-size: 18px; }
.create-facts { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; color: var(--text-2); font-size: 12px; }
.create-facts li { display: flex; align-items: center; gap: 8px; }
.create-facts .icon-svg { color: var(--ok); }
.create-page .empty-state { width: 100%; max-width: 600px; }
@media (max-width: 767px) {
  .employee-workspace > .page-scroll { padding: 12px; }
  .create-card { padding: 16px; margin-top: 0; }
  .attention-strip { width: calc(100% - 16px); margin-top: 8px; }
}
</style>
