<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import ChatMessage from "./ChatMessage.vue";
import { employeeChatMessages } from "./conversation";
const props = defineProps({ api: Function, employeeId: String, name: String, avatar: String, revision: Number, event: Object, composer: Object, readonly: Boolean });
const emit = defineEmits(["task"]);
const messages = ref([]), running = ref(false), busy = ref(false), error = ref(""), transcript = ref(null), fileInput = ref(null), input = ref(null);
const draft = computed({ get: () => props.composer.text, set: (text) => props.composer.text = text });
const files = computed({ get: () => props.composer.images, set: (images) => props.composer.images = images });
const quoted = computed({ get: () => props.composer.quote, set: (quote) => props.composer.quote = quote });
const visible = computed(() => employeeChatMessages(messages.value, running.value));
function quoteMessage(message) {
  const text = (message.displayText || message.text || "[图片]").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  quoted.value = { seq: message.seq, role: message.role, text: text.length > 160 ? text.slice(0, 160) + "…" : text };
  void nextTick(() => input.value?.focus());
}
async function jumpTo(seq) {
  await nextTick();
  const target = [...(transcript.value?.querySelectorAll("[data-message-seq]") || [])].find((element) => Number(element.dataset.messageSeq) === seq);
  if (!target) { error.value = "原消息暂不可见或已不存在"; return; }
  target.scrollIntoView({ block: "center", behavior: "instant" });
  target.focus({ preventScroll: true });
}
let disposed = false, request = 0, streamVersion = 0;
async function scroll() { await nextTick(); if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight; }
async function refresh() {
  const current = ++request, stream = streamVersion;
  try {
    const result = await props.api(`/employees/${props.employeeId}/chat`);
    if (disposed || current !== request) return;
    const atBottom = !messages.value.length || !transcript.value || transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 80;
    messages.value = result.messages;
    if (stream === streamVersion) running.value = result.running;
    if (atBottom) await scroll();
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
  const text = draft.value, images = files.value, quote = quoted.value;
  try {
    await props.api(`/employees/${props.employeeId}/messages`, "POST", { text, images: images.map(({ mime, data }) => ({ mime, data })), ...(quote ? { quoteSeq: quote.seq } : {}) });
    if (draft.value === text && files.value === images && quoted.value === quote) { draft.value = ""; files.value = []; quoted.value = undefined; }
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
function handleEvent(event) {
  if (!event) return;
  streamVersion++;
  switch (event.type) {
    case "started":
      running.value = true;
      error.value = "";
      break;
    case "message_start":
    case "text_delta":
    case "thinking_delta":
      running.value = true;
      break;
    case "error":
      error.value = typeof event.data === "string" ? event.data : event.data?.message;
      break;
    case "done":
      running.value = false;
      void refresh();
      break;
    case "message_end":
    case "compacted":
    case "user":
    case "steer":
      void refresh();
      break;
  }
}
watch(() => props.revision, refresh);
watch(() => props.event, handleEvent);
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; request++; });
</script>
<template>
  <section class="employee-chat">
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <div ref="transcript" class="employee-transcript" aria-live="polite">
      <div v-if="!messages.length" class="employee-welcome"><h3>今天，想交给我什么？</h3><p>直接告诉我目标。我会安排任务、跟进结果，需要你决定时再回来。</p><div v-if="!readonly" class="welcome-prompts"><button type="button" @click="draft = '帮我处理一项工作：'; input?.focus()"><span aria-hidden="true">↗</span> 交代新工作</button><button type="button" @click="draft = '目前有哪些任务需要我处理？'; input?.focus()"><span aria-hidden="true">☷</span> 看看工作进度</button></div></div>
      <ChatMessage v-for="message in visible" :key="message.seq" :message="message" :name="name" :avatar="avatar" :employee-id="employeeId" :quotable="!readonly" @quote="quoteMessage" @jump="jumpTo" @task="emit('task', $event)" />
      <div v-if="running" class="employee-typing" role="status" aria-label="正在输入中"><span>{{ name }}</span><div>正在输入中<span class="typing-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></div></div>
    </div>
    <p v-if="readonly" class="readonly-note">当前账号仅可查看团队员工的对话和任务。</p>
    <form v-else class="employee-composer" @submit.prevent="send">
      <div v-if="quoted" class="composer-quote"><button type="button" @click="jumpTo(quoted.seq)"><strong>引用 {{ quoted.role === 'user' ? '我' : name }}</strong><span>{{ quoted.text }}</span></button><button type="button" class="icon" aria-label="取消引用" @click="quoted = undefined">×</button></div>
      <div class="attachments"><button v-for="(file, index) in files" :key="index" type="button" @click="files.splice(index, 1)">{{ file.name }} ×</button></div>
      <textarea ref="input" v-model="draft" aria-label="给员工的消息" placeholder="告诉我目标，剩下的交给我…" rows="2" @keydown="keydown"></textarea>
      <div class="composer-tools"><input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden multiple @change="upload" /><button type="button" class="attach-button" @click="fileInput.click()"><span aria-hidden="true">＋</span> 添加图片</button><span class="composer-hint">Enter 发送 · Shift + Enter 换行</span><button v-if="running" type="button" @click="stop">停止本轮</button><button class="primary" :disabled="busy || (!draft.trim() && !files.length)">{{ busy ? '提交中…' : '发送' }} <span aria-hidden="true">↑</span></button></div>
    </form>
  </section>
</template>
<style scoped>
.employee-typing { margin: 4px 0 18px 37px; color: var(--muted); font-size: 12px; }
.employee-typing > span { display: block; font-size: 10px; margin-bottom: 5px; }
.employee-typing > div { display: inline-flex; align-items: baseline; gap: 2px; border-radius: 4px 12px 12px; padding: 10px 14px; background: var(--surface-sunken); }
.typing-dots { display: inline-flex; }
.typing-dots i { font-style: normal; animation: typing-dot 1.2s ease-in-out infinite; }
.typing-dots i:nth-child(2) { animation-delay: .15s; }
.typing-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes typing-dot { 0%, 65%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .typing-dots i { animation: none; } }
.composer-quote { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; border-left: 3px solid var(--accent); padding: 0 8px; background: var(--surface-sunken); border-radius: 4px; }
.composer-quote > button:first-child { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; padding: 7px 0; display: grid; gap: 3px; }
.composer-quote strong { font-size: 11px; color: var(--text-secondary); }
.composer-quote span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }
.composer-quote .icon { flex: none; min-width: 44px; min-height: 44px; }
.readonly-note { color: var(--muted); text-align: center; padding: 16px; font-size: 12px; }
.employee-chat { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; padding: 0 16px 12px; }
.employee-transcript { overflow-y: auto; flex: 1; min-height: 0; padding: 12px max(4px, calc((100% - 800px) / 2)); scrollbar-width: thin; }
.employee-welcome { display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; min-height: 0; padding: 8px 0 16px; text-align: left; max-width: 520px; }
.employee-welcome h3 { font-size: 18px; letter-spacing: -.03em; margin: 0 0 8px; font-weight: 650; }
.employee-welcome p { font-size: 13px; color: var(--text-secondary); line-height: 1.65; margin: 0; }
.welcome-prompts { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.welcome-prompts button { background: var(--surface); font-size: 12px; border-radius: 8px; min-height: 40px; padding: 8px 12px; }
.welcome-prompts span { color: var(--accent); margin-right: 4px; }
.employee-composer { flex: none; width: 100%; max-width: 840px; align-self: center; margin: 0; padding: 10px 12px 8px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface); box-shadow: var(--sh-xs); }
.employee-composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.employee-composer textarea { width: 100%; min-height: 40px; max-height: 160px; resize: vertical; border: 0; box-shadow: none; background: transparent; padding: 4px 2px; line-height: 1.6; }
.employee-composer textarea:focus { box-shadow: none; }
.composer-tools { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.composer-tools button { min-height: 36px; font-size: 12px; }
.attach-button { background: transparent; border-color: transparent; color: var(--text-secondary); padding-left: 0; }
.composer-hint { color: var(--muted); font-size: 10px; flex: 1; text-align: right; }
.composer-tools .primary { margin-left: auto; min-width: 72px; }
@media (max-width: 700px) { .employee-chat { padding: 0 12px 10px; } .employee-transcript { padding: 8px 0; } .employee-welcome h3 { font-size: 17px; } .welcome-prompts { margin-top: 10px; } .composer-hint { display: none; } .composer-tools button { min-height: 44px; } .employee-composer textarea { font-size: 16px; } }
@media (max-width: 760px) {
  .employee-chat { padding: 0 12px max(8px, env(safe-area-inset-bottom, 0px)); }
  .employee-composer { padding: 8px 12px 6px; border-radius: 12px; box-shadow: none; }
  .employee-composer textarea { height: 44px; min-height: 44px; max-height: 18dvh; resize: none; padding: 2px 0; font-size: 16px; line-height: 1.5; }
  .composer-tools { margin-top: 4px; gap: 8px; }
  .composer-tools button { min-height: 44px; }
  .composer-hint { display: none; }
}
@media (max-height: 600px) { .employee-welcome { padding: 4px 0 8px; } .employee-welcome p { display: none; } .welcome-prompts { margin-top: 8px; } }
</style>
