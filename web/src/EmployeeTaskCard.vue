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
.work-item { padding: 20px 22px; margin-bottom: 14px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); overflow-wrap: anywhere; }
.work-item.highlighted, .work-item:focus { outline: 2px solid var(--accent); outline-offset: 3px; }
.work-item.attention { border-color: oklch(0.86 0.08 75); }
.work-meta { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
.work-meta time { margin-left: auto; font-size: 11px; }
.work-status { color: var(--text-secondary); font-weight: 600; }
.work-status span { font-size: 8px; vertical-align: middle; }
.work-status.running, .work-status.recovering { color: var(--accent); }
.work-status.waiting, .work-status.approval { color: var(--amber); }
.work-status.done { color: var(--green); }
h3 { font-size: 15px; line-height: 1.65; margin: 12px 0 8px; white-space: pre-wrap; }
.work-update { font-size: 13px; color: var(--text-secondary); line-height: 1.65; margin: 8px 0 14px; }
.work-progress { display: flex; gap: 12px; align-items: center; margin: 16px 0; }
progress { width: 100%; height: 5px; border: none; accent-color: var(--accent); border-radius: 4px; }
progress::-webkit-progress-bar { background: var(--surface-sunken); border-radius: 4px; }
progress::-webkit-progress-value { background: var(--accent); border-radius: 4px; }
.work-progress span { color: var(--muted); font-size: 11px; }
.work-attention { background: var(--amber-soft); padding: 16px; margin: 16px 0; border-radius: 10px; }
.work-attention p { white-space: pre-wrap; line-height: 1.65; font-size: 13px; }
.answer-label { display: grid; gap: 7px; font-size: 12px; }
.answer-label textarea { width: 100%; min-width: 0; }
.work-attention > button { margin-top: 10px; }
.work-details { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 16px; }
.work-details summary { color: var(--text-secondary); font-size: 12px; cursor: pointer; min-height: 28px; }
.work-plan { padding: 0; list-style: none; font-size: 13px; }
.work-plan li { display: flex; align-items: baseline; gap: 12px; margin: 10px 0; }
.work-plan span { flex: none; color: var(--muted); font-size: 11px; }
.work-plan .completed { color: var(--green); }
.work-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
.work-actions button { min-height: 36px; font-size: 12px; }
.work-footer { justify-content: flex-end; }
.danger-text { color: var(--red); }
@media (max-width: 600px) { .work-item { padding: 16px; } .work-actions button, summary { min-height: 44px; } .work-meta time { font-size: 10px; } }
</style>
