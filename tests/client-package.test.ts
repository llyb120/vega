import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { clientBaseName, clientPackage } from "../server/core/client-package";

const name = "vega-local-windows-amd64.exe";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "vega-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, name), "binary-v1");
  process.env.VEGA_CLIENTS_DIR = dir;
  t.after(() => { delete process.env.VEGA_CLIENTS_DIR; });
  return dir;
}

test("the install package carries the site's own origin next to the client binary", async (t) => {
  const dir = fixture(t);
  const body = await clientPackage(name, "https://vega.example");
  const files = unzipSync(body);
  assert.equal(strFromU8(files[name]), "binary-v1");
  const instance = JSON.parse(strFromU8(files["instance.json"]));
  assert.equal(instance.origin, "https://vega.example");
  assert.equal(typeof instance.downloadedAt, "number");

  // 同一站点同一版本不重复压缩。
  const cached = await clientPackage(name, "https://vega.example");
  assert.equal(cached, body);

  // 客户端升级（文件变化）后重新打包。
  writeFileSync(join(dir, name), "binary-v2");
  utimesSync(join(dir, name), new Date(), new Date(Date.now() + 2000));
  const upgraded = await clientPackage(name, "https://vega.example");
  assert.equal(strFromU8(unzipSync(upgraded)[name]), "binary-v2");

  // 另一个站点有自己的包，指向它自己。
  const other = await clientPackage(name, "https://other.example");
  assert.equal(JSON.parse(strFromU8(unzipSync(other)["instance.json"])).origin, "https://other.example");
});

test("only known client files can be packaged", async (t) => {
  fixture(t);
  assert.equal(clientBaseName("vega-local-linux-amd64.zip"), "vega-local-linux-amd64");
  for (const bad of ["manifest.json", "../../etc/passwd", "../vega-local-linux-amd64", "vega-chrome.zip", ""])
    assert.throws(() => clientBaseName(bad), /Unknown client package/, bad);
  await assert.rejects(clientPackage("vega-local-solaris-sparc", "https://vega.example"), /Unknown client package/);
});
