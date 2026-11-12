// Desktop/Wails detection and window controls. The Wails shell injects
// window.__VEGA_DESKTOP__ and a runtime shim after each page load, which may
// happen after this module first evaluates.
import { ref } from "vue";

const win = globalThis;

export function isDesktop() {
  return !!(win.__VEGA_DESKTOP__ || win.runtime?.WindowMinimise || win.runtime?.Quit || document.documentElement?.classList?.contains("is-desktop"));
}

export const desktopMode = ref(false);

export function applyDesktopClass() {
  if (!isDesktop()) return false;
  document.documentElement.classList.add("is-desktop");
  document.body?.classList.add("is-desktop");
  desktopMode.value = true;
  return true;
}

export function watchDesktop() {
  const sync = () => { if (isDesktop()) applyDesktopClass(); };
  sync();
  win.addEventListener?.("vega-desktop-ready", sync);
  const timer = setInterval(sync, 200);
  setTimeout(() => clearInterval(timer), 8000);
}

function invoke(fn, fallback) {
  try {
    const runtime = win.runtime;
    if (runtime && typeof runtime[fn] === "function") return runtime[fn]();
    if (typeof fallback === "function") return fallback();
  } catch {
    // The window bridge is best-effort; a missing runtime should not break the page.
  }
}

export function windowMinimise() {
  return invoke("WindowMinimise", () => win.WailsInvoke?.("Wm"));
}

export function windowToggleMaximise() {
  return invoke("WindowToggleMaximise", () => win.WailsInvoke?.("Wt"));
}

export function windowClose() {
  return invoke("Quit", () => win.WailsInvoke?.("Q"));
}

watchDesktop();
