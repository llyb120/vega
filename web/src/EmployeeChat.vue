<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import ChatMessage from "./ChatMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import Icon from "./Icon.vue";
import { employeeChatMessages, continuesPrevious } from "./conversation";
import { createChatHistory } from "./chat-history.js";
import { createChatCache } from "./chat-cache.js";
const props = defineProps({ api: Function, userId: String, employeeId: String, name: String, avatar: String, revision: Number, event: Object, composer: Object, readonly: Boolean, tasks: Array, remember: Function });
const emit = defineEmits(["task"]);
const messages = ref([]), running = ref(false), hasMore = ref(false), loadingOlder = ref(false), error = ref(""), transcript = ref(null), fileInput = ref(null), input = ref(null);
const draft = computed({ get: () => props.composer.text, set: (text) => props.composer.text = text });
const files = computed({ get: () => props.composer.images, set: (images) => props.composer.images = images });
const quoted = computed({ get: () => props.composer.quote, set: (quote) => props.composer.quote = quote });
// shortcut: unsent messages live with this page; use durable storage if reload recovery is required.
const outbox = computed(() => props.composer.outbox ||= []);
watch([messages, running], ([rows, active]) => {
  const delivered = new Map(rows.filter((message) => message.clientMessageId).map((message) => [message.clientMessageId, message.seq]));
  let anchor = 0;
  props.composer.outbox = outbox.value.filter((message) => {
    message.afterSeq = Math.max(message.afterSeq, anchor);
    if (delivered.has(message.clientMessageId)) { anchor = Math.max(anchor, delivered.get(message.clientMessageId)); return false; }
    if (!active && message.sendStatus === "sent") {
      message.sendStatus = "failed";
      message.sendError = "本轮已结束，但尚未确认这条消息；可安全重发";
    }
    return true;
  });
});
const visible = computed(() => employeeChatMessages(messages.value));
const displayed = computed(() => {
  const rows = [...visible.value];
  for (const message of outbox.value) {
    const next = rows.findIndex((row) => !row.sendStatus && row.seq > message.afterSeq);
    rows.splice(next < 0 ? rows.length : next, 0, message);
  }
  return rows.map((message, index) => ({ message, continued: continuesPrevious(rows[index - 1], message) }));
});
const typingContinued = computed(() => continuesPrevious(displayed.value.at(-1)?.message, { role: "assistant" }));
const history = createChatHistory({ api: (...args) => props.api(...args), path: () => `/employees/${props.employeeId}/chat`, messages, running, hasMore, cache: createChatCache(props.userId, props.employeeId) });

// Message avatars rest on one up-right glance. The reply that replaces the typing row starts from the typing
// avatar's last glance and eases into it (in memory only; nothing is persisted).
const taskStatus = computed(() => Object.fromEntries((props.tasks || []).map((task) => [task.id, task.status])));
async function onRemember(message) {
  if (!props.remember || !message?.text) return;
  const claim = String(message.displayText || message.text).replace(/\s+/g, " ").trim();
  const short = [...claim].slice(0, 200).join("");
  await props.remember({ claim: short, memoryKind: "preference", memoryScene: "chat", source: "ui" });
}
function quoteMessage(message) {
  const text = (message.displayText || message.text || "[图片]").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  quoted.value = { seq: message.seq, role: message.role, text: text.length > 160 ? text.slice(0, 160) + "…" : text };
  void nextTick(() => input.value?.focus());
}
const findMessage = (seq) => [...(transcript.value?.querySelectorAll("[data-message-seq]") || [])].find((element) => Number(element.dataset.messageSeq) === seq);
async function jumpTo(seq) {
  await nextTick();
  // Quoted messages may be older than the loaded window: page back until the source is in the DOM.
  while (!findMessage(seq) && hasMore.value && messages.value[0]?.seq > seq && !disposed) await loadOlder();
  const target = findMessage(seq);
  if (!target) { error.value = "原消息暂不可见或已不存在"; return; }
  target.scrollIntoView({ block: "center", behavior: "instant" });
  target.focus({ preventScroll: true });
}
let disposed = false, turn = 0;
const nearBottom = () => !transcript.value || transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 80;
async function scroll() { await nextTick(); if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight; }
/** Prepend one older page while keeping the message under the reader's eyes exactly where it was. */
async function loadOlder() {
  if (loadingOlder.value || !hasMore.value || disposed) return;
  loadingOlder.value = true;
  const el = transcript.value, height = el?.scrollHeight ?? 0, top = el?.scrollTop ?? 0;
  try {
    await history.older();
    await nextTick();
    if (el && !disposed) el.scrollTop = top + (el.scrollHeight - height);
  } catch (e) { if (!disposed && !e.network) error.value = e.message; }
  finally { loadingOlder.value = false; }
}
const OLDER_THRESHOLD = 600;
async function fillViewport() {
  // A page of raw messages may hold few visible bubbles (tool calls are hidden); keep paging until the view can scroll.
  for (let guard = 0; guard < 20 && hasMore.value && !disposed; guard++) {
    const el = transcript.value;
    if (el && el.scrollHeight > el.clientHeight + OLDER_THRESHOLD) break;
    const first = messages.value[0]?.seq;
    await loadOlder();
    if (messages.value[0]?.seq === first) break;
  }
}
let ready = false;
function onScroll() {
  const el = transcript.value;
  if (!ready || !el || el.scrollTop >= OLDER_THRESHOLD || !hasMore.value || loadingOlder.value) return;
  const first = messages.value[0]?.seq;
  void loadOlder().then(() => { if (messages.value[0]?.seq !== first) onScroll(); });
}
async function load() {
  let cached = false;
  try {
    await history.load(async () => { cached = true; ready = true; await scroll(); });
    if (disposed) return;
    if (!cached || nearBottom()) await scroll();
    ready = true;
    await fillViewport();
  } catch (e) { if (!disposed && !e.network) error.value = e.message; }
}
/** Fetch only messages after the newest one we hold; `apply` runs in the same tick as the merge. */
async function refresh(apply, syncRunning = true) {
  const atBottom = nearBottom();
  try {
    await history.newer(apply, syncRunning);
    if (!disposed && atBottom) await scroll();
  } catch (e) { if (!disposed && !e.network) { error.value = e.message; apply?.([]); } }
}
/**
 * The turn is over. Keep the typing row on screen until the reply is in hand, then swap them in one tick:
 * merge the reply and clear `running` together so no frame shows neither.
 */
function finishTurn() {
  const current = turn;
  return refresh(() => {
    if (current !== turn) return; // a new turn already started; it owns the typing row now
    running.value = false;
  });
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
  if (props.readonly || (!draft.value.trim() && !files.value.length)) return;
  if (outbox.value.length >= 16) { error.value = "请先重发未送达的消息（最多保留16条）"; return; }
  error.value = "";
  // getRandomValues also works over LAN HTTP, where randomUUID is unavailable.
  const clientMessageId = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
  outbox.value.push({ role: "user", text: draft.value, images: files.value.map(({ mime, data }) => ({ mime, data })), quote: quoted.value, clientMessageId, afterSeq: history.lastSeq(), at: Date.now(), sendStatus: "pending" });
  const message = outbox.value.at(-1);
  draft.value = ""; files.value = []; quoted.value = undefined;
  void scroll();
  return retry(message);
}
let sendQueue = Promise.resolve();
function retry(message) {
  if (props.readonly || message.sendStatus === "sending" || message.sendStatus === "sent") return;
  message.sendStatus = "sending";
  message.sendError = "";
  const employeeId = props.employeeId;
  const submit = async () => {
    try {
      if (disposed || props.readonly) throw Error("发送已暂停，请回到对话后重发");
      await props.api(`/employees/${employeeId}/messages`, "POST", {
        text: message.text, images: message.images, clientMessageId: message.clientMessageId,
        ...(message.quote ? { quoteSeq: message.quote.seq } : {}),
      });
      message.sendStatus = "sent";
      return true;
    } catch (e) {
      message.sendStatus = "failed";
      message.sendError = e.message;
      return false;
    }
  };
  sendQueue = sendQueue.then(submit, submit);
  return sendQueue.then(async (sent) => {
    if (sent && !disposed) { await refresh(); await scroll(); }
  });
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
  history.touch();
  switch (event.type) {
    case "started":
      turn++;
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
      void finishTurn();
      break;
    case "message_end":
      // No streaming here: each reply appears whole once it is persisted; the typing dots cover the wait.
      void refresh(undefined, false);
      break;
    case "compacted":
    case "user":
    case "steer":
      void refresh(undefined, false);
      break;
  }
}
watch(() => props.revision, () => refresh());
// `message_end` and `done` arrive in the same tick through one shared ref; a pre-flush watcher would only see
// the last of them, so every event is handled synchronously as it is assigned.
watch(() => props.event, handleEvent, { flush: "sync" });
onMounted(load);
onBeforeUnmount(() => { disposed = true; history.dispose(); });
</script>
<template>
  <section class="employee-chat">
    <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span><button type="button" class="icon" aria-label="关闭" @click="error = ''"><Icon name="close" :size="14" /></button></p>
    <div ref="transcript" class="chat-scroll" aria-live="polite" @scroll.passive="onScroll">
      <div class="chat-column">
        <div v-if="hasMore" class="chat-older" :aria-busy="loadingOlder"><span v-if="loadingOlder" class="spinner" aria-label="正在加载更早的消息"></span><span v-else>上滑查看更早的消息</span></div>
        <div v-if="!messages.length && !outbox.length && !running" class="chat-welcome">
          <h3>今天，想交给{{ name }}什么？</h3>
          <p>直接告诉我目标。我会安排任务、跟进结果，需要你决定时再回来找你。</p>
          <div v-if="!readonly" class="welcome-prompts">
            <button type="button" @click="draft = '帮我处理一项工作：'; input?.focus()"><Icon name="plus" :size="15" />交代新工作</button>
            <button type="button" @click="draft = '目前有哪些任务需要我处理？'; input?.focus()"><Icon name="tasks" :size="15" />看看工作进度</button>
          </div>
        </div>
        <ChatMessage v-for="{ message, continued } in displayed" :key="message.clientMessageId || message.seq || message.liveKey" :message="message" :continued="continued" :name="name" :avatar="avatar" :employee-id="employeeId" :task-status="taskStatus" :tasks="tasks" :quotable="!readonly" :rememberable="!readonly && !!remember" @quote="quoteMessage" @jump="jumpTo" @task="emit('task', $event)" @retry="retry" @remember="onRemember" />
        <article v-if="running" class="chat-message assistant chat-typing" :class="{ continued: typingContinued }" role="status" aria-label="正在输入中">
          <span v-if="typingContinued" class="chat-avatar spacer" aria-hidden="true"></span>
          <span v-else class="chat-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="employeeId" :name="name" :avatar="avatar" /></span>
          <div class="chat-content">
            <div class="chat-heading"><strong v-if="!typingContinued">{{ name }}</strong><span>正在输入中</span></div>
            <div class="chat-bubble"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
          </div>
        </article>
      </div>
    </div>
    <p v-if="readonly" class="readonly-note"><Icon name="lock" :size="14" />当前账号仅可查看团队牛马的对话和任务。</p>
    <form v-else class="chat-composer" @submit.prevent="send">
      <div v-if="quoted" class="composer-quote"><Icon name="reply" :size="14" /><button type="button" @click="jumpTo(quoted.seq)"><strong>引用 {{ quoted.role === 'user' ? '我' : name }}</strong><span>{{ quoted.text }}</span></button><button type="button" class="icon sm" aria-label="取消引用" @click="quoted = undefined"><Icon name="close" :size="14" /></button></div>
      <div v-if="files.length" class="attachments"><button v-for="(file, index) in files" :key="index" type="button" :title="'移除 ' + file.name" @click="files.splice(index, 1)"><Icon name="image" :size="12" />{{ file.name }}<Icon name="close" :size="12" /></button></div>
      <div class="composer-row">
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden multiple @change="upload" />
        <button type="button" class="icon attach" aria-label="添加图片" title="添加图片" @click="fileInput.click()"><Icon name="image" /></button>
        <textarea ref="input" v-model="draft" aria-label="给牛马的消息" placeholder="告诉我目标，剩下的交给我…" rows="1" @keydown="keydown"></textarea>
        <button v-if="running" type="button" class="stop" title="停止本轮" @click="stop"><Icon name="stop" :size="14" /><span>停止本轮</span></button>
        <button class="primary send" :disabled="!draft.trim() && !files.length" aria-label="发送" title="发送"><Icon name="send" :size="18" /></button>
      </div>
      <p class="composer-hint">Enter 发送 · Shift + Enter 换行</p>
    </form>
  </section>
</template>
<style scoped>
.employee-chat { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; background: var(--surface); }
.employee-chat > .banner { flex: none; }
.chat-scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; overflow-anchor: none; scrollbar-width: thin; }
.chat-column { max-width: 820px; margin: 0 auto; padding: 16px 24px 8px; }
.chat-welcome { display: grid; gap: 8px; padding: 32px 0 24px; }
.chat-welcome h3 { font-size: 20px; }
.chat-welcome p { color: var(--text-2); }
.welcome-prompts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.welcome-prompts .icon-svg { color: var(--accent); }
.chat-older { display: grid; place-items: center; height: 32px; color: var(--faint); font-size: 11px; }
.chat-older .spinner { width: 14px; height: 14px; }
/* The typing row mirrors ChatMessage's assistant row (same avatar slot, heading and bubble) so the reply replaces it in place. */
.chat-typing { display: flex; align-items: flex-start; gap: var(--chat-gap); margin: 0 0 16px; min-width: 0; }
.chat-typing.continued { margin-top: -10px; }
.chat-typing .chat-avatar.spacer { height: 0; background: none; }
.chat-typing .chat-avatar { display: grid; place-items: center; flex: none; width: var(--chat-avatar); height: var(--chat-avatar); border-radius: 12px; background: var(--accent-soft); }
.chat-typing .chat-content { display: grid; gap: 4px; min-width: 0; max-width: min(100% - var(--chat-avatar) - var(--chat-gap), 680px); }
.chat-typing .chat-heading { display: flex; align-items: center; gap: 8px; min-height: 20px; color: var(--muted); font-size: 11px; }
.chat-typing .chat-heading strong { color: var(--text-2); font-size: 12px; font-weight: 600; }
.chat-typing .chat-bubble { justify-self: start; padding: 9px 13px; border-radius: 4px 14px 14px 14px; background: var(--surface-2); line-height: 1.65; }
.typing-dots { display: flex; align-items: center; gap: 4px; height: 23px; }
.typing-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: typing 1.2s ease-in-out infinite; }
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
  .chat-typing { margin-bottom: 14px; }
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
