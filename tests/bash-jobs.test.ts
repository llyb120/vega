import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASH_YIELD_SECS,
  BASH_JOB_KEEP_MS,
  createBashJob,
  completeBashJob,
  consumeBashJob,
  pollBash,
  pendingBash,
  pendingBashAll,
  pendingBashFinished,
  hasPendingBash,
  awaitPendingBash,
  cancelSessionBash,
  backgroundBashMessage,
  resetBashJobs,
  bashJob,
} from "../server/core/bash-jobs";
import { shell } from "../server/core/tools";

afterEach(() => resetBashJobs());

test("bash yield is 10s and finished jobs stay pending until delivered", async () => {
  assert.equal(BASH_YIELD_SECS, 10);
  assert.equal(BASH_JOB_KEEP_MS, 60_000);
  const session = "s1";
  const job = createBashJob({ session, waitable: true, timeoutSecs: 120, kill: () => {} });
  assert.equal(pendingBash(session), job.id);
  assert.equal(pendingBashFinished(session), false);
  completeBashJob(job, { exitCode: 0, output: "hello" });
  assert.equal(pendingBash(session), job.id, "finished waitable jobs stay registered until poll/await delivers them");
  assert.equal(pendingBashFinished(session), true);
  const delivered = await awaitPendingBash(session);
  assert.match(delivered || "", /\[后台任务 1 已完成\] exit=0/);
  assert.match(delivered || "", /hello/);
  assert.equal(hasPendingBash(session), false);
  assert.equal(bashJob(job.id), undefined);
});

test("detach jobs are not auto-delivered", async () => {
  const session = "s-detach";
  const job = createBashJob({ session, waitable: false, timeoutSecs: 120, kill: () => {} });
  completeBashJob(job, { exitCode: 0, output: "daemon" });
  assert.deepEqual(pendingBashAll(session), []);
  assert.equal(await awaitPendingBash(session), undefined);
  const polled = await pollBash(session, job.id, 1);
  assert.equal(polled.status, "finished");
  assert.match(polled.text, /daemon/);
});

test("pending bash delivers the earliest job only, then the next", async () => {
  const session = "s-order";
  const first = createBashJob({ session, waitable: true, timeoutSecs: 30, kill: () => {} });
  const second = createBashJob({ session, waitable: true, timeoutSecs: 30, kill: () => {} });
  completeBashJob(second, { exitCode: 0, output: "second" });
  completeBashJob(first, { exitCode: 0, output: "first" });
  assert.equal(pendingBash(session), first.id);
  const one = await awaitPendingBash(session);
  assert.match(one || "", /后台任务 1 已完成/);
  assert.match(one || "", /还有 1 个后台任务/);
  assert.match(one || "", /first/);
  const two = await awaitPendingBash(session);
  assert.match(two || "", /后台任务 2 已完成/);
  assert.match(two || "", /second/);
  assert.equal(hasPendingBash(session), false);
});

test("consumeBashJob drops a foreground result so auto-delivery will not send it again", async () => {
  const session = "s-consume";
  const job = createBashJob({ session, waitable: true, timeoutSecs: 30, kill: () => {} });
  completeBashJob(job, { exitCode: 0, output: "already returned" });
  consumeBashJob(job);
  assert.equal(hasPendingBash(session), false);
  assert.equal(await awaitPendingBash(session), undefined);
});

test("cancelSessionBash kills running jobs and poll reports the nova cancel text", async () => {
  const session = "s-cancel";
  let killed = false;
  const job = createBashJob({
    session,
    waitable: true,
    timeoutSecs: 30,
    kill: () => { killed = true; },
  });
  cancelSessionBash(session);
  assert.equal(killed, true);
  const polled = await pollBash(session, job.id, 1);
  assert.equal(polled.status, "finished");
  assert.equal(polled.error, true);
  assert.match(polled.text, /命令已被取消，已终止/);
});

test("timeout watchdog marks the job expired and poll reports the timeout text", async () => {
  const session = "s-timeout";
  let killed = false;
  const job = createBashJob({
    session,
    waitable: true,
    timeoutSecs: 1,
    kill: () => { killed = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(killed, true);
  assert.equal(pendingBashFinished(session), true);
  const polled = await pollBash(session, job.id, 1);
  assert.equal(polled.status, "finished");
  assert.match(polled.text, /命令超过 1s 未结束，已终止/);
});

test("bash_poll is one-shot: a still-running job is returned after the wait, not awaited to completion", async () => {
  const session = "s-poll";
  const job = createBashJob({ session, waitable: true, timeoutSecs: 30, kill: () => {} });
  const started = Date.now();
  const polled = await pollBash(session, job.id, 1);
  assert.ok(Date.now() - started < 3000);
  assert.equal(polled.status, "running");
  assert.match(polled.text, /仍在运行/);
  assert.equal(pendingBash(session), job.id);
});

test("backgroundBashMessage distinguishes detach from auto-delivered jobs", () => {
  const wait = backgroundBashMessage(3, 120, false);
  assert.match(wait, /job_id=3/);
  assert.match(wait, /本轮收尾时运行时会替你等完并交回结果/);
  assert.doesNotMatch(wait, /不会自动交付结果/);
  const detached = backgroundBashMessage(4, 120, true);
  assert.match(detached, /detach 的长驻任务/);
  assert.match(detached, /也不会自动交付结果/);
});

test("server shell backgrounds a command after 10s and auto-delivers the result", async () => {
  const session = "s-shell";
  const started = Date.now();
  // A node child works under both sh and PowerShell; sleep/&& do not (&& is PowerShell 7 syntax),
  // and an absolute path may not survive PowerShell 5.1's ANSI command-line code page.
  const command = `node -e "setTimeout(() => console.log('yielded-ok'), 12000)"`;
  const outcome = await shell(process.cwd(), { command, timeout: 30 }, new AbortController().signal, () => {}, undefined, undefined, session);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 9000 && elapsed < 16000, `yield took ${elapsed}ms`);
  assert.equal(outcome.value.jobId, 1);
  assert.equal(outcome.value.running, true);
  assert.match(String(outcome.value.message), /转到后台：job_id=1/);
  const delivered = await awaitPendingBash(session);
  assert.match(delivered || "", /yielded-ok/);
  assert.match(delivered || "", /exit=0/);
});

test("server shell timeout kills the background process", async () => {
  const session = "s-kill";
  const name = `vega-bash-kill-${process.pid}-${Date.now()}`, marker = join(tmpdir(), name);
  // Same portable child: it would write the marker after 30s, and the 12s timeout must kill it first.
  // The child resolves the temp directory itself; an absolute path would cross PowerShell's code page.
  const script = `setTimeout(() => require('fs').writeFileSync(require('path').join(require('os').tmpdir(), '${name}'), 'survived'), 30000)`;
  const outcome = await shell(process.cwd(), { command: `node -e "${script}"`, timeout: 12 }, new AbortController().signal, () => {}, undefined, undefined, session);
  assert.equal(outcome.value.running, true);
  const delivered = await awaitPendingBash(session);
  assert.match(delivered || "", /命令超过 12s 未结束，已终止/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(marker), false, "timeout must kill the process before it writes the marker");
});
