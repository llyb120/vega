<script setup vapor>
import Icon from "./Icon.vue";
import { ref, watch } from "vue";
const props = defineProps({ api: Function, config: Object });
const emit = defineEmits(["saved", "error", "notice"]);
const busy = ref(false);
const globalSlots = ref(3);
const perEmployeeSlots = ref(3);
watch(
  () => props.config,
  () => {
    globalSlots.value = props.config?.scheduler?.globalSlots ?? 3;
    perEmployeeSlots.value = props.config?.scheduler?.perEmployeeSlots ?? 3;
  },
  { immediate: true },
);
async function save() {
  busy.value = true;
  try {
    const next = JSON.parse(JSON.stringify(props.config || {}));
    delete next.model;
    next.scheduler = {
      globalSlots: Number(globalSlots.value),
      perEmployeeSlots: Number(perEmployeeSlots.value),
    };
    emit("saved", await props.api("/config", "PUT", next));
    emit("notice", "调度并发已保存");
  } catch (e) {
    emit("error", e.message);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="card">
    <div class="card-head row">
      <div>
        <h3>任务调度并发</h3>
        <p class="hint">限制同时执行的任务数。全站上限与单牛马上限同时生效；默认各为 3。</p>
      </div>
      <button class="primary sm" :disabled="busy" @click="save">保存</button>
    </div>
    <div class="slot-grid">
      <label class="slot-field">
        <span>全站同时执行上限</span>
        <input type="number" min="1" max="64" step="1" v-model.number="globalSlots" />
        <span class="hint">任意时刻全站最多这么多任务在跑</span>
      </label>
      <label class="slot-field">
        <span>单牛马同时执行上限</span>
        <input type="number" min="1" max="64" step="1" v-model.number="perEmployeeSlots" />
        <span class="hint">同一牛马最多同时跑这么多（电脑类仍限 1 个）</span>
      </label>
    </div>
    <p class="callout info"><Icon name="alert" :size="14" /><span>改大可减少「排队像调度慢」；过大可能把模型和浏览器打满。电脑任务仍受桌面空闲/接管规则约束。</span></p>
  </section>
</template>
<style scoped>
.slot-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
.slot-field { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.slot-field input { width: 100%; min-height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
@media (max-width: 699px) { .slot-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
