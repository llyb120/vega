<script setup vapor>
import { computed } from "vue";
import EmployeeAvatar from "./EmployeeAvatar.vue";
import UserAvatar from "./UserAvatar.vue";
import { groupTiles } from "./group.js";
// The composite avatar of a group: its members' avatars in a grid, the 群主 first.
const props = defineProps({ group: Object });
const layout = computed(() => groupTiles(props.group));
</script>
<template>
  <span class="group-avatar" :style="{ gridTemplateColumns: `repeat(${layout.cols}, 1fr)` }" :data-cols="layout.cols" aria-hidden="true">
    <span v-for="tile in layout.tiles" :key="tile.kind + tile.id" class="tile">
      <UserAvatar v-if="tile.kind === 'user'" :user-id="tile.id" :name="tile.name" :avatar="tile.avatar" />
      <EmployeeAvatar v-else :employee-id="tile.id" :name="tile.name" :avatar="tile.avatar" />
    </span>
  </span>
</template>
<style scoped>
.group-avatar { display: grid; align-content: center; gap: 1px; width: 100%; height: 100%; padding: 2px; overflow: hidden; border-radius: inherit; background: var(--surface-3, #e5e7eb); box-sizing: border-box; }
.tile { display: grid; aspect-ratio: 1; min-width: 0; overflow: hidden; border-radius: 2px; background: var(--surface, #fff); font-size: 9px; }
.group-avatar[data-cols="1"] .tile { font-size: inherit; border-radius: inherit; }
.tile :deep(.employee-picture.is-bot) { overflow: hidden; }
</style>
