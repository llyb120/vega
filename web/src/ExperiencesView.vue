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
  padding: 22px 28px;
}
.experience-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
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
  gap: 20px;
}
.experience-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.experience-list button {
  text-align: left;
  padding: 14px;
}
.experience-list strong,
.experience-list small {
  display: block;
  overflow-wrap: anywhere;
}
.experience-list .selected {
  border-color: var(--green);
  background: #edf5ef;
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
  border-radius: 10px;
  padding: 14px 18px;
  line-height: 1.8;
  background: #f8faf8;
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
  border-color: #9bc9b0;
  background: #edf8f0;
}
.flow-node.entry {
  background: #f1f5fa;
}
.flow-arrow {
  font-size: 24px;
  color: #97ac9f;
  padding: 6px;
}
.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #dfede3;
  color: var(--green);
  font-size: 12px;
  margin-right: 10px;
}
.experience-cautions {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
@media (max-width: 800px) {
  .experience-page {
    padding: 16px;
  }
  .experience-layout {
    grid-template-columns: 1fr;
  }
  .experience-list {
    flex-direction: row;
    overflow: auto;
    max-width: 100%;
  }
  .experience-list button {
    min-width: 200px;
  }
  .experience-flow {
    padding: 4px;
  }
  .experience-filters {
    flex-wrap: wrap;
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
