<script setup vapor>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import ConversationTimeline from "./ConversationTimeline.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
import WorkspaceHandoff from "./WorkspaceHandoff.vue";
import { CHAT_PAGE_SIZE, mergeMessages } from "./chat-history.js";
const props = defineProps({
  api: Function,
  sessionId: String,
  revision: Number,
  handoffRevision: Number,
  debug: Boolean,
});
const emit = defineEmits(["back"]);
const raw = ref(false);
const record = ref(null);
const session = ref(null),
  messages = ref([]),
  running = ref(false),
  hasMore = ref(false),
  busy = ref(false),
  loadingOlder = ref(false),
  error = ref("");
const transcript = ref(null);
let version = 0, refreshVersion = 0, activeSession = "", ready = false;
const OLDER_THRESHOLD = 600;
const nearBottom = () => !transcript.value || transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 80;
async function refresh() {
  if (activeSession !== props.sessionId) {
    activeSession = props.sessionId;
    version++;
    ready = false;
    loadingOlder.value = false;
    record.value = null;
    session.value = null;
    messages.value = [];
    running.value = false;
    hasMore.value = false;
  }
  const current = version, request = ++refreshVersion;
  const initial = !record.value, last = messages.value.at(-1)?.seq ?? 0, atBottom = nearBottom();
  busy.value = true;
  error.value = "";
  try {
    const result = await props.api(
      "/sessions/" + encodeURIComponent(props.sessionId) + (initial ? "?limit=" + CHAT_PAGE_SIZE : "?after=" + last),
    );
    if (current !== version || request !== refreshVersion) return;
    if (!result.session.taskId && !(props.debug && (result.session.employeeId || result.session.groupId))) throw Error("这不是牛马的会话");
    if (!initial && Number.isSafeInteger(result.lastSeq) && result.lastSeq < last) {
      record.value = null;
      messages.value = [];
      hasMore.value = false;
      running.value = false;
      ready = false;
      version++;
      loadingOlder.value = false;
      return refresh();
    }
    const follow = initial || (atBottom && nearBottom());
    record.value = result;
    session.value = result.session;
    messages.value = initial ? result.messages || [] : mergeMessages(messages.value, result.messages || []);
    if (initial) hasMore.value = !!result.hasMore;
    running.value = !!result.running;
    await nextTick();
    if (current !== version || request !== refreshVersion) return;
    if (follow && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
    if (initial) await fillViewport(current);
    if (current === version) ready = true;
  } catch (e) {
    if (current === version && request === refreshVersion) {
      if ([401, 403, 404].includes(e.status)) {
        record.value = null;
        messages.value = [];
        hasMore.value = false;
        running.value = false;
        ready = false;
        version++;
        loadingOlder.value = false;
        busy.value = false;
      }
      if (initial || !e.network) error.value = e.message;
    }
  } finally {
    if (current === version && request === refreshVersion) busy.value = false;
  }
}
async function loadOlder() {
  const first = messages.value[0]?.seq;
  if (loadingOlder.value || !hasMore.value || !first) return;
  const request = version;
  loadingOlder.value = true;
  const el = transcript.value;
  try {
    const result = await props.api(
      "/sessions/" + encodeURIComponent(props.sessionId) + "?before=" + first + "&limit=" + CHAT_PAGE_SIZE,
    );
    if (request !== version || messages.value[0]?.seq !== first) return;
    if (!result.session.taskId && !(props.debug && (result.session.employeeId || result.session.groupId))) throw Error("这不是牛马的会话");
    const height = el?.scrollHeight ?? 0, top = el?.scrollTop ?? 0;
    messages.value = mergeMessages(result.messages || [], messages.value);
    hasMore.value = !!result.hasMore;
    await nextTick();
    if (request === version && el) el.scrollTop = top + (el.scrollHeight - height);
  } catch (e) {
    if (request === version && !e.network) error.value = e.message;
  } finally {
    if (request === version) loadingOlder.value = false;
  }
}
async function fillViewport(current = version) {
  // A raw page can collapse into one tool summary; page all roles until the reader can scroll.
  while (current === version && hasMore.value && transcript.value) {
    const el = transcript.value;
    if (el.scrollHeight > el.clientHeight + OLDER_THRESHOLD) break;
    const first = messages.value[0]?.seq;
    await loadOlder();
    if (messages.value[0]?.seq === first) break;
  }
}
function onScroll() {
  const el = transcript.value;
  if (!ready || !el || loadingOlder.value || !hasMore.value || el.scrollTop >= OLDER_THRESHOLD) return;
  const current = version, first = messages.value[0]?.seq;
  void loadOlder().then(() => { if (current === version && messages.value[0]?.seq !== first) onScroll(); });
}
async function exportSession() {
  if (!props.debug || busy.value || !record.value) return;
  error.value = "";
  busy.value = true;
  const link = document.createElement("a");
  let url;
  try {
    // Export always pulls the full transcript once (display stays paginated).
    const full = await props.api("/sessions/" + encodeURIComponent(props.sessionId));
    const json = JSON.stringify({
      exportedAt: new Date().toISOString(),
      session: full.session,
      messages: full.messages,
      folds: full.folds,
      fire: full.fire,
      running: full.running,
      context: full.context,
      canWrite: full.canWrite,
    }, null, 2);
    url = URL.createObjectURL(new Blob([json + "\n"], { type: "application/json;charset=utf-8" }));
    link.href = url;
    link.download = "vega-session-" + full.session.id + ".json";
    document.body.append(link);
    link.click();
  } catch (e) {
    error.value = "导出失败：" + e.message;
  } finally {
    link.remove();
    busy.value = false;
    setTimeout(() => { if (url) URL.revokeObjectURL(url); }, 1000);
  }
}
watch(
  () => [props.sessionId, props.revision],
  () => void refresh(),
  { immediate: true },
);
onBeforeUnmount(() => { version++; });
</script>
<template>
  <PageHeader :title="session?.title || '牛马会话记录'" :subtitle="debug ? '调试会话' : '只读执行记录'" :back="debug ? '调试会话' : '返回牛马'" @back="emit('back')">
    <template #title-extra><span :class="['badge', running ? 'info' : '']"><span v-if="running" class="dot info pulse"></span>{{ running ? "执行中" : "执行记录" }}</span></template>
    <button v-if="debug" type="button" class="sm" :aria-pressed="raw" @click="raw = !raw"><Icon name="code" :size="14" /><span class="hide-mobile">{{ raw ? '整理视图' : '原始消息' }}</span></button>
    <button v-if="debug" type="button" class="sm" :disabled="busy || !record" title="导出当前会话记录（JSON）" aria-label="导出会话（JSON）" @click="exportSession"><Icon name="download" :size="14" /><span class="hide-mobile">导出会话</span></button>
    <button type="button" class="sm" :disabled="busy" title="刷新记录" @click="refresh"><Icon name="refresh" :size="14" /><span class="hide-mobile">刷新记录</span></button>
  </PageHeader>
  <section
    ref="transcript"
    class="transcript employee-session"
    aria-label="牛马会话记录"
    :aria-busy="busy || loadingOlder"
    @scroll.passive="onScroll"
  >
    <p class="callout info session-note"><Icon name="lock" :size="14" /><span>只读执行记录；补充、审批或续做请返回对应牛马，不能在这里输入或重放操作。<template v-if="debug">导出包含原始消息、工具参数与本地路径，分享前请脱敏；图片仅保留引用。</template></span></p>
    <dl v-if="debug && session" class="debug-metadata"><dt>Session ID</dt><dd>{{ session.id }}</dd><dt>牛马 / 任务</dt><dd>{{ session.employeeId }} / {{ session.taskId || '沟通会话' }}</dd><dt>模型 / 场景</dt><dd>{{ session.model || '未配置' }} / {{ session.scene || 'lightweight' }}</dd><dt>执行位置</dt><dd>{{ session.localAgent ? (session.clientName || session.clientId) : '服务端' }} · {{ session.cwd }}</dd></dl>
    <WorkspaceHandoff v-if="session?.employeeId && session?.taskId" :api="api" :employee-id="session.employeeId" :task-id="session.taskId" :revision="handoffRevision" />
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <p v-if="busy && !messages.length" class="context-note" role="status"><span class="spinner"></span>正在加载记录…</p>
    <div v-if="hasMore" class="load-older" :aria-busy="loadingOlder">
      <span v-if="loadingOlder" class="spinner" role="status" aria-label="正在加载更早的记录"></span>
      <button v-else type="button" class="sm ghost" @click="loadOlder">上滑查看更早的记录</button>
    </div>
    <ConversationTimeline v-if="!raw" :key="sessionId" :messages="messages" :running="running" />
    <template v-else><article
      v-for="(message, i) in messages"
      :key="sessionId + '-' + (message.seq || i)"
      :class="['message', message.role]"
    >
      <details v-if="message.role === 'tool'" class="tool-block">
        <summary>{{ message.error ? "⚠" : "✓" }} {{ message.name }}</summary>
        <pre>{{ message.text }}</pre>
        <img
          v-for="(image, n) in message.images || []"
          :key="n"
          :src="
            image.url ||
            (image.blobId
              ? '/api/blobs/' + image.blobId
              : 'data:' + image.mime + ';base64,' + image.data)
          "
          alt="工具返回的图片"
        />
      </details>
      <template v-else
        ><div class="message-meta">
          <span>{{ message.role === "user" ? "任务输入" : "Vega" }}</span
          ><span>{{ message.model || "" }}</span>
        </div>
        <details v-if="message.thinking" class="reasoning">
          <summary>思考过程</summary>
          <pre>{{ message.thinking }}</pre>
        </details>
        <div class="message-text">
          {{ debug ? message.text : message.displayText || message.text }}
        </div>
        <details v-if="debug && message.calls?.length" class="tool-block"><summary>原始工具参数</summary><pre>{{ JSON.stringify(message.calls, null, 2) }}</pre></details>
        <div v-else-if="message.calls?.length" class="calls">
          <span v-for="call in message.calls" :key="call.id"
            >↳ {{ call.name }}</span
          >
        </div>
        <img
          v-for="(image, n) in message.images || []"
          :key="n"
          :src="
            image.url ||
            (image.blobId
              ? '/api/blobs/' + image.blobId
              : 'data:' + image.mime + ';base64,' + image.data)
          "
          alt="任务附图"
      /></template>
    </article></template>
    <p v-if="!busy && !messages.length && !error" class="empty-card">
      还没有执行记录
    </p>
  </section>
</template>
<style scoped>
.employee-session { background: var(--surface); overflow-anchor: none; }
.session-note { max-width: 820px; margin: 0 auto 12px; }
.load-older { display: flex; align-items: center; justify-content: center; height: 32px; margin: 0 auto 12px; color: var(--muted); }
.debug-metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; max-width: 820px; margin: 0 auto 16px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface-2); font-size: 12px; }
.debug-metadata dt { color: var(--muted); }
.debug-metadata dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); }
@media (max-width: 600px) { .debug-metadata { grid-template-columns: 1fr; gap: 5px; } }
</style>
