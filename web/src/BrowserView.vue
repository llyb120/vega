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
  dragStart = ref(null);
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
  if (selected.value !== tab.tag) {
    remote.value = false;
    text.value = "";
  }
  dragStart.value = null;
  imageReady.value = false;
  selected.value = tab.tag;
  screenshot.value = null;
  error.value = "";
  info.value = "";
  busy.value = true;
  try {
    const result = await props.api("/chrome/screenshot", "POST", {
      tabTag: tab.tag,
    });
    if (!disposed && request === version) acceptScreenshot(result);
  } catch (e) {
    if (!disposed && request === version) error.value = e.message;
  } finally {
    if (!disposed && request === version) busy.value = false;
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
  screenshot.value = result.image ? result : null;
  selected.value = result.tabTag || selected.value;
  address.value = result.url || "";
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
async function control(action) {
  if (!remote.value || busy.value || !screenshot.value || !imageReady.value)
    return;
  const shown = screenshot.value,
    request = ++version;
  busy.value = true;
  imageReady.value = false;
  error.value = "";
  info.value = "";
  dragStart.value = null;
  try {
    const result = await props.api("/chrome/control", "POST", {
      tabTag: shown.tabTag,
      snapshotId: shown.snapshotId,
      action,
    });
    if (disposed || request !== version) return;
    acceptScreenshot(result);
    if (result.status === "executed")
      info.value = result.image
        ? "操作已发送，截图已更新"
        : "操作已发送，请刷新截图查看结果";
    else
      error.value =
        (result.status === "not_executed"
          ? "未操作："
          : "操作结果需核对，不要重复提交：") +
        (result.reason || "请刷新截图查看");
    if (!result.image) remote.value = false;
  } catch (e) {
    if (!disposed && request === version) {
      screenshot.value = null;
      remote.value = false;
      error.value = e.message + "；请刷新截图，不要重复提交。";
    }
  } finally {
    if (!disposed && request === version) busy.value = false;
  }
}
function imagePoint(event) {
  const image = screenshot.value?.image,
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
    !imageReady.value ||
    event.button !== 0
  )
    return;
  const point = imagePoint(event);
  if (!point) return;
  event.preventDefault();
  dragStart.value = { ...point, at: performance.now(), id: event.pointerId };
  event.currentTarget.setPointerCapture(event.pointerId);
}
function pointerUp(event) {
  const start = dragStart.value;
  dragStart.value = null;
  if (!start || start.id !== event.pointerId) return;
  event.currentTarget.releasePointerCapture(event.pointerId);
  const end = imagePoint(event);
  if (!end || Math.hypot(end.x - start.x, end.y - start.y) < 3) return;
  void control({
    action: "drag",
    x: start.x,
    y: start.y,
    to_x: end.x,
    to_y: end.y,
    duration_ms: Math.round(
      Math.max(80, Math.min(1500, performance.now() - start.at)),
    ),
  });
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
  if (busy.value) return;
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
  if (!value) return;
  text.value = "";
  void control({ action: "type", text: value });
}
function failedImage() {
  imageReady.value = false;
  remote.value = false;
  screenshot.value = null;
  error.value =
    "截图图片加载失败。登录可能已过期，或图片已不可用；请重新登录后刷新截图。";
}
onMounted(() => void refresh());
onBeforeUnmount(() => {
  disposed = true;
  version++;
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
            @click="
              remote = !remote;
              dragStart = null;
            "
          >
            {{ remote ? "退出操作" : "远程操作" }}
          </button>
          <a
            v-if="screenshot"
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
          <select v-model="mode" aria-label="截图操作模式" :disabled="busy">
            <option value="click">点击</option>
            <option value="double">双击</option>
            <option value="right">右键</option>
            <option value="drag">拖动</option>
          </select>
          <button :disabled="busy || !imageReady" @click="scrollRemote(-600)">
            网页上滚</button
          ><button :disabled="busy || !imageReady" @click="scrollRemote(600)">
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
              :disabled="busy || !imageReady || !screenshot?.editable || !text"
            >
              发送文字
            </button>
          </form>
          <div class="remote-keys">
            <button
              v-for="[key, label] in keys"
              :key="key"
              :disabled="busy || !imageReady"
              :aria-label="'远程按键 ' + label"
              @click="control({ action: 'press', key })"
            >
              {{ label }}
            </button>
          </div>
          <div class="remote-keys">
            <button
              :disabled="busy || !imageReady"
              @click="control({ action: 'back' })"
            >
              网页后退</button
            ><button
              :disabled="busy || !imageReady"
              @click="control({ action: 'forward' })"
            >
              网页前进</button
            ><button
              :disabled="busy || !imageReady"
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
            /><button :disabled="busy || !imageReady">前往</button>
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
      <figure v-else-if="screenshot" class="browser-capture">
        <figcaption>
          截图于 {{ new Date(screenshot.capturedAt).toLocaleString() }}
        </figcaption>
        <div class="browser-image">
          <img
            :key="screenshot.snapshotId"
            :src="screenshot.image.url"
            :width="screenshot.image.width"
            :height="screenshot.image.height"
            :alt="'标签页当前截图：' + screenshot.title"
            draggable="false"
            :class="{
              'remote-active': remote,
              'remote-drag': remote && mode === 'drag',
            }"
            @load="imageReady = true"
            @click="clickImage"
            @pointerdown="pointerDown"
            @pointerup="pointerUp"
            @pointercancel="dragStart = null"
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
