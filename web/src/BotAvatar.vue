<script setup vapor>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { BOT_POSES, BOT_SHAPE_GEOMETRY, DEFAULT_EYES, nextPose } from "./bot-avatar.js";
const props = defineProps({ shape: String, hex: String, pose: { type: String, default: "center" }, animate: Boolean });
const emit = defineEmits(["pose"]);
const geometry = computed(() => BOT_SHAPE_GEOMETRY[props.shape] || BOT_SHAPE_GEOMETRY.round);
const eyes = computed(() => ({ ...DEFAULT_EYES, ...geometry.value.eyes }));
// While animating, `look` cycles through poses; `blinking` overlays a quick blink without changing the look,
// so the pose reported for freezing is always a deliberate expression, never a half-closed blink.
const look = ref(props.pose), blinking = ref(false);
const shown = computed(() => BOT_POSES[blinking.value ? "blink" : look.value] || BOT_POSES.center);
const eyeStyle = side => { const pose = shown.value[side]; return { transform: `translate(${pose.x}px, ${pose.y}px) scale(${pose.sx}, ${pose.sy})` }; };
let timer = 0;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function schedule(delay) { clearTimeout(timer); timer = setTimeout(step, delay); }
function step() {
  if (!props.animate) return;
  if (!blinking.value && Math.random() < 0.22) { blinking.value = true; schedule(130); return; }
  blinking.value = false;
  look.value = nextPose(look.value);
  emit("pose", look.value);
  schedule(380 + Math.random() * 520);
}
function sync() {
  clearTimeout(timer); blinking.value = false;
  // Start each typing burst on a fresh glance, so even quick replies don't all freeze on the resting face.
  if (props.animate && !reduced()) { look.value = nextPose(props.pose); emit("pose", look.value); schedule(260 + Math.random() * 300); }
  else look.value = props.pose;
}
watch(() => props.animate, sync, { immediate: true });
// The parent mirrors the live pose back for freezing; only a still avatar follows its `pose` prop.
watch(() => props.pose, (pose) => { if (!props.animate) look.value = pose; });
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <svg :class="['bot-avatar', { animate }]" viewBox="0 0 100 100" role="img" aria-hidden="true" :data-shape="geometry === BOT_SHAPE_GEOMETRY[shape] ? shape : 'round'" :data-pose="blinking ? 'blink' : look">
    <g class="bot-body"><path :d="geometry.d" :fill="hex || '#7c7c84'" /><ellipse class="bot-eye" :cx="eyes.x - eyes.gap" :cy="eyes.y" :rx="eyes.rx" :ry="eyes.ry" :style="eyeStyle('l')" /><ellipse class="bot-eye" :cx="eyes.x + eyes.gap" :cy="eyes.y" :rx="eyes.rx" :ry="eyes.ry" :style="eyeStyle('r')" /></g>
  </svg>
</template>
<style scoped>
.bot-avatar { display: block; width: 100%; height: 100%; overflow: visible; }
.bot-eye { fill: #fff; transform-box: fill-box; transform-origin: center; transition: transform .16s cubic-bezier(.3, .7, .4, 1); }
.bot-body { transform-origin: 50% 90%; }
.animate .bot-body { animation: bot-bob 1.6s ease-in-out infinite; }
@keyframes bot-bob { 0%, 100% { transform: translateY(0) scale(1, 1); } 45% { transform: translateY(-2.5px) scale(.985, 1.02); } }
@media (prefers-reduced-motion: reduce) { .bot-eye { transition: none; } .animate .bot-body { animation: none; } }
</style>
