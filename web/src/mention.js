// @mention helpers for the group chat composer (pure; tested in tests/mention.test.ts).

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

/** Members matching the query: name prefix matches first, then substring matches, in list order. */
export function filterMembers(members, query, limit = 8) {
  const q = key(query);
  const rank = (m) => {
    const name = key(m.name);
    return !q ? 1 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
  };
  return members
    .map((m, index) => ({ m, r: rank(m), index }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.m);
}

/** Replace "@query" (from start to caret) with "@名称 "; returns the new text and caret. */
export function insertMention(text, start, caret, name) {
  const value = String(text), insert = "@" + name + " ";
  const after = value.slice(caret).replace(/^ /, "");
  return { text: value.slice(0, start) + insert + after, caret: start + insert.length };
}

/** Next highlighted index when moving through `count` items (wraps); -1 when there are none. */
export function moveActive(count, current, step) {
  return count ? (((current + step) % count) + count) % count : -1;
}

/** The "#query" being typed right before the caret, or null. "#" right after ASCII word/URL chars does not count. */
export function taskHashQuery(text, caret) {
  const before = String(text).slice(0, caret);
  const hash = before.lastIndexOf("#");
  if (hash < 0) return null;
  if (hash > 0 && /[A-Za-z0-9_/:&.=+-]/.test(before[hash - 1])) return null;
  const query = before.slice(hash + 1);
  if (/[\n#]/.test(query) || [...query].length > 40) return null;
  return { start: hash, query };
}

const ENDED_SET = new Set(["done", "failed", "cancelled", "stopped", "sealed"]);

/** Tasks matching the #query: exact id/#seq first, then prefix/substring on text, id, branchLabel, employeeName. */
export function filterTasks(tasks, query, limit = 8) {
  const raw = key(query), seqQuery = raw.replace(/^#/, "");
  const rank = (t) => {
    const id = key(t.id);
    const title = key(t.text);
    const label = key(t.branchLabel);
    const emp = key(t.employeeName);
    const seq = t.chainSeq != null ? String(t.chainSeq) : "";
    if (!raw) return ENDED_SET.has(t.status) ? 2 : 1;
    if (id === raw || (seq && seq === seqQuery)) return 0;
    if (id.startsWith(raw) || title.startsWith(raw) || label.startsWith(raw)) return 1;
    if (title.includes(raw) || id.includes(raw) || label.includes(raw) || emp.includes(raw) || key(t.status).includes(raw)) return 2;
    return -1;
  };
  return (tasks || [])
    .map((t, index) => ({ t, r: rank(t), index }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || ((b.t.finishedAt || b.t.createdAt || 0) - (a.t.finishedAt || a.t.createdAt || 0)) || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.t);
}

/** Remove "[start, caret)" (e.g. a picked #query) from text and return the adjusted text and caret. */
export function removeRange(text, start, caret) {
  const value = String(text);
  const before = value.slice(0, start);
  const after = value.slice(caret);
  const trimmedAfter = before.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
  return { text: before + trimmedAfter, caret: start };
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

/**
 * Plain text split into text and "@名称" pieces for the known people ({ id, name, link? }), longest name first;
 * "@" right after a letter or digit (an email) does not count. Used for the user's own (non-Markdown) messages.
 */
export function mentionSegments(text, people) {
  const value = String(text || ""), named = (people || []).filter((p) => p?.id && String(p.name || "").trim());
  if (!named.length || !value.includes("@")) return [{ text: value }];
  const byName = new Map(named.map((p) => [String(p.name).trim(), p]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@(${names.join("|")})`, "gu");
  const out = [];
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index + match[1].length, person = byName.get(match[2]);
    if (start > last) out.push({ text: value.slice(last, start) });
    out.push({ text: "@" + match[2], id: String(person.id), link: person.link !== false });
    last = start + 1 + match[2].length;
  }
  if (last < value.length) out.push({ text: value.slice(last) });
  return out;
}
