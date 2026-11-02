<script setup vapor>
import { computed, ref, watch } from "vue";
import { employeeAvatarURL } from "../../shared/employee-avatars";
const props = defineProps({ employeeId: String, avatar: String, name: String });
const failed = ref(false);
const url = computed(() => employeeAvatarURL(props.employeeId, props.avatar));
watch(url, () => { failed.value = false; });
</script>
<template>
  <span class="employee-picture"><img v-if="url && !failed" :src="url" alt="" @error="failed = true" /><span v-else>{{ name?.slice(0, 1) || '员' }}</span></span>
</template>
<style scoped>
.employee-picture { display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; border-radius: inherit; }
.employee-picture img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>
