<script setup vapor>
import { computed, onMounted, ref } from "vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
import { formatBeijing } from "../../shared/time";
const props = defineProps({ api: Function, admin: Boolean, selfId: String });
const rows = ref([]), busy = ref(false), error = ref(""), userId = ref(""), admin = ref(false);
const totals = computed(() => rows.value.reduce((acc, row) => ({
  input: acc.input + (row.input || 0),
  output: acc.output + (row.output || 0),
  cacheRead: acc.cacheRead + (row.cacheRead || 0),
  cacheWrite: acc.cacheWrite + (row.cacheWrite || 0),
  total: acc.total + (row.total || (row.input || 0) + (row.output || 0) + (row.cacheRead || 0) + (row.cacheWrite || 0)),
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }));
const users = computed(() => [...new Set(rows.value.map((row) => row.userId).filter(Boolean))].sort());
async function load() {
  busy.value = true;
  error.value = "";
  try {
    const query = userId.value ? "?userId=" + encodeURIComponent(userId.value) : "";
    const result = await props.api("/usage" + query);
    rows.value = result.rows || [];
    admin.value = !!result.admin;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function formatTokens(n) {
  return new Intl.NumberFormat("zh-CN").format(n || 0);
}
onMounted(load);
</script>
<template>
  <PageHeader title="Token 统计" subtitle="查看本账号的模型用量；管理员可查看全部或筛选某一用户" />
  <div class="page-scroll settings">
    <p v-if="error" class="callout warn" role="alert"><Icon name="alert" :size="14" /><span>{{ error }}</span></p>
    <section class="card">
      <div class="card-head row">
        <div>
          <h3>用量汇总</h3>
          <p class="hint">数据来自每次模型请求的实际用量（含缓存读写）。{{ admin ? "管理员默认看到全部用户。" : "仅显示你自己的记录。" }}</p>
        </div>
        <div class="actions">
          <label v-if="admin" class="user-filter">用户
            <select v-model="userId" @change="load">
              <option value="">全部用户</option>
              <option v-if="selfId" :value="selfId">我自己</option>
              <option v-for="id in users.filter((id) => id !== selfId)" :key="id" :value="id">{{ id }}</option>
            </select>
          </label>
          <button type="button" class="sm" :disabled="busy" @click="load"><Icon name="refresh" :size="14" />刷新</button>
        </div>
      </div>
      <div class="usage-grid">
        <article class="stat"><span class="hint">合计</span><strong>{{ formatTokens(totals.total) }}</strong></article>
        <article class="stat"><span class="hint">输入</span><strong>{{ formatTokens(totals.input) }}</strong></article>
        <article class="stat"><span class="hint">输出</span><strong>{{ formatTokens(totals.output) }}</strong></article>
        <article class="stat"><span class="hint">缓存命中</span><strong>{{ formatTokens(totals.cacheRead) }}</strong></article>
        <article class="stat"><span class="hint">缓存写入</span><strong>{{ formatTokens(totals.cacheWrite) }}</strong></article>
      </div>
    </section>
    <section class="card">
      <h3>明细</h3>
      <p v-if="busy && !rows.length" class="hint">正在加载…</p>
      <p v-else-if="!rows.length" class="hint">还没有用量记录。</p>
      <div v-else class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>时间</th>
              <th v-if="admin && !userId">用户</th>
              <th>模型</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存命中</th>
              <th>缓存写入</th>
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>{{ formatBeijing(row.at) }}</td>
              <td v-if="admin && !userId">{{ row.userId }}</td>
              <td class="model">{{ row.model || "—" }}</td>
              <td>{{ formatTokens(row.input) }}</td>
              <td>{{ formatTokens(row.output) }}</td>
              <td>{{ formatTokens(row.cacheRead) }}</td>
              <td>{{ formatTokens(row.cacheWrite) }}</td>
              <td>{{ formatTokens(row.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
<style scoped>
.card-head.row { align-items: flex-start; gap: 12px; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.user-filter { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-top: 12px; }
.stat { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
.stat strong { font-size: 18px; }
.usage-table-wrap { overflow-x: auto; }
.usage-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.usage-table th, .usage-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
.usage-table th:first-child, .usage-table td:first-child, .usage-table .model { text-align: left; }
.usage-table th { color: var(--muted); font-weight: 600; }
</style>
