<script setup vapor>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, shallowReactive, shallowRef, watch } from "vue";
import PageHeader from "./PageHeader.vue";
import ChatMessage from "./ChatMessage.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import UserAvatar from "./UserAvatar.vue";
import GroupAvatar from "./GroupAvatar.vue";
import MentionTextarea from "./MentionTextarea.vue";
import Icon from "./Icon.vue";
import GroupWork from "./GroupWork.vue";
import { continuesPrevious, chatCardVisibility, messageTaskId, taskAccentColor } from "./conversation";
import { CHAT_PAGE_SIZE, loadStepOutput, mergeMessages } from "./chat-history.js";
import { groupMembers, groupMentionPeople } from "./group.js";
import { attachmentPayload, isImage, readAttachments, useAttachmentInput } from "./attachments.js";
import ComposerQuote from "./ComposerQuote.vue";
import ComposerTaskRefs from "./ComposerTaskRefs.vue";
import { markSeen, seenSeq } from "./seen.js";
import PressMention from "./PressMention.vue";
// One group chat (or, without groupId, the form that creates one). Live updates arrive as `revision` bumps.
const props = defineProps({ api: Function, user: Object, groupId: String, selectedTask: Object, myEmployees: Array, revision: Number });
const emit = defineEmits(["changed", "created", "closed", "open-employee", "open-task", "inspect", "cancel", "read", "task-change"]);
// Work panel: side-by-side from 768px (GroupWork stops overlaying); drawers stay closed until opened.
const roomy = () => typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;
const group = ref(null), error = ref(""), sending = ref(false), panel = ref(false), work = ref(roomy()), workMembers = ref([]), workLoading = ref(false), transcript = ref(null), input = ref(null), fileInput = ref(null);
const topic = computed(() => props.selectedTask), topicTitle = ref(""), viewMode = ref("main"), history = shallowRef(null), historyLoading = ref(false);
const requestedTopic = computed(() => viewMode.value === "topic" ? topic.value : null);
const historyKey = computed(() => requestedTopic.value?.taskId || "");
const activeTopic = computed(() => history.value?.topic || null);
const switching = computed(() => historyKey.value !== (activeTopic.value?.taskId || ""));
const messages = computed(() => history.value?.messages || []), taskStatus = computed(() => history.value?.taskStatus || {}), taskMeta = computed(() => history.value?.taskMeta || {});
const workTaskLookup = computed(() => {
  const map = new Map();
  for (const member of workMembers.value || [])
    for (const task of member.tasks || [])
      map.set(task.id, { id: task.id, title: task.text, status: task.status, employeeId: member.id });
  return map;
});
const taskFocus = computed(() => topic.value ? { member: topic.value.employeeId, task: topic.value.taskId } : null);
function chooseView(mode) {
  if (viewMode.value !== mode) viewMode.value = mode;
  else if (switching.value && !historyLoading.value) void run(load);
}
const emptyComposer = () => reactive({ text: "", attachments: [], quote: undefined, taskRefs: [] });
const mainComposer = emptyComposer(), topicDrafts = new Map();
const composer = computed(() => activeTopic.value ? topicDrafts.get(activeTopic.value.taskId) : mainComposer);
const draft = computed({ get: () => composer.value.text, set: (text) => { composer.value.text = text; } });
const files = computed(() => composer.value.attachments);
const quoted = computed({ get: () => composer.value.quote, set: (quote) => { composer.value.quote = quote; } });
const taskRefs = computed({ get: () => composer.value.taskRefs || [], set: (items) => { composer.value.taskRefs = items; } });
const groupTasks = computed(() => {
  const names = new Map((group.value?.employees || []).map((e) => [e.id, e.name]));
  return (workMembers.value || []).flatMap((member) =>
    (member.tasks || []).map((task) => ({ ...task, employeeId: member.id, employeeName: member.name || names.get(member.id) || "" })),
  );
});
function addTaskRef(task, intent) {
  if (!task?.id) return;
  const list = [...taskRefs.value.filter((item) => item.id !== task.id), { id: task.id, title: task.text || task.title || task.id, status: task.status, chainId: task.chainId, chainSeq: task.chainSeq, ...(intent ? { intent } : {}) }];
  taskRefs.value = list.slice(-5);
}
function removeTaskRef(id) {
  taskRefs.value = taskRefs.value.filter((item) => item.id !== id);
}
function quoteTask({ task, intent, memberId }) {
  addTaskRef({ ...task, employeeId: memberId || task.employeeId }, intent);
  void nextTick(() => input.value?.focus());
}
function openRefTask(taskId) {
  const found = groupTasks.value.find((t) => t.id === taskId);
  if (found) selectTopic({ employeeId: found.employeeId, taskId: found.id, title: found.text });
}
const directory = ref([]), form = ref({ name: "", bulletin: "", users: [], employees: [] }), edit = ref({ name: "", bulletin: "" }), invite = ref(""), bring = ref("");
const readonly = computed(() => props.user?.role === "viewer");
const members = computed(() => groupMembers(group.value, props.user?.id));
provide("mentions", { people: computed(() => groupMentionPeople(group.value)), open: (id) => emit("open-employee", id) });
// Authors carry ids and names; avatars come from the current member list (a member who left keeps the initial / default bot).
const avatars = computed(() => new Map([...(group.value?.users || []), ...(group.value?.employees || [])].map((p) => [p.id, p.avatar || ""])));
const weatherByEmployee = computed(() => new Map((group.value?.employees || []).map((p) => [p.id, p.moodWeather || ""])));
const shown = computed(() => {
  const rows = mergeMessages(history.value?.olderReferences || [], messages.value).filter((m) => m.notice || m.text?.trim() || m.tasks?.length || m.images?.length || m.files?.length)
    .map((m) => m.author ? { ...m, author: { ...m.author, avatar: avatars.value.get(m.author.id) || "" } } : m);
  const cards = chatCardVisibility(rows, taskStatus.value);
  const firstWindowSeq = messages.value[0]?.seq ?? Infinity;
  const inTopic = !!activeTopic.value;
  return rows.map((message, index) => {
    const previous = rows[index - 1];
    const jumpedGap = previous && previous.seq < firstWindowSeq && message.seq >= firstWindowSeq && previous.seq !== message.seq - 1;
    const taskId = !inTopic ? messageTaskId(message) : "";
    let topicContext;
    if (taskId) {
      const meta = taskMeta.value[taskId] || workTaskLookup.value.get(taskId);
      const linked = message.tasks?.find((task) => task.id === taskId);
      const title = meta?.title || linked?.title || "";
      const status = taskStatus.value[taskId] ?? meta?.status ?? linked?.status;
      topicContext = { id: taskId, title, status, color: taskAccentColor(taskId) };
    }
    return { message, continued: !jumpedGap && continuesPrevious(previous, message), cards: cards[index], topicContext };
  });
});
// 「新」分界：进来时上次看到的位置之后是新的；来了新消息就收起（切出再进来也不会再出现）。
const newFrom = ref(seenSeq(props.user?.id, props.groupId)), markGone = ref(false);
const newAt = computed(() => !activeTopic.value && newFrom.value > 0 ? shown.value.findIndex(({ message }) => message.seq > newFrom.value) : -1);
// 每位热心市民只在自己最后一次发言的头像旁展示当前天气小图标。
const lastBotAvatarIndexById = computed(() => {
  const rows = shown.value, map = new Map();
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i].message;
    if (m.notice || m.author?.kind !== "employee" || map.has(m.author.id)) continue;
    let head = i;
    while (head > 0 && rows[head].continued && !(newAt.value > 0 && head === newAt.value)) head--;
    map.set(m.author.id, head);
  }
  return map;
});
const lastSeq = computed(() => messages.value.at(-1)?.seq || 0);
let settled = false, baseSeq = 0;
watch(lastSeq, (seq) => { if (!activeTopic.value && settled && seq > baseSeq) markGone.value = true; });
watch(shown, (rows) => { if (props.groupId && !activeTopic.value) markSeen(props.user?.id, props.groupId, rows.at(-1)?.message.seq); });
const runningMembers = computed(() => (group.value?.employees || []).filter((e) => group.value.running?.includes(e.id) && (!activeTopic.value || activeTopic.value.employeeId === e.id)));
const available = computed(() => (props.myEmployees || []).filter((e) => !group.value?.employees.some((m) => m.id === e.id)));
const invitable = computed(() => directory.value.filter((u) => !group.value?.users.some((m) => m.id === u.id)));
// Both add rows always show, so users find them; when empty they say why.
const noUsersHint = computed(() => props.user?.role === "admin" ? "没有可邀请的用户（在左下角「账号与安全」→ 成员里新建账号）" : "没有可邀请的用户（请管理员在「账号与安全」里新建账号）");
const noEmployeesHint = computed(() => props.myEmployees?.length ? "你名下的热心市民都已在群里" : "你还没有热心市民，可在左侧「热心市民」里创建一位");
// A member employee's avatar and name open its chat only for its owner.
const canOpen = (author) => author?.kind === "employee" && !!group.value?.employees.find((e) => e.id === author.id)?.mine;
const canStop = (e) => e.mine || group.value?.isCreator;
// Long-press a member's avatar: "@name " goes into the composer (the same mention the picker inserts).
function mentionMember(name) { if (!readonly.value && name) input.value?.mention(name); }

async function run(fn) {
  error.value = "";
  try { return await fn(); } catch (e) { error.value = e.message; }
}
function nearBottom() {
  const el = transcript.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
let historyRequest = 0, scrollTop = 0;
const groupPage = (id, query, taskId) => props.api(`/groups/${id}/messages?${query}${taskId ? `&topicTaskId=${encodeURIComponent(taskId)}` : ""}&stepSummaries=1`);
// shortcut: keep the main chat and the last loaded topic, add a bounded cache if switching between multiple tasks becomes common.
let mainHistory, topicHistory;
function showHistory(page) {
  const previous = history.value, el = transcript.value;
  if (previous === page) return false;
  if (previous && el) previous.top = el.scrollHeight - el.scrollTop - el.clientHeight <= 1 ? undefined : el.scrollTop;
  history.value = page;
  return true;
}
async function restoreScroll(current, top) {
  await nextTick();
  const el = transcript.value;
  if (!current() || !el) return;
  el.scrollTop = top ?? el.scrollHeight;
  scrollTop = el.scrollTop;
}
async function load(scroll = false) {
  if (!props.groupId) return;
  const id = props.groupId, selection = requestedTopic.value, key = historyKey.value, request = ++historyRequest;
  const current = () => props.groupId === id && historyKey.value === key && historyRequest === request;
  let page = key ? (topicHistory?.topic.taskId === key ? topicHistory : undefined) : mainHistory;
  const showing = () => props.groupId === id && historyKey.value === key && history.value === page;
  historyLoading.value = true;
  try {
    if (page) {
      // A live refresh can supersede the request without superseding the view's scroll restoration.
      if (showHistory(page)) await restoreScroll(showing, page.top);
      else await nextTick();
      if (!current()) return;
    }
    const follow = nearBottom(), last = page?.messages.at(-1)?.seq;
    const result = await groupPage(id, `limit=${CHAT_PAGE_SIZE}`, key);
    if (!current()) return;
    // If more than a page arrived while away, fetch the gap rather than splicing two disjoint windows.
    const delta = last && result.hasMore && result.messages[0]?.seq > last ? await groupPage(id, `after=${last}`, key) : null;
    if (!current()) return;
    const stick = scroll || (follow && nearBottom() && !page?.loadingOlder);
    if (!page) {
      page = shallowReactive({ topic: selection, messages: [], taskStatus: {}, taskMeta: {}, olderReferences: [], hasMore: false, loadingOlder: false, olderError: "", top: undefined });
      if (key) topicHistory = page;
      else mainHistory = page;
    }
    const recent = delta ? mergeMessages(result.messages, delta.messages) : result.messages;
    const prefix = result.hasMore ? page.messages.filter((row) => row.seq < recent[0]?.seq) : [];
    page.messages = [...prefix, ...recent];
    if (!prefix.length) page.hasMore = !!result.hasMore;
    page.taskStatus = { ...(prefix.length ? page.taskStatus : {}), ...result.taskStatus, ...delta?.taskStatus };
    page.taskMeta = { ...(prefix.length ? page.taskMeta : {}), ...result.taskMeta, ...delta?.taskMeta };
    group.value = (delta || result).group;
    edit.value = { name: group.value.name, bulletin: group.value.bulletin };
    const opened = showHistory(page);
    if (!key) {
      if (!settled) { settled = true; baseSeq = lastSeq.value; }
      void markRead();
    }
    if (opened || stick) await restoreScroll(opened ? showing : current, opened && !scroll ? page.top : undefined);
  } catch (e) {
    if (!current()) return;
    if (key && [400, 403, 404].includes(e.status)) exitTask(true);
    throw e;
  } finally { if (current()) historyLoading.value = false; }
}
async function loadOlder() {
  const page = history.value, el = transcript.value, id = props.groupId, before = page?.messages[0]?.seq;
  if (!page?.hasMore || page.loadingOlder || switching.value || !el || !before) return;
  const current = () => props.groupId === id && history.value === page && transcript.value === el && !switching.value;
  page.loadingOlder = true;
  page.olderError = "";
  try {
    const result = await groupPage(id, `before=${before}&limit=${CHAT_PAGE_SIZE}`, page.topic?.taskId);
    if (!current() || page.messages[0]?.seq !== before) return;
    const top = el.getBoundingClientRect().top;
    // Measure at response time; the reader may have moved while the request was in flight.
    const anchor = [...el.querySelectorAll("[data-message-seq]")].find((row) => row.getBoundingClientRect().bottom > top);
    const offset = anchor?.getBoundingClientRect().top;
    page.messages = mergeMessages(result.messages, page.messages);
    page.taskStatus = { ...result.taskStatus, ...page.taskStatus };
    page.taskMeta = { ...result.taskMeta, ...page.taskMeta };
    page.hasMore = result.messages.length > 0 && !!result.hasMore;
    await nextTick();
    if (current() && anchor && el.contains(anchor)) {
      const shift = anchor.getBoundingClientRect().top - offset;
      el.scrollTop += shift;
      scrollTop = el.scrollTop;
    }
  } catch (e) {
    if (current()) page.olderError = e.message || "加载失败";
  } finally { page.loadingOlder = false; }
}
function onScroll() {
  const top = transcript.value?.scrollTop ?? 0, movedUp = top < scrollTop;
  scrollTop = top;
  if (movedUp && top <= 160 && !history.value?.olderError) void loadOlder();
}
// Open and visible: everything loaded so far is read (one marker per user on the server).
let readSeq = 0;
async function markRead() {
  const id = props.groupId, last = messages.value.at(-1)?.seq || 0;
  if (!id || activeTopic.value || historyKey.value || document.hidden || last <= readSeq) return;
  readSeq = last;
  try { await props.api(`/groups/${id}/read`, "POST", {}); if (props.groupId === id) emit("read", id); } catch { readSeq = 0; }
}
const visibility = () => { if (!document.hidden) void markRead(); };
onMounted(() => document.addEventListener("visibilitychange", visibility));
onBeforeUnmount(() => { historyRequest++; document.removeEventListener("visibilitychange", visibility); });
async function loadDirectory() {
  try { directory.value = (await props.api("/groups/directory")).filter((u) => u.id !== props.user?.id); } catch { directory.value = []; }
}
function quoteMessage(quote) {
  quoted.value = quote;
  input.value?.focus();
}
async function jumpTo(seq) {
  const root = transcript.value, id = props.groupId, page = history.value;
  const current = () => props.groupId === id && transcript.value === root && history.value === page;
  if (!page || !root || !Number.isSafeInteger(seq) || seq < 1 || seq === Number.MAX_SAFE_INTEGER) return;
  const find = () => root.querySelector(`[data-message-seq="${seq}"]`);
  await run(async () => {
    if (!find()) {
      const result = await groupPage(id, `before=${seq + 1}&limit=1`);
      if (!current()) return;
      const source = result.messages.find((row) => row.seq === seq);
      if (source) {
        page.olderReferences = mergeMessages(page.olderReferences, [source]);
        if (result.taskStatus) page.taskStatus = { ...page.taskStatus, ...result.taskStatus };
        if (result.taskMeta) page.taskMeta = { ...page.taskMeta, ...result.taskMeta };
      }
      await nextTick();
    }
    if (!current()) return;
    const target = find();
    if (!target) throw Error("原消息暂不可见或已不存在");
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.focus({ preventScroll: true });
    scrollTop = root.scrollTop;
  });
}
const { uploading, upload, paste } = useAttachmentInput(async (picked) => {
  const id = props.groupId, target = composer.value;
  await run(async () => {
    const items = await readAttachments(picked, target.attachments);
    if (props.groupId === id) target.attachments.push(...items);
  });
});
async function send() {
  const target = composer.value, id = props.groupId, topicTaskId = activeTopic.value?.taskId;
  const original = target.text, text = original.trim(), items = [...target.attachments], quote = target.quote, refs = [...(target.taskRefs || [])];
  if ((!text && !items.length) || readonly.value || sending.value || uploading.value || switching.value) return;
  sending.value = true;
  await run(async () => {
    // getRandomValues also works over LAN HTTP, where randomUUID is unavailable.
    const clientMessageId = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
    await props.api(`/groups/${id}/messages`, "POST", {
      text, ...attachmentPayload(items), quoteSeq: quote?.seq, topicTaskId, clientMessageId,
      ...(refs.length ? { taskRefs: refs.map(({ id, intent }) => ({ id, ...(intent ? { intent } : {}) })) } : {}),
    });
    if (props.groupId !== id) return;
    if (target.text === original) target.text = "";
    target.attachments = target.attachments.filter((file) => !items.includes(file));
    if (target.quote === quote) target.quote = undefined;
    if (refs.length) target.taskRefs = target.taskRefs.filter((item) => !refs.includes(item));
    if (!switching.value && composer.value === target) await load(true);
  });
  sending.value = false;
  if (!switching.value && composer.value === target) input.value?.focus();
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
const removeEmployee = (e) => confirm(`将热心市民「${e.name}」移出群聊？`) && change(() => props.api(`/groups/${props.groupId}/employees/${e.id}`, "DELETE"), () => load());
const removeUser = (u) => confirm(`将 ${u.name} 移出群聊？这位用户邀请入群的热心市民也会离开。`) && change(() => props.api(`/groups/${props.groupId}/users/${u.id}`, "DELETE"), () => load());
const stop = (e) => run(() => props.api(`/groups/${props.groupId}/cancel`, "POST", { employeeId: e.id }));
function leave() {
  const mine = group.value.employees.filter((e) => e.mine).length;
  if (!confirm(`退出群聊「${group.value.name}」？${mine ? "你邀请入群的热心市民也会离开。" : ""}${group.value.users.length === 1 ? "你是最后一位成员，群聊会被解散。" : ""}`)) return;
  void change(() => props.api(`/groups/${props.groupId}/users/${props.user.id}`, "DELETE"), () => emit("closed"));
}
function dissolve() {
  if (!confirm(`解散群聊「${group.value.name}」？群消息和热心市民的群内对话会删除；已派出的任务保留，结果会发到对应的私聊。`)) return;
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
function exitTask(replace = false) {
  if (!topic.value) return;
  if (replace && topicHistory?.topic.taskId === topic.value.taskId) {
    if (history.value === topicHistory && !mainHistory) history.value = null;
    topicHistory = undefined;
  }
  emit("task-change", null, replace);
}
function selectTopic(selection) {
  const same = topic.value?.taskId === selection.taskId && topic.value?.employeeId === selection.employeeId;
  if (same) chooseView(viewMode.value === "topic" ? "main" : "topic");
  else emit("task-change", selection);
}
function showTask(selection) {
  topicTitle.value = selection?.title || "";
  if (selection) {
    if (!topicDrafts.has(selection.taskId)) topicDrafts.set(selection.taskId, emptyComposer());
    panel.value = false;
    work.value = true;
  }
  chooseView(selection ? "topic" : "main");
}
function openTask(message, taskId) {
  const meta = taskMeta.value[taskId] || workTaskLookup.value.get(taskId);
  const employeeId = meta?.employeeId || (message.author?.kind === "employee" ? message.author.id : undefined);
  const author = group.value?.employees.find((e) => e.id === employeeId);
  if (!author) { error.value = "这位热心市民已离开群聊。需要跟进任务时，请联系对应的归属用户"; return; }
  selectTopic({ employeeId: author.id, taskId, title: meta?.title || message.tasks?.find((task) => task.id === taskId)?.title });
}
// 工作面板: the group's tasks by member, reloaded with the group (task status changes bump the revision too).
async function loadWork() {
  if (!props.groupId) return;
  const id = props.groupId;
  workLoading.value = true;
  try { const result = await props.api(`/groups/${id}/tasks?stepSummaries=1`); if (props.groupId === id) workMembers.value = result.members; }
  finally { workLoading.value = false; }
}
function toggleWork() { work.value = !work.value; if (work.value) panel.value = false; }
watch(topic, showTask, { immediate: true, flush: "sync" });
watch(panel, (open) => { if (open) work.value = false; });
watch([() => props.groupId, historyKey], ([id], [previousId]) => {
  if (id !== previousId) {
    historyRequest++; historyLoading.value = false; history.value = mainHistory = topicHistory = null;
    readSeq = 0; settled = false; baseSeq = 0; newFrom.value = seenSeq(props.user?.id, id); markGone.value = false;
    group.value = null; panel.value = false; work.value = roomy(); workMembers.value = []; topicDrafts.clear(); showTask(topic.value);
    mainComposer.text = ""; mainComposer.attachments = []; mainComposer.quote = undefined; mainComposer.taskRefs = [];
  }
  if (id) void run(load);
});
watch(work, (open) => { if (!open) exitTask(); });
watch([work, () => props.groupId], () => { if (props.groupId) void run(loadWork); }, { immediate: true });
watch(() => props.revision, () => { void run(load); void run(loadWork); });
watch(panel, (open) => { if (open && !directory.value.length) void loadDirectory(); });
onMounted(() => { if (props.groupId) void run(load); else void loadDirectory(); });
</script>
<template>
  <section class="group-workspace">
    <template v-if="!groupId">
      <PageHeader title="发起群聊" subtitle="与同事和热心市民一起协作，在群里 @ 对应成员即可请对方回应。" back="返回" @back="emit('cancel')" />
      <div class="page-scroll create-page">
        <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span><button class="icon" aria-label="关闭" @click="error = ''"><Icon name="close" :size="14" /></button></p>
        <form class="card create-card" @submit.prevent="create">
          <div class="form-grid">
            <label>群名<input v-model="form.name" required maxlength="40" placeholder="例如：发布小组、周报协作" autofocus /></label>
            <label>群公告<textarea v-model="form.bulletin" rows="5" maxlength="4000" placeholder="写清分工和协作方式，例如：研发助手负责写代码；测试助手负责验证，发现问题 @研发助手 修复；发布前 @我 确认。"></textarea><small class="hint">热心市民会按群公告中的分工处理消息。</small></label>
            <fieldset><legend>邀请用户</legend><label v-for="u in directory" :key="u.id" class="check"><input v-model="form.users" type="checkbox" :value="u.id" />{{ u.name }}</label><small v-if="!directory.length" class="hint">{{ noUsersHint }}</small></fieldset>
            <fieldset><legend>邀请我的热心市民</legend><label v-for="e in myEmployees" :key="e.id" class="check"><input v-model="form.employees" type="checkbox" :value="e.id" />{{ e.name }}</label><small v-if="!myEmployees?.length" class="hint">{{ noEmployeesHint }}</small></fieldset>
            <p class="hint">每位用户只能邀请自己名下的热心市民。其他用户入群后，可以在右上角「群成员与公告」中邀请各自名下的热心市民。</p>
          </div>
          <div class="actions end"><button type="button" class="ghost" @click="emit('cancel')">取消</button><button class="primary" :disabled="!form.name.trim()">创建群聊</button></div>
        </form>
      </div>
    </template>
    <template v-else>
      <PageHeader :title="group?.name || '群聊'" :subtitle="group ? `${group.users.length} 位用户 · ${group.employees.length} 位热心市民` : ''">
        <template #title-extra><span v-if="group" class="header-avatar"><GroupAvatar :group="group" /></span></template>
        <button type="button" class="sm" :class="{ active: panel }" :aria-expanded="panel" @click="panel = !panel"><Icon name="users" :size="15" /><span class="hide-mobile">群成员与公告</span></button>
        <button type="button" class="sm" :class="{ active: work }" :aria-expanded="work" @click="toggleWork"><Icon name="tasks" :size="15" /><span class="hide-mobile">工作面板</span></button>
      </PageHeader>
      <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span><button class="icon" aria-label="关闭" @click="error = ''"><Icon name="close" :size="14" /></button></p>
      <div class="group-body">
        <section class="group-chat">
          <nav v-if="topic" class="group-chat-tabs" aria-label="群聊视图">
            <button type="button" :aria-pressed="!activeTopic" :aria-busy="historyLoading && switching && !historyKey" @click="chooseView('main')">{{ historyLoading && switching && !historyKey ? '加载主聊天…' : '主聊天' }}</button>
            <button type="button" class="topic-tab" :aria-pressed="activeTopic?.taskId === topic.taskId" :aria-busy="historyLoading && switching && !!historyKey" :title="topicTitle" @click="chooseView('topic')"><span>{{ historyLoading && switching && historyKey ? '加载话题…' : '话题' }}</span><span v-if="topicTitle" class="topic-title">{{ topicTitle }}</span></button>
          </nav>
          <div ref="transcript" class="chat-scroll" aria-live="polite" :aria-busy="historyLoading && !history" @scroll.passive="onScroll">
            <div class="chat-column">
              <div v-if="!activeTopic && group?.bulletin" class="group-bulletin"><Icon name="inbox" :size="14" /><div><strong>群公告</strong><p>{{ group.bulletin }}</p></div></div>
              <div v-if="history?.hasMore" class="older-messages"><button type="button" class="ghost sm" :disabled="history.loadingOlder || switching" :title="history.olderError || undefined" @click="loadOlder">{{ history.loadingOlder ? '正在加载更早消息…' : history.olderError ? '加载失败，点击重试' : '加载更早消息' }}</button></div>
              <p v-if="activeTopic && !shown.length" class="group-notice">还没有关联消息，可以直接在此开始讨论。</p>
              <template v-for="({ message, continued, cards, topicContext }, index) in shown" :key="message.seq">
                <p v-if="newAt > 0 && index === newAt" :class="markGone ? 'chat-new gone' : 'chat-new'" role="separator" aria-label="新消息"><span>新</span></p>
                <p v-if="message.notice" class="group-notice" :data-message-seq="message.seq">{{ message.text }}</p>
                <ChatMessage v-else :message="message" :continued="continued && !(newAt > 0 && index === newAt)" :mood-weather="message.author?.kind === 'employee' && lastBotAvatarIndexById.get(message.author.id) === index ? weatherByEmployee.get(message.author.id) : ''" :hidden-task-ids="cards?.hiddenTaskIds" :hide-step-output="cards?.hideStepOutput" :topic-context="topicContext" :viewer-id="user?.id" :task-status="taskStatus" :load-step-output="(seq, message) => loadStepOutput(api, `/groups/${groupId}/messages`, seq, '', message)" :open-author="canOpen(message.author)" :mention-author="!readonly" :employee-id="message.author?.id" :name="message.author?.name" :quotable="!readonly" @quote="quoteMessage" @jump="jumpTo" @task="openTask(message, $event)" @author="emit('open-employee', $event)" @mention="mentionMember" />
              </template>
              <article v-for="e in runningMembers" :key="'typing-' + e.id" class="chat-message assistant chat-typing" role="status" :aria-label="e.name + ' 正在回复'">
                <span class="chat-avatar" aria-hidden="true"><PressMention :name="e.name" :disabled="readonly" @press="mentionMember"><EmployeeAvatar :employee-id="e.id" :name="e.name" :avatar="e.avatar" /></PressMention></span>
                <div class="chat-content">
                  <div class="chat-heading"><strong>{{ e.name }}</strong><span>正在回复</span><button v-if="canStop(e) && !readonly" type="button" class="ghost sm stop-reply" @click="stop(e)"><Icon name="stop" :size="12" />停止</button></div>
                  <div class="chat-bubble"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
                </div>
              </article>
            </div>
          </div>
          <p v-if="readonly" class="readonly-note"><Icon name="lock" :size="14" />只读账号只能查看群聊。</p>
          <form v-else class="chat-composer" @paste="paste" @submit.prevent="send">
            <ComposerTaskRefs :refs="taskRefs" @open="openRefTask" @remove="removeTaskRef" />
            <ComposerQuote v-if="quoted" :quote="quoted" @jump="jumpTo" @remove="quoted = undefined" />
            <div v-if="files.length" class="attachments"><button v-for="(file, index) in files" :key="index" type="button" :title="'移除 ' + file.name" @click="files.splice(index, 1)"><Icon :name="isImage(file) ? 'image' : 'file'" :size="12" />{{ file.name }}<Icon name="close" :size="12" /></button></div>
            <div class="composer-row">
              <input ref="fileInput" type="file" hidden multiple @change="upload" />
              <button type="button" class="icon attach" aria-label="添加附件" title="附件（可粘贴图片）" :disabled="uploading" @click="fileInput.click()"><Icon name="paperclip" /></button>
              <MentionTextarea ref="input" v-model="draft" class="composer-input" :members="members" :tasks="groupTasks" :auto-grow="true" rows="1" maxlength="20000" :placeholder="activeTopic ? '回复当前任务话题，输入 # 可引用任务…' : '输入消息，可 @ 热心市民或 # 引用任务…'" @keydown="keydown" @pick-task="addTaskRef" />
              <button class="primary send" :disabled="(!draft.trim() && !files.length) || sending || uploading || switching" aria-label="发送" title="发送"><Icon name="send" :size="18" /></button>
            </div>
            <p class="composer-hint">{{ activeTopic ? '发送到当前任务话题，同步显示在主聊天 · # 引用任务 · /new 用新任务执行' : '回复消息、@ 热心市民或 # 引用任务 · /new 用新任务执行' }} · Enter 发送 · Shift + Enter 换行</p>
          </form>
        </section>
        <GroupWork v-if="work && group" :members="workMembers" :loading="workLoading" :api="api" :group-id="groupId" :focus="taskFocus" @select="selectTopic" @exit="exitTask" @title="topicTitle = $event" @open="emit('open-task', $event)" @inspect="emit('inspect', $event)" @changed="run(loadWork)" @quote-task="quoteTask" @close="work = false" />
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
            <h3>热心市民 · {{ group.employees.length }}</h3>
            <ul class="member-list">
              <li v-for="e in group.employees" :key="e.id"><span class="member-avatar" title="长按 @ 它"><PressMention :name="e.name" :disabled="readonly" @press="mentionMember"><EmployeeAvatar :employee-id="e.id" :name="e.name" :avatar="e.avatar" /></PressMention></span>
                <button v-if="e.mine" type="button" class="link member-name truncate" :title="'打开 ' + e.name" @click="emit('open-employee', e.id)">{{ e.name }}<small>我的</small></button>
                <span v-else class="member-name truncate">{{ e.name }}<small>{{ e.ownerName || '其他用户' }}的</small></span>
                <button v-if="(e.mine || group.isCreator) && !readonly" type="button" class="icon sm" :aria-label="'移出 ' + e.name" title="移出群聊" @click="removeEmployee(e)"><Icon name="close" :size="14" /></button></li>
            </ul>
            <div v-if="!readonly" class="add-row"><select v-model="bring" aria-label="邀请我的热心市民" :disabled="!available.length"><option value="">{{ available.length ? "邀请我的热心市民…" : noEmployeesHint }}</option><option v-for="e in available" :key="e.id" :value="e.id">{{ e.name }}</option></select><button type="button" class="sm" :disabled="!bring" @click="addEmployee">邀请</button></div>
            <p class="hint">只能邀请你名下的热心市民，其他群成员也可以在这里邀请各自名下的热心市民。你可以请其他用户名下的热心市民派单、查询、补充、续做或停止任务，但不能管理长期记忆；密码本仍按适用范围取用。</p>
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
.group-chat-tabs { display: flex; flex: none; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
.group-chat-tabs button { min-height: 28px; padding: 0 8px; border-color: transparent; background: transparent; font-size: 12px; }
.group-chat-tabs button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); }
.topic-tab { justify-content: start; min-width: 0; max-width: 42rem; }
.topic-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.chat-scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; }
.chat-column { max-width: 820px; margin: 0 auto; padding: 16px 24px 8px; }
.older-messages { display: flex; justify-content: center; margin-bottom: 12px; }
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
.composer-input { flex: 1; min-width: 0; }
.composer-input :deep(textarea) { min-height: 36px; padding: 8px 6px; border: 0; box-shadow: none; resize: none; font-size: 14px; line-height: 1.45; }
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
