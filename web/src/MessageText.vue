<script setup vapor>
import { computed, onBeforeUnmount } from "vue";
import { renderMarkdown } from "./markdown";
import { useStreamingText } from "./streaming-text.js";
const props = defineProps({ text: String, streaming: Boolean });
const text = useStreamingText(() => props.text || "", () => props.streaming, 120, onBeforeUnmount);
const rendered = computed(() => renderMarkdown(text.value));
async function copy(event) {
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
.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
