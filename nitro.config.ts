import { defineNitroConfig } from "nitropack/config";
export default defineNitroConfig({
  preset: "node-server",
  srcDir: "server",
  compatibilityDate: "2026-10-30",
  publicAssets: [
    { dir: "../web/dist", baseURL: "/", maxAge: 0 },
    { dir: "../local/extension", baseURL: "/extension", maxAge: 0 },
  ],
  serverAssets: [
    { baseName: "assets", dir: "../shared" },
    { baseName: "browser", dir: "assets/browser" },
  ],
  // shared/*.mjs 在 dev 下会被外部化，相对路径按 .nitro 目录解析就会找不到模块（Windows dev 必崩）。
  externals: { external: ["node:sqlite", "sharp"], inline: [/\/(cloud-wire|workspace-sync)\.mjs$/] },
  routeRules: {
    "/clients/**": {
      headers: { "Content-Disposition": "attachment", "Cache-Control": "no-cache" },
    },
    "/**": {
      headers: {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      },
    },
  },
  esbuild: { options: { target: "node24" } },
  typescript: { strict: true },
});
