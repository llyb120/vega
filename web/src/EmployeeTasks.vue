<script setup vapor>
import { computed, onBeforeUnmount, ref, watch, nextTick } from "vue";
import Icon from "./Icon.vue";
import TaskDetail from "./TaskDetail.vue";
import { taskLabel, taskTone, planProgress, shortTime, needsAttention } from "./task-status";
import { chainEdgeLabel, chainTasks, groupTasksByChain } from "../../shared/task-chain";
import { cleanTaskTitle } from "./conversation.js";
const props = defineProps({ active: Array, attention: Array, history: Array, filter: String, focus: String, readonly: Boolean, act: Function, saveMemory: Function, employeeId: String, clients: Array, handoff: Function });
const emit = defineEmits(["filter", "select", "inspect", "chat"]);
const list = ref(null);
const media = window.matchMedia("(min-width: 1024px)"), twoPane = ref(media.matches);
const sync = () => { twoPane.value = media.matches; };
media.addEventListener("change", sync);
onBeforeUnmount(() => media.removeEventListener("change", sync));
const filters = computed(() => [["active", "进行中", props.active.length], ["attention", "待我处理", props.attention.length], ["history", "已结束", props.history.length]]);
const visible = computed(() => props.filter === "history" ? props.history : props.filter === "attention" ? props.attention : props.active);
const all = computed(() => [...props.active, ...props.history]);
const grouped = computed(() => groupTasksByChain(visible.value, all.value));
const selected = computed(() => props.focus ? all.value.find((task) => task.id === props.focus) : (twoPane.value ? visible.value[0] : null));
const selectedChainTasks = computed(() => selected.value?.chainId ? chainTasks(all.value, selected.value.chainId) : []);
const toggledChains = ref(new Map());
function isExpanded(group) {
  if (toggledChains.value.has(group.chainId)) return toggledChains.value.get(group.chainId);
  return group.hasActive || group.hasAttention || selected.value?.chainId === group.chainId;
}
function toggleChain(chainId, current) {
  const next = new Map(toggledChains.value);
  next.set(chainId, !current);
  toggledChains.value = next;
}
const edgeText = (node) => {
  const label = chainEdgeLabel(node.edgeKind);
  if (!label) return "";
  return node.retryOfSeq ? `${label} #${node.retryOfSeq}` : label;
};
watch(() => props.focus, async (id) => {
  if (!id) return;
  await nextTick();
  list.value?.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}, { immediate: true });
function location(task) { return task.execution?.localAgent ? task.execution.clientName || "客户端" : "服务端"; }
</script>
<template>
  <div class="tasks-layout" :class="{ 'show-detail': !!selected && !twoPane }">
    <section class="task-list-pane" aria-label="任务列表">
      <div class="task-toolbar">
        <div class="segmented" role="group" aria-label="筛选任务">
          <button v-for="[id, label, count] in filters" :key="id" type="button" :class="{ selected: filter === id }" :aria-pressed="filter === id" @click="emit('filter', id)">{{ label }}<span :class="['count', id === 'attention' && count ? 'warn' : '']">{{ count }}</span></button>
        </div>
      </div>
      <div ref="list" class="task-list" role="list">
        <template v-for="group in grouped" :key="group.kind === 'single' ? group.task.id : group.chainId">
          <button v-if="group.kind === 'single'" type="button" role="listitem" class="task-item" :data-row="group.task.id" :class="{ selected: selected?.id === group.task.id, attention: needsAttention(group.task.status) }" :aria-current="selected?.id === group.task.id ? 'true' : undefined" @click="emit('select', group.task.id)">
            <span :class="['dot', taskTone(group.task.status), { pulse: group.task.status === 'running' }]" aria-hidden="true"></span>
            <span class="task-main">
              <strong>{{ group.task.text }}</strong>
              <span class="task-meta"><span :class="['status-text', taskTone(group.task.status)]">{{ taskLabel(group.task.status) }}</span><span>{{ location(group.task) }}</span><time>{{ shortTime(group.task.createdAt) }}</time></span>
              <span v-if="needsAttention(group.task.status)" class="task-ask"><span class="clamp">{{ group.task.status === 'approval' ? group.task.approval : group.task.waiting }}</span></span>
              <span v-else-if="group.task.progress?.length" class="task-note">{{ group.task.progress.at(-1).text }}</span>
            </span>
            <span v-if="planProgress(group.task.plan)" class="task-plan" :title="`计划 ${planProgress(group.task.plan).done}/${planProgress(group.task.plan).total}`"><span class="ring" :style="{ '--p': planProgress(group.task.plan).percent }"></span>{{ planProgress(group.task.plan).done }}/{{ planProgress(group.task.plan).total }}</span>
          </button>
          <div v-else class="task-chain-group" role="listitem" :class="{ attention: group.hasAttention, expanded: isExpanded(group) }">
            <button type="button" class="chain-group-head" :aria-expanded="isExpanded(group)" @click="toggleChain(group.chainId, isExpanded(group))">
              <span :class="['dot', taskTone(group.headTask.status), { pulse: group.headTask.status === 'running' }]" aria-hidden="true"></span>
              <span class="chain-group-main">
                <strong>{{ cleanTaskTitle(group.headTask.text) || group.headTask.text }}</strong>
                <span class="chain-group-meta">
                  <span class="chain-badge">任务链 · {{ group.count }} 节点<template v-if="group.branched"> · {{ group.branchCount }} 分支</template></span>
                  <span :class="['status-text', taskTone(group.headTask.status)]">{{ taskLabel(group.headTask.status) }}</span>
                </span>
              </span>
              <Icon :name="isExpanded(group) ? 'down' : 'right'" :size="14" />
            </button>
            <div v-if="isExpanded(group)" class="chain-group-nodes">
              <div v-for="node in group.nodes" :key="node.id" class="chain-node-row" :class="{ cancelled: node.task?.status === 'cancelled', missing: node.missing }">
                <span v-for="(open, gi) in node.guides" :key="gi" class="guide" :class="{ open }" aria-hidden="true"></span>
                <span v-if="node.depth > 0" class="branch-join" :class="{ last: node.isLast }" aria-hidden="true"></span>
                <button v-if="!node.missing" type="button" class="task-item chain-node" :data-row="node.id" :class="{ selected: selected?.id === node.id, attention: needsAttention(node.task.status) }" :aria-current="selected?.id === node.id ? 'true' : undefined" @click="emit('select', node.id)">
                  <span :class="['dot', taskTone(node.task.status), { pulse: node.task.status === 'running' }]" aria-hidden="true"></span>
                  <span class="task-main">
                    <span class="chain-node-line">
                      <span v-if="node.task.chainSeq" class="chain-seq">#{{ node.task.chainSeq }}</span>
                      <span v-if="edgeText(node)" class="chain-edge" :class="node.edgeKind">{{ edgeText(node) }}</span>
                      <strong>{{ cleanTaskTitle(node.task.text) || node.task.text }}</strong>
                    </span>
                    <span class="task-meta"><span :class="['status-text', taskTone(node.task.status)]">{{ taskLabel(node.task.status) }}</span><span>{{ location(node.task) }}</span><time>{{ shortTime(node.task.createdAt) }}</time></span>
                  </span>
                </button>
                <span v-else class="chain-missing-node">已删除的前置任务</span>
              </div>
            </div>
          </div>
        </template>
        <div v-if="!visible.length" class="empty-state">
          <Icon name="inbox" :size="28" />
          <strong>{{ filter === 'attention' ? '没有需要你处理的事项' : filter === 'history' ? '还没有结束的任务' : '暂时没有进行中的任务' }}</strong>
          <span>在对话中交代工作。</span>
          <button v-if="filter !== 'history'" type="button" class="sm" @click="emit('chat')">去对话交代</button>
        </div>
      </div>
      <p class="task-tip"><Icon name="zap" :size="13" />新任务先由轻量模型起步，涉及编码再在原会话升级。</p>
    </section>
    <section class="task-detail-pane" aria-label="任务详情">
      <TaskDetail v-if="selected" :key="selected.id" :task="selected" :chain-tasks="selectedChainTasks" :employee-id="employeeId" :readonly="readonly" :back="!twoPane" :act="(action, answer) => act(selected, action, answer)" :clients="clients" :handoff="handoff ? (clientId) => handoff(selected, clientId) : undefined" :save-memory="saveMemory" @inspect="emit('inspect', $event)" @back="emit('select', '')" @select-task="emit('select', $event)" />
      <div v-else class="detail-empty"><Icon name="tasks" :size="32" /><p>选择左侧任务查看进度、计划与结果</p></div>
    </section>
  </div>
</template>
<style scoped>
.tasks-layout { display: grid; grid-template-columns: minmax(340px, 420px) minmax(0, 1fr); flex: 1; min-height: 0; }
.task-list-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--surface); }
.task-toolbar { display: grid; gap: 10px; flex: none; padding: 12px; border-bottom: 1px solid var(--border); }
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
.task-chain-group { margin: 4px 0; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); overflow: hidden; }
.task-chain-group.attention { border-color: var(--warn-border); }
.chain-group-head { display: flex; align-items: flex-start; gap: 10px; width: 100%; height: auto; padding: 9px 10px; border: 0; border-radius: 0; background: var(--surface-2); font-weight: 400; text-align: left; white-space: normal; }
.chain-group-head:hover:not(:disabled) { background: var(--surface-3); }
.chain-group-head > .dot { margin-top: 6px; }
.chain-group-head > .icon-svg { flex: none; margin-top: 4px; color: var(--muted); }
.chain-group-main { display: grid; flex: 1; gap: 3px; min-width: 0; }
.chain-group-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 13px; font-weight: 500; }
.chain-group-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
.chain-badge { padding: 0 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-weight: 500; }
.chain-group-nodes { padding: 4px 6px 6px; border-top: 1px solid var(--border); background: var(--surface); }
.chain-node-row { display: flex; align-items: stretch; }
.chain-node-row.cancelled .chain-node { opacity: .66; }
.guide { position: relative; flex: none; width: 14px; }
.guide.open::before { content: ""; position: absolute; top: 0; bottom: 0; left: 6px; border-left: 1.5px solid var(--border-strong); }
.branch-join { position: relative; flex: none; width: 14px; }
.branch-join::before { content: ""; position: absolute; top: 0; bottom: 0; left: 6px; border-left: 1.5px solid var(--border-strong); }
.branch-join.last::before { bottom: 50%; }
.branch-join::after { content: ""; position: absolute; top: 50%; left: 6px; right: 2px; border-top: 1.5px solid var(--border-strong); }
.task-item.chain-node { flex: 1; padding: 7px 8px; }
.chain-node-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.chain-node-line strong { flex: 1; min-width: 0; -webkit-line-clamp: 1; }
.chain-seq { flex: none; color: var(--muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chain-edge { flex: none; padding: 0 4px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); font-size: 10px; font-weight: 500; }
.chain-edge.follow_up { background: var(--accent-soft); color: var(--accent-text); }
.chain-edge.retry { background: var(--warn-soft); color: var(--warn); }
.chain-missing-node { padding: 6px 8px; color: var(--muted); font-size: 11.5px; font-style: italic; }
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
  .task-item { padding: 12px 10px; }
  .task-tip { display: none; }
}
</style>
