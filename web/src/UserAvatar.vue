<script setup vapor>
import { computed, ref, watch } from "vue";
import { userAvatarURL } from "../../shared/employee-avatars";
// A user's uploaded avatar, or their initial.
const props = defineProps({ userId: String, avatar: String, name: String });
const failed = ref(false);
const url = computed(() => userAvatarURL(props.userId, props.avatar));
watch(url, () => { failed.value = false; });
</script>
<template>
  <span class="user-picture"><img v-if="url && !failed" :src="url" alt="" @error="failed = true" /><span v-else aria-hidden="true">{{ String(name || "?").slice(0, 1).toUpperCase() }}</span></span>
</template>
<style scoped>
.user-picture { display: grid; place-items: center; width: 100%; height: 100%; overflow: hidden; border-radius: inherit; background: var(--accent-soft); color: var(--accent-text); font-weight: 600; font-size: .9em; }
.user-picture img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>
