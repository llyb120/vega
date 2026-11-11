<script setup vapor>
import { computed, onMounted, ref } from "vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
import { beijingParts, beijingTimestamp } from "../../shared/time";
const props = defineProps({ api: Function, admin: Boolean, selfId: String });
// Presets count natural days in Beijing time: 今天 is one day, the rest run back from today's midnight.
const RANGES = [
  { id: "today", label: "今天", days: 1 },
  { id: "7d", label: "近 7 天", days: 7 },
  { id: "30d", label: "近 30 天", days: 30 },
  { id: "90d", label: "近 90 天", days: 90 },
  { id: "all", label: "全部", days: 0 },
];
const empty = { n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, users: [] };
const stats = ref({ ...empty }), busy = ref(false), error = ref("");
const userId = ref(""), range = ref("all"), admin = ref(false);
const rangeLabel = computed(() => RANGES.find((item) => item.id === range.value)?.label || "");
function rangeFrom(id) {
  const days = RANGES.find((item) => item.id === id)?.days || 0;
  if (!days) return undefined;
  const p = beijingParts(Date.now());
  return beijingTimestamp(p.year, p.month, p.day, 0, 0) - (days - 1) * 86400000;
}
async function load() {
  busy.value = true;
  error.value = "";
  try {
    const query = new URLSearchParams();
    if (userId.value) query.set("userId", userId.value);
    const from = rangeFrom(range.value);
    if (from !== undefined) query.set("from", String(from));
    const search = query.toString();
    const result = await props.api("/usage" + (search ? "?" + search : ""));
    stats.value = { ...empty, ...result, users: result.users || [] };
    admin.value = !!result.admin;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function setRange(id) {
  range.value = id;
  load();
}
function formatTokens(n) {
  return new Intl.NumberFormat("zh-CN").format(n || 0);
}
onMounted(load);
</script>
<template>
  <PageHeader title="Token 统计" subtitle="按时间范围统计本账号的模型用量；管理员可查看全部或筛选某一用户" />
  <div class="page-scroll settings">
    <p v-if="error" class="callout warn" role="alert"><Icon name="alert" :size="14" /><span>{{ error }}</span></p>
    <section class="card">
      <div class="card-head row">
        <div>
          <h3>用量汇总</h3>
          <p class="hint">{{ rangeLabel }} 共 {{ formatTokens(stats.n) }} 次模型请求（含缓存读写）。{{ admin ? "管理员默认看到全部用户。" : "仅显示你自己的记录。" }}</p>
        </div>
        <div class="actions">
          <label v-if="admin" class="user-filter">用户
            <select v-model="userId" @change="load">
              <option value="">全部用户</option>
              <option v-if="selfId" :value="selfId">我自己</option>
              <option v-for="id in stats.users.filter((item) => item !== selfId)" :key="id" :value="id">{{ id }}</option>
            </select>
          </label>
          <button type="button" class="sm" :disabled="busy" @click="load"><Icon name="refresh" :size="14" />刷新</button>
        </div>
      </div>
      <div class="segmented ranges" role="group" aria-label="时间范围">
        <button v-for="item in RANGES" :key="item.id" type="button" :aria-pressed="range === item.id" :disabled="busy" @click="setRange(item.id)">{{ item.label }}</button>
      </div>
      <div class="usage-grid">
        <article class="stat"><span class="hint">合计</span><strong>{{ formatTokens(stats.total) }}</strong></article>
        <article class="stat"><span class="hint">输入</span><strong>{{ formatTokens(stats.input) }}</strong></article>
        <article class="stat"><span class="hint">输出</span><strong>{{ formatTokens(stats.output) }}</strong></article>
        <article class="stat"><span class="hint">缓存命中</span><strong>{{ formatTokens(stats.cacheRead) }}</strong></article>
        <article class="stat"><span class="hint">缓存写入</span><strong>{{ formatTokens(stats.cacheWrite) }}</strong></article>
      </div>
    </section>
  </div>
</template>
<style scoped>
.card-head.row { align-items: flex-start; gap: 12px; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.user-filter { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.ranges { margin-top: 12px; flex-wrap: wrap; }
.usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-top: 12px; }
.stat { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
.stat strong { font-size: 18px; }
</style>
