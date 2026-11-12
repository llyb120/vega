<script setup vapor>
import { computed, ref, watch } from "vue";
import ProviderSettings from "./ProviderSettings.vue";
import SceneSettings from "./SceneSettings.vue";
import SchedulerSettings from "./SchedulerSettings.vue";
import VaultSettings from "./VaultSettings.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
const props = defineProps({
  api: Function,
  config: Object,
  models: Array,
  userId: String,
  tab: String,
  admin: Boolean,
  employees: Array,
});
const emit = defineEmits(["saved", "error", "notice", "tab"]);
// 每个账号都有自己的设置页（密码本）；模型服务商、场景模型和任务调度只有管理员能改。
const ADMIN_SECTIONS = [["providers", "服务商", "server", "模型服务商与可用模型"], ["scenes", "场景模型", "layers", "不同工作场景使用的模型"], ["scheduler", "任务调度", "tasks", "全站与单牛马并发上限"], ["vault", "密码本", "key", "加密保存的账号、密钥和 SSH 私钥，可指定适用的牛马"]];
const PERSONAL_SECTIONS = [["vault", "密码本", "key", "加密保存的账号、密钥和 SSH 私钥，可指定适用的牛马"]];
const sections = computed(() => props.admin ? ADMIN_SECTIONS : PERSONAL_SECTIONS);
const first = computed(() => props.admin ? "providers" : "vault");
// The open section lives in the address (/settings/scenes) so refresh keeps it.
const section = ref("providers");
watch([() => props.tab, sections], ([tab, list]) => { section.value = list.some(([id]) => id === tab) ? String(tab) : first.value; }, { immediate: true });
watch(section, (id) => { if (id !== (props.tab || first.value)) emit("tab", id === first.value ? "" : id); });
</script>
<template>
  <PageHeader :title="admin ? '系统设置' : '设置'" :subtitle="sections.find((entry) => entry[0] === section)[3]" />
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="设置分类">
      <button v-for="[id, label, icon] in sections" :key="id" type="button" :class="{ selected: section === id }" :aria-current="section === id ? 'page' : undefined" @click="section = id">
        <Icon :name="icon" :size="16" /><span>{{ label }}</span>
      </button>
    </nav>
    <div class="settings-content">
      <template v-if="admin">
        <div :hidden="section !== 'providers'"><ProviderSettings :api="api" :config="config" :user-id="userId" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
        <div :hidden="section !== 'scenes'"><SceneSettings :api="api" :config="config" :models="models" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
        <div :hidden="section !== 'scheduler'"><SchedulerSettings :api="api" :config="config" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
      </template>
      <div :hidden="section !== 'vault'"><VaultSettings :api="api" :user-id="userId" :employees="employees || []" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
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
