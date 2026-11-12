<script setup vapor>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
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
  rail: Boolean,
  clientReady: Boolean,
  clientStatus: String,
  clients: Array,
  pairingText: String,
  pairingCode: String,
});
const emit = defineEmits(["choose", "open-group", "create", "navigate", "settings", "logout", "close", "expand", "retry-pairing", "select-session", "remove-session"]);
const moreOpen = ref(false);
const searching = ref(false);
const query = ref("");
const hover = ref(null);
let hoverTimer = 0;
const adminNav = [["experiences", "经验图谱", "graph"], ["debug", "调试会话", "code"], ["settings", "系统设置", "settings"]];
function employeeLine(entry) {
  if (entry.lastText) return entry.lastText;
  if (entry.attentionTasks) return `${entry.attentionTasks} 项待你处理`;
  if (entry.runningTasks) return "正在工作…";
  return "";
}
function chatLine(chat) {
  if (chat.running?.length) return chat.lastText || "牛马回复中…";
  return chat.lastText || "";
}
function match(text) {
  const q = query.value.trim().toLowerCase();
  return !q || String(text || "").toLowerCase().includes(q);
}
const allEntries = computed(() => (props.groups || []).flatMap((group) => group.entries || []));
const defaultEmployee = computed(() => allEntries.value.find((entry) => entry.id === "default") || allEntries.value[0] || null);
const visibleGroups = computed(() => (props.groups || []).map((group) => ({
  ...group,
  entries: group.entries.filter((entry) => {
    if (defaultEmployee.value && entry.id === defaultEmployee.value.id) return false;
    return match(entry.name) || match(employeeLine(entry));
  }),
})).filter((group) => group.entries.length));
const visibleChats = computed(() => (props.chats || []).filter((chat) => match(chat.name) || match(chat.lastText)));
const morePages = computed(() => {
  const pages = [["account", "账号与安全", "user"], ["resources", "资源", "laptop"], ["usage", "Token 统计", "graph"]];
  if (props.isAdmin) pages.push(...adminNav);
  return pages;
});
function isEmployeeUnread(entry) {
  return !!entry.unread && !(props.view === "employee" && !props.creating && props.selectedEmployee === entry.id);
}
function isChatUnread(chat) {
  return !!chat.unread && !(props.view === "group" && props.selectedGroup === chat.id);
}
function hoverPreview(item, kind) {
  if (kind === "chat") return chatLine(item) || `${item.users?.length || 0} 人 · ${item.employees?.length || 0} 个牛马`;
  return employeeLine(item) || "还没有消息";
}
function showHover(event, item, kind) {
  clearTimeout(hoverTimer);
  const row = event.currentTarget.getBoundingClientRect();
  const next = { item, kind, top: row.top + row.height / 2, left: row.right + 8 };
  hoverTimer = window.setTimeout(() => { hover.value = next; }, 80);
}
function hideHover() {
  clearTimeout(hoverTimer);
  hover.value = null;
}
function toggleSearch() {
  searching.value = !searching.value;
  if (!searching.value) query.value = "";
}
function go(view) {
  moreOpen.value = false;
  if (["account", "resources", "usage", "settings"].includes(view)) emit("settings", view);
  else emit("navigate", view);
}
function openSettingsMenu() {
  moreOpen.value = !moreOpen.value;
}
function onUserClick() {
  if (props.rail) openSettingsMenu();
  else go("account");
}
onMounted(() => {
  window.addEventListener("scroll", hideHover, true);
  window.addEventListener("resize", hideHover);
});
onBeforeUnmount(() => {
  hideHover();
  window.removeEventListener("scroll", hideHover, true);
  window.removeEventListener("resize", hideHover);
});
</script>
<template>
  <div class="sidebar-inner">
    <div class="sidebar-toolbar">
      <button type="button" class="icon rail-only" data-nav-trigger aria-label="展开导航" title="展开导航" @click="emit('expand')"><Icon name="menu" /></button>
      <button type="button" class="icon circle-btn" :class="{ active: searching }" aria-label="搜索牛马" title="搜索" @click="toggleSearch"><Icon name="search" :size="17" /></button>
      <button v-if="canExecute" type="button" class="icon circle-btn toolbar-add" :class="{ active: creating }" aria-label="创建牛马" title="创建牛马" @click="emit('create')"><Icon name="plus" :size="17" /></button>
      <button type="button" class="icon close-navigation" aria-label="关闭导航" @click="emit('close')"><Icon name="close" /></button>
    </div>
    <div v-if="searching" class="sidebar-search nav-label">
      <input v-model="query" type="search" aria-label="搜索牛马或群聊" placeholder="搜索牛马或群聊" autofocus />
    </div>

    <button
      v-if="defaultEmployee"
      type="button"
      class="workspace-hero nav-label"
      :class="{ active: view === 'employee' && !creating && selectedEmployee === defaultEmployee.id }"
      @click="emit('choose', defaultEmployee.id)"
      @mouseenter="showHover($event, defaultEmployee, 'employee')"
      @mouseleave="hideHover"
    >
      <span class="hero-avatar" :class="{ running: defaultEmployee.runningTasks }" aria-hidden="true">
        <EmployeeAvatar :employee-id="defaultEmployee.id" :name="defaultEmployee.name" :avatar="defaultEmployee.avatar" :animate="!!defaultEmployee.runningTasks" />
        <span v-if="isEmployeeUnread(defaultEmployee)" class="avatar-dot unread-dot" aria-label="有未读消息"></span>
      </span>
      <span class="hero-name truncate">{{ defaultEmployee.name }}</span>
    </button>

    <div class="sidebar-scroll">
      <template v-for="group in visibleGroups" :key="group.key">
        <div v-if="visibleGroups.length > 1 && groups.length > 1" class="sidebar-group nav-label">{{ group.label }}</div>
        <button
          v-for="entry in group.entries"
          :key="entry.id"
          type="button"
          class="nav-item employee-item"
          :class="{ active: view === 'employee' && !creating && selectedEmployee === entry.id, unread: isEmployeeUnread(entry) }"
          :aria-current="view === 'employee' && !creating && selectedEmployee === entry.id ? 'page' : undefined"
          @click="emit('choose', entry.id)"
          @mouseenter="showHover($event, entry, 'employee')"
          @mouseleave="hideHover"
        >
          <span class="nav-avatar" :class="{ running: entry.runningTasks }">
            <EmployeeAvatar :employee-id="entry.id" :name="entry.name" :avatar="entry.avatar" :animate="!!entry.runningTasks" />
            <span v-if="isEmployeeUnread(entry)" class="avatar-dot unread-dot" aria-label="有未读消息"></span>
          </span>
          <span class="nav-text nav-label"><strong class="truncate">{{ entry.name }}</strong><small class="truncate">{{ employeeLine(entry) }}</small></span>
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
          :class="{ active: view === 'group' && selectedGroup === chat.id, unread: isChatUnread(chat) }"
          :aria-current="view === 'group' && selectedGroup === chat.id ? 'page' : undefined"
          @click="emit('open-group', chat.id)"
          @mouseenter="showHover($event, chat, 'chat')"
          @mouseleave="hideHover"
        >
          <span class="nav-avatar group-nav-avatar" :class="{ running: chat.running?.length }">
            <GroupAvatar :group="chat" />
            <span v-if="isChatUnread(chat)" class="avatar-dot unread-dot" aria-label="有未读消息"></span>
          </span>
          <span class="nav-text nav-label"><strong class="truncate">{{ chat.name }}</strong><small class="truncate">{{ chatLine(chat) }}</small></span>
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
        <div class="rail-tools">
          <button v-if="canExecute" type="button" class="icon circle-btn" aria-label="创建牛马" title="创建牛马" @click="emit('create')"><Icon name="plus" :size="18" /></button>
          <button v-if="user?.role !== 'viewer'" type="button" class="icon circle-btn" aria-label="发起群聊" title="发起群聊" @click="emit('open-group', '')"><Icon name="grid" :size="18" /></button>
        </div>
        <button type="button" class="footer-user" :class="{ active: view === 'account' || (rail && moreOpen) }" :title="rail ? '更多与设置' : '账号与安全'" @click="onUserClick">
          <span class="account-avatar" aria-hidden="true"><UserAvatar :user-id="user?.id" :name="user?.username" :avatar="user?.avatar" /></span>
          <span class="nav-label user-name truncate">{{ user?.username }}</span>
        </button>
        <div class="more-wrap">
          <button type="button" class="icon circle-btn more-btn" :class="{ active: moreOpen }" aria-label="更多与设置" title="设置" :aria-expanded="moreOpen" @click="openSettingsMenu"><Icon name="settings" :size="17" /></button>
          <div v-if="moreOpen" class="more-popover" role="menu">
            <button v-for="[id, label, icon] in morePages" :key="id" type="button" role="menuitem" :class="{ active: view === id }" @click="go(id)"><Icon :name="icon" :size="16" /><span>{{ label }}</span></button>
            <button type="button" role="menuitem" @click="moreOpen = false; emit('logout')"><Icon name="logout" :size="16" /><span>退出登录</span></button>
          </div>
        </div>
      </div>
    </footer>

    <Teleport to="body">
      <div v-if="hover" class="sidebar-hover-card" :style="{ top: hover.top + 'px', left: hover.left + 'px' }" role="tooltip">
        <span class="hover-avatar" aria-hidden="true">
          <EmployeeAvatar v-if="hover.kind === 'employee'" :employee-id="hover.item.id" :name="hover.item.name" :avatar="hover.item.avatar" />
          <GroupAvatar v-else :group="hover.item" />
        </span>
        <span class="hover-text">
          <strong class="truncate">{{ hover.item.name }}</strong>
          <small class="truncate">{{ hoverPreview(hover.item, hover.kind) }}</small>
        </span>
      </div>
    </Teleport>
  </div>
</template>
<style scoped>
.sidebar-inner { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--sidebar); }
.sidebar-toolbar { display: flex; align-items: center; gap: 8px; flex: none; height: 56px; padding: 8px 16px 0; --wails-draggable: drag; }
.sidebar-toolbar > button { --wails-draggable: no-drag; }
.toolbar-add { margin-left: auto; }
.circle-btn { width: 36px; height: 36px; min-height: 36px; border-radius: 50%; color: var(--text-2); background: var(--surface-2); border: 1px solid transparent; }
.circle-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
.circle-btn.active { background: var(--accent-soft); color: var(--accent); }
.close-navigation { display: none; }
.rail-only { display: none; }
.sidebar-search { padding: 0 16px 8px; }
.sidebar-search input { width: 100%; height: 34px; min-height: 34px; border-radius: 999px; background: var(--surface-2); border-color: transparent; }
.workspace-hero { display: grid; justify-items: center; gap: 8px; width: calc(100% - 16px); margin: 8px 8px 4px; padding: 16px 8px 18px; border: 0; border-radius: 16px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.workspace-hero:hover:not(:disabled), .workspace-hero.active { background: var(--surface-2); }
.hero-avatar { position: relative; display: grid; place-items: center; width: 88px; height: 88px; border-radius: 50%; background: #1a1a1a; color: #fff; font-size: 36px; font-weight: 600; box-shadow: 0 8px 24px rgb(16 24 40 / 10%); overflow: visible; }
.hero-avatar :deep(.employee-picture) { width: 88px; height: 88px; border-radius: 50%; overflow: hidden; }
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
.nav-avatar, .nav-icon { position: relative; display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 50%; }
.nav-avatar { background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; overflow: visible; }
.nav-avatar :deep(.employee-picture) { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; }
.nav-icon { color: var(--muted); }
.group-nav-avatar { font-size: 7px; }
.account-avatar { overflow: hidden; }
.avatar-dot { position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border: 2px solid var(--sidebar); border-radius: 50%; background: var(--faint); }
.unread-dot { width: 12px; height: 12px; border-width: 2px; background: #3ec6ff; box-shadow: 0 0 0 1px rgb(255 255 255 / 80%); }
.hero-avatar .unread-dot { width: 16px; height: 16px; right: 2px; bottom: 2px; border-color: #fff; }
.nav-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
.nav-text strong { font-size: 13px; font-weight: 600; color: var(--text); }
.nav-text small { overflow: hidden; color: var(--muted); font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.employee-item.unread .nav-text small { color: var(--text); }
.sidebar-empty { padding: 8px 10px; color: var(--muted); font-size: 12px; }
.session-row { display: flex; align-items: center; gap: 2px; }
.session-row .nav-item { min-height: 32px; font-weight: 400; }
.session-row.active .nav-item { background: var(--surface-3); color: var(--text); }
.rail-tools { display: none; }
.sidebar-footer { flex: none; padding: 8px 10px 12px; }

.footer-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.footer-user { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; height: 36px; min-height: 36px; padding: 0 8px 0 0; border: 0; border-radius: 999px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.footer-user:hover:not(:disabled), .footer-user.active { background: var(--surface-2); }
.account-avatar { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--text); color: #fff; font-size: 12px; font-weight: 600; }
.user-name { font-size: 13px; font-weight: 600; }
.more-wrap { position: relative; flex: none; }
.more-btn { background: var(--accent); color: #fff; border: 0; }
.more-btn:hover:not(:disabled) { background: var(--accent-hover); color: #fff; }
.more-btn.active { background: var(--accent-hover); color: #fff; }
.more-popover { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 50; display: grid; gap: 2px; width: 240px; padding: 8px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: 0 12px 40px rgb(16 24 40 / 16%); animation: rise-in .15s ease; }
.more-popover button { justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 36px; padding: 6px 10px; border: 0; background: transparent; font-weight: 400; text-align: left; }
.more-popover button:hover:not(:disabled), .more-popover button.active { background: var(--surface-2); }
.more-popover .icon-svg { color: var(--muted); }
</style>
<style>
.sidebar-hover-card { position: fixed; z-index: 80; display: flex; align-items: center; gap: 10px; min-width: 220px; max-width: 320px; padding: 10px 12px; border-radius: 14px; background: #fff; box-shadow: 0 8px 28px rgb(16 24 40 / 16%); transform: translateY(-50%); pointer-events: none; }
.sidebar-hover-card .hover-avatar { display: grid; place-items: center; flex: none; width: 36px; height: 36px; overflow: hidden; border-radius: 50%; background: #f3f4f6; }
.sidebar-hover-card .hover-text { display: grid; min-width: 0; gap: 2px; }
.sidebar-hover-card strong { font-size: 13px; font-weight: 600; color: #111827; }
.sidebar-hover-card small { overflow: hidden; color: #6b7280; font-size: 12px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
</style>
