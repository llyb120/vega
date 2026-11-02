<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import { taskLabel, taskTone, planProgress, shortTime } from "./task-status";
const props = defineProps({ attention: Array, active: Array, readonly: Boolean, act: Function, overlay: Boolean });
const emit = defineEmits(["open", "all", "close"]);
const answers = ref({}), busy = ref("");
async function run(task, action) {
  if (busy.value) return;
  busy.value = task.id;
  try { if (await props.act(task, action, answers.value[task.id]) === true) answers.value[task.id] = ""; }
  finally { busy.value = ""; }
}
const others = (list, attention) => list.filter((task) => !attention.includes(task));
</script>
<template>
  <aside class="work-panel" :class="{ overlay }" aria-label="工作面板">
    <header class="panel-head"><h3>工作面板</h3><button type="button" class="link" @click="emit('all', 'active')">全部任务</button><button type="button" class="icon sm" aria-label="收起工作面板" @click="emit('close')"><Icon name="close" :size="16" /></button></header>
    <div class="panel-scroll">
      <section v-if="attention.length" class="panel-section">
        <h4><span class="dot warn" aria-hidden="true"></span>待你处理<span class="count warn">{{ attention.length }}</span></h4>
        <article v-for="task in attention" :key="task.id" class="attention-card" :aria-busy="busy === task.id">
          <button type="button" class="task-title" @click="emit('open', task.id)">{{ task.text }}</button>
          <p class="attention-text"><strong>{{ task.status === 'approval' ? '需要确认' : '需要补充' }}：</strong>{{ task.status === 'approval' ? task.approval : task.waiting }}</p>
          <div v-if="!readonly && task.status === 'approval'" class="actions"><button type="button" class="primary sm" :disabled="!!busy" @click="run(task, 'approve')"><Icon name="check" :size="14" />批准执行</button><button type="button" class="sm" :disabled="!!busy" @click="run(task, 'reject')">驳回</button></div>
          <form v-else-if="!readonly" class="answer" @submit.prevent="run(task, 'answer')"><textarea v-model="answers[task.id]" rows="2" maxlength="8000" required :aria-label="'回复：' + task.text" placeholder="补充信息后，员工会继续原任务"></textarea><button class="primary sm" :disabled="!!busy || !answers[task.id]?.trim()">回复并继续</button></form>
        </article>
      </section>
      <section class="panel-section">
        <h4><span class="dot info" aria-hidden="true"></span>进行中<span class="count">{{ others(active, attention).length }}</span></h4>
        <p v-if="!others(active, attention).length" class="panel-empty"><Icon name="check" :size="16" />手头很清爽。交代一个目标，进度会更新在这里。</p>
        <button v-for="task in others(active, attention).slice(0, 8)" :key="task.id" type="button" class="task-row" @click="emit('open', task.id)">
          <span class="task-row-head"><span :class="['badge', taskTone(task.status)]">{{ taskLabel(task.status) }}</span><time>{{ shortTime(task.createdAt) }}</time></span>
          <strong>{{ task.text }}</strong>
          <span v-if="task.progress?.length || task.queueReason || task.checkpoint" class="task-row-note">{{ task.progress?.at(-1)?.text || task.queueReason || task.checkpoint }}</span>
          <span v-if="planProgress(task.plan)" class="mini-progress" :title="`计划 ${planProgress(task.plan).done}/${planProgress(task.plan).total}`"><span :style="{ width: planProgress(task.plan).percent + '%' }"></span></span>
        </button>
        <button v-if="others(active, attention).length > 8" type="button" class="link more" @click="emit('all', 'active')">还有 {{ others(active, attention).length - 8 }} 项 →</button>
      </section>
    </div>
  </aside>
</template>
<style scoped>
.work-panel { display: flex; flex-direction: column; min-height: 0; width: 320px; border-left: 1px solid var(--border); background: var(--bg); }
.work-panel.overlay { position: absolute; top: 0; right: 0; bottom: 0; z-index: 20; width: min(340px, 92%); box-shadow: var(--sh-lg); animation: rise-in .15s ease; }
.panel-head { display: flex; align-items: center; gap: 8px; flex: none; height: 44px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--border); }
.panel-head h3 { flex: 1; font-size: 13px; }
.panel-head .link { font-size: 12px; }
.panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 16px; scrollbar-width: thin; }
.panel-section h4 { display: flex; align-items: center; gap: 8px; margin: 12px 4px 8px; color: var(--text-2); font-size: 12px; }
.panel-section h4 .count { margin-left: auto; }
.attention-card { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 8px; padding: 10px 12px; border: 1px solid var(--warn-border); border-left: 3px solid var(--warn); border-radius: var(--r-md); background: var(--surface); }
.task-title { display: block; height: auto; min-height: 0; padding: 0; border: 0; background: transparent; color: var(--text); font-weight: 600; line-height: 1.45; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.task-title:hover:not(:disabled) { background: transparent; color: var(--accent-text); }
.attention-text { color: var(--text-2); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.attention-text strong { color: var(--warn); font-weight: 600; }
.answer { display: grid; gap: 6px; }
.answer textarea { width: 100%; font-size: 12px; }
.answer button { justify-self: end; }
.task-row { display: grid; grid-template-columns: minmax(0, 1fr); justify-content: stretch; gap: 4px; width: 100%; height: auto; margin-bottom: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); font-weight: 400; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.task-row:hover:not(:disabled) { border-color: var(--border-strong); background: var(--surface); box-shadow: var(--sh-sm); }
.task-row-head { display: flex; align-items: center; justify-content: space-between; }
.task-row time { color: var(--muted); font-size: 11px; }
.task-row strong { display: -webkit-box; overflow: hidden; color: var(--text); font-size: 13px; font-weight: 500; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.task-row-note { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 12px; line-height: 1.5; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mini-progress { display: block; height: 3px; margin-top: 2px; overflow: hidden; border-radius: 2px; background: var(--surface-3); }
.mini-progress span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.panel-empty { display: flex; gap: 8px; padding: 12px; color: var(--muted); font-size: 12px; line-height: 1.55; }
.panel-empty .icon-svg { color: var(--ok); }
.more { margin: 4px; font-size: 12px; }
</style>
