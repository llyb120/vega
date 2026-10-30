<script setup vapor>
import Integrations from "./Integrations.vue";
import Team from "./Team.vue";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
const token = ref(""),
  authenticated = ref(false),
  error = ref(""),
  notice = ref(""),
  view = ref("chat");
const sessions = ref([]),
  current = ref(null),
  messages = ref([]),
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
  config = ref({}),
  configText = ref("");
const employee = ref({
    duties: [],
    tasks: [],
    memories: [],
    runs: [],
    orbit: [],
  }),
  employeeTab = ref("tasks"),
  taskText = ref(""),
  taskProfile = ref("lightweight"),
  memoryText = ref(""),
  memoryID = ref(""),
  importance = ref(1);
const duty = ref(emptyDuty()),
  dutyOpen = ref(false),
  orbitText = ref(""),
  vault = ref([]),
  vaultForm = ref({ name: "", condition: "", content: "" });
let eventsController,
  closed = false;
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
    events: "orbit.changed",
    enabled: true,
  };
}
const isRunning = computed(
  () => current.value && running.value[current.value.id],
);
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
  catalogModels.value = await api("/providers/models");
}
function providerSaved(value) {
  config.value = value;
  configText.value = JSON.stringify(value, null, 2);
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
    if (authenticated.value)
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
  return at ? new Date(at).toLocaleString() : "";
}
async function api(path, method = "GET", data) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token.value}`,
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
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
  sessions.value = b.sessions || [];
  running.value = b.running || {};
  config.value = b.config || {};
  if (!project.value) project.value = b.cwd;
  return b;
}
async function login() {
  await attempt(async () => {
    await bootstrap();
    closed = false;
    authenticated.value = true;
    startPresence();
    await loadModels();
    configText.value = JSON.stringify(
      config.value.model ? config.value : exampleConfig(),
      null,
      2,
    );
    await loadEmployee();
    if (sessions.value.length) await selectSession(sessions.value[0]);
    eventsController = new AbortController();
    void eventLoop(eventsController.signal);
  });
}
function logout() {
  stopPresence();
  closed = true;
  eventsController?.abort();
  authenticated.value = false;
  token.value = "";
  current.value = null;
  messages.value = [];
  vault.value = [];
  config.value = {};
}
async function selectSession(session) {
  const v = await api(`/sessions/${session.id}`);
  current.value = v.session;
  messages.value = v.messages || [];
  folds.value = v.folds || [];
  contextBudget.value = v.context;
  fireState.value = v.fire;
  running.value[session.id] = v.running;
  live.value = "";
  thinking.value = "";
  activeTools.value = [];
  draft.value = "";
  attachments.value = [];
  view.value = "chat";
  await scrollBottom();
}
async function newSession() {
  await attempt(async () => {
    const s = await api("/sessions", "POST", {
      cwd: project.value,
      model: chosenModel.value,
    });
    await bootstrap();
    await selectSession(s);
  });
}
async function newStage() {
  if (!current.value) return;
  await attempt(async () => {
    const s = await api(`/sessions/${current.value.id}/stage`, "POST", {});
    await bootstrap();
    await selectSession(s);
    toast("Stage 使用独立历史；每轮自动引用来源会话的最新提示词与结论。");
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
  if (sending.value || (!draft.value.trim() && !attachments.value.length))
    return;
  sending.value = true;
  const body = { text: draft.value, images: attachments.value };
  await attempt(async () => {
    if (!current.value) {
      const s = await api("/sessions", "POST", {
        cwd: project.value,
        model: chosenModel.value,
      });
      await bootstrap();
      await selectSession(s);
    }
    const id = current.value.id;
    const path = isRunning.value ? "steer" : "messages";
    const result = await api(`/sessions/${id}/${path}`, "POST", body);
    draft.value = "";
    attachments.value = [];
    if (result.id && result.id !== id) {
      await bootstrap();
      await selectSession({ id: result.id });
    } else {
      await refreshCurrent();
    }
    await scrollBottom();
  });
  sending.value = false;
}
async function upload(event) {
  await attempt(async () => {
    for (const file of event.target.files) {
      if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024)
        throw Error("仅支持不超过 25 MiB 的图片");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      attachments.value.push({ mime: file.type, data });
    }
    event.target.value = "";
  });
}
async function scrollBottom() {
  await nextTick();
  if (transcript.value)
    transcript.value.scrollTop = transcript.value.scrollHeight;
}
async function eventLoop(signal) {
  closed = false;
  while (!signal.aborted && !closed) {
    try {
      const response = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${token.value}` },
        signal,
      });
      if (!response.ok) throw Error("事件连接认证失败");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = frame.split("\n").find((x) => x.startsWith("data: "));
          if (line) await handleEvent(JSON.parse(line.slice(6)));
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      error.value = `事件连接中断：${e.message}。已保存的数据不会丢失，正在重连。`;
    }
    if (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        await bootstrap();
        if (current.value) await refreshCurrent();
        await loadEmployee();
      } catch {}
    }
  }
}
async function refreshCurrent() {
  if (!current.value) return;
  const data = await api(`/sessions/${current.value.id}`);
  current.value = data.session;
  messages.value = data.messages || [];
  folds.value = data.folds || [];
  contextBudget.value = data.context;
  fireState.value = data.fire;
  running.value[current.value.id] = data.running;
}
async function handleEvent(event) {
  if (event.type === "config_changed") {
    await bootstrap();
    configText.value = JSON.stringify(config.value, null, 2);
    await loadModels();
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
  const selected = event.session === current.value?.id;
  if (event.type === "started") running.value[event.session] = true;
  if (event.type === "employee_changed") {
    await loadEmployee();
    return;
  }
  if (event.type === "employee_error") {
    error.value = event.data;
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
      await refreshCurrent();
      await bootstrap();
      await scrollBottom();
      break;
  }
}
async function loadEmployee() {
  employee.value = await api("/employee");
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
          : d.events?.length
            ? "events"
            : "dynamic",
    times: (d.times || ["09:00"]).join(","),
    events: (d.events || ["orbit.changed"]).join(","),
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
    if (d.trigger === "events")
      data.events = d.events
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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
      cwd: project.value,
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
function exampleConfig() {
  return {
    model: "openai/gpt-4.1",
    provider: {
      openai: {
        api: "openai-completions",
        baseURL: "https://api.openai.com/v1",
        apiKey: "{env:OPENAI_API_KEY}",
        models: {
          "gpt-4.1": {
            contextWindow: 128000,
            maxOutputTokens: 8192,
            supportsImages: true,
          },
        },
      },
    },
    scenes: {
      lightweight: ["openai/gpt-4.1"],
      coding: ["openai/gpt-4.1"],
      computer: ["openai/gpt-4.1"],
    },
    contextMode: "auto",
    mcp: {},
    image: { baseURL: "", apiKey: "", models: [] },
  };
}
async function saveConfig() {
  await attempt(async () => {
    const saved = await api("/config", "PUT", JSON.parse(configText.value));
    config.value = saved;
    configText.value = JSON.stringify(saved, null, 2);
    await loadModels();
    toast("配置已存入 SQLite；新轮次生效");
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
      <p>一个轻巧的工作伙伴</p>
      <label for="access-token">服务端访问令牌</label
      ><input
        id="access-token"
        v-model="token"
        type="password"
        minlength="16"
        required
        autocomplete="current-password"
        placeholder="终端显示的令牌 / VEGA_TOKEN"
      /><button class="primary">进入工作台 →</button>
      <p class="hint">令牌仅保存在当前页面内存中。所有工具在服务端执行。</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </main>
  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark small">V</span><strong>Vega</strong
        ><span class="beta">WORKSPACE</span>
      </div>
      <nav aria-label="主导航">
        <button :class="{ selected: view === 'chat' }" @click="view = 'chat'">
          ◈ <span>对话</span></button
        ><button
          :class="{ selected: view === 'employee' }"
          @click="
            view = 'employee';
            attempt(loadEmployee);
          "
        >
          ◎ <span>数字员工</span
          ><span class="count">{{ activeTasks.length }}</span></button
        ><button
          :class="{ selected: view === 'settings' }"
          @click="view = 'settings'"
        >
          ⚙ <span>设置</span>
        </button>
      </nav>
      <div class="sidebar-heading">
        <span>会话</span
        ><button class="icon" title="新建会话" @click="newSession">＋</button>
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
              >{{ s.stageSource ? "↳ " : s.taskId ? "◎ " : ""
              }}{{ s.title }}</span
            ></button
          ><button
            v-if="!s.taskId && !running[s.id]"
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
        <span class="status-dot"></span> Nitro · SQLite
        <button class="link" @click="logout">退出</button>
      </footer>
    </aside>
    <section class="workspace">
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
        <header class="topbar">
          <div>
            <h2>
              {{ current?.title || "对话" }}
              <span v-if="current?.stageSource" class="pill">Stage</span>
            </h2>
            <p>{{ current?.cwd || project || "选择工作目录，开始对话" }}</p>
          </div>
          <div class="actions">
            <span v-if="isRunning" class="pill green">执行中</span
            ><button v-if="current" @click="newStage">＋ Stage</button>
          </div>
        </header>
        <div ref="transcript" class="transcript" aria-live="polite">
          <div v-if="!messages.length && !live" class="welcome">
            <div class="welcome-symbol">✳</div>
            <h1>让想法开始运转。</h1>
            <p>编写代码、探索网页，或把一项工作交给数字员工。</p>
            <div class="suggestions">
              <button @click="draft = '分析当前项目结构，提出最小改进方案'">
                ◈ 分析一个项目</button
              ><button @click="draft = '请用 Chrome 查看当前标签页'">
                ↗ 探索网页</button
              ><button @click="view = 'employee'">◎ 交给数字员工</button>
            </div>
          </div>
          <div v-if="fireState" class="context-note">
            Fire · 第 {{ fireState.attempt }} 次 ·
            {{ fireState.role === "judge" ? "独立验收" : "执行" }} ·
            {{ fireState.status }}
            <p v-if="fireState.reason">{{ fireState.reason }}</p>
            <small
              >只继续最后阶段；旧阶段不会分叉工作流。验收不以执行者自述为证。</small
            >
          </div>
          <details v-if="contextBudget" class="context-note">
            <summary>
              上下文约 {{ contextBudget.usedPercent }}% ·
              {{ contextBudget.method }}
            </summary>
            <p>
              T1/T2/T3 分层压缩 ·
              {{ contextBudget.blocks?.length || 0 }} 个活动块 · 已缩短
              {{ contextBudget.truncatedToolResults || 0 }} 个旧工具结果
            </p>
            <p v-if="contextBudget.lastReceipt?.mechanical">
              窗口应急恢复使用了机械轮廓，细节可能省略；原文仍可
              recall/decompress。
            </p>
            <p>
              剩余输入预算约
              {{ contextBudget.remaining }} tokens（实测锚点之外为启发式估算）。
            </p>
          </details>
          <div v-if="folds.some((b) => b.active)" class="context-note">
            {{ folds.filter((b) => b.active).length }}
            个上下文区块已压缩，原文保留在 SQLite，可随时还原。
          </div>
          <article
            v-for="(m, i) in messages"
            :key="`${current?.id}-${m.seq || i}`"
            :class="['message', m.role]"
          >
            <template v-if="m.role === 'tool'"
              ><details class="tool-block">
                <summary>
                  {{ m.error ? "⚠" : "✓" }} {{ m.name }} <span>工具结果</span>
                </summary>
                <pre>{{ m.text }}</pre>
                <img
                  v-for="(image, n) in m.images || []"
                  :key="n"
                  :src="`data:${image.mime};base64,${image.data}`"
                  alt="工具返回的图片"
                /></details></template
            ><template v-else
              ><div class="message-meta">
                <span>{{ m.role === "user" ? "你" : "Vega" }}</span
                ><span>{{ m.model || "" }}</span
                ><span v-if="m.seq">m{{ String(m.seq).padStart(5, "0") }}</span>
              </div>
              <details v-if="m.thinking" class="reasoning">
                <summary>思考过程</summary>
                <pre>{{ m.thinking }}</pre>
              </details>
              <div v-if="m.text" class="message-text">
                {{ m.displayText || m.text }}
              </div>
              <div v-if="m.calls?.length" class="calls">
                <span v-for="c in m.calls" :key="c.id">↳ {{ c.name }}</span>
              </div>
              <img
                v-for="(image, n) in m.images || []"
                :key="n"
                :src="`data:${image.mime};base64,${image.data}`"
                alt="用户附图"
            /></template>
          </article>
          <article v-if="live || thinking" class="message assistant">
            <div class="message-meta">
              <span>Vega</span><span>{{ model }}</span
              ><span class="status-dot"></span>
            </div>
            <details v-if="thinking" class="reasoning">
              <summary>思考中</summary>
              <pre>{{ thinking }}</pre>
            </details>
            <div class="message-text">
              {{ live }}<span class="cursor">▍</span>
            </div>
          </article>
          <div v-for="c in activeTools" :key="c.id" class="tool-progress">
            <span class="spinner"></span>{{ c.name }} 正在执行…
          </div>
        </div>
        <div class="composer-wrap">
          <div class="context-controls">
            <input
              v-model="project"
              aria-label="工作目录"
              placeholder="服务端工作目录"
            /><select v-model="chosenModel" aria-label="新会话模型">
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
              @keydown.enter.exact.prevent="send"
            ></textarea>
            <div class="composer-bottom">
              <label class="attach" title="添加图片"
                >＋<input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  @change="upload" /></label
              ><span class="hint">Enter 发送 · Shift + Enter 换行</span
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
                :disabled="sending || (!draft.trim() && !attachments.length)"
              >
                {{ isRunning ? "补充约束" : "发送" }} ↑
              </button>
            </div>
          </form>
          <p class="disclaimer">
            工具操作发生在服务端。请核对重要结果，勿向不可信网页泄露凭据。
          </p>
        </div>
      </template>
      <template v-else-if="view === 'employee'"
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
          <div class="employee-settings">
            <label
              ><input v-model="employee.enabled" type="checkbox" />
              启用员工</label
            ><label
              >工作时间 <input v-model="employee.workStart" type="time" /> —
              <input v-model="employee.workEnd" type="time" /></label
            ><button @click="saveEmployeeSettings">保存</button
            ><small>时刻均为服务端本地时间，相同起止时刻表示全天。</small
            ><input
              v-model="project"
              aria-label="员工工作目录"
              placeholder="员工的服务端工作目录"
            />
          </div>
          <div v-if="!employee.enabled" class="context-note">
            员工当前停用，新任务只保存、不执行。启用并进入工作时间后开始处理。
          </div>
          <p v-if="employee.systemPresence" class="hint">
            电脑任务系统状态：{{
              !employee.systemPresence.available
                ? "不可确认（保留排队）"
                : employee.systemPresence.locked
                  ? "锁屏，解锁后续做"
                  : "可用"
            }}。{{ employee.systemPresence.reason || "" }}
          </p>
          <div class="tabs" role="tablist">
            <button
              v-for="[id, label] in [
                ['tasks', '任务'],
                ['duties', '职责'],
                ['memories', '长期记忆'],
                ['orbit', '星轨'],
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
                  @click="attempt(() => selectSession({ id: t.workSession }))"
                >
                  主会话 ↗</button
                ><button
                  v-if="t.computerSession"
                  @click="
                    attempt(() => selectSession({ id: t.computerSession }))
                  "
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
                    <option value="events">星轨事件</option>
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
              ><label v-if="duty.trigger === 'events'"
                >事件（逗号分隔）<input
                  v-model="duty.events"
                  placeholder="orbit.added,orbit.done" /></label
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
            <p class="hint">
              普通记忆随时间淡忘，相关任务会强化记忆；长期记忆不会自动删除。
            </p>
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
          <template v-if="employeeTab === 'orbit'"
            ><form
              class="inline-form"
              @submit.prevent="
                attempt(async () => {
                  await employeeAction({
                    action: 'orbit_add',
                    text: orbitText,
                  });
                  orbitText = '';
                })
              "
            >
              <input
                v-model="orbitText"
                required
                placeholder="一件待办事项"
              /><button class="primary">添加</button>
            </form>
            <label
              v-for="item in employee.orbit || []"
              :key="item.id"
              class="card orbit-item"
              ><input
                :checked="item.done"
                type="checkbox"
                @change="
                  attempt(() =>
                    employeeAction({
                      action: 'orbit_done',
                      id: item.id,
                      done: !item.done,
                    }),
                  )
                "
              /><span :class="{ strike: item.done }">{{
                item.text
              }}</span></label
            ></template
          >
          <template v-if="employeeTab === 'vault'"
            ><p class="context-note">
              密码本凭据使用 AES-GCM 加密存入 SQLite，可配置 VEGA_VAULT_KEY
              将主密钥放在数据库外；未配置时自动生成本机密钥并存于同一数据库，仅防误读误传。
            </p>
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
      <template v-else
        ><header class="topbar">
          <div>
            <h2>设置</h2>
            <p>配置存于服务端 SQLite，凭据不会放入前端存储。</p>
          </div>
        </header>
        <div class="page-scroll settings">
          <Integrations
            :api="api"
            @saved="providerSaved"
            @error="error = $event"
            @notice="notice = $event"
          />
          <section class="card">
            <div class="section-heading">
              <div>
                <h3>模型与场景</h3>
                <p class="hint">
                  支持 OpenAI Chat Completions、Responses、Anthropic
                  Messages。场景候选模型按顺序降级。
                </p>
              </div>
              <button class="primary" @click="saveConfig">保存配置</button>
            </div>
            <textarea
              v-model="configText"
              class="config-editor"
              spellcheck="false"
              aria-label="模型配置 JSON"
            ></textarea>
            <p class="hint">
              apiKey 可使用 {env:变量名}。__stored_secret__
              表示保留已有密钥。默认自动压缩，可将 contextMode 设为 acp
              由模型主动压缩。MCP 支持 command/args/env 或 url/headers。
            </p>
          </section>

          <section class="card">
            <h3>部署与权限</h3>
            <p>
              这是具备服务端文件读写、命令执行与浏览器控制能力的管理工作台。只向可信用户开放；跨设备访问请通过
              HTTPS 反向代理。SQLite 中的模型配置可能含明文 API
              Key，建议使用环境变量引用并保护数据库及备份。
            </p>
          </section>
        </div></template
      >
    </section>
  </div>
</template>
