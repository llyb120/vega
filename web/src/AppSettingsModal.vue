<script setup vapor>
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import UserAvatar from "./UserAvatar.vue";
import Accounts from "./Accounts.vue";
import ResourcesView from "./ResourcesView.vue";
import TokenStatsView from "./TokenStatsView.vue";
import SettingsView from "./SettingsView.vue";
const props = defineProps({
  api: Function,
  user: Object,
  isAdmin: Boolean,
  tab: { type: String, default: "account" },
  config: Object,
  models: Array,
  userId: String,
  pageSub: String,
});
const emit = defineEmits(["close", "tab", "error", "notice", "signed-out", "changed", "saved", "page-tab"]);
const current = ref(props.tab === "settings" && !props.isAdmin ? "account" : (props.tab || "account"));
watch(() => props.tab, (tab) => { if (tab) current.value = tab === "settings" && !props.isAdmin ? "account" : tab; });
const nav = computed(() => {
  const items = [
    ["account", "通用", "settings"],
    ["usage", "用量与账单", "graph"],
    ["resources", "资源", "laptop"],
  ];
  if (props.isAdmin) items.push(["settings", "系统设置", "server"]);
  return items;
});
const title = computed(() => nav.value.find((item) => item[0] === current.value)?.[1] || "设置");
function go(id) {
  current.value = id;
  emit("tab", id);
}
</script>
<template>
  <div class="dialog-root" @keydown.esc="emit('close')">
    <button type="button" class="dialog-backdrop" aria-label="关闭设置" @click="emit('close')"></button>
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <aside class="settings-nav">
        <button v-for="[id, label, icon] in nav" :key="id" type="button" :class="{ active: current === id }" @click="go(id)">
          <Icon :name="icon" :size="16" /><span>{{ label }}</span>
        </button>
      </aside>
      <div class="settings-main">
        <header>
          <h2 id="settings-title">{{ title }}</h2>
          <button type="button" class="icon sm" aria-label="关闭" @click="emit('close')"><Icon name="close" :size="16" /></button>
        </header>
        <div class="settings-body">
          <div v-if="current === 'account'" class="account-pane">
            <h3>账户</h3>
            <div class="account-card">
              <span class="account-avatar" aria-hidden="true"><UserAvatar :user-id="user?.id" :name="user?.username" :avatar="user?.avatar" /></span>
              <div class="account-meta">
                <strong>{{ user?.username }}</strong>
                <small>{{ user?.email || user?.role }}</small>
              </div>
            </div>
            <Accounts :api="api" :user="user" @error="emit('error', $event)" @notice="emit('notice', $event)" @signed-out="emit('signed-out')" @changed="emit('changed')" />
          </div>
          <TokenStatsView v-else-if="current === 'usage'" :api="api" :admin="isAdmin" :self-id="userId || user?.id" />
          <ResourcesView v-else-if="current === 'resources'" />
          <SettingsView v-else-if="current === 'settings' && isAdmin" :api="api" :config="config" :user-id="userId || user?.id" :models="models" :tab="pageSub" @tab="emit('page-tab', $event)" @saved="emit('saved', $event)" @error="emit('error', $event)" @notice="emit('notice', $event)" />
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.dialog-root { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 24px; }
.dialog-backdrop { position: absolute; inset: 0; border: 0; border-radius: 0; background: rgb(17 24 39 / 45%); }
.settings-dialog { position: relative; display: flex; width: min(920px, 100%); height: min(680px, calc(100dvh - 48px)); overflow: hidden; border-radius: 20px; background: #fff; box-shadow: 0 24px 80px rgb(16 24 40 / 24%); }
.settings-nav { display: flex; flex-direction: column; gap: 2px; flex: none; width: 200px; padding: 16px 10px; background: #f6f7f9; }
.settings-nav button { justify-content: flex-start; gap: 10px; width: 100%; height: 36px; min-height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: var(--text-2); font-weight: 500; }
.settings-nav button.active, .settings-nav button:hover:not(:disabled) { background: #eceef2; color: var(--text); }
.settings-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.settings-main > header { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 16px 20px 8px; }
.settings-main h2 { font-size: 22px; font-weight: 600; }
.settings-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 24px 24px; }
.settings-body :deep(.page-header), .settings-body :deep(.page-menu) { display: none; }
.account-pane h3 { margin: 4px 0 12px; color: var(--muted); font-size: 13px; font-weight: 500; }
.account-card { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 16px; }
.account-avatar { display: grid; place-items: center; width: 48px; height: 48px; overflow: hidden; border-radius: 50%; background: var(--text); color: #fff; font-weight: 600; }
.account-meta { display: grid; gap: 2px; }
.account-meta small { color: var(--muted); }
</style>
