<script setup vapor>
import { ref } from "vue";
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
  <section class="employee-avatar-picker" aria-label="员工头像" :aria-busy="busy">
    <div class="avatar-picker-heading"><span class="avatar-current" aria-hidden="true"><EmployeeAvatar :employee-id="employeeId" :name="name" :avatar="avatar" /></span><div><h4>员工头像</h4><p>选择星座，或上传自己的图片。修改后立即生效。</p><div class="avatar-picker-actions"><button type="button" :disabled="busy" @click="fileInput.click()">上传头像</button><button type="button" :disabled="busy || !avatar" @click="choose('')">恢复首字头像</button></div></div></div>
    <input ref="fileInput" type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传员工头像图片" :disabled="busy" @change="upload" />
    <div class="zodiac-avatar-grid" aria-label="12 星座头像"><button v-for="item in ZODIAC_AVATARS" :key="item.id" type="button" :class="{ selected: avatar === 'zodiac:' + item.id }" :aria-pressed="avatar === 'zodiac:' + item.id" :aria-label="'使用' + item.name + '头像'" :disabled="busy" @click="choose('zodiac:' + item.id)"><img :src="'/avatars/zodiac/' + item.id + '.webp'" alt="" loading="lazy" /><span>{{ item.name }}</span></button></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-else class="avatar-picker-hint">{{ busy ? '正在保存头像…' : '自定义图片会裁为正方形，GIF 取首帧；支持 PNG、JPEG、WebP、GIF，最大 5MiB。' }}</p>
  </section>
</template>
<style scoped>
.employee-avatar-picker { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); }
.avatar-picker-heading { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.avatar-current { display: grid; place-items: center; flex: none; width: 68px; height: 68px; border-radius: 18px; background: var(--accent-soft); color: var(--accent); font-size: 28px; font-weight: 650; }
.avatar-picker-heading h4 { margin: 0 0 4px; font-size: 14px; }
.avatar-picker-heading p { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.avatar-picker-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.avatar-picker-actions button { min-height: 36px; padding: 6px 10px; font-size: 12px; }
.zodiac-avatar-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.zodiac-avatar-grid button { display: grid; justify-items: center; gap: 6px; min-width: 0; padding: 7px 4px; border-radius: 10px; border: 1px solid transparent; background: var(--surface-sunken); color: var(--text-secondary); }
.zodiac-avatar-grid button.selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent); }
.zodiac-avatar-grid img { width: 48px; max-width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; }
.zodiac-avatar-grid span { font-size: 11px; white-space: nowrap; }
.avatar-picker-hint { margin: 12px 0 0; font-size: 11px; color: var(--muted); }
@media (max-width: 520px) { .employee-avatar-picker { padding: 12px; } .avatar-picker-heading { align-items: flex-start; gap: 10px; } .avatar-current { width: 54px; height: 54px; border-radius: 14px; } .zodiac-avatar-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; } .zodiac-avatar-grid img { width: 44px; } .avatar-picker-actions button { min-height: 44px; } }
</style>
