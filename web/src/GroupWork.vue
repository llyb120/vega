<script setup vapor>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import TaskDetail from "./TaskDetail.vue";
import { taskLabel, taskTone, planProgress, shortTime, isEnded, needsAttention } from "./task-status";
import { chainEdgeLabel, chainTasks, groupTasksByChain } from "../../shared/task-chain";
// The group's 工作面板: tasks started from this group, by member employee (GET /groups/:id/tasks, already ordered).
// Task details stay beside the chat; owners can explicitly open their execution workspace.
const props = defineProps({ members: Array, loading: Boolean, api: Function, groupId: String, focus: Object });
const emit = defineEmits(["select", "exit", "title", "open", "inspect", "close", "changed", "quote-task", "open-browser", "open-settings"]);
const selectedKey = computed(() => props.focus || null), selected = ref(null), detailLoading = ref(false), error = ref(""), filter = ref("all");
const owned = () => props.members?.some((member) => member.mine && member.id === selectedKey.value?.member);
const requester = (task) => task.requester?.kind === "employee" ? `热心市民「${task.requester.name}」` : task.requester?.name || "";
const note = (task) => task.status === "waiting" ? task.waiting : task.status === "approval" ? task.approval : task.summary || task.progress?.at(-1)?.text || task.queueReason || "";
/** Strip bare URLs in card previews so Tapd/link-heavy prompts stay readable; full text stays in tooltip & detail. */
function cardTitle(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const cleaned = raw.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned.length >= 6 ? cleaned : raw;
}
const allTasks = computed(() => (props.members || []).flatMap((member) => member.tasks || []));
const activeCount = computed(() => allTasks.value.filter((task) => !isEnded(task.status)).length);
const endedCount = computed(() => allTasks.value.filter((task) => isEnded(task.status)).length);
const filteredMembers = computed(() => (props.members || []).map((member) => {
  const all = member.tasks || [];
  const visible = all.filter((task) => filter.value === "all" || (filter.value === "active" ? !isEnded(task.status) : isEnded(task.status)));
  return { ...member, tasks: visible, grouped: groupTasksByChain(visible, all) };
}));
const selectedChainTasks = computed(() => {
  if (!selected.value?.chainId) return [];
  const memberTasks = (props.members || []).find((m) => m.id === selectedKey.value?.member)?.tasks || [];
  const merged = new Map(memberTasks.map((t) => [t.id, t]));
  merged.set(selected.value.id, selected.value);
  return chainTasks([...merged.values()], selected.value.chainId);
});
const toggledChains = ref(new Map());
const isExpanded = (group) => toggledChains.value.has(group.chainId) ? toggledChains.value.get(group.chainId) : (group.hasActive || group.hasAttention);
function toggleChain(chainId, current) {
  const next = new Map(toggledChains.value);
  next.set(chainId, !current);
  toggledChains.value = next;
}
const edgeText = (node) => {
  const label = chainEdgeLabel(node.edgeKind);
  if (!label) return "";
  return node.retryOfSeq ? `${label} #${node.retryOfSeq}` : label;
};
function selectChainTask(taskId) {
  const member = (props.members || []).find((m) => (m.tasks || []).some((t) => t.id === taskId));
  const target = member?.tasks?.find((t) => t.id === taskId);
  open({ id: member?.id || selectedKey.value?.member }, { id: taskId, text: target?.text || selected.value?.text });
}
let version = 0;
const taskPath = (key) => `/groups/${encodeURIComponent(props.groupId)}/tasks/${encodeURIComponent(key.member)}/${encodeURIComponent(key.task)}`;
async function loadDetail() {
  const request = ++version, key = selectedKey.value;
  const current = () => version === request && selectedKey.value === key;
  if (!key) { selected.value = null; detailLoading.value = false; return; }
  detailLoading.value = true; error.value = "";
  try {
    const task = await props.api(taskPath(key));
    if (current()) { selected.value = task; emit("title", task.text); }
  } catch (e) {
    if (current()) {
      selected.value = null; error.value = e.message;
      if ([403, 404].includes(e.status)) emit("exit", true);
    }
  }
  finally { if (current()) detailLoading.value = false; }
}
function open(member, task) {
  emit("select", { employeeId: member.id, taskId: task.id, title: task.text });
}
async function control(action, text) {
  const key = selectedKey.value;
  if (!key || !selected.value?.canControl) return false;
  if (action === "remove" && !confirm("永久删除此任务记录？")) return false;
  if (action === "redispatch" && !confirm("重新派发为新任务？此前外部操作不会回滚。")) return false;
  if (action === "seal" && !confirm("封存此任务？封存后不能再恢复、续做或重新派发，只能查看或删除。")) return false;
  error.value = "";
  try {
    const result = await props.api(taskPath(key), "POST", { action: action === "reject" ? "approve" : action, ...(action === "approve" || action === "reject" ? { approved: action === "approve" } : {}), ...(text ? { text } : {}), ...(action === "redispatch" ? { confirmed: true } : {}), ...(action === "seal" ? { manual: true } : {}) });
    if (selectedKey.value === key) {
      if (action === "remove") emit("exit", true);
      else if (action === "redispatch" && result.id) open({ id: key.member }, { id: result.id, text: selected.value?.text });
      else await loadDetail();
    }
    emit("changed");
    return true;
  } catch (e) { if (selectedKey.value === key) error.value = e.message; return false; }
}
watch(selectedKey, (key, previous) => { if (key?.task !== previous?.task || key?.member !== previous?.member) selected.value = null; void loadDetail(); }, { immediate: true });
watch(() => props.members, () => { if (selectedKey.value) void loadDetail(); });
onBeforeUnmount(() => { version++; });
</script>
<template>
  <aside class="group-work" aria-label="工作面板">
    <header class="panel-head">
      <button v-if="selectedKey" type="button" class="icon sm" aria-label="返回任务列表" @click="emit('exit')"><Icon name="back" :size="16" /></button>
      <h3>工作面板</h3>
      <button type="button" class="icon sm" aria-label="收起工作面板" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </header>
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <div v-if="selectedKey" class="panel-scroll detail" :aria-busy="detailLoading">
      <p v-if="detailLoading && !selected" class="panel-empty">正在读取任务…</p>
      <template v-if="selected">
        <p class="panel-empty access-note"><Icon name="lock" :size="12" />{{ selected.canControl ? '你可以操作此任务' : '只读 · 仅任务发起人或热心市民的归属用户可操作' }}<button v-if="owned()" type="button" class="link" @click="emit('open', { employeeId: selectedKey.member, taskId: selectedKey.task })">打开任务会话</button></p>
        <TaskDetail :key="selected.id" :task="selected" :chain-tasks="selectedChainTasks" :employee-id="selectedKey.member" :readonly="!selected.canControl" :act="control" :can-open-browser="owned()" @inspect="emit('inspect', $event)" @select-task="selectChainTask" @quote-task="emit('quote-task', { ...$event, memberId: selectedKey.member })" @open-browser="emit('open-browser', { ...$event, employeeId: selectedKey.member })" @open-settings="emit('open-settings', $event)" />
      </template>
    </div>
    <div v-else class="panel-scroll">
      <div v-if="allTasks.length" class="work-filters" role="tablist" aria-label="任务筛选">
        <button type="button" role="tab" :aria-selected="filter === 'all'" @click="filter = 'all'">全部<span>{{ allTasks.length }}</span></button>
        <button type="button" role="tab" :aria-selected="filter === 'active'" @click="filter = 'active'">进行中<span>{{ activeCount }}</span></button>
        <button type="button" role="tab" :aria-selected="filter === 'ended'" @click="filter = 'ended'">已结束<span>{{ endedCount }}</span></button>
      </div>
      <p v-if="loading && !members?.length" class="panel-empty"><span class="spinner" aria-hidden="true"></span>加载中…</p>
      <p v-else-if="!members?.length" class="panel-empty">群里还没有热心市民。</p>
      <section v-for="member in filteredMembers" :key="member.id" class="member-section">
        <h4><span class="member-avatar"><EmployeeAvatar :employee-id="member.id" :name="member.name" :avatar="member.avatar" /></span>{{ member.name }}<small v-if="member.mine">我的</small><span class="count">{{ member.tasks.length }}</span></h4>
        <p v-if="!member.tasks.length" class="panel-empty">{{ filter === 'active' ? '当前没有进行中的任务。' : filter === 'ended' ? '还没有已结束的任务。' : '还没有群里发起的任务。' }}</p>
        <div v-else class="task-grid">
          <template v-for="group in member.grouped" :key="group.kind === 'single' ? group.task.id : group.chainId">
            <button v-if="group.kind === 'single'" type="button" class="task-row" :class="[taskTone(group.task.status), { ended: isEnded(group.task.status), attention: needsAttention(group.task.status) }]" :data-task-id="group.task.id" :title="group.task.text" @click="open(member, group.task)">
              <span class="task-row-head">
                <span class="task-state"><i class="state-dot" aria-hidden="true"></i>{{ taskLabel(group.task.status) }}</span>
                <time>{{ shortTime(group.task.createdAt) }}</time>
              </span>
              <strong>{{ cardTitle(group.task.text) }}</strong>
              <span v-if="note(group.task)" class="task-row-note">{{ note(group.task) }}</span>
              <span class="task-row-foot">
                <span class="task-row-meta">{{ requester(group.task) }} 发起</span>
                <span v-if="!isEnded(group.task.status) && planProgress(group.task.plan)" class="task-step-count">{{ planProgress(group.task.plan).done }}/{{ planProgress(group.task.plan).total }}</span>
              </span>
              <span v-if="!isEnded(group.task.status) && planProgress(group.task.plan)" class="mini-progress" :title="`计划 ${planProgress(group.task.plan).done}/${planProgress(group.task.plan).total}`"><span :style="{ width: planProgress(group.task.plan).percent + '%' }"></span></span>
            </button>
            <div v-else class="group-chain-card" :class="{ attention: group.hasAttention }">
              <button type="button" class="group-chain-head" :aria-expanded="isExpanded(group)" @click="toggleChain(group.chainId, isExpanded(group))">
                <span class="chain-head-title">
                  <span :class="['state-dot', taskTone(group.headTask.status)]" aria-hidden="true"></span>
                  <strong>{{ cardTitle(group.headTask.text) }}</strong>
                </span>
                <span class="chain-head-meta">
                  <span class="chain-pill-tag">任务链 · {{ group.count }} 节点<template v-if="group.branched"> · {{ group.branchCount }} 分支</template></span>
                  <Icon :name="isExpanded(group) ? 'down' : 'right'" :size="13" />
                </span>
              </button>
              <div v-if="isExpanded(group)" class="group-chain-nodes">
                <div v-for="node in group.nodes" :key="node.id" class="chain-node-row" :class="{ cancelled: node.task?.status === 'cancelled', missing: node.missing }">
                  <span v-for="(open, gi) in node.guides" :key="gi" class="guide" :class="{ open }" aria-hidden="true"></span>
                  <span v-if="node.depth > 0" class="branch-join" :class="{ last: node.isLast }" aria-hidden="true"></span>
                  <button v-if="!node.missing" type="button" class="chain-node-item" :data-task-id="node.id" :title="node.task.text" @click="open(member, node.task)">
                    <span :class="['state-dot', taskTone(node.task.status)]" aria-hidden="true"></span>
                    <span v-if="node.task.chainSeq" class="chain-seq">#{{ node.task.chainSeq }}</span>
                    <span v-if="edgeText(node)" class="chain-edge" :class="node.edgeKind">{{ edgeText(node) }}</span>
                    <span class="chain-node-title">{{ cardTitle(node.task.text) }}</span>
                    <span class="chain-node-status">{{ taskLabel(node.task.status) }}</span>
                  </button>
                  <span v-else class="chain-missing-node">已删除的前置任务</span>
                </div>
              </div>
            </div>
          </template>
        </div>
        <p v-if="filter !== 'active' && member.endedHidden" class="panel-empty">更早结束的 {{ member.endedHidden }} 个任务未显示。</p>
      </section>
    </div>
  </aside>
</template>
<style scoped>
.group-work { display: flex; flex-direction: column; flex: none; min-height: 0; width: min(clamp(340px, 30vw, 560px), 50%); border-left: 1px solid var(--border); background: var(--bg); }
.panel-head { display: flex; align-items: center; gap: 8px; flex: none; height: 44px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--border); }
.panel-head h3 { flex: 1; font-size: 13px; }
.panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 16px; scrollbar-width: thin; }
.panel-scroll.detail { display: flex; flex-direction: column; padding: 0; }
.work-filters { display: flex; align-items: center; gap: 4px; margin: 0 0 8px; padding: 3px; border-radius: var(--r-md); background: var(--surface-2); }
.work-filters button { flex: 1; justify-content: center; gap: 5px; min-height: 26px; padding: 0 8px; border: 0; border-radius: calc(var(--r-md) - 2px); background: transparent; color: var(--muted); font-size: 12px; font-weight: 500; }
.work-filters button span { font-size: 11px; opacity: .75; font-variant-numeric: tabular-nums; }
.work-filters button[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: var(--sh-sm); }
.member-section h4 { display: flex; align-items: center; gap: 8px; margin: 10px 2px 8px; color: var(--text-2); font-size: 12px; }
.member-section h4 small { color: var(--muted); font-weight: 400; }
.member-section h4 .count { margin-left: auto; }
.member-avatar { display: inline-grid; width: 22px; height: 22px; }
.task-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(205px, 1fr)); gap: 8px; }
.task-row { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%; height: auto; min-width: 0; padding: 10px 11px; border: 1px solid var(--border); border-radius: var(--r-lg, 10px); background: var(--surface); font-weight: 400; text-align: left; white-space: normal; overflow-wrap: anywhere; transition: border-color .14s, box-shadow .14s, transform .14s; }
.task-row:hover:not(:disabled) { border-color: var(--accent); background: var(--surface); box-shadow: var(--sh-sm); transform: translateY(-1px); }
.task-row.attention { grid-column: 1 / -1; border-color: var(--warn-border, var(--border)); border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 4%, var(--surface)); }
.task-row.info { border-left: 3px solid var(--accent); }
.task-row.danger { border-left: 3px solid var(--danger); }
.task-row.ended { background: color-mix(in srgb, var(--surface) 76%, var(--bg)); }
.task-row.ended:hover:not(:disabled) { background: var(--surface); }
.task-row-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.task-state { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--text-2); }
.state-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex: none; }
.task-row.info .task-state { color: var(--accent-text); }
.task-row.info .state-dot { background: var(--accent); }
.task-row.warn .task-state { color: var(--warn); }
.task-row.warn .state-dot { background: var(--warn); }
.task-row.ok .task-state { color: var(--muted); font-weight: 500; }
.task-row.ok .state-dot { background: var(--ok); opacity: .75; }
.task-row.danger .task-state { color: var(--danger); }
.task-row.danger .state-dot { background: var(--danger); }
.task-row time, .task-row-meta { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.task-row strong { display: -webkit-box; overflow: hidden; color: var(--text); font-size: 12.5px; font-weight: 500; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.task-row.ended strong { color: var(--text-2); }
.task-row-note { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 11.5px; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.task-row.ended .task-row-note { -webkit-line-clamp: 1; opacity: .88; }
.task-row-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: auto; padding-top: 2px; }
.task-row-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-step-count { flex: none; padding: 0 5px; border-radius: 999px; background: var(--surface-2); color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.mini-progress { display: block; height: 2px; overflow: hidden; border-radius: 2px; background: var(--surface-3); }
.mini-progress span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.panel-empty { display: flex; gap: 8px; padding: 8px 4px; color: var(--muted); font-size: 12px; line-height: 1.55; }
.group-chain-card { grid-column: 1 / -1; border: 1px solid var(--border); border-radius: var(--r-lg, 10px); background: var(--surface); overflow: hidden; }
.group-chain-card.attention { border-color: var(--warn-border, var(--border)); }
.group-chain-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: auto; padding: 8px 10px; border: 0; border-radius: 0; background: var(--surface-2); text-align: left; white-space: normal; }
.group-chain-head:hover:not(:disabled) { background: var(--surface-3); }
.chain-head-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.chain-head-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 500; color: var(--text); }
.chain-head-meta { display: inline-flex; align-items: center; gap: 5px; flex: none; color: var(--muted); }
.chain-pill-tag { padding: 0 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-size: 10.5px; font-weight: 500; }
.group-chain-nodes { padding: 4px 6px 6px; border-top: 1px solid var(--border); }
.chain-node-row { display: flex; align-items: stretch; }
.chain-node-row.cancelled .chain-node-item { opacity: .66; }
.guide { position: relative; flex: none; width: 14px; }
.guide.open::before { content: ""; position: absolute; top: 0; bottom: 0; left: 6px; border-left: 1.5px solid var(--border-strong); }
.branch-join { position: relative; flex: none; width: 14px; }
.branch-join::before { content: ""; position: absolute; top: 0; bottom: 0; left: 6px; border-left: 1.5px solid var(--border-strong); }
.branch-join.last::before { bottom: 50%; }
.branch-join::after { content: ""; position: absolute; top: 50%; left: 6px; right: 2px; border-top: 1.5px solid var(--border-strong); }
.chain-node-item { display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; height: auto; min-height: 26px; padding: 4px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 400; text-align: left; }
.chain-node-item:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.chain-seq { flex: none; color: var(--muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chain-edge { flex: none; padding: 0 4px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); font-size: 10px; font-weight: 500; }
.chain-edge.follow_up { background: var(--accent-soft); color: var(--accent-text); }
.chain-edge.retry { background: var(--warn-soft); color: var(--warn); }
.chain-node-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chain-node-status { flex: none; color: var(--muted); font-size: 11px; }
.chain-missing-node { padding: 4px 6px; color: var(--muted); font-size: 11px; font-style: italic; }
.group-work:has(.detail) { width: min(clamp(500px, 38vw, 680px), 50%); }
.panel-scroll.detail :deep(.task-detail) { flex: 1 0 auto; padding: 12px 16px 0; min-height: 0; }
.panel-scroll.detail :deep(.detail-foot) { position: sticky; bottom: 0; z-index: 1; margin-inline: -16px; padding: 10px 16px max(10px, env(safe-area-inset-bottom, 0px)); background: var(--bg); }
.panel-scroll.detail :deep(.detail-foot:not(:has(button, .hint))) { display: none; }
.access-note { align-items: center; margin: 0; padding: 10px 16px 0; }
@media (max-width: 767px) { .group-work, .group-work:has(.detail) { position: absolute; z-index: 20; top: 52px; right: 0; bottom: 0; width: min(460px, 100%); box-shadow: var(--sh-lg); } }
</style>
