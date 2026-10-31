<script setup vapor>
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
const props = defineProps({ api: Function });
const status = ref(null),
  tabs = ref([]),
  selected = ref(""),
  screenshot = ref(null),
  busy = ref(false),
  error = ref("");
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
  selected.value = tab.tag;
  screenshot.value = null;
  error.value = "";
  busy.value = true;
  try {
    const result = await props.api("/chrome/screenshot", "POST", {
      tabTag: tab.tag,
    });
    if (!disposed && request === version) screenshot.value = result;
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
function failedImage() {
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
.browser-view {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: 18px 28px 28px;
}
.browser-tabstrip {
  display: flex;
  flex-shrink: 0;
  overflow-x: auto;
  overscroll-behavior-y: auto;
  margin-bottom: 12px;
  gap: 5px;
  padding: 4px 2px 8px;
  border-bottom: 1px solid var(--line, #e0e7e2);
}
.browser-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 150px;
  max-width: 250px;
  flex-shrink: 0;
  padding: 11px 14px;
  border-radius: 9px 9px 0 0;
  text-align: left;
  background: var(--surface, #fff);
}
.browser-tab.selected {
  background: #e5f1eb;
  border-color: #32836c;
  color: #14624e;
  box-shadow: inset 0 -2px #23745d;
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
  color: var(--muted, #748079);
}
.browser-tab-mark {
  color: #387e69;
}
.browser-tab:focus-visible {
  outline: 2px solid #23745d;
  outline-offset: 1px;
}
.browser-panel {
  border: 1px solid var(--line, #e0e7e2);
  border-radius: 12px;
  background: #fff;
}
.browser-address {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  background: #f6f9f7;
  border-bottom: 1px solid #e0e7e2;
  border-radius: 11px 11px 0 0;
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
  color: #6e7b74;
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
  color: #64736b;
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
  padding: 10px 18px;
  font-size: 11px;
  color: #68766e;
  border-bottom: 1px solid #e8ede9;
}
.browser-image {
  padding: 14px;
  background: #eaf0ec;
  border-radius: 0 0 11px 11px;
}
.browser-image img {
  display: block;
  width: 100%;
  height: auto;
  max-width: 1568px;
  margin: 0 auto;
  background: #fff;
  user-select: none;
}
@media (max-width: 760px) {
  .browser-view {
    padding: 12px 10px max(18px, env(safe-area-inset-bottom, 0px));
  }
  .browser-tab {
    min-width: 130px;
    max-width: 190px;
    padding: 10px;
  }
  .browser-address > div:first-child {
    width: 100%;
  }
  .browser-address {
    padding: 10px;
    gap: 8px;
    align-items: flex-start;
    flex-direction: column;
  }
  .browser-placeholder {
    min-height: 200px;
  }
  .browser-image {
    padding: 4px;
  }
  .browser-placeholder {
    padding: 20px;
  }
  .topbar {
    gap: 12px;
    flex-wrap: wrap;
  }
}
</style>
