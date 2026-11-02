<script setup vapor>
import { ref, onMounted } from "vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
import { formatBeijing } from "../../shared/time";
const props = defineProps({ api: Function, user: Object });
const emit = defineEmits(["error", "notice", "signed-out", "changed"]);
const users = ref([]),
  busy = ref(false),
  create = ref({ username: "", password: "", role: "viewer" }),
  reset = ref({ id: "", password: "" }),
  currentPassword = ref(""),
  newPassword = ref(""),
  creating = ref(false);
const labels = { admin: "管理员", operator: "操作用户", viewer: "只读用户" };
async function run(fn) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    emit("error", e.message);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  if (props.user.role === "admin")
    users.value = (await props.api("/users")).users;
}
async function add() {
  await run(async () => {
    await props.api("/users", "POST", create.value);
    create.value = { username: "", password: "", role: "viewer" };
    creating.value = false;
    await refresh();
    emit("notice", "账号已创建；请通过安全渠道交付初始密码。");
  });
}
async function update(u, change) {
  await run(async () => {
    if (
      !confirm(
        `确认修改 ${u.username} 的网站权限/停用状态？该用户的网页登录将失效，但内部任务继续运行；如需中止任务，请单独使用停止操作。`,
      )
    )
      return;
    await props.api("/users/" + u.id, "PUT", change);
    await refresh();
    if (u.id === props.user.id) emit("signed-out");
    else emit("notice", "权限已更新，旧登录会话已撤销。");
  });
}
async function resetPassword() {
  await run(async () => {
    const id = reset.value.id;
    await props.api("/users/" + id, "PUT", { password: reset.value.password });
    reset.value = { id: "", password: "" };
    if (id === props.user.id) emit("signed-out");
    else emit("notice", "密码已重置，该用户的所有旧登录已撤销。");
  });
}
async function changePassword() {
  await run(async () => {
    await props.api("/auth/password", "POST", {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    currentPassword.value = "";
    newPassword.value = "";
    emit("notice", "密码已修改，请重新登录。");
    emit("signed-out");
  });
}
onMounted(() => void run(refresh));
</script>
<template>
  <PageHeader title="账号与权限" :subtitle="user.username + ' · ' + labels[user.role]" />
  <div class="page-scroll accounts-page">
    <div class="accounts-inner">
      <section class="card me-card">
        <div class="me-head">
          <span class="me-avatar" aria-hidden="true">{{ user.username.slice(0, 1).toUpperCase() }}</span>
          <div><h3>{{ user.username }}</h3><p class="hint">{{ labels[user.role] }} · 退出登录不影响已提交任务。</p></div>
        </div>
        <form class="password-form" @submit.prevent="changePassword">
          <div class="form-head"><strong>修改我的密码</strong><span class="hint">修改后需在所有设备重新登录。</span></div>
          <div class="form-grid three">
            <label>当前密码<input v-model="currentPassword" type="password" required autocomplete="current-password" /></label>
            <label>新密码<input v-model="newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="至少 12 个字符" /></label>
            <button class="primary" :disabled="busy">修改密码并退出全部设备</button>
          </div>
        </form>
      </section>
      <section v-if="user.role === 'admin'" class="card members-card">
        <div class="card-head row">
          <div><h3>成员 <span class="count">{{ users.length }}</span></h3><p class="hint">管理员可管理网站，操作用户可提交任务，只读用户仅可查看授权内容。</p></div>
          <button type="button" class="sm" :class="creating ? '' : 'primary'" @click="creating = !creating"><Icon :name="creating ? 'close' : 'plus'" :size="14" />{{ creating ? '取消' : '新建账号' }}</button>
        </div>
        <p class="callout"><Icon name="alert" :size="16" /><span>执行任务的 agent 拥有容器/服务器工具能力，提交任务的账号必须可信。网站角色不是内部运行权限，也不是多租户沙箱。</span></p>
        <form v-if="creating" class="create-form" @submit.prevent="add">
          <div class="form-grid four">
            <label>用户名<input v-model="create.username" required minlength="3" maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,63}" autocomplete="off" autocapitalize="none" spellcheck="false" /></label>
            <label>初始密码<input v-model="create.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="至少 12 个字符" /></label>
            <label>角色<select v-model="create.role"><option value="viewer">只读用户</option><option value="operator">操作用户（可信）</option><option value="admin">管理员</option></select></label>
            <button class="primary" :disabled="busy">创建账号</button>
          </div>
        </form>
        <div class="member-table" role="table" aria-label="成员列表">
          <div class="member-row member-header" role="row"><span role="columnheader">账号</span><span role="columnheader">角色</span><span role="columnheader">最近登录</span><span role="columnheader"><span class="sr-only">操作</span></span></div>
          <template v-for="u in users" :key="u.id">
            <div class="member-row" :class="{ disabled: u.disabled }" role="row">
              <span class="member-name" role="cell"><span class="member-avatar" aria-hidden="true">{{ u.username.slice(0, 1).toUpperCase() }}</span><strong class="truncate">{{ u.username }}</strong><span v-if="u.id === user.id" class="badge info">我</span><span v-if="u.disabled" class="badge danger">已停用</span></span>
              <span role="cell"><select class="role-select" :value="u.role" :aria-label="u.username + '的角色'" @change="update(u, { role: $event.target.value })"><option value="viewer">只读用户</option><option value="operator">操作用户</option><option value="admin">管理员</option></select></span>
              <span class="member-login" role="cell"><Icon name="clock" :size="12" />{{ u.lastLogin ? formatBeijing(u.lastLogin) : "尚未登录" }}</span>
              <span class="member-actions" role="cell">
                <button type="button" class="sm ghost" :aria-expanded="reset.id === u.id" @click="reset = reset.id === u.id ? { id: '', password: '' } : { id: u.id, password: '' }"><Icon name="key" :size="13" />重置密码</button>
                <button type="button" class="sm" :class="u.disabled ? '' : 'danger-text'" :disabled="busy" @click="update(u, { disabled: !u.disabled })">{{ u.disabled ? "启用" : "停用" }}</button>
              </span>
            </div>
            <form v-if="reset.id === u.id" class="reset-row" @submit.prevent="resetPassword">
              <span class="hint">为 {{ u.username }} 设置新密码，旧登录会全部撤销。</span>
              <input v-model="reset.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" :aria-label="u.username + '的新密码'" placeholder="新密码（至少12字符）" />
              <button class="primary sm" :disabled="busy">重置并撤销旧登录</button>
            </form>
          </template>
        </div>
        <p class="hint isolation-note"><Icon name="lock" :size="12" />每个用户的会话和 Stage 仅本人可见；数字员工由管理员共享管理。</p>
      </section>
    </div>
  </div>
</template>
<style scoped>
.accounts-inner { display: grid; gap: 16px; max-width: 960px; margin: 0 auto; }
.accounts-inner > .card + .card { margin-top: 0; }
.card-head { display: grid; gap: 2px; margin-bottom: 12px; }
.card-head.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.card-head h3 { display: flex; align-items: center; gap: 6px; font-size: 15px; }
.me-head { display: flex; align-items: center; gap: 12px; padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid var(--border); }
.me-avatar { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--text); color: #fff; font-size: 18px; font-weight: 600; }
.me-head h3 { font-size: 16px; }
.form-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.form-head strong { font-size: 13px; }
.form-grid.three { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; }
.form-grid.four { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 160px auto; align-items: end; }
.callout { margin-bottom: 12px; }
.create-form { margin-bottom: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
.member-table { display: grid; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; }
.member-row { display: grid; grid-template-columns: minmax(0, 1.4fr) 140px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 52px; padding: 8px 12px; border-top: 1px solid var(--border); }
.member-row:first-child { border-top: 0; }
.member-header { min-height: 34px; background: var(--surface-2); color: var(--muted); font-size: 11px; font-weight: 600; }
.member-row.disabled .member-name strong { color: var(--muted); text-decoration: line-through; }
.member-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.member-avatar { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--surface-3); color: var(--text-2); font-size: 12px; font-weight: 600; }
.member-name strong { font-size: 13px; font-weight: 600; }
.role-select { width: 100%; height: 30px; font-size: 12px; }
.member-login { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
.member-actions { display: flex; justify-content: flex-end; gap: 4px; }
.reset-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px 12px 48px; border-top: 1px dashed var(--border); background: var(--surface-2); }
.reset-row input { flex: 1; min-width: 180px; }
.reset-row .hint { flex-basis: 100%; }
.isolation-note { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 899px) {
  .form-grid.four { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@media (max-width: 767px) {
  .form-grid.three, .form-grid.four { grid-template-columns: minmax(0, 1fr); }
  .member-header { display: none; }
  .member-row { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 8px; padding: 10px 12px; }
  .member-name { grid-column: 1 / -1; }
  .member-login { grid-column: 1 / -1; grid-row: 2; padding-left: 36px; }
  .member-row > span:nth-child(2) { grid-row: 3; padding-left: 36px; }
  .member-actions { grid-row: 3; }
  .reset-row { padding-left: 12px; }
}
</style>
