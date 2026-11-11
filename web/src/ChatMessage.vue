<script setup vapor>
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import UserAvatar from "./UserAvatar.vue";
import Icon from "./Icon.vue";
import FileCard from "./FileCard.vue";
import { computed, ref } from "vue";
import { taskLabel, taskTone, shortTime } from "./task-status";
import { MESSAGE_POSE } from "./bot-avatar.js";
import PressMention from "./PressMention.vue";
import { exportResult, exportTitleOf } from "./export-result.js";
import { filesArchiveBase } from "./markdown.js";
import { bubbleTint, parseAvatarColor } from "../../shared/employee-avatars";
const props = defineProps({ message: Object, name: String, avatar: String, viewerAvatar: String, employeeId: String, taskStatus: Object, tasks: Array, quotable: Boolean, rememberable: Boolean, continued: Boolean, viewerId: String, openAuthor: Boolean, mentionAuthor: Boolean });
const emit = defineEmits(["quote", "jump", "task", "retry", "remember", "author", "mention"]);
// In a group, long-pressing an employee's avatar @mentions it in the composer (mentionAuthor); a tap still opens it.
const pressable = computed(() => props.mentionAuthor && sender.value.kind === "employee");
const exportOpen = ref(false), exportError = ref("");
// Task links show the employee's live task status (the copy stored in the message is a snapshot from when it was written).
// In a group every message carries its author (a user or an employee, avatar filled in by the group view); only the
// viewer's own messages sit on the right. A private chat has no authors: user messages are mine, the rest the employee's.
const mine = computed(() => props.message.role === "user" && (!props.message.author || props.message.author.id === props.viewerId));
const sender = computed(() => props.message.author ? { kind: props.message.author.kind, id: props.message.author.id, name: props.message.author.name, avatar: props.message.author.avatar || "" } : { kind: "employee", id: props.employeeId, name: props.name, avatar: props.avatar });
// A user who picked an avatar color speaks in it (a private chat's own messages carry no author, so the viewer's does).
const tint = computed(() => {
  const hex = parseAvatarColor(props.message.author ? props.message.author.avatar : mine.value ? props.viewerAvatar : "")?.hex;
  if (!hex) return undefined;
  const color = bubbleTint(hex);
  return { background: color.fill, color: color.ink };
});
const statusOf = (task) => props.taskStatus?.[task.id] ?? task.status;
const linkedTask = computed(() => {
  const id = props.message.tasks?.[0]?.id;
  return id ? (props.tasks || []).find((task) => task.id === id) : undefined;
});
// Delivery bubbles stay brief; export always prefers the live task's full result.
// Bubble text stays brief; export always pulls the live task's full result, never the truncated delivery summary.
const exportMarkdown = computed(() => {
  const task = linkedTask.value;
  if (!task) return "";
  return String(task.result || task.completion || "").trim();
});
const archiveBase = computed(() => filesArchiveBase(props.employeeId, linkedTask.value?.id || props.message.tasks?.[0]?.id));
const canExport = computed(() => props.message.delivery && !!exportMarkdown.value);
const exportTitle = computed(() => exportTitleOf(linkedTask.value?.text || props.message.tasks?.[0]?.title));
async function runExport(format) {
  exportError.value = "";
  try {
    await exportResult(format, { title: exportTitle.value, request: linkedTask.value?.text, markdown: exportMarkdown.value, archiveBase: archiveBase.value });
    exportOpen.value = false;
  } catch (error) {
    exportError.value = error?.message || String(error);
  }
}
</script>
<template>
  <article class="chat-message" :class="[mine ? 'user' : 'assistant', { continued, authored: !!message.author }]" :data-message-seq="message.seq" tabindex="-1">
    <span v-if="!mine && continued" class="chat-avatar spacer" aria-hidden="true"></span>
    <button v-else-if="!mine && openAuthor" type="button" class="chat-avatar author-link" :aria-label="'打开和 ' + sender.name + ' 的聊天'" :title="'打开和 ' + sender.name + ' 的聊天'" @click="emit('author', sender.id)"><PressMention :name="sender.name" :disabled="!pressable" @press="emit('mention', $event)"><EmployeeAvatar :employee-id="sender.id" :name="sender.name" :avatar="sender.avatar" :pose="MESSAGE_POSE" /></PressMention></button>
    <span v-else-if="!mine" class="chat-avatar" aria-hidden="true"><UserAvatar v-if="sender.kind === 'user'" :user-id="sender.id" :name="sender.name" :avatar="sender.avatar" /><PressMention v-else :name="sender.name" :disabled="!pressable" @press="emit('mention', $event)"><EmployeeAvatar :employee-id="sender.id" :name="sender.name" :avatar="sender.avatar" :pose="MESSAGE_POSE" /></PressMention></span>
    <div class="chat-content">
      <div class="chat-heading">
        <button v-if="!mine && !continued && openAuthor" type="button" class="author-name" @click="emit('author', sender.id)">{{ sender.name }}</button>
        <strong v-else-if="!mine && !continued">{{ sender.name }}</strong>
        <span v-if="!mine && sender.kind === 'user' && message.author" class="author-tag">用户</span>
        <time v-if="message.at">{{ shortTime(message.at) }}</time>
        <button v-if="quotable && message.seq" type="button" class="chat-reply" aria-label="引用这条消息" title="引用" @click="emit('quote', message)"><Icon name="reply" :size="13" /><span class="reply-label">引用</span></button>
        <button v-if="rememberable && !mine && message.text" type="button" class="chat-reply" aria-label="记住这句" title="记住这句" @click="emit('remember', message)"><Icon name="memory" :size="13" /><span class="reply-label">记住</span></button>
      </div>
      <div class="chat-bubble" :class="{ failed: message.error, tinted: !!tint }" :style="tint" :role="message.error ? 'alert' : undefined">
        <button v-if="message.quote" type="button" class="chat-quote" :aria-label="'跳转到引用的消息：' + message.quote.text" @click="emit('jump', message.quote.seq)"><strong>{{ message.quote.role === 'user' ? '我' : name }}</strong><span>{{ message.quote.text }}</span></button>
        <UserMessage v-if="message.role === 'user' && message.text" :text="message.displayText || message.text" />
        <MessageText v-else-if="message.text" :text="message.displayText || message.text" :streaming="message.streaming" :archive-base="archiveBase" />
        <img v-for="(image, index) in message.images || []" :key="index" :src="image.url || (image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`)" alt="消息附图" />
        <FileCard v-for="(file, index) in message.files || []" :key="'f' + index" :file="file" />
      </div>
      <div v-if="message.sendStatus" class="chat-send-status" role="status">
        <span v-if="message.sendStatus === 'sending'"><span class="spinner" aria-hidden="true"></span>发送中…</span>
        <button v-else-if="message.sendStatus === 'failed'" type="button" :disabled="!quotable" :title="message.sendError" aria-label="重发这条消息" @click="emit('retry', message)">发送未确认 · 点击重发</button>
        <span v-else>已送达</span>
      </div>
      <div v-if="message.tasks?.length" class="chat-tasks">
        <button v-for="task in message.tasks" :key="task.id" type="button" class="chat-task-link" :data-task-id="task.id" :aria-label="'查看任务：' + task.title" @click="emit('task', task.id)">
          <Icon name="tasks" :size="15" /><span class="truncate">{{ task.title }}</span><span v-if="statusOf(task)" :class="['badge', taskTone(statusOf(task))]">{{ taskLabel(statusOf(task)) }}</span><Icon name="right" :size="14" />
        </button>
      </div>
      <div v-if="canExport" class="chat-export">
        <button type="button" class="chat-export-toggle" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen"><Icon name="download" :size="14" />导出完整结果</button>
        <div v-if="exportOpen" class="chat-export-menu" role="menu">
          <button type="button" role="menuitem" @click="runExport('html')">HTML</button>
          <button type="button" role="menuitem" @click="runExport('pdf')">PDF</button>
          <button type="button" role="menuitem" @click="runExport('docx')">DOCX</button>
          <button type="button" role="menuitem" @click="runExport('xlsx')">XLSX</button>
        </div>
        <p v-if="exportError" class="chat-export-error" role="alert">{{ exportError }}</p>
      </div>
    </div>
    <span v-if="mine && message.author" class="chat-avatar" aria-hidden="true"><UserAvatar :user-id="message.author.id" :name="message.author.name" :avatar="message.author.avatar" /></span>
  </article>
</template>
<style scoped>
.chat-message { display: flex; align-items: flex-start; gap: var(--chat-gap); margin: 0 0 16px; min-width: 0; outline: none; }
.chat-message.user { justify-content: flex-end; }
/* Follow-up bubbles of one reply run sit tight under the first, without repeating avatar and name. */
.chat-message.continued { margin-top: -10px; }
.chat-avatar.spacer { height: 0; background: none; }
.chat-avatar { display: grid; place-items: center; flex: none; width: var(--chat-avatar); height: var(--chat-avatar); overflow: hidden; border-radius: 12px; background: var(--accent-soft); color: var(--accent-text); font-size: 16px; font-weight: 600; }
/* One shrinkable column: grid items default to an automatic minimum of their min-content width, so a single
   nowrap child (a long task title, URL or code line) would otherwise widen the track past the screen. */
.chat-content { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; max-width: min(100% - var(--chat-avatar) - var(--chat-gap), 680px); }
.chat-content > * { min-width: 0; }
.user .chat-content { justify-items: end; max-width: min(85%, 620px); }
.user .chat-content > * { max-width: 100%; }
.chat-heading { display: flex; align-items: center; gap: 8px; min-height: 20px; color: var(--muted); font-size: 11px; }
.chat-heading strong { color: var(--text-2); font-size: 12px; font-weight: 600; }
.author-tag { padding: 0 6px; border-radius: 999px; background: var(--surface-3); color: var(--muted); font-size: 11px; }
.chat-send-status { color: var(--muted); font-size: 11px; }
.chat-send-status > span { display: flex; align-items: center; gap: 5px; }
.chat-send-status .spinner { width: 11px; height: 11px; }
.chat-send-status button { min-height: 28px; padding: 2px 4px; border: 0; background: transparent; color: var(--danger); font-size: 12px; }
.chat-reply { gap: 3px; min-height: 20px; padding: 0 4px; border: 0; background: transparent; color: var(--muted); font-size: 11px; font-weight: 400; opacity: 0; }
.chat-message:hover .chat-reply, .chat-reply:focus-visible { opacity: 1; }
.chat-reply:hover:not(:disabled) { background: var(--surface-2); color: var(--accent); }
.chat-bubble { min-width: 0; padding: 9px 13px; border-radius: 4px 14px 14px 14px; background: var(--surface-2); line-height: 1.65; overflow-wrap: anywhere; }
.user .chat-bubble { border-radius: 14px 4px 14px 14px; background: var(--accent-soft); color: #13254f; }
/* A chosen avatar color fills the bubble (inline); mentions keep the text readable instead of blue-on-blue. */
.chat-bubble.tinted :deep(.mention) { color: inherit; text-decoration: underline; }
.chat-bubble.failed { background: var(--danger-soft); box-shadow: inset 3px 0 var(--danger); }
.chat-message:focus .chat-bubble { outline: 2px solid var(--accent); outline-offset: 2px; }
.chat-bubble :deep(.message-text) { font-size: 14px; }
.chat-bubble :deep(.code-block) { margin-left: -4px; margin-right: -4px; }
.author-link { padding: 0; border: 0; cursor: pointer; }
.author-link:hover:not(:disabled) { background: var(--accent-soft); filter: brightness(1.05); }
.author-name { height: auto; min-height: 0; padding: 0; border: 0; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 600; }
.author-name:hover:not(:disabled) { background: transparent; color: var(--accent-text); text-decoration: underline; }
.chat-bubble img { display: block; max-width: 100%; max-height: 360px; margin-top: 6px; border-radius: var(--r-md); }
.chat-quote { display: grid; justify-content: stretch; justify-items: start; gap: 1px; width: 100%; height: auto; min-height: 0; margin: 0 0 6px; padding: 4px 8px; border: 0; border-left: 2px solid var(--accent); border-radius: 2px 6px 6px 2px; background: rgb(255 255 255 / 60%); color: var(--text-2); font-weight: 400; text-align: left; white-space: normal; }
.chat-quote strong { font-size: 11px; }
.chat-quote span { display: -webkit-box; overflow: hidden; font-size: 12px; line-height: 1.5; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.chat-tasks { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; width: 100%; min-width: 0; }
.chat-task-link { justify-content: flex-start; gap: 8px; width: 100%; min-width: 0; max-width: min(100%, 440px); height: auto; min-height: 36px; padding: 6px 8px 6px 10px; border-color: var(--border); background: var(--surface); font-weight: 500; text-align: left; }
.chat-task-link > .icon-svg:first-child { color: var(--accent); }
.chat-task-link > .truncate { flex: 1; min-width: 0; }
.chat-task-link > .badge, .chat-task-link > .icon-svg { flex: none; }
.chat-task-link > .icon-svg:last-child { color: var(--faint); }
.chat-task-link:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-softer); }
.chat-export { display: grid; justify-items: start; gap: 4px; width: 100%; }
.chat-export-toggle { gap: 6px; min-height: 30px; padding: 0 8px; border-color: var(--border); background: var(--surface); color: var(--text-2); font-size: 12px; font-weight: 500; }
.chat-export-toggle:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-softer); color: var(--accent); }
.chat-export-menu { display: flex; flex-wrap: wrap; gap: 4px; }
.chat-export-menu button { min-height: 28px; padding: 0 10px; border-color: var(--border); background: var(--surface); font-size: 12px; }
.chat-export-error { margin: 0; color: var(--danger); font-size: 12px; }
.chat-bubble :deep(.markdown-table) { max-width: 100%; }
.chat-bubble :deep(.markdown-body img) { max-width: 100%; max-height: 360px; height: auto; }
@media (hover: none) { .chat-reply { opacity: .7; } .reply-label { display: none; } }
@media (max-width: 767px) {
  .chat-message { margin-bottom: 14px; }
  .user .chat-content { max-width: 88%; }
  .chat-reply { min-height: 28px; padding: 0 6px; }
}
</style>
