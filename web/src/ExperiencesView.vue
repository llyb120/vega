<script setup vapor>
import { computed, onMounted, ref } from "vue";
const props = defineProps({ api: Function });
const busy = ref(false),
  error = ref(""),
  routes = ref([]),
  scope = ref(""),
  query = ref(""),
  selected = ref("");
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
onMounted(() => void refresh());
</script>
<template>
  <header class="topbar">
    <h2>经验图谱</h2>
    <button :disabled="busy" @click="refresh">刷新</button>
  </header>
  <div class="experience-page">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="experience-filters">
      <select v-model="scope" aria-label="经验网站">
        <option value="">全部网站</option>
        <option v-for="site in scopes" :key="site">{{ site }}</option></select
      ><input v-model="query" placeholder="搜索经验" aria-label="搜索经验" />
    </div>
    <div v-if="!visible.length" class="empty-card">
      {{ busy ? "加载中…" : "暂无经验" }}
    </div>
    <div v-else class="experience-layout">
      <aside class="experience-list">
        <button
          v-for="r in visible"
          :key="r.id"
          :class="{ selected: current?.id === r.id }"
          @click="selected = r.id"
        >
          <strong>{{ r.task }}</strong
          ><small>{{ r.scope }}</small>
        </button>
      </aside>
      <section v-if="current" class="experience-detail card">
        <div class="section-heading">
          <h3>{{ current.task }}</h3>
          <span class="pill green">成功 {{ current.successes }} 次</span>
        </div>
        <p class="hint">{{ current.scope }}</p>
        <div class="experience-flow">
          <div v-if="current.conditions?.length" class="flow-node entry">
            <small>开始</small>
            <p v-for="text in current.conditions" :key="text">{{ text }}</p>
          </div>
          <template v-for="(text, n) in current.steps" :key="n"
            ><span class="flow-arrow" aria-hidden="true">↓</span>
            <div class="flow-node">
              <span class="step-number">{{ n + 1 }}</span
              >{{ text }}
            </div></template
          ><template v-if="current.checks?.length"
            ><span class="flow-arrow" aria-hidden="true">↓</span>
            <div class="flow-node complete">
              <small>完成</small>
              <p v-for="text in current.checks" :key="text">{{ text }}</p>
            </div></template
          >
        </div>
        <div v-if="current.pitfalls?.length" class="experience-cautions">
          <h3>注意事项</h3>
          <p v-for="text in current.pitfalls" :key="text">{{ text }}</p>
        </div>
      </section>
    </div>
  </div>
</template>
<style scoped>
.experience-page {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 30px 40px;
  scrollbar-width: thin;
  scrollbar-color: #d5d8e1 transparent;
}
.experience-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 22px;
}
.experience-filters select {
  max-width: 50%;
}
.experience-filters input {
  flex: 1;
}
.experience-layout {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  align-items: start;
  gap: 22px;
}
.experience-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.experience-list button {
  text-align: left;
  color: #5c6272;
  padding: 15px;
  border-radius: 12px;
}
.experience-list strong,
.experience-list small {
  display: block;
  overflow-wrap: anywhere;
}
.experience-list .selected {
  border-color: #d9d9f5;
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: 0 3px 10px #5b5bd60a;
}
.experience-detail {
  margin: 0;
}
.experience-flow {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px;
}
.flow-node {
  width: min(100%, 540px);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 15px 18px;
  line-height: 1.8;
  background: #f8f9fb;
  overflow-wrap: anywhere;
}
.flow-node p {
  margin: 0;
}
.flow-node small {
  display: block;
  margin-bottom: 5px;
}
.flow-node.complete {
  border-color: #d8f0e3;
  background: #edf8f2;
}
.flow-node.entry {
  border-color: #dfdff6;
  background: #f4f4fc;
}
.flow-arrow {
  font-size: 24px;
  color: #b1b4c3;
  padding: 6px;
}
.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #e8e8fb;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  margin-right: 10px;
}
.experience-cautions {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
@media (max-width: 800px) {
  .experience-page {
    padding: 18px 14px max(24px, env(safe-area-inset-bottom, 0px));
  }
  .experience-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .experience-list {
    flex-direction: row;
    overflow: auto;
    max-width: 100%;
    margin: 0 -14px;
    padding: 0 14px 4px;
    scrollbar-width: none;
  }
  .experience-list::-webkit-scrollbar {
    display: none;
  }
  .experience-list button {
    min-width: 190px;
  }
  .experience-flow {
    padding: 4px 0;
  }
  .flow-node {
    padding: 13px 14px;
  }
  .experience-filters {
    flex-wrap: wrap;
    gap: 10px;
  }
  .experience-filters select {
    max-width: 100%;
    width: 100%;
  }
  .experience-filters input {
    width: 100%;
  }
  .experience-detail {
    min-width: 0;
  }
  .experience-list button {
    max-width: 240px;
    flex-shrink: 0;
  }
  .experience-detail .section-heading {
    flex-wrap: wrap;
  }
}
</style>
