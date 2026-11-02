<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import { dutyCondition, dutyContent } from "../../shared/duty-condition";
const props = defineProps({ duties: Array, canManage: Boolean, save: Function, remove: Function });
const open = ref(false), saving = ref(false), duty = ref(empty());
function empty() { return { id: "", condition: "", text: "" }; }
function create() { duty.value = empty(); open.value = true; }
function edit(d) {
  duty.value = { id: d.id, condition: dutyCondition(d), text: dutyContent(d) };
  open.value = true;
}
function triggerIcon(d) { return d.manual ? "hand" : d.everyMinutes ? "repeat" : "clock"; }
async function submit() {
  if (saving.value || !props.canManage) return;
  const d = duty.value;
  const data = { action: d.id ? "update" : "add", kind: "duty", id: d.id || undefined, condition: d.condition, text: d.text, note: "" };
  saving.value = true;
  try { if (await props.save(data) === true && duty.value === d) { open.value = false; duty.value = empty(); } }
  finally { saving.value = false; }
}
</script>
<template>
  <div class="page-scroll section-page">
    <div class="section-inner">
      <div class="section-heading">
        <div><h3>职责模板 <small>{{ duties.length }}</small></h3><p class="hint">把重复的工作写成职责，只在真正触发时开工。</p></div>
        <button v-if="canManage && !open" type="button" class="primary" @click="create"><Icon name="plus" :size="16" />新增职责</button>
      </div>
      <form v-if="open && canManage" class="card duty-form" @submit.prevent="submit">
        <h4>{{ duty.id ? '编辑职责' : '新增职责' }}</h4>
        <div class="form-grid two">
          <label class="span-2">触发条件<textarea v-model="duty.condition" rows="2" maxlength="2000" required :disabled="saving" placeholder="例如：每天上午9点；每30分钟检查一次；按交代的任务需要"></textarea></label>
          <label class="span-2">职责内容<textarea v-model="duty.text" rows="5" maxlength="8000" required :disabled="saving" placeholder="说明要做什么、处理范围和交付要求"></textarea></label>
        </div>
        <div class="form-foot"><p class="hint">保存时自动识别触发方式，时间按北京时间；无法自动执行的条件会明确提示。</p><div class="actions"><button type="button" class="ghost" :disabled="saving" @click="open = false">取消</button><button class="primary" :disabled="saving">{{ saving ? '保存中…' : '保存职责' }}</button></div></div>
      </form>
      <div v-if="!duties.length && !open" class="empty-state"><Icon name="repeat" :size="28" /><strong>还没有职责</strong><span>例如「每天 9 点检查 CI 失败原因」。</span></div>
      <ul v-if="duties.length" class="duty-list">
        <li v-for="d in duties" :key="d.id" :class="{ disabled: !d.enabled }">
          <span class="duty-icon"><Icon :name="triggerIcon(d)" :size="16" /></span>
          <div class="duty-main">
            <strong>{{ dutyContent(d) }}</strong>
            <span class="duty-meta"><span>{{ dutyCondition(d) }}</span><span :class="['badge', d.enabled ? 'ok' : '']">{{ d.enabled ? '启用' : '停用' }}</span></span>
          </div>
          <div v-if="canManage" class="duty-actions">
            <button type="button" class="sm ghost" @click="edit(d)"><Icon name="edit" :size="14" />编辑</button>
            <button type="button" class="sm ghost" @click="save({ action: 'update', id: d.id, enabled: !d.enabled })">{{ d.enabled ? '停用' : '启用' }}</button>
            <button type="button" class="sm danger-text" @click="remove(d)"><Icon name="trash" :size="14" />移除</button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
<style scoped>
.section-inner { max-width: 960px; }
.section-heading { align-items: flex-start; }
.duty-form { display: grid; gap: 12px; margin-bottom: 16px; border-color: #cbd9fb; box-shadow: 0 0 0 3px var(--accent-softer); }
.duty-form h4 { font-size: 13px; }
.form-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.duty-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }
.duty-list li { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; }
.duty-list li + li { border-top: 1px solid var(--border); }
.duty-list li.disabled .duty-main strong { color: var(--muted); }
.duty-icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--r-md); background: var(--accent-soft); color: var(--accent-text); }
li.disabled .duty-icon { background: var(--surface-3); color: var(--muted); }
.duty-main { display: grid; flex: 1; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
.duty-main strong { font-weight: 500; line-height: 1.5; white-space: pre-wrap; }
.duty-main p { color: var(--text-2); font-size: 12px; }
.duty-meta { display: flex; align-items: center; gap: 8px; margin-top: 2px; color: var(--muted); font-size: 12px; }
.duty-actions { display: flex; gap: 2px; flex: none; }
@media (max-width: 767px) {
  .duty-list li { flex-wrap: wrap; padding: 12px; }
  .duty-actions { width: 100%; justify-content: flex-end; margin-top: -4px; }
}
</style>
