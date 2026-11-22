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
  killBashJob,
  waitBashReady,
  backgroundBashMessage,
  resetBashJobs,
  bashJob,
} from "../server/core/bash-jobs";
import { shell } from "../server/core/tools";

afterEach(() => resetBashJobs());

test("bash yield is 60s and finished jobs stay pending until delivered", async () => {
  assert.equal(BASH_YIELD_SECS, 60);
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

test("automatic delivery reports process failure separately from an unavailable result", async () => {
  for (const remote of [false, true]) for (const exitCode of [0, 7, 128]) {
    const session = `status-${remote}-${exitCode}`;
    const result = { exitCode, output: "fixture output: 已完成 exit=0\n" };
    const job = createBashJob({ session, waitable: true, timeoutSecs: 30, kill: () => {}, ...(remote ? { pollRemote: async () => ({ running: false, ...result }) } : {}) });
    if (!remote) completeBashJob(job, result);
    const delivered = await awaitPendingBash(session);
    assert.match(delivered!, new RegExp(`^\\[后台任务 ${job.id} ${exitCode ? "执行失败" : "已完成"}\\] exit=${exitCode}\\n`));
    assert.match(delivered!, /fixture output/);
    assert.doesNotMatch(delivered!, /未能取回结果/);
  }
  const job = createBashJob({ session: "unavailable", waitable: true, timeoutSecs: 30, kill: () => {}, pollRemote: async () => ({ running: false, error: "result unavailable" }) });
  assert.equal(await awaitPendingBash("unavailable"), `[后台任务 ${job.id} 未能取回结果] result unavailable`);
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

test("poll settles a job past its deadline even before the watchdog callback", async () => {
  const session = "s-poll-deadline";
  let killed = false;
  const job = createBashJob({ session, waitable: true, startedAt: Date.now() - 2_000, timeoutSecs: 1, kill: () => { killed = true; } });
  const polled = await pollBash(session, job.id, 1);
  assert.equal(polled.status, "finished");
  assert.match(polled.text, /命令超过 1s/);
  assert.equal(killed, true);
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
  assert.match(wait, /结束本轮即可由运行时事件等待并自动交付结果/);
  assert.match(wait, /kill=true/);
  assert.doesNotMatch(wait, /不会自动交付结果/);
  const detached = backgroundBashMessage(4, 120, true);
  assert.match(detached, /detach 长驻任务/);
  assert.match(detached, /也不会自动交付结果/);
});

test("killBashJob terminates a stuck job and waitBashReady wakes immediately via events", async () => {
  const session = "s-kill-wait";
  let killed = false;
  const job = createBashJob({ session, waitable: true, timeoutSecs: 60, kill: () => { killed = true; } });
  let woke = false;
  const waiting = waitBashReady(session).then(() => { woke = true; });
  const killedResult = killBashJob(session, job.id);
  assert.equal(killed, true);
  assert.equal(killedResult.status, "finished");
  assert.equal(killedResult.error, true);
  assert.match(killedResult.text, /命令已被取消/);
  await waiting;
  assert.equal(woke, true);
  assert.equal(hasPendingBash(session), false);
});

test("server shell backgrounds a command past its yield window, fast-returns detach, and auto-delivers via events", async () => {
  const session = "s-shell";
  const started = Date.now();
  const command = `node -e "setTimeout(() => console.log('yielded-ok'), 1200)"`;
  const outcome = await shell(process.cwd(), { command, timeout: 30 }, new AbortController().signal, () => {}, undefined, undefined, session, 400);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 300 && elapsed < 1100, `yield took ${elapsed}ms`);
  assert.equal(outcome.value.jobId, 1);
  assert.equal(outcome.value.running, true);
  assert.match(String(outcome.value.message), /转到后台：job_id=1/);
  const delivered = await awaitPendingBash(session);
  assert.match(delivered || "", /yielded-ok/);
  assert.match(delivered || "", /exit=0/);

  const detachStart = Date.now();
  const detached = await shell(process.cwd(), { command: `node -e "setTimeout(() => {}, 5000)"`, timeout: 10, detach: true }, new AbortController().signal, () => {}, undefined, undefined, session);
  assert.ok(Date.now() - detachStart < 2500, "detach returns quickly without waiting 60s");
  assert.equal(detached.value.running, true);
  killBashJob(session, detached.value.jobId);
});

test("server shell timeout kills the background process", async () => {
  const session = "s-kill";
  const name = `vega-bash-kill-${process.pid}-${Date.now()}`, marker = join(tmpdir(), name);
  const script = `setTimeout(() => require('fs').writeFileSync(require('path').join(require('os').tmpdir(), '${name}'), 'survived'), 30000)`;
  const outcome = await shell(process.cwd(), { command: `node -e "${script}"`, timeout: 2 }, new AbortController().signal, () => {}, undefined, undefined, session, 400);
  assert.equal(outcome.value.running, true);
  const delivered = await awaitPendingBash(session);
  assert.match(delivered || "", /命令超过 2s 未结束，已终止/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(marker), false, "timeout must kill the process before it writes the marker");
});
