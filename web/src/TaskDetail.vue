<script setup vapor>
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import MessageText from "./MessageText.vue";
import { formatBeijing } from "../../shared/time";
import { taskLabel, taskTone, isEnded, planProgress } from "./task-status";
import { exportResult } from "./export-result.js";
const props = defineProps({ task: Object, act: Function, readonly: Boolean, back: Boolean, saveMemory: Function });
const emit = defineEmits(["inspect", "back"]);
const busy = ref(false), answer = ref(""), exportOpen = ref(false), exportError = ref(""), settleSelected = ref([]), settling = ref(false);
const suggestions = computed(() => props.task.memorySuggestions || []);
watch(() => props.task.id, () => { answer.value = ""; exportOpen.value = false; exportError.value = ""; });
watch(suggestions, (rows) => { settleSelected.value = rows.map((item) => item.id); }, { immediate: true });
function toggleSettle(id) {
  settleSelected.value = settleSelected.value.includes(id) ? settleSelected.value.filter((x) => x !== id) : [...settleSelected.value, id];
}
async function settleMemories() {
  if (!props.saveMemory || settling.value || !settleSelected.value.length) return;
  settling.value = true;
  try {
    for (const item of suggestions.value.filter((row) => settleSelected.value.includes(row.id))) {
      await props.saveMemory({
        id: item.id,
        claim: item.claim,
        memoryKind: item.kind,
        source: "ui",
      });
    }
  } finally { settling.value = false; }
}
const ended = computed(() => isEnded(props.task.status));
const resumable = computed(() => ["failed", "stopped", "cancelled"].includes(props.task.status));
const progress = computed(() => planProgress(props.task.plan));
const stepIcon = { completed: "check", in_progress: "play", blocked: "alert" };
const exportMarkdown = computed(() => String(props.task.result || props.task.completion || props.task.summary || "").trim());
const canExport = computed(() => !!exportMarkdown.value);
function runExport(format) {
  exportError.value = "";
  try {
    exportResult(format, { title: props.task.text || "任务结果", markdown: exportMarkdown.value });
    exportOpen.value = false;
  } catch (error) {
    exportError.value = error?.message || String(error);
  }
}
async function run(action) {
  if (busy.value) return;
  busy.value = true;
  try { if (await props.act(action, answer.value) === true) answer.value = ""; }
  finally { busy.value = false; }
}
</script>
<template>
  <article class="task-detail" :data-task-id="task.id" tabindex="-1" :aria-busy="busy">
    <button v-if="back" type="button" class="ghost sm detail-back" @click="emit('back')"><Icon name="back" :size="16" />全部任务</button>
    <header class="detail-head">
      <div class="detail-badges">
        <span :class="['badge', taskTone(task.status)]"><span :class="['dot', taskTone(task.status), { pulse: task.status === 'running' }]" aria-hidden="true"></span>{{ taskLabel(task.status) }}</span>
        <span v-if="task.dutyId" class="badge"><Icon name="repeat" :size="12" />职责触发</span>
        <span class="badge"><Icon :name="task.execution?.localAgent ? 'laptop' : 'server'" :size="12" />{{ task.execution?.localAgent ? '客户端 · ' + (task.execution.clientName || '已绑定设备') : '服务端' }}</span>
        <time class="detail-time">{{ formatBeijing(task.createdAt) }}</time>
      </div>
      <h2 class="sr-only">任务详情</h2>
      <MessageText :text="task.text" />
      <p v-if="task.status === 'queued' && task.queueReason" class="detail-note" role="status"><Icon name="clock" :size="14" />{{ task.queueReason }}</p>
    </header>

    <section v-if="task.status === 'approval'" class="attention-block">
      <h3><Icon name="alert" :size="16" />需要你确认</h3>
      <MessageText :text="task.approval" />
      <div v-if="!readonly" class="actions"><button type="button" class="primary" :disabled="busy" @click="run('approve')"><Icon name="check" :size="16" />批准执行</button><button type="button" :disabled="busy" @click="run('reject')">驳回</button></div>
    </section>
    <form v-if="task.status === 'waiting'" class="attention-block" @submit.prevent="run('answer')">
      <h3><Icon name="alert" :size="16" />需要补充信息</h3>
      <MessageText :text="task.waiting" />
      <template v-if="!readonly"><label class="sr-only" :for="'answer-' + task.id">你的回复</label><textarea :id="'answer-' + task.id" v-model="answer" rows="3" maxlength="8000" required placeholder="补充信息后，牛马会继续原任务"></textarea><div class="actions end"><button class="primary" :disabled="busy || !answer.trim()">回复并继续</button></div></template>
    </form>

    <section v-if="task.progress?.length" class="detail-section">
      <h3>最新进展</h3>
      <MessageText class="progress-latest" :text="task.progress.at(-1).text" />
      <details v-if="task.progress.length > 1" class="progress-history"><summary>全部进展（{{ task.progress.length }}）</summary><ol><li v-for="(item, i) in task.progress" :key="i"><MessageText :text="item.text" /></li></ol></details>
    </section>

    <section v-if="progress" class="detail-section">
      <h3>执行计划<span class="plan-count">{{ progress.done }}/{{ progress.total }}</span></h3>
      <div class="plan-bar" role="progressbar" :aria-valuenow="progress.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`任务进度 ${progress.percent}%`"><span :style="{ width: progress.percent + '%' }"></span></div>
      <ol class="plan">
        <li v-for="(step, index) in task.plan" :key="index" :class="step.status"><span class="step-mark" :title="taskLabel(step.status)"><Icon v-if="stepIcon[step.status]" :name="stepIcon[step.status]" :size="12" /></span><span>{{ step.content }}</span></li>
      </ol>
    </section>

    <section v-if="task.result" class="detail-section">
      <div class="result-head">
        <h3>{{ task.status === 'failed' ? '失败原因' : '结果' }}</h3>
        <div v-if="canExport" class="result-export">
          <button type="button" class="ghost sm" :aria-expanded="exportOpen" @click="exportOpen = !exportOpen"><Icon name="download" :size="14" />导出</button>
          <div v-if="exportOpen" class="result-export-menu" role="menu">
            <button type="button" role="menuitem" @click="runExport('html')">HTML</button>
            <button type="button" role="menuitem" @click="runExport('pdf')">PDF</button>
            <button type="button" role="menuitem" @click="runExport('docx')">DOCX</button>
            <button type="button" role="menuitem" @click="runExport('xlsx')">XLSX</button>
          </div>
        </div>
      </div>
      <p v-if="exportError" class="export-error" role="alert">{{ exportError }}</p>
      <div class="result-box" :class="{ failed: task.status === 'failed' }"><MessageText :text="task.result" /></div>
    </section>

    <section v-if="!readonly && task.status === 'done' && suggestions.length && saveMemory" class="detail-section settle">
      <h3>沉淀为记忆</h3>
      <p class="detail-note">勾选跨任务仍有用的稳定主张，确认后写入记忆库。</p>
      <ul class="settle-list">
        <li v-for="item in suggestions" :key="item.id">
          <label><input type="checkbox" :checked="settleSelected.includes(item.id)" @change="toggleSettle(item.id)" />
            <span class="settle-kind">{{ item.kind }}</span>
            <span>{{ item.claim }}</span>
            <em v-if="item.status === 'draft'">待确认</em>
          </label>
        </li>
      </ul>
      <div class="actions"><button type="button" class="primary sm" :disabled="settling || !settleSelected.length" @click="settleMemories">写入所选记忆</button></div>
    </section>

    <section v-if="task.recovery?.attempts || task.checkpoint" class="detail-section meta-list">
      <p v-if="task.recovery?.attempts"><Icon name="refresh" :size="14" />自动恢复 {{ task.recovery.attempts }} 次 · {{ task.recovery.reason }}</p>
      <p v-if="task.checkpoint"><Icon name="clock" :size="14" />恢复点：{{ task.checkpoint }}</p>
    </section>
    <p v-if="!task.result && !task.plan?.length && !task.checkpoint && !task.progress?.length && !['approval', 'waiting'].includes(task.status)" class="detail-note">牛马开工后，进度会更新在这里。</p>

    <footer class="detail-foot">
      <button v-if="task.workSession" type="button" @click="emit('inspect', task.workSession)"><Icon name="code" :size="15" />执行记录</button>
      <button v-if="task.computerSession" type="button" @click="emit('inspect', task.computerSession)"><Icon name="globe" :size="15" />浏览器记录</button>
      <span class="spacer"></span>
      <span v-if="task.status === 'deferred'" class="hint">无需等待，牛马会按恢复点继续检查。</span>
      <template v-if="!readonly">
        <button v-if="task.status === 'running'" type="button" :disabled="busy" @click="run('stop')"><Icon name="stop" :size="14" />停止任务</button>
        <button v-else-if="!ended" type="button" :disabled="busy" @click="run('stop')"><Icon name="pause" :size="14" />暂停任务</button>
        <button v-if="resumable" type="button" class="primary" :disabled="busy" @click="run('resume')"><Icon name="play" :size="14" />继续任务</button>
        <button v-if="ended && task.status !== 'sealed'" type="button" :disabled="busy" @click="run('redispatch')"><Icon name="refresh" :size="14" />重新派发</button>
        <button v-if="task.status !== 'sealed' && task.status !== 'running'" type="button" :disabled="busy" title="封存后禁止恢复、续做或重新派发" @click="run('seal')"><Icon name="lock" :size="14" />封存</button>
        <button v-if="ended" type="button" class="danger-text" :disabled="busy" @click="run('remove')"><Icon name="trash" :size="14" />删除记录</button>
      </template>
    </footer>
  </article>
</template>
<style scoped>
.task-detail { display: flex; flex-direction: column; gap: 16px; min-height: 100%; padding: 20px 24px; outline: none; overflow-wrap: anywhere; }
.detail-back { align-self: flex-start; margin: -8px 0 -6px -8px; color: var(--text-2); }
.detail-head { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.detail-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.detail-time { margin-left: auto; color: var(--muted); font-size: 12px; }
.detail-note { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.attention-block { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 14px 16px; border: 1px solid var(--warn-border); border-radius: var(--r-lg); background: var(--warn-soft); }
.attention-block h3 { display: flex; align-items: center; gap: 6px; color: var(--warn); font-size: 13px; }
.attention-block textarea { width: 100%; background: var(--surface); }
.detail-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.detail-section h3 { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.plan-count { color: var(--text-2); font-weight: 500; }
.progress-latest { padding: 10px 12px; border-left: 3px solid var(--accent); border-radius: 0 var(--r-md) var(--r-md) 0; background: var(--accent-softer); line-height: 1.6; }
.progress-history summary { color: var(--muted); font-size: 12px; }
.progress-history ol { margin: 6px 0 0; padding-left: 20px; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.progress-history .markdown { font-size: inherit; }
.plan-bar { height: 4px; overflow: hidden; border-radius: 2px; background: var(--surface-3); }
.plan-bar span { display: block; height: 100%; border-radius: 2px; background: var(--accent); transition: width .3s; }
.plan { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.plan li { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; color: var(--text-2); line-height: 1.5; }
.step-mark { display: grid; place-items: center; flex: none; width: 18px; height: 18px; margin-top: 1px; border: 1.5px solid var(--border-strong); border-radius: 50%; color: #fff; }
.plan li.completed { color: var(--muted); }
.plan li.completed .step-mark { border-color: var(--ok); background: var(--ok); }
.plan li.in_progress { color: var(--text); font-weight: 500; }
.plan li.in_progress .step-mark { border-color: var(--accent); background: var(--accent); }
.plan li.blocked .step-mark { border-color: var(--warn); background: var(--warn); }
.result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.result-export { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.result-export-menu { display: flex; flex-wrap: wrap; gap: 4px; }
.result-export-menu button { min-height: 28px; padding: 0 10px; border-color: var(--border); background: var(--surface); font-size: 12px; }
.export-error { margin: 0; color: var(--danger); font-size: 12px; }
.result-box { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); overflow-x: auto; }
.result-box.failed { border-color: var(--danger-border); background: var(--danger-soft); }
.result-box :deep(.markdown-table) { max-width: 100%; }
.result-box :deep(.markdown-body img) { max-width: 100%; height: auto; }
.meta-list { gap: 4px; }
.meta-list p { display: flex; align-items: flex-start; gap: 6px; color: var(--muted); font-size: 12px; line-height: 1.55; }
.meta-list .icon-svg { margin-top: 2px; }
.detail-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border); }
.detail-foot .spacer { flex: 1; }
@media (max-width: 767px) {
  .task-detail { padding: 14px 14px max(16px, env(safe-area-inset-bottom, 0px)); gap: 14px; }
  .detail-foot .spacer { display: none; }
  .detail-foot .hint { flex-basis: 100%; }
}
.settle-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.settle-list label { display: flex; gap: 8px; align-items: flex-start; line-height: 1.5; }
.settle-kind { flex: none; color: var(--muted); font-size: 12px; }
.settle em { color: var(--warn); font-style: normal; font-size: 12px; }
</style>
