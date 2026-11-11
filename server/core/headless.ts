import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readlink, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { hostname, platform } from "node:os";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { assert, sleep } from "./util";
import * as filesystem from "node:fs/promises";
import type { CloudRuntime } from "./cloud";

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

type PrivateBrowser = { profile: string; port: number; token: string; proxy?: string };
export function privateWorker(source: string, instance: Pick<PrivateBrowser, "port" | "token">) {
  const loop = 'for (let port=47653; port<=47662; port++) void connect(`http://127.0.0.1:${port}`);';
  const pair = "{method:'POST',signal:AbortSignal.timeout(3000)}";
  assert(source.includes(loop) && source.includes(pair), "Bundled browser bridge protocol changed");
  // Keep vendored extension intact; only this employee's generated copy can pair with its private bridge.
  return source.replace(loop, `void connect(${JSON.stringify(`http://127.0.0.1:${instance.port}`)});`)
    .replace(pair, `{method:'POST',headers:{Authorization:${JSON.stringify("Bearer " + instance.token)}},signal:AbortSignal.timeout(3000)}`);
}

export function headlessArguments(profile: string, extension: string, network?: Pick<PrivateBrowser, "port" | "proxy">) {
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1920,1200",
    "--password-store=basic",
    // No "started debugging this browser" bar (headless shows it too): it shrank the viewport 56px on every attach.
    // Safe here: the private profile only runs the Nova extension.
    "--silent-debugger-extension-api",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "about:blank",
  ];
  if (network?.proxy) args.unshift(
    `--proxy-server=${network.proxy}`,
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${network.port}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  );
  return args;
}

const EXTENSION_STARTUP_MS = 10000;

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
            finish(reply.error ? Error("加载牛马扩展失败：" + reply.error.message) : undefined);
          }
        } catch { finish(Error("Invalid Chromium startup response")); }
      }
    };
    const timer = setTimeout(() => finish(Error("Chromium extension startup timeout")), EXTENSION_STARTUP_MS);
    child.once("exit", exited);
    input.once("error", finish);
    output.on("data", receive);
    input.write(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path } }) + "\0");
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; } };

// Every Chromium we spawned is its own process group (detached); killing the group takes renderers/zygote with it.
function killTree(pid: number, signal: NodeJS.Signals) {
  try { process.kill(platform() === "win32" ? pid : -pid, signal); return; } catch {}
  try { process.kill(pid, signal); } catch {}
}

// Last-resort guard: any Chromium still running when Node exits (crash, process.exit,
// graceful close timed out) is killed synchronously so it cannot hold its profile lock.
const running = new Set<ChildProcess>();
export function killBrowsersSync() {
  for (const child of running) if (child.pid && child.exitCode === null && child.signalCode === null) killTree(child.pid, "SIGKILL");
  running.clear();
}
let exitHook = false;

/**
 * A private profile locked by a Chromium left over from an earlier server process
 * (e.g. Node was SIGKILLed) makes every new instance exit with code 21. Linux only:
 * SingletonLock is a symlink "host-pid"; the holder is reclaimed only when it is on
 * this host, alive, and its cmdline uses exactly this --user-data-dir.
 */
export async function reclaimProfile(profile: string, cloud?: CloudRuntime): Promise<"none" | "stale" | "killed" | "foreign"> {
  const { readFile, readlink } = cloud?.fs || filesystem;
  const isAlive = async (pid: number) => cloud ? cloud.signal(pid, 0).then(() => true, (error: any) => error.code === "EPERM") : alive(pid);
  if (platform() !== "linux") return "none";
  let target: string;
  try { target = await readlink(join(profile, "SingletonLock")); } catch { return "none"; }
  const cut = target.lastIndexOf("-"), host = target.slice(0, cut), pid = Number(target.slice(cut + 1));
  if (host === hostname() && Number.isInteger(pid) && pid > 0 && await isAlive(pid)) {
    let cmdline: string;
    // Chromium rewrites its process title, so argv may appear as one space-joined string.
    try { cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ") + " "; } catch { return "foreign"; }
    // Never touch a process that is not a Chromium on this exact profile (pid reuse, other users' browsers).
    if (!cmdline.includes(` --user-data-dir=${profile} `)) return "foreign";
    let group = false;
    try { group = Number((await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[2]) === pid; } catch {}
    const kill = async (signal: NodeJS.Signals) => cloud ? cloud.signal(group ? -pid : pid, signal).catch(() => {}) : group ? killTree(pid, signal) : (() => { try { process.kill(pid, signal); } catch {} })();
    await kill("SIGTERM");
    for (let i = 0; i < 30 && await isAlive(pid); i++) await sleep(100);
    if (await isAlive(pid)) { await kill("SIGKILL"); for (let i = 0; i < 20 && await isAlive(pid); i++) await sleep(100); }
    if (await isAlive(pid)) return "foreign";
    await removeSingletons(profile, cloud);
    return "killed";
  }
  // Holder is gone, or the lock was written by another host name (container recreated
  // on the same volume): the profile belongs to this server only, so the lock is stale.
  await removeSingletons(profile, cloud);
  return "stale";
}
const removeSingletons = (profile: string, cloud?: CloudRuntime) =>
  Promise.all(["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) => (cloud?.fs || { rm }).rm(join(profile, name), { force: true })));

// Chromium's own words are the only clue when it stalls before answering; keep them in every failure report.
const stderrTail = (text: string) => text.trim().split("\n").slice(-12).join("\n").slice(-1500);
function startupError(code: number | null, signal: NodeJS.Signals | null, stderr: string, cause: unknown) {
  const tail = stderrTail(stderr);
  const parts = [`牛马浏览器 Chromium 启动即退出（${signal ? "signal " + signal : "code " + code}）`];
  // 21 = profile in use; 0 = handed off to a live Chromium already holding the profile.
  if (code === 21 || code === 0) parts.push("该牛马的浏览器配置目录正被残留 Chromium 占用（未能自动清理，请结束占用该目录的 chromium 进程后重试）");
  if (process.getuid?.() === 0 && process.env.VEGA_CHROMIUM_NO_SANDBOX !== "1")
    parts.push("当前以 root 运行且未关闭沙箱：Chromium 在 root 下必须设置环境变量 VEGA_CHROMIUM_NO_SANDBOX=1 后重启服务");
  parts.push(tail ? "stderr：" + tail : "无错误输出（原始错误：" + (cause instanceof Error ? cause.message : String(cause)) + "）");
  return Error(parts.join("；"));
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
  async start(dbPath: string, instance?: PrivateBrowser, cloud?: CloudRuntime) {
    const { mkdir, rm, cp, readFile, writeFile } = cloud?.fs || filesystem;
    if (!instance && (
      process.env.VEGA_BROWSER_MODE !== "isolated" ||
      process.env.VEGA_CHROMIUM_EXTERNAL === "1"
    ))
      return;
    if (this.child) return;
    const binary = chromeBinary();
    if (!binary) {
      if (instance) throw Error("牛马浏览器找不到 Chromium；请配置 VEGA_CHROME_PATH");
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
    const args = headlessArguments(this.dir, extension, instance);
    if (instance) {
      args.splice(args.indexOf("--remote-debugging-port=0"), 1, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging");
      args.splice(args.findIndex((arg) => arg.startsWith("--disable-extensions-except=")), 1);
      args.splice(args.findIndex((arg) => arg.startsWith("--load-extension=")), 1);
    }
    if (process.env.VEGA_CHROMIUM_NO_SANDBOX === "1" || platform() === "win32")
      args.unshift("--no-sandbox");
    if (instance) await reclaimProfile(this.dir, cloud);
    // Detached = own process group, so close/exit can kill the whole Chromium tree at once.
    const launch = cloud?.launch(binary, args, (await cloud.identity()).cwd, {}, !!instance);
    this.child = spawn(launch?.command || binary, launch?.args || args, {
      ...(launch ? { cwd: launch.cwd, env: launch.env } : {}),
      stdio: instance ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : "ignore",
      windowsHide: true,
      detached: platform() !== "win32",
    });
    const child = this.child;
    child.unref();
    running.add(child);
    if (!exitHook) { exitHook = true; process.once("exit", killBrowsersSync); }
    // A pipe reset when Chromium dies must never surface as an uncaught stream error.
    for (const stream of child.stdio) stream?.on("error", () => {});
    let stderr = "";
    // Always drain stderr (keep the last 4KB) so a chatty Chromium never blocks on a full pipe.
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.once("error", () => { running.delete(child); if (this.child === child) this.child = undefined; });
    child.once("exit", () => { running.delete(child); if (this.child === child) this.child = undefined; });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (instance) {
      try { await loadExtension(child, extension); }
      catch (error) {
        // A dead pipe (ECONNRESET/EPIPE) means Chromium is exiting: wait briefly for its exit status.
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((yes) => { const timer = setTimeout(yes, 2000); child.once("exit", () => { clearTimeout(timer); yes(); }); });
        const exited = child.exitCode !== null || child.signalCode !== null, tail = stderrTail(stderr);
        await this.close();
        // A live-but-silent Chromium is a hang or a cold start slower than the budget; losing its stderr
        // left every container failure reporting a bare "extension startup timeout".
        throw exited ? startupError(child.exitCode, child.signalCode, stderr, error)
          : Error(`牛马浏览器 Chromium ${EXTENSION_STARTUP_MS / 1000} 秒内没有响应扩展加载命令（进程仍在运行）` + (tail ? "；stderr：" + tail : "；无错误输出"));
      }
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
        if (child.pid) killTree(child.pid, "SIGKILL");
        running.delete(child);
        yes();
      }, 4000);
      if (child.exitCode !== null || child.signalCode !== null) {
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
