import { randomUUID } from "node:crypto";
import { Chrome } from "./chrome";
import { ChromeBridge } from "./chrome-bridge";
import { LocalAgentUnavailable, type Agent, type LocalAgents } from "./local-agent";
import type { Store, Session } from "./store";
import type { Obj } from "./util";

class LocalBridge extends ChromeBridge {
  private info = super.status();
  readonly lease = randomUUID();
  constructor(private hub: LocalAgents, readonly agent: Agent) { super(); }
  private async send(operation: string, args: Obj, signal = new AbortController().signal) {
    const r = await this.hub.request(this.agent, "browser", { session: this.lease, operation, args }, signal);
    if (r.error) {
      if (r.error === "Unknown operation") throw new LocalAgentUnavailable("所选客户端版本不支持本地浏览器，请升级客户端并重新加载 Vega Chrome 扩展后继续；不会改用服务端浏览器。");
      if (["busy", "unavailable"].includes(r.status)) throw new LocalAgentUnavailable(r.error);
      throw Error(r.error);
    }
    return r.result;
  }
  async claim(signal?: AbortSignal) { this.info = await this.send("acquire", {}, signal); }
  async release() { await this.send("release", {}, AbortSignal.timeout(5000)); }
  async start() { this.info = await this.send("status", {}); }
  status() { return this.info; }
  request(operation: string, args: Obj, signal?: AbortSignal) { return this.send(operation, args, signal); }
  close() { /* Native browser and its login data belong to the user. */ }
}

export class LocalBrowsers {
  private sessions = new Map<string, { agent: Agent; chrome: Chrome; held: boolean }>();
  constructor(private store: Store, private hub: LocalAgents, private pageScript: string) {}
  async get(session: Session, signal?: AbortSignal) {
    const clientId = session.browserClientId || session.clientId;
    if (!clientId) throw new LocalAgentUnavailable("此会话尚未绑定本机浏览器客户端；不会自动选择设备或使用服务端浏览器。");
    const agent = this.hub.active(session.ownerId, clientId);
    if (!agent) throw new LocalAgentUnavailable();
    let entry = this.sessions.get(session.id);
    if (!entry || entry.agent !== agent) {
      if (entry) await this.release(session.id, true);
      const bridge = new LocalBridge(this.hub, agent);
      const chrome = new Chrome(this.store, bridge, this.pageScript, "experience:client:" + agent.clientId);
      const shared = [...this.sessions.values()].find(value => value.agent === agent);
      // Navigation affects every session on this browser; observation keys still isolate input ownership.
      if (shared) chrome.observations = shared.chrome.observations;
      chrome.workspaceFile = async (cwd, path) => {
        const r = await bridge.request("workspace_file", { cwd, path });
        if (typeof r.path !== "string") throw Error("Invalid local upload path");
        return r.path;
      };
      this.sessions.set(session.id, entry = { agent, chrome, held: false });
    }
    // The native client owns the lease across accounts, servers and the whole model turn.
    const bridge = entry.chrome.bridge as LocalBridge;
    agent.browserLeases.add(bridge.lease);
    try { await bridge.claim(signal); }
    catch (error) { agent.browserLeases.delete(bridge.lease); throw error; }
    entry.held = true;
    return entry.chrome;
  }
  peek(key: string) { return this.sessions.get(key)?.chrome; }
  async release(key: string, remove = false) {
    const entry = this.sessions.get(key);
    if (remove) {
      this.sessions.delete(key);
      if (entry) for (const observationKey of entry.chrome.observations.keys())
        if (observationKey.startsWith(key + ":")) entry.chrome.observations.delete(observationKey);
    }
    if (entry) entry.agent.browserLeases.delete((entry.chrome.bridge as LocalBridge).lease);
    if (!entry?.held) return;
    if (this.hub.active(entry.agent.userId, entry.agent.clientId) !== entry.agent) { entry.held = false; return; }
    try { await (entry.chrome.bridge as LocalBridge).release(); }
    finally { entry.held = false; }
  }
  async close() {
    await Promise.allSettled([...this.sessions.keys()].map((key) => this.release(key, true)));
  }
}
