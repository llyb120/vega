<script setup vapor>
import { computed, nextTick, ref } from "vue";
import { caretOffset, filterMembers, insertMention, mentionQuery, moveActive } from "./mention.js";
import { withMention } from "./long-press.js";
// A textarea with an @member picker. `members`: [{ id, name, hint? }] (the writer already excluded).
// Keys the picker does not use are re-emitted as `keydown` (e.g. Enter to send).
const props = defineProps({ modelValue: String, members: { type: Array, default: () => [] }, rows: [Number, String], maxlength: [Number, String], placeholder: String, disabled: Boolean });
const emit = defineEmits(["update:modelValue", "keydown"]);
const box = ref(null), mention = ref(null), active = ref(0), position = ref({ top: 0, left: 0 });
const items = computed(() => (mention.value ? filterMembers(props.members, mention.value.query) : []));
const open = computed(() => !!mention.value && items.value.length > 0);
const listId = "mention-" + Math.random().toString(36).slice(2);
function refresh() {
  const el = box.value;
  if (!el) return;
  mention.value = el.selectionStart === el.selectionEnd ? mentionQuery(el.value, el.selectionStart) : null;
  if (!mention.value) return;
  active.value = items.value.length ? 0 : -1;
  position.value = caretOffset(el, mention.value.start);
}
function input(event) {
  emit("update:modelValue", event.target.value);
  if (event.isComposing) return;
  refresh();
}
function pick(member) {
  if (!member || !mention.value) return;
  const el = box.value, next = insertMention(el.value, mention.value.start, el.selectionStart, member.name);
  emit("update:modelValue", next.text);
  mention.value = null;
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
    mention.value = null;
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
    <textarea ref="box" :value="modelValue" :rows="rows" :maxlength="maxlength" :placeholder="placeholder" :disabled="disabled"
      role="combobox" aria-autocomplete="list" :aria-expanded="open" :aria-controls="listId" :aria-activedescendant="open && active >= 0 ? listId + '-' + active : undefined"
      @input="input" @compositionend="refresh" @keydown="keydown" @click="refresh" @blur="mention = null"></textarea>
    <ul v-if="open" :id="listId" class="mention-menu" role="listbox" :style="{ bottom: 'calc(100% + 4px)', left: Math.max(0, position.left) + 'px' }">
      <li v-for="(m, index) in items" :id="listId + '-' + index" :key="m.id" role="option" :aria-selected="index === active"
        :class="{ active: index === active }" @mousedown.prevent="pick(m)" @mouseenter="active = index">
        <strong>@{{ m.name }}</strong>
        <small v-if="m.hint">{{ m.hint }}</small>
      </li>
    </ul>
  </div>
</template>
<style scoped>
.mention-wrap { position: relative; display: grid; }
.mention-menu { position: absolute; z-index: 30; min-width: 200px; max-width: 320px; margin: 0; padding: 4px; list-style: none; background: var(--surface, #fff); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .12); }
.mention-menu li { display: grid; gap: 1px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.mention-menu li.active { background: var(--accent-softer); }
.mention-menu strong { font-weight: 500; font-size: 13px; }
.mention-menu small { color: var(--muted); font-size: 11px; font-weight: 400; }
</style>
