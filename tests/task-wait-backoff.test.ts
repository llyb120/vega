import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import {
  Employee,
  TASK_WAIT_BACKOFF_MINUTES,
  nextTaskWaitMinutes,
  type EmployeeRuntime,
} from "../server/core/employee";
import { beijingDateTime } from "../shared/time";

async function fixture() {
  const store = await Store.open(":memory:");
  const runtime: EmployeeRuntime = {
    run: async () => {},
    cancel() {},
    isRunning: () => false,
    emit() {},
    config: () => ({ scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] } }),
    isolated: true,
  };
  const employee = new Employee(store, new Vault(store), runtime);
  employee.closed = true;
  const created = await employee.execute("", { action: "add", kind: "todo", text: "等待外部结果" });
  return { store, employee, id: created.value.id };
}

async function markRunning(employee: Employee, id: string) {
  await employee.update((state) => {
    employee.task(state, id).status = "running";
  });
  employee.busy.set(id, { computer: false, session: "" });
}

test("task_wait backoff ladder follows 1 -> 5 -> 10 -> 15 -> 30 -> 60 minutes and caps at 60", () => {
  assert.deepEqual([...TASK_WAIT_BACKOFF_MINUTES], [1, 5, 10, 15, 30, 60]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((streak) => nextTaskWaitMinutes(streak)), [1, 5, 10, 15, 30, 60, 60, 60]);
  assert.equal(nextTaskWaitMinutes(-3), 1);
});

test("consecutive deferrals apply progressive backoff and ignore requested delayMinutes", async () => {
  const { store, employee, id } = await fixture();
  try {
    const expected = [1, 5, 10, 15, 30, 60, 60];
    for (let i = 0; i < expected.length; i++) {
      await markRunning(employee, id);
      const before = Date.now();
      const args = i === 0
        ? { action: "defer", text: `wait-${i + 1}`, nextCheckInMinutes: 60 }
        : { action: "defer", text: `wait-${i + 1}` };
      const receipt = await employee.execute(id, args);
      const after = Date.now();
      const task = employee.task(await employee.state(), id);
      const minutes = expected[i];
      assert.equal(task.status, "deferred");
      assert.equal(task.waitStreak, i + 1);
      assert.equal(receipt.value.delayMinutes, minutes);
      assert.equal(receipt.value.waitStreak, i + 1);
      assert.equal(receipt.value.nextCheckAt, beijingDateTime(task.nextCheckAt));
      assert(task.nextCheckAt >= before + minutes * 60_000 - 1000 && task.nextCheckAt <= after + minutes * 60_000 + 1000, `step ${i + 1} expected ${minutes}m`);
    }
  } finally {
    employee.close();
    await store.close();
  }
});

test("no-op progress preserves waitStreak while plan advancement resets backoff to 1 minute", async () => {
  const { store, employee, id } = await fixture();
  const initialPlan = [
    { content: "等待外部接口", status: "in_progress" },
    { content: "继续处理", status: "pending" },
  ];
  try {
    await markRunning(employee, id);
    await employee.execute(id, { action: "progress", text: "登记计划", plan: initialPlan });
    assert.equal((await employee.execute(id, { action: "defer", text: "第1次等待" })).value.delayMinutes, 1);

    // Repeating the same plan with no stepOutput must NOT reset waitStreak.
    await markRunning(employee, id);
    await employee.execute(id, { action: "progress", text: "仍在等待", plan: initialPlan });
    assert.equal((await employee.execute(id, { action: "defer", text: "第2次等待" })).value.delayMinutes, 5);

    // Advancing the plan resets waitStreak so a later wait starts from 1 minute again.
    await markRunning(employee, id);
    await employee.execute(id, {
      action: "progress",
      text: "接口已完成，进入下一步",
      plan: [
        { content: "等待外部接口", status: "completed" },
        { content: "继续处理", status: "in_progress" },
      ],
    });
    const resetTask = employee.task(await employee.state(), id);
    assert.equal(resetTask.waitStreak, undefined);
    const nextWait = await employee.execute(id, { action: "defer", text: "新一阶段等待" });
    assert.equal(nextWait.value.delayMinutes, 1);
    assert.equal(nextWait.value.waitStreak, 1);
  } finally {
    employee.close();
    await store.close();
  }
});

test("user supplement, answer, and resume reset waitStreak back to 1 minute", async () => {
  const { store, employee, id } = await fixture();
  try {
    // Advance streak to 2 (1m -> 5m)
    await markRunning(employee, id);
    await employee.execute(id, { action: "defer", text: "wait 1" });
    employee.busy.delete(id);
    await markRunning(employee, id);
    assert.equal((await employee.execute(id, { action: "defer", text: "wait 2" })).value.delayMinutes, 5);
    employee.busy.delete(id);

    // Non-duplicate supplement resets waitStreak
    await employee.control({ action: "resume", id, text: "已补充上下文" });
    assert.equal(employee.task(await employee.state(), id).waitStreak, undefined);
    await markRunning(employee, id);
    assert.equal((await employee.execute(id, { action: "defer", text: "after supplement" })).value.delayMinutes, 1);
    employee.busy.delete(id);

    // task_ask_user (help) -> answer resets waitStreak
    await markRunning(employee, id);
    await employee.execute(id, { action: "help", text: "请确认环境" });
    employee.busy.delete(id);
    await employee.control({ action: "answer", id, text: "使用预发环境" });
    assert.equal(employee.task(await employee.state(), id).waitStreak, undefined);
    await markRunning(employee, id);
    assert.equal((await employee.execute(id, { action: "defer", text: "after answer" })).value.delayMinutes, 1);
    employee.busy.delete(id);

    // stop -> resume resets waitStreak
    await employee.control({ action: "stop", id });
    await employee.control({ action: "resume", id });
    assert.equal(employee.task(await employee.state(), id).waitStreak, undefined);
    await markRunning(employee, id);
    assert.equal((await employee.execute(id, { action: "defer", text: "after stop/resume" })).value.delayMinutes, 1);
    employee.busy.delete(id);
  } finally {
    employee.close();
    await store.close();
  }
});

test("explicit nextAt uses the exact Beijing timestamp rather than overriding with backoff", async () => {
  const { store, employee, id } = await fixture();
  try {
    await markRunning(employee, id);
    const receipt = await employee.execute(id, { action: "defer", text: "约定时间复查", nextAt: "2035-01-02 09:30" });
    const task = employee.task(await employee.state(), id);
    assert.equal(task.status, "deferred");
    assert.equal(receipt.value.nextCheckAt, "2035-01-02 09:30");
    assert.equal(receipt.value.delayMinutes, undefined);
    assert.equal(beijingDateTime(task.nextCheckAt), "2035-01-02 09:30");
  } finally {
    employee.close();
    await store.close();
  }
});
