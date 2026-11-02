<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps({ memories: Array, canManage: Boolean, save: Function, forget: Function });
const text = ref(""), id = ref(""), importance = ref(1), saving = ref(false), query = ref("");
const levels = ["", "普通", "重要", "长期记住"];
function edit(m) { id.value = m.id; text.value = m.text; importance.value = m.importance; }
function cancel() { id.value = ""; text.value = ""; importance.value = 1; }
async function submit() {
  if (saving.value) return;
  saving.value = true;
  try { if (await props.save({ id: id.value || undefined, text: text.value, importance: Number(importance.value) }) === true) cancel(); }
  finally { saving.value = false; }
}
const match = (m) => !query.value || m.text.toLowerCase().includes(query.value.toLowerCase());
</script>
<template>
  <div class="page-scroll section-page">
    <div class="section-inner">
      <div class="section-heading">
        <div><h3>记忆 <small>{{ memories.length }}</small></h3><p class="hint">稳定、可跨任务复用的事实。重要度越高越不容易被遗忘。</p></div>
        <label v-if="memories.length > 4" class="search"><Icon name="search" :size="15" /><input v-model="query" type="search" placeholder="搜索记忆" aria-label="搜索记忆" /></label>
      </div>
      <form v-if="canManage" class="memory-form" :class="{ editing: id }" @submit.prevent="submit">
        <input v-model="text" required maxlength="200" :placeholder="id ? '修改这条记忆' : '一条稳定、可跨任务复用的事实'" aria-label="记忆内容" />
        <select v-model="importance" aria-label="重要度"><option :value="1">普通</option><option :value="2">重要</option><option :value="3">长期记住</option></select>
        <button class="primary" :disabled="saving">{{ id ? '更新' : '记住' }}</button>
        <button v-if="id" type="button" class="ghost" @click="cancel">取消</button>
      </form>
      <div v-if="!memories.length" class="empty-state"><Icon name="memory" :size="28" /><strong>还没有记忆</strong><span>员工会在工作中积累记忆，你也可以在上方手动添加。</span></div>
      <ul v-else class="memory-list">
        <li v-for="m in memories.filter(match)" :key="m.id" :class="{ editing: id === m.id }">
          <span :class="['level', 'l' + m.importance]" :title="levels[m.importance]">{{ levels[m.importance] }}</span>
          <p>{{ m.text }}</p>
          <span class="strength" :title="'强度 ' + m.strength">强度 {{ m.strength }}</span>
          <div v-if="canManage" class="row-actions">
            <button type="button" class="sm icon" aria-label="编辑记忆" title="编辑" @click="edit(m)"><Icon name="edit" :size="14" /></button>
            <button type="button" class="sm icon danger-text" aria-label="忘记这条记忆" title="忘记" @click="forget(m)"><Icon name="trash" :size="14" /></button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
<style scoped>
.section-inner { max-width: 960px; }
.section-heading { align-items: flex-start; }
.search { display: flex; align-items: center; gap: 6px; padding-left: 10px; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface); color: var(--muted); }
.search input { width: 180px; border: 0; box-shadow: none !important; padding-left: 0; }
.memory-form { display: flex; gap: 8px; margin-bottom: 12px; }
.memory-form input { flex: 1; }
.memory-form select { width: 120px; }
.memory-form.editing input { border-color: var(--accent); }
.memory-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }
.memory-list li { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 8px 8px 14px; }
.memory-list li + li { border-top: 1px solid var(--border); }
.memory-list li.editing { background: var(--accent-softer); }
.memory-list p { flex: 1; min-width: 0; line-height: 1.5; overflow-wrap: anywhere; }
.level { flex: none; width: 56px; padding: 2px 0; border-radius: 4px; background: var(--surface-3); color: var(--text-2); font-size: 11px; text-align: center; }
.level.l2 { background: var(--info-soft); color: var(--accent-text); }
.level.l3 { background: var(--warn-soft); color: var(--warn); }
.strength { flex: none; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.row-actions { display: flex; flex: none; }
@media (max-width: 767px) {
  .memory-form { flex-wrap: wrap; }
  .memory-form input { flex-basis: 100%; }
  .memory-form select { flex: 1; width: auto; }
  .memory-list li { flex-wrap: wrap; gap: 6px 10px; padding: 10px 6px 6px 12px; }
  .memory-list p { flex-basis: calc(100% - 70px); order: 0; }
  .strength { margin-left: 66px; }
  .row-actions { margin-left: auto; }
  .search input { width: 120px; }
}
</style>
