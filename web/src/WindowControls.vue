<script setup vapor>
import Icon from "./Icon.vue";
import { desktopMode, windowMinimise, windowToggleMaximise, windowClose } from "./desktop.js";
const props = defineProps({
  // When true, this cluster is a floating overlay in the window corner.
  floating: Boolean,
});
</script>
<template>
  <div v-if="desktopMode" class="window-controls" :class="{ floating }" role="group" aria-label="窗口控制">
    <button type="button" class="win-btn" aria-label="最小化" title="最小化" @click="windowMinimise()"><Icon name="minus" :size="14" /></button>
    <button type="button" class="win-btn" aria-label="最大化" title="最大化" @click="windowToggleMaximise()"><Icon name="maximize" :size="13" /></button>
    <button type="button" class="win-btn close" aria-label="关闭" title="关闭" @click="windowClose()"><Icon name="close" :size="14" /></button>
  </div>
</template>
<style scoped>
.window-controls { display: flex; align-items: stretch; flex: none; height: 40px; --wails-draggable: no-drag; }
.window-controls.floating { position: fixed; top: var(--app-top, 0px); right: 0; z-index: 80; height: 48px; padding-right: 6px; }
.win-btn { width: 40px; min-height: 0; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--text-2); }
.win-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
.win-btn.close:hover:not(:disabled) { background: #e81123; color: #fff; }
</style>
