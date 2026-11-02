<script setup vapor>
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
const props = defineProps({
  employee: Object,
  status: String,
  tone: String,
  tabs: Array,
  tab: String,
  counts: Object,
  deleting: Boolean,
  busy: Boolean,
  showWork: Boolean,
  workOpen: Boolean,
  workCount: Number,
});
const emit = defineEmits(["tab", "delete", "execution", "toggle-work", "menu"]);
const menu = ref(null), place = ref(null);
const icons = { chat: "chat", tasks: "tasks", browser: "globe", duties: "repeat", memories: "memory", settings: "settings" };
const location = computed(() => props.employee?.execution?.localAgent ? props.employee.execution.clientName || "客户端" : "服务端");
const clients = computed(() => props.employee?.executionClients || []);
const offlineCurrent = computed(() => props.employee?.execution?.localAgent && !clients.value.some((client) => client.id === props.employee.execution.clientId));
function close(target) { if (target.value) target.value.open = false; }
function choose(localAgent, clientId) { close(place); emit("execution", localAgent, clientId); }
</script>
<template>
  <header class="employee-header">
    <div class="identity">
      <button type="button" class="icon header-menu" data-nav-trigger aria-label="打开导航" @click="emit('menu')"><Icon name="menu" /></button>
      <span class="identity-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="employee.id" :name="employee.name" :avatar="employee.avatar" /></span>
      <div class="identity-text">
        <h2 class="truncate">{{ employee.name || "加载中…" }}</h2>
        <span :class="['identity-status', tone]" :title="employee.instruction || '把目标交给我，任务由我安排。'"><span class="dot" :class="[tone, { pulse: tone === 'info' }]" aria-hidden="true"></span>{{ status }}<span class="identity-scope"> · {{ employee.scope === 'personal' ? '个人牛马' : '团队牛马' }}</span></span>
      </div>
    </div>
    <nav class="employee-tabs" aria-label="牛马工作区">
      <button v-for="[id, label] in tabs" :key="id" type="button" :class="{ selected: tab === id }" :aria-current="tab === id ? 'page' : undefined" @click="emit('tab', id)">
        <Icon :name="icons[id]" :size="16" /><span>{{ label }}</span><span v-if="counts?.[id]" :class="['count', id === 'tasks' && counts.attention ? 'warn' : '']">{{ counts[id] }}</span>
      </button>
    </nav>
    <div class="header-actions">
      <details v-if="employee.canManage" ref="place" class="popover place-popover">
        <summary class="place-chip" :title="'新任务默认执行位置：' + location"><Icon :name="employee.execution?.localAgent ? 'laptop' : 'server'" :size="15" /><span class="truncate">{{ location }}</span><Icon name="down" :size="14" /></summary>
        <div class="popover-panel" role="menu" aria-label="新任务执行位置">
          <p class="popover-title">新任务执行位置</p>
          <button type="button" role="menuitemradio" :aria-checked="!employee.execution?.localAgent" :disabled="busy" @click="choose(false)"><Icon name="server" :size="16" /><span>服务端</span><Icon v-if="!employee.execution?.localAgent" name="check" :size="16" class="check" /></button>
          <button v-for="client in clients" :key="client.id" type="button" role="menuitemradio" :aria-checked="employee.execution?.localAgent && employee.execution.clientId === client.id" :disabled="busy" @click="choose(true, client.id)"><Icon name="laptop" :size="16" /><span>{{ client.name }}<small>{{ client.platform }}</small></span><Icon v-if="employee.execution?.localAgent && employee.execution.clientId === client.id" name="check" :size="16" class="check" /></button>
          <button v-if="offlineCurrent" type="button" disabled><Icon name="laptop" :size="16" /><span>{{ employee.execution.clientName }}<small>离线</small></span><Icon name="check" :size="16" class="check" /></button>
          <p class="popover-hint">{{ busy ? '正在验证执行环境…' : clients.length ? '只影响之后的新任务，已有任务不变。' : '无在线客户端，连接后可切换；只影响新任务。' }}</p>
        </div>
      </details>
      <span v-else class="place-chip static" :title="'新任务默认执行位置：' + location"><Icon :name="employee.execution?.localAgent ? 'laptop' : 'server'" :size="15" />{{ location }}</span>
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
.identity { display: flex; align-items: center; gap: 10px; flex: 0 1 auto; min-width: 0; max-width: 300px; }
.header-menu { display: none; margin-left: -6px; }
.identity-avatar { display: grid; place-items: center; flex: none; width: 36px; height: 36px; overflow: hidden; border-radius: 10px; background: var(--accent-soft); color: var(--accent-text); font-size: 15px; font-weight: 600; }
.identity-text { display: grid; min-width: 0; }
.identity-text h2 { font-size: 15px; line-height: 1.3; }
.identity-status { display: flex; align-items: center; gap: 6px; overflow: hidden; color: var(--muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.identity-status.warn { color: var(--warn); }
.identity-status.info { color: var(--accent-text); }
.identity-scope { color: var(--muted); }
.employee-tabs { display: flex; align-self: stretch; flex: 1; min-width: 0; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.employee-tabs::-webkit-scrollbar { display: none; }
.employee-tabs button { position: relative; gap: 6px; height: auto; min-height: 0; padding: 0 10px; border: 0; border-radius: 0; background: transparent; color: var(--text-2); font-weight: 500; }
.employee-tabs button:hover:not(:disabled) { background: transparent; color: var(--text); }
.employee-tabs button .icon-svg { color: var(--muted); }
.employee-tabs button.selected { color: var(--text); }
.employee-tabs button.selected .icon-svg { color: var(--accent); }
.employee-tabs button.selected::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; border-radius: 2px 2px 0 0; background: var(--accent); }
.header-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.place-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 200px; height: 30px; padding: 0 8px 0 10px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-2); font-size: 12px; font-weight: 500; cursor: pointer; list-style: none; }
.place-chip::-webkit-details-marker { display: none; }
.place-chip:hover { background: var(--surface-2); }
.place-chip.static { cursor: default; padding-right: 10px; }
.popover { position: relative; }
.popover[open] > summary { background: var(--surface-3); }
.icon-summary { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-md); color: var(--text-2); list-style: none; }
.icon-summary::-webkit-details-marker { display: none; }
.icon-summary:hover { background: var(--surface-3); }
.popover-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; display: grid; gap: 2px; width: 280px; padding: 6px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--sh-lg); animation: rise-in .14s ease; }
.popover-title { padding: 6px 8px 4px; color: var(--muted); font-size: 11px; font-weight: 600; }
.popover-meta { padding: 6px 8px 8px; margin-bottom: 2px; border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.popover-hint { padding: 6px 8px 2px; margin-top: 2px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; line-height: 1.5; }
.popover-panel button { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 36px; padding: 6px 8px; border: 0; background: transparent; font-weight: 400; text-align: left; white-space: normal; }
.popover-panel button:hover:not(:disabled) { background: var(--surface-2); }
.popover-panel button > span { display: grid; flex: 1; }
.popover-panel button small { color: var(--muted); font-size: 11px; }
.popover-panel .icon-svg { color: var(--muted); }
.popover-panel .check { color: var(--accent); }
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
  .identity-scope, .work-toggle, .place-chip { display: none; }
  .employee-tabs { height: 44px; margin: 0 -8px 0 -12px; padding: 0 4px; }
  .employee-tabs button { padding: 0 10px; }
  .employee-tabs button .icon-svg { display: none; }
  .popover-panel { width: min(300px, calc(100vw - 24px)); }
  .icon-summary { width: 40px; height: 40px; }
}
</style>
