<script setup vapor>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import EmployeeSessionView from "./EmployeeSessionView.vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
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
  <div class="debug-layout" :class="{ 'has-selection': !!selected }">
    <section class="debug-list-pane" aria-label="调试会话列表">
      <PageHeader title="调试会话" subtitle="仅管理员可见 · 真实会话与工具记录，只读查看">
        <button type="button" class="sm" :disabled="busy" title="刷新" @click="refresh"><Icon name="refresh" :size="14" /><span class="hide-mobile">刷新</span></button>
      </PageHeader>
      <div class="debug-filters">
        <select v-model="employee" aria-label="员工"><option value="">全部员工</option><option v-for="[id, name] in employees" :key="id" :value="id">{{ name }}</option></select>
        <label class="search"><Icon name="search" :size="14" /><input v-model="search" aria-label="查找会话" placeholder="会话 ID、标题或任务" /></label>
      </div>
      <p class="debug-count">{{ visible.length }} 个真实会话</p>
      <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span></p>
      <div class="debug-list">
        <p v-if="!visible.length" class="empty-state">{{ busy ? '正在读取…' : '没有匹配的员工会话' }}</p>
        <button v-for="session in visible" :key="session.id" type="button" class="debug-session" :class="{ selected: selected === session.id }" :aria-current="selected === session.id ? 'true' : undefined" @click="selected = session.id">
          <span class="debug-row"><strong>{{ session.employeeName }}</strong><span :class="['badge', session.kind === 'work' ? 'info' : '']">{{ labels[session.kind] }}</span><span v-if="session.running" class="badge ok"><span class="dot ok pulse"></span>执行中</span><time>{{ formatBeijing(session.createdAt) }}</time></span>
          <span class="debug-title">{{ session.title }}</span>
          <span v-if="session.taskText" class="debug-task">{{ session.taskText }}</span>
          <span class="debug-row debug-secondary"><code>{{ session.id }}</code><span>{{ session.scene || 'lightweight' }} · {{ session.model || '默认模型' }}</span><span>{{ session.localAgent ? '客户端 · ' + (session.clientName || session.clientId) : '服务端' }}</span></span>
        </button>
      </div>
    </section>
    <section class="debug-detail-pane" aria-label="会话记录">
      <EmployeeSessionView v-if="selected" :key="selected" :api="api" :session-id="selected" :revision="revision" debug @back="selected = ''" />
      <div v-else class="debug-placeholder"><Icon name="code" :size="32" /><strong>选择一个会话</strong><span>查看完整消息、工具调用与原始参数。</span></div>
    </section>
  </div>
</template>
<style scoped>
.debug-layout { display: grid; grid-template-columns: minmax(340px, 400px) minmax(0, 1fr); flex: 1; min-height: 0; }
.debug-list-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--bg); }
.debug-detail-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--surface); }
.debug-filters { display: flex; gap: 6px; flex: none; padding: 10px 12px 0; }
.debug-filters select { flex: 0 1 130px; min-width: 0; }
.search { position: relative; display: flex; align-items: center; flex: 1; min-width: 0; }
.search .icon-svg { position: absolute; left: 9px; color: var(--muted); pointer-events: none; }
.search input { width: 100%; padding-left: 28px; }
.debug-count { flex: none; padding: 8px 14px 4px; color: var(--muted); font-size: 11px; }
.debug-list-pane > .banner { flex: none; }
.debug-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 16px; scrollbar-width: thin; }
.debug-session { display: grid; justify-content: stretch; gap: 4px; width: 100%; height: auto; margin-bottom: 4px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--r-md); background: transparent; font-weight: 400; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.debug-session:hover:not(:disabled) { background: var(--surface); border-color: var(--border); }
.debug-session.selected { background: var(--surface); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.debug-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.debug-row strong { font-weight: 600; }
.debug-row time { margin-left: auto; color: var(--muted); font-size: 11px; }
.debug-title { color: var(--text); font-size: 13px; font-weight: 500; line-height: 1.45; }
.debug-task { display: -webkit-box; overflow: hidden; color: var(--text-2); font-size: 12px; line-height: 1.5; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.debug-secondary { gap: 4px 10px; color: var(--muted); font-size: 11px; }
.debug-secondary code { font-size: 10px; user-select: text; }
.debug-placeholder { display: grid; align-content: center; justify-items: center; gap: 6px; flex: 1; color: var(--muted); font-size: 12px; }
.debug-placeholder strong { color: var(--text); font-size: 14px; }
.debug-placeholder .icon-svg { color: var(--faint); }
@media (max-width: 1099px) {
  .debug-layout { grid-template-columns: minmax(0, 1fr); }
  .debug-list-pane { border-right: 0; }
  .debug-layout:not(.has-selection) .debug-detail-pane, .debug-layout.has-selection .debug-list-pane { display: none; }
}
</style>
