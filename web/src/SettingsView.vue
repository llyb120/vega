<script setup vapor>
import { onMounted, ref, watch } from "vue";
import ProviderSettings from "./ProviderSettings.vue";
import SceneSettings from "./SceneSettings.vue";
import { validateMcpServer } from "../../shared/mcp-config";
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
const copy = (value) => JSON.parse(JSON.stringify(value));
const sections = [["providers", "服务商", "server", "模型服务商与可用模型"], ["scenes", "场景模型", "layers", "不同工作场景使用的模型"], ["skills", "技能", "zap", "员工可调用的技能包"], ["vault", "密码本", "key", "供员工取用的加密凭据"], ["mcp", "MCP", "plug", "外部工具服务"]];
const section = ref("providers");
const busy = ref(false),
  skills = ref([]),
  replace = ref(false),
  upload = ref(null),
  mcp = ref({}),
  mcpName = ref(""),
  vault = ref([]),
  vaultForm = ref({ name: "", condition: "", content: "" });
watch(
  () => props.config,
  () => {
    mcp.value = Object.fromEntries(Object.entries(props.config.mcp || {}).map(([name, config]) => [name, JSON.stringify(config, null, 2)]));
  },
  { immediate: true },
);
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
async function refreshSkills() {
  skills.value = await props.api("/skills");
}
async function importSkill() {
  const file = upload.value?.files?.[0];
  if (!file) return;
  await run(async () => {
    if (file.size > 32 * 1024 * 1024) throw Error("技能包不能超过32MiB");
    const content = await new Promise((yes, no) => {
      const r = new FileReader();
      r.onload = () => yes(String(r.result).split(",")[1]);
      r.onerror = no;
      r.readAsDataURL(file);
    });
    await props.api("/skills/upload", "POST", {
      filename: file.name,
      content,
      replace: replace.value,
    });
    upload.value.value = "";
    await refreshSkills();
    emit("notice", "技能已导入");
  });
}
async function saveMcp() {
  await run(async () => {
    const next = copy(props.config);
    next.mcp = Object.fromEntries(Object.entries(mcp.value).map(([name, text]) => {
      let config;
      try { config = JSON.parse(text); }
      catch { throw Error(`MCP「${name}」的 JSON 格式无效`); }
      validateMcpServer(config, name);
      return [name, config];
    }));
    emit("saved", await props.api("/config", "PUT", next));
    emit("notice", "MCP已保存");
  });
}
function addMcp() {
  const key = mcpName.value.trim();
  if (!key) return;
  if (Object.hasOwn(mcp.value, key)) return emit("error", "MCP名称已存在");
  mcp.value = { ...mcp.value, [key]: '{\n  "url": "https://example.com/mcp"\n}' };
  mcpName.value = "";
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
onMounted(() => void run(async () => {
  await refreshSkills();
  await loadVault();
}));
</script>
<template>
  <PageHeader title="系统设置" :subtitle="sections.find((entry) => entry[0] === section)[3]" />
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="设置分类">
      <button v-for="[id, label, icon] in sections" :key="id" type="button" :class="{ selected: section === id }" :aria-current="section === id ? 'page' : undefined" @click="section = id">
        <Icon :name="icon" :size="16" /><span>{{ label }}</span>
        <span v-if="id === 'skills' && skills.length" class="count">{{ skills.length }}</span>
        <span v-else-if="id === 'vault' && vault.length" class="count">{{ vault.length }}</span>
        <span v-else-if="id === 'mcp' && Object.keys(mcp).length" class="count">{{ Object.keys(mcp).length }}</span>
      </button>
    </nav>
    <div class="settings-content">
      <div :hidden="section !== 'providers'"><ProviderSettings :api="api" :config="config" :user-id="userId" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
      <div :hidden="section !== 'scenes'"><SceneSettings :api="api" :config="config" :models="models" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" /></div>
      <section :hidden="section !== 'skills'" class="card">
        <div class="card-head"><h3>技能</h3><p class="hint">上传 ZIP 格式的技能包，员工会在合适的任务中使用。</p></div>
        <div class="upload-row">
          <input ref="upload" type="file" accept=".zip" aria-label="选择技能ZIP文件" />
          <label class="check"><input v-model="replace" type="checkbox" />覆盖同名技能</label>
          <button class="primary sm" :disabled="busy" @click="importSkill"><Icon name="plus" :size="14" />上传技能</button>
        </div>
        <p v-if="!skills.length" class="empty-state">还没有导入技能</p>
        <ul v-else class="item-list">
          <li v-for="s in skills" :key="s.id">
            <span class="item-icon" aria-hidden="true"><Icon name="zap" :size="15" /></span>
            <span class="item-text"><strong>{{ s.name }}</strong><small>{{ s.description }}</small></span>
            <button type="button" class="sm danger-text" @click="run(async () => { if (confirm('移除这个技能？')) { await api('/skills/' + encodeURIComponent(s.id), 'DELETE'); await refreshSkills(); } })">移除</button>
          </li>
        </ul>
      </section>
      <section :hidden="section !== 'vault'" class="card">
        <div class="card-head row"><div><h3>密码本 · {{ vault.length }} 条</h3><p class="hint">密码本全局共享，不归属员工，无需逐员工授权。可保存多条账号、密码或密钥，每条有独立的使用条件；凭据加密保存，只有管理员能修改。</p></div><button type="button" class="sm" :disabled="busy" @click="newVault">新增凭据</button></div>
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
      <section :hidden="section !== 'mcp'" class="card">
        <div class="card-head row"><div><h3>MCP</h3><p class="hint">修改后点保存生效。</p></div><button class="primary sm" :disabled="busy" @click="saveMcp">保存</button></div>
        <p class="hint">每个 MCP 单独配置一个 JSON 对象：远程服务使用 url / headers，本地进程使用 command / args / env；不要包含 mcpServers 外层。保留 __stored_secret__ 可保留已有密钥。</p>
        <p v-if="!Object.keys(mcp).length" class="empty-state">还没有 MCP 服务</p>
        <div v-for="(json, key) in mcp" :key="key" class="mcp-row">
          <strong class="truncate" :title="key">{{ key }}</strong>
          <textarea v-model="mcp[key]" rows="8" spellcheck="false" :aria-label="key + ' JSON配置'"></textarea>
          <button type="button" class="icon sm" :aria-label="'移除 ' + key" title="移除" @click="{ const next = { ...mcp }; delete next[key]; mcp = next; }"><Icon name="trash" :size="15" /></button>
        </div>
        <div class="mcp-add">
          <input v-model="mcpName" placeholder="名称" aria-label="MCP名称" />
          <button type="button" class="sm" :disabled="busy" @click="addMcp"><Icon name="plus" :size="14" />添加 MCP</button>
        </div>
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
.upload-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; padding: 12px; border: 1px dashed var(--border-strong); border-radius: var(--r-md); background: var(--surface-2); }
.upload-row input[type="file"] { flex: 1; min-width: 180px; height: auto; padding: 0; border: 0; background: transparent; box-shadow: none; font-size: 12px; }
.vault-form { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.item-list { display: grid; margin: 0; padding: 0; list-style: none; }
.item-list li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.item-list li:first-child { border-top: 0; }
.item-icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--surface-2); color: var(--text-2); }
.item-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
.item-text strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.item-text small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.mcp-row { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; align-items: center; gap: 8px; margin-bottom: 8px; }
.mcp-row strong { font-size: 13px; font-weight: 600; }
.mcp-row textarea { min-width: 0; font-family: var(--mono); }
.mcp-add { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
@media (max-width: 899px) {
  .settings-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .settings-nav { display: flex; gap: 4px; padding: 8px 12px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); background: var(--surface); scrollbar-width: none; }
  .settings-nav::-webkit-scrollbar { display: none; }
  .settings-nav button { flex: none; width: auto; min-height: 32px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); }
  .settings-nav button.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); box-shadow: none; }
  .settings-nav .count { display: none; }
  .settings-content { padding: 12px 12px 32px; }
}
@media (max-width: 767px) {
  .mcp-row { grid-template-columns: minmax(0, 1fr) auto; }
  .mcp-row strong { grid-column: 1 / -1; }
  .mcp-add { grid-template-columns: minmax(0, 1fr); }
}
</style>
