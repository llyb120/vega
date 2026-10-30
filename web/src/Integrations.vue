<script setup vapor>
import { onMounted, ref } from "vue";
const props = defineProps({ api: Function });
const emit = defineEmits(["saved", "error", "notice"]);
const source = ref("codebuddy"),
  site = ref("global"),
  sources = ["codebuddy", "workbuddy", "devin", "codex", "claude-code"],
  login = ref(null),
  pasted = ref(""),
  busy = ref(false),
  models = ref([]),
  chrome = ref(null),
  tabs = ref([]),
  graph = ref(null),
  paths = ref({ workbuddyPath: "", devinPath: "" });
const skillPath = ref(""),
  installedSkills = ref([]),
  replaceSkill = ref(false);
async function refreshSkills() {
  installedSkills.value = await props.api("/skills");
}
async function importSkill() {
  await run(async () => {
    await props.api("/skills", "POST", {
      path: skillPath.value,
      replace: replaceSkill.value,
    });
    await refreshSkills();
    skillPath.value = "";
    emit(
      "notice",
      "技能及附属脚本/资源已存入SQLite；新轮次先读取技能正文，不自动执行导入脚本。",
    );
  });
}
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
async function begin() {
  await run(async () => {
    login.value = await props.api("/providers/login", "POST", {
      action: "start",
      source: source.value,
      site: site.value,
    });
    window.open(login.value.url, "_blank", "noopener,noreferrer");
    emit(
      "notice",
      "已打开官方登录页；登录完成后检查状态，异机回调可粘贴完整跳转地址。",
    );
  });
}
async function check() {
  if (!login.value) return;
  await run(async () => {
    const value = await props.api("/providers/login", "POST", {
      action: "poll",
      source: source.value,
      state: login.value.state,
      pasted: pasted.value || undefined,
    });
    if (value.complete) {
      login.value = null;
      pasted.value = "";
      emit("notice", "登录已保存到 SQLite，请导入本地服务商并刷新模型。");
    } else emit("notice", "尚未完成登录，本次未重新发起登录。");
  });
}
async function importProvider() {
  await run(async () => {
    const result = await props.api("/providers/import", "POST", {
      source: source.value,
      id: source.value,
    });
    models.value = result.models || [];
    emit("saved", result.config);
  });
}
async function refresh() {
  await run(async () => {
    models.value = await props.api("/providers/models", "POST", {
      force: true,
    });
  });
}
async function connect() {
  await run(async () => {
    chrome.value = await props.api("/chrome", "POST", { operation: "connect" });
  });
}
async function listTabs() {
  await run(async () => {
    const result = await props.api("/chrome/tool", "POST", {
      operation: "tabs",
      visual: "none",
    });
    tabs.value = result.tabs || [];
  });
}
async function experiences() {
  await run(async () => {
    graph.value = await props.api("/experiences");
  });
}
onMounted(() => {
  void connect();
});
</script>
<template>
  <section class="card">
    <h3>订阅与本地 CLI</h3>
    <p>
      CodeBuddy / WorkBuddy 站点登录、令牌刷新和账号模型目录；Devin 使用 PKCE
      与原生 Connect/Protobuf；Codex / Claude Code 只读使用本地订阅或自定义 API
      配置。
    </p>
    <div class="inline-form">
      <select v-model="source" aria-label="订阅来源">
        <option v-for="s in sources" :key="s">{{ s }}</option></select
      ><select
        v-if="source === 'codebuddy'"
        v-model="site"
        aria-label="CodeBuddy站点"
      >
        <option value="global">国际站</option>
        <option value="cn">中国站</option></select
      ><button
        v-if="['codebuddy', 'workbuddy', 'devin'].includes(source)"
        :disabled="busy"
        @click="begin"
      >
        官方网页登录</button
      ><button class="primary" :disabled="busy" @click="importProvider">
        导入服务商</button
      ><button :disabled="busy" @click="refresh">刷新账号模型</button
      ><button
        @click="
          run(async () => {
            await api('/providers/login', 'POST', { action: 'logout', source });
            emit('notice', 'Vega内登录已退出，不修改CLI凭据');
          })
        "
      >
        退出应用内登录
      </button>
    </div>
    <div v-if="login" class="context-note">
      <a :href="login.url" target="_blank" rel="noopener noreferrer"
        >重新打开本次官方登录页 ↗</a
      ><input
        v-if="source === 'devin'"
        v-model="pasted"
        placeholder="跨设备：粘贴包含正确 state 的完整回调地址"
      /><button @click="check" :disabled="busy">检查本次登录状态</button>
    </div>
    <details>
      <summary>本地可执行文件路径（可选）</summary>
      <div class="inline-form">
        <input
          v-model="paths.workbuddyPath"
          placeholder="WorkBuddy.exe 完整路径"
        /><input
          v-model="paths.devinPath"
          placeholder="Devin CLI 路径，默认 devin"
        /><button
          @click="
            run(async () => {
              await api('/providers/paths', 'PUT', paths);
              emit('notice', '路径已保存');
            })
          "
        >
          保存路径
        </button>
      </div>
    </details>
    <details v-if="models.length">
      <summary>模型目录 {{ models.length }} 项</summary>
      <ul>
        <li v-for="m in models" :key="m.id || m.provider">
          <span>{{ m.id || m.provider }} · {{ m.name || m.error }}</span
          ><small v-if="m.variants?.length">
            档位：{{ m.variants.join(" / ") }}</small
          >
        </li>
      </ul>
    </details>
    <details>
      <summary>导入 Agent Skill</summary>
      <p class="hint">
        服务端技能目录、ZIP或SKILL.md路径；正文和附属资源均存于SQLite。未指定目录时只读发现已有Nova/Lyra技能；不改写它们。
      </p>
      <label
        ><input
          v-model="replaceSkill"
          type="checkbox"
        />确认覆盖同名已安装技能</label
      >
      <button @click="run(refreshSkills)">查看已导入技能</button>
      <ul>
        <li v-for="s in installedSkills" :key="s.id">
          {{ s.name }} · {{ s.files.length }} 个文件
          <button
            @click="
              run(async () => {
                if (confirm('移除此技能索引？现有会话引用的归档资源仍保留。')) {
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
      <form class="inline-form" @submit.prevent="importSkill">
        <input
          v-model="skillPath"
          required
          placeholder="服务端技能目录 / .zip / SKILL.md"
        /><button :disabled="busy">导入技能</button>
      </form>
    </details>
    <p class="hint">
      读取CLI凭据不会改写或刷新其他进程的登录；应用内CodeBuddy/WorkBuddy登录会按官方协议续期。Devin
      Adaptive 与原项目一样不支持自动路由，选择具体模型。
    </p>
  </section>
  <section class="card">
    <div class="section-heading">
      <h3>Chrome 扩展 · 全功能引擎</h3>
      <button @click="connect">刷新连接</button>
    </div>
    <p>
      使用原版独立 Chrome 扩展和隔离世界 DOM 引擎，支持 iframe、Shadow
      DOM、下载、DevTools、运行计划、截图分片/长图、像素坐标校验与经验图谱。
    </p>
    <p :class="['pill', chrome?.connected ? 'green' : '']">
      {{ chrome?.connected ? "已连接 " + chrome.browser : "尚未连接扩展" }} ·
      {{ chrome?.origin || "本机回环桥接" }}
    </p>
    <ol>
      <li>
        解压部署目录中的 <code>extensions/nova-chrome</code>（生产输出为
        <code>.output/public/extension/nova-chrome</code>）。
      </li>
      <li>
        打开 <code>chrome://extensions</code>，启用开发者模式，加载已解压扩展。
      </li>
      <li>扩展自动配对回环端口；无痕操作需在扩展详情允许无痕运行。</li>
    </ol>
    <div class="actions">
      <button @click="listTabs">标签页列表</button
      ><button @click="experiences">经验图谱</button>
    </div>
    <ul class="browser-tabs">
      <li v-for="t in tabs" :key="t.tag">
        <strong>{{ t.title || "新标签页" }}</strong
        ><small>{{ t.tag }} · {{ t.url }}</small>
      </li>
    </ul>
    <details v-if="graph">
      <summary>已验证路径与未尝试分支</summary>
      <pre>{{ JSON.stringify(graph, null, 2) }}</pre>
    </details>
    <p class="hint">
      扩展只接受认证过的本机实例命令，不会因当前激活页变化而猜测目标。操作超时可能已执行，工具不会自动重放。
    </p>
  </section>
</template>
