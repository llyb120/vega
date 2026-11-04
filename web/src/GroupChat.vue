<script setup vapor>
import { computed, nextTick, onMounted, provide, ref, watch } from "vue";
import PageHeader from "./PageHeader.vue";
import ChatMessage from "./ChatMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import UserAvatar from "./UserAvatar.vue";
import GroupAvatar from "./GroupAvatar.vue";
import MentionTextarea from "./MentionTextarea.vue";
import Icon from "./Icon.vue";
import { continuesPrevious } from "./conversation";
import { groupMembers, groupMentionPeople } from "./group.js";
import { attachmentPayload, isImage, readAttachments } from "./attachments.js";
// One group chat (or, without groupId, the form that creates one). Live updates arrive as `revision` bumps.
const props = defineProps({ api: Function, user: Object, groupId: String, myEmployees: Array, revision: Number });
const emit = defineEmits(["changed", "created", "closed", "open-employee", "open-task", "cancel"]);
const group = ref(null), messages = ref([]), taskStatus = ref({}), error = ref(""), draft = ref(""), sending = ref(false), panel = ref(false), transcript = ref(null), input = ref(null), fileInput = ref(null), files = ref([]);
const directory = ref([]), form = ref({ name: "", bulletin: "", users: [], employees: [] }), edit = ref({ name: "", bulletin: "" }), invite = ref(""), bring = ref("");
const readonly = computed(() => props.user?.role === "viewer");
const members = computed(() => groupMembers(group.value, props.user?.id));
provide("mentions", { people: computed(() => groupMentionPeople(group.value)), open: (id) => emit("open-employee", id) });
// Authors carry ids and names; avatars come from the current member list (a member who left keeps the initial / default bot).
const avatars = computed(() => new Map([...(group.value?.users || []), ...(group.value?.employees || [])].map((p) => [p.id, p.avatar || ""])));
const shown = computed(() => {
  const rows = messages.value.filter((m) => m.notice || m.text?.trim() || m.tasks?.length || m.images?.length || m.files?.length)
    .map((m) => m.author ? { ...m, author: { ...m.author, avatar: avatars.value.get(m.author.id) || "" } } : m);
  return rows.map((message, index) => ({ message, continued: !message.notice && continuesPrevious(rows[index - 1], message) }));
});
const runningMembers = computed(() => (group.value?.employees || []).filter((e) => group.value.running?.includes(e.id)));
const available = computed(() => (props.myEmployees || []).filter((e) => !group.value?.employees.some((m) => m.id === e.id)));
const invitable = computed(() => directory.value.filter((u) => !group.value?.users.some((m) => m.id === u.id)));
// Both add rows always show, so users find them; when empty they say why.
const noUsersHint = computed(() => props.user?.role === "admin" ? "没有可邀请的用户（在左下角「账号与安全」→ 成员里新建账号）" : "没有可邀请的用户（请管理员在「账号与安全」里新建账号）");
const noEmployeesHint = computed(() => props.myEmployees?.length ? "你的牛马都已在群里" : "你还没有牛马（先在左侧「数字牛马」里新建）");
const canStop = (e) => e.mine || group.value?.isCreator;

async function run(fn) {
  error.value = "";
  try { return await fn(); } catch (e) { error.value = e.message; }
}
function nearBottom() {
  const el = transcript.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
async function load(scroll = false) {
  if (!props.groupId) return;
  const id = props.groupId, stick = scroll || nearBottom();
  const result = await props.api(`/groups/${id}/messages?limit=200`);
  if (props.groupId !== id) return;
  messages.value = result.messages;
  taskStatus.value = result.taskStatus || {};
  group.value = result.group;
  edit.value = { name: result.group.name, bulletin: result.group.bulletin };
  if (stick) { await nextTick(); transcript.value?.scrollTo({ top: transcript.value.scrollHeight }); }
}
async function loadDirectory() {
  try { directory.value = (await props.api("/groups/directory")).filter((u) => u.id !== props.user?.id); } catch { directory.value = []; }
}
async function upload(event) {
  await run(async () => { files.value = [...files.value, ...await readAttachments(event.target.files, files.value)]; });
  event.target.value = "";
}
async function send() {
  const text = draft.value.trim(), items = files.value;
  if ((!text && !items.length) || sending.value) return;
  sending.value = true;
  await run(async () => {
    // getRandomValues also works over LAN HTTP, where randomUUID is unavailable.
    const clientMessageId = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
    await props.api(`/groups/${props.groupId}/messages`, "POST", { text, ...attachmentPayload(items), clientMessageId });
    draft.value = "";
    if (files.value === items) files.value = [];
    await load(true);
  });
  sending.value = false;
  input.value?.focus();
}
function keydown(event) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) { event.preventDefault(); void send(); }
}
async function change(fn, after) {
  await run(async () => { const result = await fn(); await after?.(result); emit("changed"); });
}
const saveInfo = () => change(() => props.api(`/groups/${props.groupId}`, "PATCH", edit.value), () => load());
const addUser = () => invite.value && change(() => props.api(`/groups/${props.groupId}/users`, "POST", { userIds: [invite.value] }), () => { invite.value = ""; return load(); });
const addEmployee = () => bring.value && change(() => props.api(`/groups/${props.groupId}/employees`, "POST", { employeeId: bring.value }), () => { bring.value = ""; return load(); });
const removeEmployee = (e) => confirm(`把牛马「${e.name}」移出群聊？`) && change(() => props.api(`/groups/${props.groupId}/employees/${e.id}`, "DELETE"), () => load());
const removeUser = (u) => confirm(`把 ${u.name} 移出群聊？他的牛马也会一起离开。`) && change(() => props.api(`/groups/${props.groupId}/users/${u.id}`, "DELETE"), () => load());
const stop = (e) => run(() => props.api(`/groups/${props.groupId}/cancel`, "POST", { employeeId: e.id }));
function leave() {
  const mine = group.value.employees.filter((e) => e.mine).length;
  if (!confirm(`退出群聊「${group.value.name}」？${mine ? "你的牛马也会一起离开。" : ""}${group.value.users.length === 1 ? "你是最后一位成员，群聊会被解散。" : ""}`)) return;
  void change(() => props.api(`/groups/${props.groupId}/users/${props.user.id}`, "DELETE"), () => emit("closed"));
}
function dissolve() {
  if (!confirm(`解散群聊「${group.value.name}」？群消息和牛马在群里的对话都会删除（已派出的任务保留，结果回到各自牛马的私聊）。`)) return;
  void change(() => props.api(`/groups/${props.groupId}`, "DELETE"), () => emit("closed"));
}
async function create() {
  await run(async () => {
    const created = await props.api("/groups", "POST", form.value);
    form.value = { name: "", bulletin: "", users: [], employees: [] };
    emit("changed");
    emit("created", created.id);
  });
}
function openTask(message, taskId) {
  const author = group.value?.employees.find((e) => e.id === message.author?.id);
  if (author?.mine) emit("open-task", { employeeId: author.id, taskId });
  else error.value = "这是其他用户的牛马的任务，只有它的主人能查看详情";
}
watch(() => props.groupId, () => { group.value = null; messages.value = []; panel.value = false; draft.value = ""; void run(() => load(true)); });
watch(() => props.revision, () => void run(() => load()));
watch(panel, (open) => { if (open && !directory.value.length) void loadDirectory(); });
onMounted(() => { if (props.groupId) void run(() => load(true)); else void loadDirectory(); });
</script>
<template>
  <section class="group-workspace">
    <template v-if="!groupId">
      <PageHeader title="发起群聊" subtitle="拉上同事和牛马，在群里 @ 谁就由谁来干活。" back="返回" @back="emit('cancel')" />
      <div class="page-scroll create-page">
        <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span><button class="icon" aria-label="关闭" @click="error = ''"><Icon name="close" :size="14" /></button></p>
        <form class="card create-card" @submit.prevent="create">
          <div class="form-grid">
            <label>群名<input v-model="form.name" required maxlength="40" placeholder="例如：发布小组、周报协作" autofocus /></label>
            <label>群公告<textarea v-model="form.bulletin" rows="5" maxlength="4000" placeholder="写清分工和协作方式，例如：研发助手负责写代码；测试助手负责验证，发现问题 @研发助手 修复；发布前 @我 确认。"></textarea><small class="hint">群里的牛马每次回复都会按公告干活。</small></label>
            <fieldset><legend>邀请用户</legend><label v-for="u in directory" :key="u.id" class="check"><input v-model="form.users" type="checkbox" :value="u.id" />{{ u.name }}</label><small v-if="!directory.length" class="hint">{{ noUsersHint }}</small></fieldset>
            <fieldset><legend>拉入我的牛马</legend><label v-for="e in myEmployees" :key="e.id" class="check"><input v-model="form.employees" type="checkbox" :value="e.id" />{{ e.name }}</label><small v-if="!myEmployees?.length" class="hint">{{ noEmployeesHint }}</small></fieldset>
            <p class="hint">每个人只能拉自己的牛马进群；被邀请的用户进群后，在群里右上角「群成员与公告」面板拉入他们自己的牛马。</p>
          </div>
          <div class="actions end"><button type="button" class="ghost" @click="emit('cancel')">取消</button><button class="primary" :disabled="!form.name.trim()">创建群聊</button></div>
        </form>
      </div>
    </template>
    <template v-else>
      <PageHeader :title="group?.name || '群聊'" :subtitle="group ? `${group.users.length} 位用户 · ${group.employees.length} 个牛马` : ''">
        <template #title-extra><span v-if="group" class="header-avatar"><GroupAvatar :group="group" /></span></template>
        <button type="button" class="sm" :class="{ active: panel }" :aria-expanded="panel" @click="panel = !panel"><Icon name="users" :size="15" /><span class="hide-mobile">群成员与公告</span></button>
      </PageHeader>
      <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span><button class="icon" aria-label="关闭" @click="error = ''"><Icon name="close" :size="14" /></button></p>
      <div class="group-body">
        <section class="group-chat">
          <div ref="transcript" class="chat-scroll" aria-live="polite">
            <div class="chat-column">
              <div v-if="group?.bulletin" class="group-bulletin"><Icon name="inbox" :size="14" /><div><strong>群公告</strong><p>{{ group.bulletin }}</p></div></div>
              <template v-for="{ message, continued } in shown" :key="message.seq">
                <p v-if="message.notice" class="group-notice">{{ message.text }}</p>
                <ChatMessage v-else :message="message" :continued="continued" :viewer-id="user?.id" :task-status="taskStatus" :employee-id="message.author?.id" :name="message.author?.name" @task="openTask(message, $event)" />
              </template>
              <article v-for="e in runningMembers" :key="'typing-' + e.id" class="chat-message assistant chat-typing" role="status" :aria-label="e.name + ' 正在回复'">
                <span class="chat-avatar" aria-hidden="true"><EmployeeAvatar :employee-id="e.id" :name="e.name" :avatar="e.avatar" animate /></span>
                <div class="chat-content">
                  <div class="chat-heading"><strong>{{ e.name }}</strong><span>正在回复</span><button v-if="canStop(e) && !readonly" type="button" class="ghost sm stop-reply" @click="stop(e)"><Icon name="stop" :size="12" />停止</button></div>
                  <div class="chat-bubble"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
                </div>
              </article>
            </div>
          </div>
          <p v-if="readonly" class="readonly-note"><Icon name="lock" :size="14" />只读账号只能查看群聊。</p>
          <form v-else class="chat-composer" @submit.prevent="send">
            <div v-if="files.length" class="attachments"><button v-for="(file, index) in files" :key="index" type="button" :title="'移除 ' + file.name" @click="files.splice(index, 1)"><Icon :name="isImage(file) ? 'image' : 'file'" :size="12" />{{ file.name }}<Icon name="close" :size="12" /></button></div>
            <div class="composer-row">
              <input ref="fileInput" type="file" hidden multiple @change="upload" />
              <button type="button" class="icon attach" aria-label="添加附件" title="附件（图片或文件）" @click="fileInput.click()"><Icon name="paperclip" /></button>
              <MentionTextarea ref="input" v-model="draft" class="composer-input" :members="members" rows="1" maxlength="20000" placeholder="输入消息，@ 牛马让它干活…" @keydown="keydown" />
              <button class="primary send" :disabled="(!draft.trim() && !files.length) || sending" aria-label="发送" title="发送"><Icon name="send" :size="18" /></button>
            </div>
            <p class="composer-hint">@ 牛马才会回复 · Enter 发送 · Shift + Enter 换行</p>
          </form>
        </section>
        <aside v-if="panel && group" class="group-panel" aria-label="群成员与公告">
          <section>
            <h3>群公告</h3>
            <form v-if="group.isCreator && !readonly" class="form-grid" @submit.prevent="saveInfo">
              <label>群名<input v-model="edit.name" required maxlength="40" /></label>
              <label>公告<textarea v-model="edit.bulletin" rows="6" maxlength="4000" placeholder="写清分工和协作方式"></textarea></label>
              <div class="actions end"><button class="sm primary">保存</button></div>
            </form>
            <p v-else class="bulletin-text">{{ group.bulletin || '群主还没有写公告。' }}</p>
          </section>
          <section>
            <h3>用户 · {{ group.users.length }}</h3>
            <ul class="member-list">
              <li v-for="u in group.users" :key="u.id"><span class="member-avatar"><UserAvatar :user-id="u.id" :name="u.name" :avatar="u.avatar" /></span><span class="member-name truncate">{{ u.name }}<small v-if="u.id === group.creatorId">群主</small><small v-if="u.id === user?.id">我</small></span>
                <button v-if="group.isCreator && u.id !== user?.id && !readonly" type="button" class="icon sm" :aria-label="'移出 ' + u.name" title="移出群聊" @click="removeUser(u)"><Icon name="close" :size="14" /></button></li>
            </ul>
            <div v-if="!readonly" class="add-row"><select v-model="invite" aria-label="邀请用户" :disabled="!invitable.length"><option value="">{{ invitable.length ? "邀请用户…" : "没有可邀请的用户" }}</option><option v-for="u in invitable" :key="u.id" :value="u.id">{{ u.name }}</option></select><button type="button" class="sm" :disabled="!invite" @click="addUser">邀请</button></div>
            <p v-if="!readonly && !invitable.length" class="hint">{{ noUsersHint }}</p>
          </section>
          <section>
            <h3>牛马 · {{ group.employees.length }}</h3>
            <ul class="member-list">
              <li v-for="e in group.employees" :key="e.id"><span class="member-avatar"><EmployeeAvatar :employee-id="e.id" :name="e.name" :avatar="e.avatar" /></span>
                <button v-if="e.mine" type="button" class="link member-name truncate" :title="'打开 ' + e.name" @click="emit('open-employee', e.id)">{{ e.name }}<small>我的</small></button>
                <span v-else class="member-name truncate">{{ e.name }}<small>{{ e.ownerName || '其他用户' }}的</small></span>
                <button v-if="(e.mine || group.isCreator) && !readonly" type="button" class="icon sm" :aria-label="'移出 ' + e.name" title="移出群聊" @click="removeEmployee(e)"><Icon name="close" :size="14" /></button></li>
            </ul>
            <div v-if="!readonly" class="add-row"><select v-model="bring" aria-label="拉入我的牛马" :disabled="!available.length"><option value="">{{ available.length ? "拉入我的牛马…" : noEmployeesHint }}</option><option v-for="e in available" :key="e.id" :value="e.id">{{ e.name }}</option></select><button type="button" class="sm" :disabled="!bring" @click="addEmployee">拉入</button></div>
            <p class="hint">只能拉你自己的牛马；被邀请的用户在这个面板里拉入他们自己的牛马。别人的牛马在群里只接派单（查询、补充、续做、停止任务），不会用主人的职责、记忆和密码本。</p>
          </section>
          <section class="panel-actions">
            <button type="button" class="ghost sm danger-text" @click="leave"><Icon name="logout" :size="14" />退出群聊</button>
            <button v-if="group.isCreator && !readonly" type="button" class="ghost sm danger-text" @click="dissolve"><Icon name="trash" :size="14" />解散群聊</button>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>
<style scoped>
.group-workspace { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.header-avatar { display: inline-grid; width: 24px; height: 24px; border-radius: 6px; overflow: hidden; }
.group-body { display: flex; flex: 1; min-height: 0; }
.group-chat { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; background: var(--surface); }
.chat-scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; }
.chat-column { max-width: 820px; margin: 0 auto; padding: 16px 24px 8px; }
.group-bulletin { display: flex; gap: 8px; margin: 0 0 16px; padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); color: var(--text-2); font-size: 12px; }
.group-bulletin p { white-space: pre-wrap; margin: 2px 0 0; }
.group-notice { margin: 0 auto 14px; max-width: 80%; color: var(--muted); font-size: 11px; text-align: center; }
.chat-typing { display: flex; align-items: flex-start; gap: var(--chat-gap); margin: 0 0 16px; }
.chat-typing .chat-avatar { display: grid; place-items: center; flex: none; width: var(--chat-avatar); height: var(--chat-avatar); border-radius: 12px; background: var(--accent-soft); }
.chat-typing .chat-content { display: grid; gap: 4px; }
.chat-typing .chat-heading { display: flex; align-items: center; gap: 8px; min-height: 20px; color: var(--muted); font-size: 11px; }
.chat-typing .chat-heading strong { color: var(--text-2); font-size: 12px; font-weight: 600; }
.chat-typing .chat-bubble { justify-self: start; padding: 9px 13px; border-radius: 4px 14px 14px 14px; background: var(--surface-2); }
.stop-reply { min-height: 22px; padding: 0 6px; color: var(--danger); font-size: 11px; }
.typing-dots { display: flex; align-items: center; gap: 4px; height: 23px; }
.typing-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: typing 1.2s ease-in-out infinite; }
.typing-dots i:nth-child(2) { animation-delay: .15s; }
.typing-dots i:nth-child(3) { animation-delay: .3s; }
@media (prefers-reduced-motion: reduce) { .typing-dots i { animation: none; opacity: .7; } }
@keyframes typing { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
.readonly-note { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.chat-composer { flex: none; width: calc(100% - 48px); max-width: 772px; margin: 0 auto 12px; padding: 6px; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--surface); box-shadow: var(--sh-sm); }
.chat-composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.composer-row { display: flex; align-items: flex-end; gap: 4px; }
.composer-input { flex: 1; }
.composer-input :deep(textarea) { min-height: 36px; max-height: 200px; padding: 8px 6px; border: 0; box-shadow: none; resize: none; font-size: 14px; line-height: 1.45; }
.composer-input :deep(textarea:focus), .composer-input :deep(textarea:focus-visible) { box-shadow: none; outline: none; }
.send { width: 36px; min-height: 36px; padding: 0; border-radius: 10px; }
.attach { width: 36px; min-height: 36px; color: var(--muted); }
.attachments { padding: 2px 4px 6px; }
.attachments button { gap: 4px; }
.composer-hint { padding: 0 8px; color: var(--faint); font-size: 11px; }
.group-panel { display: grid; align-content: start; gap: 18px; flex: none; width: 300px; padding: 16px; overflow-y: auto; border-left: 1px solid var(--border); background: var(--surface); }
.group-panel h3 { margin: 0 0 8px; font-size: 13px; }
.bulletin-text { white-space: pre-wrap; color: var(--text-2); font-size: 12px; }
.member-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.member-list li { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.member-avatar { display: grid; flex: none; width: 26px; height: 26px; overflow: hidden; border-radius: 8px; background: var(--accent-soft); font-size: 12px; }
.member-name { display: flex; align-items: center; justify-content: flex-start; gap: 6px; flex: 1; min-width: 0; padding: 0; border: 0; background: none; color: var(--text); font-size: 13px; font-weight: 500; text-align: left; }
.member-name small { color: var(--muted); font-size: 11px; font-weight: 400; }
button.member-name { cursor: pointer; }
button.member-name:hover { text-decoration: underline; }
.add-row { display: flex; gap: 6px; margin-top: 8px; }
.add-row select { flex: 1; min-width: 0; }
.panel-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.danger-text { color: var(--danger); }
fieldset { display: grid; gap: 4px; margin: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-md); }
legend { padding: 0 4px; color: var(--text-2); font-size: 12px; }
@media (max-width: 1099px) {
  .group-panel { position: absolute; z-index: 20; top: 52px; right: 0; bottom: 0; box-shadow: var(--sh-lg, 0 8px 30px rgba(0,0,0,.15)); }
  .group-workspace { position: relative; }
}
@media (max-width: 767px) {
  .chat-column { padding: 12px 12px 4px; }
  .chat-composer { width: calc(100% - 16px); margin: 0 8px max(8px, env(safe-area-inset-bottom, 0px)); border-radius: 12px; }
  .composer-input :deep(textarea) { font-size: 16px; }
  .attach, .send { width: 40px; min-height: 40px; }
  .composer-hint { display: none; }
  .group-panel { width: min(320px, 100%); }
}
</style>
