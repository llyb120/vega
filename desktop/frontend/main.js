const urlInput = document.getElementById("url");
const form = document.getElementById("form");
const errorEl = document.getElementById("error");
const connectBtn = document.getElementById("connect");

function runtime() { return window.runtime || {}; }
document.getElementById("min").addEventListener("click", () => runtime().WindowMinimise?.());
document.getElementById("max").addEventListener("click", () => runtime().WindowToggleMaximise?.());
document.getElementById("quit").addEventListener("click", () => runtime().Quit?.());

function showError(message) {
  if (!message) { errorEl.hidden = true; errorEl.textContent = ""; return; }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function app() {
  return window.go?.main?.App;
}

async function init() {
  const params = new URLSearchParams(location.search);
  const api = app();
  let cfg = { serverUrl: "http://127.0.0.1:8080" };
  try { if (api?.GetConfig) cfg = await api.GetConfig(); } catch (e) { console.warn(e); }
  urlInput.value = cfg.serverUrl || "http://127.0.0.1:8080";
  if (cfg.serverUrl && params.get("settings") !== "1" && api?.ConnectExisting) {
    try { await api.ConnectExisting(); } catch (e) { showError(e?.message || String(e)); }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const api = app();
  if (!api?.Connect) { showError("桌面接口还没准备好，请稍后再试。"); return; }
  connectBtn.disabled = true;
  try {
    await api.Connect(urlInput.value.trim());
  } catch (e) {
    showError(e?.message || String(e));
    connectBtn.disabled = false;
  }
});

document.documentElement.classList.add("is-desktop");
void init();
