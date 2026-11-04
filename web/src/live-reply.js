import { ref, computed } from "vue";

/**
 * The employee reply being streamed into the chat page.
 * message_start → start(), text_delta → append() (painted at most once per frame; every 250ms in a hidden tab),
 * message_end → end() moves the text to "settling" until settle() runs in the same tick the persisted copy is merged,
 * so the bubble neither flickers nor shows twice. Masked turns stream no deltas: nothing shows until the merge.
 */
export function createLiveReply({ onPaint } = {}) {
  const text = ref(""), settling = ref([]);
  let pending = "", frame = 0, timer, epoch = 0, disposed = false;
  function paint() {
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = undefined;
    if (!pending || disposed) return;
    text.value += pending;
    pending = "";
    onPaint?.();
  }
  function schedule() {
    if (frame || timer) return;
    if (typeof requestAnimationFrame === "function" && globalThis.document?.visibilityState !== "hidden") frame = requestAnimationFrame(paint);
    timer = setTimeout(paint, 250);
  }
  return {
    /** Assistant bubbles to append after the persisted messages. */
    rows: computed(() => [
      ...settling.value.map((item) => ({ role: "assistant", text: item.text, liveKey: `live-${item.epoch}` })),
      ...(text.value.trim() ? [{ role: "assistant", text: text.value, streaming: true, liveKey: `live-${epoch}` }] : []),
    ]),
    /** True while the current message already has visible text (the typing dots give way to it). */
    writing: computed(() => !!text.value.trim()),
    start() { paint(); pending = ""; text.value = ""; epoch++; },
    append(delta) { if (typeof delta === "string" && delta) { pending += delta; schedule(); } },
    end() {
      paint();
      const ended = epoch++;
      if (text.value.trim()) settling.value = [...settling.value, { epoch: ended, text: text.value }];
      text.value = "";
      return ended;
    },
    settle(ended) { settling.value = settling.value.filter((item) => item.epoch !== ended); },
    clear() { paint(); pending = ""; text.value = ""; settling.value = []; },
    dispose() { disposed = true; clearTimeout(timer); if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame); },
  };
}
