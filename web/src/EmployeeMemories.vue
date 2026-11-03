<script setup vapor>
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps({
  memories: { type: Array, default: () => [] },
  canManage: Boolean,
  save: Function,
  forget: Function,
  resolve: Function,
  pin: Function,
});
const claim = ref(""), id = ref(""), kind = ref("convention"), scene = ref("any"), scope = ref("global"), saving = ref(false), query = ref(""), tab = ref("active"), selected = ref([]);
const kinds = [
  ["preference", "偏好"],
  ["convention", "约定"],
  ["procedure", "流程"],
  ["environment", "环境"],
  ["person_org", "人事"],
  ["correction", "纠错"],
];
const kindLabel = Object.fromEntries(kinds);
const statusLabel = { active: "活跃", draft: "待确认", conflict: "冲突", archived: "归档" };
function edit(m) {
  id.value = m.id;
  claim.value = m.claim || m.text || "";
  kind.value = m.kind || "convention";
  scene.value = m.scene || "any";
  scope.value = m.scope || "global";
  tab.value = m.status === "archived" ? "archived" : m.status === "draft" || m.status === "conflict" ? "pending" : "active";
}
function cancel() {
  id.value = "";
  claim.value = "";
  kind.value = "convention";
  scene.value = "any";
  scope.value = "global";
}
async function submit() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (await props.save({
      id: id.value || undefined,
      claim: claim.value,
      memoryKind: kind.value,
      memoryScene: scene.value,
      scope: scope.value,
      source: "ui",
    }) === true) cancel();
  } finally { saving.value = false; }
}
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (props.memories || []).filter((m) => {
    const status = m.status || "active";
    if (tab.value === "active" && status !== "active") return false;
    if (tab.value === "pending" && !["draft", "conflict"].includes(status)) return false;
    if (tab.value === "archived" && status !== "archived") return false;
    if (!q) return true;
    return [m.claim, m.text, m.kind, m.scope, m.scene, m.evidence].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
});
const counts = computed(() => {
  const all = props.memories || [];
  return {
    active: all.filter((m) => (m.status || "active") === "active").length,
    pending: all.filter((m) => m.status === "draft" || m.status === "conflict").length,
    archived: all.filter((m) => m.status === "archived").length,
  };
});
function toggle(id) {
  selected.value = selected.value.includes(id) ? selected.value.filter((x) => x !== id) : [...selected.value, id];
}
async function mergeSelected() {
  if (selected.value.length < 2 || !props.resolve) return;
  await props.resolve({ resolveAction: "merge", ids: selected.value });
  selected.value = [];
}
function exportJson() {
  const blob = new Blob([JSON.stringify(props.memories || [], null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "employee-memories.json"; a.click();
  URL.revokeObjectURL(url);
}
function exportMarkdown() {
  const lines = ["# 数字牛马记忆", ""];
  for (const m of props.memories || []) {
    lines.push(`- **${kindLabel[m.kind] || m.kind || "记忆"}** (${m.status || "active"} · ${m.scene || "any"}/${m.scope || "global"}): ${m.claim || m.text || ""}`);
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "employee-memories.md"; a.click();
  URL.revokeObjectURL(url);
}
function pct(v) { return Math.round((Number(v) || 0) * 100); }
</script>
<template>
  <div class="page-scroll section-page">
    <div class="section-inner">
      <div class="section-heading">
        <div>
          <h3>记忆 <small>{{ counts.active }} 活跃 · {{ counts.pending }} 待确认</small></h3>
          <p class="hint">只保留跨任务仍成立的稳定知识。系统会合并近义、隔离场景，并用使用反馈越用越准。</p>
        </div>
        <div class="heading-actions">
          <label v-if="memories.length > 3" class="search"><Icon name="search" :size="15" /><input v-model="query" type="search" placeholder="搜索记忆" aria-label="搜索记忆" /></label>
          <button type="button" class="ghost sm" @click="exportMarkdown">导出 MD</button>
          <button type="button" class="ghost sm" @click="exportJson">导出 JSON</button>
        </div>
      </div>

      <div class="tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="tab === 'active'" :class="{ on: tab === 'active' }" @click="tab = 'active'">活跃 {{ counts.active }}</button>
        <button type="button" role="tab" :aria-selected="tab === 'pending'" :class="{ on: tab === 'pending' }" @click="tab = 'pending'">待确认 {{ counts.pending }}</button>
        <button type="button" role="tab" :aria-selected="tab === 'archived'" :class="{ on: tab === 'archived' }" @click="tab = 'archived'">归档 {{ counts.archived }}</button>
      </div>

      <form v-if="canManage" class="memory-form" :class="{ editing: id }" @submit.prevent="submit">
        <input v-model="claim" required maxlength="120" :placeholder="id ? '修改这条主张' : '一条稳定、可跨任务复用的主张（≤120字）'" aria-label="记忆主张" />
        <select v-model="kind" aria-label="类型"><option v-for="[value, label] in kinds" :key="value" :value="value">{{ label }}</option></select>
        <select v-model="scene" aria-label="场景"><option value="any">任意场景</option><option value="chat">沟通</option><option value="coding">编码</option><option value="computer">电脑</option></select>
        <input v-model="scope" maxlength="200" placeholder="作用域 global / 路径 / 站点" aria-label="作用域" />
        <button class="primary" :disabled="saving">{{ id ? '更新' : '记住' }}</button>
        <button v-if="id" type="button" class="ghost" @click="cancel">取消</button>
      </form>

      <div v-if="canManage && tab === 'active' && selected.length >= 2" class="bulk-bar">
        <span>已选 {{ selected.length }} 条</span>
        <button type="button" class="primary sm" @click="mergeSelected">合并所选</button>
        <button type="button" class="ghost sm" @click="selected = []">清空</button>
      </div>

      <div v-if="!filtered.length" class="empty-state"><Icon name="memory" :size="28" /><strong>{{ tab === 'pending' ? '没有待确认记忆' : tab === 'archived' ? '归档为空' : '还没有记忆' }}</strong><span>{{ tab === 'active' ? '牛马会在工作中沉淀记忆，你也可以在上方手动添加。' : '冲突与草稿会出现在这里。' }}</span></div>
      <ul v-else class="memory-list">
        <li v-for="m in filtered" :key="m.id" :class="{ editing: id === m.id, conflict: m.status === 'conflict', draft: m.status === 'draft' }">
          <label v-if="canManage && tab === 'active'" class="check"><input type="checkbox" :checked="selected.includes(m.id)" @change="toggle(m.id)" :aria-label="'选择 ' + (m.claim || m.text)" /></label>
          <span class="kind">{{ kindLabel[m.kind] || '记忆' }}</span>
          <div class="body">
            <p>{{ m.claim || m.text }}</p>
            <div class="meta">
              <span>{{ statusLabel[m.status || 'active'] }}</span>
              <span>{{ m.scene || 'any' }} · {{ m.scope || 'global' }}</span>
              <span title="可信度">可信 {{ pct(m.confidence) }}%</span>
              <span title="有用度">有用 {{ pct(m.usefulness) }}%</span>
              <span v-if="m.pinned">已钉选</span>
              <span v-if="m.lastUsedAt || m.usedAt">用过</span>
            </div>
          </div>
          <div v-if="canManage" class="row-actions">
            <button v-if="m.status === 'draft' || m.status === 'conflict'" type="button" class="sm" @click="resolve({ resolveAction: 'confirm', id: m.id })">确认</button>
            <button v-if="m.status === 'conflict'" type="button" class="sm ghost" @click="resolve({ resolveAction: 'drop', id: m.id })">丢弃</button>
            <button v-if="m.status === 'archived'" type="button" class="sm" @click="resolve({ resolveAction: 'restore', id: m.id })">恢复</button>
            <button v-else type="button" class="sm ghost" @click="pin(m, !m.pinned)">{{ m.pinned ? '取消钉选' : '钉选' }}</button>
            <button type="button" class="sm icon" aria-label="编辑记忆" title="编辑" @click="edit(m)"><Icon name="edit" :size="14" /></button>
            <button type="button" class="sm icon danger-text" aria-label="忘记这条记忆" title="忘记" @click="forget(m)"><Icon name="trash" :size="14" /></button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
<style scoped>
.section-inner { max-width: 1040px; }
.section-heading { align-items: flex-start; }
.heading-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.search { display: flex; align-items: center; gap: 6px; padding-left: 10px; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface); color: var(--muted); }
.search input { width: 180px; border: 0; box-shadow: none !important; padding-left: 0; }
.tabs { display: flex; gap: 6px; margin: 0 0 12px; }
.tabs button { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 6px 12px; color: var(--text-2); }
.tabs button.on { background: var(--accent-softer); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.memory-form { display: grid; grid-template-columns: minmax(0, 1fr) 110px 110px minmax(120px, 180px) auto auto; gap: 8px; margin-bottom: 12px; }
.memory-form.editing input:first-child { border-color: var(--accent); }
.bulk-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--text-2); font-size: 13px; }
.memory-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }
.memory-list li { display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 10px 10px 10px 14px; }
.memory-list li + li { border-top: 1px solid var(--border); }
.memory-list li.editing { background: var(--accent-softer); }
.memory-list li.conflict { background: var(--warn-soft); }
.memory-list li.draft { background: var(--info-soft); }
.check { margin-top: 4px; }
.kind { flex: none; min-width: 44px; padding: 2px 8px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); font-size: 11px; text-align: center; margin-top: 2px; }
.body { flex: 1; min-width: 0; }
.body p { margin: 0; line-height: 1.55; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; color: var(--muted); font-size: 11px; }
.row-actions { display: flex; flex: none; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
@media (max-width: 900px) {
  .memory-form { grid-template-columns: 1fr 1fr; }
  .memory-form input:first-child { grid-column: 1 / -1; }
  .memory-list li { flex-wrap: wrap; }
  .row-actions { width: 100%; justify-content: flex-end; }
  .search input { width: 120px; }
}
</style>
