<script setup vapor>
import Icon from "./Icon.vue";
import { formatSize } from "./attachments.js";
defineProps({ preview: Object });
</script>
<template>
  <a v-if="preview?.url" class="preview-card" :href="preview.url" target="_blank" rel="noopener noreferrer" :title="'在新窗口打开 ' + (preview.title || '静态网页预览')">
    <Icon name="globe" :size="18" />
    <span class="preview-meta">
      <span class="preview-title">{{ preview.title || "静态网页预览" }}</span>
      <small>网页预览<template v-if="preview.fileCount"> · {{ preview.fileCount }} 个文件</template><template v-if="preview.totalBytes"> · {{ formatSize(preview.totalBytes) }}</template></small>
    </span>
    <span class="preview-open">新窗口打开<Icon name="external" :size="14" /></span>
  </a>
</template>
<style scoped>
.preview-card { display: flex; align-items: center; gap: 10px; max-width: 380px; margin-top: 6px; padding: 8px 11px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); color: inherit; text-decoration: none; }
a.preview-card:hover { border-color: var(--accent); background: var(--accent-softer); }
.preview-meta { display: grid; flex: 1; min-width: 0; gap: 1px; }
.preview-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
small { color: var(--muted); font-size: 11px; }
.preview-open { display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--accent-text); font-size: 12px; font-weight: 500; }
</style>
