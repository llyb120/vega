import { dirname, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { Store } from "./store";
import { Chrome } from "./chrome";
import { ChromeBridge } from "./chrome-bridge";
import { HeadlessBrowser } from "./headless";
import { assert, sleep } from "./util";

// One persistent profile and private, authenticated bridge per employee.
export class EmployeeBrowsers {
  entries = new Map<string, { chrome: Chrome; browser: HeadlessBrowser; starting?: Promise<Chrome>; stopping?: boolean }>();
  closed = false;
  removed = new Set<string>();
  constructor(public store: Store, public pageScript: string) {}
  profile(id: string) {
    assert(/^(default|e[a-zA-Z0-9_-]+)$/.test(id), "Invalid employee browser ID");
    return join(dirname(resolve(process.env.VEGA_DB || "vega.db")), "employee-browsers", id);
  }
  peek(id: string) { return this.entries.get(id)?.chrome; }
  async get(id: string): Promise<Chrome> {
    assert(!this.closed && !this.removed.has(id), "Browser manager stopped or employee deleted");
    let entry = this.entries.get(id);
    if (!entry) {
      this.profile(id);
      entry = { chrome: new Chrome(this.store, new ChromeBridge(true), this.pageScript, "experience:" + id), browser: new HeadlessBrowser() };
      this.entries.set(id, entry);
    }
    assert(!entry.stopping, "Employee browser is stopping");
    if (entry.starting) return entry.starting;
    const current = entry;
    current.starting = (async () => {
      if (!current.browser.child) {
        current.chrome.observations.clear();
        current.chrome.bridge.close();
        assert(!this.closed && !current.stopping, "Browser manager stopped");
        await current.chrome.bridge.start();
        await current.browser.start(process.env.VEGA_DB || "vega.db", {
          profile: this.profile(id), port: current.chrome.bridge.port, token: current.chrome.bridge.token,
        });
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
            return current.chrome;
          } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        }
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
    entry.stopping = false;
  }
  async remove(id: string) {
    this.removed.add(id);
    try {
      await this.stop(id);
      await rm(this.profile(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      this.entries.delete(id);
    } catch (error) { this.removed.delete(id); throw error; }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }
}
