<script setup vapor>
import { ref, onMounted } from "vue";
const props = defineProps({ api: Function, user: Object, sessions: Array });
const emit = defineEmits(["error", "notice", "signed-out", "changed"]);
const users = ref([]),
  busy = ref(false),
  create = ref({ username: "", password: "", role: "viewer" }),
  reset = ref({ id: "", password: "" }),
  currentPassword = ref(""),
  newPassword = ref(""),
  sharedSession = ref(""),
  readerIds = ref([]);
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
    reset.value.password = "";
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
async function loadAccess() {
  if (sharedSession.value)
    readerIds.value =
      (await props.api("/sessions/" + sharedSession.value)).session.readerIds ||
      [];
}
async function saveAccess() {
  await run(async () => {
    await props.api("/sessions/" + sharedSession.value + "/access", "PUT", {
      readerIds: readerIds.value,
    });
    emit(
      "notice",
      "会话查看权限已更新；授权查看不授予发送消息或执行工具的权限。",
    );
    emit("changed");
  });
}
onMounted(() => void run(refresh));
</script>
<template>
  <header class="topbar">
    <div>
      <h2>账号与权限</h2>
      <p>{{ user.username }} · {{ labels[user.role] }}</p>
    </div>
  </header>
  <div class="page-scroll settings">
    <p class="hint">退出登录不影响已提交任务。</p>
    <section class="card">
      <h3>修改我的密码</h3>
      <p class="hint">修改密码后需重新登录。</p>
      <form class="form-grid" @submit.prevent="changePassword">
        <label
          >当前密码<input
            v-model="currentPassword"
            type="password"
            required
            autocomplete="current-password" /></label
        ><label
          >新密码<input
            v-model="newPassword"
            type="password"
            required
            minlength="12"
            maxlength="128"
            autocomplete="new-password" /></label
        ><button class="primary" :disabled="busy">
          修改密码并退出全部设备
        </button>
      </form>
    </section>
    <template v-if="user.role === 'admin'">
      <section class="card">
        <h3>账号管理</h3>
        <p>管理员可管理网站，操作用户可提交任务，只读用户仅可查看授权内容。</p>
        <p class="attention">
          执行任务的agent拥有容器/服务器工具能力，提交任务的账号必须可信。网站角色不是内部运行权限，也不是多租户沙箱。
        </p>
        <form class="form-grid" @submit.prevent="add">
          <label
            >用户名<input
              v-model="create.username"
              required
              minlength="3"
              maxlength="64"
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false" /></label
          ><label
            >初始密码<input
              v-model="create.password"
              type="password"
              required
              minlength="12"
              maxlength="128"
              autocomplete="new-password" /></label
          ><label
            >角色<select v-model="create.role">
              <option value="viewer">只读用户</option>
              <option value="operator">操作用户（可信）</option>
              <option value="admin">管理员</option>
            </select></label
          ><button class="primary" :disabled="busy">创建账号</button>
        </form>
        <article v-for="u in users" :key="u.id" class="card">
          <div class="section-heading">
            <strong
              >{{ u.username }}{{ u.id === user.id ? "（我）" : "" }}</strong
            ><span class="pill">{{
              u.disabled ? "已停用" : labels[u.role]
            }}</span>
          </div>
          <p class="hint">
            最近登录：{{
              u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "尚未登录"
            }}
          </p>
          <div class="card-actions">
            <select
              :value="u.role"
              :aria-label="u.username + '的角色'"
              @change="update(u, { role: $event.target.value })"
            >
              <option value="viewer">只读用户</option>
              <option value="operator">操作用户</option>
              <option value="admin">管理员</option></select
            ><button
              :disabled="busy"
              @click="update(u, { disabled: !u.disabled })"
            >
              {{ u.disabled ? "启用" : "停用" }}
            </button>
          </div>
        </article>
        <details>
          <summary>重置账号密码</summary>
          <form class="inline-form" @submit.prevent="resetPassword">
            <select v-model="reset.id" required aria-label="重置密码的账号">
              <option value="" disabled>选择账号</option>
              <option v-for="u in users" :key="u.id" :value="u.id">
                {{ u.username }}
              </option></select
            ><input
              v-model="reset.password"
              type="password"
              required
              minlength="12"
              maxlength="128"
              autocomplete="new-password"
              placeholder="新密码（至少12字符）"
            /><button :disabled="busy">重置并撤销旧登录</button>
          </form>
        </details>
      </section>
      <section class="card">
        <h3>授权查看会话</h3>
        <p class="hint">
          旧版本的会话仅管理员可见。可单独授权其他账号查看已有会话；其工具调用、图片和正文均属于共享内容，授权前请检查敏感信息。
        </p>
        <select
          v-model="sharedSession"
          @change="run(loadAccess)"
          aria-label="要共享的会话"
        >
          <option value="">选择会话</option>
          <option v-for="s in sessions || []" :key="s.id" :value="s.id">
            {{ s.title }}
          </option></select
        ><template v-if="sharedSession"
          ><div class="form-grid">
            <label
              v-for="u in users.filter(
                (u) => u.role !== 'admin' && !u.disabled,
              )"
              :key="u.id"
              ><input v-model="readerIds" type="checkbox" :value="u.id" />{{
                u.username
              }}（{{ labels[u.role] }}）</label
            >
          </div>
          <button :disabled="busy" @click="saveAccess">
            保存查看授权
          </button></template
        >
      </section>
    </template>
  </div>
</template>
