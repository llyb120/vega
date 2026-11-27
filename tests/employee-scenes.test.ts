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
          assert(names.includes("browser_tabs") && names.includes("read") && names.includes("vault_get"));
          assert(!system.includes("首次执行先用task_progress"), "specialist does not inherit coordinator boilerplate");
          return call("nav", "browser_tabs", { action: "open", url: "https://cursor.com/pricing" });
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
          assert(!rows.some(r => r.name === "browser_tabs" || r.name === "chrome_navigate"), "coordinator history is never polluted with inner specialist tool calls");
          return call("code", "code_agent", { task: "check the browser finding" });
        }
        case 5:
          assert.equal(model.selection, "p/code");
          assert(!names.some(n => ["browser_tabs", "chrome_navigate", "code_agent", "browser_agent", "switch_scene", "task_progress", "task_complete", "spawn_agent", "employee_task_create"].includes(n)));
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
      if (step === 2) return call("n", "browser_tabs", { action: "open", url: "https://cursor.com/pricing" });
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
      assert(definitions.some(tool => tool.name === "browser_tabs"));
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

const chromeNames = (definitions: { name: string }[]) => definitions.filter(tool => tool.name.startsWith("browser_") && tool.name !== "browser_agent").map(tool => tool.name);

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
        { id: "early-nav", name: "browser_tabs", arguments: { action: "open", url: "https://www.baidu.com/" } },
        { id: "early-status", name: "browser_debug", arguments: { kind: "downloads" } },
      ] };
    }
    if (phase === 2) {
      for (const id of ["early-nav", "early-status"]) {
        const rejected = messages.find(message => message.role === "tool" && message.callId === id)!;
        assert(rejected.error && /当前会话未授权工具：browser_/.test(rejected.text!), "out-of-scene batch call is rejected with guidance");
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
      return call("status", "browser_debug", { kind: "downloads" });
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
      assert(chromeNames(definitions).includes("browser_tabs"));
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

test("Fork-Join phase barrier: mixed coordinator + concurrent code_agent/browser_agent run together while standalone tools still cannot mix with phases", async () => {
  const { store, engine, add, segment } = await fixture();
  const config = await engine.config();
  config.scheduler = { globalSlots: 4, perEmployeeSlots: 4 };
  await store.put("config", config);
  let activeSpecialists = 0, peakSpecialists = 0;
  let releaseBoth!: () => void;
  let arrived = 0;
  const barrier = new Promise<void>((resolve) => { releaseBoth = resolve; });
  let coordTurn = 0;
  engine.providers.chat = async (model, _system, messages) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) {
        // Standalone tools like task_complete still cannot mix with phase tools
        return { role: "assistant", calls: [
          { id: "bad-code", name: "code_agent", arguments: { task: "分析代码" } },
          { id: "bad-done", name: "task_complete", arguments: { evidence: "premature", summary: "premature" } },
        ] };
      }
      if (coordTurn === 2) {
        const err = messages.findLast(m => m.role === "tool" && m.callId === "bad-code")!;
        assert(err.error && /task_complete must be called alone/.test(err.text!));
        // Mixed batch: task_progress + context_budget + concurrent code_agent + browser_agent together in ONE turn!
        return { role: "assistant", calls: [
          { id: "mix-plan", name: "task_progress", arguments: { message: "登记计划并并发执行", plan: [{ content: "检查配置与定价页", status: "in_progress" }] } },
          { id: "par-code", name: "code_agent", arguments: { task: "检查服务端配置" } },
          { id: "par-browser", name: "browser_agent", arguments: { task: "抓取定价页面" } },
          { id: "mix-budget", name: "context_budget", arguments: {} },
        ] };
      }
      if (coordTurn === 3) {
        // Coordinator only resumes after ALL coordinator tools and BOTH specialists finished, in original call order
        const planReceipt = messages.findLast(m => m.role === "tool" && m.callId === "mix-plan")!;
        const codeReceipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "par-code")!.text!);
        const browserReceipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "par-browser")!.text!);
        const budgetReceipt = messages.findLast(m => m.role === "tool" && m.callId === "mix-budget")!;
        assert(!planReceipt.error && !budgetReceipt.error);
        assert.equal(codeReceipt.status, "completed");
        assert.equal(browserReceipt.status, "completed");
        assert.match(codeReceipt.result, /服务端配置已核对/);
        assert.match(browserReceipt.result, /定价页面已核对/);
        // Close out in ONE turn: task_progress(completed) + task_complete together!
        return { role: "assistant", calls: [
          { id: "close-plan", name: "task_progress", arguments: { message: "全部核对完成", plan: [{ content: "检查配置与定价页", status: "completed" }] } },
          { id: "close-done", name: "task_complete", arguments: { deliverableRefs: [], evidence: "服务端配置与定价页均已核对。", summary: "核对完成。" } },
        ] };
      }
      throw Error("unexpected extra coordinator turn " + coordTurn);
    }
    activeSpecialists++;
    peakSpecialists = Math.max(peakSpecialists, activeSpecialists);
    if (++arrived === 2) releaseBoth();
    await barrier;
    activeSpecialists--;
    return { role: "assistant", text: model.selection === "p/code" ? "服务端配置已核对。" : "定价页面已核对。" };
  };
  try {
    const job = await segment(await add("并发检查代码与网页"));
    assert.equal(job.status, "done");
    assert.equal(peakSpecialists, 2, "code_agent and browser_agent must execute concurrently");
    assert.equal(coordTurn, 3, "mixed launch + single-turn closeout completes in 3 coordinator turns");
    const sessions = await store.sessions();
    assert.equal(sessions.filter(s => s.phaseRole === "code_agent").length, 1);
    assert.equal(sessions.filter(s => s.phaseRole === "browser_agent").length, 1);
    const phases = phaseIndex(await store.messages(job.workSession));
    assert.deepEqual(
      phases.map(p => [p.name, p.status]),
      [["code_agent", "error"], ["code_agent", "returned"], ["browser_agent", "returned"]],
      "rejected and mixed-batch phases both index cleanly in UI timeline",
    );
  } finally { await engine.close(); await store.close(); }
});

test("browser_agent host circuit breaker halts after 2 consecutive ERR_SOCKS errors and forces a clean wrap-up turn", async () => {
  const { store, engine, add, segment } = await fixture();
  let navCalls = 0;
  (engine as any).chromeFor = async () => ({
    execute: async () => {
      navCalls++;
      return {
        tabTag: "C3-net",
        tabs: [{ tag: "C3-net", url: "chrome-error://chromewebdata/", title: "docs.cursor.com", active: true }],
        pages: [{ url: "chrome-error://chromewebdata/", headings: [{ level: "H1", text: "This site can’t be reached" }], visibleText: "ERR_SOCKS_CONNECTION_FAILED" }],
      };
    },
  });
  let coordTurn = 0, browserTurn = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) return call("b-net", "browser_agent", { task: "依次打开 6 个 docs 链接" });
      if (coordTurn === 2) {
        const receipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-net")!.text!);
        assert.equal(receipt.status, "blocked");
        assert.equal(receipt.circuitBroken, true);
        assert.match(receipt.result, /\[BLOCKED\]/);
        return verified();
      }
      return completed();
    }
    browserTurn++;
    if (browserTurn <= 2) {
      assert(definitions.some(d => d.name === "browser_tabs"));
      return { role: "assistant", text: "尝试打开第 " + browserTurn + " 个链接", calls: [{ id: "nav-" + browserTurn, name: "browser_tabs", arguments: { action: "open", url: `https://docs.cursor.com/p${browserTurn}` } }] };
    }
    // Turn 3 must be forced wrap-up with empty definitions!
    assert.deepEqual(definitions, [], "host circuit breaker must disable tools on forced wrap-up turn");
    assert(JSON.stringify(messages).includes("[宿主熔断]"));
    return { role: "assistant", text: "[BLOCKED] docs.cursor.com 连续 2 次 ERR_SOCKS_CONNECTION_FAILED，已停止重试。" };
  };
  try {
    const job = await segment(await add("打开 docs 核实"));
    assert.equal(job.status, "done");
    assert.equal(navCalls, 2, "circuit breaker must stop after 2 consecutive network errors instead of trying 6 URLs");
    assert.equal(browserTurn, 3);
  } finally { await engine.close(); await store.close(); }
});

test("queued same-batch browser_agent short-circuits after an earlier phase trips the host circuit breaker", async () => {
  const { store, engine, add, segment } = await fixture();
  const cfg = await store.get<any>("config", {});
  await store.put("config", { ...cfg, scheduler: { globalSlots: 1, perEmployeeSlots: 1 } });
  let navCalls = 0;
  (engine as any).chromeFor = async () => ({
    execute: async () => {
      navCalls++;
      return {
        tabTag: "C9-net",
        tabs: [{ tag: "C9-net", url: "chrome-error://chromewebdata/", title: "docs.cursor.com", active: true }],
        pages: [{ url: "chrome-error://chromewebdata/", headings: [{ level: "H1", text: "This site can’t be reached" }], visibleText: "ERR_CONNECTION_TIMED_OUT" }],
      };
    },
  });
  let coordTurn = 0;
  const turns = new Map<string, number>();
  let releaseSecond!: () => void;
  const secondHold = new Promise<void>((r) => { releaseSecond = r; });
  engine.providers.chat = async (model, _system, messages, definitions, _sig, _emit, sessionId) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) {
        return { role: "assistant", calls: [
          { id: "b-1", name: "browser_agent", arguments: { task: "打开站点 A" } },
          { id: "b-2", name: "browser_agent", arguments: { task: "打开站点 B" } },
          { id: "b-3", name: "browser_agent", arguments: { task: "打开站点 C" } },
        ] };
      }
      if (coordTurn === 2) {
        const r1 = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-1")!.text!);
        const r3 = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-3")!.text!);
        assert.equal(r1.status, "blocked");
        assert.equal(r1.circuitBroken, true);
        assert.equal(r3.status, "blocked");
        assert.equal(r3.circuitBroken, true);
        assert.equal(r3.executor, "host/circuit_breaker");
        assert.match(r3.result, /短路跳过/);
        return verified();
      }
      return completed();
    }
    const text = String(messages.find((m) => m.role === "user")?.text || "");
    const t = (turns.get(sessionId!) || 0) + 1;
    turns.set(sessionId!, t);
    if (text.includes("站点 B")) {
      await secondHold;
      return { role: "assistant", text: "站点 B 已完成。" };
    }
    if (t <= 2) {
      return { role: "assistant", calls: [{ id: "nav-" + t, name: "browser_tabs", arguments: { action: "open", url: `https://docs.cursor.com/x${t}` } }] };
    }
    assert.deepEqual(definitions, []);
    setTimeout(releaseSecond, 20);
    return { role: "assistant", text: "[BLOCKED] 网络连接连续失败，已停止。" };
  };
  try {
    const job = await segment(await add("核实多个页面"));
    assert.equal(job.status, "done");
    assert.equal(navCalls, 2, "queued third browser_agent must short-circuit with zero extra Chrome calls");
    assert.equal((await store.sessions()).filter(s => s.phaseRole === "browser_agent").length, 2, "queued third browser_agent must not launch a child LLM session");
  } finally { releaseSecond(); await engine.close(); await store.close(); }
});

test("concurrent browser_agent phases run in parallel with runtime per-session tab ownership and clean release", async () => {
  const { store, engine, add, segment } = await fixture();
  let serial = 0;
  const fakeTabs: any[] = [{ tag: "C0-existing", url: "about:blank", title: "blank", active: true, controllable: true }];
  const bridge = new ChromeBridge();
  (bridge as any).request = async (op: string, args: any) => {
    if (op === "tabs") return { tabs: fakeTabs.map((t) => ({ ...t })) };
    if (op === "open" || op === "new_tab") {
      const tab = { tag: "C" + ++serial, url: args.url, title: args.url, active: true, controllable: true };
      for (const t of fakeTabs) t.active = false;
      fakeTabs.push(tab);
      return { tabTag: tab.tag, tabs: fakeTabs.map((t) => ({ ...t })) };
    }
    if (op === "goto") {
      const tab = fakeTabs.find((t) => t.tag === args.tabTag)!;
      tab.url = args.url;
      tab.title = args.url;
      return { tabTag: tab.tag, tabs: fakeTabs.map((t) => ({ ...t })) };
    }
    throw Error("unexpected bridge op " + op);
  };
  const chrome = new Chrome(store, bridge, "");
  (chrome as any).settleNavigation = async () => fakeTabs.map((t) => ({ ...t }));
  (chrome as any).feedback = async (_owner: string, tag: string) => {
    const tab = fakeTabs.find((t) => t.tag === tag)!;
    return { tabTag: tag, pages: [{ url: tab.url, title: tab.title, visibleText: "content of " + tab.url }], images: [] };
  };
  (engine as any).chromeFor = async () => chrome;

  let coordTurn = 0, activeBrowsers = 0, peakBrowsers = 0;
  let releaseBoth!: () => void, zaiOpened!: () => void, bigmodelCheckedConflict!: () => void;
  const bothEntered = new Promise<void>((r) => { releaseBoth = r; });
  const waitZaiOpen = new Promise<void>((r) => { zaiOpened = r; });
  const waitBigmodelConflict = new Promise<void>((r) => { bigmodelCheckedConflict = r; });
  let enteredCount = 0;
  let zaiTabTag = "";
  const phaseTurns = new Map<string, number>();

  engine.providers.chat = async (model, _system, messages, _definitions, _sig, _emit, sessionId) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) {
        return { role: "assistant", calls: [
          { id: "b-zai", name: "browser_agent", arguments: { task: "核实国际站 z.ai 定价" } },
          { id: "b-cn", name: "browser_agent", arguments: { task: "核实国内站 bigmodel.cn 定价" } },
        ] };
      }
      if (coordTurn === 2) {
        const rZai = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-zai")!.text!);
        const rCn = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-cn")!.text!);
        assert.equal(rZai.status, "completed");
        assert.equal(rCn.status, "completed");
        // Strict per-phase evidence isolation: z.ai never leaks bigmodel.cn and vice versa!
        assert(rZai.evidence.visitedUrls.every((u: any) => u.url.includes("z.ai")), JSON.stringify(rZai.evidence.visitedUrls));
        assert(rCn.evidence.visitedUrls.every((u: any) => u.url.includes("bigmodel.cn")), JSON.stringify(rCn.evidence.visitedUrls));
        assert.equal(chrome.tabOwners.size, 0, "all runtime tab leases must be released once phases end");
        // Follow-up phase must be able to reuse zaiTabTag after lease release!
        return call("b-reuse", "browser_agent", { task: `复用 ${zaiTabTag} 复查` });
      }
      if (coordTurn === 3) {
        const rReuse = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-reuse")!.text!);
        assert.equal(rReuse.status, "completed");
        assert(rReuse.evidence.visitedUrls.some((u: any) => u.url === "https://z.ai/docs"));
        assert.equal(chrome.tabOwners.size, 0);
        return verified();
      }
      return completed();
    }

    const promptText = String(messages.find((m) => m.role === "user")?.text || "");
    const turn = (phaseTurns.get(sessionId!) || 0) + 1;
    phaseTurns.set(sessionId!, turn);

    if (promptText.includes("复查")) {
      if (turn === 1) {
        return { role: "assistant", calls: [{ id: "reuse-goto", name: "browser_tabs", arguments: { action: "goto", url: "https://z.ai/docs", tab: zaiTabTag } }] };
      }
      return { role: "assistant", text: "复查完成。" };
    }

    // Both concurrent phases must receive the runtime tab-isolation notice
    assert(JSON.stringify(messages).includes("[并发标签隔离]"), "concurrent browser_agent phases must get tab isolation notice");

    if (turn === 1) {
      activeBrowsers++;
      peakBrowsers = Math.max(peakBrowsers, activeBrowsers);
      if (++enteredCount === 2) releaseBoth();
      await bothEntered;
    }

    if (promptText.includes("z.ai")) {
      if (turn === 1) {
        return { role: "assistant", calls: [{ id: "open-zai", name: "browser_tabs", arguments: { action: "open", url: "https://z.ai/pricing" } }] };
      }
      if (turn === 2) {
        const opened = JSON.parse(messages.findLast((m) => m.role === "tool" && m.callId === "open-zai")!.text!);
        zaiTabTag = opened.tab || opened.tabTag;
        assert.equal(chrome.tabOwners.get(zaiTabTag), sessionId, "opened tab must be owned by z.ai phase");
        zaiOpened();
        // Stay alive until bigmodel.cn attempts to inspect/steal zaiTabTag
        await waitBigmodelConflict;
        activeBrowsers--;
        return { role: "assistant", text: "z.ai 定价核实完成。" };
      }
    }

    if (promptText.includes("bigmodel.cn")) {
      if (turn === 1) {
        await waitZaiOpen;
        // 1. browser_tabs(list) must hide z.ai's owned tab
        return { role: "assistant", calls: [{ id: "cn-tabs", name: "browser_tabs", arguments: { action: "list" } }] };
      }
      if (turn === 2) {
        const listed = JSON.parse(messages.findLast((m) => m.role === "tool" && m.callId === "cn-tabs")!.text!);
        assert(!listed.tabs.some((t: any) => t.tag === zaiTabTag), "other concurrent phase's tab must be hidden from browser_tabs");
        // 2. Trying to directly hijack zaiTabTag must be rejected at runtime
        return { role: "assistant", calls: [{ id: "cn-hijack", name: "browser_tabs", arguments: { action: "goto", url: "https://bigmodel.cn/hijack", tab: zaiTabTag } }] };
      }
      if (turn === 3) {
        const rejected = messages.findLast((m) => m.role === "tool" && m.callId === "cn-hijack")!;
        assert(rejected.error && /正由另一个并行会话占用/.test(rejected.text!), "hijacking another phase's tab must be rejected: " + rejected.text);
        assert.equal(fakeTabs.find((t) => t.tag === zaiTabTag)!.url, "https://z.ai/pricing", "z.ai tab URL must remain untouched");
        bigmodelCheckedConflict();
        return { role: "assistant", calls: [{ id: "open-cn", name: "browser_tabs", arguments: { action: "open", url: "https://bigmodel.cn/pricing" } }] };
      }
      activeBrowsers--;
      return { role: "assistant", text: "bigmodel.cn 定价核实完成。" };
    }
    throw Error("unexpected phase prompt: " + promptText);
  };

  try {
    const job = await segment(await add("同时从零查 z.ai 与 bigmodel.cn 套餐"));
    assert.equal(job.status, "done");
    assert.equal(peakBrowsers, 2, "two browser_agent phases in the same batch must execute concurrently");
    assert.equal(chrome.tabOwners.size, 0);
  } finally {
    releaseBoth(); zaiOpened(); bigmodelCheckedConflict();
    await engine.close(); await store.close();
  }
});

test("complex browser_agent phase has no artificial turn limit and finishes multi-step collection with host-verified evidence", async () => {
  const { store, engine, add, segment } = await fixture();
  (engine as any).chromeFor = async () => ({
    execute: async () => ({
      tabTag: "C2-ok",
      tabs: [{ tag: "C2-ok", url: "https://cursor.com/pricing", title: "Cursor · Pricing", active: true }],
      pages: [{ url: "https://cursor.com/pricing", headings: [{ level: "H1", text: "Pricing" }], visibleText: "Teams $30/$100/$200" }],
    }),
  });
  let coordTurn = 0, browserTurn = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) return call("b-long", "browser_agent", { task: "完整采集多站点与多面板定价" });
      if (coordTurn === 2) {
        const receipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-long")!.text!);
        assert.equal(receipt.status, "completed");
        assert.equal(receipt.truncatedByTurnLimit, undefined);
        assert.equal(receipt.evidence.visitedUrls[0].url, "https://cursor.com/pricing");
        assert.match(receipt.result, /全部面板采集完成/);
        assert.doesNotMatch(receipt.result, /我先查找标签/);
        return verified();
      }
      return completed();
    }
    browserTurn++;
    const payload = JSON.stringify(messages);
    assert(!payload.includes("[阶段即将到达轮次上限]") && !payload.includes("[阶段强制收尾]"), "no artificial turn-limit warning or cutoff");
    assert(definitions.some(d => d.name === "browser_view"), "tools remain available past 18 turns");
    if (browserTurn <= 22) {
      return {
        role: "assistant",
        text: browserTurn === 1 ? "我先查找标签。" : "",
        calls: [{ id: "t-" + browserTurn, name: "browser_view", arguments: { tab: "C2-ok", screenshot: false } }],
      };
    }
    return { role: "assistant", text: "全部面板采集完成：Teams $30 / $100 / $200。" };
  };
  try {
    const job = await segment(await add("完整采集多站点定价"));
    assert.equal(job.status, "done");
    assert.equal(browserTurn, 23, "browser_agent finishes all 22 tool turns plus concluding summary without forced truncation");
  } finally { await engine.close(); await store.close(); }
});

test("browser_agent loop guard trips after repeated stale navigation without short-circuiting unrelated sibling phases", async () => {
  const { store, engine, add, segment } = await fixture();
  let siblingExecuted = false;
  (engine as any).chromeFor = async () => ({
    execute: async (_owner: string, _cwd: string, args: any) => ({
      tabTag: args.tab || "C4-loop",
      tabs: [{ tag: args.tab || "C4-loop", url: args.url || "https://example.test/1", title: "img", active: true }],
      url: args.url || "https://example.test/1",
    }),
  });
  let coordTurn = 0;
  const phaseTurns = new Map<string, number>();
  const urls = ["https://example.test/img1.png", "https://example.test/img2.png", "https://example.test/img3.png"];

  engine.providers.chat = async (model, _system, messages, definitions, _sig, _emit, sessionId) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) {
        return {
          role: "assistant",
          calls: [
            { id: "b-loop", name: "browser_agent", arguments: { task: "打开三张图片链接" } },
            { id: "b-sibling", name: "browser_agent", arguments: { task: "检查另一个正常站点" } },
          ],
        };
      }
      if (coordTurn === 2) {
        const loopReceipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-loop")!.text!);
        const sibReceipt = JSON.parse(messages.findLast(m => m.role === "tool" && m.callId === "b-sibling")!.text!);
        assert.equal(loopReceipt.status, "blocked");
        assert.equal(loopReceipt.circuitBroken, true);
        assert.match(loopReceipt.result, /\[BLOCKED\]/);
        assert.equal(sibReceipt.status, "completed", "single-phase loop circuit break must not short-circuit sibling browser_agent");
        assert.equal(sibReceipt.circuitBroken, undefined);
        return verified();
      }
      return completed();
    }

    const promptText = String(messages.find(m => m.role === "user")?.text || "");
    const t = (phaseTurns.get(sessionId!) || 0) + 1;
    phaseTurns.set(sessionId!, t);

    if (promptText.includes("正常站点")) {
      if (t === 1) {
        return { role: "assistant", calls: [{ id: "sib-open", name: "browser_tabs", arguments: { action: "open", url: "https://example.test/ok" } }] };
      }
      siblingExecuted = true;
      return { role: "assistant", text: "正常站点已核实。" };
    }

    if (t <= 10) {
      const url = urls[(t - 1) % urls.length];
      return { role: "assistant", calls: [{ id: "loop-" + t, name: "browser_tabs", arguments: { action: t === 1 ? "open" : "goto", url, tab: t === 1 ? "" : "C4-loop" } }] };
    }
    assert.deepEqual(definitions, [], "loop guard must disable tools on forced wrap-up turn");
    assert(JSON.stringify(messages).includes("[宿主熔断]"));
    return { role: "assistant", text: "[BLOCKED] 重复导航未取得新进展，建议主控改用 bash 下载原图后 read。" };
  };
  try {
    const job = await segment(await add("核实图片与站点"));
    assert.equal(job.status, "done");
    assert.equal(siblingExecuted, true);
    const loopTurns = [...phaseTurns.values()].find(v => v > 2);
    assert.equal(loopTurns, 11, "loop guard must trip on the 10th nav turn (4th visit to img1) and force wrap-up on turn 11");
  } finally { await engine.close(); await store.close(); }
});

test("code_agent loop guard trips on repeated identical failing tool calls and forces [BLOCKED] wrap-up", async () => {
  const { store, engine, add, segment } = await fixture();
  let coordTurn = 0, codeTurn = 0;
  engine.providers.chat = async (model, _system, messages, definitions) => {
    if (model.selection === "p/light") {
      coordTurn++;
      if (coordTurn === 1) return call("c-loop", "code_agent", { task: "排查并修复代码" });
      if (coordTurn === 2) {
        const receipt = JSON.parse(messages.findLast((m) => m.role === "tool" && m.callId === "c-loop")!.text!);
        assert.equal(receipt.status, "blocked");
        assert.equal(receipt.circuitBroken, true);
        assert.match(receipt.result, /\[BLOCKED\]/);
        return verified();
      }
      return completed();
    }
    codeTurn++;
    if (codeTurn <= 4) {
      return { role: "assistant", calls: [{ id: "cd-" + codeTurn, name: "bash", arguments: { command: "git status" } }] };
    }
    assert.deepEqual(definitions, [], "code_agent loop guard must disable tools on wrap-up turn");
    assert(JSON.stringify(messages).includes("[宿主熔断]"));
    return { role: "assistant", text: "[BLOCKED] bash 连续重复触发相同错误，交回主控。" };
  };
  try {
    const job = await segment(await add("排查代码"));
    assert.equal(job.status, "done");
    assert.equal(codeTurn, 5);
  } finally { await engine.close(); await store.close(); }
});

test("coordinator loop guard nudges first and forces wrap-up if loop persists", async () => {
  const { store, engine, add, segment } = await fixture();
  let turn = 0, sawNudge = false;
  engine.providers.chat = async (_model, _system, messages, definitions) => {
    turn++;
    const payload = JSON.stringify(messages);
    if (payload.includes("[宿主循环提醒]")) sawNudge = true;
    if (turn <= 10) {
      return { role: "assistant", calls: [{ id: "b-" + turn, name: "bash", arguments: { command: "pwd" } }] };
    }
    assert.deepEqual(definitions, [], "coordinator 2nd loop trip must disable tools and force wrap-up");
    assert(payload.includes("[宿主熔断]"));
    return { role: "assistant", text: "检测到循环重复，已停止并汇报当前状态。" };
  };
  try {
    const job = await segment(await add("执行命令"));
    assert.equal(sawNudge, true, "1st coordinator trip must inject soft loop reminder before hard fuse");
    assert.equal(turn, 11);
    assert.equal(job.status, "recovering");
    assert.match(job.result || "", /检测到循环重复/);
  } finally { await engine.close(); await store.close(); }
});

test("queued task after task_wait writes queueReason instead of stale checkpoint and task_progress clears stale checkpoint", async () => {
  const { store, engine, employee, add, segment } = await fixture();
  const blocker = await add("占用工作区的任务");
  await employee.update((s) => { employee.task(s, blocker.id).status = "running"; });
  const blockerSession = await store.newSession({ cwd: blocker.cwd, scene: "coding", employeeId: employee.employeeId, taskId: blocker.id });
  assert.equal(await employee.claimWorkspace(blockerSession, true, blocker.cwd), true);

  const job = await add("等待外部回复后修改工作区");
  await employee.update((s) => {
    const t = employee.task(s, job.id);
    t.checkpoint = "旧等待检查点：TAPD 评论仍无回复";
  });

  let turn = 0;
  engine.providers.chat = async () => {
    turn++;
    if (turn === 1) {
      return { role: "assistant", calls: [{ id: "prog-1", name: "task_progress", arguments: { message: "已收到产品回复，准备修改代码" } }] };
    }
    return { role: "assistant", calls: [{ id: "mut-1", name: "bash", arguments: { command: "git status" } }] };
  };

  try {
    const queued = await segment(job);
    assert.equal(queued.status, "queued");
    assert.equal(queued.checkpoint, undefined, "task_progress on running task must clear stale checkpoint");
    const lastMsg = (await store.messages(queued.workSession!)).at(-1)!;
    assert.equal(lastMsg.role, "assistant");
    assert.doesNotMatch(lastMsg.text || "", /旧等待检查点/);
    assert.match(lastMsg.text || "", /工作区正由另一任务写入/);
  } finally { await engine.close(); await store.close(); }
});
