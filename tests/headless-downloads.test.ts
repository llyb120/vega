import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { prepareHeadlessDownloads } from "../shared/headless-downloads.mjs";
import { privateDownloadReceipt } from "../server/core/private-downloads";
import { exportCopyScript, HeadlessBrowser } from "../server/core/headless";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { sleep } from "../server/core/util";

test("automatic downloads preserve existing preferences, fail closed on corruption and verify only the selected private file", async t => {
  const root = await mkdtemp(join(tmpdir(), "vega-dl-")), dir = join(root, "downloads"), profile = join(root, "profile");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(profile, "Default"), { recursive: true });
  const prefs = join(profile, "Default", "Preferences");
  await writeFile(prefs, JSON.stringify({ profile: { name: "keep" }, download: { prompt_for_download: true, extra: 2 } }));
  await prepareHeadlessDownloads(profile, dir);
  assert.deepEqual(JSON.parse(await readFile(prefs, "utf8")), { profile: { name: "keep" }, download: { extra: 2, prompt_for_download: false, default_directory: dir, directory_upgrade: true } });
  await writeFile(prefs, "broken");
  await assert.rejects(prepareHeadlessDownloads(profile, dir));
  assert.equal(await readFile(prefs, "utf8"), "broken");
  const path = join(dir, "report.csv");
  await writeFile(path, "ok");
  const record = { downloads: [{ id: "13", state: "complete", path }] };
  const check = (data: any, id?: string) => privateDownloadReceipt(data, id, dir) as Promise<any>;
  assert.equal((await check(record)).saved, undefined);
  assert.equal((await check(record, "13")).savedPath, path);
  record.downloads[0].state = "interrupted";
  assert.equal((await check(record, "13")).saved, undefined);
  record.downloads[0].state = "complete";
  await rm(path);
  assert.equal((await check(record, "13")).saved, false);
  record.downloads[0].path = prefs;
  assert.equal((await check(record, "13")).saved, false);
  assert.match((await check({ downloads: [] })).notice, /未检测到/);
});

test("picker compatibility is off by default and scoped to exact trusted origins including port", () => {
  assert.equal(exportCopyScript(), undefined);
  const entry = exportCopyScript("https://a.example:8443/,https://a.example:8443")!;
  assert.deepEqual(entry.matches, ["https://a.example/*"]);
  assert.deepEqual(entry.include_globs, ["https://a.example:8443/*"]);
  for (const bad of ["http://a.example", "https://*.example", "https://a.example/path", "https://x@a.example", "file:///tmp/example"]) assert.throws(() => exportCopyScript(bad));
});

test("private headless Chrome saves both a native attachment and a picker export with the original bytes", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "vega-dl-live-")), profile = join(root, "profile");
  const server = createServer((req, res) => {
    if (req.url === "/file") { res.writeHead(200, { "Content-Disposition": 'attachment; filename="native.txt"', "Content-Type": "text/plain" }); res.end("native"); }
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end('<a id="attachment" href="/file">native</a>'); }
  });
  const bridge = new ChromeBridge(true), browser = new HeadlessBrowser();
  const prior = process.env.VEGA_HEADLESS_EXPORT_ORIGINS;
  t.after(async () => {
    if (prior === undefined) delete process.env.VEGA_HEADLESS_EXPORT_ORIGINS; else process.env.VEGA_HEADLESS_EXPORT_ORIGINS = prior;
    await browser.close(); bridge.close(); server.closeAllConnections(); server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  });
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const origin = "http://127.0.0.1:" + (server.address() as {port: number}).port;
  process.env.VEGA_HEADLESS_EXPORT_ORIGINS = origin;
  await bridge.start();
  const probes = new Set<string>();
  bridge.server!.on('request', (req, res) => { if (req.url === '/health' || req.url === '/pair') res.on('finish', () => probes.add(`${req.method} ${req.url} ${res.statusCode} origin=${req.headers.origin || '(absent)'}`)); });
  await browser.start(join(root, "vega.db"), { profile, port: bridge.port, token: bridge.token });
  const deadline = Date.now() + 12000;
  while (!bridge.status().connected && Date.now() < deadline) await sleep(100);
  assert(bridge.status().connected, "private extension did not pair: " + [...probes].join('; '));
  const openFixture = async () => (await bridge.request("open", { url: origin, viewOpts: { screenshot: false } })).tabTag;
  let tabTag = await openFixture();
  const evaluate = async (expression: string, userGesture = true) => {
    const r = await bridge.request("cdp", { tabTag, method: "Runtime.evaluate", params: { expression, userGesture, awaitPromise: true, returnByValue: true } });
    assert(!r.exceptionDetails, r.exceptionDetails?.exception?.description); return r.result.value;
  };
  const verify = async (name: string, content: string) => {
    for (const end = Date.now() + 6000; Date.now() < end;) {
      const r = await bridge.request("downloads", {}), item = r.downloads.find((d: any) => d.path?.endsWith(name));
      if (item?.state === "interrupted") assert.fail(item.error);
      if (item?.state === "complete") {
        assert.equal(item.path, join(profile, "Downloads", name));
        assert.equal(await readFile(item.path, "utf8"), content); return;
      }
      await sleep(100);
    }
    const { downloads } = await bridge.request("downloads", {});
    assert.fail(`no completed download: ${name}; records: ${JSON.stringify(downloads.map((d: any) => [d.path, d.state, d.error, d.danger]))}`);
  };
  await evaluate("document.querySelector('#attachment').click()");
  await verify("native.txt", "native");
  // Separate export actions, not a multiple-automatic-downloads permission test.
  tabTag = await openFixture();
  await evaluate(`(async () => {const h = await showSaveFilePicker({suggestedName:'copy.txt'}); const w = await h.createWritable(); await w.write('abc'); await w.seek(1); await w.write('X'); await w.close()})()`);
  await verify("copy.txt", "aXc");
  assert.deepEqual(await evaluate(`(async () => {const w = await (await showSaveFilePicker()).createWritable(); await w.write('partial'); await w.abort(); return Array.fromAsync((await navigator.storage.getDirectory()).keys());})()`), []);
});
