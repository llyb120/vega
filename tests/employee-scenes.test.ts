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

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "p/code", scenes: { lightweight: ["p/light"], coding: ["p/code"], computer: ["p/vision"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: Object.fromEntries(["light", "code", "vision", "failed"].map(id => [id, { modalities: { input: id === "vision" ? ["text", "image"] : ["text"] }, limit: { context: 128000, output: 8192 } }])) } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Scene employee" }, "owner").id);
  const add = async (text: string, profile = "lightweight") => {
    const created = await employee.execute("", { action: "add", kind: "todo", text, profile });
    return employee.task(employee.state(), created.value.id);
  };
  const segment = async (job: Task) => {
    employee.update(state => { employee.task(state, job.id).status = "running"; });
    const current = employee.task(employee.state(), job.id);
    employee.busy.set(job.id, { computer: current.side === "computer", session: "" });
    await employee.run(current);
    return employee.task(employee.state(), job.id);
  };
  return { store, engine, employee, add, segment };
}
const call = (id: string, name: string, args: any) => ({ role: "assistant", calls: [{ id, name, arguments: args }] });
const verified = () => call("verify", "employee", { action: "progress", text: "verified authorized goal", plan: [{ content: "verify goal", status: "completed" }] });
const completed = () => call("complete", "employee", { action: "complete", text: "goal verified", summary: "已验证完成。" });

test("even a coding-profile task starts lightweight, upgrades in the same work session and retains coding after browser handoff", async () => {
  const { store, engine, employee, add, segment } = fixture();
  const selected: string[] = [];
  let phase = 0;
  engine.providers.chat = async (model, system, messages, definitions) => {
    selected.push(model.selection);
    assert(system.includes("新主任务统一先用轻量模型") && system.includes("普通信息查询不因使用read或bash而升级"));
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
      assert(!definitions.some(tool => ["write", "edit", "bash", "switch_scene"].includes(tool.name)));
      return { role: "assistant", text: "浏览器已验证。" };
    }
    assert.equal(model.selection, "p/code", "returning from the browser must not reset an upgraded task to lightweight");
    return phase === 4 ? verified() : completed();
  };
  try {
    let job = await add("实现功能并在浏览器验证", "coding");
    job = await segment(job);
    const work = job.workSession;
    assert.equal(store.session(work).scene, "coding");
    assert.equal(job.side, "computer");
    job = await segment(job);
    assert.equal(job.side, "work");
    job = await segment(job);
    assert.equal(job.status, "done");
    assert.equal(job.workSession, work);
    assert.equal(store.sessions().length, 2);
    assert.deepEqual(selected, ["p/light", "p/code", "p/vision", "p/code", "p/code"]);
    assert.deepEqual(employee.state().runs.map(run => run.scene), ["lightweight", "computer", "coding"], "run records reflect their actual starting scenes");

    let requests = 0;
    engine.providers.chat = async model => {
      assert.equal(model.selection, "p/light", "a new unrelated task never inherits the previous task's coding model");
      return requests++ === 0 ? verified() : completed();
    };
    assert.equal((await segment(await add("查询任务状态和实际请求地址"))).status, "done");
  } finally { await engine.close(); store.close(); }
});

test("employee communication reselects the configured lightweight model instead of keeping a stale coding selection", async () => {
  const { store, engine, employee } = fixture();
  try {
    const chat = employee.chat("owner");
    chat.model = "p/code"; chat.scene = "coding"; store.saveSession(chat);
    engine.providers.chat = async (model, system, _messages, definitions) => {
      assert.equal(model.selection, "p/light");
      assert(!definitions.some(tool => tool.name === "switch_scene"));
      assert(!system.includes("日志分析优先profile=coding"));
      return { role: "assistant", text: "这是普通问答。" };
    };
    await engine.run(chat.id, { role: "user", text: "目前有哪些待处理事项？" });
    assert.equal(store.session(chat.id).model, "p/light");
    assert.equal(store.session(chat.id).scene, "lightweight");
    const ordinary = store.newSession({ model: "p/code", scene: "coding" });
    engine.providers.chat = async model => { assert.equal(model.selection, "p/code"); return { role: "assistant", text: "用户手动选择保持不变。" }; };
    await engine.run(ordinary.id, { role: "user", text: "ordinary manual session" });
  } finally { await engine.close(); store.close(); }
});

test("lightweight candidate failures stay within the lightweight list instead of borrowing a coding model", async () => {
  const { store, engine, add, segment } = fixture();
  const config = engine.config(); config.scenes!.lightweight = ["p/failed", "p/light"]; store.put("config", config);
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
    assert.equal(store.session(job.workSession).scene, "lightweight");
  } finally { await engine.close(); store.close(); }
});

test("a scene covered by the current preferred model does not expose a redundant switch just because it has a different backup", async () => {
  const { store, engine, add, segment } = fixture();
  const config = engine.config(); config.scenes!.coding = ["p/light", "p/code"]; store.put("config", config);
  let requests = 0;
  engine.providers.chat = async (model, _system, _messages, definitions) => {
    assert.equal(model.selection, "p/light");
    assert(!definitions.some(tool => tool.name === "switch_scene"), "Nova treats the preferred identical model as already covering coding");
    return requests++ === 0 ? verified() : completed();
  };
  try { assert.equal((await segment(await add("按已覆盖场景完成工作"))).status, "done"); }
  finally { await engine.close(); store.close(); }
});
