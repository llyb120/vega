<script setup vapor>
import { onBeforeUnmount, ref, watch } from "vue";
const props = defineProps({
  api: Function,
  sessionId: String,
  revision: Number,
  debug: Boolean,
});
const emit = defineEmits(["back"]);
const session = ref(null),
  messages = ref([]),
  running = ref(false),
  busy = ref(false),
  error = ref("");
let version = 0;
async function refresh() {
  const request = ++version;
  if (session.value?.id !== props.sessionId) {
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
    if (!result.session.taskId && !(props.debug && result.session.employeeId)) throw Error("这不是员工的会话");
    session.value = result.session;
    messages.value = result.messages || [];
    running.value = result.running;
  } catch (e) {
    if (request === version) error.value = e.message;
  } finally {
    if (request === version) busy.value = false;
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
  <header class="topbar">
      <button class="link" @click="emit('back')">← {{ debug ? '返回调试会话' : '返回数字员工' }}</button>
      <h2>{{ session?.title || "员工会话记录" }}</h2>
    <div class="actions">
      <span :class="['pill', running ? 'green' : '']">{{
        running ? "执行中" : "执行记录"
      }}</span
      ><button :disabled="busy" @click="refresh">刷新记录</button>
    </div>
  </header>
  <section
    class="transcript employee-session"
    aria-label="员工会话记录"
    :aria-busy="busy"
  >
    <p class="context-note">
      只读执行记录；补充、审批或续做请返回对应员工，不能在这里输入或重放操作。
    </p>
    <dl v-if="debug && session" class="debug-metadata"><dt>Session ID</dt><dd>{{ session.id }}</dd><dt>员工 / 任务</dt><dd>{{ session.employeeId }} / {{ session.taskId || '沟通会话' }}</dd><dt>模型 / 场景</dt><dd>{{ session.model || '默认' }} / {{ session.scene || 'lightweight' }}</dd><dt>执行位置</dt><dd>{{ session.localAgent ? (session.clientName || session.clientId) : '服务端' }} · {{ session.cwd }}</dd></dl>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="busy && !messages.length" role="status">正在加载记录…</p>
    <article
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
    </article>
    <p v-if="!busy && !messages.length && !error" class="empty-card">
      还没有执行记录
    </p>
  </section>
</template>
<style scoped>
.debug-metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-sunken); font-size: 12px; }
.debug-metadata dt { color: var(--muted); }
.debug-metadata dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
@media (max-width: 600px) { .debug-metadata { grid-template-columns: 1fr; gap: 5px; } }
</style>
