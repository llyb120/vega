<script setup vapor>
import { computed, onBeforeUnmount, ref, watch, nextTick } from "vue";
import Icon from "./Icon.vue";
import TaskDetail from "./TaskDetail.vue";
import { taskLabel, taskTone, planProgress, shortTime, needsAttention } from "./task-status";
const props = defineProps({ active: Array, attention: Array, history: Array, filter: String, focus: String, readonly: Boolean, canCreate: Boolean, act: Function, add: Function });
const emit = defineEmits(["filter", "select", "inspect", "chat"]);
const text = ref(""), adding = ref(false), list = ref(null);
const media = window.matchMedia("(min-width: 1024px)"), twoPane = ref(media.matches);
const sync = () => { twoPane.value = media.matches; };
media.addEventListener("change", sync);
onBeforeUnmount(() => media.removeEventListener("change", sync));
const filters = computed(() => [["active", "进行中", props.active.length], ["attention", "待我处理", props.attention.length], ["history", "已结束", props.history.length]]);
const visible = computed(() => props.filter === "history" ? props.history : props.filter === "attention" ? props.attention : props.active);
const all = computed(() => [...props.active, ...props.history]);
const selected = computed(() => all.value.find((task) => task.id === props.focus) || (twoPane.value ? visible.value[0] : null));
watch(() => props.focus, async (id) => {
  if (!id) return;
  await nextTick();
  list.value?.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}, { immediate: true });
async function submit() {
  if (adding.value || !text.value.trim()) return;
  adding.value = true;
  try { if (await props.add(text.value) === true) text.value = ""; }
  finally { adding.value = false; }
}
function location(task) { return task.execution?.localAgent ? task.execution.clientName || "客户端" : "服务端"; }
</script>
<template>
  <div class="tasks-layout" :class="{ 'show-detail': !!selected && !twoPane }">
    <section class="task-list-pane" aria-label="任务列表">
      <div class="task-toolbar">
        <form v-if="canCreate" class="task-add" @submit.prevent="submit">
          <Icon name="plus" :size="16" />
          <input v-model="text" required aria-label="新任务" placeholder="交给员工：一件有明确目标的事" />
          <button class="primary sm" :disabled="adding || !text.trim()">交给员工</button>
        </form>
        <div class="segmented" role="group" aria-label="筛选任务">
          <button v-for="[id, label, count] in filters" :key="id" type="button" :class="{ selected: filter === id }" :aria-pressed="filter === id" @click="emit('filter', id)">{{ label }}<span :class="['count', id === 'attention' && count ? 'warn' : '']">{{ count }}</span></button>
        </div>
      </div>
      <div ref="list" class="task-list" role="list">
        <button v-for="task in visible" :key="task.id" type="button" role="listitem" class="task-item" :data-row="task.id" :class="{ selected: selected?.id === task.id, attention: needsAttention(task.status) }" :aria-current="selected?.id === task.id ? 'true' : undefined" @click="emit('select', task.id)">
          <span :class="['dot', taskTone(task.status), { pulse: task.status === 'running' }]" aria-hidden="true"></span>
          <span class="task-main">
            <strong>{{ task.text }}</strong>
            <span class="task-meta"><span :class="['status-text', taskTone(task.status)]">{{ taskLabel(task.status) }}</span><span>{{ location(task) }}</span><span v-if="task.dutyId">职责触发</span><time>{{ shortTime(task.createdAt) }}</time></span>
            <span v-if="needsAttention(task.status)" class="task-ask"><span class="clamp">{{ task.status === 'approval' ? task.approval : task.waiting }}</span></span>
            <span v-else-if="task.progress?.length" class="task-note">{{ task.progress.at(-1).text }}</span>
          </span>
          <span v-if="planProgress(task.plan)" class="task-plan" :title="`计划 ${planProgress(task.plan).done}/${planProgress(task.plan).total}`"><span class="ring" :style="{ '--p': planProgress(task.plan).percent }"></span>{{ planProgress(task.plan).done }}/{{ planProgress(task.plan).total }}</span>
        </button>
        <div v-if="!visible.length" class="empty-state">
          <Icon name="inbox" :size="28" />
          <strong>{{ filter === 'attention' ? '没有需要你处理的事项' : filter === 'history' ? '还没有结束的任务' : '暂时没有进行中的任务' }}</strong>
          <span>在对话中交代工作，或在上方直接创建任务。</span>
          <button v-if="filter !== 'history'" type="button" class="sm" @click="emit('chat')">去对话交代</button>
        </div>
      </div>
      <p class="task-tip"><Icon name="zap" :size="13" />新任务先由轻量模型起步，涉及编码再在原会话升级。</p>
    </section>
    <section class="task-detail-pane" aria-label="任务详情">
      <TaskDetail v-if="selected" :key="selected.id" :task="selected" :readonly="readonly" :back="!twoPane" :act="(action, answer) => act(selected, action, answer)" @inspect="emit('inspect', $event)" @back="emit('select', '')" />
      <div v-else class="detail-empty"><Icon name="tasks" :size="32" /><p>选择左侧任务查看进度、计划与结果</p></div>
    </section>
  </div>
</template>
<style scoped>
.tasks-layout { display: grid; grid-template-columns: minmax(340px, 420px) minmax(0, 1fr); flex: 1; min-height: 0; }
.task-list-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--surface); }
.task-toolbar { display: grid; gap: 10px; flex: none; padding: 12px; border-bottom: 1px solid var(--border); }
.task-add { display: flex; align-items: center; gap: 6px; padding: 3px 3px 3px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface); }
.task-add:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.task-add .icon-svg { color: var(--muted); }
.task-add input { flex: 1; min-height: 28px; padding: 0 2px; border: 0; box-shadow: none !important; }
.segmented { display: flex; }
.segmented > button { flex: 1; }
.task-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; scrollbar-width: thin; }
.task-item { display: flex; align-items: flex-start; gap: 10px; width: 100%; height: auto; padding: 10px; border: 1px solid transparent; border-radius: var(--r-md); background: transparent; font-weight: 400; text-align: left; white-space: normal; }
.task-item + .task-item { margin-top: 2px; }
.task-item:hover:not(:disabled) { background: var(--surface-2); }
.task-item.selected { border-color: #cbd9fb; background: var(--accent-softer); }
.task-item > .dot { margin-top: 6px; }
.task-main { display: grid; flex: 1; gap: 3px; min-width: 0; }
.task-main strong { display: -webkit-box; overflow: hidden; color: var(--text); font-size: 13px; font-weight: 500; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.task-meta { display: flex; align-items: center; gap: 0; flex-wrap: wrap; color: var(--muted); font-size: 11.5px; }
.task-meta > * + *::before { content: "·"; margin: 0 6px; color: var(--faint); }
.status-text { font-weight: 600; color: var(--text-2); }
.status-text.info { color: var(--accent-text); }
.status-text.warn { color: var(--warn); }
.status-text.ok { color: var(--ok); }
.status-text.danger { color: var(--danger); }
.task-ask .clamp, .task-note { display: -webkit-box; overflow: hidden; font-size: 12px; line-height: 1.5; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.task-ask { margin-top: 2px; padding: 4px 8px; border-radius: var(--r-sm); background: var(--warn-soft); color: var(--warn); }
.task-note { color: var(--text-2); }
.task-plan { display: inline-flex; align-items: center; gap: 6px; flex: none; margin-top: 2px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.ring { width: 14px; height: 14px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--p) * 1%), var(--surface-3) 0); -webkit-mask: radial-gradient(circle, transparent 3.5px, #000 4px); mask: radial-gradient(circle, transparent 3.5px, #000 4px); }
.task-list .empty-state { margin: 12px 6px; }
.task-tip { display: flex; align-items: center; gap: 6px; flex: none; padding: 8px 14px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; }
.task-detail-pane { min-width: 0; min-height: 0; overflow-y: auto; background: var(--surface); scrollbar-width: thin; }
.detail-empty { display: grid; place-content: center; justify-items: center; gap: 10px; height: 100%; color: var(--faint); font-size: 13px; }
@media (min-width: 1440px) { .tasks-layout { grid-template-columns: 440px minmax(0, 1fr); } }
@media (max-width: 1023px) {
  .tasks-layout { grid-template-columns: minmax(0, 1fr); }
  .task-list-pane { border-right: 0; }
  .task-detail-pane { display: none; }
  .tasks-layout.show-detail .task-list-pane { display: none; }
  .tasks-layout.show-detail .task-detail-pane { display: block; }
}
@media (max-width: 767px) {
  .task-toolbar { padding: 10px; }
  .task-add input { min-height: 34px; }
  .task-item { padding: 12px 10px; }
  .task-tip { display: none; }
}
</style>
