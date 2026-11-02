<script setup vapor>
import { onBeforeUnmount, ref, watch } from "vue";
import ConversationTimeline from "./ConversationTimeline.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
const props = defineProps({
  api: Function,
  sessionId: String,
  revision: Number,
  debug: Boolean,
});
const emit = defineEmits(["back"]);
const raw = ref(false);
const record = ref(null);
const session = ref(null),
  messages = ref([]),
  running = ref(false),
  busy = ref(false),
  error = ref("");
let version = 0;
async function refresh() {
  const request = ++version;
  if (session.value?.id !== props.sessionId) {
    record.value = null;
    session.value = null;
    messages.value = [];
    running.value = false;
  }
  busy.value = true;
  error.value = "";
  try {
    const result = await props.api(
      "/sessions/" + encodeURIComponent(props.sessionId),
    );
    if (request !== version) return;
    if (!result.session.taskId && !(props.debug && result.session.employeeId)) throw Error("这不是牛马的会话");
    record.value = result;
    session.value = result.session;
    messages.value = result.messages || [];
    running.value = result.running;
  } catch (e) {
    if (request === version) error.value = e.message;
  } finally {
    if (request === version) busy.value = false;
  }
}
function exportSession() {
  if (!props.debug || busy.value || !record.value) return;
  error.value = "";
  const link = document.createElement("a");
  let url;
  try {
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), ...record.value }, null, 2);
    url = URL.createObjectURL(new Blob([json + "\n"], { type: "application/json;charset=utf-8" }));
    link.href = url;
    link.download = "vega-session-" + record.value.session.id + ".json";
    document.body.append(link);
    link.click();
  } catch (e) {
    error.value = "导出失败：" + e.message;
  } finally {
    link.remove();
    setTimeout(() => { if (url) URL.revokeObjectURL(url); }, 1000);
  }
}
watch(
  () => [props.sessionId, props.revision],
  () => void refresh(),
  { immediate: true },
);
onBeforeUnmount(() => version++);
</script>
<template>
  <PageHeader :title="session?.title || '牛马会话记录'" :subtitle="debug ? '调试会话' : '只读执行记录'" :back="debug ? '调试会话' : '返回牛马'" @back="emit('back')">
    <template #title-extra><span :class="['badge', running ? 'info' : '']"><span v-if="running" class="dot info pulse"></span>{{ running ? "执行中" : "执行记录" }}</span></template>
    <button v-if="debug" type="button" class="sm" :aria-pressed="raw" @click="raw = !raw"><Icon name="code" :size="14" /><span class="hide-mobile">{{ raw ? '整理视图' : '原始消息' }}</span></button>
    <button v-if="debug" type="button" class="sm" :disabled="busy || !record" title="导出当前会话记录（JSON）" aria-label="导出会话（JSON）" @click="exportSession"><Icon name="download" :size="14" /><span class="hide-mobile">导出会话</span></button>
    <button type="button" class="sm" :disabled="busy" title="刷新记录" @click="refresh"><Icon name="refresh" :size="14" /><span class="hide-mobile">刷新记录</span></button>
  </PageHeader>
  <section
    class="transcript employee-session"
    aria-label="牛马会话记录"
    :aria-busy="busy"
  >
    <p class="callout info session-note"><Icon name="lock" :size="14" /><span>只读执行记录；补充、审批或续做请返回对应牛马，不能在这里输入或重放操作。<template v-if="debug">导出包含原始消息、工具参数与本地路径，分享前请脱敏；图片仅保留引用。</template></span></p>
    <dl v-if="debug && session" class="debug-metadata"><dt>Session ID</dt><dd>{{ session.id }}</dd><dt>牛马 / 任务</dt><dd>{{ session.employeeId }} / {{ session.taskId || '沟通会话' }}</dd><dt>模型 / 场景</dt><dd>{{ session.model || '默认' }} / {{ session.scene || 'lightweight' }}</dd><dt>执行位置</dt><dd>{{ session.localAgent ? (session.clientName || session.clientId) : '服务端' }} · {{ session.cwd }}</dd></dl>
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <p v-if="busy && !messages.length" class="context-note" role="status"><span class="spinner"></span>正在加载记录…</p>
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
            image.blobId
              ? '/api/blobs/' + image.blobId
              : 'data:' + image.mime + ';base64,' + image.data
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
            image.blobId
              ? '/api/blobs/' + image.blobId
              : 'data:' + image.mime + ';base64,' + image.data
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
.employee-session { background: var(--surface); }
.session-note { max-width: 820px; margin: 0 auto 12px; }
.debug-metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; max-width: 820px; margin: 0 auto 16px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface-2); font-size: 12px; }
.debug-metadata dt { color: var(--muted); }
.debug-metadata dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); }
@media (max-width: 600px) { .debug-metadata { grid-template-columns: 1fr; gap: 5px; } }
</style>
