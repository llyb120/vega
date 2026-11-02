import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { unzipSync } from "fflate";
import { createServer } from "vite";

const docker = readFileSync("Dockerfile", "utf8");
const resources = readFileSync("web/src/ResourcesView.vue", "utf8");
const app = readFileSync("web/src/App.vue", "utf8");

test("Docker builds exactly the client platforms offered by Resources before bundling the frontend", () => {
  const script = resources.match(/<script setup vapor>([\s\S]*?)<\/script>/)![1];
  const clients = vm.runInNewContext(script + "\nclients") as { name: string; arch: string; file: string }[];
  const targets = docker.match(/for target in ([^;]+); do/)![1].trim().split(/\s+/);
  const expected = [
    "vega-local-windows-amd64.exe",
    "vega-local-linux-amd64",
    "vega-local-linux-arm64",
    "vega-local-darwin-amd64",
    "vega-local-darwin-arm64",
  ];
  assert.deepEqual(Array.from(clients, (client) => client.file).sort(), expected.sort());
  assert.deepEqual(targets.map((target) => "vega-local-" + target.replace("/", "-") + (target.startsWith("windows/") ? ".exe" : "")).sort(), expected);
  assert(clients.every((client) => client.name && client.arch));
  assert.match(docker, /FROM --platform=\$BUILDPLATFORM golang:1\.26-bookworm AS clients/);
  assert.match(docker, /COPY local\/go\.mod local\/go\.sum \.\/\s+RUN go mod download/);
  assert.match(docker, /COPY local\/\*\.go local\/icon\.ico \.\//);
  assert.match(docker, /RUN set -eu;/, "a failed cross-build must stop the image build");
  assert.match(docker, /CGO_ENABLED=0 GOOS="\$os" GOARCH="\$arch" go build -trimpath/);
  assert.match(docker, /if \[ "\$os" = windows \]; then flags="\$flags -H=windowsgui"; suffix="\.exe"; fi/);
  assert.match(docker, /-o "\/out\/vega-local-\$os-\$arch\$suffix"/);
  assert.match(docker, /COPY --from=clients \/out \.\/web\/public\/clients\s+RUN npm run build/);
  const ignore = readFileSync(".dockerignore", "utf8");
  for (const input of ["local/", "local/*.go", "local/go.mod", "local/go.sum", "local/icon.ico"])
    assert(ignore.split(/\r?\n/).includes("!" + input));
  assert(ignore.split(/\r?\n/).includes("web/public/clients/"), "host binaries must not enter the build context");
  assert(!ignore.includes("!local/**"), "allow Go inputs, not local credentials or host executables");
});

test("Resources offers a Chrome extension ZIP containing only the current runtime files", async (t) => {
  const publicDir = mkdtempSync(join(tmpdir(), "vega-resources-"));
  const server = await createServer({
    configFile: "web/vite.config.js",
    publicDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(async () => {
    await server.close();
    rmSync(publicDir, { recursive: true, force: true });
  });
  await server.listen();
  const response = await fetch(new URL("clients/nova-chrome.zip", server.resolvedUrls!.local[0]));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/zip/);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const expected = ["manifest.json", "worker.js", "content.js", "popup.html", "popup.js"];
  assert.deepEqual(Object.keys(files).sort(), expected.sort());
  for (const file of expected)
    assert.deepEqual(Buffer.from(files[file]), readFileSync("extensions/nova-chrome/" + file));
  assert.match(resources, /href="\/clients\/nova-chrome\.zip" download="nova-chrome\.zip"/);
  assert.match(resources, /aria-label="下载 Chrome 扩展 ZIP"/);
  assert.match(resources, /chrome:\/\/extensions/);
  assert.match(resources, /加载已解压的扩展程序/);
  assert.match(resources, /重新加载/);
});

test("Resources is available in desktop and mobile navigation with same-origin downloadable clients", () => {
  assert.match(app, /import ResourcesView from "\.\/ResourcesView\.vue"/);
  assert.match(app, /resources: "资源"/);
  const button = app.match(/<button[^>]*@click="view = 'resources'"[^>]*>[\s\S]*?<\/button>/)![0];
  assert.doesNotMatch(button, /v-if=/, "downloads are not admin-only");
  assert.match(button, /<span>资源<\/span>/);
  assert.match(app, /<ResourcesView v-else-if="view === 'resources'" \/>/);
  assert.match(resources, /:href="'\/clients\/' \+ client\.file" :download="client\.file"/);
  assert.match(resources, /:aria-label="'下载 '/);
  assert.match(resources, /chmod \+x/);
  assert.match(resources, /未签名/);
  const config = readFileSync("nitro.config.ts", "utf8");
  assert.match(config, /"\/clients\/\*\*":\s*\{\s*headers: \{ "Content-Disposition": "attachment", "Cache-Control": "no-cache" \}/);
});
