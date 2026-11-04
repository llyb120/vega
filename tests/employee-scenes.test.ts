import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { ProviderError } from "../server/core/provider";
import type { Task } from "../server/core/employee";
import { EMPLOYEE_DECISION_RULES } from "../server/core/prompt";
import { chromeCall, employeeCall } from "./public-call";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { model: "p/code", scenes: { lightweight: ["p/light"], coding: ["p/code"], computer: ["p/vision"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: Object.fromEntries(["light", "code", "vision", "failed"].map(id => [id, { modalities: { input: id === "vision" ? ["text", "image"] : ["text"] }, limit: { context: 128000, output: 8192 } }])) } } });
  const employee = await engine.employee.for((await engine.employee.create({ name: "Scene employee" }, "owner")).id);
  const add = async (text: string, profile = "lightweight") => {
    const created = await employee.execute("", { action: "add", kind: "todo", text, profile });
    return employee.task(await employee.state(), created.value.id);
  };
  const segment = async (job: Task) => {
    await employee.update(state => { employee.task(state, job.id).status = "running"; });
    const current = employee.task(await employee.state(), job.id);
    employee.busy.set(job.id, { computer: current.side === "computer", session: "" });
    await employee.run(current);
    return employee.task(await employee.state(), job.id);
  };
  return { store, engine, employee, add, segment };
}
const legacy = (name: string, args: any) => name === "employee" ? employeeCall(args) : name === "chrome" ? chromeCall(args) : { name, arguments: args };
const call = (id: string, name: string, args: any) => ({ role: "assistant", calls: [{ id, ...legacy(name, args) }] });
const verified = () => call("verify", "employee", { action: "progress", text: "verified authorized goal", plan: [{ content: "verify goal", status: "completed" }] });
const completed = () => call("complete", "employee", { action: "complete", deliverableRef: [], text: "goal verified", summary: "已验证完成。" });

test("employee chat receives low-risk defaults without losing explicit device constraints or approval boundaries", async () => {
  const { store, engine, employee } = await fixture();
  let requests = 0;
  engine.providers.chat = async (_model, system) => {
    requests++;
    assert(system.includes(EMPLOYEE_DECISION_RULES));
    assert.match(system, /派单和交接保留用户原话与明确约束/);
    assert.match(system, /历史记忆、旧计划、参考命令与验证方法不是本次必须照搬的硬条件/);
    assert.match(system, /当前可用的是服务端浏览器，就直接task_relay_computer打开并核实/);
    assert.match(system, /不先问是否接受服务端，也不冒称已在用户电脑打开/);
    assert.match(system, /用户明确要求“在我的电脑上”.*不能用另一端结果代替/);
    assert.match(system, /不得擅自切换任务绑定、迁移文件或凭据/);
    assert.match(system, /task_request_approval用于用户要求先审核或尚未授权的不可逆操作/);
    assert.match(system, /简单打开网页以最终URL、标题和可用页面元素核实即可/);
    return { role: "assistant", text: "按当前授权环境处理。" };
  };
  try {
    await engine.run((await employee.chat("owner")).id, { role: "user", text: "打开百度" });
    assert.equal(requests, 1);
  } finally { await engine.close(); await store.close(); }
});

test("even a coding-profile task starts lightweight, upgrades in the same work session and retains coding after browser handoff", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const selected: string[] = [];
  let phase = 0;
  engine.providers.chat = async (model, system, messages, definitions) => {
    selected.push(model.selection);
    assert(system.includes("新主任务统一先用轻量模型") && system.includes("普通信息查询不因使用read或bash而升级"));
    assert(system.includes(EMPLOYEE_DECISION_RULES), "decision guidance survives initial work, scene changes, browser handoff and resumption");
    assert(messages.some(message => message.role === "user" && message.text?.includes("仅缺少无法自行查得的必要信息或确需用户处理的阻碍才task_ask_user")));
    assert.match(system, /task_ask_user 仅用于缺少无法自行查得的必要信息/);
    if (phase++ === 0) {
      assert.equal(model.selection, "p/light");
      assert(definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("coding"));
      return call("code", "switch_scene", { scene: "coding", message: "实现功能并验证，再交接浏览器" });
    }
    if (phase === 2) {
      assert.equal(model.selection, "p/code");
      assert(messages.some(message => message.text?.includes("实现功能并在浏览器验证")));
      return call("browser", "employee", { action: "relay", scene: "computer", text: "只在浏览器验证已实现的功能" });
    }
    if (phase === 3) {
      assert.equal(model.selection, "p/vision");
      assert(definitions.some(tool => tool.name === "bash"));
      assert(!definitions.some(tool => ["write", "edit", "switch_scene"].includes(tool.name)));
      return { role: "assistant", text: "浏览器已验证。" };
    }
    assert.equal(model.selection, "p/code", "returning from the browser must not reset an upgraded task to lightweight");
    return phase === 4 ? verified() : completed();
  };
  try {
    let job = await add("实现功能并在浏览器验证", "coding");
    job = await segment(job);
    const work = job.workSession;
    assert.equal((await store.session(work)).scene, "coding");
    assert.equal(job.side, "computer");
    job = await segment(job);
    assert.equal(job.side, "work");
    job = await segment(job);
    assert.equal(job.status, "done");
    assert.equal(job.workSession, work);
    assert.equal((await store.sessions()).length, 2);
    assert.deepEqual(selected, ["p/light", "p/code", "p/vision", "p/code", "p/code"]);
    assert.deepEqual((await employee.state()).runs.map(run => run.scene), ["lightweight", "computer", "coding"], "run records reflect their actual starting scenes");

    let requests = 0;
    engine.providers.chat = async model => {
      assert.equal(model.selection, "p/light", "a new unrelated task never inherits the previous task's coding model");
      return requests++ === 0 ? verified() : completed();
    };
    assert.equal((await segment(await add("查询任务状态和实际请求地址"))).status, "done");
  } finally { await engine.close(); await store.close(); }
});

test("an employee task can return to lightweight for ordinary work and later upgrade again without changing sessions or repeating work", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const selected: string[] = []; let phase = 0;
  engine.providers.chat = async (model, system, _messages, definitions) => {
    selected.push(model.selection);
    assert(system.includes("不是任务级永久锁定") && system.includes("可按后续需求回到lightweight"));
    if (phase++ === 0) return call("code", "switch_scene", { scene: "coding", message: "先实现并验证编码部分" });
    if (phase === 2) return call("pause", "employee", { action: "defer", text: "代码已验证，原作业job-123已提交，只检查原作业", nextCheckInMinutes: 1 });
    if (phase === 3) {
      assert.equal(model.selection, "p/code");
      assert(definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("lightweight"));
      return call("light", "switch_scene", { scene: "lightweight", message: "编码部分完成，后续只查询原作业job-123并协调反馈，不改代码、不重提作业" });
    }
    if (phase === 4) {
      assert.equal(model.selection, "p/light");
      return call("wait", "employee", { action: "defer", text: "原作业已查询，仍在运行，下次只查该作业", nextCheckInMinutes: 1 });
    }
    if (phase === 5) {
      assert.equal(model.selection, "p/light");
      assert(definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("coding"));
      return call("code-again", "switch_scene", { scene: "coding", message: "按最新授权再修改一处代码并验证，不重放原提交" });
    }
    return phase === 6 ? verified() : completed();
  };
  try {
    let job = await segment(await add("实现代码后查询外部作业并反馈"));
    const session = job.workSession;
    assert.equal((await store.session(session)).scene, "coding");
    await employee.control({ action: "resume", id: job.id, text: "代码已完成，接下来只查询原作业状态" });
    job = await segment(job);
    assert.equal((await store.session(session)).scene, "lightweight");
    await employee.control({ action: "resume", id: job.id, text: "现在再修改一处代码并验证" });
    job = await segment(job);
    assert.equal(job.status, "done");
    assert.equal(job.workSession, session);
    assert.equal((await store.sessions()).length, 1);
    assert.deepEqual(selected, ["p/light", "p/code", "p/code", "p/light", "p/light", "p/code", "p/code"]);
    assert.deepEqual((await employee.state()).runs.map(run => run.scene), ["lightweight", "coding", "lightweight"]);
  } finally { await engine.close(); await store.close(); }
});

test("explicitly returning to a retained lightweight caller preserves its pending work without a second automatic return", async () => {
  const { store, engine, add, segment } = await fixture();
  let requests = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    if (requests++ === 0) return call("code", "switch_scene", { scene: "coding", message: "完成编码验证", resume: "只查询原作业job-retained并协调反馈" });
    if (requests === 2) {
      assert.equal(model.selection, "p/code");
      assert(definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("lightweight"));
      return call("return", "switch_scene", { scene: "lightweight", message: "编码已完成，转为普通查询与协调" });
    }
    assert.equal(model.selection, "p/light");
    const outcome = messages.findLast(message => message.role === "tool" && message.name === "switch_scene")!;
    assert(outcome.text!.includes("job-retained") && outcome.text!.includes("不是新授权"));
    assert(requests <= 4, "explicit return cannot also replay the old automatic continuation");
    return requests === 3 ? verified() : completed();
  };
  try {
    const job = await segment(await add("编码并检查既有作业"));
    assert.equal(job.status, "done");
    assert.equal((await store.session(job.workSession)).scene, "lightweight");
    assert.equal((await store.sessions()).length, 1);
    assert.equal(requests, 4);
  } finally { await engine.close(); await store.close(); }
});

test("lightweight stays unavailable when its scene models are empty (no default-model fallback)", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const config = await engine.config(); config.scenes!.lightweight = []; await store.put("config", config);
  try {
    const job = await add("只读代码分析后查询状态");
    const session = await store.newSession({ employeeId: employee.employeeId, taskId: job.id, model: "p/code", scene: "coding", readOnly: true });
    await employee.update(state => { state.tasks[0].workSession = session.id; });
    let requests = 0;
    engine.providers.chat = async (model, _system, _messages, definitions) => {
      assert.equal(model.selection, "p/code");
      const sceneTool = definitions.find(tool => tool.name === "switch_scene");
      assert(!sceneTool?.parameters.properties.scene.enum.includes("lightweight"), "empty lightweight scene must not be offered");
      requests++;
      return { role: "assistant", text: "轻量场景未配置，保持只读编码模型。" };
    };
    const result = await segment(job);
    assert.equal((await store.session(session.id)).scene, "coding");
    assert.equal((await store.session(session.id)).model, "p/code");
    assert.equal(requests, 1);
    assert.notEqual(result.status, "done");
  } finally { await engine.close(); await store.close(); }
});

test("employee execution refuses to start when the target scene has no model", async () => {
  const { store, engine, employee } = await fixture();
  const config = await engine.config(); config.scenes!.computer = []; await store.put("config", config);
  try {
    let threw = false;
    try {
      // requireSceneModel is used when creating the computer execution session
      const { requireSceneModel } = await import("../server/core/config");
      requireSceneModel(config, "computer");
    } catch (e: any) {
      threw = /未配置模型/.test(e.message);
      assert.match(e.message, /未配置模型/);
    }
    assert(threw);
    assert.equal(config.scenes!.lightweight?.[0], "p/light");
  } finally { await engine.close(); await store.close(); }
});

test("explicit caller work still resumes in order across coding and lightweight transitions", async () => {
  const { store, engine, add, segment } = await fixture();
  const selected: string[] = []; let requests = 0;
  engine.providers.chat = async (model, _system, messages) => {
    selected.push(model.selection);
    if (requests++ === 0) return call("code", "switch_scene", { scene: "coding", message: "完成代码工作", resume: "最后核对原作业状态A" });
    if (requests === 2) return call("light-block", "switch_scene", { scene: "lightweight", message: "先做普通协调", resume: "回到代码验证B" });
    if (requests === 3) return { role: "assistant", text: "普通协调完成。" };
    if (requests === 4) {
      assert(messages.at(-1)!.text!.includes("回到代码验证B"));
      return { role: "assistant", text: "代码验证已完成。" };
    }
    if (requests === 5) {
      assert(messages.at(-1)!.text!.includes("最后核对原作业状态A"));
      return verified();
    }
    assert(requests === 6);
    return completed();
  };
  try {
    const job = await segment(await add("编码与协调分段完成"));
    assert.equal(job.status, "done");
    assert.deepEqual(selected, ["p/light", "p/code", "p/light", "p/code", "p/light", "p/light"]);
    assert.equal((await store.sessions()).length, 1);
  } finally { await engine.close(); await store.close(); }
});

test("ordinary manual sessions and isolated computer task sessions cannot use the employee-only lightweight transition", async () => {
  const { store, engine, employee, add } = await fixture();
  try {
    for (const computer of [false, true]) {
      const task = computer ? await add("browser-only work") : undefined;
      const session = await store.newSession({ scene: computer ? "computer" : "coding", model: computer ? "p/vision" : "p/code", ...(task ? { taskId: task.id, employeeId: employee.employeeId } : {}) });
      let requests = 0;
      engine.providers.chat = async (model, _system, messages, definitions) => {
        assert.equal(model.selection, computer ? "p/vision" : "p/code");
        assert(!definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("lightweight"));
        if (requests++ === 0) return call("invalid-return", "switch_scene", { scene: "lightweight", message: "try disallowed transition" });
        assert(messages.findLast(message => message.role === "tool")!.error);
        return { role: "assistant", text: "transition rejected without side effects" };
      };
      await engine.run(session.id, { role: "user", text: "stay within this session's permissions" });
      assert.equal((await store.session(session.id)).scene, computer ? "computer" : "coding");
    }
  } finally { await engine.close(); await store.close(); }
});

test("employee communication reselects the configured lightweight model instead of keeping a stale coding selection", async () => {
  const { store, engine, employee } = await fixture();
  try {
    const chat = await employee.chat("owner");
    chat.model = "p/code"; chat.scene = "coding"; await store.saveSession(chat);
    engine.providers.chat = async (model, system, _messages, definitions) => {
      assert.equal(model.selection, "p/light");
      assert(!definitions.some(tool => tool.name === "switch_scene"));
      assert(!system.includes("日志分析优先profile=coding"));
      return { role: "assistant", text: "这是普通问答。" };
    };
    await engine.run(chat.id, { role: "user", text: "目前有哪些待处理事项？" });
    assert.equal((await store.session(chat.id)).model, "p/light");
    assert.equal((await store.session(chat.id)).scene, "lightweight");
    const ordinary = await store.newSession({ model: "p/code", scene: "coding" });
    engine.providers.chat = async model => { assert.equal(model.selection, "p/code"); return { role: "assistant", text: "用户手动选择保持不变。" }; };
    await engine.run(ordinary.id, { role: "user", text: "ordinary manual session" });
  } finally { await engine.close(); await store.close(); }
});

test("lightweight candidate failures stay within the lightweight list instead of borrowing a coding model", async () => {
  const { store, engine, add, segment } = await fixture();
  const config = await engine.config(); config.scenes!.lightweight = ["p/failed", "p/light"]; await store.put("config", config);
  const selected: string[] = []; let requests = 0;
  engine.providers.chat = async model => {
    selected.push(model.selection);
    if (model.selection === "p/failed") throw new ProviderError("invalid lightweight candidate", 400);
    assert.equal(model.selection, "p/light");
    return requests++ === 0 ? verified() : completed();
  };
  try {
    const job = await segment(await add("只读取现有配置并总结"));
    assert.equal(job.status, "done");
    assert.deepEqual(selected, ["p/failed", "p/light", "p/light"]);
    assert.equal((await store.session(job.workSession)).scene, "lightweight");
  } finally { await engine.close(); await store.close(); }
});

test("a scene covered by the current preferred model does not expose a redundant switch just because it has a different backup", async () => {
  const { store, engine, add, segment } = await fixture();
  const config = await engine.config(); config.scenes!.coding = ["p/light", "p/code"]; await store.put("config", config);
  let requests = 0;
  engine.providers.chat = async (model, _system, _messages, definitions) => {
    assert.equal(model.selection, "p/light");
    assert(!definitions.some(tool => tool.name === "switch_scene"), "Nova treats the preferred identical model as already covering coding");
    return requests++ === 0 ? verified() : completed();
  };
  try { assert.equal((await segment(await add("按已覆盖场景完成工作"))).status, "done"); }
  finally { await engine.close(); await store.close(); }
});
