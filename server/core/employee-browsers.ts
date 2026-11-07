import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Store } from "./store";
import { Chrome } from "./chrome";
import { ChromeBridge } from "./chrome-bridge";
import { HeadlessBrowser } from "./headless";
import { assert, sleep, workspaceFile } from "./util";
import { cloudEnabled, type CloudRuntime } from "./cloud";
import { BRIDGE_MAX_BYTES } from "./file-bridge";

type StartFailure = { count: number; error: string; at: number; retryAt: number };

// One persistent Chromium + profile per owner (user_*). An owner's employees share it so tabs/logins stay in that user's profile only.
export class EmployeeBrowsers {
  entries = new Map<string, { chrome: Chrome; browser: HeadlessBrowser; cloud?: CloudRuntime; profile?: string; starting?: Promise<Chrome>; stopping?: boolean; probedAt?: number; failure?: StartFailure }>();
  static PROBE_TTL_MS = 3000;
  // After the 2nd consecutive failed launch, wait before respawning so each chrome_* call does not relaunch a dying Chromium.
  static BACKOFF_MS = [5000, 15000, 60000];
  closed = false;
  removed = new Set<string>();
  constructor(public store: Store, public pageScript: string, private networkProxy?: (id: string) => Promise<string | undefined>, private isolation?: (id: string) => Promise<CloudRuntime | undefined>) {}
  profile(id: string) {
    assert(/^(default|e[a-zA-Z0-9_-]+|user_[a-zA-Z0-9_-]+)$/.test(id), "Invalid browser profile ID");
    return join(dirname(resolve(process.env.VEGA_DB || "vega.db")), "employee-browsers", id);
  }
  peek(id: string) { return this.entries.get(id)?.chrome; }
  /** Last failed private-browser launch (cleared on success), for chrome_connection status. */
  failure(id: string) {
    const failure = this.entries.get(id)?.failure;
    return failure && { error: failure.error, failures: failure.count, at: new Date(failure.at).toISOString(), retryAfterSeconds: Math.max(0, Math.ceil((failure.retryAt - Date.now()) / 1000)) };
  }
  async get(id: string): Promise<Chrome> {
    assert(!this.closed && !this.removed.has(id), "Browser manager stopped or employee deleted");
    let entry = this.entries.get(id);
    if (!entry) {
      this.profile(id);
      entry = { chrome: new Chrome(this.store, new ChromeBridge(true), this.pageScript, "experience:" + id), browser: new HeadlessBrowser() };
      this.entries.set(id, entry);
    }
    assert(!entry.stopping, "Employee browser is stopping");
    if (
      entry.browser.child &&
      entry.chrome.bridge.status().connected &&
      entry.probedAt &&
      Date.now() - entry.probedAt < EmployeeBrowsers.PROBE_TTL_MS &&
      !entry.starting
    ) {
      return entry.chrome;
    }
    if (entry.starting) return entry.starting;
    const current = entry;
    current.starting = (async () => {
      if (!current.browser.child) {
        const failure = current.failure;
        if (failure && failure.retryAt > Date.now())
          throw Error(`${failure.error}；已连续失败 ${failure.count} 次，${Math.ceil((failure.retryAt - Date.now()) / 1000)} 秒后才会再次尝试启动`);
        current.chrome.observations.clear();
        current.chrome.bridge.close();
        current.probedAt = undefined;
        assert(!this.closed && !current.stopping, "Browser manager stopped");
        try {
          current.cloud = await this.isolation?.(id);
          current.profile = current.cloud ? join((await current.cloud.identity()).home, "browsers", id) : this.profile(id);
          // Only the cloud workspace uses this. A client workspace is staged via stageForBrowser from client bytes;
          // resolving the client's cwd here would read a same-named directory on the server.
          if (current.cloud) current.chrome.workspaceFile = (cwd, file) => workspaceFile(cwd, file, current.cloud!.fs);
          await current.chrome.bridge.start();
          await current.browser.start(process.env.VEGA_DB || "vega.db", {
            profile: current.profile, port: current.chrome.bridge.port, token: current.chrome.bridge.token, proxy: await this.networkProxy?.(id),
          }, current.cloud);
        } catch (error) {
          if (this.closed || current.stopping) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const count = (failure?.count || 0) + 1, delays = EmployeeBrowsers.BACKOFF_MS;
          const wait = count < 2 ? 0 : delays[Math.min(count - 2, delays.length - 1)];
          current.failure = { count, at: Date.now(), retryAt: Date.now() + wait,
            error: message.startsWith("牛马浏览器") ? message : "牛马浏览器启动失败：" + message };
          throw Error(current.failure.error + (wait ? `；已连续失败 ${count} 次，${wait / 1000} 秒后才会再次尝试启动` : ""));
        }
        current.failure = undefined;
      }
      const deadline = Date.now() + 30000;
      let failure = "扩展未连接";
      while (Date.now() < deadline) {
        assert(!this.closed && !current.stopping && current.browser.child, "Employee browser exited before connecting");
        if (current.chrome.bridge.status().connected) {
          try {
            // A cached heartbeat is not readiness; only this read-only probe may be retried.
            await current.chrome.bridge.request("status", {});
            assert(!this.closed && !current.stopping && current.browser.child, "Employee browser stopped while connecting");
            current.probedAt = Date.now();
            return current.chrome;
          } catch (error) {
            current.probedAt = undefined;
            failure = error instanceof Error ? error.message : String(error);
          }
        } else current.probedAt = undefined;
        await sleep(100);
      }
      throw Error(`牛马浏览器连接暂不可用：${failure}；已保留浏览器和页面，下次使用会继续恢复，不会重放页面操作`);
    })().finally(() => { current.starting = undefined; });
    return current.starting;
  }
  async stop(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.stopping = true;
    await entry.starting?.catch(() => {});
    await entry.browser.close();
    entry.chrome.bridge.close();
    entry.chrome.observations.clear();
    entry.probedAt = undefined;
    entry.failure = undefined;
    entry.stopping = false;
  }
  async remove(id: string) {
    this.removed.add(id);
    try {
      await this.stop(id);
      const cloud = this.entries.get(id)?.cloud || await this.isolation?.(id);
      const profile = cloud ? join((await cloud.identity()).home, "browsers", id) : this.profile(id);
      await (cloud?.fs || { rm }).rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      this.entries.delete(id);
    } catch (error) { this.removed.delete(id); throw error; }
  }
  /** Directories a cloud-browser download may be read from. Client cwd is intentionally not one of them. */
  downloadRoots(id: string) {
    const entry = this.entries.get(id);
    const profile = entry?.browser.dir || entry?.profile || this.profile(id);
    return [profile, join(profile, "downloads"), join(profile, "bridge-inbox")];
  }
  /**
   * Materialise client bytes where this owner's cloud browser can read them.
   * The destination is under the browser profile (or the isolation tmp), never the session cwd.
   */
  async stageForBrowser(id: string, name: string, data: Buffer) {
    assert(Buffer.isBuffer(data) && data.length > 0 && data.length <= BRIDGE_MAX_BYTES, "暂存文件为空或超过 32MiB");
    const entry = this.entries.get(id);
    if (cloudEnabled() && !entry?.cloud) throw Error("云端隔离浏览器尚未就绪，不会把文件写到服务器上的同名工作目录");
    const safe = (name.split(/[/\\]/).pop() || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
    const fs = entry?.cloud?.fs || { mkdir, writeFile };
    const root = entry?.cloud ? join((await entry.cloud.identity()).tmp, "vega-bridge") : join(entry?.browser.dir || this.profile(id), "bridge-inbox");
    const dir = join(root, randomUUID());
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, safe);
    await fs.writeFile(file, data);
    return file;
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }
}
