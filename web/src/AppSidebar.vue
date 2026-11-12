<script setup vapor>
import { ref, computed } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import GroupAvatar from "./GroupAvatar.vue";
import UserAvatar from "./UserAvatar.vue";
const props = defineProps({
  user: Object,
  isAdmin: Boolean,
  canExecute: Boolean,
  groups: Array,
  chats: Array,
  selectedGroup: String,
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
const emit = defineEmits(["choose", "open-group", "create", "navigate", "logout", "close", "expand", "retry-pairing", "select-session", "remove-session"]);
const clientOpen = ref(false);
const moreOpen = ref(false);
const searching = ref(false);
const query = ref("");
const roleLabel = { admin: "管理员", operator: "操作用户", viewer: "只读用户" };
const adminNav = [["experiences", "经验图谱", "graph"], ["debug", "调试会话", "code"], ["settings", "系统设置", "settings"]];
function employeeTone(entry) { return entry.attentionTasks ? "warn" : entry.activeTasks ? "info" : ""; }
function employeeLine(entry) { return entry.attentionTasks ? `${entry.attentionTasks} 项待你处理` : entry.activeTasks ? `${entry.activeTasks} 项进行中` : "空闲"; }
const unreadLabel = (n) => n > 99 ? "99+" : String(n);
function match(text) {
  const q = query.value.trim().toLowerCase();
  return !q || String(text || "").toLowerCase().includes(q);
}
const visibleGroups = computed(() => (props.groups || []).map((group) => ({
  ...group,
  entries: group.entries.filter((entry) => match(entry.name) || match(employeeLine(entry))),
})).filter((group) => group.entries.length));
const visibleChats = computed(() => (props.chats || []).filter((chat) => match(chat.name) || match(chat.lastText)));
const morePages = computed(() => {
  const pages = [["account", "账号与安全", "user"], ["resources", "资源", "laptop"], ["usage", "Token 统计", "graph"]];
  if (props.isAdmin) pages.push(...adminNav);
  return pages;
});
function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) query.value = "";
}
function go(view) {
  moreOpen.value = false;
  clientOpen.value = false;
  emit("navigate", view);
}
function openSettingsMenu() {
  moreOpen.value = !moreOpen.value;
  clientOpen.value = false;
}
function openClient() {
  clientOpen.value = !clientOpen.value;
  moreOpen.value = false;
}
</script>
<template>
  <div class="sidebar-inner">
    <div class="sidebar-toolbar">
      <button type="button" class="icon rail-only" data-nav-trigger aria-label="展开导航" title="展开导航" @click="emit('expand')"><Icon name="menu" /></button>
      <button type="button" class="icon circle-btn" :class="{ active: searching }" aria-label="搜索牛马" title="搜索" @click="toggleSearch"><Icon name="search" :size="17" /></button>
      <button v-if="canExecute" type="button" class="icon circle-btn" :class="{ active: creating }" aria-label="创建牛马" title="创建牛马" @click="emit('create')"><Icon name="plus" :size="17" /></button>
      <button type="button" class="icon close-navigation" aria-label="关闭导航" @click="emit('close')"><Icon name="close" /></button>
    </div>
    <div v-if="searching" class="sidebar-search nav-label">
      <input v-model="query" type="search" aria-label="搜索牛马或群聊" placeholder="搜索牛马或群聊" autofocus />
    </div>

    <button type="button" class="workspace-hero nav-label" :title="user?.username" @click="go('account')">
      <span class="hero-avatar" aria-hidden="true"><UserAvatar :user-id="user?.id" :name="user?.username" :avatar="user?.avatar" /></span>
      <span class="hero-name truncate">{{ user?.username }}</span>
    </button>

    <div class="sidebar-scroll">
      <template v-for="group in visibleGroups" :key="group.key">
        <div v-if="visibleGroups.length > 1 && groups.length > 1" class="sidebar-group nav-label">{{ group.label }}</div>
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
          <span class="nav-avatar"><EmployeeAvatar :employee-id="entry.id" :name="entry.name" :avatar="entry.avatar" :animate="!!entry.runningTasks" /><span v-if="employeeTone(entry)" :class="['avatar-dot', employeeTone(entry)]" aria-hidden="true"></span></span>
          <span class="nav-text nav-label"><strong class="truncate">{{ entry.name }}</strong><small :class="employeeTone(entry)">{{ employeeLine(entry) }}</small></span>
          <span v-if="entry.unread" class="unread" :aria-label="entry.unread + ' 条未读消息'">{{ unreadLabel(entry.unread) }}</span>
          <span v-else-if="entry.attentionTasks" class="count warn nav-label">{{ entry.attentionTasks }}</span>
          <span v-else-if="entry.activeTasks" class="count nav-label">{{ entry.activeTasks }}</span>
        </button>
      </template>
      <p v-if="!visibleGroups.length" class="sidebar-empty nav-label">{{ query ? "没有匹配的牛马" : "还没有牛马" }}</p>

      <div class="quiet-section">
        <div class="sidebar-section-head">
          <span class="nav-label">群聊</span>
          <button v-if="user?.role !== 'viewer'" type="button" class="icon sm add-employee" :class="{ active: view === 'group' && !selectedGroup }" aria-label="发起群聊" title="发起群聊" @click="emit('open-group', '')"><Icon name="plus" :size="16" /></button>
        </div>
        <button
          v-for="chat in visibleChats"
          :key="chat.id"
          type="button"
          class="nav-item employee-item quiet"
          :class="{ active: view === 'group' && selectedGroup === chat.id }"
          :aria-current="view === 'group' && selectedGroup === chat.id ? 'page' : undefined"
          :title="chat.name"
          @click="emit('open-group', chat.id)"
        >
          <span class="nav-avatar group-nav-avatar"><GroupAvatar :group="chat" /><span v-if="chat.running?.length" class="avatar-dot info" aria-hidden="true"></span></span>
          <span class="nav-text nav-label"><strong class="truncate">{{ chat.name }}</strong><small class="truncate">{{ chat.running?.length ? '牛马回复中…' : chat.lastText || `${chat.users.length} 人 · ${chat.employees.length} 个牛马` }}</small></span>
          <span v-if="chat.unread" class="unread" :aria-label="chat.unread + ' 条未读消息'">{{ unreadLabel(chat.unread) }}</span>
        </button>
        <p v-if="!visibleChats.length" class="sidebar-empty nav-label">{{ query ? "没有匹配的群聊" : "拉上同事和牛马一起干活" }}</p>
      </div>

      <template v-if="view === 'chat' && sessions?.length">
        <div class="sidebar-section-head"><span class="nav-label">历史会话</span><span class="count nav-label">{{ sessions.length }}</span></div>
        <div v-for="s in sessions" :key="s.id" class="session-row" :class="{ active: currentRoot === s.id }">
          <button type="button" class="nav-item" :title="s.title" @click="emit('select-session', s)"><span :class="['dot', running?.[s.id] ? 'info pulse' : '']" aria-hidden="true"></span><span class="nav-label truncate">{{ s.title }}</span></button>
          <button v-if="!s.taskId && !running?.[s.id] && canExecute && s.ownerId === user?.id" type="button" class="icon sm nav-label" title="删除会话" aria-label="删除会话" @click="emit('remove-session', s)"><Icon name="trash" :size="14" /></button>
        </div>
      </template>
    </div>

    <footer class="sidebar-footer">
      <div class="footer-row">
        <button type="button" class="footer-user" :class="{ active: view === 'account' }" title="账号与安全" @click="go('account')">
          <span class="account-avatar" aria-hidden="true"><UserAvatar :user-id="user?.id" :name="user?.username" :avatar="user?.avatar" /></span>
          <span class="nav-label user-name truncate">{{ user?.username }}</span>
        </button>
        <div class="client-status">
          <button type="button" class="connect-pill nav-label" :aria-expanded="clientOpen" :title="clientStatus" @click="openClient">
            <span class="connect-label">连接应用</span>
            <span :class="['status-dot', !clientReady ? '' : clients?.length ? 'ok' : '']" aria-hidden="true"></span>
          </button>
          <div v-if="clientOpen" class="client-popover" role="dialog" aria-label="本机客户端">
            <strong>本机客户端</strong>
            <ul v-if="clients?.length"><li v-for="client in clients" :key="client.id"><span class="dot ok" aria-hidden="true"></span>{{ client.name }}<small>{{ client.platform }} · {{ client.id.slice(0, 6) }}</small></li></ul>
            <p v-else class="hint">没有在线客户端。新任务会在服务端执行；启动 vega-local 并在本机网页授权后即可选择。</p>
            <p v-if="pairingText" class="hint pairing">{{ pairingText }}</p>
            <div class="actions"><button v-if="pairingCode && pairingCode !== 'connected'" type="button" class="sm" @click="emit('retry-pairing')"><Icon name="refresh" :size="14" />重新检测</button><button type="button" class="sm ghost" @click="clientOpen = false">关闭</button></div>
          </div>
        </div>
        <div class="more-wrap">
          <button type="button" class="icon circle-btn more-btn" :class="{ active: moreOpen }" aria-label="更多与设置" title="设置" :aria-expanded="moreOpen" @click="openSettingsMenu"><Icon name="settings" :size="17" /></button>
          <div v-if="moreOpen" class="more-popover" role="menu">
            <button v-for="[id, label, icon] in morePages" :key="id" type="button" role="menuitem" :class="{ active: view === id }" @click="go(id)"><Icon :name="icon" :size="16" /><span>{{ label }}</span></button>
            <button type="button" role="menuitem" @click="moreOpen = false; emit('logout')"><Icon name="logout" :size="16" /><span>退出登录</span></button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>
<style scoped>
.unread { flex: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--danger); color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
.sidebar-inner { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--sidebar); }
.sidebar-toolbar { display: flex; align-items: center; gap: 8px; flex: none; height: 56px; padding: 8px 16px 0; --wails-draggable: drag; }
.sidebar-toolbar > button { --wails-draggable: no-drag; }
.circle-btn { width: 36px; height: 36px; min-height: 36px; border-radius: 50%; color: var(--text-2); background: var(--surface-2); border: 1px solid transparent; }
.circle-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
.circle-btn.active { background: var(--accent-soft); color: var(--accent); }
.close-navigation { margin-left: auto; display: none; }
.rail-only { display: none; }
.sidebar-search { padding: 0 16px 8px; }
.sidebar-search input { width: 100%; height: 34px; min-height: 34px; border-radius: 999px; background: var(--surface-2); border-color: transparent; }
.workspace-hero { display: grid; justify-items: center; gap: 8px; width: calc(100% - 16px); margin: 8px 8px 4px; padding: 16px 8px 18px; border: 0; border-radius: 16px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.workspace-hero:hover:not(:disabled) { background: var(--surface-2); }
.hero-avatar { display: grid; place-items: center; width: 88px; height: 88px; overflow: hidden; border-radius: 50%; background: #1a1a1a; color: #fff; font-size: 36px; font-weight: 600; box-shadow: 0 8px 24px rgb(16 24 40 / 10%); }
.hero-name { max-width: 100%; color: var(--muted); font-size: 13px; font-weight: 500; }
.sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 8px; scrollbar-width: thin; }
.sidebar-section-head { display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 4px 0 10px; margin-top: 8px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.quiet-section { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border); }
.sidebar-group { padding: 8px 8px 2px; color: var(--faint); font-size: 11px; }
.add-employee { color: var(--muted); }
.add-employee.active { background: var(--accent-soft); color: var(--accent); }
.nav-item { display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; min-height: 36px; height: auto; padding: 8px 10px; border: 0; border-radius: 14px; background: transparent; color: var(--text-2); font-weight: 500; text-align: left; }
.nav-item:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.nav-item.active { background: var(--surface-3); color: var(--text); box-shadow: none; }
.employee-item { min-height: 52px; margin: 1px 0; }
.employee-item.quiet { min-height: 48px; }
.nav-avatar, .nav-icon { position: relative; display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 50%; }
.nav-avatar { background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; overflow: hidden; }
.nav-icon { color: var(--muted); }
.group-nav-avatar { font-size: 7px; }
.account-avatar { overflow: hidden; }
.avatar-dot { position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border: 2px solid var(--sidebar); border-radius: 50%; background: var(--faint); }
.avatar-dot.info { background: var(--info); }
.avatar-dot.warn { background: var(--warn); }
.avatar-dot.ok { background: var(--ok); }
.avatar-dot.idle { background: var(--border-strong); }
.nav-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
.nav-text strong { font-size: 13px; font-weight: 600; color: var(--text); }
.nav-text small { overflow: hidden; color: var(--muted); font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.nav-text small.warn { color: var(--warn); }
.nav-text small.info { color: var(--accent-text); }
.sidebar-empty { padding: 8px 10px; color: var(--muted); font-size: 12px; }
.session-row { display: flex; align-items: center; gap: 2px; }
.session-row .nav-item { min-height: 32px; font-weight: 400; }
.session-row.active .nav-item { background: var(--surface-3); color: var(--text); }
.sidebar-footer { flex: none; padding: 8px 10px 12px; }
.footer-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.footer-user { display: flex; align-items: center; gap: 8px; flex: none; max-width: 42%; min-width: 0; height: 36px; min-height: 36px; padding: 0 4px 0 0; border: 0; border-radius: 999px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.footer-user:hover:not(:disabled), .footer-user.active { background: var(--surface-2); }
.account-avatar { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--text); color: #fff; font-size: 12px; font-weight: 600; }
.user-name { font-size: 13px; font-weight: 600; }
.client-status { position: relative; flex: 1; min-width: 0; }
.connect-pill { display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 36px; min-height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-2); font-size: 12px; font-weight: 500; }
.connect-pill:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.connect-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.client-popover, .more-popover { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 50; display: grid; gap: 8px; width: 280px; padding: 12px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--sh-lg); animation: rise-in .15s ease; }
.client-popover ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.client-popover li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.client-popover li small { margin-left: auto; color: var(--muted); }
.client-popover .pairing { padding-top: 6px; border-top: 1px solid var(--border); }
.more-wrap { position: relative; flex: none; }
.more-btn { background: var(--accent); color: #fff; border: 0; }
.more-btn:hover:not(:disabled) { background: var(--accent-hover); color: #fff; }
.more-btn.active { background: var(--accent-hover); color: #fff; }
.more-popover { left: auto; right: 0; width: 220px; padding: 6px; gap: 2px; }
.more-popover button { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 36px; padding: 6px 10px; border: 0; background: transparent; font-weight: 400; text-align: left; }
.more-popover button:hover:not(:disabled), .more-popover button.active { background: var(--surface-2); }
.more-popover .icon-svg { color: var(--muted); }
</style>
