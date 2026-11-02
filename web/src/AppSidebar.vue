<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
const props = defineProps({
  user: Object,
  isAdmin: Boolean,
  canExecute: Boolean,
  groups: Array,
  selectedEmployee: String,
  view: String,
  creating: Boolean,
  open: Boolean,
  clientReady: Boolean,
  clientStatus: String,
  clients: Array,
  pairingText: String,
  pairingCode: String,
  sessions: Array,
  running: Object,
  currentRoot: String,
});
const emit = defineEmits(["choose", "create", "navigate", "logout", "close", "expand", "retry-pairing", "select-session", "remove-session"]);
const clientOpen = ref(false);
const roleLabel = { admin: "管理员", operator: "操作用户", viewer: "只读用户" };
const adminNav = [["experiences", "经验图谱", "graph"], ["debug", "调试会话", "code"], ["settings", "系统设置", "settings"]];
function employeeTone(entry) { return entry.attentionTasks ? "warn" : entry.activeTasks ? "info" : ""; }
function employeeLine(entry) { return entry.attentionTasks ? `${entry.attentionTasks} 项待你处理` : entry.activeTasks ? `${entry.activeTasks} 项进行中` : "空闲"; }
</script>
<template>
  <div class="sidebar-inner">
    <div class="sidebar-brand">
      <button type="button" class="icon rail-only" data-nav-trigger aria-label="展开导航" title="展开导航" @click="emit('expand')"><Icon name="menu" /></button>
      <span class="brand-mark" aria-hidden="true">V</span>
      <strong class="nav-label">Vega</strong>
      <button type="button" class="icon close-navigation" aria-label="关闭导航" @click="emit('close')"><Icon name="close" /></button>
    </div>

    <div class="sidebar-scroll">
      <div class="sidebar-section-head">
        <span class="nav-label">数字员工</span>
        <button v-if="canExecute" type="button" class="icon sm add-employee" :class="{ active: creating }" aria-label="创建员工" title="创建员工" @click="emit('create')"><Icon name="plus" :size="16" /></button>
      </div>
      <template v-for="group in groups" :key="group.scope">
        <div v-if="groups.length > 1" class="sidebar-group nav-label">{{ group.label }}</div>
        <button
          v-for="entry in group.entries"
          :key="entry.id"
          type="button"
          class="nav-item employee-item"
          :class="{ active: view === 'employee' && !creating && selectedEmployee === entry.id }"
          :aria-current="view === 'employee' && !creating && selectedEmployee === entry.id ? 'page' : undefined"
          :title="entry.name + ' · ' + employeeLine(entry)"
          @click="emit('choose', entry.id)"
        >
          <span class="nav-avatar"><EmployeeAvatar :employee-id="entry.id" :name="entry.name" :avatar="entry.avatar" /><span v-if="employeeTone(entry)" :class="['avatar-dot', employeeTone(entry)]" aria-hidden="true"></span></span>
          <span class="nav-text nav-label"><strong class="truncate">{{ entry.name }}</strong><small :class="employeeTone(entry)">{{ employeeLine(entry) }}</small></span>
          <span v-if="entry.attentionTasks" class="count warn nav-label">{{ entry.attentionTasks }}</span>
          <span v-else-if="entry.activeTasks" class="count nav-label">{{ entry.activeTasks }}</span>
        </button>
      </template>
      <p v-if="!groups.length" class="sidebar-empty nav-label">还没有员工</p>

      <template v-if="view === 'chat' && sessions?.length">
        <div class="sidebar-section-head"><span class="nav-label">历史会话</span><span class="count nav-label">{{ sessions.length }}</span></div>
        <div v-for="s in sessions" :key="s.id" class="session-row" :class="{ active: currentRoot === s.id }">
          <button type="button" class="nav-item" :title="s.title" @click="emit('select-session', s)"><span :class="['dot', running?.[s.id] ? 'info pulse' : '']" aria-hidden="true"></span><span class="nav-label truncate">{{ s.title }}</span></button>
          <button v-if="!s.taskId && !running?.[s.id] && canExecute && s.ownerId === user?.id" type="button" class="icon sm nav-label" title="删除会话" aria-label="删除会话" @click="emit('remove-session', s)"><Icon name="trash" :size="14" /></button>
        </div>
      </template>
    </div>

    <nav class="sidebar-nav" aria-label="主导航">
      <template v-if="isAdmin">
        <div class="sidebar-section-head"><span class="nav-label">管理</span></div>
        <button v-for="[id, label, icon] in adminNav" :key="id" type="button" class="nav-item" :class="{ active: view === id }" :aria-current="view === id ? 'page' : undefined" :title="label" @click="emit('navigate', id)"><span class="nav-icon"><Icon :name="icon" /></span><span class="nav-label">{{ label }}</span></button>
      </template>
    </nav>

    <footer class="sidebar-footer">
      <div class="client-status">
        <button type="button" class="nav-item" :aria-expanded="clientOpen" :title="clientStatus" @click="clientOpen = !clientOpen">
          <span class="nav-icon"><Icon name="laptop" /><span :class="['avatar-dot', !clientReady ? '' : clients?.length ? 'ok' : 'idle']" aria-hidden="true"></span></span>
          <span class="nav-label client-text" role="status" :title="clientStatus + ' · 新会话可选择任意在线客户端，已有会话不会自动切换'">{{ clientStatus }}</span>
        </button>
        <div v-if="clientOpen" class="client-popover" role="dialog" aria-label="本机客户端">
          <strong>本机客户端</strong>
          <ul v-if="clients?.length"><li v-for="client in clients" :key="client.id"><span class="dot ok" aria-hidden="true"></span>{{ client.name }}<small>{{ client.platform }} · {{ client.id.slice(0, 6) }}</small></li></ul>
          <p v-else class="hint">没有在线客户端。新任务会在服务端执行；启动 vega-local 并在本机网页授权后即可选择。</p>
          <p v-if="pairingText" class="hint pairing">{{ pairingText }}</p>
          <div class="actions"><button v-if="pairingCode && pairingCode !== 'connected'" type="button" class="sm" @click="emit('retry-pairing')"><Icon name="refresh" :size="14" />重新检测</button><button type="button" class="sm ghost" @click="clientOpen = false">关闭</button></div>
        </div>
      </div>
      <div class="account-row">
        <button type="button" class="nav-item account-item" :class="{ active: view === 'account' }" title="账号与安全" @click="emit('navigate', 'account')">
          <span class="account-avatar" aria-hidden="true">{{ user?.username?.slice(0, 1).toUpperCase() }}</span>
          <span class="nav-label nav-text"><strong class="truncate">{{ user?.username }}</strong><small>{{ roleLabel[user?.role] }} · 账号与安全</small></span>
        </button>
        <button type="button" class="icon nav-label" aria-label="退出登录" title="退出登录" @click="emit('logout')"><Icon name="logout" :size="17" /></button>
      </div>
    </footer>
  </div>
</template>
<style scoped>
.sidebar-inner { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sidebar-brand { display: flex; align-items: center; gap: 10px; flex: none; height: 52px; padding: 0 12px 0 16px; }
.sidebar-brand .brand-mark { width: 28px; height: 28px; border-radius: 8px; font-size: 14px; }
.sidebar-brand strong { font-size: 15px; }
.close-navigation { margin-left: auto; display: none; }
.rail-only { display: none; }
.sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 8px; scrollbar-width: thin; }
.sidebar-section-head { display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 4px 0 8px; margin-top: 6px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.sidebar-group { padding: 8px 8px 2px; color: var(--faint); font-size: 11px; }
.add-employee { color: var(--muted); }
.add-employee.active { background: var(--accent-soft); color: var(--accent); }
.nav-item { display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; min-height: 36px; height: auto; padding: 6px 8px; border: 0; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-weight: 500; text-align: left; }
.nav-item:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
.nav-item.active { background: var(--surface); color: var(--text); box-shadow: var(--sh-sm); }
.employee-item { min-height: 44px; margin: 1px 0; }
.nav-avatar, .nav-icon { position: relative; display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 8px; }
.nav-avatar { background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; }
.nav-icon { color: var(--muted); }
.nav-item.active .nav-icon { color: var(--accent); }
.avatar-dot { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border: 2px solid var(--sidebar); border-radius: 50%; background: var(--faint); }
.avatar-dot.info { background: var(--info); }
.avatar-dot.warn { background: var(--warn); }
.avatar-dot.ok { background: var(--ok); }
.avatar-dot.idle { background: var(--border-strong); }
.nav-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
.nav-text strong { font-size: 13px; font-weight: 600; color: var(--text); }
.nav-text small { overflow: hidden; color: var(--muted); font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.nav-text small.warn { color: var(--warn); }
.nav-text small.info { color: var(--accent-text); }
.sidebar-empty { padding: 8px; color: var(--muted); font-size: 12px; }
.session-row { display: flex; align-items: center; gap: 2px; }
.session-row .nav-item { min-height: 32px; font-weight: 400; }
.session-row.active .nav-item { background: var(--surface); color: var(--text); }
.sidebar-nav { flex: none; padding: 0 8px 6px; }
.sidebar-footer { flex: none; padding: 6px 8px 10px; border-top: 1px solid var(--border); }
.client-status { position: relative; }
.client-status .nav-item { min-height: 32px; }
.client-text { flex: 1; min-width: 0; overflow: hidden; color: var(--text-2); font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.client-popover { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 50; display: grid; gap: 8px; width: 280px; padding: 12px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--sh-lg); animation: rise-in .15s ease; }
.client-popover ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.client-popover li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.client-popover li small { margin-left: auto; color: var(--muted); }
.client-popover .pairing { padding-top: 6px; border-top: 1px solid var(--border); }
.account-row { display: flex; align-items: center; gap: 2px; margin-top: 2px; }
.account-item { flex: 1; min-width: 0; }
.account-avatar { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--text); color: #fff; font-size: 12px; font-weight: 600; }
</style>
