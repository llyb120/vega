<script setup vapor>
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
const confirm = window.confirm.bind(window);
const props = defineProps({ api: Function, config: Object, userId: String });
const emit = defineEmits(["saved", "error", "notice"]);
const presets = ref([]),
  selected = ref(""),
  creating = ref(false),
  id = ref(""),
  name = ref(""),
  preset = ref("openai-compatible"),
  apiType = ref("openai-completions"),
  baseURL = ref(""),
  apiKey = ref(""),
  modelMap = ref({}),
  draft = ref({}),
  busy = ref(false),
  query = ref(""),
  modelID = ref(""),
  editingModel = ref(""),
  site = ref("global"),
  login = ref(null),
  pasted = ref(""),
  loginError = ref(""),
  headers = ref("{}"),
  options = ref("{}");
let pollTimer,
  disposed = false,
  polling = false;
const copy = (value) => JSON.parse(JSON.stringify(value));
const protocols = [
  ["openai-completions", "OpenAI Chat"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic"],
];
const localSources = {
  "local-codex": "codex",
  "local-claude-code": "claude-code",
  codebuddy: "codebuddy",
  workbuddy: "workbuddy",
  devin: "devin",
};
const source = computed(() => localSources[preset.value]),
  webLogin = computed(() =>
    ["codebuddy", "workbuddy", "devin"].includes(source.value),
  ),
  providers = computed(() => Object.entries(props.config.provider || {})),
  visibleModels = computed(() =>
    Object.entries(modelMap.value).filter(([key, m]) =>
      (key + " " + (m.name || ""))
        .toLowerCase()
        .includes(query.value.toLowerCase()),
    ),
  );
function savePending(attempt = login.value) {
  // Only the short-lived attempt is cached; codes, PKCE verifier and tokens stay off the browser.
  try {
    const key = "vega:provider-login:" + props.userId;
    if (attempt) sessionStorage.setItem(key, JSON.stringify(attempt));
    else sessionStorage.removeItem(key);
  } catch {}
}
function restorePending() {
  try {
    const attempt = JSON.parse(
      sessionStorage.getItem("vega:provider-login:" + props.userId) || "null",
    );
    if (!attempt) return;
    const url = new URL(attempt.url),
      family = {
        codebuddy: ["codebuddy.cn", "codebuddy.ai"],
        workbuddy: ["workbuddy.cn"],
        devin: ["devin.ai"],
      }[attempt.source];
    if (
      !family ||
      typeof attempt.state !== "string" ||
      !/^[\w.-]{1,80}$/.test(attempt.id) ||
      !(
        attempt.expires > Date.now() && attempt.expires <= Date.now() + 600000
      ) ||
      url.protocol !== "https:" ||
      !family.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith("." + domain),
      )
    )
      return savePending(null);
    edit(
      props.config.provider?.[attempt.id] ? attempt.id : "",
      props.config.provider?.[attempt.id] || {
        preset: attempt.source,
        name: attempt.name,
      },
    );
    id.value = attempt.id;
    login.value = attempt;
    void poll();
  } catch {
    savePending(null);
  }
}
function resumeLogin() {
  if (!document.hidden && login.value && !busy.value) {
    stopPolling();
    void poll();
  }
}
function stopPolling() {
  clearTimeout(pollTimer);
}
function edit(key, raw) {
  stopPolling();
  login.value = null;
  loginError.value = "";
  creating.value = !key;
  selected.value = key;
  id.value = key || "provider-" + (providers.value.length + 1);
  draft.value = copy(raw || {});
  name.value = raw?.name || key || "";
  preset.value = raw?.preset || "openai-compatible";
  apiType.value = raw?.api || "openai-completions";
  baseURL.value =
    raw?.options?.baseURL ||
    raw?.baseURL ||
    presets.value.find((p) => p.id === preset.value)?.baseURL ||
    "";
  apiKey.value = raw?.options?.apiKey || raw?.apiKey || "";
  modelMap.value = flatten(raw?.models || {});
  headers.value = JSON.stringify(
    raw?.options?.headers || raw?.headers || {},
    null,
    2,
  );
  const o = { ...raw?.options };
  delete o.baseURL;
  delete o.apiKey;
  delete o.headers;
  options.value = JSON.stringify(o, null, 2);
  query.value = "";
  editingModel.value = "";
}
function flatten(models, prefix = "") {
  const out = {};
  for (const [key, v] of Object.entries(models)) {
    if (
      !Object.keys(v || {}).length ||
      [
        "name",
        "api",
        "options",
        "limit",
        "variants",
        "modalities",
        "reasoning",
        "supportsImages",
        "contextWindow",
      ].some((k) => k in v)
    )
      out[prefix + key] = copy(v);
    else Object.assign(out, flatten(v, prefix + key + "/"));
  }
  return out;
}
function choosePreset() {
  const p = presets.value.find((p) => p.id === preset.value);
  baseURL.value = p?.baseURL || "";
  apiType.value = /minimax|kimi-code/.test(preset.value)
    ? "anthropic-messages"
    : "openai-completions";
  if (creating.value) {
    id.value =
      preset.value === "openai-compatible"
        ? "provider-" + (providers.value.length + 1)
        : preset.value;
    name.value = p?.name || "";
  }
  modelMap.value = {};
}
function provider() {
  const row = {
    ...draft.value,
    name: name.value.trim() || id.value,
    preset: preset.value,
    models: copy(modelMap.value),
    options: {
      ...JSON.parse(options.value || "{}"),
      headers: JSON.parse(headers.value || "{}"),
    },
  };
  if (!source.value) {
    row.api = apiType.value;
    row.options.baseURL = baseURL.value.trim();
    row.options.apiKey = apiKey.value;
    delete row.baseURL;
    delete row.apiKey;
    delete row.headers;
  } else {
    delete row.api;
    delete row.options.baseURL;
    delete row.options.apiKey;
    delete row.options.headers;
  }
  return row;
}
async function run(fn) {
  if (busy.value) return;
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    emit("error", e.message);
  } finally {
    busy.value = false;
  }
}
async function discover() {
  await run(async () => {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id.value)) throw Error("请填写服务商ID");
    const result = await props.api("/providers/discover", "POST", {
      id: id.value,
      provider: provider(),
    });
    modelMap.value = { ...result.models, ...modelMap.value };
    emit("notice", `已获取 ${Object.keys(result.models).length} 个模型`);
  });
}
async function save() {
  await run(async () => {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id.value))
      throw Error("服务商ID仅支持字母、数字、点、下划线和横线");
    if (creating.value && props.config.provider?.[id.value])
      throw Error("服务商ID已存在");
    const next = copy(props.config);
    next.provider ||= {};
    next.provider[id.value] = provider();
    const first = Object.keys(modelMap.value)[0];
    if (!next.model && first) next.model = id.value + "/" + first;
    const saved = await props.api("/config", "PUT", next);
    creating.value = false;
    selected.value = id.value;
    emit("saved", saved);
    edit(id.value, saved.provider[id.value]);
    emit("notice", "服务商已保存");
  });
}
async function remove(key) {
  if (!confirm("删除此服务商？使用它的场景模型也会移除。")) return;
  await run(async () => {
    const next = copy(props.config);
    delete next.provider[key];
    for (const s in next.scenes || {})
      next.scenes[s] = next.scenes[s].filter((m) => !m.startsWith(key + "/"));
    if (next.model?.startsWith(key + "/")) next.model = "";
    emit("saved", await props.api("/config", "PUT", next));
    edit("", {});
    emit("notice", "已删除服务商");
  });
}
function addModel() {
  const key = modelID.value.trim();
  if (!key) return;
  modelMap.value = {
    ...modelMap.value,
    [key]: modelMap.value[key] || {
      name: key,
      limit: { context: 200000, output: 32000 },
      modalities: { input: ["text"] },
    },
  };
  editingModel.value = key;
  modelID.value = "";
}
function limitValue(key, field, value) {
  const m = modelMap.value[key];
  m.limit = { ...m.limit, [field]: Number(value) };
}
function imageValue(key, enabled) {
  modelMap.value[key].supportsImages = enabled;
  modelMap.value[key].modalities = {
    ...modelMap.value[key].modalities,
    input: enabled ? ["text", "image"] : ["text"],
  };
}
async function finishLogin(attempt) {
  const result = await props.api("/providers/import", "POST", {
    source: attempt.source,
    id: attempt.id,
    name: attempt.name,
  });
  if (disposed) return;
  savePending(null);
  emit("saved", result.config);
  edit(attempt.id, result.config.provider[attempt.id]);
  emit("notice", "登录成功，模型已就绪");
}
async function poll(manual = false) {
  const attempt = login.value;
  if (!attempt || polling) return;
  polling = true;
  try {
    const result = attempt.complete
      ? { complete: true }
      : await props.api("/providers/login", "POST", {
          action: "poll",
          source: attempt.source,
          state: attempt.state,
          pasted: manual ? pasted.value || undefined : undefined,
        });
    if (disposed || login.value !== attempt) return;
    if (result.complete) {
      attempt.complete = true;
      savePending(attempt);
      stopPolling();
      await finishLogin(attempt);
    } else if (Date.now() < attempt.expires)
      pollTimer = setTimeout(() => void poll(), 2000);
    else {
      loginError.value = "登录已过期，请重新开始";
      savePending(null);
    }
  } catch (e) {
    if (!disposed) {
      loginError.value = e.message;
      stopPolling();
    }
  } finally {
    polling = false;
  }
}
async function begin(manual = false) {
  if (busy.value) return;
  const requested = {
    source: source.value,
    id: id.value || source.value,
    name: name.value,
    site: site.value,
  };
  const target = window.open("about:blank", "_blank");
  if (target) target.opener = null;
  await run(async () => {
    try {
      stopPolling();
      loginError.value = "";
      pasted.value = "";
      const result = await props.api("/providers/login", "POST", {
        action: "start",
        source: requested.source,
        site: requested.site,
        manual: manual === true,
      });
      const attempt = {
        ...result,
        source: requested.source,
        id: requested.id,
        name: requested.name,
        expires: Date.now() + 600000,
      };
      login.value = attempt;
      savePending(attempt);
      if (target) target.location.replace(result.url);
      pollTimer = setTimeout(() => void poll(), 1500);
    } catch (e) {
      target?.close();
      throw e;
    }
  });
}
async function localImport() {
  await run(async () => {
    const result = await props.api("/providers/import", "POST", {
      source: source.value,
      name: name.value,
      id: id.value || source.value,
    });
    emit("saved", result.config);
    edit(
      id.value || source.value,
      result.config.provider[id.value || source.value],
    );
    emit("notice", "已读取服务端登录");
  });
}
watch(
  () => props.config.provider,
  () => {
    if (
      !creating.value &&
      selected.value &&
      props.config.provider?.[selected.value] &&
      !login.value
    )
      edit(selected.value, props.config.provider[selected.value]);
  },
);
onMounted(
  () =>
    void run(async () => {
      presets.value = await props.api("/providers/presets");
      if (disposed) return;
      const first = providers.value[0];
      if (first) edit(...first);
      else edit("", {});
      restorePending();
      document.addEventListener("visibilitychange", resumeLogin);
      window.addEventListener("pageshow", resumeLogin);
      window.addEventListener("online", resumeLogin);
    }),
);
onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
  document.removeEventListener("visibilitychange", resumeLogin);
  window.removeEventListener("pageshow", resumeLogin);
  window.removeEventListener("online", resumeLogin);
});
</script>
<template>
  <section class="card provider-settings">
    <div class="section-heading">
      <h3>服务商</h3>
      <button @click="edit('', {})" :disabled="busy">＋ 添加服务商</button>
    </div>
    <div class="provider-layout">
      <aside class="provider-list">
        <button
          v-for="[key, p] in providers"
          :key="key"
          :class="{ selected: selected === key && !creating }"
          @click="edit(key, p)"
        >
          {{ p.name || key }}<small>{{ key }}</small>
        </button>
        <p v-if="!providers.length" class="hint">还没有服务商</p>
      </aside>
      <form class="provider-form" @submit.prevent="save">
        <div class="form-grid">
          <label
            >服务商类型<select v-model="preset" @change="choosePreset">
              <option v-for="p in presets" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select></label
          >
          <label
            >名称<input
              v-model="name"
              required
              placeholder="例如：我的 CodeBuddy"
          /></label>
        </div>
        <template v-if="!source"
          ><div class="form-grid">
            <label
              >接口格式<select v-model="apiType">
                <option
                  v-for="[value, label] in protocols"
                  :key="value"
                  :value="value"
                >
                  {{ label }}
                </option>
              </select></label
            ><label
              >API地址<input
                v-model="baseURL"
                required
                type="url"
                placeholder="https://api.example.com/v1" /></label
            ><label
              >API Key<input
                v-model="apiKey"
                type="password"
                autocomplete="off"
                :placeholder="
                  apiKey === '__stored_secret__'
                    ? '已保存，留原值保留'
                    : 'API Key 或 {env:NAME}'
                "
            /></label></div
        ></template>
        <div v-else class="provider-login">
          <div class="inline-form">
            <select
              v-if="source === 'codebuddy'"
              v-model="site"
              aria-label="CodeBuddy站点"
              :disabled="!!login"
            >
              <option value="global">国际站</option>
              <option value="cn">中国站</option></select
            ><button
              v-if="webLogin"
              type="button"
              class="primary"
              @click="begin"
              :disabled="busy"
            >
              {{ login ? "重新登录" : "登录 " + (name || source) }}</button
            ><button type="button" @click="localImport" :disabled="busy">
              读取服务端已有登录</button
            ><button
              v-if="webLogin && !creating"
              type="button"
              @click="
                run(async () => {
                  if (confirm('退出此服务商的网页登录？')) {
                    stopPolling();
                    await api('/providers/login', 'POST', {
                      action: 'logout',
                      source,
                    });
                    login = null;
                    savePending(null);
                    emit('notice', '已退出服务商登录');
                  }
                })
              "
            >
              退出登录
            </button>
          </div>
          <div v-if="login" class="login-progress">
            <p>请在新窗口完成登录，完成后这里会自动更新。</p>
            <a :href="login.url" target="_blank" rel="noopener noreferrer"
              >未打开窗口？点击继续登录 ↗</a
            >
            <details v-if="login.source === 'devin'">
              <summary>没有自动返回？</summary>
              <p class="hint">复制登录后浏览器最后跳转的完整地址到这里。</p>
              <button type="button" @click="begin(true)">
                改用手动回调登录
              </button>
              <input
                v-model="pasted"
                placeholder="粘贴本次登录的回调地址"
                autocomplete="off"
              /><button type="button" @click="poll(true)">完成登录</button>
            </details>
            <p v-if="loginError" class="error" role="alert">{{ loginError }}</p>
            <button type="button" @click="poll(true)">检查登录结果</button>
          </div>
        </div>
        <div class="section-heading">
          <h3>
            模型 <small>{{ Object.keys(modelMap).length }}</small>
          </h3>
          <button type="button" @click="discover" :disabled="busy">
            获取模型
          </button>
        </div>
        <input v-model="query" placeholder="搜索模型" aria-label="搜索模型" />
        <div class="model-list">
          <div v-for="[key, m] in visibleModels" :key="key" class="model-row">
            <button
              type="button"
              class="model-name"
              @click="editingModel = editingModel === key ? '' : key"
            >
              <strong>{{ m.name || key }}</strong
              ><small>{{ key }}</small></button
            ><span
              v-if="m.supportsImages || m.modalities?.input?.includes('image')"
              class="pill"
              >图片</span
            ><button
              type="button"
              class="link"
              @click="
                {
                  const next = { ...modelMap };
                  delete next[key];
                  modelMap = next;
                }
              "
            >
              移除
            </button>
            <div v-if="editingModel === key" class="model-edit form-grid">
              <label>显示名称<input v-model="m.name" /></label
              ><label
                >上下文长度<input
                  :value="m.limit?.context || m.contextWindow || 200000"
                  type="number"
                  min="1024"
                  @change="
                    limitValue(key, 'context', $event.target.value)
                  " /></label
              ><label
                >输出上限<input
                  :value="m.limit?.output || m.maxOutputTokens || 32000"
                  type="number"
                  min="32"
                  @change="
                    limitValue(key, 'output', $event.target.value)
                  " /></label
              ><label
                ><input
                  :checked="
                    m.supportsImages || m.modalities?.input?.includes('image')
                  "
                  type="checkbox"
                  @change="imageValue(key, $event.target.checked)"
                />支持图片</label
              ><label
                ><input v-model="m.reasoning" type="checkbox" />支持思考</label
              >
            </div>
          </div>
        </div>
        <div class="inline-form">
          <input
            v-model="modelID"
            placeholder="手动添加模型ID"
            aria-label="手动模型ID"
            @keydown.enter.prevent="addModel"
          /><button type="button" @click="addModel">添加模型</button>
        </div>
        <details>
          <summary>高级参数</summary>
          <label
            >服务商标识<input
              v-model="id"
              :disabled="!creating"
              pattern="[a-zA-Z0-9_.-]{1,80}"
              required
          /></label>
          <div class="form-grid">
            <label
              >请求头<textarea
                v-model="headers"
                rows="3"
                spellcheck="false"
              ></textarea></label
            ><label
              >模型请求参数<textarea
                v-model="options"
                rows="3"
                spellcheck="false"
              ></textarea>
            </label>
          </div>
        </details>
        <div class="actions">
          <button class="primary" :disabled="busy">
            {{ busy ? "处理中…" : "保存服务商" }}</button
          ><button
            v-if="!creating"
            type="button"
            class="danger-text"
            :disabled="busy"
            @click="remove(selected)"
          >
            删除服务商
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
<style scoped>
.provider-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 24px;
}
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.provider-list button {
  text-align: left;
  color: #606677;
  padding: 11px 13px;
}
.provider-list small,
.model-name small {
  display: block;
  word-break: break-all;
}
.provider-list .selected {
  border-color: #d9d9f5;
  background: var(--accent-soft);
  color: var(--accent);
}
.provider-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.model-list {
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 11px;
  scrollbar-width: thin;
}
.model-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  background: #fff;
  border-bottom: 1px solid var(--border);
}
.model-row:last-child {
  border: 0;
}
.model-name {
  text-align: left;
  flex: 1;
  border: 0;
  background: none;
  min-width: 100px;
  word-break: break-word;
}
.model-edit {
  width: 100%;
  padding: 12px;
  background: #f7f8fb;
  border-radius: 9px;
}
.model-edit label {
  min-width: 140px;
}
.provider-login {
  padding: 15px;
  background: #f4f4fc;
  border: 1px solid #e3e3f5;
  border-radius: 11px;
}
.login-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}
.login-progress p {
  margin: 0;
}
.provider-form details textarea {
  width: 100%;
  font-family: monospace;
}
.provider-form h3 {
  margin: 0;
}
@media (max-width: 760px) {
  .provider-layout {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .provider-list {
    flex-direction: row;
    overflow: auto;
    margin: 0 -16px;
    padding: 0 16px 4px;
    scrollbar-width: none;
  }
  .provider-list::-webkit-scrollbar {
    display: none;
  }
  .provider-list button {
    min-width: 140px;
    max-width: 220px;
    flex-shrink: 0;
    overflow-wrap: anywhere;
  }
  .provider-login {
    padding: 10px;
  }
  .model-row {
    padding: 8px;
    gap: 4px;
  }
  .model-edit label {
    min-width: 0;
  }
  .provider-form .actions {
    flex-wrap: wrap;
  }
  .provider-form .section-heading {
    flex-direction: row;
    align-items: center;
  }
}
</style>
