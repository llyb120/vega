<script setup vapor>
import { onMounted, onBeforeUnmount, ref } from "vue";
import { validateMcpServer } from "../../shared/mcp-config";
import Icon from "./Icon.vue";
const props = defineProps({ api: Function, employeeId: String });
const emit = defineEmits(["error", "notice"]);
const canEdit = ref(false), skills = ref([]), servers = ref([]), mcp = ref({}), mcpName = ref(""), busy = ref(false), upload = ref(null), replace = ref(false), detail = ref(null);
const base = `/employees/${props.employeeId}`;
let disposed = false;
const confirm = window.confirm.bind(window);
async function run(fn) {
  if (busy.value) return;
  busy.value = true;
  try { await fn(); }
  catch (e) { if (!disposed) emit("error", e.message); }
  finally { busy.value = false; }
}
async function refreshSkills() {
  const value = await props.api(base + "/capabilities");
  if (disposed) return;
  canEdit.value = value.canEdit;
  skills.value = value.skills;
  servers.value = value.mcp;
  if (!value.canEdit) { mcp.value = {}; detail.value = null; }
  return value;
}
async function importSkill() {
  const file = upload.value?.files?.[0];
  if (!canEdit.value || !file) return;
  await run(async () => {
    if (file.size > 32 * 1024 * 1024) throw Error("技能包不能超过32MiB");
    const content = await new Promise((yes, no) => {
      const reader = new FileReader();
      reader.onload = () => yes(String(reader.result).split(",")[1]);
      reader.onerror = no;
      reader.readAsDataURL(file);
    });
    if (disposed) return;
    await props.api(base + "/skills/upload", "POST", { filename: file.name, content, replace: replace.value });
    if (disposed) return;
    upload.value.value = "";
    detail.value = null;
    await refreshSkills();
    emit("notice", "技能已保存到当前牛马");
  });
}
async function showSkill(skill) {
  if (!canEdit.value) return;
  await run(async () => {
    const value = await props.api(base + "/skills/" + encodeURIComponent(skill.id));
    if (!disposed) detail.value = value;
  });
}
async function removeSkill(skill) {
  if (!canEdit.value || !confirm("移除当前牛马的这个技能？")) return;
  await run(async () => {
    await props.api(base + "/skills/" + encodeURIComponent(skill.id), "DELETE");
    detail.value = null;
    await refreshSkills();
  });
}
async function saveMcp() {
  if (!canEdit.value) return;
  await run(async () => {
    const next = Object.fromEntries(Object.entries(mcp.value).map(([name, text]) => {
      let config;
      try { config = JSON.parse(text); }
      catch { throw Error(`MCP「${name}」的 JSON 格式无效`); }
      validateMcpServer(config, name);
      return [name, config];
    }));
    await props.api(base + "/mcp", "PUT", { mcp: next });
    const value = await refreshSkills();
    if (!value || disposed) return;
    mcp.value = Object.fromEntries(value.mcp.map((entry) => [entry.name, JSON.stringify(entry.config, null, 2)]));
    emit("notice", "当前牛马的 MCP 已保存");
  });
}
function addMcp() {
  if (!canEdit.value) return;
  const key = mcpName.value.trim();
  if (!key) return;
  // 名称框被粘进整段 JSON 时不要建出一个存不下的名字（服务端同样拒绝，这里先就地拦住）。
  if (key.length > 100 || /[\x00-\x1f]/.test(key)) return emit("error", "MCP 名称最多 100 个字符、不能换行；JSON 配置写在右侧内容框里");
  if (Object.hasOwn(mcp.value, key)) return emit("error", "MCP名称已存在");
  mcp.value = { ...mcp.value, [key]: '{\n  "url": "https://example.com/mcp"\n}' };
  mcpName.value = "";
}
onMounted(() => void run(async () => {
  const value = await refreshSkills();
  if (value?.canEdit) mcp.value = Object.fromEntries(value.mcp.map((entry) => [entry.name, JSON.stringify(entry.config, null, 2)]));
}));
onBeforeUnmount(() => { disposed = true; });
</script>
<template>
  <div class="page-scroll capabilities">
    <p class="callout capabilities-warning"><Icon name="alert" :size="14" /><span>本系统设计架构不推荐使用 Skill 或 MCP，后续有可能会移除相关支持，请谨慎使用。</span></p>
    <section class="card">
      <div class="card-head"><h3>技能</h3><p v-if="canEdit" class="hint">上传 ZIP 技能包；勾选覆盖可更新当前牛马的同名技能。</p></div>
      <div v-if="canEdit" class="upload-row">
        <input ref="upload" type="file" accept=".zip" aria-label="选择技能ZIP文件" :disabled="busy" />
        <label class="check"><input v-model="replace" type="checkbox" />覆盖同名技能</label>
        <button class="primary sm" :disabled="busy" @click="importSkill"><Icon name="plus" :size="14" />上传技能</button>
      </div>
      <p v-if="!skills.length" class="empty-state">尚未配置技能</p>
      <ul v-else class="item-list">
        <li v-for="skill in skills" :key="skill.name"><span class="item-text"><strong>{{ skill.name }}</strong><small v-if="canEdit">{{ skill.description }}</small></span><template v-if="canEdit"><button type="button" class="sm" :disabled="busy" @click="showSkill(skill)">详情</button><button type="button" class="sm danger-text" :disabled="busy" @click="removeSkill(skill)">移除</button></template></li>
      </ul>
      <section v-if="canEdit && detail" class="skill-detail"><div class="card-head row"><h4>{{ detail.name }}</h4><button type="button" class="icon sm" aria-label="关闭技能详情" @click="detail = null"><Icon name="close" :size="14" /></button></div><p class="hint">文件：{{ detail.files.join('、') }}</p><pre>{{ detail.content }}</pre></section>
    </section>
    <section class="card">
      <div class="card-head row"><h3>MCP</h3><button v-if="canEdit" class="primary sm" :disabled="busy" @click="saveMcp">保存 MCP</button></div>
      <template v-if="canEdit">
        <p class="hint">每项配置一个 JSON 对象：远程服务使用 url / headers，本地进程使用 command / args / env。保留 __stored_secret__ 可保留已有密钥。</p>
        <p v-if="!Object.keys(mcp).length" class="empty-state">尚未配置 MCP</p>
        <div v-for="(json, key) in mcp" :key="key" class="mcp-row"><strong>{{ key }}</strong><textarea v-model="mcp[key]" rows="8" spellcheck="false" :aria-label="key + ' JSON配置'" :disabled="busy"></textarea><button type="button" class="icon sm" :disabled="busy" :aria-label="'移除 ' + key" @click="{ const next = { ...mcp }; delete next[key]; mcp = next; }"><Icon name="trash" :size="15" /></button></div>
        <div class="mcp-add"><input v-model="mcpName" placeholder="名称" aria-label="MCP名称" :disabled="busy" /><button type="button" class="sm" :disabled="busy" @click="addMcp">添加 MCP</button></div>
      </template>
      <template v-else><p v-if="!servers.length" class="empty-state">尚未配置 MCP</p><ul v-else class="item-list"><li v-for="server in servers" :key="server.name">{{ server.name }}</li></ul></template>
    </section>
  </div>
</template>
<style scoped>
.capabilities { display: grid; align-content: start; gap: 16px; }
.capabilities > * { width: 100%; max-width: 1000px; }
.capabilities-warning { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-border); }
.card-head { display: grid; gap: 4px; margin-bottom: 12px; }
.card-head.row { display: flex; align-items: center; justify-content: space-between; }
.upload-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
.upload-row input[type="file"] { flex: 1; min-width: 160px; }
.item-list { list-style: none; margin: 0; padding: 0; }
.item-list li { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid var(--border); }
.item-text { display: grid; gap: 2px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.item-text small { color: var(--muted); }
.skill-detail { margin-top: 12px; }
.skill-detail pre { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 var(--mono); }
.mcp-row { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; align-items: start; gap: 8px; margin-top: 12px; }
.mcp-row strong { overflow-wrap: anywhere; }
.mcp-row textarea { min-width: 0; font-family: var(--mono); }
.mcp-add { display: flex; gap: 8px; margin-top: 12px; }
.mcp-add input { flex: 1; min-width: 0; }
@media (max-width: 767px) { .mcp-row { grid-template-columns: minmax(0, 1fr) auto; } .mcp-row strong { grid-column: 1 / -1; } }
</style>
