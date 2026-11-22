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
import { CHROME_TOOL_DEFINITIONS } from "../server/core/public-tools";
import { phaseIndex } from '../web/src/agent-phases.js';
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
    assert.match(system, /当前可用的是服务端浏览器，就由轻量主控调用 browser_agent 打开并核实/);
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

test("CLI coding handoff needs no coding model and returns to the coordinator", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const { Tools } = await import("../server/core/tools");
  const original = Tools.prototype.runCodingCLI;
  const runs: string[] = [];
  try {
    const cfg = await engine.config();
    cfg.scenes!.coding = [];
    await engine.saveConfig({ ...cfg, codingExecutor: "antigravity" });
    Tools.prototype.runCodingCLI = async function (cli, handoff) {
      runs.push(`${cli}:${handoff}`);
      return { value: { status: "completed", executor: cli, result: "fixture CLI result", evidence: { filesChanged: [], commands: [], failedCommands: 0 } } };
    };
    let phase = 0;
    engine.providers.chat = async (model, _sys, rows, defs) => {
      assert.equal(model.selection, "p/light");
      if (!phase++) {
        assert(defs.some(d => d.name === "code_agent"));
        assert(!defs.some(d => d.name === "switch_scene"), "coordinator hides overlapping switch_scene when phase tools exist");
        return call("cli", "code_agent", { task: "edit and test" });
      }
      assert(rows.some(row => row.role === "tool" && row.text?.includes("fixture CLI result")));
      return phase === 2 ? verified() : completed();
    };
    assert.equal((await segment(await add("code phase"))).status, "done");
    assert.deepEqual(runs, ["antigravity:edit and test"]);
  } finally { Tools.prototype.runCodingCLI = original; await engine.close(); await store.close(); }
});

for (const cli of [false, true]) test(`coding returns to lightweight before browser verification (${cli ? "CLI" : "model"})`, async () => {
  const { store, engine, add, segment } = await fixture();
  const { Tools } = await import("../server/core/tools");
  const original = Tools.prototype.runCodingCLI;
  const requests: string[] = [];
  try {
    if (cli) {
      await engine.saveConfig({ ...await engine.config(), codingExecutor: "codex" });
      Tools.prototype.runCodingCLI = async () => ({ value: { result: "edit tested\nVEGA_READY_FOR_BROWSER" } });
    }
    engine.providers.chat = async (model, _sys, rows, defs) => {
      requests.push(model.selection);
      if (requests.length === 1) {
        assert(!Object.hasOwn(defs.find(d => d.name === "code_agent")!.parameters.properties, "browserTask"));
        return call("old", "code_agent", { task: "fix hover", browserTask: "verify hover" });
      }
      if (requests.length === 2) {
        assert.equal(model.selection, "p/light");
        assert(rows.some(r => r.callId === "old" && r.error));
        return call("code", "code_agent", { task: "fix hover" });
      }
      if (model.selection === "p/code") {
        assert(!defs.some(d => ["browser_agent", "switch_scene"].includes(d.name)));
        return { role: "assistant", text: "edit tested" };
      }
      if (model.selection === "p/light" && requests.length === (cli ? 3 : 4)) {
        assert(rows.some(r => r.text?.includes("edit tested")));
        return call("browser", "browser_agent", { task: "verify hover on updated build" });
      }
      if (model.selection === "p/vision") {
        assert(rows.some(r => r.text?.includes("verify hover")));
        return { role: "assistant", text: "hover verification result" };
      }
      return requests.at(-2) === "p/vision" ? verified() : completed();
    };
    assert.equal((await segment(await add("fix and verify"))).status, "done");
    assert.deepEqual(requests, ["p/light", "p/light", ...cli ? [] : ["p/code"], "p/light", "p/vision", "p/light", "p/light"]);
  } finally { Tools.prototype.runCodingCLI = original; await engine.close(); await store.close(); }
});

for (const cli of [false, true]) test(`lightweight coordinates browser findings, authorized fixes and rechecks (${cli ? 'CLI' : 'model'})`, async () => {
  const { store, engine, add, segment } = await fixture();
  const { Tools } = await import('../server/core/tools');
  const original = Tools.prototype.runCodingCLI;
  const route: string[] = [];
  try {
    if (cli) {
      await engine.saveConfig({ ...await engine.config(), codingExecutor: 'antigravity' });
      Tools.prototype.runCodingCLI = async () => { route.push('cli'); return { value: { result: 'fixed\nVEGA_READY_FOR_BROWSER' } }; };
    }
    engine.providers.chat = async (model, _sys, rows, defs) => {
      route.push(model.selection);
      if (route.length === 1) return call('inspect', 'browser_agent', { task: 'verify hover and repair if missing' });
      if (route.length === 2) {
        assert(!defs.some(d => d.name === 'code_agent'));
        return call('forbidden', 'code_agent', { task: 'fix missing hover' });
      }
      if (route.length === 3) {
        assert(rows.some(r => r.callId === 'forbidden' && r.error));
        return { role: 'assistant', text: 'missing hover confirmed' };
      }
      if (route.length === 4) return call('fix', 'code_agent', { task: 'fix missing hover' });
      if (model.selection === 'p/code') return { role: 'assistant', text: 'fixed' };
      if (route.length === 6) return call('recheck', 'browser_agent', { task: 'recheck hover' });
      if (model.selection === 'p/vision') {
        assert(rows.some(r => r.role === 'tool' && !r.error && r.text?.includes('recheck hover')));
        return { role: 'assistant', text: 'hover verified' };
      }
      return route.at(-2) === 'p/vision' ? verified() : completed();
    };
    assert.equal((await segment(await add('verify and repair hover'))).status, 'done');
    assert.deepEqual(route, ['p/light', 'p/vision', 'p/vision', 'p/light', cli ? 'cli' : 'p/code', 'p/light', 'p/vision', 'p/light', 'p/light']);
  } finally { Tools.prototype.runCodingCLI = original; await engine.close(); await store.close(); }
});

test("isolated browser and code phases return structured evidence without polluting coordinator history or leaking bash/task tools", async () => {
  const { store, engine, add, segment } = await fixture();
  (engine as any).chromeFor = async () => ({
    execute: async () => ({
      tabTag: "C1-1",
      tabs: [{ tag: "C1-1", url: "https://cursor.com/pricing", title: "Pricing", active: true }],
      images: [{ url: "/api/files/employees/e/t/shot.webp", path: "/data/shot.webp" }],
      documentPath: "/data/doc.json",
    }),
  });
  let phase = 0;
  try {
    engine.providers.chat = async (model, system, rows, defs) => {
      const names = defs.map(d => d.name);
      switch (++phase) {
        case 1:
          assert.equal(model.selection, "p/light");
          assert(!names.includes("switch_scene"), "coordinator exposes code_agent/browser_agent instead of switch_scene");
          return call("browser", "browser_agent", { task: "inspect existing evidence" });
        case 2:
          assert.equal(model.selection, "p/vision");
          assert(!names.some(n => ["bash", "bash_poll", "write", "edit", "code_agent", "browser_agent", "switch_scene", "task_progress", "task_complete", "spawn_agent", "employee_task_create"].includes(n)), "browser_agent strictly drops bash and task lifecycle tools");
          assert(names.includes("chrome_navigate") && names.includes("read") && names.includes("vault_get"));
          assert(!system.includes("首次执行先用task_progress"), "specialist does not inherit coordinator boilerplate");
          return call("nav", "chrome_navigate", { url: "https://cursor.com/pricing", target: { kind: "new_tab" } });
        case 3:
          assert.equal(model.selection, "p/vision");
          return { role: "assistant", text: "browser finding" };
        case 4: {
          assert.equal(model.selection, "p/light");
          const receiptRow = rows.findLast(r => r.role === "tool" && r.name === "browser_agent")!;
          const receipt = JSON.parse(receiptRow.text!);
          assert.equal(receipt.status, "completed");
          assert.equal(receipt.executor, "model/p/vision");
          assert.equal(receipt.result, "browser finding");
          assert.equal(receipt.evidence.visitedUrls[0].url, "https://cursor.com/pricing");
          assert.equal(receipt.evidence.screenshots[0].url, "/api/files/employees/e/t/shot.webp");
          assert.equal(receipt.evidence.tabs[0].tabTag, "C1-1");
          assert(receipt.phaseSession);
          assert(!rows.some(r => r.name === "chrome_navigate"), "coordinator history is never polluted with inner specialist tool calls");
          return call("code", "code_agent", { task: "check the browser finding" });
        }
        case 5:
          assert.equal(model.selection, "p/code");
          assert(!names.some(n => ["chrome_navigate", "code_agent", "browser_agent", "switch_scene", "task_progress", "task_complete", "spawn_agent", "employee_task_create"].includes(n)));
          assert(names.includes("read") && names.includes("edit") && names.includes("bash"));
          return { role: "assistant", text: "coding finding" };
        case 6: {
          assert.equal(model.selection, "p/light");
          const receipt = JSON.parse(rows.findLast(r => r.role === "tool" && r.name === "code_agent")!.text!);
          assert.equal(receipt.status, "completed");
          assert.equal(receipt.result, "coding finding");
          assert(receipt.phaseSession);
          return verified();
        }
        default: return completed();
      }
    };
    const result = await segment(await add("inspect then verify"));
    assert.equal(result.status, "done");
    const rows = await store.messages(result.workSession);
    const phases = phaseIndex(rows);
    assert.deepEqual(phases.map(p => [p.name, p.status]), [["browser_agent", "returned"], ["code_agent", "returned"]]);
    for (const p of phases) {
      assert.equal(p.messageSeqs.length, 2, "isolated phase keeps only delegation + structured receipt in coordinator transcript");
      assert(p.phaseSession);
      const childRows = await store.messages(p.phaseSession);
      assert(childRows.some(r => r.role === "assistant" && r.text?.endsWith("finding")));
    }
    assert.equal(phase, 7);
  } finally { await engine.close(); await store.close(); }
});

test("browser_agent fail-fast reports blocked status and error evidence when site is unreachable", async () => {
  const { store, engine, add, segment } = await fixture();
  (engine as any).chromeFor = async () => ({
    execute: async () => ({
      tabTag: "C1-err",
      tabs: [{ tag: "C1-err", url: "https://cursor.com/pricing", title: "cursor.com", active: true }],
      pages: [{ headings: [{ level: "H1", text: "This site can’t be reached" }], stamp: '["chrome-error://chromewebdata/"]' }],
    }),
  });
  let step = 0;
  try {
    engine.providers.chat = async (model, _sys, rows) => {
      step++;
      if (step === 1) return call("b", "browser_agent", { task: "打开 cursor.com/pricing" });
      if (step === 2) return call("n", "chrome_navigate", { url: "https://cursor.com/pricing", target: { kind: "new_tab" } });
      if (step === 3) return { role: "assistant", text: "[BLOCKED] Chrome 代理故障无法打开 cursor.com/pricing" };
      if (step === 4) {
        assert.equal(model.selection, "p/light");
        const receipt = JSON.parse(rows.findLast(r => r.role === "tool" && r.name === "browser_agent")!.text!);
        assert.equal(receipt.status, "blocked");
        assert(receipt.evidence.errors.some((e: string) => /This site can/.test(e)));
        assert.match(receipt.next, /受阻交回/);
        return verified();
      }
      return completed();
    };
    const result = await segment(await add("核查官网定价"));
    assert.equal(result.status, "done");
    const [phase] = phaseIndex(await store.messages(result.workSession));
    assert.equal(phase.status, "blocked");
  } finally { await engine.close(); await store.close(); }
});

test('a specialist cannot take over coordinator work when its return model disappears', async () => {
  const { store, engine, add, segment } = await fixture();
  try {
    let requests = 0;
    engine.providers.chat = async model => {
      if (++requests === 1) return call('inspect', 'browser_agent', { task: 'inspect only' });
      assert.equal(requests, 2);
      assert.equal(model.selection, 'p/vision');
      const cfg = await engine.config(); cfg.scenes!.lightweight = []; await store.put('config', cfg);
      return { role: 'assistant', text: 'saved browser finding' };
    };
    const result = await segment(await add('inspect then coordinate'));
    assert.equal(requests, 2);
    assert.match(result.result, /无法返回轻量主控/);
    assert.equal((await store.session(result.workSession)).scene, 'lightweight');
    assert((await store.messages(result.workSession)).some(r => r.agentPhase?.name === 'browser_agent' && r.text?.includes('saved browser finding')));
  } finally { await engine.close(); await store.close(); }
});

test("even a coding-profile task starts lightweight and routes coding and browser phases through the coordinator", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const selected: string[] = [];
  let phase = 0;
  engine.providers.chat = async (model, system, messages, definitions) => {
    selected.push(model.selection);
    if (phase++ === 0) {
      assert(system.includes("新主任务统一先用轻量模型") && system.includes("普通信息查询不因使用read或bash而升级"));
      assert(system.includes(EMPLOYEE_DECISION_RULES), "decision guidance survives initial work, phase calls and resumption");
      assert(messages.some(message => message.role === "user" && message.text?.includes("仅缺少无法自行查得的必要信息或确需用户处理的阻碍才task_ask_user")));
      assert.match(JSON.stringify(messages), /task_ask_user 仅用于缺少无法自行查得的必要信息/, "task rules are attached to the request as dynamic context, not the frozen system prefix");
      assert.equal(model.selection, "p/light");
      assert(definitions.some(tool => tool.name === "code_agent") && !definitions.some(tool => tool.name === "switch_scene"));
      return call("code", "code_agent", { task: "实现功能并验证" });
    }
    if (phase === 2) {
      assert.equal(model.selection, "p/code");
      assert(!definitions.some(tool => ["browser_agent", "switch_scene", "task_complete"].includes(tool.name)));
      return { role: "assistant", text: "编码完成，单测通过" };
    }
    if (phase === 3) {
      assert.equal(model.selection, "p/light");
      assert(messages.some(m => m.role === "tool" && m.name === "code_agent" && m.text?.includes("编码完成，单测通过")));
      return call("inspect", "browser_agent", { task: "只在浏览器验证已实现的功能" });
    }
    if (phase === 4) {
      assert.equal(model.selection, "p/vision");
      assert(!definitions.some(tool => ["bash", "write", "edit", "switch_scene", "task_complete"].includes(tool.name)));
      assert(definitions.some(tool => tool.name === "chrome_navigate"));
      return { role: "assistant", text: "浏览器已验证" };
    }
    assert.equal(model.selection, "p/light");
    return phase === 5 ? verified() : completed();
  };
  try {
    let job = await add("实现功能并在浏览器验证", "coding");
    job = await segment(job);
    const work = job.workSession;
    assert.equal((await store.session(work)).scene, "lightweight");
    assert.notEqual(job.side, "computer", "isolated browser phase does not flip task.side to computer");
    assert.equal(job.status, "done");
    assert.equal(job.workSession, work);
    assert.equal((await store.sessions()).filter(s => !s.phaseRole).length, 1, "one coordinator session");
    assert.deepEqual(selected, ["p/light", "p/code", "p/light", "p/vision", "p/light", "p/light"]);
    assert.deepEqual((await employee.state()).runs.map(run => run.scene), ["lightweight"], "one continuous work session run");

    let requests = 0;
    engine.providers.chat = async model => {
      assert.equal(model.selection, "p/light", "a new unrelated task never inherits the previous task's coding model");
      return requests++ === 0 ? verified() : completed();
    };
    assert.equal((await segment(await add("查询任务状态和实际请求地址"))).status, "done");
  } finally { await engine.close(); await store.close(); }
});

test("an employee task can delegate coding, wait on external job, and delegate coding again in the same coordinator session", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const selected: string[] = []; let phase = 0;
  engine.providers.chat = async (model, system) => {
    selected.push(model.selection);
    if (phase++ === 0) {
      assert(system.includes("不是任务级永久锁定"));
      return call("code", "code_agent", { task: "先实现并验证编码部分" });
    }
    if (phase === 2) return { role: "assistant", text: "编码已完成，原作业 job-123 已提交" };
    if (phase === 3) {
      assert.equal(model.selection, "p/light");
      return call("pause", "employee", { action: "defer", text: "代码已验证，原作业job-123已提交，只检查原作业", nextCheckInMinutes: 1 });
    }
    if (phase === 4) {
      assert.equal(model.selection, "p/light");
      return call("wait", "employee", { action: "defer", text: "原作业已查询，仍在运行，下次只查该作业", nextCheckInMinutes: 1 });
    }
    if (phase === 5) {
      assert.equal(model.selection, "p/light");
      return call("code-again", "code_agent", { task: "按最新授权再修改一处代码并验证，不重放原提交" });
    }
    if (phase === 6) {
      assert.equal(model.selection, "p/code");
      return { role: "assistant", text: "已修改并通过单测" };
    }
    assert.equal(model.selection, "p/light");
    return phase === 7 ? verified() : completed();
  };
  try {
    let job = await segment(await add("实现代码后查询外部作业并反馈"));
    const session = job.workSession;
    assert.equal((await store.session(session)).scene, "lightweight");
    await employee.control({ action: "resume", id: job.id, text: "代码已完成，接下来只查询原作业状态" });
    job = await segment(job);
    assert.equal((await store.session(session)).scene, "lightweight");
    await employee.control({ action: "resume", id: job.id, text: "现在再修改一处代码并验证" });
    job = await segment(job);
    assert.equal(job.status, "done");
    assert.equal(job.workSession, session);
    assert.equal((await store.sessions()).filter(s => !s.phaseRole).length, 1);
    assert.deepEqual(selected, ["p/light", "p/code", "p/light", "p/light", "p/light", "p/code", "p/light", "p/light"]);
    assert.deepEqual((await employee.state()).runs.map(run => run.scene), ["lightweight", "lightweight", "lightweight"]);
  } finally { await engine.close(); await store.close(); }
});

test("legacy sceneStack: explicitly returning to a retained lightweight caller preserves its pending work without a second automatic return", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  let requests = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    if (requests++ === 0) {
      assert.equal(model.selection, "p/code");
      assert(definitions.find(tool => tool.name === "switch_scene")?.parameters.properties.scene.enum.includes("lightweight"));
      return call("return", "switch_scene", { scene: "lightweight", message: "编码已完成，转为普通查询与协调" });
    }
    assert.equal(model.selection, "p/light");
    const outcome = messages.findLast(message => message.role === "tool" && message.name === "switch_scene")!;
    assert(outcome.text!.includes("job-retained") && outcome.text!.includes("不是新授权"));
    assert(requests <= 3, "explicit return cannot also replay the old automatic continuation");
    return requests === 2 ? verified() : completed();
  };
  try {
    const added = await add("编码并检查既有作业");
    const legacy = await store.newSession({ cwd: process.cwd(), employeeId: employee.employeeId, taskId: added.id, ownerId: "owner", scene: "coding", model: "p/code", sceneStack: [{ scene: "lightweight", model: "p/light", resume: "只查询原作业job-retained并协调反馈" }] });
    await employee.update(state => { employee.task(state, added.id).workSession = legacy.id; });
    const job = await segment(employee.task(await employee.state(), added.id));
    assert.equal(job.status, "done");
    assert.equal((await store.session(job.workSession)).scene, "lightweight");
    assert.equal((await store.sessions()).length, 1);
    assert.equal(requests, 3);
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

test("legacy sceneStack: explicit caller work still resumes in order across coding and lightweight transitions", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const selected: string[] = []; let requests = 0;
  engine.providers.chat = async (model, _system, messages) => {
    selected.push(model.selection);
    if (requests++ === 0) return call("light-block", "switch_scene", { scene: "lightweight", message: "先做普通协调", resume: "回到代码验证B" });
    if (requests === 2) return { role: "assistant", text: "普通协调完成。" };
    if (requests === 3) {
      assert(messages.findLast(m => m.role === "user" && m.runtime !== "dynamic")!.text!.includes("回到代码验证B"));
      return { role: "assistant", text: "代码验证已完成。" };
    }
    if (requests === 4) {
      assert(messages.findLast(m => m.role === "user" && m.runtime !== "dynamic")!.text!.includes("最后核对原作业状态A"));
      return verified();
    }
    assert(requests === 5);
    return completed();
  };
  try {
    const added = await add("编码与协调分段完成");
    const legacy = await store.newSession({ cwd: process.cwd(), employeeId: employee.employeeId, taskId: added.id, ownerId: "owner", scene: "coding", model: "p/code", sceneStack: [{ scene: "lightweight", model: "p/light", resume: "最后核对原作业状态A" }] });
    await employee.update(state => { employee.task(state, added.id).workSession = legacy.id; });
    const job = await segment(employee.task(await employee.state(), added.id));
    assert.equal(job.status, "done");
    assert.deepEqual(selected, ["p/code", "p/light", "p/code", "p/light", "p/light"]);
    assert.equal((await store.sessions()).length, 1);
  } finally { await engine.close(); await store.close(); }
});

test("mid-phase user steer interrupts an active browser_agent cleanly and hands control back to coordinator", async () => {
  const { store, engine, add, segment } = await fixture();
  let releaseSpecialist!: () => void;
  const specialistEntered = new Promise<void>((resolve) => { releaseSpecialist = resolve; });
  let phase = 0, jobId = "", workSession = "";
  engine.providers.chat = async (model, _system, messages, _definitions, signal) => {
    if (phase++ === 0) {
      assert.equal(model.selection, "p/light");
      return call("phase-browser", "browser_agent", { task: "慢速巡检页面" });
    }
    if (model.selection === "p/vision") {
      releaseSpecialist();
      await new Promise<void>((_res, rej) => {
        if (signal.aborted) rej(signal.reason || new Error("aborted"));
        else signal.addEventListener("abort", () => rej(signal.reason || new Error("aborted")), { once: true });
      });
      return { role: "assistant", text: "unreachable" };
    }
    if (phase === 3) {
      const receipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.name === "browser_agent")!.text!);
      assert.equal(receipt.status, "interrupted_by_steer");
      assert(messages.some(m => m.role === "user" && m.text?.includes("改查另一个页面")));
      return verified();
    }
    return completed();
  };
  try {
    const added = await add("页面巡检");
    jobId = added.id;
    const running = segment(added);
    await specialistEntered;
    workSession = (await store.sessions()).find(s => s.taskId === jobId && !s.phaseRole)!.id;
    engine.steer(workSession, { role: "user", text: "不用查这个了，改查另一个页面" });
    const job = await running;
    assert.equal(job.status, "done");
  } finally { await engine.close(); await store.close(); }
});

test("ordinary manual sessions and isolated computer task sessions cannot use the employee-only lightweight transition", async () => {
  const { store, engine, employee, add } = await fixture();
  try {
    for (const computer of [false, true]) {
      const task = computer ? await add("browser-only work") : undefined;
      const session = await store.newSession({ scene: computer ? "computer" : "coding", model: computer ? "p/vision" : "p/code", ...(task ? { taskId: task.id, employeeId: employee.employeeId, relayComputer: true } : {}) });
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

const chromeNames = (definitions: { name: string }[]) => definitions.filter(tool => tool.name.startsWith("chrome_")).map(tool => tool.name);

test("a scene covered by the current preferred model stays reachable: code_agent is offered and executes an isolated coding phase", async () => {
  const { store, engine, add, segment } = await fixture();
  const config = await engine.config(); config.scenes!.coding = ["p/light", "p/code"]; await store.put("config", config);
  let phase = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    assert.equal(model.selection, "p/light");
    const names = definitions.map(tool => tool.name);
    if (phase++ === 0) {
      assert(names.includes("code_agent"), "preferred identical model must not hide code_agent");
      assert(!names.includes("switch_scene"), "lightweight coordinator hides legacy switch_scene");
      return call("code", "code_agent", { task: "需要改文件" });
    }
    if (phase === 2) {
      assert(names.includes("write") && names.includes("edit") && names.includes("bash"), "isolated code_agent receives coding tools");
      assert(!names.includes("task_complete") && !names.includes("switch_scene"));
      return { role: "assistant", text: "文件修改已完成。" };
    }
    if (phase === 3) {
      const outcome = messages.findLast(message => message.role === "tool" && message.name === "code_agent")!;
      assert(!outcome.error, outcome.text);
      const receipt = JSON.parse(outcome.text!);
      assert.equal(receipt.status, "completed");
      assert(receipt.phaseSession);
      return verified();
    }
    return completed();
  };
  try {
    const job = await segment(await add("按已覆盖场景完成工作"));
    assert.equal(job.status, "done");
    assert.equal((await store.session(job.workSession)).scene, "lightweight");
    assert.equal((await store.session(job.workSession)).model, "p/light");
    assert.equal((await store.sessions()).filter(s => s.phaseRole === "code_agent").length, 1);
  } finally { await engine.close(); await store.close(); }
});

test("attached log scenario: lightweight task whose model is shared with computer delegates to isolated browser_agent with chrome tools and no bash", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  // One image-capable model serves lightweight and computer, as in the reported deployment.
  const config = await engine.config(); config.scenes!.lightweight = ["p/vision"]; config.scenes!.computer = ["p/vision"]; await store.put("config", config);
  let driver = 0;
  (engine as any).chromeFor = async () => { driver++; return { execute: async () => ({ connected: true }) }; };
  const selected: string[] = []; let phase = 0, work = "";
  engine.providers.chat = async (model, system, messages, definitions) => {
    selected.push(model.selection);
    assert.equal(model.selection, "p/vision");
    const names = definitions.map(tool => tool.name);
    assert(!names.includes("task_relay_computer"), "relay is never exposed");
    if (phase++ === 0) {
      assert.deepEqual(chromeNames(definitions), []);
      assert(JSON.stringify(messages).includes("[Chrome 场景]") && !JSON.stringify(messages).includes("[Chrome 规则]") && !system.includes("[Chrome 规则]") && !system.includes("[Chrome 场景]"), "only the short gate rule outside browser_agent, in the dynamic segment");
      assert(names.includes("browser_agent"), "shared model must not hide browser_agent");
      assert(!names.includes("switch_scene"));
      assert(names.includes("task_progress") && names.includes("task_complete"));
      return { role: "assistant", calls: [
        { id: "early-nav", name: "chrome_navigate", arguments: { url: "https://www.baidu.com/" } },
        { id: "early-status", name: "chrome_connection", arguments: { command: "status" } },
      ] };
    }
    if (phase === 2) {
      for (const id of ["early-nav", "early-status"]) {
        const rejected = messages.find(message => message.role === "tool" && message.callId === id)!;
        assert(rejected.error && /当前会话未授权工具：chrome_/.test(rejected.text!), "out-of-scene batch call is rejected with guidance");
      }
      assert.equal(driver, 0, "rejected calls never reach the browser driver");
      work = (await store.sessions()).find(s => !s.phaseRole)!.id;
      return call("browser", "browser_agent", { task: "在服务端浏览器打开百度并核实" });
    }
    if (phase === 3) {
      // Inside isolated browser_agent child session
      assert.deepEqual(chromeNames(definitions), CHROME_TOOL_DEFINITIONS.map(tool => tool.name));
      assert(JSON.stringify(messages).includes("[Chrome 规则]") && !JSON.stringify(messages).includes("[Chrome 场景]") && !system.includes("[Chrome 规则]") && !system.includes("[Chrome 场景]"), "full Chrome rules only in browser_agent dynamic segment");
      assert(!names.includes("bash") && !names.includes("write") && !names.includes("edit") && !names.includes("task_complete") && !names.includes("task_progress") && !names.includes("switch_scene"), "browser_agent has strict tool isolation");
      assert(!system.includes("[电脑场景未配置]"));
      return call("status", "chrome_connection", { command: "status" });
    }
    if (phase === 4) {
      const status = messages.findLast(message => message.role === "tool" && message.callId === "status")!;
      assert(!status.error, status.text);
      assert.equal(driver, 1, "browser_agent reaches the browser driver");
      return { role: "assistant", text: "百度首页已打开并核实。" };
    }
    if (phase === 5) {
      // Back in coordinator
      const outcome = messages.findLast(message => message.role === "tool" && message.name === "browser_agent")!;
      assert(!outcome.error, outcome.text);
      const receipt = JSON.parse(outcome.text!);
      assert.equal(receipt.status, "completed");
      assert(receipt.evidence && Array.isArray(receipt.evidence.visitedUrls));
      assert(messages.some(message => message.role === "user" && message.text?.includes("在服务端浏览器打开百度首页")), "task text stays in coordinator history");
      assert(!messages.some(message => message.role === "tool" && message.callId === "status"), "browser tool noise stays isolated inside child phase session");
      return verified();
    }
    return completed();
  };
  try {
    const job = await segment(await add("在服务端浏览器打开百度首页"));
    assert.equal(job.status, "done");
    assert.equal(job.workSession, work, "task keeps its original work session");
    const sessions = await store.sessions();
    assert.equal(sessions.filter(s => !s.phaseRole).length, 1, "one coordinator session");
    assert.equal(sessions.filter(s => s.phaseRole === "browser_agent").length, 1, "one isolated browser_agent session");
    const session = await store.session(job.workSession);
    assert.equal(session.scene, "lightweight");
    assert.equal(session.model, "p/vision");
    assert.equal(session.sceneStack, undefined);
    assert.equal(session.taskId, job.id);
    assert.notEqual(job.side, "computer", "task is not flipped to the isolated computer side");
    assert.equal(session.relayComputer, undefined);
    assert.deepEqual(selected, ["p/vision", "p/vision", "p/vision", "p/vision", "p/vision", "p/vision"]);
    assert.equal((await employee.state()).runs.length, 1, "one continuous run");
  } finally { await engine.close(); await store.close(); }
});

test("lightweight and computer on different models: browser_agent uses vision model in isolated session without polluting coordinator", async () => {
  const { store, engine, add, segment } = await fixture();
  let phase = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    if (phase++ === 0) {
      assert.equal(model.selection, "p/light");
      assert.deepEqual(chromeNames(definitions), []);
      assert(definitions.some(tool => tool.name === "browser_agent"));
      return call("browser", "browser_agent", { task: "打开网页核实" });
    }
    if (phase === 2) {
      assert.equal(model.selection, "p/vision");
      assert(chromeNames(definitions).includes("chrome_navigate"));
      assert(!definitions.some(tool => tool.name === "bash" || tool.name === "task_complete"));
      return { role: "assistant", text: "网页核实通过。" };
    }
    assert.equal(model.selection, "p/light");
    assert(definitions.some(tool => tool.name === "task_complete"));
    const receipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.name === "browser_agent")!.text!);
    assert.equal(receipt.status, "completed");
    return phase === 3 ? verified() : completed();
  };
  try {
    const job = await segment(await add("打开网页核实"));
    assert.equal(job.status, "done");
    assert.equal((await store.sessions()).filter(s => !s.phaseRole).length, 1);
    assert.equal((await store.sessions()).filter(s => s.phaseRole === "browser_agent").length, 1);
    assert.equal((await store.session(job.workSession)).scene, "lightweight");
    assert.equal((await store.session(job.workSession)).model, "p/light");
  } finally { await engine.close(); await store.close(); }
});

test("computer scene without a model: not offered, accurate setup diagnosis instead of an extension-reconnect request, direct call fails clearly", async () => {
  const { store, engine, add, segment } = await fixture();
  const config = await engine.config(); config.scenes!.computer = []; await store.put("config", config);
  let phase = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    assert.equal(model.selection, "p/light");
    assert(!definitions.some(tool => tool.name === "browser_agent"));
    assert(!definitions.some(tool => tool.name === "switch_scene"));
    assert.deepEqual(chromeNames(definitions), []);
    assert.match(JSON.stringify(messages), /\[电脑场景未配置\].*computer 场景未配置模型.*不是浏览器扩展连接问题/s, "unconfigured-computer diagnosis is in the dynamic segment");
    if (phase++ === 0) return call("browser", "browser_agent", { task: "强行调用" });
    const outcome = messages.findLast(message => message.role === "tool" && message.name === "browser_agent")!;
    assert(outcome.error);
    assert.match(outcome.text!, /场景「computer」未配置模型/);
    assert.doesNotMatch(outcome.text!, /请重连|重新连接扩展/);
    return phase === 2 ? verified() : completed();
  };
  try {
    const job = await segment(await add("打开网页核实"));
    assert.equal((await store.session(job.workSession)).scene, "lightweight", "failed call changes nothing");
    assert.equal((await store.sessions()).length, 1);
  } finally { await engine.close(); await store.close(); }
});

test("one model for every scene: lightweight coordinator delegates code_agent then browser_agent with matching isolated tool sets", async () => {
  const { store, engine, add, segment } = await fixture();
  const config = await engine.config(); config.scenes = { lightweight: ["p/vision"], coding: ["p/vision"], computer: ["p/vision"] }; await store.put("config", config);
  let phase = 0;
  engine.providers.chat = async (model, _system, _messages, definitions) => {
    assert.equal(model.selection, "p/vision");
    const names = definitions.map(tool => tool.name);
    if (phase++ === 0) {
      assert(names.includes("code_agent") && names.includes("browser_agent"));
      assert(!names.includes("switch_scene") && chromeNames(definitions).length === 0);
      return call("code", "code_agent", { task: "改代码" });
    }
    if (phase === 2) {
      assert(names.includes("write") && names.includes("bash") && chromeNames(definitions).length === 0 && !names.includes("task_complete"));
      return { role: "assistant", text: "代码修改完成。" };
    }
    if (phase === 3) {
      assert(names.includes("browser_agent") && chromeNames(definitions).length === 0);
      return call("browser", "browser_agent", { task: "浏览器验证" });
    }
    if (phase === 4) {
      assert(!names.includes("write") && !names.includes("bash") && chromeNames(definitions).length > 0 && !names.includes("task_complete"));
      return { role: "assistant", text: "浏览器验收通过。" };
    }
    if (phase === 5) return verified();
    return completed();
  };
  try {
    const job = await segment(await add("改代码并在浏览器验证", "coding"));
    assert.equal(job.status, "done");
    const sessions = await store.sessions();
    assert.equal(sessions.filter(s => !s.phaseRole).length, 1);
    assert.equal(sessions.filter(s => s.phaseRole === "code_agent").length, 1);
    assert.equal(sessions.filter(s => s.phaseRole === "browser_agent").length, 1);
    assert.equal((await store.session(job.workSession)).scene, "lightweight", "coordinator stays lightweight throughout");
  } finally { await engine.close(); await store.close(); }
});
