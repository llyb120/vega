<script setup vapor>
import { onBeforeUnmount, ref, watch } from "vue";
const props = defineProps({
  api: Function,
  sessionId: String,
  revision: Number,
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
    if (!result.session.taskId) throw Error("这不是员工任务的会话");
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
      <button class="link" @click="emit('back')">← 返回数字员工</button>
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
      这是员工任务的执行记录；补充、审批或续做请返回数字员工看板，不会改变你的普通会话。
    </p>
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
          {{ message.displayText || message.text }}
        </div>
        <div v-if="message.calls?.length" class="calls">
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
