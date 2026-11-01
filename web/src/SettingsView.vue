<script setup vapor>
import { onMounted, ref, watch } from "vue";
import ProviderSettings from "./ProviderSettings.vue";
import SceneSettings from "./SceneSettings.vue";
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
  mcpURL = ref(""),
  vault = ref([]),
  vaultForm = ref({ name: "", condition: "", content: "" });
watch(
  () => props.config,
  () => {
    mcp.value = copy(props.config.mcp || {});
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
    next.mcp = mcp.value;
    emit("saved", await props.api("/config", "PUT", next));
    emit("notice", "MCP已保存");
  });
}
function addMcp() {
  const key = mcpName.value.trim();
  if (!key) return;
  mcp.value = { ...mcp.value, [key]: { url: mcpURL.value.trim() } };
  mcpName.value = "";
  mcpURL.value = "";
}
async function loadVault() {
  const result = await props.api("/vault");
  vault.value = result.entries || result;
}
async function saveVault() {
  await run(async () => {
    await props.api("/vault", "POST", { ...vaultForm.value });
    vaultForm.value = { name: "", condition: "", content: "" };
    await loadVault();
    emit("notice", "凭据已加密保存");
  });
}
async function removeVault(item) {
  if (!confirm('永久删除此凭据？')) return;
  await run(async () => {
    await props.api("/vault/" + encodeURIComponent(item.id), "DELETE");
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
      <h3>密码本</h3>
      <p class="hint">
        凭据加密保存，供数字员工在符合条件时取用；只有管理员能修改。
      </p>
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
            required
            rows="3"
            maxlength="16000"
            autocomplete="off"
          ></textarea
        ></label>
        <button class="primary" :disabled="busy">加密保存</button>
      </form>
      <p v-if="!vault.length" class="hint">还没有凭据</p>
      <ul class="skill-items">
        <li v-for="item in vault" :key="item.id">
          <strong>{{ item.name }}</strong
          ><small>{{ item.condition }}</small
          ><button @click="removeVault(item)">删除凭据</button>
        </li>
      </ul>
    </section>
    <section class="card">
      <div class="section-heading">
        <h3>MCP</h3>
        <button :disabled="busy" @click="saveMcp">保存</button>
      </div>
      <div v-for="(server, key) in mcp" :key="key" class="mcp-row">
        <strong>{{ key }}</strong
        ><input
          v-if="server.url !== undefined"
          v-model="server.url"
          type="url"
          :aria-label="key + '地址'"
        /><input
          v-else
          v-model="server.command"
          :aria-label="key + '命令'"
          placeholder="服务端命令"
        /><button
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
        /><input
          v-model="mcpURL"
          type="url"
          placeholder="https://example.com/mcp"
          aria-label="MCP地址"
        /><button @click="addMcp">添加</button>
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
.mcp-row input {
  flex: 1;
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
