<script setup vapor>
import { computed } from "vue";
import { renderMarkdown } from "./markdown";
const props = defineProps({ text: String, streaming: Boolean });
const rendered = computed(() => renderMarkdown(props.text || ""));
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
.markdown {
  position: relative;
}

.markdown-body {
  font-size: 0.9375rem;
  line-height: 1.7;
  color: var(--text-primary);
}

.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-lg);
  margin: var(--space-4) 0;
}

.markdown-body :deep(p) {
  margin: var(--space-3) 0;
}

.markdown-body :deep(p:first-child) {
  margin-top: 0;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: var(--space-3) 0;
  padding-left: var(--space-6);
}

.markdown-body :deep(li) {
  margin: var(--space-2) 0;
}

.markdown-body :deep(code) {
  padding: var(--space-1) var(--space-2);
  background: var(--bg-sunken);
  border-radius: var(--radius-sm);
  font-size: 0.875em;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}

.markdown-body :deep(pre) {
  margin: var(--space-4) 0;
  padding: var(--space-4);
  background: var(--bg-sunken);
  border-radius: var(--radius-md);
  overflow-x: auto;
  line-height: 1.6;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: 0.8125rem;
}

.markdown-body :deep(blockquote) {
  margin: var(--space-4) 0;
  padding-left: var(--space-4);
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: var(--space-5) 0 var(--space-3);
  font-weight: 600;
}

.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child) {
  margin-top: 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: var(--space-4) 0;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-light);
}

.markdown-body :deep(th) {
  background: var(--bg-secondary);
  font-weight: 600;
}

.markdown-body :deep(a) {
  color: var(--accent);
  text-decoration: underline;
}

.markdown-body :deep(a:hover) {
  color: var(--accent-hover);
}

.markdown-body :deep(.code-copy) {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  cursor: pointer;
}

.markdown-body :deep(.code-copy:hover) {
  background: var(--bg-tertiary);
}

.cursor {
  display: inline-block;
  margin-left: var(--space-1);
  color: var(--accent);
  animation: blink 1s steps(1) infinite;
}
</style>
