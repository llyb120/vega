// Long-press (~500 ms) by touch or mouse; a normal tap keeps its click. Touch events, not pointer events: mobile
// browsers cancel pointers (pointercancel) once they consider the touch a scroll or a long-press. Android also
// reports the long-press as contextmenu, which counts as one too (whichever comes first fires, once per press).
export const LONG_PRESS_MS = 500;
export function longPress(fire, ms = LONG_PRESS_MS) {
  let timer = 0, fired = false, x = 0, y = 0, touched = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const go = () => { cancel(); if (fired) return; fired = true; navigator.vibrate?.(10); fire(); };
  const point = (event) => event.touches?.[0] || event;
  return {
    /** touchstart / mousedown (left button). */
    down(event) {
      // The mouse events a browser synthesizes after a touch are not a second press.
      if (event.touches) touched = Date.now();
      else if (event.button > 0 || Date.now() - touched < 1000) return;
      fired = false; ({ clientX: x, clientY: y } = point(event)); cancel();
      timer = setTimeout(go, ms);
    },
    /** touchmove / mousemove: a drag (scroll) is not a press. */
    move(event) { const p = point(event); if (timer && Math.hypot(p.clientX - x, p.clientY - y) > 10) cancel(); },
    /** touchend / touchcancel / mouseup / mouseleave: before the delay, a plain tap. */
    cancel,
    /** touchend: after a long-press, no synthesized click follows. */
    end(event) { cancel(); if (fired && event.cancelable) event.preventDefault(); },
    /** contextmenu: the browser's own long-press. */
    menu: go,
    /** True once right after a long-press: the click that follows it is swallowed. */
    consumed() { const was = fired; fired = false; return was; },
  };
}
/** "@name " at the caret of a focused textarea, else appended; with a space before it when needed. */
export function withMention(value, name, start = value.length, end = start) {
  const before = value.slice(0, start), pad = before && !/\s$/.test(before) ? " " : "", text = pad + "@" + name + " ";
  return { text: before + text + value.slice(end), caret: start + text.length };
}
