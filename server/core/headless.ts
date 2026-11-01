import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { assert } from "./util";

export function extensionDirectory(moduleUrl = import.meta.url, entry = process.argv[1]) {
  const candidates = [
    fileURLToPath(new URL("../../extensions/nova-chrome", moduleUrl)),
    fileURLToPath(new URL("../../../public/extension/nova-chrome", moduleUrl)),
    ...(entry ? [resolve(dirname(entry), "../public/extension/nova-chrome"), resolve(dirname(entry), "../../extension")] : []),
  ];
  const directory = candidates.find((path) => existsSync(join(path, "manifest.json")) && existsSync(join(path, "worker.js")));
  assert(directory, "找不到随应用打包的 Chrome 扩展，请完整部署 .output（包含 public/extension/nova-chrome）");
  return directory;
}

type PrivateBrowser = { profile: string; port: number; token: string };
export function privateWorker(source: string, instance: Pick<PrivateBrowser, "port" | "token">) {
  const loop = 'for (let port=47653; port<=47662; port++) void connect(`http://127.0.0.1:${port}`);';
  const pair = "{method:'POST',signal:AbortSignal.timeout(3000)}";
  assert(source.includes(loop) && source.includes(pair), "Bundled browser bridge protocol changed");
  // Keep vendored extension intact; only this employee's generated copy can pair with its private bridge.
  return source.replace(loop, `void connect(${JSON.stringify(`http://127.0.0.1:${instance.port}`)});`)
    .replace(pair, `{method:'POST',headers:{Authorization:${JSON.stringify("Bearer " + instance.token)}},signal:AbortSignal.timeout(3000)}`);
}

export function headlessArguments(profile: string, extension: string) {
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--password-store=basic",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "about:blank",
  ];
  return args;
}

async function loadExtension(child: ChildProcess, path: string) {
  const input = child.stdio[3] as Duplex, output = child.stdio[4] as Duplex;
  await new Promise<void>((resolve, reject) => {
    let pending = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      output.off("data", receive);
      child.off("exit", exited);
      input.off("error", finish);
      error ? reject(error) : resolve();
    };
    const exited = () => finish(Error("Chromium exited while loading the employee extension"));
    const receive = (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.length > 1024 * 1024) return finish(Error("Chromium startup response exceeds limit"));
      let end: number;
      while ((end = pending.indexOf("\0")) >= 0) {
        const raw = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const reply = JSON.parse(raw);
          if (reply.id === 1) {
            finish(reply.error ? Error("加载员工扩展失败：" + reply.error.message) : undefined);
          }
        } catch { finish(Error("Invalid Chromium startup response")); }
      }
    };
    const timer = setTimeout(() => finish(Error("Chromium extension startup timeout")), 10000);
    child.once("exit", exited);
    input.once("error", finish);
    output.on("data", receive);
    input.write(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path } }) + "\0");
  });
}

function chromeBinary(): string | undefined {
  if (process.env.VEGA_CHROME_PATH && existsSync(process.env.VEGA_CHROME_PATH))
    return process.env.VEGA_CHROME_PATH;
  const local = process.env.LOCALAPPDATA || "";
  const candidates =
    platform() === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          join(local, "Google/Chrome/Application/chrome.exe"),
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.find(existsSync);
}

// A server-private headless Chrome with the same bundled extension protocol:
// independent tabs, no user desktop, no visible window. Profile persists next
// to the database so cookies/logins survive restarts.
export class HeadlessBrowser {
  child?: ChildProcess;
  dir?: string;
  async start(dbPath: string, instance?: PrivateBrowser) {
    if (!instance && (
      process.env.VEGA_BROWSER_MODE !== "isolated" ||
      process.env.VEGA_CHROMIUM_EXTERNAL === "1"
    ))
      return;
    if (this.child) return;
    const binary = chromeBinary();
    if (!binary) {
      if (instance) throw Error("员工浏览器找不到 Chromium；请配置 VEGA_CHROME_PATH");
      console.warn(
        "[Vega] VEGA_BROWSER_MODE=isolated but no Chrome/Chromium binary found; set VEGA_CHROME_PATH",
      );
      return;
    }
    this.dir = instance?.profile || join(dirname(resolve(dbPath)), "chromium");
    await mkdir(this.dir, { recursive: true });
    let extension = extensionDirectory();
    if (instance) {
      const source = extension;
      extension = join(this.dir, "vega-extension");
      await rm(extension, { recursive: true, force: true });
      await cp(source, extension, { recursive: true });
      const worker = `employee-${randomUUID()}.js`;
      const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
      manifest.background.service_worker = worker;
      await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
      // A fresh script URL prevents Chromium's service-worker cache from retaining an old bridge address.
      await writeFile(join(extension, worker), privateWorker(await readFile(join(source, "worker.js"), "utf8"), instance), { mode: 0o600 });
    }
    const args = headlessArguments(this.dir, extension);
    if (instance) {
      args.splice(args.indexOf("--remote-debugging-port=0"), 1, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging");
      args.splice(args.findIndex((arg) => arg.startsWith("--disable-extensions-except=")), 1);
      args.splice(args.findIndex((arg) => arg.startsWith("--load-extension=")), 1);
    }
    if (process.env.VEGA_CHROMIUM_NO_SANDBOX === "1" || platform() === "win32")
      args.unshift("--no-sandbox");
    this.child = spawn(binary, args, {
      stdio: instance ? ["ignore", "ignore", "ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
      detached: platform() !== "win32",
    });
    const child = this.child;
    child.unref();
    child.once("error", () => { if (this.child === child) this.child = undefined; });
    child.once("exit", () => { if (this.child === child) this.child = undefined; });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (instance) {
      try { await loadExtension(child, extension); }
      catch (error) { await this.close(); throw error; }
    }
  }
  async close() {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    const pipe = child.stdio[3] as Duplex | null;
    if (pipe?.writable && !pipe.destroyed) {
      pipe.once("error", () => child.kill());
      pipe.write(JSON.stringify({ id: 99, method: "Browser.close" }) + "\0");
    } else child.kill();
    await new Promise<void>((yes) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        yes();
      }, 4000);
      if (child.exitCode !== null) {
        clearTimeout(timer);
        yes();
      } else
        child.once("exit", () => {
          clearTimeout(timer);
          yes();
        });
    });
    // Profiles contain persistent login state; stopping a process must never delete them.
  }
}
