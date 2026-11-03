import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { Redactor } from "../server/core/util";
import { employeeChatMessages } from "../web/src/conversation.js";
import { employeeCall } from "./public-call";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Chat employee" }, "owner").id), chat = employee.chat("owner");
  return { store, engine, employee, chat };
}

test("chat retries share an in-flight submission and failed setup remains retryable", async () => {
  const { store, engine, chat } = fixture();
  const message = { role: "user", actorId: "owner", text: "once", clientMessageId: "message-identifier-one", clientMessageHash: "hash-one" };
  let starts = 0, release!: () => void;
  engine.launch = async (session, input) => {
    starts++;
    await new Promise<void>((resolve) => release = resolve);
    if (starts === 1) throw Error("setup unavailable");
    store.append(session, input);
  };
  try {
    const one = engine.submitChat(chat.id, message), two = engine.submitChat(chat.id, message);
    const failures = Promise.allSettled([one, two]);
    await Promise.resolve();
    assert.equal(starts, 1);
    release();
    assert((await failures).every((result) => result.status === "rejected"));
    const retry = engine.submitChat(chat.id, message);
    await Promise.resolve(); release(); await retry;
    await engine.submitChat(chat.id, message);
    assert.equal(starts, 2);
    assert.equal(store.messages(chat.id).length, 1);
    await assert.rejects(engine.submitChat(chat.id, { ...message, clientMessageHash: "changed" }), /different content/);
    const other = engine.submitChat(chat.id, { ...message, actorId: "other-user" });
    await Promise.resolve(); release(); await other;
    assert.equal(store.messages(chat.id).length, 2, "IDs are scoped to the authenticated sender");
  } finally { await engine.close(); store.close(); }
});

test("queued chat retries are deduplicated without inserting the next actor's input into the current model turn", async () => {
  const { store, engine, chat } = fixture();
  let finish!: () => void, calls = 0;
  const gate = new Promise<void>((resolve) => finish = resolve);
  engine.providers.chat = async () => { if (++calls === 1) await gate; return { role: "assistant", text: "done" }; };
  const first = { role: "user", actorId: "owner", text: "first", clientMessageId: "message-identifier-first", clientMessageHash: "first-hash" };
  const second = { ...first, text: "second", clientMessageId: "message-identifier-second", clientMessageHash: "second-hash" };
  const done = new Promise<void>((resolve) => engine.events.on("event", (event) => { if (event.type === "done" && event.session === chat.id) resolve(); }));
  try {
    await engine.submitChat(chat.id, first);
    // Wait until the first model turn, so the next message takes the steer path.
    for (let i = 0; i < 100 && !calls; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    await Promise.all([engine.submitChat(chat.id, second), engine.submitChat(chat.id, second)]);
    assert.equal(engine.active.get(chat.id)!.steer.length, 1);
    assert.equal(store.messages(chat.id).filter((message) => message.role === "user").length, 1, "steering enters history only when its actor becomes active");
    finish(); await done;
    assert.equal(calls, 2);
    await engine.submitChat(chat.id, first);
    await engine.submitChat(chat.id, second);
    assert.equal(calls, 2);
    assert.equal(store.messages(chat.id).filter((message) => message.role === "user").length, 2);
  } finally { finish(); await engine.close(); store.close(); }
});

test("employee chat shows user messages and final conclusions only; process details and partial streaming text stay in execution records", () => {
  const messages = [
    { seq: 1, role: "user", text: "work" },
    { seq: 2, role: "assistant", text: "I will inspect", thinking: "private reasoning", calls: [{ id: "read", name: "read" }] },
    { seq: 3, role: "tool", name: "read", callId: "read", text: "details" },
    { seq: 4, role: "assistant", text: "Verified outcome" },
    { seq: 5, role: "user", text: "next" },
    { seq: 6, role: "assistant", text: "partial text" },
    { seq: 7, role: "assistant", text: "Independent task delivered", delivery: true },
  ];
  assert.deepEqual(employeeChatMessages(messages, true).map((message: any) => message.seq), [1, 4, 5, 7]);
  assert.deepEqual(employeeChatMessages(messages, false).map((message: any) => message.seq), [1, 4, 5, 6, 7]);
  assert.equal(messages[1].thinking, "private reasoning", "the minimal chat projection never removes canonical process history");
});

test("task delivery quotes its originating chat message, carries a task link and sends a brief summary without losing the full report", async () => {
  const { store, engine, employee, chat } = fixture();
  const original = "Investigate the endpoint. " + "Keep the scope read-only. ".repeat(20);
  let calls = 0;
  engine.providers.chat = async () => calls++ === 0
    ? { role: "assistant", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Investigate endpoint", profile: "coding" }) }] }
    : { role: "assistant", text: "调查已安排。" };
  try {
    await engine.run(chat.id, { role: "user", text: original });
    let job = employee.state().tasks[0];
    assert.equal(job.chatSource.session, chat.id);
    assert.equal(job.chatSource.seq, 1);
    assert.equal(store.messages(chat.id).at(-1)?.tasks?.[0].id, job.id);
    const full = "Full verified evidence\n" + "Trace details that belong to the task record.\n".repeat(60);
    employee.runtime.run = async () => {
      await employee.execute(job.id, { action: "progress", text: "verified endpoint", plan: [{ content: "verify endpoint", status: "completed" }] });
      await assert.rejects(employee.execute(job.id, { action: "complete", deliverableRef: [], text: full, summary: "x".repeat(401) }), /summary/);
      await employee.execute(job.id, { action: "complete", deliverableRef: [], text: full, summary: "**结论**：地址已确认。\n- 未修改配置或重试请求。" });
    };
    employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    job = employee.state().tasks[0];
    assert.equal(job.status, "done");
    assert.equal(job.result, full.trim());
    const conclusion = store.messages(job.workSession).at(-1)!;
    assert.equal(conclusion.role, "assistant");
    assert.equal(conclusion.text, "**结论**：地址已确认。\n- 未修改配置或重试请求。");
    assert(!conclusion.calls?.length);
    const delivery = store.messages(chat.id).at(-1)!;
    assert.equal(delivery.delivery, true);
    assert.equal(delivery.quote?.seq, 1);
    assert(delivery.quote!.text.endsWith("…") && delivery.quote!.text.length <= 161);
    assert.equal(delivery.tasks?.[0].id, job.id);
    assert.match(delivery.text!, /地址已确认/);
    assert(!delivery.text!.includes("Trace details") && delivery.text!.length < 100);
  } finally { await engine.close(); store.close(); }
});

test("complete feedback identifies missing evidence, unverified steps and stale plan revisions without completing the task", async () => {
  const { store, engine, employee } = fixture();
  const verified = [{ content: "verify result", status: "completed" }];
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify result" });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    const cases = [
      { text: " ", plan: verified, planRevision: 2, revision: 2, error: /evidence=空/ },
      { text: "actual evidence", plan: [], planRevision: 2, revision: 2, error: /plan=0步/ },
      { text: "actual evidence", plan: ["in_progress", "blocked", "failed", "completed"].map(status => ({ content: "verify result", status })), planRevision: 2, revision: 2, error: /未验证步骤=1:in_progress、2:blocked、3:failed/ },
      { text: "actual evidence", plan: verified, planRevision: 1, revision: 2, error: /planRevision=1，revision=2/ },
    ];
    for (const scenario of cases) {
      employee.update(state => { Object.assign(state.tasks[0], { status: "running", plan: scenario.plan, planRevision: scenario.planRevision, revision: scenario.revision }); });
      const before = structuredClone(employee.state().tasks[0]);
      await assert.rejects(employee.execute(created.value.id, { action: "complete", deliverableRef: [], text: scenario.text, summary: "Verified outcome" }), { message: scenario.error });
      assert.deepEqual(employee.state().tasks[0], before);
    }
    await employee.execute(created.value.id, { action: "progress", text: "latest result verified", plan: verified });
    const completed = await employee.execute(created.value.id, { action: "complete", deliverableRef: [], text: "actual verified evidence", summary: "Verified outcome" });
    assert.equal(completed.stop, true);
    assert.equal(employee.state().tasks[0].completion, "actual verified evidence");
    assert.equal(employee.state().tasks[0].planRevision, 2);
  } finally { await engine.close(); store.close(); }
});

test("complete accepts cancelled steps as settled partial delivery and progress marks settlePreferred", async () => {
  const { store, engine, employee } = fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Design cases" });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    employee.update(state => { Object.assign(state.tasks[0], { status: "running", revision: 0, planRevision: 0 }); });
    await employee.execute(created.value.id, {
      action: "progress",
      text: "partial delivery accepted",
      plan: [
        { content: "read requirement", status: "completed" },
        { content: "design case list", status: "completed" },
        { content: "execute remaining cases", status: "cancelled" },
      ],
    });
    assert.equal(employee.state().tasks[0].settlePreferred, true);
    const completed = await employee.execute(created.value.id, {
      action: "complete", deliverableRef: [],
      text: "Case list delivered; remaining execution cancelled per user.",
      summary: "已交付用例清单；未执行项已标注取消。",
    });
    assert.equal(completed.stop, true);
    assert.equal(employee.state().tasks[0].completion.includes("Case list"), true);
  } finally { await engine.close(); store.close(); }
});

test("complete still rejects blocked/failed/in_progress steps and hints cancelled for user settle", async () => {
  const { store, engine, employee } = fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify result" });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    employee.update(state => {
      Object.assign(state.tasks[0], {
        status: "running",
        revision: 1,
        planRevision: 1,
        plan: [
          { content: "done", status: "completed" },
          { content: "stuck", status: "blocked" },
        ],
      });
    });
    await assert.rejects(
      employee.execute(created.value.id, { action: "complete", deliverableRef: [], text: "partial", summary: "partial" }),
      /未验证步骤=2:blocked[\s\S]*cancelled/,
    );
  } finally { await engine.close(); store.close(); }
});

test("complete summary feedback reports character counts and preserves the previous result until a valid correction", async () => {
  const { store, engine, employee } = fixture();
  const boundary = "字".repeat(200) + "😀".repeat(200);
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify result" });
    employee.update(state => { Object.assign(state.tasks[0], { status: "running", plan: [{ content: "verify", status: "completed" }], summary: "previous summary", completion: "previous evidence" }); });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    const before = structuredClone(employee.state().tasks[0]);
    for (const { summary, length } of [{ summary: "", length: 0 }, { summary: " \n\t", length: 3 }, { summary: boundary + "。", length: 401 }, { summary: boundary + " ", length: 401 }, { summary: 42, length: 0 }]) {
      await assert.rejects(employee.execute(created.value.id, { action: "complete", deliverableRef: [], text: "new verified evidence", summary }), {
        message: new RegExp(`Delivery summary requires 1–400 characters; received ${length}.*请先填写或精简summary`),
      });
      assert.deepEqual(employee.state().tasks[0], before);
    }
    const completed = await employee.execute(created.value.id, { action: "complete", deliverableRef: [], text: "new verified evidence", summary: boundary });
    assert.equal(completed.stop, true);
    assert.equal(employee.state().tasks[0].summary, boundary);
    assert.equal(employee.state().tasks[0].completion, "new verified evidence");
  } finally { await engine.close(); store.close(); }
});

test("scheduled execution records persist conclusions for stopping task tools without another model request", async () => {
  const cases = [
    { arguments: { action: "complete", deliverableRef: [], text: "已核验完整证据，未修改配置。", summary: "已确认实际地址，未修改配置。" }, status: "done", conclusion: /已确认实际地址，未修改配置/ },
    { arguments: { action: "ask", text: "是否批准发布？" }, status: "approval", conclusion: /等待你确认：是否批准发布/ },
    { arguments: { action: "help", text: "请提供目标环境。" }, status: "waiting", conclusion: /需要你处理：请提供目标环境/ },
    { arguments: { action: "defer", text: "导出作业export-123已提交，只检查原作业。", nextCheckInMinutes: 5 }, status: "deferred", conclusion: /已挂起[\s\S]*export-123/ },
    { arguments: { action: "relay", scene: "computer", text: "在已打开的网页检查结果，不重新提交。" }, status: "queued", conclusion: /已交接电脑会话[\s\S]*主任务尚未完成/ },
  ];
  for (const scenario of cases) {
    const { store, engine, employee } = fixture();
    let requests = 0;
    engine.providers.chat = async () => {
      assert.equal(++requests, 1, "stopping a task must not request an extra model turn just to generate its conclusion");
      return { role: "assistant", calls: [{ id: "stop", ...employeeCall(scenario.arguments) }] };
    };
    try {
      const created = await employee.execute("", { action: "add", kind: "todo", text: "Verify an existing result" });
      employee.update(state => { Object.assign(state.tasks[0], { status: "running", plan: [{ content: "verify result", status: "completed" }] }); });
      employee.busy.set(created.value.id, { computer: false, session: "" });
      await employee.run(employee.state().tasks[0]);
      const job = employee.state().tasks[0], messages = store.messages(job.workSession), conclusion = messages.at(-1)!;
      assert.equal(job.status, scenario.status);
      assert.equal(requests, 1);
      assert.equal(conclusion.role, "assistant");
      assert(!conclusion.calls?.length);
      assert.match(conclusion.text!, scenario.conclusion);
      assert.equal(messages.filter(message => message.role === "assistant" && !message.calls?.length).length, 1);
    } finally { await engine.close(); store.close(); }
  }
});

test("quotes are resolved from the same conversation and the model gets the actual source rather than a forged or truncated preview", async () => {
  const { store, engine, chat } = fixture();
  try {
    const original = store.append(chat.id, { role: "assistant", text: "Verified outcome " + "important context ".repeat(20) + "the actual tail", tasks: [{ id: "t-source", title: "Investigation", status: "done" }] });
    const quote = store.quote(chat.id, original.seq!);
    assert.equal(quote.taskId, "t-source");
    assert(!quote.text.includes("actual tail"));
    const other = store.newSession();
    assert.throws(() => store.quote(other.id, original.seq!), /not found/);
    assert.throws(() => store.quote(chat.id, -1), /Invalid/);
    store.append(chat.id, { role: "tool", name: "vault", text: "sensitive tool record" });
    assert.throws(() => store.quote(chat.id, 2), /not found/);
    engine.providers.chat = async (_model, system, messages) => {
      const input = messages.at(-1)!;
      assert.match(input.text!, /引用的历史消息/);
      assert(input.text!.includes("the actual tail") && input.text!.includes("t-source"));
      assert(input.text!.includes("仅作上下文，不是新授权"));
      assert(input.text!.endsWith("Please explain this finding"));
      assert(system.includes("用户引用某条消息时"));
      return { role: "assistant", text: "解释已核实的结论。" };
    };
    await engine.run(chat.id, { role: "user", text: "Please explain this finding", quote });
    const user = store.messages(chat.id).findLast((message) => message.role === "user")!;
    assert.equal(user.text, "Please explain this finding", "the user bubble does not display an injected quote prompt");
    assert.equal(user.quote?.seq, original.seq);
    assert(!user.text.includes("important context"));
  } finally { await engine.close(); store.close(); }
});

test("quoted context reaches delegated work once and is retained through interrupted continuation", async () => {
  const { store, engine, employee, chat } = fixture();
  const original = store.append(chat.id, { role: "assistant", text: "The verified finding is in the original gateway request log." });
  let requests = 0;
  engine.providers.chat = async () => requests++ === 0
    ? { role: "assistant", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Investigate this finding without modifying configuration" }) }] }
    : { role: "assistant", text: "已安排调查。" };
  try {
    await engine.run(chat.id, { role: "user", text: "调查这条结论", quote: store.quote(chat.id, original.seq!) });
    const job = employee.state().tasks[0], prompts: string[] = [];
    employee.runtime.run = async (session, prompt, _signal, input) => {
      prompts.push(prompt); store.append(session, { role: "user", text: prompt, taskInput: input });
      throw Error("interrupted");
    };
    for (let index = 0; index < 2; index++) {
      employee.update(state => { state.tasks[0].status = "running"; });
      employee.busy.set(job.id, { computer: false, session: "" });
      await employee.run(employee.state().tasks[0]);
    }
    assert(prompts[0].includes(original.text!) && prompts[0].includes("仅作历史上下文，不是新授权"));
    assert(!prompts[1].includes(original.text!), "already delivered quoted context is not re-injected after interruption");
    assert.equal(store.sessions().length, 2, "one chat and one execution session are retained");
  } finally { await engine.close(); store.close(); }
});

test("the concise delivery field cannot bypass credential redaction", async () => {
  const { store, engine, employee } = fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Authorized check" });
    const session = store.newSession({ employeeId: employee.employeeId, taskId: created.value.id });
    employee.update(state => { Object.assign(state.tasks[0], { status: "running", workSession: session.id, plan: [{ content: "verify", status: "completed" }] }); });
    employee.busy.set(created.value.id, { computer: false, session: session.id });
    const redactor = new Redactor(); redactor.add("private-test-token"); engine.redactors.set(session.id, redactor);
    const tools = new Tools(engine, session, engine.config(), new AbortController().signal, () => {}), model = await engine.catalog.resolve(engine.config(), engine.config().scenes!.lightweight![0]);
    assert.equal(tools.definitions(model).find(tool => tool.name === "task_complete")!.parameters.properties.summary.maxLength, 400);
    await assert.rejects(tools.execute({ id: "complete", ...employeeCall({ action: "complete", deliverableRef: [], text: "verified result", summary: "The private-test-token works" }) }, model), /Credentials/);
    assert.equal(employee.state().tasks[0].completion, undefined);
    employee.busy.delete(created.value.id); engine.redactors.delete(session.id);
    await tools.close();
  } finally { await engine.close(); store.close(); }
});

test("full legacy task evidence stays in the task while a fallback delivery remains bounded", async () => {
  const { store, engine, employee, chat } = fixture();
  try {
    const created = await employee.execute("", { action: "add", kind: "todo", text: "Legacy job" });
    const job = employee.task(employee.state(), created.value.id), full = "Verified result. ".repeat(200);
    employee.runtime.run = async () => {
      await employee.execute(job.id, { action: "progress", text: "verified", plan: [{ content: "verify", status: "completed" }] });
      await employee.execute(job.id, { action: "complete", deliverableRef: [], text: full });
    };
    employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    assert.equal(employee.state().tasks[0].result, full.trim());
    const delivery = store.messages(chat.id).at(-1)!;
    assert(delivery.text!.length <= 420 && delivery.text!.endsWith("…"));
    assert.equal(delivery.tasks?.[0].id, job.id);
  } finally { await engine.close(); store.close(); }
});

test("answer appends a quoted user message in chat without duplicating identical replies", async () => {
  const { store, engine, employee, chat } = fixture();
  let calls = 0;
  engine.providers.chat = async () => calls++ === 0
    ? { role: "assistant", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "Need a verification code", profile: "coding" }) }] }
    : { role: "assistant", text: "已安排。" };
  try {
    await engine.run(chat.id, { role: "user", text: "帮我登录并核对" });
    const job = employee.state().tasks[0];
    employee.runtime.run = async () => {
      await employee.execute(job.id, { action: "help", text: "请提供邮箱里的 6 位验证码" });
    };
    employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    const delivery = store.messages(chat.id).findLast((message) => message.delivery)!;
    assert.equal(delivery.tasks?.[0].id, job.id);
    assert.match(delivery.text!, /6 位验证码/);
    assert.equal(employee.state().tasks[0].status, "waiting");
    await employee.control({ action: "answer", id: job.id, text: "123456" }, { token: "", name: "林林" });
    const users = store.messages(chat.id).filter((message) => message.role === "user" && message.text === "123456");
    assert.equal(users.length, 1);
    assert.equal(users[0].quote?.seq, delivery.seq);
    assert.match(users[0].quote!.text, /验证码|需要你处理/);
    assert.equal(employee.appendChatReply(chat.id, delivery, "123456")?.seq, users[0].seq);
    assert.equal(store.messages(chat.id).filter((message) => message.role === "user" && message.text === "123456").length, 1);
  } finally { await engine.close(); store.close(); }
});

test("clearEmployeeChat drops chat messages and folds but keeps the session and tasks", async () => {
  const { store, engine, employee, chat } = fixture();
  try {
    store.append(chat.id, { role: "user", text: "hello" });
    store.append(chat.id, { role: "assistant", text: "hi" });
    store.db.prepare("INSERT INTO folds VALUES(?,?,?)").run(chat.id, "fold-1", JSON.stringify({ summary: "old" }));
    store.save("context-state", chat.id, { ledger: ["x"] });
    employee.update((state) => {
      state.tasks.push({ id: "task-keep", text: "keep me", status: "done", createdAt: Date.now(), profile: "coding", cwd: state.cwd, owner: { token: "", name: "owner" } });
    });
    const events: any[] = [];
    engine.events.on("event", (event) => events.push(event));
    assert.deepEqual(engine.clearEmployeeChat(employee.employeeId), { ok: true, cleared: true });
    assert.equal(store.messages(chat.id).length, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM folds WHERE session=?").get(chat.id).n, 0);
    assert.equal(store.object("context-state", chat.id), undefined);
    assert.ok(store.session(chat.id));
    assert.equal(employee.state().chatSession, chat.id);
    assert.equal(employee.state().tasks.some((task) => task.id === "task-keep"), true);
    assert.ok(events.some((event) => event.type === "compacted" && event.session === chat.id && event.data?.cleared));
    assert.ok(events.some((event) => event.type === "employee_changed" && event.data?.employeeId === employee.employeeId));
    assert.deepEqual(engine.clearEmployeeChat(employee.employeeId), { ok: true, cleared: true });
  } finally { await engine.close(); store.close(); }
});

test("clearEmployeeChat refuses while the chat turn is still running", async () => {
  const { store, engine, employee, chat } = fixture();
  try {
    engine.active.set(chat.id, { control: new AbortController(), steer: [] } as any);
    assert.throws(() => engine.clearEmployeeChat(employee.employeeId), /先停止/);
  } finally {
    engine.active.delete(chat.id);
    await engine.close();
    store.close();
  }
});

test("complete delivers the cited deliverable body verbatim instead of only the summary", async () => {
  const { store, engine, employee, chat } = fixture();
  let calls = 0;
  engine.providers.chat = async () => calls++ === 0
    ? { role: "assistant", calls: [{ id: "assign", ...employeeCall({ action: "add", kind: "todo", text: "写测试用例清单" }) }] }
    : { role: "assistant", text: "已安排。" };
  try {
    await engine.run(chat.id, { role: "user", text: "写测试用例清单" });
    let job = employee.state().tasks[0];
    const body = "# 测试用例清单\n" + "TC-01 指标卡标题取管理端配置。\n".repeat(30);
    employee.runtime.run = async (session: string) => {
      const reply = store.append(session, { role: "assistant", model: "fixture/model", text: body, calls: [{ id: "p", name: "employee", arguments: {} }] });
      const progressed = await employee.execute(job.id, { action: "progress", text: "清单已写完", plan: [{ content: "写清单", status: "completed" }] });
      assert.equal(progressed.value.textRef, reply.seq, "tool receipts expose the reply number to cite");
      await assert.rejects(employee.execute(job.id, { action: "complete", text: "证据", summary: "交付25条用例。" }), /deliverableRef[\s\S]*#\d+（/);
      await employee.execute(job.id, { action: "complete", deliverableRef: [reply.seq], text: "证据：已读需求单。", summary: "交付25条用例。" });
    };
    employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    job = employee.state().tasks[0];
    assert.equal(job.status, "done");
    assert(job.result.startsWith(body.trim()) && job.result.includes("证据：已读需求单。"));
    const conclusion = store.messages(job.workSession).at(-1)!;
    assert(conclusion.text!.startsWith(body.trim()) && conclusion.text!.endsWith("交付25条用例。"));
    assert.match(store.messages(chat.id).at(-1)!.text!, /完整交付物见任务详情/);
  } finally { await engine.close(); store.close(); }
});
