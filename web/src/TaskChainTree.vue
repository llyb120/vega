<script setup vapor>
import { computed } from "vue";
import { chainEdgeLabel, flattenChainTree, isBranchedChain } from "../../shared/task-chain";
import { cleanTaskTitle } from "./conversation.js";
import { shortTime, taskLabel, taskTone } from "./task-status.js";
const props = defineProps({ tasks: { type: Array, default: () => [] }, currentId: String });
const emit = defineEmits(["select"]);
const nodes = computed(() => flattenChainTree(props.tasks || []));
const branched = computed(() => isBranchedChain(nodes.value));
const edgeText = (node) => {
  const label = chainEdgeLabel(node.edgeKind);
  if (!label) return "";
  return node.retryOfSeq ? `${label} #${node.retryOfSeq}` : label;
};
</script>
<template>
  <section v-if="tasks.length > 1" class="chain-panel" aria-label="任务链">
    <div class="chain-head">
      <strong>任务链</strong>
      <span>{{ tasks.length }} 个节点{{ branched ? ' · 含分支' : '' }}</span>
    </div>
    <ol v-if="!branched" class="chain-linear">
      <li v-for="(node, index) in nodes" :key="node.id" class="chain-step-wrap">
        <span v-if="index > 0" class="chain-arrow" aria-hidden="true">→</span>
        <button v-if="!node.missing" type="button" class="chain-pill" :class="{ active: node.id === currentId, cancelled: node.task?.status === 'cancelled' }" :title="node.task?.text" @click="emit('select', node.id)">
          <span :class="['dot', taskTone(node.task?.status)]" aria-hidden="true"></span>
          <span v-if="node.task?.chainSeq" class="seq">#{{ node.task.chainSeq }}</span>
          <span class="title">{{ cleanTaskTitle(node.task?.text) || node.id }}</span>
          <span class="state">{{ taskLabel(node.task?.status) }}</span>
        </button>
        <span v-else class="chain-pill missing">已删除的前置任务</span>
      </li>
    </ol>
    <ul v-else class="chain-tree">
      <li v-for="node in nodes" :key="node.id" class="chain-row" :class="{ active: node.id === currentId, cancelled: node.task?.status === 'cancelled', missing: node.missing }">
        <span v-for="(open, gi) in node.guides" :key="gi" class="guide" :class="{ open }" aria-hidden="true"></span>
        <span v-if="node.depth > 0" class="branch-join" :class="{ last: node.isLast }" aria-hidden="true"></span>
        <button v-if="!node.missing" type="button" class="chain-node-btn" :aria-current="node.id === currentId ? 'true' : undefined" :title="node.task?.text" @click="emit('select', node.id)">
          <span :class="['dot', taskTone(node.task?.status)]" aria-hidden="true"></span>
          <span v-if="node.task?.chainSeq" class="seq">#{{ node.task.chainSeq }}</span>
          <span v-if="edgeText(node)" class="edge-badge" :class="node.edgeKind">{{ edgeText(node) }}</span>
          <span v-if="node.task?.branchLabel" class="branch-label">{{ node.task.branchLabel }}</span>
          <span class="title">{{ cleanTaskTitle(node.task?.text) || node.id }}</span>
          <span class="state">{{ taskLabel(node.task?.status) }}</span>
          <time v-if="node.task?.createdAt">{{ shortTime(node.task.createdAt) }}</time>
        </button>
        <span v-else class="chain-node-missing">已删除的前置任务</span>
      </li>
    </ul>
  </section>
</template>
<style scoped>
.chain-panel { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
.chain-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); }
.chain-head strong { color: var(--text-2); font-weight: 600; }
.chain-linear { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; padding: 0; list-style: none; }
.chain-step-wrap { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
.chain-arrow { color: var(--faint); font-size: 12px; }
.chain-pill { display: inline-flex; align-items: center; gap: 5px; max-width: 240px; height: auto; min-height: 26px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-2); font-size: 12px; font-weight: 400; }
.chain-pill:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
.chain-pill.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); font-weight: 500; }
.chain-pill.cancelled { opacity: .68; }
.chain-pill.missing { color: var(--muted); border-style: dashed; }
.chain-pill .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain-pill .state { flex: none; color: var(--muted); font-size: 11px; }
.seq { flex: none; font-size: 11px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
.chain-tree { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.chain-row { display: flex; align-items: stretch; min-height: 28px; }
.guide { position: relative; flex: none; width: 16px; }
.guide.open::before { content: ""; position: absolute; top: 0; bottom: 0; left: 7px; border-left: 1.5px solid var(--border-strong); }
.branch-join { position: relative; flex: none; width: 16px; }
.branch-join::before { content: ""; position: absolute; top: 0; bottom: 0; left: 7px; border-left: 1.5px solid var(--border-strong); }
.branch-join.last::before { bottom: 50%; }
.branch-join::after { content: ""; position: absolute; top: 50%; left: 7px; right: 2px; border-top: 1.5px solid var(--border-strong); }
.chain-node-btn { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: auto; min-height: 28px; padding: 3px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 400; text-align: left; }
.chain-node-btn:hover:not(:disabled) { background: var(--surface); border-color: var(--border); }
.chain-row.active .chain-node-btn { border-color: #cbd9fb; background: var(--surface); color: var(--text); font-weight: 500; }
.chain-row.cancelled .chain-node-btn { opacity: .66; }
.chain-node-btn .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain-node-btn .state, .chain-node-btn time { flex: none; color: var(--muted); font-size: 11px; }
.chain-node-missing { display: inline-flex; align-items: center; padding: 3px 8px; color: var(--muted); font-size: 12px; font-style: italic; }
.edge-badge { flex: none; padding: 0 5px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); font-size: 10.5px; font-weight: 500; }
.edge-badge.follow_up { background: var(--accent-soft); color: var(--accent-text); }
.edge-badge.retry { background: var(--warn-soft); color: var(--warn); }
.branch-label { flex: none; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
</style>
