<script setup vapor>
import { inject } from "vue";
import Icon from "./Icon.vue";
defineProps({ title: String, subtitle: String, back: String });
const emit = defineEmits(["back"]);
const openNavigation = inject("openNavigation", null);
</script>
<template>
  <header class="topbar page-header">
    <button v-if="openNavigation" type="button" class="icon page-menu" data-nav-trigger aria-label="打开导航" @click="openNavigation()"><Icon name="menu" /></button>
    <button v-if="back" type="button" class="ghost sm page-back" @click="emit('back')"><Icon name="back" :size="16" />{{ back }}</button>
    <div class="page-title">
      <h2 class="truncate">{{ title }}<slot name="title-extra"></slot></h2>
      <p v-if="subtitle" class="truncate">{{ subtitle }}</p>
    </div>
    <div class="actions"><slot></slot></div>
  </header>
</template>
<style scoped>
.page-header { gap: 8px; }
.page-menu { display: none; margin-left: -6px; }
.page-title { display: grid; flex: 1; min-width: 0; }
.page-title h2 { display: flex; align-items: center; gap: 8px; }
.page-back { margin-left: -6px; color: var(--text-2); }
.actions { flex: none; flex-wrap: nowrap; }
@media (max-width: 767px) {
  .page-menu { display: inline-flex; }
  .page-back { padding: 0 6px; }
}
</style>
