function runtime() { return window.runtime || {}; }
document.getElementById("min").addEventListener("click", () => runtime().WindowMinimise?.());
document.getElementById("max").addEventListener("click", () => runtime().WindowToggleMaximise?.());
document.getElementById("quit").addEventListener("click", () => runtime().Quit?.());

const errorEl = document.getElementById("error");
const titleEl = document.getElementById("title");
const leadEl = document.getElementById("lead");

function showError(message) {
  titleEl.textContent = "无法启动";
  leadEl.textContent = "这个桌面窗口必须从站点下载的安装包里启动，站点地址写在同目录的 instance.json 里。";
  errorEl.hidden = false;
  errorEl.textContent = message;
}

async function init() {
  const api = window.go?.main?.App;
  try {
    const err = api?.StartupError ? await api.StartupError() : "";
    if (err) showError(err);
  } catch (e) {
    showError(e?.message || String(e));
  }
}

document.documentElement.classList.add("is-desktop");
void init();
