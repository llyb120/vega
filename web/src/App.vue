<script setup vapor>
import SettingsView from "./SettingsView.vue";
import { LocalAgentPairing, canBridgeLocal, pairingStatusText } from "./local-agent";
import ConversationTimeline from "./ConversationTimeline.vue";
import ExperiencesView from "./ExperiencesView.vue";
import { formatBeijing } from "../../shared/time";
import { dutyCondition, dutyContent } from "../../shared/duty-condition";
import EmployeeSessionView from "./EmployeeSessionView.vue";
import EmployeeChat from "./EmployeeChat.vue";
import EmployeeChrome from "./EmployeeChrome.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import EmployeeAvatarPicker from "./EmployeeAvatarPicker.vue";
import EmployeeTaskCard from "./EmployeeTaskCard.vue";
import DebugSessions from "./DebugSessions.vue";
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
  employee: "数字员工",
  debug: "调试会话",
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
  employeeDeleting = ref(false),
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
  vaultEntries = ref([]),
  employeeSession = ref(""),
  employeeSessionVersion = ref(0),
  employeeError = ref(""),
  taskText = ref(""),
  memoryText = ref(""),
  memoryID = ref(""),
  importance = ref(1),
  activeTaskCount = ref(null);
const duty = ref(emptyDuty()),
  dutySaving = ref(false),
  dutyOpen = ref(false);
watch(selectedEmployee, () => { workRailOpen.value = false; });

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
    condition: "",
    text: "",
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
const employeeTabs = computed(() => [['chat', '对话'], ['tasks', '任务'], ...(employee.value.canManage ? [['browser', '浏览器']] : []), ['duties', '职责'], ['memories', '记忆']]);
const employeeGroups = computed(() => [['team', '团队员工'], ['personal', isAdmin.value ? '个人员工' : '我的员工']].map(([scope, label]) => ({ scope, label, entries: employees.value.filter((employee) => employee.scope === scope) })).filter((group) => group.entries.length));
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
      const id = String(++wsRequestSerial).padStart(8, "0"),
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
    clientListReady.value = false;
    onlineClients.value = [];
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
  vaultEntries.value = [];
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
function employeeLocationChanged() {
  if (user.value) return chooseEmployee(new URL(window.location.href).searchParams.get("employee") || "");
}
function setEmployeeURL(id, replace = false) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("employee", id);
  else url.searchParams.delete("employee");
  if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"](null, "", url.href);
}
async function loadEmployee() {
  if (!user.value) return;
  const owner = user.value.id;
  const list = await api("/employees");
  if (user.value?.id !== owner) return;
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
  employeeComposers.value[id] ||= { text: "", images: [] };
  const data = await api(`/employees/${id}`);
  if (user.value?.id !== owner || selectedEmployee.value !== id) return;
  if (employeeTab.value !== "settings" || employee.value.id !== id) employee.value = data;
  else { employee.value.tasks = data.tasks; employee.value.busy = data.busy; employee.value.chatRunning = data.chatRunning; employee.value.executionClients = data.executionClients; employee.value.execution = data.execution; employee.value.avatar = data.avatar; }
}
function employeeApi(path, method = "GET", data) {
  if (!selectedEmployee.value) throw Error("请先创建员工");
  return api(path.replace(/^\/employee(?=\/|$)/, `/employees/${selectedEmployee.value}`), method, data);
}
function employeeBrowserApi(path, method = "GET", data) {
  return api(path.replace(/^\/chrome/, `/employees/${selectedEmployee.value}/chrome`), method, data);
}
async function chooseEmployee(id) {
  selectedEmployee.value = id;
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
  const id = employee.value.id, name = employee.value.name;
  if (!confirm(`永久删除「${name}」？\n\n将删除该员工的职责、记忆、所有任务和执行会话，并清除其浏览器登录数据。项目文件和共享密码本不会删除；已提交的外部作业不会自动取消。此操作不可撤销。`)) return;
  employeeDeleting.value = true;
  try {
    await api(`/employees/${id}?confirmed=true`, "DELETE");
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
  await nextTick();
  const card = [...document.querySelectorAll(".work-item[data-task-id]")].find((element) => element.dataset.taskId === id);
  card?.scrollIntoView({ block: "start", behavior: "instant" });
  card?.focus({ preventScroll: true });
}
async function employeeTabChanged(id) {
  employeeTab.value = id;
  if (id === "settings" && isAdmin.value) {
    try { vaultEntries.value = (await api("/vault")).entries; }
    catch (error) { employeeError.value = error.message; }
  }
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
  const result = await employeeApi("/employee", "POST", data);
  await loadEmployee();
  return result;
}
async function control(data) {
  await employeeApi("/employee/control", "POST", data);
  await loadEmployee();
}
async function addTask() {
  await attempt(async () => {
    await employeeAction({
      action: "add",
      kind: "todo",
      text: taskText.value,
      cwd: employee.value.cwd,
    });
    taskText.value = "";
  });
}
function editDuty(d) {
  duty.value = { id: d.id, condition: dutyCondition(d), text: dutyContent(d) };
  dutyOpen.value = true;
}
async function saveDuty() {
  if (dutySaving.value) return;
  const employeeId = selectedEmployee.value, actor = user.value?.id;
  dutySaving.value = true;
  try { await attempt(async () => {
    const d = duty.value;
    await employeeAction({ action: d.id ? "update" : "add", kind: "duty", id: d.id || undefined, condition: d.condition, text: d.text, note: "" }).catch(error => {
      if (selectedEmployee.value === employeeId && user.value?.id === actor) throw error;
    });
    if (selectedEmployee.value !== employeeId || user.value?.id !== actor || duty.value !== d) return;
    dutyOpen.value = false;
    duty.value = emptyDuty();
  }); } finally { dutySaving.value = false; }
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
  if (employeeSaving.value) return;
  const id = employee.value.id;
  employeeSaving.value = true;
  try { await attempt(async () => {
    await control({
      action: "settings",
      name: employee.value.name,
      instruction: employee.value.instruction,
      cwd: employee.value.cwd,
      ...(isAdmin.value ? { vaultIds: employee.value.vaultIds || [] } : {}),
    });
    toast("员工设置已保存");
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
        pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,63}"
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
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <strong>{{ view === 'employee' ? creatingEmployee ? '创建员工' : employee.name || '数字员工' : view === 'chat' ? conversationTitle : mobileTitles[view] }}</strong>
      <span
        v-if="view !== 'employee'"
        class="pill"
        :class="{ green: localConnected }"
        role="status"
        :title="clientStatus + ' · 新会话可选择任意在线客户端，已有会话不会自动切换'"
      >{{ clientStatus }}</span>
      <span
        v-if="narrow && view === 'chat' && isRunning"
        class="status-dot"
        role="status"
        aria-label="执行中"
      ></span>
      <select
        v-if="narrow && view === 'chat' && stagePath.length > 1"
        class="stage-switch"
        aria-label="切换会话 Stage"
        :value="current?.id"
        @change="selectSession(stagePath.find((s) => s.id === $event.target.value))"
      >
        <option :value="stagePath[0].id">主对话</option>
        <option
          v-for="(stage, i) in stagePath.slice(1)"
          :key="stage.id"
          :value="stage.id"
        >
          Stage {{ i + 1 }}
        </option>
      </select>
      <details v-if="view === 'employee' && employee.canManage && !creatingEmployee && !employeeSession" ref="employeeMenu" class="employee-mobile-menu">
        <summary aria-label="员工更多操作">···</summary>
        <div class="employee-mobile-actions"><small>{{ employeeStatus }}</small><button @click="employeeTabChanged('settings'); employeeMenu.open = false">员工设置</button><button :aria-expanded="employeeExecutionOpen" @click="employeeExecutionOpen = !employeeExecutionOpen; employeeMenu.open = false">新任务执行位置 · {{ employee.execution?.localAgent ? employee.execution.clientName || '客户端' : '服务端' }}</button><button class="employee-delete" :disabled="employeeDeleting" @click="employeeMenu.open = false; deleteEmployee()">删除员工</button></div>
      </details>
      <button
        v-if="canExecute && view === 'chat'"
        class="icon mobile-control"
        aria-label="交给员工"
        @click="openEmployee()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <span v-else-if="view !== 'employee' || !employee.canManage || creatingEmployee || employeeSession" class="mobile-header-spacer" aria-hidden="true"></span>
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
        <span class="brand-edition">工作台</span>
        <button
          class="icon close-navigation"
          aria-label="关闭导航"
          @click="closeNavigation"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <button v-if="canExecute" class="new-session" @click="creatingEmployee = true; openEmployee()">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>创建员工</span>
      </button>
      <div class="employee-list">
        <template v-for="group in employeeGroups" :key="group.scope"><div class="employee-group-label"><span>{{ group.label }}</span><span>{{ group.entries.length }}</span></div>
        <button v-for="entry in group.entries" :key="entry.id" class="session-row" :class="{ active: view === 'employee' && selectedEmployee === entry.id }" @click="chooseEmployee(entry.id)">
          <span class="employee-nav-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="entry.id" :name="entry.name" :avatar="entry.avatar" /></span><span class="employee-nav-info"><strong class="truncate">{{ entry.name }}</strong><small>{{ entry.attentionTasks ? entry.attentionTasks + ' 项待处理' : entry.activeTasks ? entry.activeTasks + ' 项进行中' : '随时待命' }}</small></span><span v-if="entry.activeTasks" :class="['count', { attention: entry.attentionTasks }]">{{ entry.activeTasks }}</span>
        </button></template>
      </div>
      <nav aria-label="主导航" @click="closeNavigation">
        <button
          v-if="isAdmin"
          :class="{ selected: view === 'experiences' }"
          @click="view = 'experiences'"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="18" cy="6" r="2.5" />
            <circle cx="12" cy="18" r="2.5" />
            <path d="m8 7 3 8.5M16 7l-3 8.5M8.5 6h7" />
          </svg>
          <span>经验图谱</span>
        </button>
        <button v-if="isAdmin" :class="{ selected: view === 'debug' }" @click="view = 'debug'"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18" /></svg><span>调试会话</span></button>
        <button
          :class="{ selected: view === 'account' }"
          @click="view = 'account'"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
          </svg>
          <span>账号</span>
        </button>
        <button
          v-if="isAdmin"
          :class="{ selected: view === 'settings' }"
          @click="view = 'settings'"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.7-1.7l.9-1.9-2.1-2.1-1.9.9a7 7 0 0 0-1.7-.7L10.5 2h-3l-.7 2a7 7 0 0 0-1.7.7l-1.9-.9-2.1 2.1.9 1.9a7 7 0 0 0-.7 1.7l-2 .7v3l2 .7a7 7 0 0 0 .7 1.7l-.9 1.9 2.1 2.1 1.9-.9a7 7 0 0 0 1.7.7l.7 2h3l.7-2a7 7 0 0 0 1.7-.7l1.9.9 2.1-2.1-.9-1.9a7 7 0 0 0 .7-1.7Z" transform="translate(3 1) scale(.75)" />
          </svg>
          <span>设置</span>
        </button>
      </nav>
      <div v-if="view === 'chat'" class="sidebar-heading">
        <span>最近会话</span><span>{{ rootSessions.length }}</span>
      </div>
      <div v-if="view === 'chat'" class="session-list">
        <div
          v-for="s in rootSessions"
          :key="s.id"
          class="session-row"
          :class="{ active: rootSession?.id === s.id && view === 'chat' }"
        >
          <button @click="attempt(() => selectSession(s))">
            <span :class="['dot', { working: running[s.id] }]"></span
            ><span class="truncate">{{ s.title }}</span></button
          ><button
            v-if="
              !s.taskId &&
              !running[s.id] &&
              canExecute &&
              s.ownerId === user.id
            "
            class="delete icon"
            title="删除会话"
            @click="removeSession(s)"
          >
            ×
          </button>
        </div>
        <p v-if="!rootSessions.length" class="empty-small">从一个问题开始。</p>
      </div>
      <footer>
        <span class="account-avatar" aria-hidden="true">{{ user?.username?.slice(0, 1).toUpperCase() }}</span>
        <span class="account-meta"><strong>{{ user?.username }}</strong><small>{{ isAdmin ? '管理员' : '成员' }}</small></span>
        <button class="icon" aria-label="退出登录" title="退出登录" @click="logout">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5M14 8l4 4-4 4M8 12h10" />
          </svg>
        </button>
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
      <div v-if="view === 'chat' && localPairing && localPairing.code !== 'connected'" class="banner notice" role="status">
        <span>{{ localPairingText }}</span>
        <button type="button" @click="retryLocalPairing">重新检测</button>
      </div>
      <template v-if="view === 'chat'">
        <header v-if="!narrow" class="topbar chat-topbar">
          <div>
            <span class="topbar-eyebrow">工作台 / 对话</span>
            <h2>
              {{ conversationTitle }}
              <span v-if="current?.stageSource" class="pill">Stage</span>
            </h2>
            <p>{{ current ? (current.cwd || project) : '随时开始一个新对话' }}</p>
            <select
              v-if="stagePath.length > 1"
              class="stage-switch"
              aria-label="切换会话 Stage"
              :value="current?.id"
              @change="selectSession(stagePath.find((s) => s.id === $event.target.value))"
            >
              <option :value="stagePath[0].id">主对话</option>
              <option
                v-for="(stage, i) in stagePath.slice(1)"
                :key="stage.id"
                :value="stage.id"
              >
                Stage {{ i + 1 }} · {{ stage.title }}
              </option>
            </select>
          </div>
          <div class="actions">
            <span
              class="pill"
              :class="{ green: localConnected }"
              role="status"
              :title="clientStatus + ' · 新会话可选择任意在线客户端，已有会话不会自动切换'"
            >{{ clientStatus }}</span>
            <span v-if="isRunning" class="pill green"><span class="status-dot"></span>执行中</span>
            <button v-if="canExecute" class="topbar-new" @click="openEmployee()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              交给员工
            </button>
          </div>
        </header>
        <div ref="transcript" :key="current?.id ?? 'none'" class="transcript" aria-live="polite">
          <div v-if="sessionLoading" class="context-note">正在加载会话…</div>
          <div
            v-if="!sessionLoading && !messages.length && !live"
            class="welcome"
          >
            <span class="welcome-kicker">VEGA WORKSPACE</span>
            <h1>今天想完成什么？</h1>
            <p>从一个问题开始。Vega 可以分析项目、探索网页，或把任务交给数字员工。</p>
            <div v-if="canWriteCurrent" class="suggestions">
              <button @click="draft = '分析当前项目结构，提出最小改进方案'">
                <span class="suggestion-index">01</span><span>分析一个项目<small>梳理结构，找到最小改进路径</small></span><span aria-hidden="true">↗</span>
              </button>
              <button @click="draft = '请用 Chrome 查看当前标签页'">
                <span class="suggestion-index">02</span><span>探索网页<small>查看当前页面并提取有效信息</small></span><span aria-hidden="true">↗</span>
              </button>
              <button v-if="isAdmin" @click="openEmployee()">
                <span class="suggestion-index">03</span><span>交给数字员工<small>创建可持续推进的独立任务</small></span><span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
          <div v-if="fireState" class="context-note">
            Fire · 第 {{ fireState.attempt }} 次 ·
            {{ fireState.role === "judge" ? "独立验收" : "执行" }} ·
            {{ fireState.status }}
            <p v-if="fireState.reason">{{ fireState.reason }}</p>
          </div>
          <ConversationTimeline :key="current?.id ?? 'none'" :messages="messages" :running="!!isRunning" :live="live" :thinking="thinking" :active-tools="activeTools" :model="model" />
        </div>
        <p v-if="!canWriteCurrent" class="context-note">
          历史会话仅供查阅；继续工作请交给员工，执行会话由员工管理。
        </p>
        <div v-if="canWriteCurrent" class="composer-wrap">
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
                  : '输入消息，Enter 发送…'
              "
              rows="2"
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
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <input
                ref="imageInput"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                multiple
                hidden
                @change="upload"
              />
              <button
                type="button"
                class="execution-switch"
                role="switch"
                aria-label="客户端执行（关闭时在服务端执行）"
                :aria-checked="executionLocal"
                :class="{ local: executionLocal }"
                :title="executionHint"
                :disabled="executionBusy || (!executionLocal && !localConnected)"
                @click="toggleExecution"
              >
                <span :class="{ selected: !executionLocal }">服务端</span>
                <span class="execution-track" aria-hidden="true"></span>
                <span :class="{ selected: executionLocal }">客户端</span>
              </button>
              <select
                v-if="executionLocal"
                class="execution-client"
                aria-label="执行客户端"
                :value="executionClientId"
                :disabled="executionBusy"
                @change="changeClient"
              >
                <option v-if="!selectedClient" :value="executionClientId" disabled>
                  {{ current?.clientName ? current.clientName + ' · 离线' : '请选择在线客户端' }}
                </option>
                <option v-for="client in onlineClients" :key="client.id" :value="client.id">
                  {{ client.name }} · {{ client.platform }} · {{ client.id.slice(0, 6) }} · 在线
                </option>
              </select>
              <div v-if="!isRunning" class="context-controls"></div>
              <span class="hint">Enter 发送 · Shift + Enter 换行</span>
              <button
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
                  sending || switchingExecution || uploading || executionUnavailable || (!draft.trim() && !attachments.length)
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
          <p v-if="executionUnavailable" class="execution-warning" role="status">
            所选客户端已离线或尚未选择，请选择在线客户端或切换到服务端；不会自动切换或重试操作。
          </p>
        </div>
      </template>
      <Accounts
        v-else-if="view === 'account'"
        :api="api"
        :user="user"
        @error="error = $event"
        @notice="notice = $event"
        @signed-out="resetLogin"
        @changed="attempt(bootstrap)"
      />
      <DebugSessions v-else-if="view === 'debug' && isAdmin" :api="api" :revision="debugRevision" />
      <EmployeeSessionView
        v-else-if="view === 'employee' && employeeSession"
        :api="api"
        :session-id="employeeSession"
        :revision="employeeSessionVersion"
        @back="openEmployee()"
      />
      <section v-else-if="view === 'employee'" class="employee-workspace" :aria-busy="employeeDeleting">
        <EmployeeChrome
          v-if="employees.length && !creatingEmployee"
          :employee="employee"
          :status="employeeStatus"
          :attention="attentionTasks.length > 0"
          :tabs="employeeTabs"
          :tab="employeeTab"
          :active-count="activeTasks.length"
          :execution-open="employeeExecutionOpen"
          :deleting="employeeDeleting"
          :busy="employeeExecutionBusy"
          :show-work="employeeTab === 'chat'"
          :work-open="workRailOpen"
          :work-count="attentionTasks.length || activeTasks.length"
          @tab="employeeTabChanged"
          @settings="employeeTabChanged('settings')"
          @delete="deleteEmployee"
          @toggle-execution="employeeExecutionOpen = !employeeExecutionOpen"
          @execution="changeEmployeeExecution"
          @toggle-work="workRailOpen = !workRailOpen"
        />
        <header v-else class="employee-header employee-header-create">
          <div class="employee-title-block">
            <h2>{{ creatingEmployee || !employees.length ? '创建新员工' : employee.name || '加载中…' }}</h2>
            <p class="employee-toolbar-sub">取个名字，交代他的工作方向，就可以开始了。</p>
          </div>
        </header>
        <div class="employee-content" :class="{ 'is-chat': employeeTab === 'chat' && !creatingEmployee && employees.length, 'is-browser': employeeTab === 'browser' && !creatingEmployee }">
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
          <div v-if="!employees.length && !canExecute" class="employee-empty"><h3>还没有团队员工</h3><p>管理员创建的团队员工会出现在这里。</p></div>
          <form v-if="(creatingEmployee || !employees.length) && canExecute" class="employee-create card form-grid" @submit.prevent="createEmployee">
            <span class="employee-eyebrow">{{ isAdmin ? '团队员工 · 所有成员可见' : '个人员工 · 仅本人和管理员可见' }}</span><h3>你想把什么交给他？</h3>
            <label>员工名称<input v-model="newEmployeeName" required maxlength="80" placeholder="例如：研发助手、运营搭档" autofocus /></label>
            <label>工作方向<textarea v-model="newEmployeeInstruction" rows="4" maxlength="8000" placeholder="例如：负责项目开发，先检查现有实现，完成后验证并汇报结果。"></textarea></label>
            <p class="hint">创建后即可接活。独立记忆、任务和浏览器会自动准备，无需设置启用或工作时间。</p>
            <div class="actions"><button v-if="employees.length" type="button" @click="creatingEmployee = false">取消</button><button class="primary" :disabled="employeeSaving">{{ employeeSaving ? '正在创建…' : '创建员工' }}</button></div>
          </form>
          <EmployeeAvatarPicker v-if="employeeTab === 'settings' && employee.canManage && employees.length && !creatingEmployee" :key="selectedEmployee" :api="api" :employee-id="selectedEmployee" :name="employee.name" :avatar="employee.avatar" @change="selectedEmployee === $event.employeeId && (employee.avatar = $event.avatar)" />
          <form v-if="employeeTab === 'settings' && employee.canManage && employees.length && !creatingEmployee" class="employee-settings-form card form-grid" @submit.prevent="saveEmployeeSettings">
            <div><h3>员工资料</h3><p class="hint">保存后，新任务会使用更新的工作原则和目录。</p></div>
            <label>姓名<input v-model="employee.name" maxlength="80" required /></label>
            <label>工作原则<textarea v-model="employee.instruction" maxlength="8000"></textarea></label>
            <label>工作目录<input v-model="employee.cwd" required /></label>
            <fieldset v-if="isAdmin && vaultEntries.length"><legend>允许使用的密码本条目</legend><label v-for="entry in vaultEntries" :key="entry.id"><input v-model="employee.vaultIds" type="checkbox" :value="entry.id" /> {{ entry.name }} · {{ entry.condition }}</label></fieldset>
            <div class="actions"><button type="button" @click="employeeTab = 'chat'">返回对话</button><button class="primary" :disabled="employeeSaving">{{ employeeSaving ? '保存中…' : '保存修改' }}</button></div>
          </form>
          <div v-if="employeeTab === 'chat' && selectedEmployee && employee.id === selectedEmployee && !creatingEmployee" class="employee-chat-layout" :class="{ 'work-open': workRailOpen }">
            <EmployeeChat :key="selectedEmployee" :api="api" :employee-id="selectedEmployee" :name="employee.name" :avatar="employee.avatar" :readonly="!canExecute" :composer="employeeComposers[selectedEmployee]" :revision="employeeSessionVersion" :event="employeeEvent" @task="openEmployeeTask" />
            <aside v-if="workRailOpen" class="employee-work-summary" aria-label="当前工作"><div class="summary-heading"><h3>当前工作</h3><button class="link" @click="employeeTab = 'tasks'">全部任务 ↗</button></div><button v-if="attentionTasks.length" class="attention-shortcut" @click="employeeTaskFilter = 'attention'; employeeTab = 'tasks'"><strong>{{ attentionTasks.length }} 项需要你处理</strong><span>补充信息或审批后继续 →</span></button><div v-if="!activeTasks.length" class="summary-empty"><span aria-hidden="true">✓</span><strong>手头很清爽</strong><p>交代一个目标，我会在这里更新进度。</p></div><button v-for="task in activeTasks.slice(0, 5)" :key="task.id" class="summary-task" @click="employeeTaskFilter = ['waiting', 'approval'].includes(task.status) ? 'attention' : 'active'; employeeTab = 'tasks'"><span :class="['summary-task-status', task.status]">{{ labels[task.status] }}</span><strong>{{ task.text }}</strong><span v-if="task.progress?.length">{{ task.progress.at(-1).text }}</span></button></aside>
          </div>
          <div v-if="employeeTab === 'browser' && selectedEmployee && !creatingEmployee" class="employee-browser"><BrowserView :key="selectedEmployee" :api="employeeBrowserApi" :employee-id="selectedEmployee" /></div>
          <template v-if="employeeTab === 'tasks' && !creatingEmployee"
            ><details class="employee-section-tip"><summary>任务说明</summary><p>新任务先由轻量模型起步，涉及编码再在原会话升级。</p></details><form v-if="canExecute" class="inline-form employee-task-form" @submit.prevent="addTask">
              <input
                v-model="taskText"
                required
                placeholder="交给员工：一件有明确目标的事"
              /><button class="primary">交给员工</button>
            </form>
            <div class="employee-task-filters" aria-label="筛选任务"><button v-for="[id, label, count] in [['active', '进行中', activeTasks.length], ['attention', '待我处理', attentionTasks.length], ['history', '已结束', historyTasks.length]]" :key="id" :class="{ selected: employeeTaskFilter === id }" :aria-pressed="employeeTaskFilter === id" @click="employeeTaskFilter = id">{{ label }} <span>{{ count }}</span></button></div>
            <div v-if="!visibleEmployeeTasks.length" class="employee-empty"><span aria-hidden="true">✓</span><h3>{{ employeeTaskFilter === 'attention' ? '没有需要你处理的事项' : employeeTaskFilter === 'history' ? '还没有结束的任务' : '暂时没有进行中的任务' }}</h3><p>在对话中交代工作，或在上方直接创建任务。</p><button v-if="employeeTaskFilter !== 'history'" @click="employeeTab = 'chat'">去交代工作</button></div>
            <EmployeeTaskCard v-for="task in visibleEmployeeTasks" :key="selectedEmployee + task.id" :task="task" :highlighted="employeeTaskFocus === task.id" :readonly="!canExecute" :act="(action, text) => employeeTaskAction(task, action, text)" @inspect="openEmployee($event)" /></template
          >
          <template v-if="employeeTab === 'duties' && !creatingEmployee"
            ><div class="section-heading">
              <h3>职责模板</h3>
              <button
                v-if="employee.canManage"
                class="primary"
                @click="
                  duty = emptyDuty();
                  dutyOpen = true;
                "
              >
                ＋ 新增职责
              </button>
            </div>
            <form v-if="dutyOpen && employee.canManage" class="card form-grid duty-editor" @submit.prevent="saveDuty">
              <label>触发条件<textarea v-model="duty.condition" rows="2" maxlength="2000" required :disabled="dutySaving" placeholder="例如：每天上午9点；每30分钟检查一次；按交代的任务需要"></textarea></label>
              <label>职责内容<textarea v-model="duty.text" rows="5" maxlength="8000" required :disabled="dutySaving" placeholder="说明要做什么、处理范围和交付要求"></textarea></label>
              <p class="hint">保存时自动识别触发方式，时间按北京时间；无法自动执行的条件会明确提示。</p>
              <div class="actions"><button class="primary" :disabled="dutySaving">{{ dutySaving ? '正在保存…' : '保存职责' }}</button><button type="button" :disabled="dutySaving" @click="dutyOpen = false">取消</button></div>
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
                <span class="pill duty-condition">{{ dutyCondition(d) }}</span><span class="hint">{{ d.enabled ? "启用" : "停用" }}</span>
              </div>
              <p class="employee-duty-content">{{ dutyContent(d) }}</p>
              <div class="card-actions">
                <button v-if="employee.canManage" @click="editDuty(d)">编辑</button><button v-if="employee.canManage" class="link" @click="attempt(() => employeeAction({ action: 'update', id: d.id, enabled: !d.enabled }))">{{ d.enabled ? '停用' : '启用' }}</button>
                <button
                  v-if="employee.canManage"
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
          <template v-if="employeeTab === 'memories' && !creatingEmployee"
            ><form v-if="employee.canManage" class="inline-form" @submit.prevent="addMemory">
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
                  v-if="employee.canManage"
                  @click="
                    memoryID = m.id;
                    memoryText = m.text;
                    importance = m.importance;
                  "
                >
                  编辑</button
                ><button
                  v-if="employee.canManage"
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

        </div>
      </section>
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
        @saved="config = $event"
        @error="error = $event"
        @notice="notice = $event"
      />
    </section>
  </div>
</template>

<style scoped>
.employee-group-label { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin: 12px 8px 6px; }
.employee-list { flex: 1; min-height: 44px; overflow-y: auto; padding: 0 8px; }
.employee-list > button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 48px; margin: 2px 0; padding: 8px; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 10px; }
.employee-list > button.active { color: var(--accent); background: var(--surface); border-color: var(--border); box-shadow: var(--sh-xs); }
.employee-nav-avatar { display: grid; place-items: center; flex: none; width: 30px; height: 32px; border-radius: 8px; font-weight: 650; background: var(--accent-soft); color: var(--accent); }
.employee-nav-info { display: grid; gap: 2px; flex: 1; min-width: 0; }
.employee-nav-info strong { font-weight: 600; font-size: 13px; }
.employee-nav-info small { color: var(--muted); font-size: 10px; }
.employee-list .count.attention { color: var(--amber); background: var(--amber-soft); }
.employee-workspace { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.employee-header-create { display: flex; align-items: center; width: 100%; min-height: 44px; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
.employee-header-create h2 { margin: 0; font-size: 15px; }
.employee-toolbar-sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.employee-eyebrow { font-size: 11px; color: var(--muted); }
.employee-content { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; padding: 16px 20px; background: var(--surface-sunken); scrollbar-width: thin; }
.employee-content > * { max-width: 1040px; margin-left: auto; margin-right: auto; }
.employee-content.is-chat, .employee-content.is-browser { padding: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--surface); }
.employee-content > .banner { flex: none; margin: 12px 24px; }
.employee-content > .employee-chat-layout { max-width: none; margin: 0; }
.employee-chat-layout { display: grid; grid-template-columns: minmax(0, 1fr); position: relative; flex: 1; min-height: 0; }
.employee-chat-layout.work-open { grid-template-columns: minmax(0, 1fr) 260px; }
.employee-work-summary { overflow-y: auto; padding: 12px 14px; border-left: 1px solid var(--border); background: var(--surface-sunken); scrollbar-width: thin; }
.summary-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.summary-heading h3 { margin: 0; font-size: 12px; }
.summary-heading button { font-size: 11px; padding: 4px; }
.summary-empty { padding: 16px 4px; text-align: center; color: var(--text-secondary); }
.summary-empty > span { display: block; margin-bottom: 8px; color: var(--green); font-size: 18px; }
.summary-empty strong { font-size: 12px; }
.summary-empty p { font-size: 11px; line-height: 1.6; color: var(--muted); margin: 0; }
.attention-shortcut, .summary-task { display: grid; gap: 8px; text-align: left; width: 100%; margin-top: 14px; padding: 14px; background: var(--surface); font-size: 12px; line-height: 1.65; white-space: normal; overflow-wrap: anywhere; border-radius: 10px; }
.summary-task strong { font-size: 12px; font-weight: 550; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.summary-task > span:last-child { font-size: 11px; color: var(--muted); }
.summary-task-status { color: var(--accent); font-size: 10px; }
.attention-shortcut { background: var(--amber-soft); color: var(--amber); border-color: oklch(0.89 0.06 75); }
.attention-shortcut span { font-size: 11px; }
.employee-browser { flex: 1; min-height: 0; width: 100%; max-width: none; display: flex; flex-direction: column; }
.duty-condition { white-space: normal; overflow-wrap: anywhere; max-width: 100%; }
.employee-duty-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.75; }
.employee-section-tip { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.employee-section-tip summary { cursor: pointer; padding: 10px 12px; font-size: 12px; font-weight: 600; color: var(--text-secondary); list-style: none; }
.employee-section-tip summary::-webkit-details-marker { display: none; }
.employee-section-tip p { margin: 0; padding: 0 12px 12px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.employee-task-form { background: var(--surface); padding: 10px; border: 1px solid var(--border); border-radius: 10px; }
.employee-task-form input { min-width: 140px; }
.employee-task-filters { display: flex; gap: 6px; margin-bottom: 18px; overflow-x: auto; }
.employee-task-filters button { background: transparent; border: 1px solid transparent; font-size: 12px; padding: 8px 12px; white-space: nowrap; }
.employee-task-filters button.selected { background: var(--surface); border-color: var(--border); color: var(--accent); box-shadow: var(--sh-xs); }
.employee-task-filters span { margin-left: 7px; color: var(--muted); font-size: 11px; }
.employee-create { max-width: 640px; margin-top: 24px; padding: 32px; }
.employee-create h3 { margin: 0; font-size: 24px; letter-spacing: -.03em; }
.employee-create .actions, .employee-settings-form .actions { justify-content: flex-end; }
.employee-settings-form { max-width: 720px; padding: 28px; }
.employee-settings-form h3 { margin: 0; font-size: 18px; }
.employee-settings-form fieldset { min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.employee-settings-form fieldset label { display: flex; gap: 8px; padding: 7px 0; align-items: center; font-size: 12px; }
.employee-empty { padding: 28px 16px; text-align: center; }
.employee-empty > span { display: block; color: var(--green); font-size: 22px; }
.employee-empty h3 { margin: 10px 0 8px; font-size: 15px; }
.employee-empty p { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
@media (max-width: 1180px) {
  .employee-chat-layout.work-open { grid-template-columns: minmax(0, 1fr); }
  .employee-work-summary { display: none; }
  .employee-chat-layout.work-open .employee-work-summary { display: block; position: absolute; top: 0; right: 0; bottom: 0; width: min(280px, 88vw); z-index: 6; box-shadow: var(--sh-lg); }
}
@media (max-width: 700px) {
  .employee-content { padding: 12px; }
  .employee-create, .employee-settings-form { padding: 18px 14px; margin-top: 0; }
  .employee-create h3 { font-size: 18px; }
  .employee-task-filters button { min-height: 44px; padding: 8px 10px; }
}
@media (max-width: 760px) {
  .employee-work-summary { display: none !important; }
  .employee-mobile-menu { position: relative; flex: none; margin-left: auto; }
  .employee-mobile-menu summary { display: grid; place-items: center; width: 44px; min-height: 44px; list-style: none; font-size: 24px; cursor: pointer; border-radius: 8px; }
  .employee-mobile-menu summary::-webkit-details-marker { display: none; }
  .employee-mobile-menu[open] summary { background: var(--surface-sunken); }
  .employee-mobile-actions { position: absolute; right: 0; top: calc(100% + 6px); width: min(280px, calc(100vw - 28px)); max-height: 70dvh; overflow-y: auto; z-index: 30; padding: 8px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: var(--sh-lg); }
  .employee-mobile-actions small { display: block; color: var(--muted); padding: 10px 12px; }
  .employee-mobile-actions button { width: 100%; text-align: left; white-space: normal; min-height: 44px; border-color: transparent; background: transparent; font-size: 13px; line-height: 1.5; padding: 10px 12px; }
  .employee-mobile-actions button:hover { background: var(--surface-sunken); }
}
</style>
