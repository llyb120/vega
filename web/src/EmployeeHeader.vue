<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
defineProps({
  employee: Object,
  status: String,
  tone: String,
  tabs: Array,
  tab: String,
  counts: Object,
  deleting: Boolean,
  /** Some task is running right now: the avatar plays its working animation. */
  working: Boolean,
  showWork: Boolean,
  workOpen: Boolean,
  workCount: Number,
});
const emit = defineEmits(["tab", "delete", "toggle-work", "menu", "set-master"]);
const menu = ref(null);
const icons = { chat: "chat", tasks: "tasks", browser: "globe", duties: "repeat", memories: "memory", capabilities: "zap", vault: "key", settings: "settings" };
function close(target) { if (target.value) target.value.open = false; }
function masterName(employee, id) {
  if (!id || id === "cloud") return "云端";
  const node = employee.runtime?.nodes?.find((item) => item.id === id);
  return node?.name || ("客户端 " + String(id).slice(0, 8));
}
function hasClient(employee) {
  return !!(employee.runtime?.hasClient || employee.runtime?.nodes?.some((item) => item.kind === "client" && item.online));
}
function masterNodes(employee) {
  return (employee.runtime?.nodes || []).filter((item) => item.kind === "cloud" || item.online);
}
function changeMaster(kind, event) {
  const value = event.target.value;
  emit("set-master", kind === "fs" ? { fsMaster: value } : { browserMaster: value });
}
</script>
<template>
  <header class="employee-header">
    <div class="identity">
      <button type="button" class="icon header-menu" data-nav-trigger aria-label="打开导航" @click="emit('menu')"><Icon name="menu" /></button>
      <span class="identity-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="employee.id" :name="employee.name" :avatar="employee.avatar" :animate="working" /></span>
      <div class="identity-text">
        <h2 class="truncate">{{ employee.name || "加载中…" }}</h2>
        <span :class="['identity-status', tone]" :title="employee.instruction || '把目标交给我，任务由我安排。'"><span class="dot" :class="[tone, { pulse: tone === 'info' }]" aria-hidden="true"></span>{{ status }}</span>
        <p v-if="employee.runtime && !hasClient(employee)" class="master-line">文件系统、浏览器均为云端 Master</p>
        <div v-else-if="employee.runtime && employee.canManage" class="master-line master-edit">
          <label>文件系统 <select :value="employee.runtime.fsMaster" aria-label="文件系统 Master" @change="changeMaster('fs', $event)"><option v-for="node in masterNodes(employee)" :key="'fs-' + node.id" :value="node.id">{{ node.name }}</option></select></label>
          <label>浏览器 <select :value="employee.runtime.browserMaster" aria-label="浏览器 Master" @change="changeMaster('browser', $event)"><option v-for="node in masterNodes(employee)" :key="'browser-' + node.id" :value="node.id">{{ node.name }}</option></select></label>
        </div>
        <p v-else-if="employee.runtime" class="master-line">文件系统 Master：{{ masterName(employee, employee.runtime.fsMaster) }} · 浏览器 Master：{{ masterName(employee, employee.runtime.browserMaster) }}</p>
      </div>
    </div>
    <nav class="employee-tabs" aria-label="牛马工作区">
      <button v-for="[id, label] in tabs" :key="id" type="button" :class="{ selected: tab === id }" :aria-current="tab === id ? 'page' : undefined" @click="emit('tab', id)">
        <Icon :name="icons[id]" :size="16" /><span>{{ label }}</span><span v-if="counts?.[id]" :class="['count', id === 'tasks' && counts.attention ? 'warn' : '']">{{ counts[id] }}</span>
      </button>
    </nav>
    <div class="header-actions">
      <button v-if="showWork" type="button" class="ghost work-toggle" :aria-pressed="workOpen" :title="workOpen ? '收起工作面板' : '展开工作面板'" @click="emit('toggle-work')"><Icon name="panel" :size="16" /><span class="work-label">工作面板</span><span v-if="workCount" class="count warn">{{ workCount }}</span></button>
      <details v-if="employee.canManage" ref="menu" class="popover">
        <summary class="icon-summary" aria-label="牛马更多操作" title="更多"><Icon name="more" /></summary>
        <div class="popover-panel" role="menu">
          <p class="popover-meta">{{ employee.instruction || '把目标交给我，任务由我安排。' }}</p>
          <button type="button" role="menuitem" @click="close(menu); emit('tab', 'settings')"><Icon name="settings" :size="16" /><span>牛马设置</span></button>
          <button type="button" role="menuitem" class="danger-item" :disabled="deleting" @click="close(menu); emit('delete')"><Icon name="trash" :size="16" /><span>{{ deleting ? '正在删除…' : '删除牛马' }}</span></button>
        </div>
      </details>
    </div>
  </header>
</template>
<style scoped>
.employee-header { display: flex; align-items: center; gap: 4px 16px; flex: none; min-height: 56px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
.identity { display: flex; align-items: center; gap: 10px; flex: 0 1 auto; min-width: 0; max-width: 420px; }
.header-menu { display: none; margin-left: -6px; }
.identity-avatar { display: grid; place-items: center; flex: none; width: 36px; height: 36px; overflow: hidden; border-radius: 10px; background: var(--accent-soft); color: var(--accent-text); font-size: 15px; font-weight: 600; }
.identity-text { display: grid; min-width: 0; }
.identity-text h2 { font-size: 15px; line-height: 1.3; }
.identity-status { display: flex; align-items: center; gap: 6px; overflow: hidden; color: var(--muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.identity-status.warn { color: var(--warn); }
.identity-status.info { color: var(--accent-text); }
.employee-tabs { display: flex; align-self: stretch; flex: 1; min-width: 0; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.employee-tabs::-webkit-scrollbar { display: none; }
.employee-tabs button { position: relative; gap: 6px; height: auto; min-height: 0; padding: 0 10px; border: 0; border-radius: 0; background: transparent; color: var(--text-2); font-weight: 500; }
.employee-tabs button:hover:not(:disabled) { background: transparent; color: var(--text); }
.employee-tabs button .icon-svg { color: var(--muted); }
.employee-tabs button.selected { color: var(--text); }
.employee-tabs button.selected .icon-svg { color: var(--accent); }
.employee-tabs button.selected::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; border-radius: 2px 2px 0 0; background: var(--accent); }
.header-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.popover { position: relative; }
.popover[open] > summary { background: var(--surface-3); }
.icon-summary { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-md); color: var(--text-2); list-style: none; }
.icon-summary::-webkit-details-marker { display: none; }
.icon-summary:hover { background: var(--surface-3); }
.popover-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; display: grid; gap: 2px; width: 280px; padding: 6px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--sh-lg); animation: rise-in .14s ease; }
.popover-meta { padding: 6px 8px 8px; margin-bottom: 2px; border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.popover-panel button { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 36px; padding: 6px 8px; border: 0; background: transparent; font-weight: 400; text-align: left; white-space: normal; }
.popover-panel button:hover:not(:disabled) { background: var(--surface-2); }
.popover-panel button > span { display: grid; flex: 1; }
.popover-panel button small { color: var(--muted); font-size: 11px; }
.popover-panel .icon-svg { color: var(--muted); }
.danger-item, .danger-item .icon-svg { color: var(--danger) !important; }
.danger-item:hover:not(:disabled) { background: var(--danger-soft) !important; }
.work-toggle { gap: 6px; padding: 0 8px; color: var(--text-2); }
.work-toggle[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); }
@media (max-width: 1099px) {
  .employee-header { flex-wrap: wrap; padding: 8px 12px 0; }
  .identity { flex: 1; max-width: none; }
  .employee-tabs { order: 3; flex: 1 1 100%; height: 40px; margin: 0 -4px; }
}
@media (max-width: 767px) {
  .employee-header { gap: 0 8px; padding: 6px 8px 0 12px; }
  .header-menu { display: inline-flex; }
  .identity-avatar { width: 32px; height: 32px; border-radius: 9px; }
  .work-toggle { display: none; }
  .employee-tabs { height: 44px; margin: 0 -8px 0 -12px; padding: 0 4px; }
  .employee-tabs button { padding: 0 10px; }
  .employee-tabs button .icon-svg { display: none; }
  .popover-panel { width: min(300px, calc(100vw - 24px)); }
  .icon-summary { width: 40px; height: 40px; }
}
.master-line { margin: 2px 0 0; font-size: 12px; color: var(--muted, #667); }
.master-edit { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.master-edit label { display: inline-flex; align-items: center; gap: 4px; }
.master-edit select { height: 24px; max-width: 140px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 12px; }
</style>
