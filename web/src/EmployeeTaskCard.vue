<script setup vapor>
import { computed, ref } from "vue";
import MessageText from "./MessageText.vue";
import { formatBeijing } from "../../shared/time";
const props = defineProps({ task: Object, act: Function, readonly: Boolean, highlighted: Boolean });
const emit = defineEmits(["inspect"]);
const busy = ref(false), answer = ref("");
const labels = { queued: "排队中", running: "执行中", recovering: "自动恢复中", deferred: "等待外部结果", waiting: "待补充", approval: "待审批", done: "已完成", failed: "失败", stopped: "已停止", cancelled: "已取消", pending: "待执行", in_progress: "进行中", completed: "已验证", blocked: "受阻" };
const ended = computed(() => ["done", "failed", "stopped", "cancelled"].includes(props.task.status));
const progress = computed(() => props.task.plan?.length ? Math.round(props.task.plan.filter((step) => step.status === "completed").length / props.task.plan.length * 100) : 0);
async function run(action) {
  if (busy.value) return;
  busy.value = true;
  try { if (await props.act(action, answer.value) === true) answer.value = ""; }
  finally { busy.value = false; }
}
</script>
<template>
  <article class="work-item" :data-task-id="task.id" tabindex="-1" :class="{ attention: ['waiting', 'approval'].includes(task.status), highlighted }" :aria-busy="busy">
    <div class="work-meta"><span class="work-status" :class="task.status"><span aria-hidden="true">●</span> {{ labels[task.status] || task.status }}</span><span v-if="task.dutyId">职责触发</span><span class="work-location">{{ task.execution?.localAgent ? '客户端 · ' + (task.execution.clientName || '已绑定设备') : '服务端' }}</span><time>{{ formatBeijing(task.createdAt) }}</time></div>
    <h3>{{ task.text }}</h3>
    <p v-if="task.progress?.length" class="work-update">{{ task.progress.at(-1).text }}</p>
    <div v-if="task.plan?.length" class="work-progress"><progress :value="progress" max="100" :aria-label="`任务进度 ${progress}%`"></progress><span>{{ progress }}%</span></div>
    <section v-if="task.status === 'approval'" class="work-attention"><strong>需要你确认</strong><p>{{ task.approval }}</p><div v-if="!readonly" class="work-actions"><button class="primary" :disabled="busy" @click="run('approve')">批准执行</button><button :disabled="busy" @click="run('reject')">驳回</button></div></section>
    <form v-if="task.status === 'waiting'" class="work-attention" @submit.prevent="run('answer')"><strong>需要补充信息</strong><p>{{ task.waiting }}</p><label v-if="!readonly" class="answer-label">你的回复<textarea v-model="answer" rows="2" maxlength="8000" required placeholder="补充信息后，员工会继续原任务"></textarea></label><button v-if="!readonly" class="primary" :disabled="busy || !answer.trim()">回复并继续</button></form>
    <details class="work-details" :open="highlighted"><summary>查看进度与结果</summary>
      <ol v-if="task.plan?.length" class="work-plan"><li v-for="(step, index) in task.plan" :key="index"><span :class="step.status">{{ labels[step.status] }}</span>{{ step.content }}</li></ol>
      <p v-if="task.recovery?.attempts" class="hint">自动恢复 {{ task.recovery.attempts }} 次 · {{ task.recovery.reason }}</p>
      <p v-if="task.checkpoint" class="hint">恢复点：{{ task.checkpoint }}</p>
      <MessageText v-if="task.result" :text="task.result" />
      <p v-if="!task.result && !task.plan?.length && !task.checkpoint" class="hint">员工开工后，进度会更新在这里。</p>
      <div class="work-actions"><button v-if="task.workSession" @click="emit('inspect', task.workSession)">执行记录 ↗</button><button v-if="task.computerSession" @click="emit('inspect', task.computerSession)">浏览器记录 ↗</button><button v-if="ended && !readonly" :disabled="busy" @click="run('redispatch')">重新派发</button><button v-if="ended && !readonly" class="danger-text" :disabled="busy" @click="run('remove')">删除记录</button></div>
    </details>
    <div v-if="!readonly && (!ended || ['failed', 'stopped', 'cancelled'].includes(task.status))" class="work-actions work-footer"><button v-if="task.status === 'running'" :disabled="busy" @click="run('stop')">停止任务</button><button v-else-if="!ended" :disabled="busy" @click="run('stop')">暂停任务</button><button v-if="['failed', 'stopped', 'cancelled'].includes(task.status)" class="primary" :disabled="busy" @click="run('resume')">继续任务</button><span v-if="task.status === 'deferred'" class="hint">无需等待，员工会按恢复点继续检查。</span></div>
  </article>
</template>
<style scoped>
.work-item {
  padding: var(--space-6) var(--space-5);
  margin-bottom: var(--space-4);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  overflow-wrap: anywhere;
  transition: all var(--duration-base) var(--ease-out);
}

.work-item:hover {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-sm);
}

.work-item.highlighted,
.work-item:focus {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.work-item.attention {
  border-color: var(--warning-500);
  background: var(--warning-50);
}

.work-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-tertiary);
  font-size: 0.875rem;
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.work-meta time {
  margin-left: auto;
  font-size: 0.8125rem;
}

.work-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.875rem;
}

.work-status span {
  font-size: 8px;
  line-height: 1;
}

.work-status.running,
.work-status.recovering {
  color: var(--accent);
}

.work-status.waiting,
.work-status.approval {
  color: var(--warning-600);
}

.work-status.done {
  color: var(--success-600);
}

.work-status.failed,
.work-status.stopped {
  color: var(--error-500);
}

h3 {
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.6;
  margin: var(--space-3) 0 var(--space-2);
  white-space: pre-wrap;
  color: var(--text-primary);
}

.work-update {
  font-size: 0.9375rem;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: var(--space-2) 0 var(--space-4);
}

.work-progress {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin: var(--space-4) 0;
}

progress {
  flex: 1;
  height: 8px;
  border: none;
  accent-color: var(--accent);
  border-radius: var(--radius-full);
  background: var(--bg-sunken);
}

progress::-webkit-progress-bar {
  background: var(--bg-sunken);
  border-radius: var(--radius-full);
}

progress::-webkit-progress-value {
  background: var(--accent);
  border-radius: var(--radius-full);
}

progress::-moz-progress-bar {
  background: var(--accent);
  border-radius: var(--radius-full);
}

.work-progress span {
  color: var(--text-tertiary);
  font-size: 0.875rem;
  font-weight: 600;
  flex-shrink: 0;
}

.work-attention {
  background: var(--warning-50);
  border: 1px solid var(--warning-200);
  padding: var(--space-4);
  margin: var(--space-4) 0;
  border-radius: var(--radius-lg);
}

.work-attention strong {
  display: block;
  color: var(--warning-700);
  font-size: 0.9375rem;
  font-weight: 600;
  margin-bottom: var(--space-2);
}

.work-attention p {
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 0.9375rem;
  color: var(--warning-700);
  margin: var(--space-2) 0;
}

.answer-label {
  display: grid;
  gap: var(--space-2);
  font-size: 0.875rem;
  margin-top: var(--space-3);
  color: var(--warning-700);
  font-weight: 500;
}

.answer-label textarea {
  width: 100%;
  min-width: 0;
  min-height: 80px;
}

.work-attention > button {
  margin-top: var(--space-3);
}

.work-details {
  border-top: 1px solid var(--border-light);
  padding-top: var(--space-4);
  margin-top: var(--space-4);
}

.work-details summary {
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  min-height: 40px;
  display: flex;
  align-items: center;
  user-select: none;
  transition: background var(--duration-base) var(--ease-out);
}

.work-details summary:hover {
  background: var(--bg-secondary);
}

.work-details[open] summary {
  margin-bottom: var(--space-3);
}

.work-plan {
  padding: 0;
  margin: var(--space-3) 0;
  list-style: none;
  font-size: 0.9375rem;
}

.work-plan li {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin: var(--space-2) 0;
  line-height: 1.6;
}

.work-plan span {
  flex: none;
  color: var(--text-tertiary);
  font-size: 0.8125rem;
  font-weight: 500;
  min-width: 64px;
}

.work-plan .completed {
  color: var(--success-600);
}

.work-plan .in_progress,
.work-plan .pending {
  color: var(--accent);
}

.work-plan .blocked {
  color: var(--error-500);
}

.work-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
  align-items: center;
}

.work-actions button {
  min-height: 36px;
  font-size: 0.875rem;
}

.work-footer {
  justify-content: flex-end;
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-light);
}

.danger-text {
  color: var(--error-500);
  background: transparent;
  border: none;
  font-weight: 500;
}

.danger-text:hover:not(:disabled) {
  background: var(--error-50);
}

@media (max-width: 768px), (pointer: coarse) {
  .work-item {
    padding: var(--space-4);
  }

  .work-actions button,
  summary {
    min-height: 44px !important;
  }

  .work-meta time {
    font-size: 0.75rem;
  }

  h3 {
    font-size: 0.9375rem;
  }
}
</style>
