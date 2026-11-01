<script setup vapor>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import EmployeeSessionView from "./EmployeeSessionView.vue";
import { formatBeijing } from "../../shared/time";
const props = defineProps({ api: Function, revision: Number });
const sessions = ref([]), selected = ref(""), employee = ref(""), search = ref(""), busy = ref(false), error = ref("");
const labels = { chat: "沟通会话", work: "主执行会话", computer: "浏览器会话" };
const employees = computed(() => [...new Map(sessions.value.map((session) => [session.employeeId, session.employeeName])).entries()]);
const visible = computed(() => sessions.value.filter((session) => (!employee.value || session.employeeId === employee.value) && (!search.value || [session.id, session.title, session.taskText, session.employeeName].join(" ").toLowerCase().includes(search.value.toLowerCase()))));
let disposed = false, version = 0;
async function refresh() {
  const current = ++version; busy.value = true; error.value = "";
  try { const result = await props.api("/debug/sessions"); if (!disposed && current === version) sessions.value = result; }
  catch (e) { if (!disposed) error.value = e.message; }
  finally { if (!disposed && current === version) busy.value = false; }
}
watch(() => props.revision, refresh);
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; version++; });
</script>
<template>
  <EmployeeSessionView v-if="selected" :api="api" :session-id="selected" :revision="revision" debug @back="selected = ''" />
  <template v-else><header class="topbar"><div><h2>调试会话</h2><p>仅管理员可见 · 真实会话与工具记录，只读查看</p></div><button :disabled="busy" @click="refresh">刷新</button></header>
    <div class="page-scroll debug-page"><p v-if="error" class="banner error" role="alert">{{ error }}</p><div class="debug-filters"><label>员工<select v-model="employee"><option value="">全部员工</option><option v-for="[id, name] in employees" :key="id" :value="id">{{ name }}</option></select></label><label>查找会话<input v-model="search" placeholder="会话 ID、标题或任务" /></label><span>{{ visible.length }} 个真实会话</span></div>
      <p v-if="!visible.length" class="empty-card">{{ busy ? '正在读取…' : '没有匹配的员工会话' }}</p>
      <button v-for="session in visible" :key="session.id" class="debug-session" @click="selected = session.id"><div class="debug-row"><strong>{{ session.employeeName }}</strong><span class="pill">{{ labels[session.kind] }}</span><span v-if="session.running" class="pill green">执行中</span><time>{{ formatBeijing(session.createdAt) }}</time></div><h3>{{ session.title }}</h3><p v-if="session.taskText">{{ session.taskText }}</p><div class="debug-row debug-secondary"><code>{{ session.id }}</code><span>{{ session.scene || 'lightweight' }} · {{ session.model || '默认模型' }}</span><span>{{ session.localAgent ? '客户端 · ' + (session.clientName || session.clientId) : '服务端' }}</span><span class="debug-open">查看原始记录 →</span></div></button>
    </div></template>
</template>
<style scoped>
.debug-filters { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
.debug-filters label { display: grid; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.debug-filters label:nth-child(2) { flex: 1; min-width: 180px; }
.debug-filters > span { color: var(--muted); font-size: 12px; padding-bottom: 10px; }
.debug-session { display: block; width: 100%; text-align: left; padding: 20px; margin-bottom: 14px; background: var(--surface); border-radius: 12px; white-space: normal; overflow-wrap: anywhere; }
.debug-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.debug-row time { margin-left: auto; color: var(--muted); font-size: 11px; }
.debug-session h3 { font-size: 15px; margin: 13px 0 8px; }
.debug-session p { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
.debug-secondary { color: var(--muted); font-size: 11px; }
.debug-secondary code { user-select: text; }
.debug-open { color: var(--accent); margin-left: auto; }
@media (max-width: 600px) { .debug-session { padding: 16px; } .debug-secondary { align-items: flex-start; flex-direction: column; } .debug-open { margin: 5px 0 0; } }
</style>
