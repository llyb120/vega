<script setup vapor>
import { computed, ref } from "vue";
import { processLiveLines, processSummary, toolKind } from "./conversation";
const props = defineProps({
  items: { type: Array, default: () => [] },
  active: { type: Array, default: () => [] },
  live: { type: Boolean, default: false },
});
const expanded = ref(false);
const allItems = computed(() => [
  ...props.items.map((item) => item.pending && props.active.some((tool) => tool.id === item.id) ? { ...item, active: true } : item),
  ...props.active.filter((tool) => !props.items.some((item) => (item.callId || item.id) === tool.id)).map((item) => ({ ...item, role: "tool", active: true })),
]);
const summary = computed(() => processSummary(allItems.value));
const lines = computed(() => processLiveLines(allItems.value));
const hasBody = (item) => !!(item.text || item.images?.length);
const icons = { read: "⌕", edit: "±", delete: "−", search: "⌕", execute: "$", think: "●", fetch: "↗", tool: "⚙" };
const icon = (item) => icons[toolKind(item.name)];
</script>
<template>
  <section class="tool-steps" :class="{ open: expanded }">
    <button
      type="button"
      class="tool-steps-summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span v-if="!live" class="steps-summary-line" :title="summary">
        <span class="steps-summary-text">{{ summary }}</span>
        <span class="steps-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      </span>
      <span v-else class="steps-live-preview" :title="lines.join('\n')">
        <span class="steps-live-lines">
          <span v-for="(line, i) in lines" :key="i" class="steps-live-line">
            {{ line }}<span v-if="i === lines.length - 1" class="steps-live-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
          </span>
        </span>
      </span>
    </button>
    <div v-show="expanded" class="tool-steps-body">
      <template v-for="(m, i) in allItems" :key="`${m.role}-${m.seq || m.callId || m.id || i}`">
        <details v-if="m.role === 'thought'" class="reasoning tool-thought">
          <summary>思考过程</summary>
          <pre>{{ m.text }}</pre>
        </details>
        <div v-else-if="m.active || m.pending" class="tool-step" :class="{ active: m.active }">
          <span class="step-icon" aria-hidden="true">{{ icon(m) }}</span>
          <span class="step-name">{{ m.name }}</span>
          <span v-if="m.active" class="spinner" role="status" aria-label="进行中"></span>
          <span v-else class="hint">结果未确认</span>
        </div>
        <details v-else class="tool-step" :class="{ failed: m.error }">
          <summary>
            <span class="step-icon" aria-hidden="true">{{ icon(m) }}</span>
            <span class="step-name">{{ m.name }}</span>
            <span v-if="m.error" class="step-failed" role="img" aria-label="失败"></span>
            <span v-if="hasBody(m)" class="step-chevron" aria-hidden="true">▸</span>
          </summary>
          <pre v-if="m.text">{{ m.text }}</pre>
          <img
            v-for="(image, n) in m.images || []"
            :key="n"
            :src="image.blobId ? `/api/blobs/${image.blobId}` : `data:${image.mime};base64,${image.data}`"
            alt="工具返回的图片"
          />
        </details>
      </template>
    </div>
  </section>
</template>
<style scoped>
.tool-steps {
  margin: var(--space-4) 0;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  overflow: hidden;
}

.tool-steps-summary {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  background: transparent;
  border: none;
  text-align: left;
  font-size: 0.875rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--duration-base) var(--ease-out);
  min-height: 44px;
  display: flex;
  align-items: center;
}

.tool-steps-summary:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.steps-summary-line,
.steps-live-preview {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

.steps-summary-text {
  flex: 1;
  font-weight: 500;
}

.steps-chevron,
.steps-live-chevron {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  flex-shrink: 0;
}

.steps-live-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.steps-live-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--accent);
  font-size: 0.875rem;
}

.tool-steps-body {
  border-top: 1px solid var(--border-light);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tool-step {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
}

.tool-step.active {
  border-color: var(--accent);
  background: var(--accent-light);
}

.tool-step.failed {
  border-color: var(--error-500);
  background: var(--error-50);
}

.step-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  flex-shrink: 0;
}

.tool-step.active .step-icon {
  background: var(--accent-medium);
  color: var(--accent);
}

.step-name {
  flex: 1;
  font-weight: 500;
  color: var(--text-primary);
}

.step-failed {
  color: var(--error-500);
  font-weight: 600;
}

.step-chevron {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  margin-left: auto;
}

details.tool-step summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

details.tool-step[open] {
  padding-bottom: var(--space-3);
}

details.tool-step pre {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-sunken);
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
  overflow-x: auto;
  line-height: 1.6;
}

details.tool-step img {
  max-width: 100%;
  margin-top: var(--space-3);
  border-radius: var(--radius-md);
}

.tool-thought {
  padding: var(--space-3);
  background: var(--info-50);
  border: 1px solid var(--info-500);
  border-radius: var(--radius-md);
}

.tool-thought summary {
  font-weight: 600;
  color: var(--info-600);
  cursor: pointer;
  user-select: none;
  font-size: 0.875rem;
}

.tool-thought pre {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-primary);
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
  line-height: 1.6;
  overflow-x: auto;
}

@media (max-width: 768px) {
  .tool-steps-summary {
    font-size: 0.9375rem;
  }

  .step-name {
    font-size: 0.9375rem;
  }
}
</style>
