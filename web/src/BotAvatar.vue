<script setup vapor>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { BOT_POSES, BOT_SHAPE_GEOMETRY, MESSAGE_POSE, blinkPlan, holdDuration, nextPose, projectFace, shade } from "./bot-avatar.js";
// `from`: render this pose first, then turn into `pose` (used when the typing row turns into the reply).
const props = defineProps({ shape: String, hex: String, pose: { type: String, default: MESSAGE_POSE }, from: String, animate: Boolean });
const emit = defineEmits(["pose"]);
const geometry = computed(() => BOT_SHAPE_GEOMETRY[props.shape] || BOT_SHAPE_GEOMETRY.round);
const color = computed(() => props.hex || "#7c7c84");
const uid = "bot" + Math.random().toString(36).slice(2, 9);

// Head state: yaw/pitch in degrees, driven by a slightly under-damped spring toward a target (small overshoot),
// with a short anticipation dip before each turn; `lid` closes for blinks independently of the turn.
const start = BOT_POSES[props.from || props.pose] || BOT_POSES[MESSAGE_POSE];
const head = ref({ yaw: start.yaw, pitch: start.pitch, lid: 1 });
const look = ref(props.from || props.pose);
const face = computed(() => projectFace(geometry.value, head.value.yaw, head.value.pitch, head.value.lid));
let target = { ...start }, velocity = { yaw: 0, pitch: 0 }, anticipate = 0, frame = 0, last = 0, blinkAt = [];
const root = ref(null), playing = ref(false);
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function turnTo(pose, { jitter = 0, prepare = false } = {}) {
  const base = BOT_POSES[pose] || BOT_POSES.center, amp = 1 + (Math.random() - 0.5) * jitter;
  look.value = pose;
  target = { yaw: base.yaw * amp + (Math.random() - 0.5) * jitter * 8, pitch: base.pitch * amp + (Math.random() - 0.5) * jitter * 6 };
  if (reduced()) { head.value = { ...head.value, ...target }; return; }
  if (prepare) anticipate = 90; // ms of a small move the other way before the turn
  run();
}
function lidAt(now) {
  // close 70ms, hold 25ms, open 110ms; a double blink queues a second one right after
  while (blinkAt.length && now - blinkAt[0] > 205) blinkAt.shift();
  if (!blinkAt.length || now < blinkAt[0]) return 1;
  const t = now - blinkAt[0];
  return t < 70 ? 1 - (t / 70) ** 2 * 0.95 : t < 95 ? 0.05 : 0.05 + 0.95 * (1 - (1 - (t - 95) / 110) ** 2);
}
function tick(now) {
  frame = 0;
  const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
  const goal = anticipate > 0 ? { yaw: head.value.yaw - (target.yaw - head.value.yaw) * 0.12, pitch: head.value.pitch - (target.pitch - head.value.pitch) * 0.12 } : target;
  anticipate -= dt * 1000;
  let { yaw, pitch } = head.value;
  for (const key of ["yaw", "pitch"]) {
    const value = key === "yaw" ? yaw : pitch, accel = 150 * (goal[key] - value) - 15 * velocity[key];
    velocity[key] += accel * dt;
    if (key === "yaw") yaw += velocity.yaw * dt; else pitch += velocity.pitch * dt;
  }
  const lid = lidAt(now);
  head.value = { yaw, pitch, lid };
  const settled = Math.abs(target.yaw - yaw) < 0.05 && Math.abs(target.pitch - pitch) < 0.05 && Math.abs(velocity.yaw) + Math.abs(velocity.pitch) < 0.1 && anticipate <= 0;
  if (settled && !blinkAt.length && !playing.value) { head.value = { ...target, lid: 1 }; last = 0; return; }
  run();
}
function run() { if (!frame && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick); }

let lookTimer = 0, blinkTimer = 0, previous, onScreen = true, observer, following = false;
function glance() {
  if (!playing.value || following) return;
  const next = nextPose(look.value, previous);
  previous = look.value;
  turnTo(next, { jitter: 0.35, prepare: Math.random() < 0.7 });
  emit("pose", next);
  lookTimer = setTimeout(glance, holdDuration());
}
function blink() {
  if (!playing.value) return;
  const { delay, double } = blinkPlan();
  blinkTimer = setTimeout(() => {
    const now = performance.now();
    blinkAt.push(now);
    if (double) blinkAt.push(now + 260);
    run();
    blink();
  }, delay);
}
function stop() { clearTimeout(lookTimer); clearTimeout(blinkTimer); playing.value = false; }
/** Play only while asked to and on screen; otherwise turn back to the resting pose. Each avatar has its own random timeline. */
function sync() {
  const play = props.animate && onScreen && !reduced();
  if (play === playing.value) return;
  stop();
  if (play) { playing.value = true; previous = undefined; lookTimer = setTimeout(glance, Math.random() * 300); blink(); run(); }
  else turnTo(props.pose);
}
watch(() => props.animate, sync);
watch(() => props.pose, (pose) => { if (!props.animate) turnTo(pose); });
onMounted(() => {
  // Many replies can point at running tasks: pause the ones scrolled out of view.
  if (typeof IntersectionObserver === "function" && root.value) {
    observer = new IntersectionObserver((entries) => { onScreen = entries.at(-1).isIntersecting; sync(); });
    observer.observe(root.value);
  }
  if (props.animate) return sync();
  // Turn from the typing row's last pose into the resting pose after the first paint.
  if (props.from && props.from !== props.pose) requestAnimationFrame(() => turnTo(props.pose));
});
function lookAtPointer(event) {
  if (!root.value || reduced()) return;
  const box = root.value.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2);
  const dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2);
  target = {
    yaw: Math.max(-36, Math.min(36, dx * 28)),
    pitch: Math.max(-24, Math.min(26, -dy * 22)),
  };
  look.value = "pointer";
  run();
}
function onPointerEnter(event) {
  following = true;
  clearTimeout(lookTimer);
  lookAtPointer(event);
}
function onPointerMove(event) {
  if (following) lookAtPointer(event);
}
function onPointerLeave() {
  following = false;
  if (playing.value) lookTimer = setTimeout(glance, 240);
  else turnTo(props.pose);
}
onBeforeUnmount(() => { stop(); if (frame) cancelAnimationFrame(frame); observer?.disconnect(); });
</script>
<template>
  <svg ref="root" :class="['bot-avatar', { animate: playing }]" :data-playing="playing ? '' : undefined" viewBox="0 0 100 100" role="img" aria-hidden="true" :data-shape="geometry === BOT_SHAPE_GEOMETRY[shape] ? shape : 'round'" :data-pose="look" :data-color="color" @pointerenter="onPointerEnter" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
    <defs>
      <radialGradient :id="uid + 'b'" gradientUnits="userSpaceOnUse" :cx="face.light.x" :cy="face.light.y" r="62" :fx="face.light.x" :fy="face.light.y">
        <stop offset="0" :stop-color="shade(color, 0.32)" /><stop offset="0.42" :stop-color="color" /><stop offset="0.8" :stop-color="shade(color, -0.22)" /><stop offset="1" :stop-color="shade(color, -0.42)" />
      </radialGradient>
      <radialGradient :id="uid + 'h'"><stop offset="0" stop-color="#fff" stop-opacity=".55" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></radialGradient>
      <radialGradient :id="uid + 's'"><stop offset="0" stop-color="#000" stop-opacity=".32" /><stop offset="1" stop-color="#000" stop-opacity="0" /></radialGradient>
      <clipPath :id="uid + 'c'"><path :d="geometry.d" /></clipPath>
    </defs>
    <ellipse class="bot-shadow" :cx="face.shadow.x" cy="93.5" :rx="face.shadow.rx" ry="4.5" :fill="`url(#${uid}s)`" :opacity="face.shadow.opacity" />
    <g class="bot-body"><g transform="translate(50 50) scale(.9) translate(-50 -50)"><g :transform="face.body">
      <path :d="geometry.d" :fill="`url(#${uid}b)`" />
      <g :clip-path="`url(#${uid}c)`"><ellipse :cx="face.highlight.x" :cy="face.highlight.y" rx="17" ry="12" :fill="`url(#${uid}h)`" transform-origin="50 50" /></g>
      <ellipse class="bot-eye" :cx="face.left.cx" :cy="face.left.cy" :rx="face.left.rx" :ry="face.left.ry" :opacity="face.left.opacity" />
      <ellipse class="bot-eye" :cx="face.right.cx" :cy="face.right.cy" :rx="face.right.rx" :ry="face.right.ry" :opacity="face.right.opacity" />
    </g></g></g>
  </svg>
</template>
<style scoped>
.bot-avatar { display: block; width: 100%; height: 100%; overflow: visible; }
.bot-eye { fill: #fff; }
.bot-body { transform-origin: 50% 90%; }
.animate .bot-body { animation: bot-bob 1.8s ease-in-out infinite; }
@keyframes bot-bob { 0%, 100% { transform: translateY(0) scale(1, 1); } 45% { transform: translateY(-2px) scale(.99, 1.015); } }
@media (prefers-reduced-motion: reduce) { .animate .bot-body { animation: none; } }
</style>
