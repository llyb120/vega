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
