/** Background bash jobs: 10s yield, explicit polls and automatic result delivery. */
import type { BackgroundResult } from "./background-result";

export const BASH_YIELD_SECS = 60;
export const BASH_JOB_KEEP_MS = 60_000;

export type BashPoll =
  | { status: "running"; text: string; jobId: number }
  | { status: "finished"; text: string; jobId: number; exitCode?: number; error?: boolean };

export type BashJob = {
  id: number;
  session: string;
  waitable: boolean;
  startedAt: number;
  timeoutSecs: number;
  deadline: number;
  output: string;
  truncated: boolean;
  exitCode?: number;
  error?: string;
  done: boolean;
  cancelled: boolean;
  expired: boolean;
  dropped: boolean;
  polling?: boolean;
  releaseExecution?: () => void;
  redact?: (text: string) => string;
  kill: () => void | Promise<boolean>;
  /** Local-client poll; when set, the process lives on the client. */
  pollRemote?: (
    waitSecs: number,
    signal?: AbortSignal,
  ) => Promise<{ running: boolean; output?: string; truncated?: boolean; exitCode?: number; error?: string }>;
};

type Waiter = () => void;

const jobs = new Map<number, BashJob>();
const waiters = new Map<number, Set<Waiter>>();
const sessionWaiters = new Map<string, Set<Waiter>>();
const executions = new Map<string, Set<Promise<void>>>();
let seq = 1;

function trackExecution(session: string, exited: Promise<void>) {
  const active = executions.get(session) || new Set<Promise<void>>();
  executions.set(session, active);
  active.add(exited);
  const remove = () => { active.delete(exited); if (!active.size) executions.delete(session); };
  void exited.then(remove, remove);
}

export function bashWorkspaceIdle(session: string) {
  const active = executions.get(session);
  return active?.size ? Promise.allSettled(active).then(() => {}) : undefined;
}

export const bashExecutionSessions = () => executions.keys();

function killJob(job: BashJob) {
  try { void job.kill()?.then(confirmed => { if (confirmed) job.releaseExecution?.(); }, () => {}); }
  catch { /* already gone */ }
}

function notify(id: number, session?: string) {
  const list = waiters.get(id);
  if (list?.size) {
    waiters.delete(id);
    for (const fn of list) fn();
  }
  const s = session || jobs.get(id)?.session;
  if (s) {
    const sList = sessionWaiters.get(s);
    if (sList?.size) {
      sessionWaiters.delete(s);
      for (const fn of sList) fn();
    }
  }
}

function subscribe(id: number, fn: Waiter) {
  const list = waiters.get(id) || new Set<Waiter>();
  list.add(fn);
  waiters.set(id, list);
  return () => {
    list.delete(fn);
    if (!list.size && waiters.get(id) === list) waiters.delete(id);
  };
}

function subscribeSession(session: string, fn: Waiter) {
  const list = sessionWaiters.get(session) || new Set<Waiter>();
  list.add(fn);
  sessionWaiters.set(session, list);
  return () => {
    list.delete(fn);
    if (!list.size && sessionWaiters.get(session) === list) sessionWaiters.delete(session);
  };
}

function gc(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now < job.deadline + BASH_JOB_KEEP_MS) continue;
    job.dropped = true;
    if (!job.done) killJob(job);
    jobs.delete(id);
    notify(id, job.session);
  }
}

function expireJob(job: BashJob) {
  if (terminal(job)) return;
  job.expired = true;
  killJob(job);
  notify(job.id);
}

function watchdog(job: BashJob) {
  const delay = Math.max(0, job.deadline - Date.now());
  const timer = setTimeout(() => expireJob(job), delay);
  timer.unref?.();
}

export function createBashJob(opts: {
  session: string;
  waitable: boolean;
  timeoutSecs: number;
  startedAt?: number;
  kill: BashJob["kill"];
  exited?: Promise<void>;
  pollRemote?: BashJob["pollRemote"];
  output?: string;
  truncated?: boolean;
}): BashJob {
  gc();
  const timeoutSecs = Math.max(1, Math.min(600, opts.timeoutSecs | 0));
  const startedAt = opts.startedAt ?? Date.now();
  const job: BashJob = {
    id: seq++,
    session: opts.session,
    waitable: opts.waitable,
    startedAt,
    timeoutSecs,
    deadline: startedAt + timeoutSecs * 1000,
    output: opts.output || "",
    truncated: !!opts.truncated,
    done: false,
    cancelled: false,
    expired: false,
    dropped: false,
    kill: opts.kill,
    pollRemote: opts.pollRemote,
  };
  jobs.set(job.id, job);
  if (opts.exited) trackExecution(job.session, opts.exited);
  watchdog(job);
  return job;
}

export function retainRemoteBashExecution(job: BashJob) {
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  // shortcut: without an exit ack, keep the workspace through the client's hard timeout and reap allowance; replace the estimate when clients can push exit events.
  const releaseAt = setTimeout(resolveExit, (job.timeoutSecs + 5) * 1000);
  releaseAt.unref?.();
  job.releaseExecution = () => { clearTimeout(releaseAt); resolveExit(); };
  trackExecution(job.session, exited);
  if (job.cancelled || job.expired) killJob(job);
}

export function bashJob(id: number) {
  return jobs.get(id);
}

export function appendBashOutput(job: BashJob, text: string, truncated = false) {
  if (!text && !truncated) return;
  job.output = (job.output + text).slice(0, 2 << 20);
  if (truncated || job.output.length >= 2 << 20) job.truncated = true;
  notify(job.id);
}

export function completeBashJob(
  job: BashJob,
  result: { exitCode?: number; error?: string; output?: string; truncated?: boolean } = {},
) {
  if (job.done) return;
  job.done = true;
  if (result.output != null) job.output = result.output;
  if (result.truncated) job.truncated = true;
  if (result.exitCode != null) job.exitCode = result.exitCode;
  if (result.error != null) job.error = result.error;
  job.releaseExecution?.();
  notify(job.id);
}

/** Drop a job that already returned its result as a foreground tool outcome so auto-delivery will not send it again. */
export function consumeBashJob(job: BashJob) {
  job.done = true;
  job.dropped = true;
  jobs.delete(job.id);
  notify(job.id, job.session);
}

export function pendingBashAll(session: string): number[] {
  const ids = [...jobs.values()]
    .filter((job) => job.session === session && job.waitable && !job.dropped)
    .map((job) => job.id);
  ids.sort((a, b) => a - b);
  return ids;
}

export function pendingBash(session: string): number | undefined {
  return pendingBashAll(session)[0];
}

export function pendingBashFinished(session: string): boolean {
  const id = pendingBash(session);
  if (id == null) return false;
  const job = jobs.get(id);
  if (!job) return false;
  return job.done || job.cancelled || job.expired;
}

export function hasPendingBash(session: string) {
  return pendingBash(session) != null;
}

/** A yielded command is still running, so the workspace must not be checkpointed yet. */
export function bashRunning(session: string) {
  if (executions.has(session)) return true;
  for (const job of jobs.values())
    if (job.session === session && !job.dropped && !job.done && !job.cancelled && !job.expired) return true;
  return false;
}

function formatOutput(job: BashJob) {
  let text = job.output || "";
  if (job.truncated && !/truncated/i.test(text)) text += (text && !text.endsWith("\n") ? "\n" : "") + "[truncated]";
  if (job.exitCode && job.exitCode !== 0) {
    if (text && !text.endsWith("\n")) text += "\n";
    text += `Command exited with code ${job.exitCode}`;
  }
  return text.trim() ? text : "(no output)";
}

function timeoutText(job: BashJob) {
  let text = job.output || "";
  if (text && !text.endsWith("\n")) text += "\n";
  text += `命令超过 ${job.timeoutSecs}s 未结束，已终止`;
  return text;
}

function cancelText(job: BashJob) {
  let text = job.output || "";
  if (text && !text.endsWith("\n")) text += "\n";
  text += "命令已被取消，已终止";
  return text;
}

function runningText(id: number, tail: string) {
  let text = `后台任务 ${id} 仍在运行。它自己会跑完——现在去做别的事，别连续 poll；需要结果时再 poll 一次。`;
  if (tail.trim()) text += "\n--- 输出尾部 ---\n" + tail;
  return text;
}

const terminal = (job: BashJob) => job.done || job.cancelled || job.expired || job.dropped;

function waitForChange(job: BashJob, ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    const unsubscribe = subscribe(job.id, done);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted || terminal(job)) done();
  });
}

export async function pollBash(
  session: string,
  id: number,
  waitSecs = 30,
  signal?: AbortSignal,
  consume = true,
): Promise<BashPoll> {
  const job = jobs.get(id);
  if (!job || job.polling) throw new Error(`没有可查询的后台任务 ${id}：可能正被读取、已清理，或不属于本会话`);
  if (job.session !== session) throw new Error(`后台任务 ${id} 不属于本会话`);
  job.polling = true;
  try {
    if (Date.now() >= job.deadline) expireJob(job);
    const wait = Math.min(Math.max(1, waitSecs || 30), 600);
    if (!terminal(job) && job.pollRemote) {
      const remaining = Math.max(1, Math.ceil((job.deadline - Date.now()) / 1000));
      const result = await job.pollRemote(Math.min(wait, remaining), signal);
      if (!result.running) completeBashJob(job, result);
      else {
        if (result.output != null) job.output = result.output;
        if (result.truncated) job.truncated = true;
      }
    } else {
      const until = Math.min(job.deadline, Date.now() + wait * 1000);
      while (!terminal(job) && !signal?.aborted && Date.now() < until)
        await waitForChange(job, until - Date.now(), signal);
    }
    // When the poll timer beats the watchdog, returning "running" past the deadline would spin the waiter and starve the watchdog.
    if (Date.now() >= job.deadline) expireJob(job);
    const safe = job.redact || ((text: string) => text);
    if (!terminal(job)) return { status: "running", text: safe(runningText(id, job.output.slice(-4000))), jobId: id };
    const text = job.cancelled ? cancelText(job) : job.expired ? timeoutText(job) : job.error && !job.output ? job.error : formatOutput(job);
    const error = job.cancelled || job.expired || !!job.error || (job.exitCode != null && job.exitCode !== 0);
    if (consume && !signal?.aborted) consumeBashJob(job);
    return { status: "finished", text: safe(text), jobId: id, exitCode: job.exitCode, error };
  } finally { job.polling = false; }
}

/** Explicitly terminate a running background job and return its captured output. */
export function killBashJob(session: string, id: number): Extract<BashPoll, { status: "finished" }> {
  const job = jobs.get(id);
  if (!job) throw new Error(`没有可终止的后台任务 ${id}：可能已完成、已清理，或不属于本会话`);
  if (job.session !== session) throw new Error(`后台任务 ${id} 不属于本会话`);
  const safe = job.redact || ((text: string) => text);
  if (!terminal(job)) {
    job.cancelled = true;
    killJob(job);
    notify(job.id, job.session);
  }
  const text = job.cancelled ? cancelText(job) : job.expired ? timeoutText(job) : job.error && !job.output ? job.error : formatOutput(job);
  const error = job.cancelled || job.expired || !!job.error || (job.exitCode != null && job.exitCode !== 0);
  consumeBashJob(job);
  return { status: "finished", text: safe(text), jobId: id, exitCode: job.exitCode, error };
}

/** Pure event wait until any waitable job for `session` finishes (or disappears), or signal/interrupted fires. */
export function waitBashReady(session: string, signal?: AbortSignal, interrupted?: () => boolean): Promise<void> {
  if (signal?.aborted || interrupted?.() || pendingBash(session) == null || pendingBashFinished(session))
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const check = () => {
      if (signal?.aborted || interrupted?.() || pendingBash(session) == null || pendingBashFinished(session)) {
        cleanup();
        resolve();
      }
    };
    let unsub = subscribeSession(session, () => {
      if (signal?.aborted || interrupted?.() || pendingBash(session) == null || pendingBashFinished(session)) {
        cleanup();
        resolve();
      } else {
        // Re-subscribe because notify() clears one-shot waiters on intermediate output events.
        unsub = subscribeSession(session, onEvent);
      }
    });
    const onEvent = () => {
      if (signal?.aborted || interrupted?.() || pendingBash(session) == null || pendingBashFinished(session)) {
        cleanup();
        resolve();
      } else {
        unsub = subscribeSession(session, onEvent);
      }
    };
    const cleanup = () => {
      unsub();
      signal?.removeEventListener("abort", check);
    };
    signal?.addEventListener("abort", check, { once: true });
    check();
  });
}

function waitForTerminal(job: BashJob, signal?: AbortSignal, interrupted?: () => boolean): Promise<void> {
  if (terminal(job) || signal?.aborted || interrupted?.()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let unsub = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      unsub();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const rearm = () => {
      if (Date.now() >= job.deadline) expireJob(job);
      if (terminal(job) || signal?.aborted || interrupted?.()) return finish();
      unsub = subscribe(job.id, rearm);
    };
    const delay = Math.max(0, job.deadline - Date.now());
    timer = setTimeout(() => { expireJob(job); finish(); }, delay);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
    rearm();
  });
}

/** End-of-turn delivery: wait for the earliest waitable job via completion events (no polling for local jobs). */
export async function awaitPendingBash(
  session: string,
  signal?: AbortSignal,
  interrupted?: () => boolean,
): Promise<string | undefined> {
  const id = pendingBash(session);
  if (id == null) return;
  const job = jobs.get(id)!;
  return readReceipt(job, 15, signal, interrupted, true);
}

async function readReceipt(job: BashJob, wait: number, signal?: AbortSignal, interrupted?: () => boolean, consume = false) {
  const { id, session } = job;
  const others = pendingBashAll(session).length - 1;
  const note = others > 0 ? `（还有 ${others} 个后台任务结果未交付）` : "";
  if (!job.pollRemote) {
    await waitForTerminal(job, signal, interrupted);
    if (signal?.aborted || interrupted?.()) return;
    if (Date.now() >= job.deadline) expireJob(job);
    const safe = job.redact || ((text: string) => text);
    const text = job.cancelled ? cancelText(job) : job.expired ? timeoutText(job) : job.error && !job.output ? job.error : formatOutput(job);
    const error = job.cancelled || job.expired || !!job.error || (job.exitCode != null && job.exitCode !== 0);
    if (consume && !signal?.aborted) consumeBashJob(job);
    return error && job.exitCode === undefined
      ? `[后台任务 ${id} 未能取回结果] ${safe(text)}`
      : `[后台任务 ${id} ${error ? "执行失败" : "已完成"}] exit=${job.exitCode ?? (error ? -1 : 0)}${note}\n${safe(text)}`;
  }
  while (!signal?.aborted && !interrupted?.()) {
    try {
      const done = await pollBash(session, id, wait, signal, consume);
      if (signal?.aborted) return;
      if (done.status === "finished") {
        return done.error && done.exitCode === undefined
          ? `[后台任务 ${id} 未能取回结果] ${done.text}`
          : `[后台任务 ${id} ${done.error ? "执行失败" : "已完成"}] exit=${done.exitCode ?? (done.error ? -1 : 0)}${note}\n${done.text}`;
      }
    } catch (e: any) {
      if (signal?.aborted) return;
      if (consume) consumeBashJob(job);
      const text = String(e.message || e);
      return `[后台任务 ${id} 未能取回结果；先核对实际状态，不要重跑] ${job.redact?.(text) ?? text}`;
    }
  }
}

export function backgroundBashResult(session: string, id = pendingBash(session), runningOnly = false): BackgroundResult | undefined {
  const job = id == null ? undefined : jobs.get(id);
  if (!job?.waitable || job.session !== session || (runningOnly && terminal(job))) return;
  return {
    wait: signal => readReceipt(job, 15, signal),
    acknowledge: () => consumeBashJob(job),
  };
}

export function redactBashJob(session: string, id: number, redact: (text: string) => string) {
  const job = jobs.get(id);
  if (job?.session === session) job.redact = redact;
}

export function cancelSessionBash(session: string) {
  for (const job of jobs.values()) {
    if (job.session !== session || job.done || job.cancelled) continue;
    job.cancelled = true;
    killJob(job);
    notify(job.id, job.session);
  }
}

export function backgroundBashMessage(id: number, timeoutSecs: number, detach: boolean, tail = "") {
  let text = detach
    ? `已作为 detach 长驻任务启动：job_id=${id}。本轮不会等它，也不会自动交付结果；需要看输出或停止时用 bash_poll(job_id=${id}) / kill=true。`
    : `命令超过 ${BASH_YIELD_SECS}s 仍未结束，已转到后台：job_id=${id}。若已无其他独立工作，结束本轮即可由运行时事件等待并自动交付结果（无其他任务排队时原地等待，有竞争才自动让出名额，无需循环 bash_poll）；卡死时可用 bash_poll(job_id=${id}, kill=true) 终止。`;
  text += `后台仍受 timeout=${timeoutSecs}s 限制，到点强杀，会话被取消时同样被杀。`;
  if (tail.trim()) text += "\n--- 已有输出尾部 ---\n" + tail;
  return text;
}

/** Test helper: drop every job. */
export function resetBashJobs() {
  for (const job of jobs.values()) {
    job.dropped = true;
    try { job.kill(); } catch { /* ignore */ }
  }
  jobs.clear();
  waiters.clear();
  sessionWaiters.clear();
  seq = 1;
}
