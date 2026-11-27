<script setup vapor>
import Icon from "./Icon.vue";
import { taskTone } from "./task-status.js";
import { taskDisplayTitle } from "./conversation.js";
defineProps({ refs: { type: Array, default: () => [] } });
const emit = defineEmits(["open", "remove"]);
const INTENT_LABEL = { follow_up: "继续交付", retry: "分支重做", fork: "开新分支" };
</script>
<template>
  <div v-if="refs.length" class="composer-task-refs" aria-label="引用的任务">
    <div v-for="item in refs" :key="item.id" class="task-ref-chip">
      <button type="button" class="task-ref-open" :title="item.title" @click="emit('open', item.id)">
        <span :class="['dot', taskTone(item.status)]" aria-hidden="true"></span>
        <span v-if="item.intent" class="intent-tag">{{ INTENT_LABEL[item.intent] || '引用' }}</span>
        <span v-if="item.chainSeq" class="seq-tag">#{{ item.chainSeq }}</span>
        <span class="task-ref-title">{{ taskDisplayTitle(item) || item.id }}</span>
      </button>
      <button type="button" class="icon sm task-ref-remove" aria-label="移除引用任务" @click="emit('remove', item.id)"><Icon name="close" :size="12" /></button>
    </div>
  </div>
</template>
<style scoped>
.composer-task-refs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 6px; padding: 2px 4px 0; }
.task-ref-chip { display: inline-flex; align-items: center; gap: 2px; max-width: min(100%, 360px); padding: 2px 4px 2px 8px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; background: var(--surface-2); }
.task-ref-open { display: inline-flex; align-items: center; gap: 5px; min-width: 0; height: auto; min-height: 22px; padding: 0; border: 0; background: transparent; color: var(--text); font-size: 12px; font-weight: 400; text-align: left; }
.task-ref-open:hover:not(:disabled) { background: transparent; color: var(--accent-text); }
.intent-tag { flex: none; padding: 0 5px; border-radius: 4px; background: var(--accent-soft); color: var(--accent-text); font-size: 10.5px; font-weight: 600; }
.seq-tag { flex: none; color: var(--muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.task-ref-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-ref-remove { width: 20px; min-height: 20px; color: var(--muted); }
</style>
