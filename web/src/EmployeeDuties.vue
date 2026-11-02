<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps({ duties: Array, canManage: Boolean, save: Function, remove: Function });
const open = ref(false), saving = ref(false), duty = ref(empty());
function empty() { return { id: "", text: "", note: "", profile: "lightweight", trigger: "manual", times: "09:00", everyMinutes: 60, nextAt: "", enabled: true }; }
function create() { duty.value = empty(); open.value = true; }
function edit(d) {
  duty.value = { ...empty(), ...d, trigger: d.manual ? "manual" : d.everyMinutes ? "interval" : d.times?.length ? "times" : "dynamic", times: (d.times || ["09:00"]).join(",") };
  open.value = true;
}
function trigger(d) { return d.manual ? "不定时 · 手动匹配" : d.everyMinutes ? `完成后每 ${d.everyMinutes} 分钟` : d.times?.length ? `每天 ${d.times.join("、")}` : d.events?.join("、") || "动态安排"; }
function triggerIcon(d) { return d.manual ? "hand" : d.everyMinutes ? "repeat" : "clock"; }
async function submit() {
  if (saving.value) return;
  const d = duty.value;
  const data = { action: d.id ? "update" : "add", kind: "duty", id: d.id || undefined, text: d.text, note: d.note, profile: d.profile, enabled: d.enabled, manual: d.trigger === "manual", times: [], everyMinutes: 0, events: [] };
  if (d.trigger === "times") data.times = d.times.split(",").map((s) => s.trim()).filter(Boolean);
  if (d.trigger === "interval") data.everyMinutes = Number(d.everyMinutes);
  if (d.trigger === "dynamic") data.nextAt = d.nextAt.replace("T", " ");
  saving.value = true;
  try { if (await props.save(data) === true) { open.value = false; duty.value = empty(); } }
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
      <form v-if="open" class="card duty-form" @submit.prevent="submit">
        <h4>{{ duty.id ? '编辑职责' : '新增职责' }}</h4>
        <div class="form-grid two">
          <label class="span-2">要做什么<textarea v-model="duty.text" required rows="2"></textarea></label>
          <label class="span-2">补充要求<textarea v-model="duty.note" rows="2"></textarea></label>
          <label>触发方式<select v-model="duty.trigger"><option value="manual">不定时，手动匹配</option><option value="times">每天固定时刻</option><option value="interval">固定间隔</option><option value="dynamic">动态安排</option></select></label>
          <label v-if="duty.trigger === 'times'">时刻（逗号分隔）<input v-model="duty.times" placeholder="09:00,14:30" required /></label>
          <label v-else-if="duty.trigger === 'interval'">完成后间隔（分钟）<input v-model="duty.everyMinutes" type="number" min="1" max="10080" required /></label>
          <label v-else-if="duty.trigger === 'dynamic'">首次执行<input v-model="duty.nextAt" type="datetime-local" required /></label>
          <span v-else></span>
        </div>
        <div class="form-foot"><label class="check"><input v-model="duty.enabled" type="checkbox" />启用此职责</label><div class="actions"><button type="button" class="ghost" @click="open = false">取消</button><button class="primary" :disabled="saving">{{ saving ? '保存中…' : '保存职责' }}</button></div></div>
      </form>
      <div v-if="!duties.length && !open" class="empty-state"><Icon name="repeat" :size="28" /><strong>还没有职责</strong><span>例如「每天 9 点检查 CI 失败原因」。</span></div>
      <ul v-if="duties.length" class="duty-list">
        <li v-for="d in duties" :key="d.id" :class="{ disabled: !d.enabled }">
          <span class="duty-icon"><Icon :name="triggerIcon(d)" :size="16" /></span>
          <div class="duty-main">
            <strong>{{ d.text }}</strong>
            <p v-if="d.note">{{ d.note }}</p>
            <span class="duty-meta"><span>{{ trigger(d) }}</span><span :class="['badge', d.enabled ? 'ok' : '']">{{ d.enabled ? '启用' : '停用' }}</span></span>
          </div>
          <div v-if="canManage" class="duty-actions">
            <button type="button" class="sm ghost" @click="edit(d)"><Icon name="edit" :size="14" />编辑</button>
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
.duty-main strong { font-weight: 500; line-height: 1.5; }
.duty-main p { color: var(--text-2); font-size: 12px; }
.duty-meta { display: flex; align-items: center; gap: 8px; margin-top: 2px; color: var(--muted); font-size: 12px; }
.duty-actions { display: flex; gap: 2px; flex: none; }
@media (max-width: 767px) {
  .duty-list li { flex-wrap: wrap; padding: 12px; }
  .duty-actions { width: 100%; justify-content: flex-end; margin-top: -4px; }
}
</style>
