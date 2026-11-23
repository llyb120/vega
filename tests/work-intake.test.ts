import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Employee } from "../server/core/employee";
import { sleep } from "../server/core/util";
import { beijingTimestamp } from "../shared/time";
import {
  FEW_MINUTES,
  nextClock,
  nextDue,
  parseExplicitSchedule,
  type Repeat,
  type WorkEvent,
} from "../server/core/work-intake";

const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const MINUTE = 60_000;

function repeatOf(text: string, now: number) {
  const parsed = parseExplicitSchedule(text, now);
  assert.ok(parsed, text);
  return parsed;
}

test("explicit schedules parse one-shot times and repeating cadences, including a few minutes", () => {
  const now = beijingTimestamp(2026, 10, 14, 15, 0);
  const tomorrow = repeatOf("明天早上 9 点检查 CI", now);
  assert.equal(tomorrow.schedule.dueAt, beijingTimestamp(2026, 10, 15, 9, 0));
  assert.equal(tomorrow.schedule.repeat, undefined);

  const daily = repeatOf("每天 18 点汇总", now);
  assert.deepEqual(daily.schedule.repeat, { kind: "daily", time: "18:00" });
  assert.equal(daily.schedule.dueAt, beijingTimestamp(2026, 10, 14, 18, 0));

  const weekly = repeatOf("每周三 18 点汇总", now);
  const weeklyRepeat = weekly.schedule.repeat as Repeat;
  assert.equal(weeklyRepeat.kind, "weekly");
  assert.equal(weeklyRepeat.kind === "weekly" && weeklyRepeat.weekday, 3);
  assert.equal(weekly.schedule.dueAt, nextDue(weeklyRepeat, now));

  const wednesday = repeatOf("周三提醒我看这个 PR", now);
  assert.equal(wednesday.schedule.repeat, undefined);
  assert.equal(wednesday.schedule.dueAt, nextClock(now, 9, 0, 3));

  const few = repeatOf("每隔几分钟检查构建", now);
  assert.deepEqual(few.schedule.repeat, { kind: "interval", everyMinutes: FEW_MINUTES });
  assert.equal(FEW_MINUTES, 3);
  assert.equal(few.schedule.dueAt, now + FEW_MINUTES * MINUTE);

  const minute = repeatOf("每隔 1 分钟检查构建", now);
  assert.deepEqual(minute.schedule.repeat, { kind: "interval", everyMinutes: 1 });
  assert.equal(minute.schedule.dueAt, now + MINUTE);

  const hours = repeatOf("每 2 小时汇总", now);
  assert.deepEqual(hours.schedule.repeat, { kind: "interval", everyMinutes: 120 });
  assert.equal(repeatOf("每隔几分钟", now).item.id.length > 0, true);

  assert.equal(parseExplicitSchedule("有空看看有没有新问题", now), undefined);
  assert.equal(parseExplicitSchedule("有空就去仓库里找点事做", now), undefined);
  assert.equal(parseExplicitSchedule("这个构建每 5 分钟失败一次", now), undefined);
  assert.equal(parseExplicitSchedule("帮我看一下，这个构建每 5 分钟失败一次", now), undefined);
  assert.equal(parseExplicitSchedule("不要每 5 分钟检查", now), undefined);
  assert.equal(parseExplicitSchedule("今天早上 9 点检查 CI", now), undefined);
  assert.equal(parseExplicitSchedule("查清 GLM 套餐：额度规则（如每 5 小时 prompts 数、每周/每月上限）并核对价格", now), undefined);
  assert.equal(parseExplicitSchedule("目标：查清智谱 GLM 当前的各项套餐。\n1. 区分两类套餐。\n2. 每档给出价格、额度规则如每 5 小时 prompts 数与并发限制，确认差异。", now), undefined);
  assert.equal(parseExplicitSchedule("帮我核对一下今天下午 6 点前要交的报告", now), undefined);
  assert.equal(parseExplicitSchedule("查清每天 9 点的同步任务报错原因", now), undefined);
  assert.equal(parseExplicitSchedule("帮我检查构建，每隔 5 分钟", now)?.schedule.repeat?.kind, "interval");

  assert.equal(
    repeatOf("每隔 1 分钟检查构建", now).item.id,
    repeatOf("请每隔 5 分钟检查构建", now + 999).item.id,
  );
});

test("schedule intake has no duty config, and 工作原则 stays", () => {
  const intake = source("server/core/work-intake.ts");
  assert.doesNotMatch(intake, /职责配置|charter|setInterval|setTimeout|findWork/);
  const settings = source("web/src/EmployeeSettings.vue");
  assert.match(settings, /工作原则/);
  assert.doesNotMatch(settings, /职责|charter|duty/);
  assert.throws(() => source("web/src/EmployeeDuties.vue"));
  assert.throws(() => source("server/core/duty-condition.ts"));
  assert.doesNotMatch(source("web/src/App.vue"), /职责|EmployeeDuties|employeeTab === 'duties'/);
  assert.doesNotMatch(source("server/core/public-tools.ts"), /employee_duty_|职责/);
  assert.match(source("server/core/engine.ts"), /acceptUserSchedule/);
  assert.match(source("server/core/engine.ts"), /\[工作原则\]/);
  assert.match(source("server/core/groups.ts"), /acceptUserSchedule/);
  assert.match(source("server/core/prompt.ts"), /工作原则/);
  assert.doesNotMatch(source("server/core/prompt.ts"), /职责/);
});

type Gate = { promise: Promise<void>; release: () => void };
function gate(): Gate {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function until(pred: () => boolean) {
  for (let i = 0; i < 100 && !pred(); i++) await sleep(10);
  assert.equal(pred(), true);
}

async function harness(slots = 3) {
  const store = await Store.open(":memory:");
  const gates: Gate[] = [];
  const prompts: string[] = [];
  const cancelled: string[] = [];
  let started = 0;
  const employee = new Employee(store, new Vault(store), {
    run: async (_session, prompt) => {
      started++;
      prompts.push(prompt);
      await (gates[started - 1]?.promise ?? Promise.resolve());
    },
    cancel: (session) => { cancelled.push(session); },
    isRunning: () => false,
    emit: () => {},
    config: () => ({
      scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
      model: "p/m",
      scheduler: { globalSlots: slots, perEmployeeSlots: slots },
    }),
  });
  employee.wake = () => {};
  return {
    employee,
    prompts,
    cancelled,
    hold() { gates.push(gate()); },
    release() { for (const item of gates) item.release(); },
    started: () => started,
    async finish() {
      for (const item of gates) item.release();
      for (let i = 0; i < 50 && employee.busy.size; i++) await sleep(10);
      employee.close();
      await store.close();
    },
  };
}

test("a minute-level interval waits until it is due, then repeats the same task", async () => {
  const box = await harness();
  try {
    const now = Date.now();
    const created = await box.employee.acceptUserSchedule("每隔 1 分钟检查构建", now);
    assert.ok(created);
    const due = now + MINUTE;
    await box.employee.tick(now + MINUTE - 1);
    await sleep(20);
    assert.equal(box.started(), 0);
    let state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal("duties" in state, false);
    assert.equal(state.tasks[0].status, "deferred");
    assert.equal(state.tasks[0].id, created.taskId);
    assert.equal(state.tasks[0].schedule?.dueAt, due);

    await box.employee.tick(due);
    await until(() => box.started() === 1 && box.employee.busy.size === 0);
    state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, created.taskId);
    assert.equal(state.tasks[0].status, "deferred");
    const nextAt = Number(state.tasks[0].nextCheckAt);
    assert.equal(nextAt, state.tasks[0].schedule?.dueAt);
    assert.ok(nextAt > due);
    assert.equal(state.runs[0].wake?.kind, "schedule");

    await box.employee.tick(nextAt);
    await until(() => box.started() === 2 && box.employee.busy.size === 0);
    state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, created.taskId);
    assert.equal("duties" in state, false);
  } finally {
    await box.finish();
  }
});

test("每隔几分钟 is a 3 minute user cadence and does not fire early", async () => {
  const box = await harness();
  try {
    const now = Date.now();
    const created = await box.employee.acceptUserSchedule("每隔几分钟看一下构建", now);
    assert.equal(created?.status, "deferred");
    await box.employee.tick(now + 2 * MINUTE);
    await sleep(20);
    assert.equal(box.started(), 0);
    await box.employee.tick(now + FEW_MINUTES * MINUTE);
    await until(() => box.started() === 1);
    const state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, created?.taskId);
    assert.equal(state.tasks[0].schedule?.repeat?.kind, "interval");
    assert.equal(state.tasks[0].schedule?.repeat?.kind === "interval" ? state.tasks[0].schedule.repeat.everyMinutes : 0, 3);
  } finally {
    await box.finish();
  }
});

test("an in-flight interval does not overlap or interrupt, then continues the same task", async () => {
  const box = await harness();
  box.hold();
  try {
    const now = Date.now();
    const created = await box.employee.acceptUserSchedule("每隔 1 分钟检查构建", now);
    const due = now + MINUTE;
    await box.employee.tick(due);
    await until(() => box.started() === 1);
    const running = (await box.employee.state()).tasks[0];
    assert.equal(running.status, "running");
    assert.equal(running.id, created?.taskId);
    const advanced = running.schedule?.dueAt || 0;
    assert.equal(advanced, due + MINUTE);

    await box.employee.tick(advanced);
    await box.employee.tick(advanced + 9 * MINUTE);
    await sleep(20);
    const mid = (await box.employee.state()).tasks[0];
    assert.equal(box.started(), 1);
    assert.equal(box.cancelled.length, 0);
    assert.equal((await box.employee.state()).tasks.length, 1);
    assert.equal(mid.id, created?.taskId);
    assert.equal(mid.status, "running");
    assert.ok(mid.schedule?.queuedFire);
    assert.match(box.prompts[0] || "", /工作原则/);

    box.release();
    await until(() => box.employee.busy.size === 0);
    const queued = (await box.employee.state()).tasks[0];
    assert.equal(queued.id, created?.taskId);
    assert.equal(queued.status, "queued");
    assert.equal(queued.schedule?.queuedFire, undefined);
    assert.match(queued.answer || "", /没有另开任务/);
    assert.match(queued.answer || "", /没有打断当前步骤/);

    box.hold();
    await box.employee.tick(Date.now());
    await until(() => box.started() === 2);
    const again = (await box.employee.state()).tasks[0];
    assert.equal((await box.employee.state()).tasks.length, 1);
    assert.equal(again.id, created?.taskId);
    assert.equal(again.status, "running");
    assert.equal(box.cancelled.length, 0);
  } finally {
    await box.finish();
  }
});

test("a due schedule resumes the same failed task, and restating it does not duplicate", async () => {
  const box = await harness();
  box.hold();
  try {
    const now = beijingTimestamp(2026, 10, 14, 15, 0);
    const created = await box.employee.acceptUserSchedule("明天早上 9 点检查 CI", now);
    const due = beijingTimestamp(2026, 10, 15, 9, 0);
    await box.employee.update((s) => {
      const task = s.tasks[0];
      task.status = "failed";
      task.nextCheckAt = due;
    });
    const again = await box.employee.acceptUserSchedule("明天早上 9 点检查 CI", now + MINUTE);
    assert.equal(again?.action, "ignore");
    assert.equal(again?.taskId, created?.taskId);
    assert.equal((await box.employee.state()).tasks.length, 1);

    await box.employee.update((s) => {
      s.tasks[0].status = "failed";
      s.tasks[0].nextCheckAt = due;
    });
    await box.employee.tick(due - 1);
    await sleep(20);
    assert.equal(box.started(), 0);
    assert.equal((await box.employee.state()).tasks[0].status, "failed");

    await box.employee.update((s) => { s.instruction = "先看现有实现，不扩大授权"; });
    await box.employee.tick(due);
    await until(() => box.started() === 1);
    const state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, created?.taskId);
    assert.equal(state.tasks[0].status, "running");
    assert.equal(state.tasks[0].wake?.kind, "schedule");
    assert.match(box.prompts[0], /工作原则/);
    assert.match(box.prompts[0], /先看现有实现，不扩大授权/);
    assert.doesNotMatch(box.prompts[0], /职责配置/);
    assert.equal("duties" in state, false);
  } finally {
    await box.finish();
  }
});

test("an event for an in-flight item is attached and absorbed after the step", async () => {
  const box = await harness();
  box.hold();
  try {
    const created = await box.employee.execute("", { action: "add", kind: "todo", text: "修这个提交" });
    const id = created.value.id as string;
    await box.employee.update((s) => { s.tasks[0].key = "ci:commit-abc"; });
    await box.employee.tick(Date.now());
    await until(() => box.started() === 1);
    const event: WorkEvent = {
      id: "ci-1",
      at: Date.now(),
      kind: "ci",
      item: { kind: "ci", id: "commit-abc" },
      text: "CI 失败",
      evidence: "job 9",
    };
    const attached = await box.employee.intake(event);
    assert.equal(attached.action, "attach");
    assert.equal(attached.taskId, id);
    await sleep(20);
    let state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].status, "running");
    assert.equal(state.tasks[0].inbox?.length, 1);
    assert.equal(box.started(), 1);
    assert.equal(box.cancelled.length, 0);

    box.release();
    await until(() => box.employee.busy.size === 0);
    state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, id);
    assert.match(state.tasks[0].answer || "", /job 9/);
    assert.equal(box.started(), 1);
  } finally {
    await box.finish();
  }
});

test("a completed task stays done until there is new evidence", async () => {
  const box = await harness();
  try {
    const created = await box.employee.execute("", { action: "add", kind: "todo", text: "修这个提交", key: "ci:commit-abc" });
    const id = created.value.id as string;
    await box.employee.update((s) => { s.tasks[0].status = "done"; });
    const event = (evidence: string, eventId: string): WorkEvent => ({
      id: eventId,
      at: Date.now(),
      kind: "ci",
      item: { kind: "ci", id: "commit-abc" },
      text: "CI 结果",
      evidence,
    });
    const same = await box.employee.intake(event("", "ci-empty"));
    assert.equal(same.action, "leave");
    assert.equal((await box.employee.state()).tasks[0].status, "done");

    const fresh = await box.employee.intake(event("job 9", "ci-9"));
    assert.equal(fresh.action, "resume");
    assert.equal(fresh.taskId, id);
    await box.employee.update((s) => { s.tasks[0].status = "done"; });
    const repeat = await box.employee.intake(event("job 9", "ci-9-again"));
    assert.equal(repeat.action, "leave");
    assert.equal((await box.employee.state()).tasks[0].status, "done");

    const newer = await box.employee.intake(event("job 10", "ci-10"));
    assert.equal(newer.action, "resume");
    assert.equal(newer.taskId, id);
    const state = await box.employee.state();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].status, "queued");
    assert.equal(box.started(), 0);
  } finally {
    await box.finish();
  }
});

test("CI for an unknown item and an idle instruction do not start work", async () => {
  const box = await harness();
  try {
    const now = Date.now();
    const ignored = await box.employee.intake({
      id: "ci-unknown",
      at: now,
      kind: "ci",
      item: { kind: "ci", id: "no-such-commit" },
      text: "CI 失败",
      evidence: "job 1",
    });
    assert.equal(ignored.action, "ignore");
    assert.equal(await box.employee.acceptUserSchedule("有空就去仓库里找点事做", now), undefined);
    await box.employee.update((s) => { s.instruction = "有空就去仓库里找点事做"; });
    await box.employee.tick(now);
    await box.employee.tick(now + 10 * MINUTE);
    await sleep(20);
    const state = await box.employee.state();
    assert.equal(state.tasks.length, 0);
    assert.equal("duties" in state, false);
    assert.equal(box.started(), 0);

    const first = await box.employee.acceptUserSchedule("每隔 1 分钟检查构建", now);
    const second = await box.employee.acceptUserSchedule("请每隔 5 分钟检查构建", now + 5000);
    const tasks = (await box.employee.state()).tasks;
    assert.equal(second?.action, "resume");
    assert.equal(second?.taskId, first?.taskId);
    assert.equal(tasks.length, 1);
    assert.match(String(tasks[0].key), /^schedule:/);
    assert.equal(tasks[0].schedule?.repeat?.kind, "interval");
    assert.equal(tasks[0].schedule?.repeat?.kind === "interval" ? tasks[0].schedule.repeat.everyMinutes : 0, 5);
  } finally {
    await box.finish();
  }
});

test("a held authority gate does not run, and a user task beats a due schedule", async () => {
  const box = await harness(1);
  box.hold();
  try {
    const now = Date.now();
    const held = await box.employee.intake({
      id: "hold-1",
      at: now,
      kind: "message",
      item: { kind: "issue", id: "88" },
      text: "这里有合并冲突",
      userInitiated: true,
      directed: true,
      hold: "merge-conflict",
    });
    assert.equal(held.status, "waiting");
    await box.employee.tick(now);
    await sleep(20);
    assert.equal(box.started(), 0);
    assert.equal((await box.employee.state()).tasks[0].status, "waiting");

    const scheduled = await box.employee.acceptUserSchedule("每隔 1 分钟检查 CI", now - MINUTE);
    await box.employee.execute("", { action: "add", kind: "todo", text: "用户马上要的事" });
    await box.employee.tick(now);
    await until(() => box.started() === 1);
    const tasks = (await box.employee.state()).tasks;
    const running = tasks.filter((task) => task.status === "running");
    assert.equal(running.length, 1);
    assert.equal(running[0].text, "用户马上要的事");
    assert.equal(tasks.find((task) => task.id === scheduled?.taskId)?.status, "deferred");
    assert.equal(tasks.filter((task) => task.schedule).length, 1);
    assert.equal(box.started(), 1);
  } finally {
    await box.finish();
  }
});

test("multi-point brief mentioning 每 5 小时 creates a normal one-shot task; a real recurring task delivers its completed round to chat before arming next tick", async () => {
  const box = await harness();
  try {
    const glm = await box.employee.execute("", {
      action: "add",
      kind: "todo",
      text: "目标：查清智谱 GLM 当前的各项套餐。\n1. 覆盖 Coding Plan 与 API 按量计费。\n2. 每档给出价格、额度规则（如每 5 小时 prompts 数、每周/每月上限）、可用模型并核对差异。",
    });
    assert.equal(glm.value.scheduled, undefined);
    const glmTask = (await box.employee.state()).tasks.find((t) => t.id === glm.value.id)!;
    assert.equal(glmTask.status, "queued");
    assert.equal(glmTask.schedule, undefined);

    const chat = await box.employee.chat("owner");
    const now = Date.now();
    const recurring = await box.employee.acceptUserSchedule("每隔 1 分钟检查构建", now);
    assert.ok(recurring?.taskId);
    box.employee.runtime.run = async () => {
      await box.employee.execute(recurring!.taskId!, {
        action: "progress",
        text: "构建已检查",
        plan: [{ content: "检查构建状态", status: "completed" }],
      });
      await box.employee.execute(recurring!.taskId!, {
        action: "complete",
        deliverableRef: [],
        text: "最新构建 #42 通过。",
        summary: "构建 #42 通过。",
      });
    };
    const due = now + MINUTE;
    await box.employee.tick(due);
    await until(() => box.employee.busy.size === 0 && (box.employee.runtime.run as any) !== undefined);
    // Wait briefly for post-commit chat delivery
    for (let i = 0; i < 50; i++) {
      const msgs = await box.employee.store.messages(chat.id);
      if (msgs.some((m) => m.delivery)) break;
      await sleep(10);
    }
    const state = await box.employee.state();
    const recTask = state.tasks.find((t) => t.id === recurring!.taskId)!;
    assert.equal(recTask.status, "deferred");
    assert.ok((recTask.nextCheckAt || 0) > due);
    const chatMsgs = await box.employee.store.messages(chat.id);
    const delivery = chatMsgs.find((m) => m.delivery);
    assert.ok(delivery, "completed recurring round must still deliver its summary to chat");
    assert.match(delivery!.text || "", /构建 #42 通过/);
  } finally {
    await box.finish();
  }
});
