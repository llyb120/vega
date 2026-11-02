<script setup vapor>
import { ref } from "vue";
import Icon from "./Icon.vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import { ZODIAC_AVATARS } from "../../shared/employee-avatars";
const props = defineProps({ api: Function, employeeId: String, avatar: String, name: String });
const emit = defineEmits(["change"]);
const busy = ref(false), error = ref(""), fileInput = ref(null);
async function save(payload) {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { emit("change", await props.api(`/employees/${props.employeeId}/avatar`, "POST", payload)); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
async function choose(preset) { if ((props.avatar || "") !== preset) await save({ preset }); }
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
  <section class="card avatar-picker" aria-label="员工头像" :aria-busy="busy">
    <div class="avatar-head">
      <span class="avatar-current" aria-hidden="true"><EmployeeAvatar :employee-id="employeeId" :name="name" :avatar="avatar" /></span>
      <div class="avatar-text"><h3>头像</h3><p class="hint">选择星座，或上传自己的图片，立即生效。</p></div>
    </div>
    <div class="avatar-actions"><button type="button" class="sm" :disabled="busy" @click="fileInput.click()"><Icon name="image" :size="14" />上传图片</button><button type="button" class="sm ghost" :disabled="busy || !avatar" @click="choose('')">恢复首字头像</button></div>
    <input ref="fileInput" type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传员工头像图片" :disabled="busy" @change="upload" />
    <div class="zodiac-grid" aria-label="12 星座头像"><button v-for="item in ZODIAC_AVATARS" :key="item.id" type="button" :class="{ selected: avatar === 'zodiac:' + item.id }" :aria-pressed="avatar === 'zodiac:' + item.id" :aria-label="'使用' + item.name + '头像'" :title="item.name" :disabled="busy" @click="choose('zodiac:' + item.id)"><img :src="'/avatars/zodiac/' + item.id + '.webp'" alt="" loading="lazy" /></button></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-else class="hint foot">{{ busy ? '正在保存头像…' : '自定义图片会裁为正方形，GIF 取首帧；支持 PNG、JPEG、WebP、GIF，最大 5MiB。' }}</p>
  </section>
</template>
<style scoped>
.avatar-head { display: flex; align-items: center; gap: 12px; }
.avatar-current { display: grid; place-items: center; flex: none; width: 52px; height: 52px; overflow: hidden; border-radius: 14px; background: var(--accent-soft); color: var(--accent-text); font-size: 22px; font-weight: 600; }
.avatar-text h3 { font-size: 14px; }
.avatar-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; }
.zodiac-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; }
.zodiac-grid button { height: auto; aspect-ratio: 1; padding: 3px; border: 2px solid transparent; border-radius: 10px; background: var(--surface-2); }
.zodiac-grid button.selected { border-color: var(--accent); background: var(--accent-soft); }
.zodiac-grid img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 7px; }
.foot { margin-top: 10px; font-size: 11px; }
</style>
