<script setup vapor>
import { computed, inject, onBeforeUnmount } from "vue";
import { renderMarkdown } from "./markdown";
import { useStreamingText } from "./streaming-text.js";
const props = defineProps({ text: String, streaming: Boolean });
const text = useStreamingText(() => props.text || "", () => props.streaming, 120, onBeforeUnmount);
// @名称 of people the reader knows are highlighted; employees the reader can open become links.
const mentions = inject("mentions", null);
const rendered = computed(() => renderMarkdown(text.value, { mentions: mentions?.people.value }));
async function copy(event) {
  const mention = event.target.closest?.("a.mention[data-employee]");
  if (mention && mentions && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    mentions.open(mention.dataset.employee);
    return;
  }
  const button = event.target.closest?.(".code-copy");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(
      rendered.value.codes[Number(button.dataset.code)],
    );
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  setTimeout(() => {
    button.textContent = "复制";
  }, 1500);
}
</script>
<template>
  <div class="markdown" @click="copy">
    <div class="markdown-body" v-html="rendered.html"></div>
    <span v-if="streaming" class="cursor">▍</span>
  </div>
</template>
<style scoped>
.markdown-body :deep(.mention) {
  color: var(--accent, #4f46e5);
  font-weight: 500;
  text-decoration: none;
}
.markdown-body :deep(a.mention:hover) {
  text-decoration: underline;
}
.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
