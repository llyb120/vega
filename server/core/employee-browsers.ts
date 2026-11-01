import { dirname, join, resolve } from "node:path";
import type { Store } from "./store";
import { Chrome } from "./chrome";
import { ChromeBridge } from "./chrome-bridge";
import { HeadlessBrowser } from "./headless";
import { assert, sleep } from "./util";

// One persistent profile and private, authenticated bridge per employee.
export class EmployeeBrowsers {
  entries = new Map<string, { chrome: Chrome; browser: HeadlessBrowser; starting?: Promise<Chrome>; stopping?: boolean }>();
  closed = false;
  constructor(public store: Store, public pageScript: string) {}
  profile(id: string) {
    assert(/^(default|e[a-zA-Z0-9_-]+)$/.test(id), "Invalid employee browser ID");
    return join(dirname(resolve(process.env.VEGA_DB || "vega.db")), "employee-browsers", id);
  }
  peek(id: string) { return this.entries.get(id)?.chrome; }
  async get(id: string): Promise<Chrome> {
    assert(!this.closed, "Browser manager stopped");
    let entry = this.entries.get(id);
    if (!entry) {
      this.profile(id);
      entry = { chrome: new Chrome(this.store, new ChromeBridge(true), this.pageScript, "experience:" + id), browser: new HeadlessBrowser() };
      this.entries.set(id, entry);
    }
    assert(!entry.stopping, "Employee browser is stopping");
    if (entry.starting) return entry.starting;
    if (entry.browser.child && entry.chrome.bridge.status().connected) return entry.chrome;
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
      for (let attempt = 0; attempt < 100; attempt++) {
        assert(!this.closed && !current.stopping && current.browser.child, "Employee browser exited before connecting");
        if (current.chrome.bridge.status().connected) return current.chrome;
        await sleep(100);
      }
      await current.browser.close();
      current.chrome.bridge.close();
      throw Error("员工浏览器连接超时；可在原任务内恢复，不会重放页面操作");
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
  async close() {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }
}
