<script setup vapor>
import { computed, nextTick, ref } from "vue";
import { caretOffset, filterColleagues, insertMention, mentionQuery, moveActive } from "./mention.js";
// A textarea with an @colleague picker. `colleagues`: [{ id, name, publicSummary, acceptsColleagues }], self already excluded.
const props = defineProps({ modelValue: String, colleagues: { type: Array, default: () => [] }, rows: [Number, String], maxlength: [Number, String], placeholder: String });
const emit = defineEmits(["update:modelValue"]);
const box = ref(null), mention = ref(null), active = ref(0), position = ref({ top: 0, left: 0 });
const items = computed(() => (mention.value ? filterColleagues(props.colleagues, mention.value.query) : []));
const open = computed(() => !!mention.value && items.value.length > 0);
const listId = "mention-" + Math.random().toString(36).slice(2);
const snippet = (text) => { const chars = [...String(text || "")]; return chars.length > 40 ? chars.slice(0, 40).join("") + "…" : chars.join(""); };
function refresh() {
  const el = box.value;
  if (!el) return;
  mention.value = el.selectionStart === el.selectionEnd ? mentionQuery(el.value, el.selectionStart) : null;
  if (!mention.value) return;
  active.value = moveActive(items.value, -1, 1);
  position.value = caretOffset(el, mention.value.start);
}
function input(event) {
  emit("update:modelValue", event.target.value);
  if (event.isComposing) return;
  refresh();
}
function pick(colleague) {
  if (!colleague || colleague.acceptsColleagues === false || !mention.value) return;
  const el = box.value, next = insertMention(el.value, mention.value.start, el.selectionStart, colleague.name);
  emit("update:modelValue", next.text);
  mention.value = null;
  void nextTick(() => { el.value = next.text; el.focus(); el.setSelectionRange(next.caret, next.caret); });
}
function keydown(event) {
  if (event.isComposing || event.keyCode === 229 || !open.value) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    active.value = moveActive(items.value, active.value, event.key === "ArrowDown" ? 1 : -1);
  } else if ((event.key === "Enter" || event.key === "Tab") && active.value >= 0) {
    event.preventDefault();
    pick(items.value[active.value]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    mention.value = null;
  }
}
</script>
<template>
  <div class="mention-wrap">
    <textarea ref="box" :value="modelValue" :rows="rows" :maxlength="maxlength" :placeholder="placeholder"
      role="combobox" aria-autocomplete="list" :aria-expanded="open" :aria-controls="listId" :aria-activedescendant="open && active >= 0 ? listId + '-' + active : undefined"
      @input="input" @compositionend="refresh" @keydown="keydown" @click="refresh" @blur="mention = null"></textarea>
    <ul v-if="open" :id="listId" class="mention-menu" role="listbox" :style="{ top: position.top + 'px', left: Math.max(0, position.left) + 'px' }">
      <li v-for="(c, index) in items" :id="listId + '-' + index" :key="c.id" role="option" :aria-selected="index === active" :aria-disabled="c.acceptsColleagues === false"
        :class="{ active: index === active, disabled: c.acceptsColleagues === false }" @mousedown.prevent="pick(c)" @mouseenter="c.acceptsColleagues !== false && (active = index)">
        <strong>@{{ c.name }}</strong>
        <small>{{ c.acceptsColleagues === false ? '未开启接受转交和询问' : snippet(c.publicSummary) || '未填写对外说明' }}</small>
      </li>
    </ul>
  </div>
</template>
<style scoped>
.mention-wrap { position: relative; display: grid; }
.mention-menu { position: absolute; z-index: 30; min-width: 220px; max-width: 320px; margin: 2px 0 0; padding: 4px; list-style: none; background: var(--surface, #fff); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .12); }
.mention-menu li { display: grid; gap: 1px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.mention-menu li.active { background: var(--accent-softer); }
.mention-menu li.disabled { cursor: not-allowed; opacity: .55; }
.mention-menu strong { font-weight: 500; font-size: 13px; }
.mention-menu small { color: var(--muted); font-size: 11px; font-weight: 400; }
</style>
