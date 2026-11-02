import { defineNitroConfig } from "nitropack/config";
export default defineNitroConfig({
  preset: "node-server",
  srcDir: "server",
  compatibilityDate: "2026-10-30",
  experimental: { websocket: true },
  publicAssets: [
    { dir: "../web/dist", baseURL: "/", maxAge: 0 },
    { dir: "../extensions", baseURL: "/extension", maxAge: 0 },
  ],
  serverAssets: [
    { baseName: "assets", dir: "../shared" },
    { baseName: "browser", dir: "assets/browser" },
  ],
  externals: { external: ["node:sqlite", "sharp"] },
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
