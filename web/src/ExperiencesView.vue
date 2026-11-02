<script setup vapor>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import PageHeader from "./PageHeader.vue";
import Icon from "./Icon.vue";
const props = defineProps({ api: Function });
const busy = ref(false),
  error = ref(""),
  routes = ref([]),
  scope = ref(""),
  query = ref(""),
  selected = ref(""),
  detailOpen = ref(false);
function choose(id) {
  selected.value = id;
  detailOpen.value = true;
}
const scopes = computed(() =>
    [...new Set(routes.value.map((r) => r.scope))].sort(),
  ),
  visible = computed(() =>
    routes.value.filter(
      (r) =>
        (!scope.value || r.scope === scope.value) &&
        (!query.value ||
          (r.task + " " + r.scope)
            .toLowerCase()
            .includes(query.value.toLowerCase())),
    ),
  ),
  current = computed(
    () =>
      visible.value.find((r) => r.id === selected.value) || visible.value[0],
  );
async function refresh() {
  busy.value = true;
  error.value = "";
  try {
    const graph = await props.api("/experiences");
    routes.value = graph.routes || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
const stacked = ref(false);
const stackedMedia = window.matchMedia("(max-width: 1099px)");
const syncStacked = () => (stacked.value = stackedMedia.matches);
syncStacked();
stackedMedia.addEventListener("change", syncStacked);
onBeforeUnmount(() => stackedMedia.removeEventListener("change", syncStacked));
onMounted(() => void refresh());
</script>
<template>
  <PageHeader :title="stacked && detailOpen && current ? current.task : '经验图谱'" :subtitle="stacked && detailOpen && current ? current.scope : '牛马在网站上验证成功的操作路线'" :back="stacked && detailOpen ? '列表' : ''" @back="detailOpen = false">
    <button type="button" class="sm" :disabled="busy" title="刷新" @click="refresh"><Icon name="refresh" :size="14" /><span class="hide-mobile">刷新</span></button>
  </PageHeader>
  <div class="experience-layout" :class="{ 'detail-open': detailOpen }">
    <aside class="experience-list-pane" aria-label="经验列表">
      <div class="experience-filters">
        <select v-model="scope" aria-label="经验网站"><option value="">全部网站</option><option v-for="site in scopes" :key="site">{{ site }}</option></select>
        <label class="search"><Icon name="search" :size="14" /><input v-model="query" placeholder="搜索经验" aria-label="搜索经验" /></label>
      </div>
      <p v-if="error" class="banner error" role="alert"><span>{{ error }}</span></p>
      <div class="experience-list">
        <p v-if="!visible.length" class="empty-state">{{ busy ? "加载中…" : "暂无经验" }}</p>
        <button v-for="r in visible" :key="r.id" type="button" :class="{ selected: current?.id === r.id && (!stacked || !!selected) }" :aria-current="current?.id === r.id ? 'true' : undefined" @click="choose(r.id)">
          <span class="route-icon" aria-hidden="true"><Icon name="graph" :size="16" /></span>
          <span class="route-text"><strong>{{ r.task }}</strong><small>{{ r.scope }} · {{ r.steps?.length || 0 }} 步 · 成功 {{ r.successes }} 次</small></span>
          <Icon name="right" :size="14" class="route-chevron" />
        </button>
      </div>
    </aside>
    <section class="experience-detail" aria-label="经验详情">
      <template v-if="current">
        <header class="detail-head">
          <div><h3>{{ current.task }}</h3><p><Icon name="globe" :size="13" />{{ current.scope }}</p></div>
          <span class="badge ok"><Icon name="check" :size="12" />成功 {{ current.successes }} 次</span>
        </header>
        <ol class="route-flow">
          <li v-if="current.conditions?.length" class="flow-node entry"><span class="flow-marker"><Icon name="play" :size="12" /></span><div><small>开始条件</small><p v-for="text in current.conditions" :key="text">{{ text }}</p></div></li>
          <li v-for="(text, n) in current.steps" :key="n" class="flow-node"><span class="flow-marker">{{ n + 1 }}</span><div><p>{{ text }}</p></div></li>
          <li v-if="current.checks?.length" class="flow-node complete"><span class="flow-marker"><Icon name="check" :size="12" /></span><div><small>完成标志</small><p v-for="text in current.checks" :key="text">{{ text }}</p></div></li>
        </ol>
        <div v-if="current.pitfalls?.length" class="callout experience-cautions"><Icon name="alert" :size="16" /><div><strong>注意事项</strong><p v-for="text in current.pitfalls" :key="text">{{ text }}</p></div></div>
      </template>
      <div v-else class="detail-empty"><Icon name="graph" :size="32" /><strong>{{ busy ? '加载中…' : '暂无经验' }}</strong><span>牛马完成网页任务后，验证过的路线会沉淀在这里。</span></div>
    </section>
  </div>
</template>
<style scoped>
.experience-layout { display: grid; grid-template-columns: minmax(300px, 360px) minmax(0, 1fr); flex: 1; min-height: 0; }
.experience-list-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--bg); }
.experience-filters { display: flex; gap: 6px; flex: none; padding: 12px; }
.experience-filters select { flex: 0 1 130px; min-width: 0; }
.search { position: relative; display: flex; align-items: center; flex: 1; min-width: 0; }
.search .icon-svg { position: absolute; left: 9px; color: var(--muted); pointer-events: none; }
.search input { width: 100%; padding-left: 28px; }
.experience-list-pane > .banner { flex: none; }
.experience-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 16px; scrollbar-width: thin; }
.experience-list button { display: flex; align-items: center; gap: 10px; width: 100%; height: auto; margin-bottom: 2px; padding: 10px; border: 1px solid transparent; border-radius: var(--r-md); background: transparent; font-weight: 400; text-align: left; white-space: normal; }
.experience-list button:hover:not(:disabled) { background: var(--surface); border-color: var(--border); }
.experience-list button.selected { background: var(--surface); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.route-icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); }
.route-text { display: grid; flex: 1; min-width: 0; gap: 2px; }
.route-text strong { color: var(--text); font-size: 13px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.route-text small { color: var(--muted); font-size: 11px; }
.route-chevron { display: none; color: var(--faint); }
.experience-detail { min-width: 0; min-height: 0; overflow-y: auto; padding: 24px 32px 40px; background: var(--surface); scrollbar-width: thin; }
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; max-width: 720px; margin-bottom: 20px; }
.detail-head h3 { font-size: 18px; line-height: 1.4; }
.detail-head p { display: flex; align-items: center; gap: 4px; margin-top: 4px; color: var(--muted); font-size: 12px; }
.detail-head .badge { flex: none; gap: 4px; }
.route-flow { position: relative; display: grid; gap: 0; max-width: 720px; margin: 0; padding: 0; list-style: none; }
.flow-node { position: relative; display: flex; gap: 14px; padding-bottom: 14px; }
.flow-node:not(:last-child)::before { content: ""; position: absolute; left: 13px; top: 28px; bottom: 0; width: 2px; background: var(--border); }
.flow-marker { position: relative; z-index: 1; display: grid; place-items: center; flex: none; width: 28px; height: 28px; border: 1px solid var(--border-strong); border-radius: 50%; background: var(--surface); color: var(--text-2); font-size: 12px; font-weight: 600; }
.flow-node > div { flex: 1; min-width: 0; padding: 4px 0 0; line-height: 1.7; overflow-wrap: anywhere; }
.flow-node small { display: block; margin-bottom: 2px; color: var(--muted); font-size: 11px; font-weight: 600; }
.flow-node.entry .flow-marker { border-color: transparent; background: var(--accent-soft); color: var(--accent); }
.flow-node.entry > div, .flow-node.complete > div { padding: 8px 12px; border-radius: var(--r-md); }
.flow-node.entry > div { background: var(--accent-softer); }
.flow-node.complete .flow-marker { border-color: transparent; background: var(--ok-soft); color: var(--ok); }
.flow-node.complete > div { background: var(--ok-soft); }
.experience-cautions { max-width: 720px; margin-top: 12px; }
.experience-cautions p { margin-top: 2px; }
.detail-empty { display: grid; justify-items: center; gap: 6px; padding: 80px 20px; color: var(--muted); font-size: 12px; text-align: center; }
.detail-empty strong { color: var(--text); font-size: 14px; }
.detail-empty .icon-svg { color: var(--faint); }
@media (max-width: 1099px) {
  .experience-layout { grid-template-columns: minmax(0, 1fr); }
  .experience-list-pane { border-right: 0; }
  .experience-layout:not(.detail-open) .experience-detail, .experience-layout.detail-open .experience-list-pane { display: none; }
  .route-chevron { display: block; }
}
@media (max-width: 767px) {
  .experience-detail { padding: 16px 14px 32px; }
  .detail-head { flex-direction: column; gap: 8px; }
  .detail-head h3 { font-size: 16px; }
}
</style>
