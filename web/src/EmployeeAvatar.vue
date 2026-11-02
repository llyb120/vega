<script setup vapor>
import { computed, ref, watch } from "vue";
import { defaultBotAvatar, employeeAvatarURL, parseBotAvatar } from "../../shared/employee-avatars";
import BotAvatar from "./BotAvatar.vue";
const props = defineProps({ employeeId: String, avatar: String, name: String, pose: String, animate: Boolean });
const emit = defineEmits(["pose"]);
const failed = ref(false);
const url = computed(() => employeeAvatarURL(props.employeeId, props.avatar));
// Bot presets render inline; an empty (default) avatar, or an image that fails to load, gets a stable bot of its own.
const bot = computed(() => parseBotAvatar(props.avatar) || defaultBotAvatar(props.employeeId || props.name || ""));
watch(url, () => { failed.value = false; });
</script>
<template>
  <span :class="['employee-picture', { 'is-bot': !url || failed }]"><img v-if="url && !failed" :src="url" alt="" @error="failed = true" /><BotAvatar v-else :shape="bot.shape" :hex="bot.hex" :pose="pose" :animate="animate" @pose="emit('pose', $event)" /></span>
</template>
<style scoped>
.employee-picture { display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; border-radius: inherit; }
.employee-picture.is-bot { overflow: visible; }
.employee-picture img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>
