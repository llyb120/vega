<script setup vapor>
import { onMounted, ref } from "vue";
import ProviderSettings from "./ProviderSettings.vue";
import SceneSettings from "./SceneSettings.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
const confirm = window.confirm.bind(window);
const props = defineProps({
  api: Function,
  config: Object,
  models: Array,
  userId: String,
});
const emit = defineEmits(["saved", "error", "notice"]);
const sections = [["providers", "服务商", "server", "模型服务商与可用模型"], ["scenes", "场景模型", "layers", "不同工作场景使用的模型"], ["vault", "密码本", "key", "供牛马取用的加密凭据"]];
const section = ref("providers");
const busy = ref(false),
  vault = ref([]),
  vaultForm = ref({ name: "", condition: "", content: "" });
async function run(fn) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    emit("error", e.message);
  } finally {
    busy.value = false;
  }
}
function newVault() {
  vaultForm.value = { name: "", condition: "", content: "" };
}
function editVault(item) {
  vaultForm.value = { id: item.id, name: item.name, condition: item.condition, content: "" };
}
async function loadVault() {
  const result = await props.api("/vault");
  vault.value = result.entries || result;
}
async function saveVault() {
  await run(async () => {
    await props.api("/vault", "POST", { ...vaultForm.value });
    newVault();
    await loadVault();
    emit("notice", "凭据已加密保存");
  });
}
async function removeVault(item) {
  if (!confirm('永久删除此凭据？')) return;
  await run(async () => {
    await props.api("/vault/" + encodeURIComponent(item.id), "DELETE");
    if (vaultForm.value.id === item.id) newVault();
    await loadVault();
  });
}
onMounted(() => void run(loadVault));
</script>
<template>
  <PageHeader title="系统设置" :subtitle="sections.find((entry) => entry[0] === section)[3]" />
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="设置分类">
      <button v-for="[id, label, icon] in sections" :key="id" type="button" :class="{ selected: section === id }" :aria-current="section === id ? 'page' : undefined" @click="section = id">
        <Icon :name="icon" :size="16" /><span>{{ label }}</span>
        <span v-if="id === 'vault' && vault.length" class="count">{{ vault.length }}</span>
      </button>
    </nav>
    <div class="settings-content">
      <div :hidden="section !== 'providers'"><ProviderSettings :api="api" :config="config" :user-id="userId" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
      <div :hidden="section !== 'scenes'"><SceneSettings :api="api" :config="config" :models="models" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
      <section :hidden="section !== 'vault'" class="card">
        <div class="card-head row"><div><h3>密码本 · {{ vault.length }} 条</h3><p class="hint">密码本全局共享，不归属牛马，无需逐牛马授权。可保存多条账号、密码或密钥，每条有独立的使用条件；凭据加密保存，只有管理员能修改。</p></div><button type="button" class="sm" :disabled="busy" @click="newVault">新增凭据</button></div>
        <p v-if="vaultForm.id" class="hint">正在编辑「{{ vaultForm.name }}」，凭据留空保留原内容。</p>
        <form class="form-grid two vault-form" @submit.prevent="saveVault">
          <label>名称<input v-model="vaultForm.name" required maxlength="100" placeholder="不要包含密钥内容" /></label>
          <label>允许使用的条件<input v-model="vaultForm.condition" required maxlength="500" placeholder="例如：仅在发布任务中使用" /></label>
          <label class="span-2">凭据<textarea v-model="vaultForm.content" :required="!vaultForm.id" rows="3" maxlength="16000" autocomplete="off"></textarea></label>
          <div class="span-2 actions end"><button class="primary sm" :disabled="busy"><Icon name="lock" :size="14" />{{ vaultForm.id ? '保存修改' : '新增并加密保存' }}</button></div>
        </form>
        <p v-if="!vault.length" class="empty-state">还没有凭据</p>
        <ul v-else class="item-list">
          <li v-for="item in vault" :key="item.id">
            <span class="item-icon" aria-hidden="true"><Icon name="key" :size="15" /></span>
            <span class="item-text"><strong>{{ item.name }}</strong><small>{{ item.condition }}</small></span>
            <button type="button" class="sm" :disabled="busy" @click="editVault(item)">编辑</button>
            <button type="button" class="sm danger-text" :disabled="busy" @click="removeVault(item)">删除凭据</button>
          </li>
        </ul>
      </section>
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
.settings-nav .count { margin-left: auto; }
.settings-content { min-width: 0; min-height: 0; overflow-y: auto; padding: 20px 24px 40px; scrollbar-width: thin; }
.settings-content > * { max-width: 880px; }
.settings-content :deep(.card-head) { display: grid; gap: 2px; margin-bottom: 14px; }
.settings-content :deep(.card-head.row) { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.settings-content :deep(.card-head h3) { font-size: 15px; }
.vault-form { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.item-list { display: grid; margin: 0; padding: 0; list-style: none; }
.item-list li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.item-list li:first-child { border-top: 0; }
.item-icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--surface-2); color: var(--text-2); }
.item-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
.item-text strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.item-text small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 899px) {
  .settings-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .settings-nav { display: flex; gap: 4px; padding: 8px 12px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); background: var(--surface); scrollbar-width: none; }
  .settings-nav::-webkit-scrollbar { display: none; }
  .settings-nav button { flex: none; width: auto; min-height: 32px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); }
  .settings-nav button.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); box-shadow: none; }
  .settings-nav .count { display: none; }
  .settings-content { padding: 12px 12px 32px; }
}
</style>
