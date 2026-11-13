import type { Chrome } from "./chrome";
import type { Session, Store } from "./store";

const TABS = "task-browser-tab", INDEX = "task-browser-tabs";
export const taskTabsFinished = (status: string) => ["done", "cancelled", "sealed"].includes(status);
type OwnedTab = { taskId: string; tag: string; session: Session; shared?: boolean; closing?: boolean };

/** Only tabs known to have been created by a task are candidates for cleanup. */
export class TaskBrowserTabs {
  private pending = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private held = new Map<string, number>();
  private stopped = false;
  constructor(
    private store: Store,
    private browser: (session: Session) => Promise<Chrome | undefined>,
    private release: (session: Session) => Promise<void>,
    private busy: (taskId: string, employeeId: string) => boolean,
  ) {}

  async opened(session: Session, tag: string) {
    if (!session.taskId || !tag || tag.length > 200) return;
    // Keep the browser's location at creation: the task can later be handed to another machine.
    const { id, title, cwd, taskId, employeeId, ownerId, localAgent, localBrowser, clientId, browserClientId, localPlatform, createdAt } = session;
    const saved: Session = { id, title, cwd, taskId, employeeId, ownerId, localAgent, localBrowser, clientId, browserClientId, localPlatform, createdAt };
    await this.store.transaction(async () => {
      const existing = await this.store.object<OwnedTab>(TABS, tag);
      if (existing) return;
      const index = await this.store.object<{ taskId: string; tags: string[] }>(INDEX, taskId!);
      await this.store.save(TABS, tag, { taskId, tag, session: saved } satisfies OwnedTab);
      await this.store.save(INDEX, taskId!, { taskId, tags: [...(index?.tags || []), tag] });
    });
  }

  /** A different task or a person has taken over this page: never close it automatically. */
  async used(taskId: string | undefined, tag: string) {
    const current = await this.store.object<OwnedTab>(TABS, tag);
    if (!current || current.shared || current.taskId === taskId) return;
    await this.store.transaction(async () => {
      const latest = await this.store.object<OwnedTab>(TABS, tag);
      if (latest && !latest.shared && latest.taskId !== taskId) await this.store.save(TABS, tag, { ...latest, shared: true });
    });
  }

  private async forget(taskId: string, tag: string) {
    await this.store.transaction(async () => {
      const current = await this.store.object<OwnedTab>(TABS, tag);
      if (current?.taskId === taskId) await this.store.remove(TABS, tag);
      const index = await this.store.object<{ taskId: string; tags: string[] }>(INDEX, taskId);
      if (!index) return;
      index.tags = index.tags.filter((value) => value !== tag);
      if (index.tags.length) await this.store.save(INDEX, taskId, index);
      else await this.store.remove(INDEX, taskId);
    });
  }

  async hold(taskId: string) {
    this.held.set(taskId, (this.held.get(taskId) || 0) + 1);
    await this.running.get(taskId);
    return () => {
      const count = (this.held.get(taskId) || 1) - 1;
      if (count) this.held.set(taskId, count);
      else {
        this.held.delete(taskId);
        if (this.pending.has(taskId)) this.finish(taskId);
      }
    };
  }
  finish(taskId: string) {
    if (this.stopped) return;
    this.pending.add(taskId);
    if (this.held.has(taskId)) return;
    const current = this.running.get(taskId);
    if (current) {
      void current.then(() => { if (!this.stopped && this.pending.has(taskId)) this.finish(taskId); });
      return;
    }
    const work = this.cleanup(taskId).catch((error) => {
      this.pending.add(taskId);
      console.warn("[Vega] task tab cleanup deferred:", String(error?.message || error));
    }).finally(() => { this.running.delete(taskId); });
    this.running.set(taskId, work);
  }
  retry() { if (!this.stopped) for (const taskId of this.pending) this.finish(taskId); }
  async restore() {
    for (const index of await this.store.objects<{ taskId: string }>(INDEX)) this.finish(index.taskId);
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.running.values()]);
  }

  private async state(taskId: string, employeeId?: string) {
    const row = await this.store.employeeTask(taskId);
    if (!row) return employeeId && this.busy(taskId, employeeId) ? "busy" : "ended";
    if (!taskTabsFinished(row.task.status)) return "active";
    return this.busy(taskId, row.employee) ? "busy" : "ended";
  }
  private async cleanup(taskId: string) {
    this.pending.delete(taskId);
    const state = await this.state(taskId);
    if (state === "busy") { this.pending.add(taskId); return; }
    if (state === "active") return;
    const index = await this.store.object<{ taskId: string; tags: string[] }>(INDEX, taskId);
    for (const tag of index?.tags || []) {
      const tab = await this.store.object<OwnedTab>(TABS, tag);
      if (!tab || tab.taskId !== taskId || tab.shared || tab.closing) {
        await this.forget(taskId, tag);
        continue;
      }
      let chrome: Chrome | undefined;
      try {
        chrome = await this.browser(tab.session);
        if (!chrome || !chrome.bridge.status().connected) { this.pending.add(taskId); continue; }
        await chrome.tabGate(tag).run(async () => {
          const current = await this.store.object<OwnedTab>(TABS, tag);
          if (!current || current.taskId !== taskId || current.shared || current.closing) { await this.forget(taskId, tag); return; }
          const currentState = await this.state(taskId, tab.session.employeeId);
          if (currentState !== "ended" || this.held.has(taskId)) {
            if (currentState === "busy" || this.held.has(taskId)) this.pending.add(taskId);
            return;
          }
          const signal = AbortSignal.timeout(10000);
          const { tabs } = await chrome!.bridge.request("tabs", {}, signal);
          if (this.held.has(taskId) || await this.state(taskId, tab.session.employeeId) !== "ended") {
            if (this.held.has(taskId)) this.pending.add(taskId);
            return;
          }
          if (!tabs.some((item: { tag: string }) => item.tag === tag)) { await this.forget(taskId, tag); return; }
          // Mark before sending: an interrupted close is never blindly replayed.
          await this.store.save(TABS, tag, { ...current, closing: true });
          try { await chrome!.inner(tab.session.id, tab.session.cwd, { operation: "close_tab", tabTag: tag }, signal); }
          catch (error) { console.warn("[Vega] task tab close unconfirmed; not replaying:", String((error as Error)?.message || error)); }
          await this.forget(taskId, tag);
        });
      } catch (error) {
        this.pending.add(taskId);
        console.warn("[Vega] task tab cleanup deferred:", String((error as Error)?.message || error));
      } finally {
        if (chrome) await this.release(tab.session).catch(() => {});
      }
    }
  }
}
