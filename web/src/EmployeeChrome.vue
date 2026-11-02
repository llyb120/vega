<script setup vapor>
import { computed, ref } from "vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
const props = defineProps({
  employee: Object,
  status: String,
  attention: Boolean,
  tabs: Array,
  tab: String,
  activeCount: Number,
  executionOpen: Boolean,
  deleting: Boolean,
  busy: Boolean,
  showWork: Boolean,
  workOpen: Boolean,
  workCount: Number,
});
const emit = defineEmits(["tab", "settings", "delete", "toggle-execution", "execution", "toggle-work"]);
const menu = ref(null);
const place = computed(() => props.employee?.execution?.localAgent ? props.employee.execution.clientName || "客户端" : "服务端");
const hint = computed(() => props.busy ? "正在验证执行环境…" : props.employee?.canManage && !props.employee.executionClients?.length && !props.employee.execution?.localAgent ? "无在线客户端，连接后可切换；只影响新任务" : "只影响之后的新任务，已有任务不变");
function closeMenu() { if (menu.value) menu.value.open = false; }
function openSettings() { closeMenu(); emit("settings"); }
function toggleExecution() { closeMenu(); emit("toggle-execution"); }
function remove() { closeMenu(); emit("delete"); }
</script>
<template>
  <div class="employee-chrome">
    <header class="employee-header">
      <div class="employee-toolbar-start">
        <span class="employee-avatar toolbar" aria-hidden="true"><EmployeeAvatar :employee-id="employee.id" :name="employee.name" :avatar="employee.avatar" /></span>
        <div class="employee-title-block">
          <h2>{{ employee.name || "加载中…" }}</h2>
          <span class="employee-status toolbar" :class="{ attention }" :title="employee.instruction || '把目标交给我，任务由我安排。'"><span aria-hidden="true">●</span> {{ status }}</span>
        </div>
      </div>
      <span v-if="!employee.canManage" class="execution-chip" :title="hint">新任务 · {{ place }}</span>
      <button v-else type="button" class="execution-chip" :aria-expanded="executionOpen" :title="hint" @click="emit('toggle-execution')">新任务 · {{ place }}</button>
      <details v-if="employee.canManage" ref="menu" class="employee-overflow-menu">
        <summary aria-label="员工更多操作">⋯</summary>
        <div class="employee-overflow-panel">
          <p class="employee-overflow-meta"><span>{{ employee.scope === 'team' ? '团队数字员工' : '个人数字员工' }}</span><span>{{ employee.instruction || '把目标交给我，任务由我安排。' }}</span></p>
          <button type="button" @click="openSettings">员工设置</button>
          <button type="button" :aria-expanded="executionOpen" @click="toggleExecution">新任务执行位置 · {{ place }}</button>
          <button type="button" class="employee-delete" :disabled="deleting" @click="remove">{{ deleting ? '正在删除…' : '删除员工' }}</button>
        </div>
      </details>
    </header>
    <nav class="employee-tabs" aria-label="员工工作空间">
      <button v-for="[id, label] in tabs" :key="id" type="button" :aria-current="tab === id ? 'page' : undefined" :class="{ selected: tab === id }" @click="emit('tab', id)">{{ label }}<span v-if="id === 'tasks' && activeCount" class="tab-count">{{ activeCount }}</span></button>
      <span v-if="tab === 'settings'" class="employee-settings-label">员工设置</span>
      <button v-if="showWork" type="button" class="work-rail-toggle" :aria-pressed="workOpen" @click="emit('toggle-work')">当前工作<span v-if="workCount" class="tab-count">{{ workCount }}</span></button>
    </nav>
  </div>
  <div class="employee-execution-bar" :class="{ 'mobile-open': executionOpen }"><span>新任务执行于</span><button v-if="employee.canManage" type="button" class="execution-switch" role="switch" aria-label="客户端执行（仅影响新任务）" :aria-checked="!!employee.execution?.localAgent" :disabled="busy || (!employee.execution?.localAgent && !employee.executionClients?.length)" @click="emit('execution', !employee.execution?.localAgent)"><span :class="{ selected: !employee.execution?.localAgent }">服务端</span><span class="execution-track" aria-hidden="true"></span><span :class="{ selected: employee.execution?.localAgent }">客户端</span></button><span v-else class="execution-readonly">{{ place }}</span><select v-if="employee.canManage && employee.execution?.localAgent" aria-label="员工执行客户端" :value="employee.execution.clientId" :disabled="busy" @change="emit('execution', true, $event.target.value)"><option v-if="!employee.executionClients?.some((client) => client.id === employee.execution.clientId)" :value="employee.execution.clientId" disabled>{{ employee.execution.clientName }} · 离线</option><option v-for="client in employee.executionClients || []" :key="client.id" :value="client.id">{{ client.name }} · {{ client.platform }}</option></select><small>{{ hint }}</small></div>
</template>
<style scoped>
.employee-chrome { display: flex; align-items: stretch; flex: none; min-width: 0; border-bottom: 1px solid var(--border); background: var(--surface); }
.employee-header { display: flex; align-items: center; gap: 8px; padding: 0 8px 0 14px; min-height: 44px; background: transparent; flex: none; min-width: 0; max-width: min(420px, 42vw); }
.employee-toolbar-start { display: flex; align-items: center; gap: 8px; min-width: 0; }
.employee-avatar.toolbar { display: grid; place-items: center; flex: none; width: 28px; height: 30px; border-radius: 8px; font-size: 13px; font-weight: 650; background: var(--accent-soft); color: var(--accent); overflow: hidden; }
.employee-title-block { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.employee-header h2 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.employee-status.toolbar { display: inline-flex; align-items: center; gap: 4px; color: var(--green); font-size: 11px; white-space: nowrap; }
.employee-status.toolbar > span { font-size: 7px; }
.employee-status.toolbar.attention { color: var(--amber); }
.execution-chip { flex: none; max-width: 168px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 36px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-sunken); color: var(--text-secondary); font-size: 11px; }
button.execution-chip { cursor: pointer; }
button.execution-chip[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.employee-tabs { display: flex; align-items: center; flex: 1; padding: 0 8px; gap: 2px; overflow-x: auto; min-width: 0; }
.employee-tabs button { display: flex; align-items: center; gap: 5px; min-height: 44px; padding: 0 10px; border: 0; border-radius: 0; background: transparent; color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.employee-tabs button.selected { color: var(--accent); box-shadow: inset 0 -2px var(--accent); font-weight: 650; }
.tab-count { font-size: 10px; color: var(--muted); padding: 1px 5px; border-radius: 5px; background: var(--surface-sunken); }
.employee-settings-label { color: var(--muted); font-size: 11px; white-space: nowrap; }
.work-rail-toggle { margin-left: auto; color: var(--text-secondary); }
.work-rail-toggle[aria-pressed="true"] { color: var(--accent); box-shadow: inset 0 -2px var(--accent); font-weight: 650; }
.employee-overflow-menu { position: relative; align-self: center; flex: none; }
.employee-overflow-menu summary { display: grid; place-items: center; width: 36px; min-height: 36px; list-style: none; font-size: 20px; line-height: 1; cursor: pointer; border-radius: 8px; color: var(--text-secondary); }
.employee-overflow-menu summary::-webkit-details-marker { display: none; }
.employee-overflow-menu[open] summary { background: var(--surface-sunken); color: var(--text); }
.employee-overflow-panel { position: absolute; right: 0; top: calc(100% + 4px); width: min(300px, calc(100vw - 24px)); max-height: min(70dvh, 420px); overflow-y: auto; z-index: 30; padding: 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: var(--sh-lg); }
.employee-overflow-meta { display: grid; gap: 6px; margin: 0; padding: 10px 12px 6px; font-size: 11px; color: var(--muted); line-height: 1.5; border-bottom: 1px solid var(--border); }
.employee-overflow-meta span:last-child { color: var(--text-secondary); }
.employee-overflow-panel button { width: 100%; text-align: left; white-space: normal; min-height: 44px; border: 0; background: transparent; font-size: 13px; line-height: 1.45; padding: 10px 12px; }
.employee-overflow-panel button:hover { background: var(--surface-sunken); }
.employee-delete { color: var(--red); }
.employee-delete:hover { background: var(--red-soft); }
.employee-execution-bar { display: none; align-items: center; flex-wrap: wrap; gap: 8px; flex: none; min-width: 0; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface-sunken); }
.employee-execution-bar.mobile-open { display: flex; }
.employee-execution-bar > span, .execution-readonly { color: var(--text-secondary); font-size: 11px; }
.employee-execution-bar .execution-switch { min-height: 32px; }
.employee-execution-bar small { color: var(--muted); font-size: 10px; }
.employee-execution-bar select { max-width: 220px; min-height: 34px; padding: 5px 9px; font-size: 12px; }
@media (max-width: 900px) {
  .employee-chrome { flex-wrap: wrap; }
  .employee-header { max-width: none; flex: 1 1 auto; }
  .employee-tabs { flex: 1 1 100%; border-top: 1px solid var(--border); }
}
@media (max-width: 760px) {
  .employee-header, .employee-tabs button.work-rail-toggle { display: none; }
  .employee-chrome { border-bottom: 0; }
  .employee-tabs { width: 100%; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .employee-tabs button { min-height: 42px; }
  .employee-execution-bar { display: none; padding: 8px 12px; }
  .employee-execution-bar.mobile-open { display: flex; }
  .employee-execution-bar .execution-switch { min-height: 44px; }
  .employee-execution-bar select { max-width: 100%; font-size: 16px; }
  .employee-execution-bar small { flex-basis: 100%; }
}
</style>
