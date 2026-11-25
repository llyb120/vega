<script setup vapor>
import { computed, nextTick, ref, watch } from "vue";
import { caretOffset, filterMembers, filterTasks, insertMention, mentionQuery, moveActive, removeRange, taskHashQuery } from "./mention.js";
import { withMention } from "./long-press.js";
import { shortTime, taskLabel, taskTone } from "./task-status.js";
import { cleanTaskTitle } from "./conversation.js";
// A textarea with an @member picker and a #task reference picker.
// Keys the active picker does not use are re-emitted as `keydown` (e.g. Enter to send).
const props = defineProps({
  modelValue: String,
  members: { type: Array, default: () => [] },
  tasks: { type: Array, default: () => [] },
  rows: [Number, String],
  maxlength: [Number, String],
  placeholder: String,
  disabled: Boolean,
  autoGrow: { type: Boolean, default: false },
  ariaLabel: String,
});
const emit = defineEmits(["update:modelValue", "keydown", "pick-task"]);
const box = ref(null), trigger = ref(null), active = ref(0), position = ref({ top: 0, left: 0 });
const items = computed(() => {
  if (!trigger.value) return [];
  return trigger.value.kind === "task"
    ? filterTasks(props.tasks, trigger.value.query)
    : filterMembers(props.members, trigger.value.query);
});
const open = computed(() => !!trigger.value && items.value.length > 0);
const listId = "mention-" + Math.random().toString(36).slice(2);
function grow() {
  const el = box.value;
  if (!el || !props.autoGrow) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}
watch(() => props.modelValue, () => nextTick(grow), { immediate: true });
function refresh() {
  const el = box.value;
  if (!el) return;
  if (el.selectionStart !== el.selectionEnd) { trigger.value = null; return; }
  const at = props.members.length ? mentionQuery(el.value, el.selectionStart) : null;
  const hash = props.tasks.length ? taskHashQuery(el.value, el.selectionStart) : null;
  if (!at && !hash) { trigger.value = null; return; }
  const next = at && hash
    ? (hash.start > at.start ? { kind: "task", ...hash } : { kind: "mention", ...at })
    : hash ? { kind: "task", ...hash } : { kind: "mention", ...at };
  trigger.value = next;
  active.value = items.value.length ? 0 : -1;
  position.value = caretOffset(el, next.start);
}
function input(event) {
  emit("update:modelValue", event.target.value);
  if (event.isComposing) return;
  refresh();
}
function pick(item) {
  if (!item || !trigger.value) return;
  const el = box.value;
  if (trigger.value.kind === "task") {
    const next = removeRange(el.value, trigger.value.start, el.selectionStart);
    emit("update:modelValue", next.text);
    emit("pick-task", item);
    trigger.value = null;
    void nextTick(() => { el.value = next.text; el.focus(); el.setSelectionRange(next.caret, next.caret); });
    return;
  }
  const next = insertMention(el.value, trigger.value.start, el.selectionStart, item.name);
  emit("update:modelValue", next.text);
  trigger.value = null;
  void nextTick(() => { el.value = next.text; el.focus(); el.setSelectionRange(next.caret, next.caret); });
}
function keydown(event) {
  if (event.isComposing || event.keyCode === 229 || !open.value) { emit("keydown", event); return; }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    active.value = moveActive(items.value.length, active.value, event.key === "ArrowDown" ? 1 : -1);
  } else if ((event.key === "Enter" || event.key === "Tab") && active.value >= 0) {
    event.preventDefault();
    pick(items.value[active.value]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    trigger.value = null;
  } else emit("keydown", event);
}
/** Insert "@name " at the caret (when the box has focus) or at the end, then focus it. */
function mentionMember(name) {
  const el = box.value;
  if (!el) return;
  const focused = document.activeElement === el;
  const next = withMention(el.value, name, focused ? el.selectionStart : el.value.length, focused ? el.selectionEnd : el.value.length);
  emit("update:modelValue", next.text);
  void nextTick(() => { el.value = next.text; el.focus(); el.setSelectionRange(next.caret, next.caret); });
}
defineExpose({ focus: () => box.value?.focus(), mention: mentionMember });
</script>
<template>
  <div class="mention-wrap">
    <textarea ref="box" class="chat-draft" :value="modelValue" :rows="rows" :maxlength="maxlength" :placeholder="placeholder" :disabled="disabled" :aria-label="ariaLabel"
      role="combobox" aria-autocomplete="list" :aria-expanded="open" :aria-controls="listId" :aria-activedescendant="open && active >= 0 ? listId + '-' + active : undefined"
      @input="input" @compositionend="refresh" @keydown="keydown" @click="refresh" @blur="trigger = null"></textarea>
    <ul v-if="open" :id="listId" class="mention-menu" :class="{ 'task-menu': trigger?.kind === 'task' }" role="listbox" :style="{ bottom: 'calc(100% + 4px)', left: Math.max(0, position.left) + 'px' }">
      <template v-if="trigger?.kind === 'task'">
        <li v-for="(t, index) in items" :id="listId + '-' + index" :key="t.id" role="option" :aria-selected="index === active"
          :class="{ active: index === active }" @mousedown.prevent="pick(t)" @mouseenter="active = index">
          <div class="task-option-head">
            <span :class="['dot', taskTone(t.status)]" aria-hidden="true"></span>
            <span v-if="t.chainSeq" class="seq-tag">#{{ t.chainSeq }}</span>
            <strong class="truncate">{{ cleanTaskTitle(t.text) || t.id }}</strong>
          </div>
          <small>{{ taskLabel(t.status) }}<template v-if="t.employeeName"> · {{ t.employeeName }}</template><template v-if="t.createdAt"> · {{ shortTime(t.createdAt) }}</template></small>
        </li>
      </template>
      <template v-else>
        <li v-for="(m, index) in items" :id="listId + '-' + index" :key="m.id" role="option" :aria-selected="index === active"
          :class="{ active: index === active }" @mousedown.prevent="pick(m)" @mouseenter="active = index">
          <strong>@{{ m.name }}</strong>
          <small v-if="m.hint">{{ m.hint }}</small>
        </li>
      </template>
    </ul>
  </div>
</template>
<style scoped>
.mention-wrap { position: relative; display: grid; }
.mention-menu { position: absolute; z-index: 30; min-width: 200px; max-width: 340px; max-height: 280px; overflow-y: auto; margin: 0; padding: 4px; list-style: none; background: var(--surface, #fff); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .12); }
.mention-menu.task-menu { min-width: 260px; max-width: min(420px, 85vw); }
.mention-menu li { display: grid; gap: 2px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.mention-menu li.active { background: var(--accent-softer); }
.mention-menu strong { font-weight: 500; font-size: 13px; }
.mention-menu small { color: var(--muted); font-size: 11px; font-weight: 400; }
.task-option-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.seq-tag { flex: none; padding: 0 5px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
