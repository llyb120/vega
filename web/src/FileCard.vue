<script setup vapor>
import Icon from "./Icon.vue";
import { fileUrl, formatSize } from "./attachments.js";
// A message's attached file: name and size, downloadable once stored (an unsent outbox copy has no blobId yet).
defineProps({ file: Object });
</script>
<template>
  <a v-if="file.blobId" class="file-card" :href="fileUrl(file)" :download="file.name" :title="'下载 ' + file.name"><Icon name="file" :size="18" /><span class="file-name">{{ file.name }}</span><small>{{ formatSize(file.size) }}</small><Icon name="download" :size="14" /></a>
  <span v-else class="file-card"><Icon name="file" :size="18" /><span class="file-name">{{ file.name }}</span><small>{{ formatSize(file.size) }}</small></span>
</template>
<style scoped>
.file-card { display: flex; align-items: center; gap: 8px; max-width: 320px; margin-top: 6px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); color: inherit; text-decoration: none; }
a.file-card:hover { border-color: var(--accent); }
.file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
small { flex: none; color: var(--muted); }
</style>
