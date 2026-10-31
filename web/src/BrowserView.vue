<script setup vapor>
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
const props = defineProps({ api: Function });
const status = ref(null),
  tabs = ref([]),
  selected = ref(""),
  screenshot = ref(null),
  busy = ref(false),
  error = ref(""),
  info = ref(""),
  remote = ref(false),
  mode = ref("click"),
  text = ref(""),
  address = ref(""),
  imageReady = ref(false),
  dragStart = ref(null),
  liveState = ref("offline"),
  inputBusy = ref(false);
const inputDisabled = computed(
  () => busy.value || inputBusy.value || !imageReady.value,
);
let socket = null,
  heartbeat = null,
  sequence = 0,
  inflight = 0,
  pendingPointer = null,
  connectTimer = null;
let imageURL = "",
  previousImageURL = "",
  shownFrame = null,
  queuedTextFrame = 0,
  queuedText = "";
function disconnect() {
  queuedText = "";
  clearInterval(heartbeat);
  clearTimeout(connectTimer);
  heartbeat = null;
  socket?.close();
  socket = null;
  inflight = 0;
  pendingPointer = null;
  inputBusy.value = false;
  dragStart.value = null;
  remote.value = false;
  liveState.value = "offline";
}
function setMode() {
  queuedText = "";
  if (socket?.readyState !== WebSocket.OPEN) return;
  pendingPointer = null;
  socket.send(
    JSON.stringify({
      type: "mode",
      mode: remote.value || liveState.value === "waiting" ? "view" : "control",
    }),
  );
}
function loadedImage() {
  if (previousImageURL) {
    URL.revokeObjectURL(previousImageURL);
    previousImageURL = "";
  }
  if (!screenshot.value || socket?.readyState !== WebSocket.OPEN) return;
  imageReady.value = true;
  shownFrame = screenshot.value;
  socket.send(
    JSON.stringify({ type: "frame_ack", frameId: screenshot.value.frameId }),
  );
  if (!inflight) {
    if (pendingPointer) {
      const next = pendingPointer;
      pendingPointer = null;
      void control(next);
    } else if (queuedText) {
      const text = queuedText,
        frameId = queuedTextFrame;
      queuedText = "";
      void control({ action: "type", text }, frameId);
    }
  }
}
function hidden() {
  if (document.hidden) {
    disconnect();
    imageReady.value = false;
    info.value = "页面已隐藏，实时连接已释放；点击刷新截图重新连接。";
  }
}
const keys = [
  ["Enter", "回车"],
  ["Tab", "Tab"],
  ["Shift+Tab", "上一个输入框"],
  ["Escape", "Esc"],
  ["Backspace", "退格"],
  ["Ctrl+A", "全选"],
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["ArrowUp", "↑"],
  ["ArrowDown", "↓"],
];
let version = 0,
  disposed = false;
const pageURL = computed(
  () =>
    screenshot.value?.url ||
    tabs.value.find((tab) => tab.tag === selected.value)?.url ||
    "",
);
function siteName(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.href;
  } catch {
    return "网页地址";
  }
}
const viewable = (tab) =>
  tab?.controllable === true && /^(https?:\/\/|about:blank$)/i.test(tab.url);
async function capture(tab) {
  if (busy.value || !viewable(tab)) return;
  const request = ++version;
  disconnect();
  if (selected.value !== tab.tag) text.value = "";
  imageReady.value = false;
  selected.value = tab.tag;
  screenshot.value = null;
  error.value = "";
  info.value = "";
  busy.value = true;
  liveState.value = "connecting";
  try {
    const { ticket } = await props.api("/chrome/live", "POST", {
      tabTag: tab.tag,
    });
    if (disposed || request !== version) return;
    const url = new URL("/api/chrome/live", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const ws = new WebSocket(url);
    socket = ws;
    const fail = (reason) => {
      if (disposed || request !== version || socket !== ws) return;
      disconnect();
      imageReady.value = false;
      busy.value = false;
      error.value = reason;
    };
    connectTimer = setTimeout(
      () => fail("实时连接超时，请检查反向代理是否支持WebSocket并刷新"),
      15000,
    );
    ws.onopen = () => {
      clearTimeout(connectTimer);
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, 5000);
    };
    ws.onmessage = async (event) => {
      if (disposed || request !== version || socket !== ws) return;
      try {
        const value = JSON.parse(event.data);
        if (value.type === "frame") {
          if (typeof value.data !== "string" || value.data.length > 6000000)
            throw Error("画面过大");
          if (previousImageURL) URL.revokeObjectURL(previousImageURL);
          previousImageURL = imageURL;
          imageURL = URL.createObjectURL(
            new Blob(
              [Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0))],
              { type: "image/jpeg" },
            ),
          );
          const preview = new Image();
          preview.src = imageURL;
          await preview.decode();
          if (disposed || request !== version || socket !== ws) return;
          const { data, ...frame } = value;
          acceptScreenshot({
            ...frame,
            snapshotId: "live-" + value.frameId,
            image: {
              url: imageURL,
              width: value.width,
              height: value.height,
            },
          });
          busy.value = false;
        } else if (value.type === "ready") {
          liveState.value = "view";
        } else if (value.type === "mode") {
          liveState.value = value.mode;
          remote.value = value.mode === "control";
          if (!remote.value) {
            queuedText = "";
            pendingPointer = null;
            dragStart.value = null;
          }
          if (value.reason) info.value = value.reason;
        } else if (value.type === "input_result") {
          if (value.seq !== inflight) return;
          inflight = 0;
          inputBusy.value = false;
          if (value.status !== "executed") {
            queuedText = "";
            dragStart.value = null;
            pendingPointer = null;
            error.value =
              (value.status === "needs_review"
                ? "结果不确定，不要重复提交："
                : "未执行：") + (value.reason || "请核对网页");
          } else if (pendingPointer) {
            const next = pendingPointer;
            pendingPointer = null;
            void control(next);
          }
        } else if (value.type === "error") error.value = value.reason;
      } catch {
        fail("实时画面格式无效，请重新连接");
      }
    };
    ws.onerror = () => fail("WebSocket连接失败；请确认登录状态和反向代理配置");
    ws.onclose = () =>
      fail(
        inflight
          ? "连接中断，操作可能已执行，请核对网页，不要重复提交"
          : error.value || "实时连接已断开，点击刷新截图重新连接",
      );
  } catch (e) {
    if (!disposed && request === version) {
      disconnect();
      busy.value = false;
      error.value = e.message;
    }
  }
}
async function refresh() {
  if (busy.value) return;
  const request = ++version;
  busy.value = true;
  error.value = "";
  let target;
  try {
    const result = await props.api("/chrome/tabs");
    if (disposed || request !== version) return;
    status.value = result;
    tabs.value = result.tabs || [];
    target =
      tabs.value.find((t) => t.tag === selected.value && viewable(t)) ||
      tabs.value.find((t) => t.active && viewable(t)) ||
      tabs.value.find(viewable);
    if (!target) {
      selected.value = "";
      screenshot.value = null;
    }
  } catch (e) {
    if (!disposed && request === version) {
      error.value = e.message;
      status.value = null;
      tabs.value = [];
      selected.value = "";
      screenshot.value = null;
    }
  } finally {
    if (!disposed && request === version) busy.value = false;
  }
  if (!disposed && request === version && target) await capture(target);
}
function keyboard(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const controls = [
      ...event.currentTarget.parentElement.querySelectorAll(
        "button[role=tab]:not(:disabled)",
      ),
    ],
    at = controls.indexOf(event.currentTarget);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (at + (event.key === "ArrowRight" ? 1 : -1) + controls.length) %
          controls.length;
  controls[next]?.focus();
  controls[next]?.click();
}
function acceptScreenshot(result) {
  const changed = result.url !== screenshot.value?.url;
  screenshot.value = result.image ? result : null;
  selected.value = result.tabTag || selected.value;
  if (changed) address.value = result.url || "";
  const existing = tabs.value.find((tab) => tab.tag === selected.value);
  if (existing) {
    existing.title = result.title;
    existing.url = result.url;
  }
  for (const tab of result.openedTabs || [])
    if (!tabs.value.some((t) => t.tag === tab.tag)) tabs.value.push(tab);
  if (
    !existing &&
    result.image &&
    !tabs.value.some((t) => t.tag === result.tabTag)
  )
    tabs.value.push({
      tag: result.tabTag,
      title: result.title,
      url: result.url,
      controllable: true,
    });
}
function control(action, frameId = shownFrame?.frameId) {
  if (
    !remote.value ||
    !screenshot.value ||
    socket?.readyState !== WebSocket.OPEN
  )
    return;
  if (inflight || !imageReady.value) {
    if (action.action === "pointer" && action.phase !== "down")
      pendingPointer = action;
    else if (action.action === "type") {
      if (queuedText.length + action.text.length > 16000) {
        error.value = "输入过快，请等待文字发送完成";
        return;
      }
      if (!queuedText) queuedTextFrame = frameId;
      queuedText += action.text;
    }
    return;
  }
  if (socket.bufferedAmount > 65536) {
    disconnect();
    error.value = "网络拥堵，已停止操作；请核对网页，不要重复提交。";
    return;
  }
  error.value = "";
  inflight = ++sequence;
  inputBusy.value = true;
  socket.send(
    JSON.stringify({
      type: "input",
      seq: inflight,
      frameId,
      action,
    }),
  );
}
function imagePoint(event) {
  const image = shownFrame?.image,
    r = event.currentTarget.getBoundingClientRect();
  if (!image || !r.width || !r.height) return;
  const x = ((event.clientX - r.left) * image.width) / r.width,
    y = ((event.clientY - r.top) * image.height) / r.height;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  return {
    x: Math.min(image.width - 1, Math.floor(x)),
    y: Math.min(image.height - 1, Math.floor(y)),
  };
}
function clickImage(event) {
  if (mode.value === "drag" || !remote.value) return;
  const point = imagePoint(event);
  if (point)
    void control({
      action: "click_at",
      ...point,
      click_count: mode.value === "double" ? 2 : 1,
      button: mode.value === "right" ? "right" : "left",
    });
}
function pointerDown(event) {
  if (
    !remote.value ||
    mode.value !== "drag" ||
    busy.value ||
    inputBusy.value ||
    !imageReady.value ||
    event.button !== 0
  )
    return;
  const point = imagePoint(event);
  if (!point) return;
  event.preventDefault();
  dragStart.value = { ...point, id: event.pointerId };
  event.currentTarget.setPointerCapture(event.pointerId);
  void control({ action: "pointer", phase: "down", ...point });
}
function pointerUp(event) {
  const start = dragStart.value;
  dragStart.value = null;
  if (!start || start.id !== event.pointerId) return;
  event.currentTarget.releasePointerCapture(event.pointerId);
  const end = imagePoint(event) || start.last || { x: start.x, y: start.y };
  void control({ action: "pointer", phase: "up", ...end });
}
function pointerMove(event) {
  if (!dragStart.value || dragStart.value.id !== event.pointerId) return;
  const point = imagePoint(event);
  if (point) {
    dragStart.value.last = point;
    void control({ action: "pointer", phase: "move", ...point });
  }
}
function pointerCancel() {
  if (!dragStart.value) return;
  dragStart.value = null;
  pendingPointer = null;
  if (remote.value && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "mode", mode: "view" }));
}
function imageKey(event) {
  if (
    !remote.value ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.metaKey ||
    event.altKey
  )
    return;
  if (event.key === " " && screenshot.value?.editable && !event.ctrlKey) {
    event.preventDefault();
    void control({ action: "type", text: " " });
    return;
  }
  const key =
    (event.ctrlKey ? "Ctrl+" : "") +
    (event.shiftKey && event.key === "Tab" ? "Shift+" : "") +
    (event.key === " "
      ? "Space"
      : event.key.length === 1 && event.ctrlKey
        ? event.key.toUpperCase()
        : event.key);
  if (
    [
      "Enter",
      "Tab",
      "Shift+Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
      "Ctrl+A",
      "Ctrl+Z",
      "Ctrl+Y",
    ].includes(key)
  ) {
    event.preventDefault();
    void control({ action: "press", key });
  } else if (event.key.length === 1 && !event.ctrlKey) {
    event.preventDefault();
    void control({ action: "type", text: event.key });
  }
}
function scrollRemote(delta, delta_x = 0) {
  if (!screenshot.value) return;
  void control({
    action: "scroll_at",
    x: Math.floor(screenshot.value.image.width / 2),
    y: Math.floor(screenshot.value.image.height / 2),
    delta,
    delta_x,
  });
}
function wheelImage(event) {
  if (!remote.value) return;
  event.preventDefault();
  if (busy.value || inputBusy.value) return;
  const point = imagePoint(event);
  if (!point) return;
  const delta = Math.round(
    Math.max(
      -1200,
      Math.min(
        1200,
        event.deltaY *
          (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? 600 : 1),
      ),
    ),
  );
  const delta_x = Math.round(Math.max(-1200, Math.min(1200, event.deltaX)));
  if (delta || delta_x)
    void control({ action: "scroll_at", ...point, delta, delta_x });
}
function sendText() {
  const value = text.value;
  if (!value || inflight || !imageReady.value) return;
  text.value = "";
  void control({ action: "type", text: value });
}
function failedImage() {
  imageReady.value = false;
  remote.value = false;
  screenshot.value = null;
  disconnect();
  error.value = "实时画面加载失败，请刷新截图重新连接。";
}
onMounted(() => {
  document.addEventListener("visibilitychange", hidden);
  void refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  version++;
  disconnect();
  if (imageURL) URL.revokeObjectURL(imageURL);
  if (previousImageURL) URL.revokeObjectURL(previousImageURL);
  document.removeEventListener("visibilitychange", hidden);
});
</script>

<template>
  <header class="topbar">
    <div>
      <h2>浏览器</h2>
    </div>
    <div class="actions">
      <span :class="['pill', status?.connected ? 'green' : '']">{{
        status?.connected ? (status.browser || "浏览器") + " 已连接" : "未连接"
      }}</span
      ><button :disabled="busy" @click="refresh">刷新标签页</button>
    </div>
  </header>
  <section class="browser-view" :aria-busy="busy">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="info" class="notice remote-notice" role="status">{{ info }}</p>
    <div
      v-if="tabs.length"
      class="browser-tabstrip"
      role="tablist"
      aria-label="浏览器标签页"
    >
      <button
        v-for="tab in tabs"
        :key="tab.tag"
        type="button"
        role="tab"
        :aria-selected="selected === tab.tag"
        aria-controls="browser-screenshot-panel"
        :tabindex="selected === tab.tag ? 0 : -1"
        :class="['browser-tab', { selected: selected === tab.tag }]"
        :title="
          viewable(tab)
            ? (tab.title || '未命名标签页') + '\n' + tab.url
            : '此浏览器页面不可截图：' + tab.url
        "
        :disabled="busy || !viewable(tab)"
        @click="capture(tab)"
        @keydown="keyboard"
      >
        <span class="browser-tab-mark" aria-hidden="true">▣</span
        ><span class="browser-tab-title">{{
          tab.title || siteName(tab.url)
        }}</span
        ><small v-if="tab.incognito">无痕</small
        ><small v-if="!viewable(tab)">不可查看</small>
      </button>
    </div>
    <div
      id="browser-screenshot-panel"
      class="browser-panel"
      role="tabpanel"
      aria-label="所选标签页截图"
    >
      <div v-if="selected" class="browser-address">
        <div>
          <strong>{{
            screenshot?.title ||
            tabs.find((t) => t.tag === selected)?.title ||
            siteName(pageURL)
          }}</strong>
          <details :key="selected" class="browser-url">
            <summary :title="pageURL">
              {{ siteName(pageURL) }} · 查看地址
            </summary>
            <p>{{ pageURL }}</p>
          </details>
        </div>
        <div class="actions">
          <button
            :class="{ primary: remote }"
            :aria-pressed="remote"
            :aria-label="remote ? '退出远程操作' : '开启远程操作'"
            :disabled="busy || !screenshot || !imageReady"
            @click="setMode"
          >
            {{
              liveState === "waiting"
                ? "等待控制权…"
                : remote
                  ? "退出操作"
                  : "远程操作"
            }}
          </button>
          <span :class="['pill', liveState === 'offline' ? '' : 'green']">{{
            liveState === "offline"
              ? "已断开"
              : liveState === "connecting"
                ? "连接中"
                : "实时画面"
          }}</span>
          <a
            v-if="!!screenshot"
            :href="screenshot.image.url"
            target="_blank"
            rel="noopener noreferrer"
            class="button-link"
            >查看大图 ↗</a
          >
          <button
            :disabled="busy"
            @click="capture(tabs.find((t) => t.tag === selected))"
          >
            刷新截图
          </button>
        </div>
      </div>
      <div v-if="remote" class="remote-controls">
        <div class="remote-toolbar">
          <select
            v-model="mode"
            aria-label="截图操作模式"
            :disabled="inputDisabled"
          >
            <option value="click">点击</option>
            <option value="double">双击</option>
            <option value="right">右键</option>
            <option value="drag">拖动</option>
          </select>
          <button :disabled="inputDisabled" @click="scrollRemote(-600)">
            网页上滚</button
          ><button :disabled="inputDisabled" @click="scrollRemote(600)">
            网页下滚
          </button>
        </div>
        <details class="remote-input">
          <summary>文字、按键与网址</summary>
          <p class="hint">
            先点截图中的输入框，再发送文字；不会自动按回车。操作会直接影响共享浏览器。
          </p>
          <form @submit.prevent="sendText" class="remote-text">
            <textarea
              v-model="text"
              rows="2"
              maxlength="16000"
              aria-label="远程输入文字"
              autocomplete="off"
              spellcheck="false"
              placeholder="要输入到网页的文字"
            ></textarea
            ><button
              :disabled="inputDisabled || !screenshot?.editable || !text"
            >
              发送文字
            </button>
          </form>
          <div class="remote-keys">
            <button
              v-for="[key, label] in keys"
              :key="key"
              :disabled="inputDisabled"
              :aria-label="'远程按键 ' + label"
              @click="control({ action: 'press', key })"
            >
              {{ label }}
            </button>
          </div>
          <div class="remote-keys">
            <button
              :disabled="inputDisabled"
              @click="control({ action: 'back' })"
            >
              网页后退</button
            ><button
              :disabled="inputDisabled"
              @click="control({ action: 'forward' })"
            >
              网页前进</button
            ><button
              :disabled="inputDisabled"
              @click="control({ action: 'reload' })"
            >
              重载网页
            </button>
          </div>
          <form
            class="remote-url"
            @submit.prevent="control({ action: 'goto', url: address })"
          >
            <input
              v-model="address"
              type="url"
              required
              aria-label="远程网页地址"
              placeholder="https://example.com"
              autocapitalize="none"
              spellcheck="false"
            /><button :disabled="inputDisabled">前往</button>
          </form>
        </details>
        <p class="hint remote-mode-hint">
          {{
            mode === "drag"
              ? "按住截图拖动目标；退出拖动模式可正常上下查看。"
              : "点击截图操作网页；手机滑动仍用于查看截图，网页翻页使用上滚/下滚。"
          }}
        </p>
      </div>
      <div v-if="busy" class="browser-placeholder" role="status">
        <span class="spinner"></span>正在读取浏览器…
      </div>
      <figure v-else-if="!!screenshot" class="browser-capture">
        <figcaption>
          实时画面 · {{ new Date(screenshot.capturedAt).toLocaleTimeString() }}
        </figcaption>
        <div class="browser-image">
          <img
            :src="screenshot.image.url"
            :width="screenshot.image.width"
            :height="screenshot.image.height"
            :alt="'标签页当前截图：' + screenshot.title"
            draggable="false"
            :class="{
              'remote-active': remote,
              'remote-drag': remote && mode === 'drag',
            }"
            @load="loadedImage"
            :tabindex="remote ? 0 : -1"
            @keydown="imageKey"
            @click="clickImage"
            @pointerdown="pointerDown"
            @pointermove="pointerMove"
            @pointerup="pointerUp"
            @pointercancel="pointerCancel"
            @wheel="wheelImage"
            @contextmenu="remote && $event.preventDefault()"
            @error="failedImage"
          />
        </div>
      </figure>
      <div v-else-if="!status?.connected && !error" class="browser-placeholder">
        <strong>浏览器扩展尚未连接</strong>
        <p>
          Windows：在本机 Chrome 加载项目
          extensions/nova-chrome。Docker：等待容器 Chromium
          和扩展自动连接，然后刷新标签页。
        </p>
      </div>
      <div v-else-if="!selected && !error" class="browser-placeholder">
        <strong>{{
          tabs.length ? "当前没有可截图的标签页" : "当前没有标签页"
        }}</strong>
        <p>请在服务端浏览器打开 HTTP(S) 网页，再刷新标签页列表。</p>
      </div>
      <div v-else-if="error" class="browser-placeholder">
        未显示旧截图，请刷新标签页或重新选择。
      </div>
    </div>
  </section>
</template>

<style scoped>
.remote-controls {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface, #fff);
}
.remote-toolbar,
.remote-keys,
.remote-text,
.remote-url {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.remote-toolbar select {
  min-width: 0;
  flex: 1 1 100px;
}
.remote-input {
  margin-top: 8px;
}
.remote-input summary {
  min-height: 44px;
  padding: 10px 0;
}
.remote-input .hint {
  margin: 4px 0 10px;
}
.remote-text {
  align-items: stretch;
}
.remote-text textarea {
  width: 100%;
  min-width: 0;
  flex: 1 1 200px;
}
.remote-keys {
  margin: 10px 0;
}
.remote-url input {
  flex: 1;
  min-width: 0;
  width: 100%;
}
.remote-mode-hint {
  margin: 6px 0 0;
}
.remote-notice {
  padding: 10px 12px;
  margin: 0 0 12px;
  border-radius: 8px;
}
.remote-active {
  cursor: crosshair;
}
.remote-drag {
  touch-action: none;
  cursor: grab;
}
@media (max-width: 760px) {
  .remote-controls button,
  .remote-toolbar select,
  .browser-address button,
  .browser-address .button-link,
  .browser-tab {
    min-height: 44px;
  }
  .remote-controls {
    padding: 8px 10px;
  }
  .remote-toolbar {
    gap: 6px;
  }
  .remote-toolbar button {
    padding: 8px;
    font-size: 13px;
  }
  .remote-mode-hint {
    font-size: 11px;
  }
  .remote-keys button {
    flex: 1 0 44px;
  }
}
.browser-view {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: 22px 32px 32px;
  scrollbar-width: thin;
  scrollbar-color: #d5d8e1 transparent;
}
.browser-tabstrip {
  display: flex;
  flex-shrink: 0;
  overflow-x: auto;
  overscroll-behavior-y: auto;
  margin-bottom: 16px;
  gap: 6px;
  padding: 4px 2px 8px;
  border-bottom: 1px solid var(--border);
}
.browser-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 150px;
  max-width: 250px;
  flex-shrink: 0;
  padding: 11px 14px;
  border-radius: 10px 10px 0 0;
  text-align: left;
  color: #656b7b;
  background: #f5f6f9;
  border-color: transparent;
}
.browser-tab.selected {
  background: var(--accent-soft);
  border-color: #d9d9f5;
  color: var(--accent);
  box-shadow: inset 0 -2px var(--accent);
}
.browser-tab-title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}
.browser-tab small {
  white-space: nowrap;
  font-size: 10px;
  color: #858b9a;
}
.browser-tab-mark {
  color: var(--accent);
}
.browser-tab:focus-visible {
  outline: 2px solid #8585e5;
  outline-offset: 1px;
}
.browser-panel {
  border: 1px solid #e3e5ed;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 5px 20px #30334b08;
  overflow: hidden;
}
.browser-address {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  background: #f8f9fb;
  border-bottom: 1px solid var(--border);
}
.browser-address > div {
  min-width: 0;
}
.browser-address > div:first-child {
  flex: 1;
  max-width: 100%;
}
.browser-address > .actions {
  flex-shrink: 0;
}
.browser-address strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #363b4a;
}
.browser-url {
  margin-top: 4px;
  min-width: 0;
}
.browser-url summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.browser-url p {
  font-size: 12px;
  margin: 5px 0 0;
  color: #777e8e;
  overflow-wrap: anywhere;
  max-height: 96px;
  overflow-y: auto;
  overscroll-behavior-y: auto;
}
.browser-address button {
  flex-shrink: 0;
}
.browser-placeholder {
  min-height: 280px;
  padding: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  text-align: center;
  color: #777e8e;
}
.browser-placeholder p {
  max-width: 650px;
  line-height: 1.8;
  margin: 0;
}
.browser-capture {
  margin: 0;
}
.browser-capture figcaption {
  padding: 11px 18px;
  font-size: 11px;
  color: #7b8190;
  background: #fafbfc;
  border-bottom: 1px solid var(--border);
}
.browser-image {
  padding: 18px;
  background: #f0f1f5;
}
.browser-image img {
  display: block;
  width: 100%;
  height: auto;
  max-width: 1568px;
  margin: 0 auto;
  border-radius: 8px;
  box-shadow: 0 2px 10px #30334b0a;
  background: #fff;
  user-select: none;
}
@media (max-width: 760px) {
  .browser-view {
    padding: 14px 12px max(22px, env(safe-area-inset-bottom, 0px));
  }
  .browser-tabstrip {
    margin: 0 -12px 14px;
    padding: 0 12px 8px;
    border-bottom: 0;
    scrollbar-width: none;
  }
  .browser-tabstrip::-webkit-scrollbar {
    display: none;
  }
  .browser-tab {
    min-width: 145px;
    max-width: 190px;
    padding: 10px 12px;
    border-radius: 11px;
  }
  .browser-tab.selected {
    box-shadow: none;
  }
  .browser-address > div:first-child {
    width: 100%;
  }
  .browser-address {
    padding: 14px;
    gap: 12px;
    align-items: flex-start;
    flex-direction: column;
  }
  .browser-address > .actions {
    width: 100%;
  }
  .browser-address > .actions button {
    flex: 1;
  }
  .browser-placeholder {
    min-height: 200px;
    padding: 24px 18px;
  }
  .browser-image {
    padding: 6px;
  }
  .topbar {
    gap: 12px;
    flex-wrap: wrap;
  }
}
</style>
