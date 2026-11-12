<script setup vapor>
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import BotAvatar from "./BotAvatar.vue";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, botAvatarPreset, defaultBotAvatar } from "../../shared/employee-avatars";
const props = defineProps({ busy: Boolean, error: String });
const emit = defineEmits(["create", "cancel"]);
const name = ref("");
const seed = defaultBotAvatar("new-" + Date.now());
const shape = ref(seed.shape);
const color = ref(seed.color);
const hex = computed(() => BOT_AVATAR_COLORS.find((entry) => entry.id === color.value)?.hex || "#7c7c84");
const preset = computed(() => botAvatarPreset(shape.value, color.value));
function submit() {
  const text = name.value.trim();
  if (!text || props.busy) return;
  emit("create", { name: text, avatar: preset.value });
}
</script>
<template>
  <div class="dialog-root" @keydown.esc="emit('cancel')">
    <button type="button" class="dialog-backdrop" aria-label="关闭" @click="emit('cancel')"></button>
    <section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-bot-title">
      <header>
        <h2 id="create-bot-title">创建新牛马</h2>
        <button type="button" class="icon sm" aria-label="关闭" @click="emit('cancel')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="create-body">
        <span class="preview" aria-hidden="true"><BotAvatar :shape="shape" :hex="hex" /></span>
        <input v-model="name" type="text" maxlength="80" required placeholder="给你的牛马起个名字" autofocus @keydown.enter.prevent="submit" />
        <div class="shape-grid" role="group" aria-label="头像形状">
          <button v-for="item in BOT_AVATAR_SHAPES" :key="item.id" type="button" :class="{ selected: shape === item.id }" :aria-label="item.name" :title="item.name" @click="shape = item.id">
            <BotAvatar :shape="item.id" :hex="shape === item.id ? hex : '#c4c4c8'" />
          </button>
        </div>
        <div class="color-row" role="group" aria-label="头像颜色">
          <button v-for="item in BOT_AVATAR_COLORS" :key="item.id" type="button" :class="['swatch', { selected: color === item.id }]" :style="{ '--swatch': item.hex }" :aria-label="item.name" :title="item.name" @click="color = item.id"></button>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </div>
      <footer>
        <button type="button" class="ghost" :disabled="busy" @click="emit('cancel')">取消</button>
        <button type="button" class="primary" :disabled="busy || !name.trim()" @click="submit">{{ busy ? "正在创建…" : "创建" }}</button>
      </footer>
    </section>
  </div>
</template>
<style scoped>
.dialog-root { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 24px; }
.dialog-backdrop { position: absolute; inset: 0; border: 0; border-radius: 0; background: rgb(17 24 39 / 45%); }
.create-dialog { position: relative; display: flex; flex-direction: column; width: min(440px, 100%); max-height: min(720px, calc(100dvh - 48px)); overflow: hidden; border-radius: 20px; background: #fff; box-shadow: 0 24px 80px rgb(16 24 40 / 24%); }
header, footer { display: flex; align-items: center; flex: none; padding: 16px 20px; }
header { justify-content: space-between; }
header h2 { font-size: 16px; font-weight: 600; }
footer { justify-content: flex-end; gap: 8px; }
.create-body { display: grid; justify-items: center; gap: 16px; min-height: 0; overflow: auto; padding: 8px 28px 16px; }
.preview { display: grid; place-items: center; width: 120px; height: 120px; }
.preview :deep(.bot-avatar) { width: 120px; height: 120px; }
input { width: 100%; height: 42px; min-height: 42px; border-radius: 12px; background: var(--surface-2); border-color: transparent; text-align: center; }
.shape-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; width: 100%; }
.shape-grid button { height: auto; min-height: 0; aspect-ratio: 1; padding: 6px; border: 2px solid transparent; border-radius: 14px; background: transparent; }
.shape-grid button:hover { background: var(--surface-2); }
.shape-grid button.selected { border-color: var(--border-strong); background: var(--surface-2); }
.color-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; width: 100%; padding-bottom: 8px; }
.swatch { width: 28px; height: 28px; min-height: 28px; padding: 0; border: 0; border-radius: 50%; background: var(--swatch); box-shadow: inset 0 0 0 1px rgb(0 0 0 / 8%); }
.swatch.selected { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--swatch); }
</style>
