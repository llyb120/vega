<script setup vapor>
import { computed, ref } from "vue";
const props = defineProps({
  messages: { type: Array, default: () => [] },
  initialOpen: { type: Boolean, default: false },
});
const expanded = ref(props.initialOpen);
const toolCount = computed(
  () => props.messages.filter((m) => m.role === "tool").length,
);
const label = computed(() => {
  const thinking = props.messages.some((m) => m.thinking?.trim());
  const parts = [];
  if (thinking) parts.push("完成思考");
  if (toolCount.value) parts.push(`执行 ${toolCount.value} 步`);
  return parts.join(" · ") || "查看本轮回复";
});
</script>
<template>
  <button
    v-if="messages.length"
    type="button"
    class="turn-fold"
    :aria-expanded="expanded"
    @click="expanded = !expanded"
  >
    <span aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
    <span>{{ expanded ? "收起执行过程" : label }}</span>
    <span v-if="!expanded" class="turn-fold-hint">展开过程</span>
  </button>
  <div v-show="expanded" class="turn-process">
    <slot></slot>
  </div>
</template>
