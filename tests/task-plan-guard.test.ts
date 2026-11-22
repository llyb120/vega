import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Employee, type EmployeeRuntime } from "../server/core/employee";
import { Vault } from "../server/core/vault";

async function fixture() {
  const store = await Store.open(":memory:");
  const runtime: EmployeeRuntime = { run: async () => {}, cancel() {}, isRunning: () => false, emit() {}, config: () => ({ scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] } }), isolated: true };
  const employee = new Employee(store, new Vault(store), runtime);
  employee.closed = true;
  const created = await employee.execute("", { action: "add", kind: "todo", text: "有疑问先在需求单联系创建人，确认后开发并验证" });
  return { store, runtime, employee, id: created.value.id };
}

const plan = [
  { content: "阅读需求", status: "completed" },
  { content: "在需求单 @创建人澄清并等待回复", status: "pending" },
  { content: "开发和合并", status: "pending" },
  { content: "构建并测试", status: "pending" },
];
const delivery = { action: "complete", text: "只读完需求，尚未开发。", summary: "尚未完成。", deliverableRef: [] };
const unmet = (...steps: typeof plan) => steps.map((step) => ({ requirement: step.content, status: "unmet", evidence: "尚未执行" }));
async function running(employee: Employee, id: string) {
  await employee.update((state) => { employee.task(state, id).status = "running"; });
  employee.busy.set(id, { computer: false, session: "" });
}

test("计划可删改和合并，但不能通过删掉未完成步骤直接交付", async () => {
  const { store, employee, id } = await fixture();
  try {
    await employee.control({ action: "settings", instruction: "疑问先在需求单澄清" });
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "已读需求", plan });
    const changed = [plan[0], { content: "建议用户澄清", status: "completed" }];
    await employee.execute(id, { action: "progress", text: "调整计划", plan: changed });
    assert.deepEqual((await employee.state()).tasks[0].plan, changed);
    const reminder = await employee.execute(id, delivery);
    assert.equal(reminder.value.code, "outline_review_required");
    assert.match(reminder.value.task, /先在需求单联系创建人/);
    assert.match(reminder.value.principles, /需求单澄清/);
    assert.deepEqual(reminder.value.changedSteps, plan.slice(1).map(step => step.content));
    const incomplete = await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    assert.equal(incomplete.value.code, "outline_review_incomplete");
    assert.deepEqual(incomplete.value.changedSteps, plan.slice(2).map(step => step.content));
    await assert.rejects(employee.execute(id, { ...delivery, outlineReview: [{ requirement: plan[1].content, status: "met", evidence: " " }] }), /outlineReview/);
    const blocked = await employee.execute(id, { ...delivery, outlineReview: unmet(...plan.slice(1)) });
    assert.equal(blocked.value.code, "outline_unmet");
    assert(!(await employee.state()).tasks[0].completion);
    await employee.control({ action: "resume", id, text: "补充一个不改变目标的细节" });
    const revised = [plan[0], { content: "与创建人澄清，完成开发和验证", status: "pending" }];
    await employee.execute(id, { action: "progress", text: "合并步骤", plan: revised });
    assert.deepEqual((await employee.state()).tasks[0].plan, revised);
  } finally { employee.close(); await store.close(); }
});

test("合并后的计划经逐项对照可交付，替代的中间步骤无需批准", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "开始", plan });
    const merged = [{ content: "澄清需求并完成开发测试", status: "completed" }];
    const ready = await employee.execute(id, { action: "progress", text: "以合并步骤完成", plan: merged });
    assert.equal(ready.value.outlineReviewRequired, true);
    assert.deepEqual(ready.value.changedSteps, plan.map(step => step.content));
    const review = plan.map(step => ({ requirement: step.content, status: "met", evidence: "需求单回复、提交和测试回执" }));
    const result = await employee.execute(id, { ...delivery, text: "已完成澄清、开发和测试", outlineReview: review });
    assert.equal(result.value.status, undefined);
    assert.equal((await employee.state()).tasks[0].completion, "已完成澄清、开发和测试");
    assert.deepEqual((await employee.state()).tasks[0].outlineReview, review);
    assert.equal((await employee.state()).tasks[0].outlineReferences, undefined);
    await employee.execute(id, { action: "progress", text: "后续补充完成", plan: [...merged, { content: "补充事项", status: "completed" }] });
    const followUp = await employee.execute(id, { ...delivery, text: "后续补充已完成" });
    assert.equal(followUp.value.status, undefined, "已完成上次核对后，普通追加不需要重做旧审核");
    assert.equal((await employee.state()).tasks[0].completion, "后续补充已完成");
  } finally { employee.close(); await store.close(); }
});

test("取消不再需要的中间方法，不等于放弃用户要求", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "改用现有工具", plan: [
      { content: "完成用户要求", status: "completed" },
      { content: "编写临时脚本", status: "cancelled" },
    ] });
    const result = await employee.execute(id, { ...delivery, outlineReview: [
      { requirement: "完成用户要求", status: "met", evidence: "实际验证回执" },
      { requirement: "编写临时脚本", status: "not_applicable", evidence: "现有工具已覆盖" },
    ] });
    assert.equal(result.value.status, undefined);
    assert.equal((await employee.state()).tasks[0].completion, delivery.text);
  } finally { employee.close(); await store.close(); }
});

test("复核补交只发缺项，保留已填依据和交付内容", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "开始", plan });
    await employee.execute(id, { action: "progress", text: "澄清开发验证已完成", plan: [{ content: "按澄清回复开发并验证", status: "completed" }] });
    const review = plan.map(step => ({ requirement: step.content, status: "met", evidence: "已验证：" + step.content }));
    const first = await employee.execute(id, { ...delivery, text: "已完成澄清、开发和验证。", summary: "开发验证完成。", outlineReview: review.slice(0, 2) });
    assert.equal(first.value.code, "outline_review_incomplete");
    assert.deepEqual(first.value.changedSteps, plan.slice(2).map(step => step.content));
    assert(!first.stop);
    assert(!(await employee.state()).tasks[0].completion);
    const second = await employee.execute(id, { action: "complete", outlineReviewRetry: first.value.outlineReviewRetry, outlineReview: review.slice(2, 3) });
    assert.equal(second.value.code, "outline_review_incomplete");
    assert.deepEqual(second.value.changedSteps, [plan[3].content]);
    const result = await employee.execute(id, { action: "complete", outlineReviewRetry: second.value.outlineReviewRetry, outlineReview: review.slice(3) });
    assert.equal(result.stop, true);
    const task = (await employee.state()).tasks[0];
    assert.deepEqual(task.outlineReview, review);
    assert.equal(task.completion, "已完成澄清、开发和验证。");
    assert.equal(task.summary, "开发验证完成。");
  } finally { employee.close(); await store.close(); }
});

test("复核补交可按本次缺项序号引用含替换字符的历史步骤", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    const requirement = "公司上报体截断\uFFFD\uFFFD\uFFFD 平台无重复事件";
    await employee.execute(id, { action: "progress", text: "开始验证", plan: [{ content: requirement, status: "pending" }] });
    await employee.execute(id, { action: "progress", text: "统一复验完成", plan: [{ content: "验收并保留抓包证据", status: "completed" }] });
    const item = { changedStep: 1, status: "met", evidence: "已核对两条请求体" };
    await assert.rejects(employee.execute(id, { ...delivery, outlineReview: [{ ...item, changedStep: 2 }] }), /有效序号/);
    await assert.rejects(employee.execute(id, { ...delivery, outlineReview: [{ ...item, requirement }] }), /不能和 requirement 同时填写/);
    await assert.rejects(employee.execute(id, { ...delivery, summary: "字".repeat(405), outlineReview: [{ ...item, changedStep: 2 }] }), /Delivery summary requires 1–400 characters[\s\S]*另外：[\s\S]*有效序号/);
    const draft = await employee.execute(id, { ...delivery, text: "复验完成", outlineReview: [
      { requirement: "验收并保留抓包证据", status: "met", evidence: "抓包回执已保存" },
    ] });
    assert.equal(draft.value.code, "outline_review_incomplete");
    assert.deepEqual(draft.value.changedSteps, [requirement]);
    const retry = { action: "complete", outlineReviewRetry: draft.value.outlineReviewRetry };
    await assert.rejects(employee.execute(id, { ...retry, outlineReview: [{ ...item, changedStep: 2 }] }), /有效序号/);
    await assert.rejects(employee.execute(id, { ...retry, outlineReview: [{ ...item, requirement }] }), /不能和 requirement 同时填写/);
    const result = await employee.execute(id, { ...retry, outlineReview: [item] });
    assert.equal(result.stop, true);
    assert.deepEqual((await employee.state()).tasks[0].outlineReview.at(-1), { requirement, status: item.status, evidence: item.evidence });
  } finally { employee.close(); await store.close(); }
});

test("首次完整交付也可直接用 changedStep 引用 task_progress 返回的 changedSteps", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    const oldStep = "对查询失败项（如发布计划 403、标签字段缺失等）逐条记录卡点";
    await employee.execute(id, { action: "progress", text: "登记计划", plan: [{ content: oldStep, status: "pending" }] });
    const progress = await employee.execute(id, { action: "progress", text: "微调步骤并完成", plan: [{ content: "对查询失败项逐条记录卡点", status: "completed" }] });
    assert.equal(progress.value.outlineReviewRequired, true);
    assert.deepEqual(progress.value.changedSteps, [oldStep]);
    const result = await employee.execute(id, { ...delivery, text: "已记录全部卡点", summary: "已完成", outlineReview: [
      { changedStep: 1, status: "met", evidence: "已在报告第四节逐条记录卡点" },
    ] });
    assert.equal(result.stop, true);
    assert.deepEqual((await employee.state()).tasks[0].outlineReview, [
      { requirement: oldStep, status: "met", evidence: "已在报告第四节逐条记录卡点" },
    ]);
  } finally { employee.close(); await store.close(); }
});

test("补交草稿随计划变更失效，新草稿保留未满足项并阻止交付", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "开始", plan });
    await employee.execute(id, { action: "progress", text: "修改执行方案", plan: [plan[0]] });
    const draft = await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    assert.equal(draft.value.code, "outline_review_incomplete");
    const missingAsMet = draft.value.changedSteps.map((requirement: string) => ({ requirement, status: "met", evidence: "已核对回执" }));
    const patch = { action: "complete", outlineReview: missingAsMet };
    await employee.execute(id, { action: "progress", text: "补充核对", plan: [...plan.slice(0, 1), { content: "补充核对", status: "completed" }] });
    const stale = await employee.execute(id, { ...patch, outlineReviewRetry: draft.value.outlineReviewRetry });
    assert.equal(stale.value.code, "outline_review_retry_expired");
    const fresh = await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    assert.equal(fresh.value.code, "outline_review_incomplete");
    const blocked = await employee.execute(id, { ...patch, outlineReviewRetry: fresh.value.outlineReviewRetry });
    assert.equal(blocked.value.code, "outline_unmet");
    assert.equal(blocked.value.unmet[0].content, plan[1].content);
    assert(!(await employee.state()).tasks[0].completion);
  } finally { employee.close(); await store.close(); }
});

test("未经接受的取消步骤不能交付，拒绝部分交付后恢复原任务", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "已读需求", plan });
    const partial = plan.map((step, index) => index ? { ...step, status: "cancelled" } : step);
    await employee.execute(id, { action: "progress", text: "未执行余项", plan: partial });
    const result = await employee.execute(id, { ...delivery, outlineReview: unmet(...plan.slice(1)) });
    const pending = (await employee.state()).tasks[0];
    assert.equal(result.value.status, "approval");
    assert.equal(pending.status, "approval");
    assert.match(pending.approval, /@创建人澄清/);
    assert.match(pending.approval, /构建并测试/);
    assert(!pending.completion);
    employee.busy.delete(id);
    await employee.control({ action: "approve", id, approved: false });
    const resumed = (await employee.state()).tasks[0];
    assert.equal(resumed.status, "queued");
    assert.match(resumed.answer, /原任务仍需完成/);
    assert.deepEqual(resumed.plan, partial);
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "继续澄清", plan });
    await assert.rejects(employee.execute(id, delivery), /未验证步骤/);
    await employee.execute(id, { action: "progress", text: "已完成验证", plan: plan.map((step) => ({ ...step, status: "completed" })) });
    await employee.execute(id, { action: "complete", text: "澄清、开发和测试均已完成。", summary: "已完成。", deliverableRef: [] });
    assert.equal((await employee.state()).tasks[0].completion, "澄清、开发和测试均已完成。");
  } finally { employee.close(); await store.close(); }
});

test("同一批未完成要求重排后复用部分交付批准，并保留未验证状态", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    const remaining = plan.slice(1, 3);
    const review = unmet(...remaining);
    const met = { requirement: plan[0].content, status: "met", evidence: "已读需求" };
    await employee.execute(id, { action: "progress", text: "部分结果", plan: [plan[0], ...remaining.map((step) => ({ ...step, status: "cancelled" }))] });
    const first = await employee.execute(id, { ...delivery, outlineReview: [...review, met] });
    assert.equal(first.value.status, "approval");
    employee.busy.delete(id);
    await employee.control({ action: "approve", id, approved: true });
    await running(employee, id);
    const reordered = [met, review[1], review[0]];
    const result = await employee.execute(id, { ...delivery, outlineReview: reordered });
    assert.equal(result.value.status, undefined);
    assert.equal(result.stop, true);
    const task = await employee.findTask(id);
    assert.equal(task?.completion, delivery.text);
    assert.deepEqual(task?.outlineReview, reordered);
  } finally { employee.close(); await store.close(); }
});

test("用户补充产生新任务版本，原部分交付批准不能继续沿用", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    const partial = [plan[0], { ...plan[1], status: "cancelled" }];
    const attempt = { ...delivery, outlineReview: unmet(plan[1]) };
    await employee.execute(id, { action: "progress", text: "部分结果", plan: partial });
    assert.equal((await employee.execute(id, attempt)).value.status, "approval");
    employee.busy.delete(id);
    await employee.control({ action: "approve", id, approved: true });
    await employee.control({ action: "resume", id, text: "补充交付要求：在结论中说明影响" });
    await running(employee, id);
    assert.match((await employee.execute(id, attempt)).value.supplement, /在结论中说明影响/);
    await employee.execute(id, { action: "progress", text: "按补充更新交付", plan: partial });
    assert.equal((await employee.execute(id, attempt)).value.status, "approval");
    assert(!(await employee.findTask(id))?.completion);
  } finally { employee.close(); await store.close(); }
});

test("批准只针对已展示的未完成步骤，之后新增取消步骤仍须确认", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    const partial = [plan[0], { ...plan[1], status: "cancelled" }];
    await employee.execute(id, { action: "progress", text: "部分结果", plan: partial });
    await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    employee.busy.delete(id);
    await employee.control({ action: "approve", id, approved: true });
    await running(employee, id);
    const extra = { content: "新出现的验证", status: "cancelled" };
    await employee.execute(id, { action: "progress", text: "计划变更", plan: [...partial, extra] });
    const result = await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1], extra) });
    assert.equal(result.value.status, "approval");
    assert.match((await employee.state()).tasks[0].approval, /新出现的验证/);
    assert(!(await employee.state()).tasks[0].completion);
  } finally { employee.close(); await store.close(); }
});

test("恢复选择只授权展示过的待完成步骤；选择继续不会变成接受部分交付", async () => {
  const { store, employee, id } = await fixture();
  try {
    await employee.update((state) => {
      const t = employee.task(state, id);
      t.plan = [plan[0], { ...plan[1], status: "blocked" }];
      for (let i = 0; i < 4; i++) employee.recover(t, "连接受阻", 1000);
      assert.match(t.waiting, /@创建人澄清/);
    });
    await employee.control({ action: "answer", id, text: "2" });
    assert.equal((await employee.state()).tasks[0].settlePreferred, false);
    await employee.update((state) => {
      const t = employee.task(state, id);
      for (let i = 0; i < 4; i++) employee.recover(t, "仍受阻", 2000);
    });
    await employee.control({ action: "answer", id, text: "1" });
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "按用户选择收尾", plan: [plan[0], { ...plan[1], status: "cancelled" }] });
    const result = await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    assert.equal(result.value.status, undefined, "已对列出的缺口明确同意，不重复询问");
    assert.equal((await employee.state()).tasks[0].completion, delivery.text);
  } finally { employee.close(); await store.close(); }
});

test("没有展示具体缺口的旧收尾选择不能授权后来新增的取消步骤", async () => {
  const { store, employee, id } = await fixture();
  try {
    await employee.update((state) => {
      const task = employee.task(state, id);
      for (let i = 0; i < 4; i++) employee.recover(task, "受阻", 1000);
    });
    await employee.control({ action: "answer", id, text: "1" });
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "部分结果", plan: [plan[0], { ...plan[1], status: "cancelled" }] });
    const result = await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    assert.equal(result.value.status, "approval");
    assert.match((await employee.state()).tasks[0].approval, /@创建人澄清/);
  } finally { employee.close(); await store.close(); }
});

test("普通操作审批被拒绝时仍按原有规则取消", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "ask", text: "是否批准发布？" });
    employee.busy.delete(id);
    await employee.control({ action: "approve", id, approved: false });
    assert.equal((await employee.state()).tasks[0].status, "cancelled");
  } finally { employee.close(); await store.close(); }
});

test("部分交付走待批准通知，不能作为已完成发送", async () => {
  const { store, employee, runtime, id } = await fixture();
  try {
    const chat = await employee.chat("owner");
    runtime.run = async () => {
      await employee.execute(id, { action: "progress", text: "未完成", plan: [plan[0], { ...plan[1], status: "cancelled" }] });
      await employee.execute(id, { ...delivery, outlineReview: unmet(plan[1]) });
    };
    await running(employee, id);
    await employee.run(employee.task(await employee.state(), id));
    const task = (await employee.state()).tasks[0];
    assert.equal(task.status, "approval");
    assert(!task.completion);
    const message = (await store.messages(chat.id)).at(-1)!;
    assert.match(message.text!, /需要你处理/);
    assert.match(message.text!, /@创建人澄清/);
    assert.equal(message.tasks?.[0].status, "approval");
  } finally { employee.close(); await store.close(); }
});

test("澄清等待多次续做保留原任务、工作原则和外部回执，不重新提交", async () => {
  const { store, employee, runtime, id } = await fixture();
  let phase = 0;
  try {
    await employee.control({ action: "settings", instruction: "需求有疑问时在原单联系创建人，多轮澄清后开发" });
    runtime.run = async (session, prompt, _signal, input) => {
      phase++;
      assert.match(prompt, /原始任务/);
      assert.match((await employee.execute(id, { action: "list" })).value.instruction, /需求有疑问时在原单联系创建人/);
      await store.append(session, { role: "user", text: prompt, taskInput: input });
      if (phase === 1) {
        await employee.execute(id, { action: "progress", text: "已发出澄清", plan });
        await employee.execute(id, { action: "defer", text: "需求单 #42 已 @创建人，回执 #7；只检查回复，超时再求助", nextCheckInMinutes: 5 });
      } else if (phase === 2) {
        assert.match(prompt, /回执 #7/);
        assert.match(prompt, /同一轮澄清只检查原结果、不重复发送/);
        assert.match(prompt, /有新疑点可发新一轮澄清/);
        await employee.execute(id, { action: "defer", text: "需求单 #42 的回复仍待确认，第二轮回执 #8；只检查回复", nextCheckInMinutes: 5 });
      } else {
        assert.match(prompt, /第二轮回执 #8/);
        await employee.execute(id, { action: "progress", text: "澄清、开发、测试均已完成", plan: plan.map((step) => ({ ...step, status: "completed" })) });
        await employee.execute(id, { action: "complete", text: "已核对澄清回复并完成开发与测试。", summary: "已完成。", deliverableRef: [] });
      }
    };
    for (const expected of ["deferred", "deferred", "done"]) {
      await running(employee, id);
      await employee.run(employee.task(await employee.state(), id));
      assert.equal((await employee.state()).tasks[0].status, expected);
    }
    assert.equal(phase, 3);
    assert.equal((await store.sessions()).length, 1);
  } finally { employee.close(); await store.close(); }
});

test("反复微调计划措辞或错别字只锚定初始基线，不滚雪球；全步结束提示直接 task_complete", async () => {
  const { store, employee, id } = await fixture();
  try {
    await running(employee, id);
    await employee.execute(id, { action: "progress", text: "登记计划", plan: [
      { content: "抓取官方定价页", status: "in_progress" },
      { content: "撰写中文报告", status: "pending" },
    ] });
    // Draft typo rewrite #1
    await employee.execute(id, { action: "progress", text: "微调1", plan: [
      { content: "获取后官方定价页", status: "completed" },
      { content: "撰写中文报告", status: "in_progress" },
    ] });
    // Typo fix rewrite #2 + all completed
    const doneProgress = await employee.execute(id, { action: "progress", text: "微调2", plan: [
      { content: "获取官方定价页", status: "completed" },
      { content: "撰写中文报告", status: "completed" },
    ] });
    assert.equal(doneProgress.value.outlineReviewRequired, true);
    assert.deepEqual(doneProgress.value.changedSteps, ["抓取官方定价页"], "transient typo draft must not snowball into changedSteps");
    assert.match(doneProgress.value.next, /task_complete/, "settled plan must steer directly to task_complete");
    // Restoring original baseline wording clears spurious review requirement
    const restored = await employee.execute(id, { action: "progress", text: "恢复原步骤名", plan: [
      { content: "抓取官方定价页", status: "completed" },
      { content: "撰写中文报告", status: "completed" },
    ] });
    assert.equal(restored.value.outlineReviewRequired, undefined);
    assert.match(restored.value.next, /task_complete/);
  } finally { employee.close(); await store.close(); }
});
