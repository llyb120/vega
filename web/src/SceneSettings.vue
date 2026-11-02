<script setup vapor>
import Icon from "./Icon.vue";
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
    <div class="card-head row"><div><h3>场景模型</h3><p class="hint">为不同场景排列候选模型，排在前面的优先使用。</p></div><button class="primary sm" :disabled="busy" @click="save">保存场景</button></div>
    <label class="default-model">默认模型<select v-model="defaultModel">
      <option value="">请选择模型</option>
      <option v-if="defaultModel && !entries.some((m) => m.id === defaultModel)" :value="defaultModel">{{ defaultModel }}（暂不可用）</option>
      <option v-for="m in entries" :key="m.id" :value="m.id">{{ m.name }}</option>
    </select></label>
    <p v-if="!entries.length" class="callout info"><Icon name="alert" :size="14" /><span>先添加服务商并获取模型。</span></p>
    <div class="scene-grid">
      <article v-for="[key, label] in scenes" :key="key" class="scene-item">
        <header><h4>{{ label }}</h4><span class="hint">{{ choices[key].length ? choices[key].length + ' 个模型' : '使用默认模型' }}</span></header>
        <p v-if="key === 'lightweight'" class="hint">新任务从这里起步；留空时使用默认模型。</p>
        <p v-else-if="key === 'coding'" class="hint">实际进入编码工作时才升级；后续按需求继续编码或回到轻量，原任务历史不变。</p>
        <p v-else-if="key === 'computer'" class="hint">仅显示支持图片的模型。</p>
        <ol class="scene-rows">
          <li v-for="(selection, n) in choices[key]" :key="n" class="scene-row">
            <span class="scene-rank">{{ n + 1 }}</span>
            <select v-model="choices[key][n]" :aria-label="label + '模型' + (n + 1)">
              <option value="">选择模型</option>
              <option v-if="selection && !entries.some((m) => m.id === selection)" :value="selection">{{ selection }}（暂不可用）</option>
              <option v-for="m in entries.filter((m) => key !== 'computer' || m.images)" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select>
            <span class="row-actions">
              <button type="button" class="icon sm" :disabled="n === 0" :aria-label="'上移' + label + '模型'" @click="move(key, n, -1)"><Icon name="down" :size="14" class="flip" /></button>
              <button type="button" class="icon sm" :disabled="n === choices[key].length - 1" :aria-label="'下移' + label + '模型'" @click="move(key, n, 1)"><Icon name="down" :size="14" /></button>
              <button type="button" class="icon sm" :aria-label="'移除' + label + '模型'" @click="choices[key].splice(n, 1)"><Icon name="close" :size="14" /></button>
            </span>
          </li>
        </ol>
        <button type="button" class="sm ghost add-model" @click="choices[key].push('')"><Icon name="plus" :size="14" />{{ choices[key].length ? "备用模型" : "选择模型" }}</button>
      </article>
    </div>
  </section>
</template>
<style scoped>
.default-model { display: grid; gap: 6px; max-width: 420px; margin-bottom: 14px; }
.callout { margin-bottom: 14px; }
.scene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.scene-item { display: grid; align-content: start; gap: 8px; min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface-2); }
.scene-item header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.scene-item h4 { font-size: 13px; }
.scene-rows { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.scene-row { display: flex; align-items: center; gap: 6px; }
.scene-rank { display: grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 50%; background: var(--surface-3); color: var(--muted); font-size: 11px; font-weight: 600; }
.scene-row select { flex: 1; min-width: 0; background-color: var(--surface); }
.row-actions { display: flex; flex: none; }
.row-actions .icon { color: var(--muted); }
.flip { transform: rotate(180deg); }
.add-model { justify-self: start; color: var(--accent-text); }
@media (max-width: 767px) {
  .scene-grid { grid-template-columns: minmax(0, 1fr); }
  .scene-item { padding: 12px; }
}
</style>
