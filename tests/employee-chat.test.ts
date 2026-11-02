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

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Chat employee" }, "owner").id), chat = employee.chat("owner");
  return { store, engine, employee, chat };
}

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
    ? { role: "assistant", calls: [{ id: "assign", name: "employee", arguments: { action: "add", kind: "todo", text: "Investigate endpoint", profile: "coding" } }] }
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
      await assert.rejects(employee.execute(job.id, { action: "complete", text: full, summary: "x".repeat(401) }), /summary/);
      await employee.execute(job.id, { action: "complete", text: full, summary: "**结论**：地址已确认。\n- 未修改配置或重试请求。" });
    };
    employee.update((state) => { state.tasks[0].status = "running"; });
    employee.busy.set(job.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    job = employee.state().tasks[0];
    assert.equal(job.status, "done");
    assert.equal(job.result, full.trim());
    const delivery = store.messages(chat.id).at(-1)!;
    assert.equal(delivery.delivery, true);
    assert.equal(delivery.quote?.seq, 1);
    assert(delivery.quote!.text.endsWith("…") && delivery.quote!.text.length <= 161);
    assert.equal(delivery.tasks?.[0].id, job.id);
    assert.match(delivery.text!, /地址已确认/);
    assert(!delivery.text!.includes("Trace details") && delivery.text!.length < 100);
  } finally { await engine.close(); store.close(); }
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
    ? { role: "assistant", calls: [{ id: "assign", name: "employee", arguments: { action: "add", kind: "todo", text: "Investigate this finding without modifying configuration" } }] }
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
    const tools = new Tools(engine, session, engine.config(), new AbortController().signal, () => {}), model = await engine.catalog.resolve(engine.config());
    assert.equal(tools.definitions(model).find(tool => tool.name === "employee")!.parameters.properties.summary.maxLength, 400);
    await assert.rejects(tools.execute({ id: "complete", name: "employee", arguments: { action: "complete", text: "verified result", summary: "The private-test-token works" } }, model), /Credentials/);
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
      await employee.execute(job.id, { action: "complete", text: full });
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
