<script setup vapor>
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps({ api: Function, employeeId: String });
const emit = defineEmits(["error", "notice"]);
const confirm = window.confirm.bind(window);
const base = `/employees/${props.employeeId}/vault`;
// Same types as the server (VAULT_TYPES); entries saved without one count as 万能.
const types = [
  { value: "login", label: "账号密码", placeholder: "例如：\n账号：name@example.com\n密码：……", hint: "用于网页登录等需要账号密码的场景。" },
  { value: "token", label: "API 密钥/令牌", placeholder: "粘贴 API Key、Access Token 等", hint: "用于调用接口、命令行工具等。" },
  { value: "ssh_key", label: "SSH 私钥", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n……\n-----END OPENSSH PRIVATE KEY-----", hint: "牛马拿不到私钥原文：取用时系统在执行位置写一个只有自己能读的临时文件，给出 GIT_SSH_COMMAND 供 git clone / pull 使用，本轮结束即删除。不支持带口令的私钥，请先用 ssh-keygen -p 去掉口令。" },
  { value: "general", label: "万能", placeholder: "任意文本，例如账号、密钥和使用说明的组合", hint: "不好归类的凭据选这一项，内容原样提供给牛马。" },
];
const typeOf = (value) => types.find((type) => type.value === value) || types[3];
const busy = ref(false), entries = ref([]), form = ref({ type: "login", name: "", condition: "", content: "" });
let disposed = false;
async function run(fn) {
  if (busy.value) return;
  busy.value = true;
  try { await fn(); }
  catch (e) { if (!disposed) emit("error", e.message); }
  finally { busy.value = false; }
}
function reset() {
  form.value = { type: "login", name: "", condition: "", content: "" };
}
function edit(item) {
  form.value = { id: item.id, type: item.type, name: item.name, condition: item.condition, content: "" };
}
async function load() {
  const value = await props.api(base);
  if (!disposed) entries.value = value.entries;
}
async function save() {
  await run(async () => {
    await props.api(base, "POST", { ...form.value });
    if (disposed) return;
    reset();
    await load();
    emit("notice", "凭据已加密保存到当前牛马");
  });
}
async function remove(item) {
  if (!confirm(`删除凭据「${item.name}」？`)) return;
  await run(async () => {
    await props.api(base + "/" + encodeURIComponent(item.id), "DELETE");
    if (disposed) return;
    if (form.value.id === item.id) reset();
    await load();
  });
}
onMounted(() => void run(load));
onBeforeUnmount(() => { disposed = true; });
</script>
<template>
  <div class="page-scroll employee-vault">
    <section class="card">
      <div class="card-head row"><div><h3>密码本 · {{ entries.length }} 条</h3><p class="hint">只属于当前牛马：它的对话、任务和电脑会话只能取用这里的条目，其他牛马看不到。凭据加密保存，只有牛马创建者能查看列表和修改；删除牛马会一并删除。</p></div><button type="button" class="sm" :disabled="busy" @click="reset">新增凭据</button></div>
      <p class="hint">使用条件可写适用系统、账号角色、登录方式和限制，不必填写网站名；有网站名或地址会更容易判断。牛马会结合当前任务与页面核对条件，无法确定时询问，不混用其他系统的账号。</p>
      <p v-if="form.id" class="hint">正在编辑「{{ form.name }}」，凭据留空保留原内容。</p>
      <form class="form-grid two vault-form" @submit.prevent="save">
        <label>类型<select v-model="form.type"><option v-for="type in types" :key="type.value" :value="type.value">{{ type.label }}</option></select></label>
        <label>名称<input v-model="form.name" required maxlength="100" placeholder="不要包含密钥内容" /></label>
        <label class="span-2">允许使用的条件<input v-model="form.condition" required maxlength="500" placeholder="例如：仅用于某系统的邮箱密码登录，不用于 OA 登录" /></label>
        <label class="span-2">凭据<textarea v-model="form.content" :required="!form.id" :class="{ mono: form.type === 'ssh_key' }" :placeholder="form.id ? '凭据已加密，留空视为不修改凭据' : typeOf(form.type).placeholder" :rows="form.type === 'ssh_key' ? 8 : 3" maxlength="16000" autocomplete="off" spellcheck="false"></textarea><small class="hint">{{ typeOf(form.type).hint }}</small></label>
        <div class="span-2 actions end"><button class="primary sm" :disabled="busy"><Icon name="lock" :size="14" />{{ form.id ? '保存修改' : '新增并加密保存' }}</button></div>
      </form>
      <p v-if="!entries.length" class="empty-state">还没有凭据</p>
      <ul v-else class="item-list">
        <li v-for="item in entries" :key="item.id">
          <span class="item-icon" aria-hidden="true"><Icon name="key" :size="15" /></span>
          <span class="item-text"><strong>{{ item.name }}</strong><small>{{ typeOf(item.type).label }} · {{ item.condition }}</small></span>
          <button type="button" class="sm" :disabled="busy" @click="edit(item)">编辑</button>
          <button type="button" class="sm danger-text" :disabled="busy" @click="remove(item)">删除凭据</button>
        </li>
      </ul>
    </section>
  </div>
</template>
<style scoped>
.employee-vault { display: grid; align-content: start; gap: 16px; }
.employee-vault > * { width: 100%; max-width: 1000px; }
.card-head { display: grid; gap: 4px; margin-bottom: 12px; }
.card-head.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.vault-form { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.item-list { display: grid; margin: 0; padding: 0; list-style: none; }
.item-list li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.item-list li:first-child { border-top: 0; }
.item-icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--surface-2); color: var(--text-2); }
.item-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
.item-text strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.item-text small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.vault-form textarea.mono { white-space: pre; }
</style>
