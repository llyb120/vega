<script setup vapor>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { BOT_POSES, BOT_SHAPE_GEOMETRY, DEFAULT_EYES, blinkPlan, holdDuration, nextPose } from "./bot-avatar.js";
// `from`: render this pose first, then ease into `pose` (used when the typing row turns into the reply).
const props = defineProps({ shape: String, hex: String, pose: { type: String, default: "center" }, from: String, animate: Boolean });
const emit = defineEmits(["pose"]);
const geometry = computed(() => BOT_SHAPE_GEOMETRY[props.shape] || BOT_SHAPE_GEOMETRY.round);
const eyes = computed(() => ({ ...DEFAULT_EYES, ...geometry.value.eyes }));
// While animating, `look` wanders between random poses on one timer and `blinking` overlays blinks on another,
// so glances, hold times and blinks never line up into a fixed sequence.
const look = ref(props.from || props.pose), blinking = ref(false);
const shown = computed(() => BOT_POSES[blinking.value ? "blink" : look.value] || BOT_POSES.center);
// Head turn: the whole face drifts a little toward the look and narrows as if rotating, while the eyes move
// further than the body, which reads as a 3D turn even at chat size.
const headStyle = computed(() => {
  const pose = shown.value, x = (pose.l.x + pose.r.x) / 2, y = (pose.l.y + pose.r.y) / 2;
  return { transform: `translate(${x * 0.45}px, ${y * 0.35}px) scale(${1 - Math.abs(x) * 0.007}, 1) skewY(${x * 0.35}deg)` };
});
const eyeStyle = side => { const pose = shown.value[side]; return { transform: `translate(${pose.x}px, ${pose.y}px) scale(${pose.sx}, ${pose.sy})` }; };
let lookTimer = 0, blinkTimer = 0, previous, onScreen = true, observer;
const root = ref(null), playing = ref(false);
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function glance() {
  if (!playing.value) return;
  const next = nextPose(look.value, previous);
  previous = look.value; look.value = next;
  emit("pose", next);
  lookTimer = setTimeout(glance, holdDuration());
}
function blink() {
  if (!playing.value) return;
  const { delay, double } = blinkPlan();
  blinkTimer = setTimeout(() => {
    blinking.value = true;
    setTimeout(() => {
      blinking.value = false;
      if (!double) return blink();
      setTimeout(() => { blinking.value = true; setTimeout(() => { blinking.value = false; blink(); }, 110); }, 140);
    }, 120);
  }, delay);
}
function stop() { clearTimeout(lookTimer); clearTimeout(blinkTimer); blinking.value = false; playing.value = false; }
/** Play only while asked to and on screen; otherwise ease back to the resting pose. Every avatar draws its own random timeline. */
function sync() {
  const play = props.animate && onScreen && !reduced();
  if (play === playing.value) return;
  stop();
  if (play) { playing.value = true; previous = undefined; lookTimer = setTimeout(glance, Math.random() * 250); blink(); }
  else look.value = props.pose;
}
watch(() => props.animate, sync);
watch(() => props.pose, (pose) => { if (!props.animate) look.value = pose; });
onMounted(() => {
  // Many replies can point at running tasks: pause the ones scrolled out of view.
  if (typeof IntersectionObserver === "function" && root.value) {
    observer = new IntersectionObserver((entries) => { onScreen = entries.at(-1).isIntersecting; sync(); });
    observer.observe(root.value);
  }
  if (props.animate) return sync();
  // Ease from the typing row's last glance into the resting pose after the first paint.
  if (props.from && props.from !== props.pose) requestAnimationFrame(() => requestAnimationFrame(() => { look.value = props.pose; }));
});
onBeforeUnmount(() => { stop(); observer?.disconnect(); });
</script>
<template>
  <svg ref="root" :class="['bot-avatar', { animate: playing }]" :data-playing="playing ? '' : undefined" viewBox="0 0 100 100" role="img" aria-hidden="true" :data-shape="geometry === BOT_SHAPE_GEOMETRY[shape] ? shape : 'round'" :data-pose="blinking ? 'blink' : look">
    <g class="bot-body"><g class="bot-head" :style="headStyle"><path :d="geometry.d" :fill="hex || '#7c7c84'" /><ellipse class="bot-eye" :cx="eyes.x - eyes.gap" :cy="eyes.y" :rx="eyes.rx" :ry="eyes.ry" :style="eyeStyle('l')" /><ellipse class="bot-eye" :cx="eyes.x + eyes.gap" :cy="eyes.y" :rx="eyes.rx" :ry="eyes.ry" :style="eyeStyle('r')" /></g></g>
  </svg>
</template>
<style scoped>
.bot-avatar { display: block; width: 100%; height: 100%; overflow: visible; }
.bot-eye { fill: #fff; transform-box: fill-box; transform-origin: center; transition: transform .16s cubic-bezier(.3, .7, .4, 1); }
.bot-body { transform-origin: 50% 90%; }
.bot-head { transform-box: fill-box; transform-origin: center; transition: transform .22s cubic-bezier(.3, .7, .4, 1); }
.animate .bot-body { animation: bot-bob 1.6s ease-in-out infinite; }
@keyframes bot-bob { 0%, 100% { transform: translateY(0) scale(1, 1); } 45% { transform: translateY(-2.5px) scale(.985, 1.02); } }
@media (prefers-reduced-motion: reduce) { .bot-eye, .bot-head { transition: none; } .animate .bot-body { animation: none; } }
</style>
