<script setup vapor>
import { computed, ref } from "vue";
const props = defineProps({
  items: { type: Array, default: () => [] },
  active: { type: Array, default: () => [] },
});
const open = ref(false);
const failed = computed(() => props.items.some((m) => m.error));
</script>
<template>
  <section class="tool-steps" :class="{ open }">
    <button
      type="button"
      class="tool-steps-summary"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="steps-icon" aria-hidden="true">⌁</span>
      <strong>执行过程</strong>
      <span class="steps-count">{{ items.length + active.length }} 步</span>
      <span v-if="failed" class="steps-state failed">有失败</span>
      <span v-else-if="active.length" class="steps-state running">执行中</span>
      <span v-else class="steps-state">已完成</span>
      <span class="steps-chevron" aria-hidden="true">{{
        open ? "▾" : "▸"
      }}</span>
    </button>
    <div v-show="open" class="tool-steps-body">
      <details v-for="(m, i) in items" :key="m.seq || i" class="tool-step">
        <summary>
          <span :class="['step-status', m.error ? 'failed' : 'done']">{{
            m.error ? "!" : "✓"
          }}</span>
          <span class="step-name">{{ m.name }}</span>
          <span class="step-hint">查看结果</span>
        </summary>
        <pre>{{ m.text }}</pre>
        <img
          v-for="(image, n) in m.images || []"
          :key="n"
          :src="`data:${image.mime};base64,${image.data}`"
          alt="工具返回的图片"
        />
      </details>
      <div v-for="c in active" :key="c.id" class="tool-step active">
        <span class="spinner"></span>{{ c.name }} 正在执行…
      </div>
    </div>
  </section>
</template>
