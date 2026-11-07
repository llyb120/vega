import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { assert } from "./util";

/**
 * 客户端安装包：站点自带的客户端 exe + 一份 instance.json 打成一个 ZIP。
 * 只压一次：按 站点 + 文件 + 大小 + 修改时间 缓存，客户端升级后自动失效。
 */

const CLIENT_NAME = /^vega-local-[a-z0-9._-]+$/i;
const CACHE_LIMIT = 24;
const cache = new Map<string, Buffer>();
const pending = new Map<string, Promise<Buffer>>();

/** 只允许打包资源页列出的客户端二进制，/clients 下别的文件不参与。 */
export function clientBaseName(file: string) {
  const name = file.replace(/\.zip$/i, "");
  assert(CLIENT_NAME.test(name) && !name.includes(".."), "Unknown client package");
  return name;
}

/** 客户端二进制在磁盘上的位置：开发在 web/dist，部署在 .output/public，也可用 VEGA_CLIENTS_DIR 指定。 */
export function clientBinaryPath(name: string) {
  const candidates = [
    process.env.VEGA_CLIENTS_DIR ? resolve(process.env.VEGA_CLIENTS_DIR, name) : "",
    resolve(process.cwd(), "web/dist/clients", name),
    resolve(process.cwd(), ".output/public/clients", name),
    resolve(dirname(process.argv[1] || "."), "..", "public/clients", name),
    resolve(dirname(process.argv[1] || "."), "clients", name),
  ].filter((path): path is string => !!path);
  return candidates.find((path) => existsSync(path));
}

export async function clientPackage(name: string, origin: string) {
  const path = clientBinaryPath(name);
  assert(path, "Unknown client package");
  const info = await stat(path);
  const key = `${origin}:${path}:${info.size}:${info.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const running = pending.get(key);
  if (running) return await running;
  const task = (async () => {
    try {
      const binary = await readFile(path);
      const instance = JSON.stringify({ origin, downloadedAt: Date.now() }, null, 2) + "\n";
      const body = Buffer.from(zipSync({ [name]: new Uint8Array(binary), "instance.json": strToU8(instance) }, { level: 1 }));
      cache.set(key, body);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return body;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return await task;
}
