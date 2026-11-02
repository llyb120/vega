<script setup vapor>
import MessageText from "./MessageText.vue";
import UserMessage from "./UserMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
const props = defineProps({ message: Object, name: String, avatar: String, employeeId: String, quotable: Boolean });
const emit = defineEmits(["quote", "jump", "task"]);
</script>
<template>
  <article class="chat-message" :class="message.role" :data-message-seq="message.seq" tabindex="-1">
    <span class="chat-avatar" aria-hidden="true"><span v-if="message.role === 'user'">我</span><EmployeeAvatar v-else :employee-id="employeeId" :name="name" :avatar="avatar" /></span>
    <div class="chat-message-content">
      <div class="chat-message-heading"><span>{{ message.role === 'user' ? '我' : name }}</span><button v-if="quotable && message.seq" type="button" class="chat-reply" aria-label="引用这条消息" @click="emit('quote', message)">引用</button></div>
      <div class="chat-bubble" :class="{ failed: message.error }" :role="message.error ? 'alert' : undefined">
        <button v-if="message.quote" type="button" class="chat-quote" :aria-label="'跳转到引用的消息：' + message.quote.text" @click="emit('jump', message.quote.seq)"><strong>{{ message.quote.role === 'user' ? '我' : name }}</strong><span>{{ message.quote.text }}</span><small>查看原消息 ↗</small></button>
        <UserMessage v-if="message.role === 'user' && message.text" :text="message.displayText || message.text" />
        <MessageText v-else-if="message.text" :text="message.displayText || message.text" />
        <img v-for="(image, index) in message.images || []" :key="index" :src="image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`" alt="消息附图" />
        <button v-for="task in message.tasks || []" :key="task.id" type="button" class="chat-task-link" :data-task-id="task.id" :aria-label="'查看任务：' + task.title" @click="emit('task', task.id)"><span>任务 · {{ task.title }}</span><span aria-hidden="true">↗</span></button>
      </div>
    </div>
  </article>
</template>
<style scoped>
.chat-message { display: flex; align-items: flex-start; gap: 9px; margin: 0 0 18px; min-width: 0; outline: none; }
.chat-message.user { flex-direction: row-reverse; }
.chat-avatar { display: grid; place-items: center; flex: none; width: 32px; height: 34px; border-radius: 10px; color: var(--accent); background: var(--accent-soft); font-size: 13px; font-weight: 650; margin-top: 24px; }
.user .chat-avatar { color: var(--text-secondary); background: var(--surface-sunken); }
.chat-message-content { min-width: 0; max-width: min(calc(100% - 44px), 680px); }
.chat-message-heading { display: flex; gap: 14px; justify-content: space-between; align-items: center; color: var(--muted); font-size: 11px; min-height: 24px; }
.user .chat-message-heading { flex-direction: row-reverse; }
.chat-reply { font-size: 11px; padding: 0 4px; border: 0; background: transparent; color: var(--muted); min-height: 24px; }
.chat-reply:hover { color: var(--accent); }
.chat-bubble { min-width: 0; padding: 12px 15px; border: 1px solid var(--border); border-radius: 4px 14px 14px; background: var(--surface-sunken); line-height: 1.7; overflow-wrap: anywhere; }
.user .chat-bubble { border-radius: 14px 4px 14px 14px; background: var(--accent-soft); border-color: transparent; }
.chat-bubble.failed { border-color: var(--red); }
.chat-message:focus .chat-bubble { outline: 2px solid var(--accent); outline-offset: 3px; }
.chat-bubble :deep(.markdown-body > :first-child) { margin-top: 0; }
.chat-bubble :deep(.markdown-body > :last-child) { margin-bottom: 0; }
.chat-bubble img { max-width: 100%; height: auto; max-height: 400px; object-fit: contain; border-radius: 8px; }
.chat-quote { display: grid; gap: 3px; width: 100%; min-height: 44px; margin: 0 0 10px; padding: 8px 10px; border: 0; border-left: 3px solid var(--border-strong); border-radius: 5px; background: var(--surface); color: var(--text-secondary); text-align: left; }
.chat-quote strong { font-size: 11px; }
.chat-quote > span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.chat-quote small { font-size: 10px; color: var(--muted); }
.chat-task-link { display: flex; justify-content: space-between; gap: 12px; width: 100%; margin-top: 10px; padding: 9px 0 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent; color: var(--accent); text-align: left; font-size: 12px; min-height: 36px; }
.chat-task-link span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) { .chat-message { gap: 7px; margin-bottom: 12px; } .chat-avatar { width: 28px; height: 30px; margin-top: 44px; } .chat-message-content { max-width: calc(100% - 35px); } .chat-bubble { padding: 10px 12px; } .chat-reply { min-height: 44px; padding: 0 10px; } .chat-task-link { min-height: 44px; } }
</style>
