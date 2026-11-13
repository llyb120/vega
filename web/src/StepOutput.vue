<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import FileCard from "./FileCard.vue";
import MessageText from "./MessageText.vue";
import { exportResult, exportTitleOf } from "./export-result.js";

const props = defineProps({ output: Object, archiveBase: String });
const exportOpen = ref(false), exporting = ref(false), error = ref("");
async function runExport(format) {
  if (exporting.value) return;
  exporting.value = true;
  error.value = "";
  try {
    await exportResult(format, { title: exportTitleOf(props.output.label, "步骤产物"), markdown: props.output.text, archiveBase: props.archiveBase });
    exportOpen.value = false;
  } catch (e) { error.value = e.message || String(e); }
  finally { exporting.value = false; }
}
</script>
<template>
  <article class="step-output" :aria-label="output.step ? `第 ${output.step} 步产物` : '步骤产物'">
    <div class="step-output-head"><Icon name="file" :size="16" /><span>步骤产物<template v-if="output.step"> · 第 {{ output.step }} 步</template></span></div>
    <strong class="step-output-title">{{ output.label }}</strong>
    <details v-if="output.text" class="step-output-content">
      <summary>查看内容</summary>
      <MessageText :text="output.text" :archive-base="archiveBase" />
    </details>
    <div v-if="output.files?.length" class="step-output-files"><FileCard v-for="file in output.files" :key="file.blobId" :file="file" /></div>
    <div v-if="output.text" class="step-output-export">
      <button type="button" class="ghost sm" :aria-expanded="exportOpen" :disabled="exporting" @click="exportOpen = !exportOpen"><Icon name="download" :size="14" />单独导出</button>
      <div v-if="exportOpen" class="step-output-menu" role="menu">
        <button type="button" role="menuitem" :disabled="exporting" @click="runExport('html')">HTML</button>
        <button type="button" role="menuitem" :disabled="exporting" @click="runExport('pdf')">PDF</button>
        <button type="button" role="menuitem" :disabled="exporting" @click="runExport('docx')">DOCX</button>
        <button type="button" role="menuitem" :disabled="exporting" @click="runExport('xlsx')">XLSX</button>
        <button type="button" role="menuitem" :disabled="exporting" @click="runExport('md')">Markdown</button>
        <p class="step-output-note">Markdown 和 DOCX 的图片保留链接；XLSX 有表格时只导出表格。</p>
      </div>
      <p v-if="error" class="step-output-error" role="alert">{{ error }}</p>
    </div>
  </article>
</template>
<style scoped>
.step-output { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); overflow-wrap: anywhere; }
.step-output-head { display: flex; align-items: center; gap: 6px; color: var(--accent-text); font-size: 12px; font-weight: 600; }
.step-output-title { font-size: 13px; font-weight: 600; }
.step-output-content { min-width: 0; }
.step-output-content summary { color: var(--muted); font-size: 12px; cursor: pointer; }
.step-output-content .markdown { margin-top: 8px; overflow-x: auto; }
.step-output-content :deep(.markdown-table) { max-width: 100%; }
.step-output-files { min-width: 0; }
.step-output-export, .step-output-menu { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.step-output-menu button { min-height: 28px; padding: 0 10px; font-size: 12px; }
.step-output-note { flex-basis: 100%; margin: 2px 0 0; color: var(--muted); font-size: 11px; }
.step-output-error { margin: 0; color: var(--danger); font-size: 12px; }
</style>
