<script setup vapor>
import { computed, inject, ref } from "vue";
import { mentionSegments } from "./mention.js";
const props = defineProps({ text: { type: String, default: "" } });
const expanded = ref(false);
const long = computed(() => props.text.length > 2000);
const shown = computed(() =>
  long.value && !expanded.value ? props.text.slice(0, 800) + "…" : props.text,
);
// "@名称" of known people is highlighted (and opens the employee when the reader can).
const mentions = inject("mentions", null);
const segments = computed(() => mentionSegments(shown.value, mentions?.people.value));
</script>
<template>
  <div class="message-text"><template v-for="(part, index) in segments" :key="index"><a v-if="part.id && part.link" class="mention" :href="'/employees/' + encodeURIComponent(part.id)" @click.exact.prevent="mentions?.open(part.id)">{{ part.text }}</a><span v-else-if="part.id" class="mention">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></div>
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
.mention { color: var(--accent, #4f46e5); font-weight: 500; text-decoration: none; }
a.mention:hover { text-decoration: underline; }
</style>
