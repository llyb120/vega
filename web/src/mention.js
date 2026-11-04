// @mention helpers for instruction textareas (pure; tested in tests/mention.test.ts).

/** The "@query" being typed right before the caret, or null. "@" right after a letter or digit (an email) does not count. */
export function mentionQuery(text, caret) {
  const before = String(text).slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\n@]/.test(query) || [...query].length > 40) return null;
  return { start: at, query };
}

const key = (value) => String(value || "").normalize("NFKC").toLowerCase().trim();

/** Colleagues matching the query: name prefix matches first, then substring matches; accepting ones before disabled ones. */
export function filterColleagues(colleagues, query, limit = 8) {
  const q = key(query);
  const rank = (c) => {
    const name = key(c.name);
    const hit = !q ? 1 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
    return hit < 0 ? -1 : hit * 2 + (c.acceptsColleagues === false ? 1 : 0);
  };
  return colleagues
    .map((c, index) => ({ c, r: rank(c), index }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.c);
}

/** Replace "@query" (from start to caret) with "@名称 "; returns the new text and caret. */
export function insertMention(text, start, caret, name) {
  const value = String(text), insert = "@" + name + " ";
  const after = value.slice(caret).replace(/^ /, "");
  return { text: value.slice(0, start) + insert + after, caret: start + insert.length };
}

/** Next highlighted index when moving through items, skipping disabled ones; -1 if none selectable. */
export function moveActive(items, current, step) {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const index = (((current + step * i) % n) + n) % n;
    if (items[index]?.acceptsColleagues !== false) return index;
  }
  return -1;
}

/** Caret position inside a textarea, in pixels relative to the textarea's top-left (mirror-div technique). */
export function caretOffset(textarea, position) {
  const style = getComputedStyle(textarea), mirror = document.createElement("div");
  for (const prop of ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "tabSize", "wordBreak", "overflowWrap"])
    mirror.style[prop] = style[prop];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", top: "0", left: "-9999px", overflow: "hidden", height: "auto" });
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop - textarea.scrollTop, left = marker.offsetLeft - textarea.scrollLeft;
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  mirror.remove();
  return { top: top + line, left };
}
