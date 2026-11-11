/** Background bash jobs: 10s yield, poll, end-of-turn auto-delivery. Semantics match nova tools.rs. */

export const BASH_YIELD_SECS = 10;
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
  kill: () => void;
  /** Local-client poll; when set, the process lives on the client. */
  pollRemote?: (
    waitSecs: number,
    signal?: AbortSignal,
  ) => Promise<{ running: boolean; output?: string; truncated?: boolean; exitCode?: number; error?: string }>;
};

type Waiter = () => void;

const jobs = new Map<number, BashJob>();
const waiters = new Map<number, Waiter[]>();
let seq = 1;

function notify(id: number) {
  const list = waiters.get(id);
  if (!list?.length) return;
  waiters.delete(id);
  for (const fn of list) fn();
}

function subscribe(id: number, fn: Waiter) {
  const list = waiters.get(id) || [];
  list.push(fn);
  waiters.set(id, list);
}

function gc(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now < job.deadline + BASH_JOB_KEEP_MS) continue;
    job.dropped = true;
    if (!job.done) {
      try { job.kill(); } catch { /* already gone */ }
    }
    jobs.delete(id);
    notify(id);
  }
}

function watchdog(job: BashJob) {
  const delay = Math.max(0, job.deadline - Date.now());
  const timer = setTimeout(() => {
    if (job.dropped || job.done) return;
    job.expired = true;
    try { job.kill(); } catch { /* already gone */ }
    notify(job.id);
  }, delay);
  timer.unref?.();
}

export function createBashJob(opts: {
  session: string;
  waitable: boolean;
  timeoutSecs: number;
  startedAt?: number;
  kill: () => void;
  pollRemote?: BashJob["pollRemote"];
  output?: string;
  truncated?: boolean;
}): BashJob {
  gc();
  const timeoutSecs = Math.max(1, Math.min(600, opts.timeoutSecs | 0));
  const job: BashJob = {
    id: seq++,
    session: opts.session,
    waitable: opts.waitable,
    startedAt: opts.startedAt ?? Date.now(),
    timeoutSecs,
    deadline: Date.now() + timeoutSecs * 1000,
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
  watchdog(job);
  return job;
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
  notify(job.id);
}

/** Drop a job that already returned its result as a foreground tool outcome so auto-delivery will not send it again. */
export function consumeBashJob(job: BashJob) {
  job.done = true;
  job.dropped = true;
  jobs.delete(job.id);
  notify(job.id);
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

function takeJob(session: string, id: number): BashJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`没有后台任务 ${id}：可能已结束并被清理，或不属于本会话`);
  if (job.session !== session) throw new Error(`后台任务 ${id} 不属于本会话`);
  jobs.delete(id);
  return job;
}

function putJob(job: BashJob) {
  if (!job.dropped) jobs.set(job.id, job);
}

async function waitLocal(job: BashJob, waitSecs: number, signal?: AbortSignal) {
  const limit = Math.min(Math.max(1, waitSecs || 30), 600) * 1000;
  const until = Date.now() + Math.min(limit, Math.max(0, job.deadline - Date.now()));
  while (Date.now() < until && !job.done && !job.cancelled && !job.expired && !signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      subscribe(job.id, done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export async function pollBash(
  session: string,
  id: number,
  waitSecs = 30,
  signal?: AbortSignal,
): Promise<BashPoll> {
  const job = takeJob(session, id);
  const finish = (text: string, error?: boolean): BashPoll => {
    job.dropped = true;
    return { status: "finished", text, jobId: id, exitCode: job.exitCode, error };
  };
  try {
    if (job.cancelled) return finish(cancelText(job), true);
    if (job.expired) return finish(timeoutText(job), true);
    if (job.done) {
      const error = job.exitCode != null ? job.exitCode !== 0 || !!job.error : !!job.error;
      return finish(job.error && !job.output ? job.error : formatOutput(job), error);
    }
    if (job.pollRemote) {
      const wait = Math.min(Math.max(1, waitSecs || 30), 600);
      const remaining = Math.max(1, Math.ceil((job.deadline - Date.now()) / 1000));
      const result = await job.pollRemote(Math.min(wait, remaining), signal);
      if (result.output != null) job.output = result.output;
      if (result.truncated) job.truncated = true;
      if (result.error) job.error = result.error;
      if (result.exitCode != null) job.exitCode = result.exitCode;
      if (job.cancelled) return finish(cancelText(job), true);
      if (job.expired) return finish(timeoutText(job), true);
      if (!result.running) {
        job.done = true;
        const error = (result.exitCode != null && result.exitCode !== 0) || !!result.error;
        return finish(result.error && !job.output ? result.error : formatOutput(job), error);
      }
      putJob(job);
      return { status: "running", text: runningText(id, job.output.slice(-4000)), jobId: id };
    }
    await waitLocal(job, waitSecs, signal);
    if (job.cancelled) return finish(cancelText(job), true);
    if (job.expired) return finish(timeoutText(job), true);
    if (job.done) {
      const error = job.exitCode != null ? job.exitCode !== 0 || !!job.error : !!job.error;
      return finish(formatOutput(job), error);
    }
    putJob(job);
    return { status: "running", text: runningText(id, job.output.slice(-4000)), jobId: id };
  } catch (e: any) {
    if (!job.done && !job.dropped) putJob(job);
    throw e;
  }
}

/** End-of-turn delivery: wait for the earliest waitable job; one job per call, like nova. */
export async function awaitPendingBash(
  session: string,
  signal?: AbortSignal,
  interrupted?: () => boolean,
): Promise<string | undefined> {
  const id = pendingBash(session);
  if (id == null) return;
  const others = pendingBashAll(session).length - 1;
  const note = others > 0 ? `（还有 ${others} 个后台任务在跑，收尾时继续交付）` : "";
  while (true) {
    if (signal?.aborted || interrupted?.()) return;
    let done: BashPoll;
    try {
      done = await pollBash(session, id, 1, signal);
    } catch (e: any) {
      return `[后台任务 ${id} 已结束] ${e.message || e}`;
    }
    if (signal?.aborted) return;
    if (done.status === "finished") {
      return done.error && !/已完成|exit=/.test(done.text)
        ? `[后台任务 ${id} 未能取回结果] ${done.text}`
        : `[后台任务 ${id} 已完成] exit=${done.exitCode ?? (done.error ? -1 : 0)}${note}\n${done.text}`;
    }
  }
}

export function cancelSessionBash(session: string) {
  for (const job of jobs.values()) {
    if (job.session !== session) continue;
    job.cancelled = true;
    try { job.kill(); } catch { /* already gone */ }
    notify(job.id);
  }
}

export function backgroundBashMessage(id: number, timeoutSecs: number, detach: boolean, tail = "") {
  let text = `命令超过 ${BASH_YIELD_SECS}s 仍未结束，已转到后台：job_id=${id}。${
    detach
      ? "这是 detach 的长驻任务，本轮不会等它，也不会自动交付结果。"
      : "现在先处理不依赖它的工作；本轮收尾时运行时会替你等完并交回结果，不必轮询 bash_poll（中途确实要结果再 bash_poll，wait 20–30 秒）。"
  }后台仍受 timeout=${timeoutSecs}s 限制，到点强杀，会话被取消时同样被杀。`;
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
  seq = 1;
}
