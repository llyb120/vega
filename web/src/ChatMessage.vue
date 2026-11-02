<script setup vapor>
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import Icon from "./Icon.vue";
import { taskLabel, taskTone, shortTime } from "./task-status";
const props = defineProps({ message: Object, name: String, avatar: String, employeeId: String, quotable: Boolean });
const emit = defineEmits(["quote", "jump", "task"]);
</script>
<template>
  <article class="chat-message" :class="message.role" :data-message-seq="message.seq" tabindex="-1">
    <span v-if="message.role !== 'user'" class="chat-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="employeeId" :name="name" :avatar="avatar" /></span>
    <div class="chat-content">
      <div class="chat-heading">
        <strong v-if="message.role !== 'user'">{{ name }}</strong>
        <time v-if="message.at">{{ shortTime(message.at) }}</time>
        <button v-if="quotable && message.seq" type="button" class="chat-reply" aria-label="引用这条消息" title="引用" @click="emit('quote', message)"><Icon name="reply" :size="13" /><span class="reply-label">引用</span></button>
      </div>
      <div class="chat-bubble" :class="{ failed: message.error }" :role="message.error ? 'alert' : undefined">
        <button v-if="message.quote" type="button" class="chat-quote" :aria-label="'跳转到引用的消息：' + message.quote.text" @click="emit('jump', message.quote.seq)"><strong>{{ message.quote.role === 'user' ? '我' : name }}</strong><span>{{ message.quote.text }}</span></button>
        <UserMessage v-if="message.role === 'user' && message.text" :text="message.displayText || message.text" />
        <MessageText v-else-if="message.text" :text="message.displayText || message.text" />
        <img v-for="(image, index) in message.images || []" :key="index" :src="image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`" alt="消息附图" />
      </div>
      <div v-if="message.tasks?.length" class="chat-tasks">
        <button v-for="task in message.tasks" :key="task.id" type="button" class="chat-task-link" :data-task-id="task.id" :aria-label="'查看任务：' + task.title" @click="emit('task', task.id)">
          <Icon name="tasks" :size="15" /><span class="truncate">{{ task.title }}</span><span v-if="task.status" :class="['badge', taskTone(task.status)]">{{ taskLabel(task.status) }}</span><Icon name="right" :size="14" />
        </button>
      </div>
    </div>
  </article>
</template>
<style scoped>
.chat-message { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 16px; min-width: 0; outline: none; }
.chat-message.user { justify-content: flex-end; }
.chat-avatar { display: grid; place-items: center; flex: none; width: 28px; height: 28px; margin-top: 2px; overflow: hidden; border-radius: 8px; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; }
/* One shrinkable column: grid items default to an automatic minimum of their min-content width, so a single
   nowrap child (a long task title, URL or code line) would otherwise widen the track past the screen. */
.chat-content { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; max-width: min(100% - 38px, 680px); }
.chat-content > * { min-width: 0; }
.user .chat-content { justify-items: end; max-width: min(85%, 620px); }
.user .chat-content > * { max-width: 100%; }
.chat-heading { display: flex; align-items: center; gap: 8px; min-height: 20px; color: var(--muted); font-size: 11px; }
.chat-heading strong { color: var(--text-2); font-size: 12px; font-weight: 600; }
.chat-reply { gap: 3px; min-height: 20px; padding: 0 4px; border: 0; background: transparent; color: var(--muted); font-size: 11px; font-weight: 400; opacity: 0; }
.chat-message:hover .chat-reply, .chat-reply:focus-visible { opacity: 1; }
.chat-reply:hover:not(:disabled) { background: var(--surface-2); color: var(--accent); }
.chat-bubble { min-width: 0; padding: 9px 13px; border-radius: 4px 14px 14px 14px; background: var(--surface-2); line-height: 1.65; overflow-wrap: anywhere; }
.user .chat-bubble { border-radius: 14px 4px 14px 14px; background: var(--accent-soft); color: #13254f; }
.chat-bubble.failed { background: var(--danger-soft); box-shadow: inset 3px 0 var(--danger); }
.chat-message:focus .chat-bubble { outline: 2px solid var(--accent); outline-offset: 2px; }
.chat-bubble :deep(.message-text) { font-size: 14px; }
.chat-bubble :deep(.code-block) { margin-left: -4px; margin-right: -4px; }
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
@media (hover: none) { .chat-reply { opacity: .7; } .reply-label { display: none; } }
@media (max-width: 767px) {
  .chat-message { gap: 8px; margin-bottom: 14px; }
  .chat-content { max-width: calc(100% - 36px); }
  .user .chat-content { max-width: 88%; }
  .chat-reply { min-height: 28px; padding: 0 6px; }
}
</style>
