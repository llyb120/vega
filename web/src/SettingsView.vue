<script setup vapor>
import { onMounted, ref, watch } from "vue";
import ProviderSettings from "./ProviderSettings.vue";
import SceneSettings from "./SceneSettings.vue";
import { validateMcpServer } from "../../shared/mcp-config";
const confirm = window.confirm.bind(window);
const props = defineProps({
  api: Function,
  config: Object,
  models: Array,
  userId: String,
});
const emit = defineEmits(["saved", "error", "notice"]);
const copy = (value) => JSON.parse(JSON.stringify(value));
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
  <header class="topbar"><h2>设置</h2></header>
  <div class="page-scroll settings">
    <ProviderSettings
      :api="api"
      :config="config"
      :user-id="userId"
      @saved="emit('saved', $event)"
      @error="emit('error', $event)"
      @notice="emit('notice', $event)"
    />
    <SceneSettings
      :api="api"
      :config="config"
      :models="models"
      @saved="emit('saved', $event)"
      @error="emit('error', $event)"
      @notice="emit('notice', $event)"
    />
    <section class="card">
      <h3>技能</h3>
      <div class="inline-form">
        <input
          ref="upload"
          type="file"
          accept=".zip"
          aria-label="选择技能ZIP文件"
        /><button :disabled="busy" @click="importSkill">上传技能</button>
      </div>
      <label><input v-model="replace" type="checkbox" />覆盖同名技能</label>
      <p v-if="!skills.length" class="hint">还没有导入技能</p>
      <ul class="skill-items">
        <li v-for="s in skills" :key="s.id">
          <strong>{{ s.name }}</strong
          ><small>{{ s.description }}</small
          ><button
            @click="
              run(async () => {
                if (confirm('移除这个技能？')) {
                  await api('/skills/' + encodeURIComponent(s.id), 'DELETE');
                  await refreshSkills();
                }
              })
            "
          >
            移除
          </button>
        </li>
      </ul>
    </section>
    <section class="card">
      <div class="section-heading">
        <h3>密码本 · {{ vault.length }} 条</h3>
        <button :disabled="busy" @click="newVault">新增凭据</button>
      </div>
      <p class="hint">
        可分别保存多条账号、密码或密钥，每条有独立的使用条件；凭据加密保存，只有管理员能修改。
      </p>
      <p v-if="vaultForm.id" class="hint">正在编辑「{{ vaultForm.name }}」，凭据留空保留原内容。</p>
      <form class="form-grid" @submit.prevent="saveVault">
        <label
          >名称<input
            v-model="vaultForm.name"
            required
            maxlength="100"
            placeholder="不要包含密钥内容"
        /></label>
        <label
          >允许使用的条件<input
            v-model="vaultForm.condition"
            required
            maxlength="500"
        /></label>
        <label
          >凭据<textarea
            v-model="vaultForm.content"
            :required="!vaultForm.id"
            rows="3"
            maxlength="16000"
            autocomplete="off"
          ></textarea
        ></label>
        <button class="primary" :disabled="busy">{{ vaultForm.id ? '保存修改' : '新增并加密保存' }}</button>
      </form>
      <p v-if="!vault.length" class="hint">还没有凭据</p>
      <ul class="skill-items">
        <li v-for="item in vault" :key="item.id">
          <strong>{{ item.name }}</strong
          ><small>{{ item.condition }}</small
          ><button :disabled="busy" @click="editVault(item)">编辑</button
          ><button :disabled="busy" @click="removeVault(item)">删除凭据</button>
        </li>
      </ul>
    </section>
    <section class="card">
      <div class="section-heading">
        <h3>MCP</h3>
        <button :disabled="busy" @click="saveMcp">保存</button>
      </div>
      <p class="hint">每个 MCP 单独配置一个 JSON 对象：远程服务使用 url / headers，本地进程使用 command / args / env；不要包含 mcpServers 外层。保留 __stored_secret__ 可保留已有密钥。</p>
      <div v-for="(json, key) in mcp" :key="key" class="mcp-row">
        <strong>{{ key }}</strong>
        <textarea v-model="mcp[key]" rows="8" spellcheck="false" :aria-label="key + ' JSON配置'"></textarea><button
          @click="
            {
              const next = { ...mcp };
              delete next[key];
              mcp = next;
            }
          "
        >
          移除
        </button>
      </div>
      <div class="inline-form">
        <input
          v-model="mcpName"
          placeholder="名称"
          aria-label="MCP名称"
        /><button :disabled="busy" @click="addMcp">添加 MCP</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.skill-items {
  list-style: none;
  padding: 0;
  margin: 14px 0 0;
}
.skill-items li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.skill-items small {
  flex: 1;
}
.mcp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.mcp-row textarea {
  flex: 1;
  min-width: 0;
  font-family: monospace;
}
.mcp-row strong {
  min-width: 100px;
}
.card > h3 {
  margin-bottom: 14px;
}
@media (max-width: 760px) {
  .mcp-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .mcp-row textarea {
    grid-column: 1/-1;
    width: 100%;
  }
  .mcp-row strong {
    grid-column: 1/-1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .skill-items li {
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .skill-items strong {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .skill-items small {
    order: 1;
    flex-basis: 100%;
    overflow-wrap: anywhere;
  }
}
</style>
