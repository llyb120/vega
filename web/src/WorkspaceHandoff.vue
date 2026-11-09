<script setup vapor>
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { formatBeijing } from "../../shared/time";
import { handoffCanClose, handoffHeadline } from "./handoff-status.js";

const props = defineProps({
  api: Function,
  sessionId: String,
  employeeId: String,
  taskId: String,
  readonly: Boolean,
  revision: Number,
});
const status = ref(null), busy = ref(""), error = ref(""), migrate = ref(false), confirmed = ref(false);
const endpoint = computed(() => props.employeeId && props.taskId
  ? `/employees/${encodeURIComponent(props.employeeId)}/tasks/${encodeURIComponent(props.taskId)}/workspace`
  : props.sessionId ? `/sessions/${encodeURIComponent(props.sessionId)}/workspace` : "");
const headline = computed(() => handoffHeadline(status.value));
const canClose = computed(() => handoffCanClose(status.value));
const browserLabel = computed(() => status.value?.browser?.location === "local"
  ? "本机例外" + (status.value.browser.reason ? " · " + status.value.browser.reason : "")
  : "云端");
const ownerLabel = computed(() => status.value?.owner === "cloud" ? "执行权在云端" : "执行权在本机");

async function load() {
  if (!endpoint.value || !props.api) return;
  try {
    status.value = await props.api(endpoint.value, "POST", { action: "status" });
    error.value = "";
  } catch (reason) {
    const message = reason?.message || String(reason);
    if (/尚未开始|没有执行会话/.test(message)) { status.value = null; error.value = ""; return; }
    error.value = message;
  }
}
async function run(action, extra = {}) {
  if (!endpoint.value || busy.value || props.readonly) return;
  const body = { action, ...extra };
  if (action === "handoff" && migrate.value === true) body.migrateBrowser = true;
  if (action === "handoff" && status.value?.phase === "needs_confirmation") {
    if (!confirmed.value) { error.value = "请先勾选确认：页面会刷新，未保存的草稿可能丢失"; return; }
    body.acknowledgeReload = true;
  }
  busy.value = action;
  error.value = "";
  try { status.value = await props.api(endpoint.value, "POST", body); }
  catch (reason) { error.value = reason?.message || String(reason); }
  finally { busy.value = ""; }
}
watch(() => [endpoint.value, props.revision], () => { confirmed.value = false; void load(); }, { immediate: true });
</script>
<template>
  <section v-if="endpoint" class="handoff" aria-label="工作区交接">
    <header>
      <strong>工作区交接</strong>
      <span class="badge">{{ ownerLabel }}</span>
      <span class="badge">浏览器 · {{ browserLabel }}</span>
      <span v-if="status?.phase" class="badge">{{ status.phase }}</span>
    </header>
    <p class="headline" :data-can-close="canClose ? 'yes' : 'no'" role="status">{{ headline }}</p>
    <p v-if="status?.message && status.message !== headline" class="detail">{{ status.message }}</p>
    <p v-if="status?.phase === 'needs_confirmation'" class="warn">切换预览后端会刷新页面，WebSocket 会重连，未保存的草稿可能丢失。勾选确认后才会带 acknowledgeReload 重试；在此之前不会改执行权。</p>
    <label v-if="status?.phase === 'needs_confirmation'" class="check"><input v-model="confirmed" type="checkbox" :disabled="readonly || !!busy" />我已处理未保存草稿，确认刷新预览页并继续交接</label>
    <p v-if="status?.checkpointAt" class="detail">最近完整检查点：{{ formatBeijing(status.checkpointAt) }}<template v-if="status.rev"> · rev {{ status.rev }}</template></p>
    <ul v-if="status?.deps?.length" class="deps">
      <li v-for="(dep, index) in status.deps" :key="dep.name + index"><span :class="['badge', dep.status === 'cloud' ? 'ok' : 'warn']">{{ dep.status }}</span>{{ dep.name }}<span class="detail">{{ dep.detail }}</span></li>
    </ul>
    <p v-if="status?.unknown?.length" class="warn">结果未知、不会重放：{{ status.unknown.map((item) => item.tool).join("、") }}</p>
    <ul v-if="status?.conflicts?.length" class="deps">
      <li v-for="(conflict, index) in status.conflicts" :key="conflict.copy + index">冲突已保留：{{ conflict.path }} → {{ conflict.copy }}</li>
    </ul>
    <p v-if="status?.pendingDeletes?.length" class="detail">云端已删除、尚未在本机删除：{{ status.pendingDeletes.join("、") }}</p>
    <label class="check"><input v-model="migrate" type="checkbox" :disabled="readonly || !!busy" />另行授权迁移本机浏览器的任务页签、Cookie 与 Storage（默认不迁移，云端浏览器保持原实例）</label>
    <div class="actions">
      <button type="button" class="sm" :disabled="readonly || !!busy" @click="run('checkpoint')">保存检查点</button>
      <button type="button" class="sm primary" :disabled="readonly || !!busy" @click="run('handoff')">{{ status?.phase === 'needs_confirmation' ? '确认后交接' : '交接到云端' }}</button>
      <button type="button" class="sm" :disabled="readonly || !!busy" @click="run('recover')">从最后检查点恢复</button>
      <button type="button" class="sm" :disabled="readonly || !!busy" @click="run('sync_back')">回传文件</button>
      <button type="button" class="sm" :disabled="readonly || !!busy" @click="run('transfer_back')">交回本机执行权</button>
    </div>
    <p v-if="busy" class="detail" role="status"><span class="spinner"></span>正在执行 {{ busy }}…</p>
    <p v-if="error" class="warn" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.handoff { display: grid; gap: 8px; margin: 12px 16px 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.handoff header, .actions, .check { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.headline { margin: 0; font-weight: 650; }
.headline[data-can-close="no"] { color: var(--text-2); }
.detail { margin: 0; color: var(--muted); }
.warn { margin: 0; color: var(--warn, #8a5a00); }
.deps { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.deps li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.check { color: var(--text-2); }
</style>
