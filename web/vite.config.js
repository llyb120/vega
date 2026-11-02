import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  root: "web",
  plugins: [vue(), {
    name: "chrome-extension-download",
    // Generate before Vite indexes public files so the first dev download also works.
    configResolved(config) {
      const archive = zipSync(Object.fromEntries(
        ["manifest.json", "worker.js", "content.js", "popup.html", "popup.js"].map((file) =>
          [file, readFileSync(new URL("../extensions/nova-chrome/" + file, import.meta.url))]),
      ));
      const directory = join(config.publicDir, "clients");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "nova-chrome.zip"), archive);
    },
  }],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8080" } },
  build: { outDir: "dist", emptyOutDir: true },
});
