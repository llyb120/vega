<script setup vapor>
import { computed, ref } from "vue";
import { formatDuration, formatTokens, turnStats } from "./conversation";
const props = defineProps({
  messages: { type: Array, default: () => [] },
  startedAt: { type: Number, default: 0 },
  running: { type: Boolean, default: false },
});
const expanded = ref(false);
const stats = computed(() => turnStats(props.messages, props.startedAt));
const rate = computed(() => {
  const { outputTokens, durationMs } = stats.value;
  return outputTokens > 0 && durationMs >= 1000
    ? Math.round(outputTokens / (durationMs / 1000))
    : null;
});
const label = computed(() =>
  [
    "已处理",
    formatDuration(stats.value.durationMs),
    stats.value.totalTokens ? `· ${formatTokens(stats.value.totalTokens)} tokens` : "",
    rate.value != null ? `· 平均输出 ${formatTokens(rate.value)} tok/s` : "",
  ].filter(Boolean).join(" "),
);
const tokenTitle = computed(() => {
  const s = stats.value;
  if (!s.totalTokens) return undefined;
  const input = Math.max(0, s.inputTokens - s.cacheReadTokens - s.cacheWriteTokens);
  const parts = [`输入 ${formatTokens(input)}`, `输出 ${formatTokens(s.outputTokens)}`];
  if (s.cacheReadTokens) parts.push(`缓存输入 ${formatTokens(s.cacheReadTokens)}`);
  if (s.cacheWriteTokens) parts.push(`缓存写入 ${formatTokens(s.cacheWriteTokens)}`);
  return `${parts.join(" / ")} tokens`;
});
</script>
<template>
  <button
    v-if="!running && messages.length"
    type="button"
    class="turn-fold"
    :title="tokenTitle"
    :aria-expanded="expanded"
    @click="expanded = !expanded"
  >
    <span>{{ label }}</span>
    <span class="turn-fold-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
  </button>
  <div
    v-if="messages.length || running"
    v-show="running || expanded"
    :class="['turn-process', { folded: !running }]"
  >
    <slot></slot>
  </div>
</template>
<style scoped>
.turn-fold {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-4);
  margin: var(--space-4) 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  font-size: 0.8125rem;
  color: var(--text-tertiary);
  text-align: left;
  cursor: pointer;
  transition: all var(--duration-base) var(--ease-out);
  min-height: 40px;
}

.turn-fold:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--border-medium);
}

.turn-fold-chevron {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  flex-shrink: 0;
}

.turn-process {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.turn-process.folded {
  margin: var(--space-3) 0;
}

@media (max-width: 768px) {
  .turn-fold {
    min-height: 44px;
    font-size: 0.875rem;
  }
}
</style>
