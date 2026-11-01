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
