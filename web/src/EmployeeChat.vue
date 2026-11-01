<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import ToolSteps from "./ToolSteps.vue";
import { groupTurns } from "./conversation";
const props = defineProps({ api: Function, employeeId: String, name: String, revision: Number, event: Object, composer: Object });
const messages = ref([]), running = ref(false), busy = ref(false), error = ref(""), live = ref(""), transcript = ref(null), fileInput = ref(null);
const draft = computed({ get: () => props.composer.text, set: (text) => props.composer.text = text });
const files = computed({ get: () => props.composer.images, set: (images) => props.composer.images = images });
const turns = computed(() => groupTurns(messages.value));
let disposed = false, request = 0;
async function scroll() { await nextTick(); if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight; }
async function refresh() {
  const current = ++request;
  try {
    const result = await props.api(`/employees/${props.employeeId}/chat`);
    if (disposed || current !== request) return;
    messages.value = result.messages;
    running.value = result.running;
    live.value = "";
    await scroll();
  } catch (e) { if (!disposed) error.value = e.message; }
}
async function upload(event) {
  error.value = "";
  try {
    const incoming = [...event.target.files];
    if (files.value.length + incoming.length > 16) throw Error("最多16张图片");
    for (const file of incoming) {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(file.type) || file.size > 25 * 1024 * 1024) throw Error("请使用25MiB以内的图片");
    }
    if (files.value.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw Error("图片总大小不能超过64MiB");
    files.value = [...files.value, ...await Promise.all(incoming.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, size: file.size, mime: file.type, data: reader.result.split(",")[1] });
      reader.onerror = () => reject(Error("读取图片失败"));
      reader.readAsDataURL(file);
    })))];
  } catch (e) { error.value = e.message; }
  event.target.value = "";
}
async function send() {
  if (busy.value || (!draft.value.trim() && !files.value.length)) return;
  busy.value = true; error.value = "";
  const text = draft.value, images = files.value;
  try {
    await props.api(`/employees/${props.employeeId}/messages`, "POST", { text, images: images.map(({ mime, data }) => ({ mime, data })) });
    if (draft.value === text && files.value === images) { draft.value = ""; files.value = []; }
    await refresh();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function stop() {
  try { await props.api(`/employees/${props.employeeId}/cancel`, "POST", {}); }
  catch (e) { error.value = e.message; }
}
function keydown(event) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) { event.preventDefault(); void send(); }
}
watch(() => props.revision, refresh);
watch(() => props.event, (event) => {
  if (event?.type === "text_delta") { live.value += event.data; running.value = true; void scroll(); }
  else if (event?.type === "message_start") live.value = "";
  else if (event?.type === "started") running.value = true;
  else if (event?.type === "error") error.value = typeof event.data === "string" ? event.data : event.data?.message;
  else if (["message_end", "done", "user", "steer"].includes(event?.type)) void refresh();
});
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; request++; });
</script>
<template>
  <section class="employee-chat">
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <div ref="transcript" class="employee-transcript" aria-live="polite">
      <div v-if="!messages.length" class="empty-card"><h3>把工作交给 {{ name }}</h3><p>直接说目标。我会安排任务、跟进结果，在需要你决定时回来。</p></div>
      <section v-for="turn in turns" :key="turn.user?.seq || 'reply'" class="conversation-turn">
        <article v-if="turn.user" class="message user">
          <UserMessage :text="turn.user.displayText || turn.user.text || ''" />
          <img v-for="image in turn.user.images || []" :key="image.blobId" :src="`/api/blobs/${image.blobId}`" alt="用户附图" />
        </article>
        <ToolSteps v-if="turn.body.some((message) => message.role === 'tool' || message.calls?.length)" :items="turn.body.filter((message) => message.role === 'tool' || message.calls?.length)" />
        <article v-for="message in turn.body.filter((message) => message.role === 'assistant' && message.text)" :key="message.seq" class="message assistant">
          <small class="hint">{{ name }}</small><MessageText :text="message.displayText || message.text" />
        </article>
      </section>
      <article v-if="live" class="message assistant"><MessageText :text="live" streaming /></article>
      <p v-if="running" class="hint" role="status">正在处理你的消息… 后台任务可在“工作”中查看。</p>
    </div>
    <form class="employee-composer card" @submit.prevent="send">
      <div class="attachments"><button v-for="(file, index) in files" :key="index" type="button" @click="files.splice(index, 1)">{{ file.name }} ×</button></div>
      <textarea v-model="draft" aria-label="给员工的消息" placeholder="交代工作、补充要求，或询问进度…" rows="3" @keydown="keydown"></textarea>
      <div class="actions"><input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden multiple @change="upload" /><button type="button" @click="fileInput.click()">添加图片</button><button v-if="running" type="button" @click="stop">停止本轮</button><button class="primary" :disabled="busy || (!draft.trim() && !files.length)">{{ busy ? '提交中…' : '发送' }}</button></div>
    </form>
  </section>
</template>
<style scoped>
.employee-chat { display: flex; flex-direction: column; min-height: 0; height: min(68dvh, 850px); }
.employee-transcript { overflow-y: auto; flex: 1; min-height: 140px; padding: 16px 4px; }
.employee-composer { flex: none; margin: 0; }
.employee-composer textarea { width: 100%; resize: vertical; }
.employee-composer .actions { justify-content: flex-end; margin-top: 8px; }
.message img { max-width: 100%; max-height: 360px; object-fit: contain; }
</style>
