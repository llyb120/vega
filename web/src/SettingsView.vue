<script setup vapor>
import { ref, watch } from "vue";
import ProviderSettings from "./ProviderSettings.vue";
import SceneSettings from "./SceneSettings.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
const props = defineProps({
  api: Function,
  config: Object,
  models: Array,
  userId: String,
  tab: String,
});
const emit = defineEmits(["saved", "error", "notice", "tab"]);
const sections = [["providers", "服务商", "server", "模型服务商与可用模型"], ["scenes", "场景模型", "layers", "不同工作场景使用的模型"]];
// The open section lives in the address (/settings/scenes) so refresh keeps it.
const section = ref("providers");
watch(() => props.tab, (tab) => { section.value = sections.some(([id]) => id === tab) ? tab : "providers"; }, { immediate: true });
watch(section, (id) => { if (id !== (props.tab || "providers")) emit("tab", id === "providers" ? "" : id); });
</script>
<template>
  <PageHeader title="系统设置" :subtitle="sections.find((entry) => entry[0] === section)[3]" />
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="设置分类">
      <button v-for="[id, label, icon] in sections" :key="id" type="button" :class="{ selected: section === id }" :aria-current="section === id ? 'page' : undefined" @click="section = id">
        <Icon :name="icon" :size="16" /><span>{{ label }}</span>
      </button>
    </nav>
    <div class="settings-content">
      <div :hidden="section !== 'providers'"><ProviderSettings :api="api" :config="config" :user-id="userId" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
      <div :hidden="section !== 'scenes'"><SceneSettings :api="api" :config="config" :models="models" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
    </div>
  </div>
</template>
<style scoped>
.settings-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); flex: 1; min-height: 0; background: var(--bg); }
.settings-nav { display: grid; align-content: start; gap: 2px; padding: 16px 8px; border-right: 1px solid var(--border); }
.settings-nav button { justify-content: flex-start; gap: 10px; width: 100%; min-height: 36px; padding: 0 10px; border: 0; background: transparent; color: var(--text-2); font-weight: 500; }
.settings-nav button:hover:not(:disabled) { background: var(--surface-3); }
.settings-nav button.selected { background: var(--surface); color: var(--text); box-shadow: var(--sh-sm); }
.settings-nav button .icon-svg { color: var(--muted); }
.settings-nav button.selected .icon-svg { color: var(--accent); }
.settings-content { min-width: 0; min-height: 0; overflow-y: auto; padding: 20px 24px 40px; scrollbar-width: thin; }
.settings-content > * { max-width: 880px; }
.settings-content :deep(.card-head) { display: grid; gap: 2px; margin-bottom: 14px; }
.settings-content :deep(.card-head.row) { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.settings-content :deep(.card-head h3) { font-size: 15px; }
@media (max-width: 899px) {
  .settings-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .settings-nav { display: flex; gap: 4px; padding: 8px 12px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); background: var(--surface); scrollbar-width: none; }
  .settings-nav::-webkit-scrollbar { display: none; }
  .settings-nav button { flex: none; width: auto; min-height: 32px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); }
  .settings-nav button.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); box-shadow: none; }
  .settings-content { padding: 12px 12px 32px; }
}
</style>
