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
.chat-message {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin: 0 0 var(--space-5);
  min-width: 0;
  outline: none;
}

.chat-message.user {
  flex-direction: row-reverse;
}

.chat-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-lg);
  color: var(--accent);
  background: var(--accent-light);
  font-size: 0.875rem;
  font-weight: 700;
  margin-top: var(--space-6);
  flex-shrink: 0;
}

.user .chat-avatar {
  color: var(--text-secondary);
  background: var(--bg-sunken);
}

.chat-message-content {
  min-width: 0;
  max-width: min(calc(100% - 48px), 680px);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chat-message-heading {
  display: flex;
  gap: var(--space-3);
  justify-content: space-between;
  align-items: center;
  color: var(--text-tertiary);
  font-size: 0.8125rem;
  font-weight: 500;
  min-height: var(--space-6);
}

.user .chat-message-heading {
  flex-direction: row-reverse;
}

.chat-reply {
  font-size: 0.8125rem;
  padding: var(--space-1) var(--space-2);
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  min-height: var(--space-6);
  border-radius: var(--radius-sm);
  transition: all var(--duration-base) var(--ease-out);
}

.chat-reply:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-light);
}

.chat-bubble {
  min-width: 0;
  padding: var(--space-4) var(--space-4);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm) var(--radius-xl) var(--radius-xl) var(--radius-xl);
  background: var(--bg-elevated);
  line-height: 1.7;
  overflow-wrap: anywhere;
  font-size: 0.9375rem;
  box-shadow: var(--shadow-xs);
  transition: all var(--duration-base) var(--ease-out);
}

.user .chat-bubble {
  border-radius: var(--radius-xl) var(--radius-sm) var(--radius-xl) var(--radius-xl);
  background: var(--accent-medium);
  border-color: var(--accent-medium);
  color: var(--text-primary);
}

.chat-bubble.failed {
  border-color: var(--error-500);
  background: var(--error-50);
}

.chat-message:focus .chat-bubble {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.chat-bubble :deep(.markdown-body > :first-child) {
  margin-top: 0;
}

.chat-bubble :deep(.markdown-body > :last-child) {
  margin-bottom: 0;
}

.chat-bubble img {
  max-width: 100%;
  height: auto;
  max-height: 400px;
  object-fit: contain;
  border-radius: var(--radius-lg);
  margin-top: var(--space-3);
  box-shadow: var(--shadow-sm);
}

.chat-quote {
  display: grid;
  gap: var(--space-1);
  width: 100%;
  min-height: 44px;
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  text-align: left;
  transition: all var(--duration-base) var(--ease-out);
}

.chat-quote:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.chat-quote strong {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.chat-quote > span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
  color: var(--text-tertiary);
}

.chat-quote small {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.chat-task-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  margin-top: var(--space-3);
  padding: var(--space-3) 0 0;
  border: 0;
  border-top: 1px solid var(--border-light);
  border-radius: 0;
  background: transparent;
  color: var(--accent);
  text-align: left;
  font-size: 0.875rem;
  font-weight: 500;
  min-height: 40px;
  transition: color var(--duration-base) var(--ease-out);
}

.chat-task-link:hover:not(:disabled) {
  color: var(--accent-hover);
}

.chat-task-link span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.chat-task-link span:last-child {
  flex-shrink: 0;
}

@media (max-width: 768px), (pointer: coarse) {
  .chat-message {
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .chat-avatar {
    width: 32px;
    height: 32px;
    margin-top: var(--space-10);
    font-size: 0.8125rem;
  }

  .chat-message-content {
    max-width: calc(100% - 40px);
  }

  .chat-bubble {
    padding: var(--space-3);
    font-size: 1rem;
  }

  .chat-reply {
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
  }

  .chat-task-link {
    min-height: 44px;
  }
}
</style>
