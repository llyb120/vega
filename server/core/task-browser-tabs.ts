import type { Chrome } from "./chrome";
import type { Session, Store } from "./store";

const TABS = "task-browser-tab", INDEX = "task-browser-tabs";
export const taskTabsFinished = (status: string) => ["done", "cancelled", "sealed"].includes(status);
export const taskTabsProtected = (status: string) =>
  ["running", "queued", "recovering", "deferred", "waiting", "approval"].includes(status);
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

  private snapshotSession(session: Session): Session {
    // Keep the browser's location at creation: the task can later be handed to another machine.
    const { id, title, cwd, taskId, employeeId, ownerId, localAgent, localBrowser, clientId, browserClientId, localPlatform, createdAt } = session;
    return { id, title, cwd, taskId, employeeId, ownerId, localAgent, localBrowser, clientId, browserClientId, localPlatform, createdAt };
  }

  private async isTaskProtected(taskId: string, employeeId?: string): Promise<boolean> {
    const row = await this.store.employeeTask(taskId);
    if (!row) return !!(employeeId && this.busy(taskId, employeeId));
    return taskTabsProtected(row.task.status) || this.busy(taskId, row.employee);
  }

  async ownerOf(tag: string, requesterTaskId: string | undefined): Promise<string | undefined> {
    if (!tag) return undefined;
    const current = await this.store.object<OwnedTab>(TABS, tag);
    if (!current || current.closing || (requesterTaskId && current.taskId === requesterTaskId)) return undefined;
    return (await this.isTaskProtected(current.taskId, current.session.employeeId)) ? current.taskId : undefined;
  }

  async blockedTags(tags: string[], requesterTaskId: string | undefined): Promise<Set<string>> {
    const blocked = new Set<string>();
    if (!tags.length) return blocked;
    const cache = new Map<string, boolean>();
    for (const tag of tags) {
      if (!tag) continue;
      const current = await this.store.object<OwnedTab>(TABS, tag);
      if (!current || current.closing || (requesterTaskId && current.taskId === requesterTaskId)) continue;
      let protectedOwner = cache.get(current.taskId);
      if (protectedOwner === undefined) {
        protectedOwner = await this.isTaskProtected(current.taskId, current.session.employeeId);
        cache.set(current.taskId, protectedOwner);
      }
      if (protectedOwner) blocked.add(tag);
    }
    return blocked;
  }

  private async attach(session: Session, tag: string, shared: boolean) {
    const taskId = session.taskId;
    if (!taskId || !tag || tag.length > 200) return;
    const saved = this.snapshotSession(session);
    await this.store.transaction(async () => {
      const existing = await this.store.object<OwnedTab>(TABS, tag);
      if (existing) {
        if (existing.taskId === taskId) return;
        if (await this.isTaskProtected(existing.taskId, existing.session.employeeId)) return;
        const oldIndex = await this.store.object<{ taskId: string; tags: string[] }>(INDEX, existing.taskId);
        if (oldIndex) {
          oldIndex.tags = oldIndex.tags.filter((value) => value !== tag);
          if (oldIndex.tags.length) await this.store.save(INDEX, existing.taskId, oldIndex);
          else await this.store.remove(INDEX, existing.taskId);
        }
      }
      const index = await this.store.object<{ taskId: string; tags: string[] }>(INDEX, taskId);
      const tags = index?.tags.includes(tag) ? index.tags : [...(index?.tags || []), tag];
      await this.store.save(TABS, tag, { taskId, tag, session: saved, ...(shared ? { shared: true } : {}) } satisfies OwnedTab);
      await this.store.save(INDEX, taskId, { taskId, tags });
    });
  }

  async opened(session: Session, tag: string) {
    await this.attach(session, tag, false);
  }

  /** A person inspecting or controlling a task-created page takes it out of automatic cleanup without releasing task lock. */
  async protect(tag: string) {
    if (!tag) return;
    const current = await this.store.object<OwnedTab>(TABS, tag);
    if (!current || current.shared) return;
    await this.store.transaction(async () => {
      const latest = await this.store.object<OwnedTab>(TABS, tag);
      if (latest && !latest.shared) await this.store.save(TABS, tag, { ...latest, shared: true });
    });
  }

  async closed(taskId: string | undefined, tag: string) {
    if (!tag) return;
    const current = await this.store.object<OwnedTab>(TABS, tag);
    if (current && (!taskId || current.taskId === taskId)) await this.forget(current.taskId, tag);
  }

  /**
   * Track tab usage for a task or session:
   * - Active/waiting/sleeping task tabs cannot be hijacked by another task or non-task session.
   * - Pre-existing unowned tabs are reserved (`shared: true`) while the task is active so it will never auto-close them,
   *   yet other tasks cannot hijack them until this task ends.
   * - Tabs of ended tasks (e.g. stopped/failed/done before cleanup) can be taken over (`shared: true` preserves them).
   */
  async used(owner: Session | string | undefined, tag: string) {
    if (!tag) return;
    if (owner === undefined) {
      await this.protect(tag);
      return;
    }
    const taskId = typeof owner === "string" ? owner : owner.taskId;
    const session = typeof owner === "object" ? owner : undefined;
    const current = await this.store.object<OwnedTab>(TABS, tag);
    if (current) {
      if (taskId && current.taskId === taskId) return;
      if (!current.closing && await this.isTaskProtected(current.taskId, current.session.employeeId)) {
        throw Error(`标签 ${tag} 正由另一个未完成/等待中的任务（${current.taskId}）占用，不能跨任务抢占；请用 browser_tabs(action="open") 新开你自己的独立标签，或只操作本任务已打开的标签。`);
      }
      if (session?.taskId) {
        await this.attach(session, tag, true);
        return;
      }
      if (!current.shared) {
        await this.store.transaction(async () => {
          const latest = await this.store.object<OwnedTab>(TABS, tag);
          if (latest && !latest.shared && latest.taskId !== taskId) await this.store.save(TABS, tag, { ...latest, shared: true });
        });
      }
      return;
    }
    if (session?.taskId) {
      await this.attach(session, tag, true);
    }
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
