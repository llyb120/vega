<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import TaskDetail from "./TaskDetail.vue";
import { taskLabel, taskTone, planProgress, shortTime } from "./task-status";
// The group's 工作面板: tasks started from this group, by member employee (GET /groups/:id/tasks, already ordered).
// The owner opens a task in the employee view; other members read it here.
const props = defineProps({ members: Array, loading: Boolean });
const emit = defineEmits(["open", "close"]);
const selected = ref(null);
const requester = (task) => task.requester ? `${task.requester.kind === "employee" ? "牛马" : ""}${task.requester.name}` : "";
const note = (task) => task.status === "waiting" ? task.waiting : task.status === "approval" ? task.approval : task.progress?.at(-1)?.text || task.queueReason || "";
function open(member, task) {
  if (member.mine) emit("open", { employeeId: member.id, taskId: task.id });
  else selected.value = task;
}
</script>
<template>
  <aside class="group-work" aria-label="工作面板">
    <header class="panel-head">
      <button v-if="selected" type="button" class="icon sm" aria-label="返回任务列表" @click="selected = null"><Icon name="back" :size="16" /></button>
      <h3>工作面板</h3>
      <button type="button" class="icon sm" aria-label="收起工作面板" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </header>
    <div v-if="selected" class="panel-scroll detail"><TaskDetail :task="selected" readonly :act="async () => false" /></div>
    <div v-else class="panel-scroll">
      <p v-if="loading && !members?.length" class="panel-empty"><span class="spinner" aria-hidden="true"></span>加载中…</p>
      <p v-else-if="!members?.length" class="panel-empty">群里还没有牛马。</p>
      <section v-for="member in members" :key="member.id" class="member-section">
        <h4><span class="member-avatar"><EmployeeAvatar :employee-id="member.id" :name="member.name" :avatar="member.avatar" /></span>{{ member.name }}<small v-if="member.mine">我的</small><span class="count">{{ member.tasks.length }}</span></h4>
        <p v-if="!member.tasks.length" class="panel-empty">还没有群里发起的任务。</p>
        <button v-for="task in member.tasks" :key="task.id" type="button" class="task-row" :data-task-id="task.id" @click="open(member, task)">
          <span class="task-row-head"><span :class="['badge', taskTone(task.status)]">{{ taskLabel(task.status) }}</span><time>{{ shortTime(task.createdAt) }}</time></span>
          <strong>{{ task.text }}</strong>
          <span class="task-row-meta">{{ requester(task) }} 发起</span>
          <span v-if="note(task)" class="task-row-note">{{ note(task) }}</span>
          <span v-if="planProgress(task.plan)" class="mini-progress" :title="`计划 ${planProgress(task.plan).done}/${planProgress(task.plan).total}`"><span :style="{ width: planProgress(task.plan).percent + '%' }"></span></span>
        </button>
        <p v-if="member.endedHidden" class="panel-empty">更早结束的 {{ member.endedHidden }} 个任务未显示。</p>
      </section>
    </div>
  </aside>
</template>
<style scoped>
.group-work { display: flex; flex-direction: column; flex: none; min-height: 0; width: 320px; border-left: 1px solid var(--border); background: var(--bg); }
.panel-head { display: flex; align-items: center; gap: 8px; flex: none; height: 44px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--border); }
.panel-head h3 { flex: 1; font-size: 13px; }
.panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 16px; scrollbar-width: thin; }
.panel-scroll.detail { padding: 0; }
.member-section h4 { display: flex; align-items: center; gap: 8px; margin: 12px 4px 8px; color: var(--text-2); font-size: 12px; }
.member-section h4 small { color: var(--muted); font-weight: 400; }
.member-section h4 .count { margin-left: auto; }
.member-avatar { display: inline-grid; width: 22px; height: 22px; }
.task-row { display: grid; grid-template-columns: minmax(0, 1fr); justify-content: stretch; gap: 4px; width: 100%; height: auto; margin-bottom: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); font-weight: 400; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.task-row:hover:not(:disabled) { border-color: var(--border-strong); background: var(--surface); box-shadow: var(--sh-sm); }
.task-row-head { display: flex; align-items: center; justify-content: space-between; }
.task-row time, .task-row-meta { color: var(--muted); font-size: 11px; }
.task-row strong { display: -webkit-box; overflow: hidden; color: var(--text); font-size: 13px; font-weight: 500; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.task-row-note { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 12px; line-height: 1.5; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mini-progress { display: block; height: 3px; margin-top: 2px; overflow: hidden; border-radius: 2px; background: var(--surface-3); }
.mini-progress span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.panel-empty { display: flex; gap: 8px; padding: 8px 4px; color: var(--muted); font-size: 12px; line-height: 1.55; }
@media (max-width: 767px) { .group-work { position: absolute; z-index: 20; top: 52px; right: 0; bottom: 0; width: min(340px, 100%); box-shadow: var(--sh-lg); } }
</style>
