<script setup vapor>
import { computed, ref, watch } from "vue";
const props = defineProps({ api: Function, config: Object, models: Array });
const emit = defineEmits(["saved", "error", "notice"]);
const busy = ref(false),
  defaultModel = ref(""),
  choices = ref({ lightweight: [], coding: [], computer: [] });
const scenes = [
  ["lightweight", "沟通与任务起步"],
  ["coding", "编码"],
  ["computer", "浏览器操作"],
];
const entries = computed(
  () =>
    props.models
      ?.filter((m) => m.id && m.available !== false)
      .flatMap((m) => [
        {
          id: m.id,
          name: (m.name || m.id) + " · " + m.id,
          images: m.supportsImages,
        },
        ...(m.variants || []).map((v) => ({
          id: m.id + "/variant/" + v,
          name: (m.name || m.id) + " · " + v + " · " + m.id,
          images: m.supportsImages,
        })),
      ]) || [],
);
watch(
  () => props.config,
  () => {
    defaultModel.value = props.config.model || "";
    choices.value = Object.fromEntries(
      scenes.map(([key]) => [key, [...(props.config.scenes?.[key] || [])]]),
    );
  },
  { immediate: true },
);
function move(key, n, delta) {
  const list = [...choices.value[key]];
  [list[n], list[n + delta]] = [list[n + delta], list[n]];
  choices.value[key] = list;
}
async function save() {
  busy.value = true;
  try {
    const next = JSON.parse(JSON.stringify(props.config));
    next.model = defaultModel.value;
    next.scenes = Object.fromEntries(
      scenes.map(([key]) => [
        key,
        [...new Set(choices.value[key].filter(Boolean))],
      ]),
    );
    emit("saved", await props.api("/config", "PUT", next));
    emit("notice", "场景模型已保存");
  } catch (e) {
    emit("error", e.message);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="card">
    <div class="section-heading">
      <h3>场景模型</h3>
      <button class="primary" :disabled="busy" @click="save">保存场景</button>
    </div>
    <label class="default-model"
      >默认模型<select v-model="defaultModel">
        <option value="">请选择模型</option>
        <option
          v-if="defaultModel && !entries.some((m) => m.id === defaultModel)"
          :value="defaultModel"
        >
          {{ defaultModel }}（暂不可用）
        </option>
        <option v-for="m in entries" :key="m.id" :value="m.id">
          {{ m.name }}
        </option>
      </select></label
    >
    <p v-if="!entries.length" class="hint">先添加服务商并获取模型。</p>
    <div class="scene-grid">
      <article v-for="[key, label] in scenes" :key="key" class="scene-item">
        <h3>{{ label }}</h3>
        <p v-if="key === 'lightweight'" class="hint">新任务从这里起步；留空时使用默认模型。</p>
        <p v-else-if="key === 'coding'" class="hint">实际进入编码工作时才升级；同一任务续做保持已选模型。</p>
        <div v-for="(selection, n) in choices[key]" :key="n" class="scene-row">
          <span class="hint">{{ n + 1 }}</span
          ><select
            v-model="choices[key][n]"
            :aria-label="label + '模型' + (n + 1)"
          >
            <option value="">选择模型</option>
            <option
              v-if="selection && !entries.some((m) => m.id === selection)"
              :value="selection"
            >
              {{ selection }}（暂不可用）
            </option>
            <option
              v-for="m in entries.filter((m) => key !== 'computer' || m.images)"
              :key="m.id"
              :value="m.id"
            >
              {{ m.name }}
            </option></select
          ><button
            class="icon"
            :disabled="n === 0"
            @click="move(key, n, -1)"
            :aria-label="'上移' + label + '模型'"
          >
            ↑</button
          ><button
            class="icon"
            :disabled="n === choices[key].length - 1"
            @click="move(key, n, 1)"
            :aria-label="'下移' + label + '模型'"
          >
            ↓</button
          ><button
            class="icon"
            @click="choices[key].splice(n, 1)"
            :aria-label="'移除' + label + '模型'"
          >
            ×
          </button>
        </div>
        <button @click="choices[key].push('')">
          ＋ {{ choices[key].length ? "备用模型" : "选择模型" }}
        </button>
        <p v-if="key === 'computer'" class="hint">仅显示支持图片的模型</p>
        <p v-else-if="choices[key].length > 1" class="hint">
          优先使用排在前面的模型
        </p>
      </article>
    </div>
  </section>
</template>
<style scoped>
.default-model {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 18px;
}
.scene-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.scene-item {
  min-width: 0;
  padding: 16px;
  background: #f9fafc;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.scene-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.scene-row select {
  flex: 1;
  min-width: 0;
}
.scene-item > p {
  margin: 8px 0 0;
}
.scene-row .icon {
  font-size: 16px;
  padding: 5px;
}
.scene-item h3 {
  margin-bottom: 10px;
}
@media (max-width: 760px) {
  .scene-row {
    display: grid;
    grid-template-columns: 24px repeat(3, minmax(44px, 1fr));
    gap: 8px;
  }
  .scene-row select {
    grid-column: 2/-1;
    grid-row: 1;
    width: 100%;
  }
  .scene-row .icon:first-of-type {
    grid-column: 2;
  }
  .scene-item {
    padding: 12px;
    min-width: 0;
  }
}
</style>
