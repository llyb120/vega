<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import { desktopMode } from "./desktop.js";
const props = defineProps({
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
  <header class="employee-header" :class="{ desktop: desktopMode }">
    <div class="header-left">
      <button type="button" class="icon header-menu" data-nav-trigger aria-label="打开导航" @click="emit('menu')"><Icon name="menu" /></button>
    </div>
    <div class="header-center">
      <button type="button" class="agent-pill" :title="status" @click="emit('tab', 'chat')">
        <span class="pill-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="employee.id" :name="employee.name" :avatar="employee.avatar" :animate="working" /></span>
        <span class="pill-name truncate">{{ employee.name || "加载中…" }}</span>
      </button>
    </div>
    <div class="header-actions">
      <button v-if="showWork" type="button" class="ghost work-toggle" :aria-pressed="workOpen" :title="workOpen ? '收起工作面板' : '展开工作面板'" @click="emit('toggle-work')"><Icon name="panel" :size="16" /><span class="work-label">工作面板</span><span v-if="workCount" class="count warn">{{ workCount }}</span></button>
      <details ref="menu" class="popover">
        <summary class="icon-summary" aria-label="牛马工作区与更多操作" title="更多"><Icon name="more" /><span v-if="tab && tab !== 'chat'" class="tab-dot" aria-hidden="true"></span></summary>
        <div class="popover-panel" role="menu">
          <p class="popover-meta">{{ employee.instruction || '把目标交给我，任务由我安排。' }}</p>
          <p v-if="status" class="popover-status" :class="tone"><span class="dot" :class="[tone, { pulse: tone === 'info' }]" aria-hidden="true"></span>{{ status }}</p>
          <div class="tab-list" role="none">
            <button v-for="[id, label] in tabs" :key="id" type="button" role="menuitem" :class="{ selected: tab === id }" @click="close(menu); emit('tab', id)">
              <Icon :name="icons[id]" :size="16" /><span>{{ label }}</span><span v-if="counts?.[id]" :class="['count', id === 'tasks' && counts.attention ? 'warn' : '']">{{ counts[id] }}</span>
            </button>
          </div>
          <p v-if="employee.runtime && !hasClient(employee)" class="master-line">文件系统、浏览器均为云端 Master</p>
          <div v-else-if="employee.runtime && employee.canManage" class="master-line master-edit">
            <label>文件系统 <select :value="employee.runtime.fsMaster" aria-label="文件系统 Master" @change="changeMaster('fs', $event)"><option v-for="node in masterNodes(employee)" :key="'fs-' + node.id" :value="node.id">{{ node.name }}</option></select></label>
            <label>浏览器 <select :value="employee.runtime.browserMaster" aria-label="浏览器 Master" @change="changeMaster('browser', $event)"><option v-for="node in masterNodes(employee)" :key="'browser-' + node.id" :value="node.id">{{ node.name }}</option></select></label>
          </div>
          <p v-else-if="employee.runtime" class="master-line">文件系统 Master：{{ masterName(employee, employee.runtime.fsMaster) }} · 浏览器 Master：{{ masterName(employee, employee.runtime.browserMaster) }}</p>
          <button v-if="showWork" type="button" role="menuitem" :aria-pressed="workOpen" @click="close(menu); emit('toggle-work')"><Icon name="panel" :size="16" /><span>{{ workOpen ? '收起工作面板' : '展开工作面板' }}</span><span v-if="workCount" class="count warn">{{ workCount }}</span></button>
          <button v-if="employee.canManage && tab !== 'settings'" type="button" role="menuitem" @click="close(menu); emit('tab', 'settings')"><Icon name="settings" :size="16" /><span>牛马设置</span></button>
          <button v-if="employee.canManage" type="button" role="menuitem" class="danger-item" :disabled="deleting" @click="close(menu); emit('delete')"><Icon name="trash" :size="16" /><span>{{ deleting ? '正在删除…' : '删除牛马' }}</span></button>
        </div>
      </details>
    </div>
  </header>
</template>
<style scoped>
.employee-header { display: flex; align-items: center; gap: 8px; flex: none; min-height: 52px; padding: 0 12px 0 16px; background: var(--surface); --wails-draggable: drag; }
.header-left, .header-actions { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; --wails-draggable: no-drag; }
.header-actions { justify-content: flex-end; }
.header-center { display: flex; justify-content: center; flex: none; max-width: min(60%, 320px); --wails-draggable: no-drag; }
.header-menu { display: none; }
.agent-pill { display: inline-flex; align-items: center; gap: 8px; height: 36px; min-height: 36px; max-width: 100%; padding: 0 14px 0 4px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text); box-shadow: var(--sh-xs); font-weight: 600; }
.agent-pill:hover:not(:disabled) { background: var(--surface-2); }
.pill-avatar { display: grid; place-items: center; flex: none; width: 28px; height: 28px; overflow: hidden; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-size: 13px; font-weight: 600; }
.pill-name { font-size: 14px; }
.popover { position: relative; }
.popover[open] > summary { background: var(--surface-3); }
.icon-summary { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: var(--text-2); list-style: none; }
.icon-summary::-webkit-details-marker { display: none; }
.icon-summary:hover { background: var(--surface-3); }
.tab-dot { position: absolute; top: 4px; right: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.popover-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; display: grid; gap: 2px; width: 280px; padding: 6px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--sh-lg); animation: rise-in .14s ease; }
.popover-meta { padding: 6px 8px 8px; margin-bottom: 2px; border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.popover-status { display: flex; align-items: center; gap: 6px; padding: 0 8px 6px; color: var(--muted); font-size: 12px; }
.popover-status.warn { color: var(--warn); }
.popover-status.info { color: var(--accent-text); }
.tab-list { display: grid; gap: 1px; padding-bottom: 4px; margin-bottom: 4px; border-bottom: 1px solid var(--border); }
.popover-panel button { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 36px; padding: 6px 8px; border: 0; background: transparent; font-weight: 400; text-align: left; white-space: normal; }
.popover-panel button:hover:not(:disabled), .popover-panel button.selected { background: var(--surface-2); }
.popover-panel button.selected { color: var(--text); font-weight: 600; }
.popover-panel button > span { display: grid; flex: 1; }
.popover-panel .icon-svg { color: var(--muted); }
.popover-panel button.selected .icon-svg { color: var(--accent); }
.danger-item, .danger-item .icon-svg { color: var(--danger) !important; }
.danger-item:hover:not(:disabled) { background: var(--danger-soft) !important; }
.work-toggle { display: none; gap: 6px; padding: 0 8px; color: var(--text-2); }
.work-toggle[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); }
html.is-desktop .employee-header { padding-right: 128px; }
@media (max-width: 1099px) {
  .work-label { display: none; }
}
@media (max-width: 767px) {
  .employee-header { gap: 0 8px; padding: 6px 8px 6px 12px; }
  .header-menu { display: inline-flex; }
  .work-toggle { display: none; }
  .popover-panel { width: min(300px, calc(100vw - 24px)); }
  .icon-summary { width: 40px; height: 40px; }
}
.master-line { margin: 4px 0; padding: 0 8px; font-size: 12px; color: var(--muted, #667); }
.master-edit { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.master-edit label { display: inline-flex; align-items: center; gap: 4px; }
.master-edit select { height: 24px; flex: 1; min-width: 0; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 12px; }
</style>
