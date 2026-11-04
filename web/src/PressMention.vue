<script setup vapor>
import { longPress } from "./long-press.js";
// Wraps an avatar: long-press emits `press` with the name (to @ it); a tap still reaches the parent's click.
const props = defineProps({ name: String, disabled: Boolean });
const emit = defineEmits(["press"]);
const press = longPress(() => emit("press", props.name));
function down(event) { if (!props.disabled) press.down(event); }
function menu(event) { if (props.disabled) return; event.preventDefault(); press.menu(); }
function click(event) { if (press.consumed()) { event.preventDefault(); event.stopPropagation(); } }
</script>
<template>
  <span class="press-mention" :class="{ on: !disabled }" @touchstart.passive="down" @touchmove.passive="press.move" @touchend="press.end" @touchcancel="press.cancel"
    @mousedown="down" @mousemove="press.move" @mouseup="press.cancel" @mouseleave="press.cancel" @contextmenu="menu" @click="click"><slot /></span>
</template>
<style scoped>
.press-mention { display: grid; place-items: center; width: 100%; height: 100%; }
/* No image menu, drag, callout or selection stealing the long-press. */
.press-mention.on { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
.press-mention.on :deep(img), .press-mention.on :deep(svg) { pointer-events: none; -webkit-user-drag: none; user-select: none; }
</style>
