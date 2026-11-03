<script setup vapor>
import Icon from "./Icon.vue";
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
    // Keep masked keys at their saved path so mergeSecrets can restore them.
    if (draft.value.apiKey && !draft.value.options?.apiKey) {
      row.apiKey = apiKey.value;
      delete row.options.apiKey;
    } else {
      row.options.apiKey = apiKey.value;
      delete row.apiKey;
    }
    delete row.baseURL;
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
    <div class="card-head row"><div><h3>服务商</h3><p class="hint">接入模型服务商，获取可用模型后在“场景模型”中分配。</p></div><button type="button" class="sm" :disabled="busy" @click="edit('', {})"><Icon name="plus" :size="14" />添加服务商</button></div>
    <div class="provider-layout">
      <aside class="provider-list" aria-label="服务商列表">
        <button v-for="[key, p] in providers" :key="key" type="button" :class="{ selected: selected === key && !creating }" :aria-current="selected === key && !creating ? 'true' : undefined" @click="edit(key, p)">
          <span class="provider-mark" aria-hidden="true">{{ (p.name || key).slice(0, 1).toUpperCase() }}</span><span class="provider-text"><strong class="truncate">{{ p.name || key }}</strong><small class="truncate">{{ key }}</small></span>
        </button>
        <button v-if="creating" type="button" class="selected new-provider"><span class="provider-mark" aria-hidden="true"><Icon name="plus" :size="14" /></span><span class="provider-text"><strong>新服务商</strong><small>未保存</small></span></button>
        <p v-if="!providers.length && !creating" class="hint">还没有服务商</p>
      </aside>
      <form class="provider-form" @submit.prevent="save">
        <fieldset class="form-section">
          <legend>基本信息</legend>
          <div class="form-grid two">
            <label>服务商类型<select v-model="preset" @change="choosePreset"><option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
            <label>名称<input v-model="name" required placeholder="例如：我的 CodeBuddy" /></label>
            <template v-if="!source">
              <label>接口格式<select v-model="apiType"><option v-for="[value, label] in protocols" :key="value" :value="value">{{ label }}</option></select></label>
              <label>API 地址<input v-model="baseURL" required type="url" placeholder="https://api.example.com/v1" /></label>
              <label class="span-2">API Key<input v-model="apiKey" type="password" autocomplete="off" :placeholder="apiKey === '__stored_secret__' ? '已保存，留原值保留' : 'API Key 或 {env:NAME}'" /></label>
            </template>
          </div>
          <div v-if="source" class="provider-login">
            <div class="login-actions">
              <select v-if="source === 'codebuddy'" v-model="site" aria-label="CodeBuddy站点" :disabled="!!login"><option value="global">国际站</option><option value="cn">中国站</option></select>
              <button v-if="webLogin" type="button" class="primary sm" :disabled="busy" @click="begin"><Icon name="key" :size="14" />{{ login ? "重新登录" : "登录 " + (name || source) }}</button>
              <button type="button" class="sm" :disabled="busy" @click="localImport">读取服务端已有登录</button>
              <button v-if="webLogin && !creating" type="button" class="sm ghost" @click="run(async () => { if (confirm('退出此服务商的网页登录？')) { stopPolling(); await api('/providers/login', 'POST', { action: 'logout', source }); login = null; savePending(null); emit('notice', '已退出服务商登录'); } })">退出登录</button>
            </div>
            <div v-if="login" class="login-progress callout info">
              <Icon name="external" :size="14" />
              <div>
                <p>请在新窗口完成登录，完成后这里会自动更新。</p>
                <a :href="login.url" target="_blank" rel="noopener noreferrer">未打开窗口？点击继续登录 ↗</a>
                <details v-if="login.source === 'devin'">
                  <summary>没有自动返回？</summary>
                  <p class="hint">复制登录后浏览器最后跳转的完整地址到这里。</p>
                  <button type="button" class="sm" @click="begin(true)">改用手动回调登录</button>
                  <div class="inline-form"><input v-model="pasted" placeholder="粘贴本次登录的回调地址" autocomplete="off" /><button type="button" class="sm" @click="poll(true)">完成登录</button></div>
                </details>
                <p v-if="loginError" class="error" role="alert">{{ loginError }}</p>
                <button type="button" class="sm" @click="poll(true)">检查登录结果</button>
              </div>
            </div>
          </div>
        </fieldset>
        <fieldset class="form-section">
          <legend>模型 <span class="count">{{ Object.keys(modelMap).length }}</span></legend>
          <div class="model-tools">
            <label class="search"><Icon name="search" :size="14" /><input v-model="query" placeholder="搜索模型" aria-label="搜索模型" /></label>
            <button type="button" class="sm" :disabled="busy" @click="discover"><Icon name="refresh" :size="14" />获取模型</button>
          </div>
          <div class="model-list">
            <p v-if="!visibleModels.length" class="hint model-empty">{{ Object.keys(modelMap).length ? '没有匹配的模型' : '还没有模型，点“获取模型”或手动添加。' }}</p>
            <div v-for="[key, m] in visibleModels" :key="key" class="model-row" :class="{ open: editingModel === key }">
              <button type="button" class="model-name" :aria-expanded="editingModel === key" @click="editingModel = editingModel === key ? '' : key"><Icon name="right" :size="12" class="chev" /><span><strong>{{ m.name || key }}</strong><small>{{ key }}</small></span></button>
              <span v-if="m.supportsImages || m.modalities?.input?.includes('image')" class="badge info">图片</span>
              <span v-if="m.reasoning" class="badge">思考</span>
              <button type="button" class="icon sm" :aria-label="'移除 ' + key" title="移除" @click="{ const next = { ...modelMap }; delete next[key]; modelMap = next; }"><Icon name="close" :size="14" /></button>
              <div v-if="editingModel === key" class="model-edit">
                <label>显示名称<input v-model="m.name" /></label>
                <label>上下文长度<input :value="m.limit?.context || m.contextWindow || 200000" type="number" min="1024" @change="limitValue(key, 'context', $event.target.value)" /></label>
                <label>输出上限<input :value="m.limit?.output || m.maxOutputTokens || 32000" type="number" min="32" @change="limitValue(key, 'output', $event.target.value)" /></label>
                <div class="model-flags"><label class="check"><input :checked="m.supportsImages || m.modalities?.input?.includes('image')" type="checkbox" @change="imageValue(key, $event.target.checked)" />支持图片</label><label class="check"><input v-model="m.reasoning" type="checkbox" />支持思考</label></div>
              </div>
            </div>
          </div>
          <div class="inline-form model-add"><input v-model="modelID" placeholder="手动添加模型 ID" aria-label="手动模型ID" @keydown.enter.prevent="addModel" /><button type="button" class="sm" @click="addModel"><Icon name="plus" :size="14" />添加模型</button></div>
        </fieldset>
        <details class="advanced">
          <summary><Icon name="right" :size="12" class="chev" />高级参数</summary>
          <div class="form-grid two">
            <label class="span-2">服务商标识<input v-model="id" class="mono-input" :disabled="!creating" pattern="[a-zA-Z0-9_.-]{1,80}" required /></label>
            <label>请求头<textarea v-model="headers" class="mono-input" rows="3" spellcheck="false"></textarea></label>
            <label>模型请求参数<textarea v-model="options" class="mono-input" rows="3" spellcheck="false"></textarea></label>
          </div>
        </details>
        <div class="form-footer">
          <button v-if="!creating" type="button" class="sm danger-text" :disabled="busy" @click="remove(selected)"><Icon name="trash" :size="14" />删除服务商</button>
          <button class="primary" :disabled="busy">{{ busy ? "处理中…" : "保存服务商" }}</button>
        </div>
      </form>
    </div>
  </section>
</template>
<style scoped>
.provider-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; }
.provider-list { display: grid; align-content: start; gap: 2px; }
.provider-list button { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 44px; padding: 6px 8px; border: 1px solid transparent; background: transparent; font-weight: 400; text-align: left; }
.provider-list button:hover:not(:disabled) { background: var(--surface-2); }
.provider-list button.selected { border-color: var(--border); background: var(--surface-2); }
.provider-mark { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 8px; background: var(--surface-3); color: var(--text-2); font-size: 12px; font-weight: 700; }
.provider-list button.selected .provider-mark { background: var(--accent-soft); color: var(--accent); }
.provider-text { display: grid; min-width: 0; }
.provider-text strong { font-size: 13px; font-weight: 600; }
.provider-text small { color: var(--muted); font-size: 11px; }
.provider-form { display: grid; gap: 16px; min-width: 0; padding-left: 20px; border-left: 1px solid var(--border); }
.form-section { min-width: 0; margin: 0; padding: 0; border: 0; }
.form-section legend { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; padding: 0; color: var(--text); font-size: 13px; font-weight: 600; }
.provider-login { display: grid; gap: 10px; margin-top: 12px; }
.login-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.login-progress > div { display: grid; gap: 6px; justify-items: start; }
.model-tools { display: flex; gap: 6px; margin-bottom: 8px; }
.search { position: relative; display: flex; align-items: center; flex: 1; min-width: 0; }
.search .icon-svg { position: absolute; left: 9px; color: var(--muted); pointer-events: none; }
.search input { width: 100%; padding-left: 28px; }
.model-list { max-height: 360px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-md); scrollbar-width: thin; }
.model-empty { padding: 16px; text-align: center; }
.model-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 6px 4px 4px; border-top: 1px solid var(--border); }
.model-row:first-child { border-top: 0; }
.model-row.open { background: var(--surface-2); }
.model-name { flex: 1; justify-content: flex-start; gap: 6px; min-width: 0; height: auto; min-height: 36px; padding: 4px 6px; border: 0; background: transparent; font-weight: 400; text-align: left; }
.model-name > span { display: grid; min-width: 0; }
.model-name strong { overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.model-name small { overflow: hidden; color: var(--muted); font-family: var(--mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.chev { flex: none; color: var(--muted); transition: transform .15s ease; }
.model-row.open .chev, .advanced[open] .chev { transform: rotate(90deg); }
.model-edit { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; flex-basis: 100%; padding: 4px 6px 8px 28px; }
.model-edit > label { display: grid; gap: 4px; font-size: 12px; }
.model-flags { display: flex; gap: 16px; grid-column: 1 / -1; }
.model-add { margin-top: 8px; }
.advanced summary { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); font-size: 13px; font-weight: 600; cursor: pointer; list-style: none; }
.advanced summary::-webkit-details-marker { display: none; }
.advanced .form-grid { margin-top: 10px; }
.form-footer { position: sticky; bottom: -40px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 -16px -16px; padding: 12px 16px; border-top: 1px solid var(--border); border-radius: 0 0 var(--r-lg) var(--r-lg); background: var(--surface); }
.form-footer .danger-text { margin-right: auto; }
@media (max-width: 1099px) {
  .provider-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .provider-list { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .provider-list::-webkit-scrollbar { display: none; }
  .provider-list button { flex: none; width: auto; max-width: 220px; min-height: 40px; border-color: var(--border); }
  .provider-list button.selected { border-color: var(--accent); background: var(--accent-softer); }
  .provider-form { padding-left: 0; border-left: 0; }
}
@media (max-width: 767px) {
  .model-edit { grid-template-columns: minmax(0, 1fr); padding-left: 6px; }
  .form-footer { margin: 0 -12px -12px; padding: 10px 12px; }
}
</style>
