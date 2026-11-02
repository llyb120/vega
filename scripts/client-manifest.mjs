import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platforms = ["windows-amd64", "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
export async function writeClientManifest(directory) {
  const version = (await readFile(new URL("../local/VERSION", import.meta.url), "utf8")).trim();
  if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) throw Error("Invalid client VERSION");
  const assets = {};
  for (const platform of platforms) {
    const file = `vega-local-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`;
    const data = await readFile(resolve(directory, file));
    if (!data.length || data.length > 128 << 20) throw Error(`Invalid client size: ${file}`);
    assets[platform] = { file, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  const manifest = { version, assets };
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest) + "\n");
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error("Usage: node scripts/client-manifest.mjs <client-directory>");
  await writeClientManifest(process.argv[2]);
}
