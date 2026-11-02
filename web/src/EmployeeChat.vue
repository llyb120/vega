<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import ChatMessage from "./ChatMessage.vue";
import Icon from "./Icon.vue";
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
function grow() {
  const el = input.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}
watch(draft, () => nextTick(grow));
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
    <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span><button type="button" class="icon" aria-label="关闭" @click="error = ''"><Icon name="close" :size="14" /></button></p>
    <div ref="transcript" class="chat-scroll" aria-live="polite">
      <div class="chat-column">
        <div v-if="!messages.length" class="chat-welcome">
          <h3>今天，想交给{{ name }}什么？</h3>
          <p>直接告诉我目标。我会安排任务、跟进结果，需要你决定时再回来找你。</p>
          <div v-if="!readonly" class="welcome-prompts">
            <button type="button" @click="draft = '帮我处理一项工作：'; input?.focus()"><Icon name="plus" :size="15" />交代新工作</button>
            <button type="button" @click="draft = '目前有哪些任务需要我处理？'; input?.focus()"><Icon name="tasks" :size="15" />看看工作进度</button>
          </div>
        </div>
        <ChatMessage v-for="message in visible" :key="message.seq" :message="message" :name="name" :avatar="avatar" :employee-id="employeeId" :quotable="!readonly" @quote="quoteMessage" @jump="jumpTo" @task="emit('task', $event)" />
        <div v-if="running" class="chat-typing" role="status" aria-label="正在输入中"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>{{ name }} 正在处理…</div>
      </div>
    </div>
    <p v-if="readonly" class="readonly-note"><Icon name="lock" :size="14" />当前账号仅可查看团队员工的对话和任务。</p>
    <form v-else class="chat-composer" @submit.prevent="send">
      <div v-if="quoted" class="composer-quote"><Icon name="reply" :size="14" /><button type="button" @click="jumpTo(quoted.seq)"><strong>引用 {{ quoted.role === 'user' ? '我' : name }}</strong><span>{{ quoted.text }}</span></button><button type="button" class="icon sm" aria-label="取消引用" @click="quoted = undefined"><Icon name="close" :size="14" /></button></div>
      <div v-if="files.length" class="attachments"><button v-for="(file, index) in files" :key="index" type="button" :title="'移除 ' + file.name" @click="files.splice(index, 1)"><Icon name="image" :size="12" />{{ file.name }}<Icon name="close" :size="12" /></button></div>
      <div class="composer-row">
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden multiple @change="upload" />
        <button type="button" class="icon attach" aria-label="添加图片" title="添加图片" @click="fileInput.click()"><Icon name="image" /></button>
        <textarea ref="input" v-model="draft" aria-label="给员工的消息" placeholder="告诉我目标，剩下的交给我…" rows="1" @keydown="keydown"></textarea>
        <button v-if="running" type="button" class="stop" title="停止本轮" @click="stop"><Icon name="stop" :size="14" /><span>停止本轮</span></button>
        <button class="primary send" :disabled="busy || (!draft.trim() && !files.length)" :aria-label="busy ? '提交中' : '发送'" :title="busy ? '提交中…' : '发送'"><span v-if="busy" class="spinner"></span><Icon v-else name="send" :size="18" /></button>
      </div>
      <p class="composer-hint">Enter 发送 · Shift + Enter 换行</p>
    </form>
  </section>
</template>
<style scoped>
.employee-chat { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; background: var(--surface); }
.employee-chat > .banner { flex: none; }
.chat-scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.chat-column { max-width: 820px; margin: 0 auto; padding: 16px 24px 8px; }
.chat-welcome { display: grid; gap: 8px; padding: 32px 0 24px; }
.chat-welcome h3 { font-size: 20px; }
.chat-welcome p { color: var(--text-2); }
.welcome-prompts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.welcome-prompts .icon-svg { color: var(--accent); }
.chat-typing { display: flex; align-items: center; gap: 10px; margin: 4px 0 16px 38px; color: var(--muted); font-size: 12px; }
.typing-dots { display: inline-flex; gap: 3px; padding: 8px 10px; border-radius: 4px 12px 12px; background: var(--surface-2); }
.typing-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); animation: typing 1.2s ease-in-out infinite; }
.typing-dots i:nth-child(2) { animation-delay: .15s; }
.typing-dots i:nth-child(3) { animation-delay: .3s; }
@media (prefers-reduced-motion: reduce) { .typing-dots i { animation: none; opacity: .7; } }
@keyframes typing { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
.readonly-note { display: flex; align-items: center; justify-content: center; gap: 6px; flex: none; padding: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.chat-composer { flex: none; width: calc(100% - 48px); max-width: 772px; margin: 0 auto 12px; padding: 6px; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--surface); box-shadow: var(--sh-sm); }
.chat-composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.composer-row { display: flex; align-items: flex-end; gap: 4px; }
.composer-row textarea { flex: 1; min-height: 36px; max-height: 200px; padding: 8px 4px; border: 0; box-shadow: none; resize: none; font-size: 14px; line-height: 1.45; }
.composer-row textarea:focus, .composer-row textarea:focus-visible { box-shadow: none; outline: none; }
.attach { width: 36px; min-height: 36px; color: var(--muted); }
.send { width: 36px; min-height: 36px; padding: 0; border-radius: 10px; }
.stop { min-height: 36px; padding: 0 10px; border-color: var(--border); color: var(--danger); font-size: 12px; }
.composer-hint { padding: 0 8px 0 44px; color: var(--faint); font-size: 11px; }
.composer-quote { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; padding: 4px 4px 4px 10px; border-left: 3px solid var(--accent); border-radius: 4px var(--r-md) var(--r-md) 4px; background: var(--surface-2); color: var(--muted); }
.composer-quote > button:nth-child(2) { display: grid; justify-content: stretch; flex: 1; gap: 1px; min-width: 0; height: auto; min-height: 0; padding: 2px 0; border: 0; background: transparent; font-weight: 400; text-align: left; }
.composer-quote strong { color: var(--text-2); font-size: 11px; }
.composer-quote span { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.attachments { padding: 2px 4px 6px; }
.attachments button { gap: 4px; }
@media (max-width: 767px) {
  .chat-column { padding: 12px 12px 4px; }
  .chat-welcome { padding: 16px 0; }
  .chat-welcome h3 { font-size: 18px; }
  .chat-composer { width: calc(100% - 16px); margin: 0 8px max(8px, env(safe-area-inset-bottom, 0px)); border-radius: 12px; }
  .composer-row textarea { font-size: 16px; padding: 7px 2px; }
  .attach, .send { width: 40px; min-height: 40px; }
  .stop span { display: none; }
  .stop { width: 40px; min-height: 40px; padding: 0; }
  .composer-hint { display: none; }
}
@media (pointer: coarse) { .composer-hint { display: none; } }
@media (max-height: 560px) { .chat-welcome p { display: none; } }
</style>
