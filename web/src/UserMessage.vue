<script setup vapor>
import { computed, ref } from "vue";
const props = defineProps({ text: { type: String, default: "" } });
const expanded = ref(false);
const long = computed(() => props.text.length > 2000);
const shown = computed(() =>
  long.value && !expanded.value ? props.text.slice(0, 800) + "…" : props.text,
);
</script>
<template>
  <div class="message-text">{{ shown }}</div>
  <button
    v-if="long"
    type="button"
    class="message-fold"
    :aria-expanded="expanded"
    @click="expanded = !expanded"
  >
    {{ expanded ? "收起完整消息" : `展开完整消息 · ${text.length} 字符` }}
    <span aria-hidden="true">{{ expanded ? "▴" : "▾" }}</span>
  </button>
</template>
<style scoped>
.message-text {
  white-space: pre-wrap;
  font-size: 0.9375rem;
  line-height: 1.7;
  color: inherit;
}

.message-fold {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-3);
  padding: var(--space-2);
  background: transparent;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--duration-base) var(--ease-out);
  min-height: 36px;
}

.message-fold:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.5);
  border-color: var(--border-medium);
}

@media (max-width: 768px) {
  .message-fold {
    min-height: 44px;
    font-size: 0.875rem;
  }
}
</style>
