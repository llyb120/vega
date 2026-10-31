import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";

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
  async start(dbPath: string) {
    if (process.env.VEGA_BROWSER_MODE !== "isolated") return;
    if (this.child) return;
    const binary = chromeBinary();
    if (!binary) {
      console.warn(
        "[Vega] VEGA_BROWSER_MODE=isolated but no Chrome/Chromium binary found; set VEGA_CHROME_PATH",
      );
      return;
    }
    this.dir = join(dirname(resolve(dbPath)), "chromium");
    await mkdir(this.dir, { recursive: true });
    const extension = resolve("extensions/nova-chrome"),
      args = headlessArguments(this.dir, extension);
    if (process.env.VEGA_CHROMIUM_NO_SANDBOX === "1" || platform() === "win32")
      args.unshift("--no-sandbox");
    this.child = spawn(binary, args, {
      stdio: "ignore",
      windowsHide: true,
      detached: platform() !== "win32",
    });
    this.child.unref();
    this.child.once("exit", (code) => {
      console.warn(`[Vega] Isolated headless browser exited (${code})`);
      this.child = undefined;
    });
  }
  async close() {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.kill();
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
    if (this.dir && platform() !== "win32")
      await rm(this.dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }).catch(() => {});
  }
}
