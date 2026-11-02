<script setup vapor>
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import BotAvatar from "./BotAvatar.vue";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, botAvatarPreset, defaultBotAvatar, parseBotAvatar } from "../../shared/employee-avatars";
const props = defineProps({ api: Function, employeeId: String, avatar: String, name: String });
const emit = defineEmits(["change"]);
const busy = ref(false), error = ref(""), fileInput = ref(null);
// The color row and shape grid edit one `bot:<shape>:<color>` preset; start from the current bot (or the default one).
const current = computed(() => parseBotAvatar(props.avatar));
const draft = computed(() => current.value || defaultBotAvatar(props.employeeId || props.name || ""));
const colorHex = computed(() => BOT_AVATAR_COLORS.find(color => color.id === draft.value.color)?.hex);
async function save(payload) {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { emit("change", await props.api(`/employees/${props.employeeId}/avatar`, "POST", payload)); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
async function choose(preset) { if ((props.avatar || "") !== preset) await save({ preset }); }
const pickShape = shape => choose(botAvatarPreset(shape, draft.value.color));
const pickColor = color => choose(botAvatarPreset(draft.value.shape, color));
async function upload(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 5 * 1024 * 1024) { error.value = "请使用 5MiB 以内的 PNG、JPEG、WebP 或 GIF 图片"; return; }
  busy.value = true;
  try {
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = () => reject(Error("读取头像失败")); reader.readAsDataURL(file); });
    busy.value = false;
    await save({ mime: file.type, data });
  } catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="card avatar-picker" aria-label="牛马头像" :aria-busy="busy">
    <div class="avatar-head">
      <span class="avatar-current" aria-hidden="true"><EmployeeAvatar :employee-id="employeeId" :name="name" :avatar="avatar" /></span>
      <div class="avatar-text"><h3>头像</h3><p class="hint">选一个形状和颜色，或上传自己的图片，立即生效。</p></div>
    </div>
    <div class="color-row" role="group" aria-label="头像颜色"><button v-for="color in BOT_AVATAR_COLORS" :key="color.id" type="button" :class="['swatch', { selected: current?.color === color.id }]" :style="{ '--swatch': color.hex }" :aria-pressed="current?.color === color.id" :aria-label="'使用' + color.name" :title="color.name" :disabled="busy" @click="pickColor(color.id)"></button></div>
    <div class="shape-grid" role="group" aria-label="头像形状"><button v-for="shape in BOT_AVATAR_SHAPES" :key="shape.id" type="button" :class="{ selected: current?.shape === shape.id }" :aria-pressed="current?.shape === shape.id" :aria-label="'使用' + shape.name + '形状'" :title="shape.name" :disabled="busy" @click="pickShape(shape.id)"><BotAvatar :shape="shape.id" :hex="current?.shape === shape.id ? colorHex : (current ? '#a3a3aa' : colorHex)" /></button></div>
    <div class="avatar-actions"><button type="button" class="sm" :disabled="busy" @click="fileInput.click()"><Icon name="image" :size="14" />上传图片</button><button type="button" class="sm ghost" :disabled="busy || !avatar" @click="choose('')">恢复默认头像</button></div>
    <input ref="fileInput" type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传牛马头像图片" :disabled="busy" @change="upload" />
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-else class="hint foot">{{ busy ? '正在保存头像…' : '自定义图片会裁为正方形，GIF 取首帧；支持 PNG、JPEG、WebP、GIF，最大 5MiB。' }}</p>
  </section>
</template>
<style scoped>
.avatar-head { display: flex; align-items: center; gap: 12px; }
.avatar-current { display: grid; place-items: center; flex: none; width: 52px; height: 52px; overflow: hidden; border-radius: 14px; background: var(--accent-soft); color: var(--accent-text); font-size: 22px; font-weight: 600; }
.avatar-text h3 { font-size: 14px; }
.color-row { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 6px 4px; margin: 14px 0 12px; }
.swatch { justify-self: center; width: 28px; height: 28px; min-height: 0; padding: 0; border: 0; border-radius: 50%; background: var(--swatch); box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08); }
.swatch.selected { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--swatch); }
.shape-grid { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 6px; }
.shape-grid button { height: auto; min-height: 0; aspect-ratio: 1; padding: 7px; border: 2px solid transparent; border-radius: 12px; background: var(--surface-2); }
.shape-grid button:hover { background: var(--accent-soft); }
.shape-grid button.selected { border-color: var(--accent); background: var(--accent-soft); }
.avatar-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 0; }
.foot { margin-top: 10px; font-size: 11px; }
@media (max-width: 560px) {
  .color-row { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px 4px; }
  .shape-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
}
</style>
