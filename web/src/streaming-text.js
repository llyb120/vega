import { ref, watch } from "vue";

/**
 * While `streaming` is true the returned text follows `source` at most once per `interval` ms,
 * so a long answer is not re-parsed as markdown on every token; it catches up immediately when streaming stops.
 */
export function useStreamingText(source, streaming, interval = 120, onCleanup) {
  const shown = ref(source());
  let timer, last = 0;
  const apply = () => {
    timer = undefined;
    last = Date.now();
    shown.value = source();
  };
  watch([source, streaming], ([text, live]) => {
    if (!live) {
      clearTimeout(timer);
      timer = undefined;
      shown.value = text;
      return;
    }
    if (timer) return;
    const wait = last + interval - Date.now();
    if (wait <= 0) apply();
    else timer = setTimeout(apply, wait);
  }, { flush: "sync" });
  onCleanup?.(() => clearTimeout(timer));
  return shown;
}
