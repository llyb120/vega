import { applyDesktopClass } from "./desktop.js";
import { createVaporApp } from "vue";
import App from "./App.vue";
import "./style.css";
applyDesktopClass();
createVaporApp(App).mount("#app");
applyDesktopClass();
