// Long-press (touch or mouse, ~500 ms) on an element; a normal tap keeps its click. Bind down/move/cancel to the
// pointer events, prevent contextmenu, and guard the element's click with consumed() so a long-press does not also tap.
export const LONG_PRESS_MS = 500;
export function longPress(fire, ms = LONG_PRESS_MS) {
  let timer = 0, fired = false, x = 0, y = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  return {
    down(event, value) {
      if (event.button > 0) return;
      fired = false; x = event.clientX; y = event.clientY; cancel();
      timer = setTimeout(() => { timer = 0; fired = true; navigator.vibrate?.(10); fire(value); }, ms);
    },
    move(event) { if (timer && Math.hypot(event.clientX - x, event.clientY - y) > 10) cancel(); },
    cancel,
    /** True once right after a long-press: the click that follows it is swallowed. */
    consumed() { const was = fired; fired = false; return was; },
  };
}
/** "@name " at the caret of a focused textarea, else appended; with a space before it when needed. */
export function withMention(value, name, start = value.length, end = start) {
  const before = value.slice(0, start), pad = before && !/\s$/.test(before) ? " " : "", text = pad + "@" + name + " ";
  return { text: before + text + value.slice(end), caret: start + text.length };
}
