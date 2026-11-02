import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { recallMemory } from "../server/core/employee";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  const employee = engine.employee.for(engine.employee.create({ name: "Memory employee" }, "owner").id), chat = employee.chat("owner");
  return { store, engine, employee, chat };
}
const action = (id: string, arguments_: any) => ({ role: "assistant", calls: [{ id, name: "employee", arguments: arguments_ }] });

test("employee memory instructions require durable write before acknowledgement and refresh remembered/updated/forgotten facts in the same turn", async () => {
  const { store, engine, employee, chat } = fixture();
  let phase = "remember", requests = 0, memory = "";
  engine.providers.chat = async (_model, system, _messages, definitions) => {
    assert(system.includes("主动积累") && system.includes("先调用remember成功"));
    assert(system.includes("临时进度") && system.includes("不能派任务绕过记忆权限"));
    assert(definitions.find(tool => tool.name === "employee")!.description.includes("主动积累"));
    if (requests++ % 2 === 0) return phase === "forget"
      ? action("forget", { action: "forget", id: memory })
      : action(phase, { action: "remember", ...(memory ? { id: memory } : {}), text: phase === "remember" ? "Project Aurora uses the east region." : "Project Aurora now uses the west region.", importance: 2 });
    if (phase === "remember") assert(system.includes("Project Aurora uses the east region."));
    if (phase === "update") {
      assert(system.includes("Project Aurora now uses the west region."));
      assert(!system.includes("Project Aurora uses the east region."));
    }
    if (phase === "forget") assert(!system.includes("Project Aurora now uses the west region."));
    return { role: "assistant", text: "记忆已处理。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "Project Aurora 的长期环境是 east region" });
    memory = employee.state().memories[0].id;
    phase = "update";
    await engine.run(chat.id, { role: "user", text: "更新长期约定：现在固定改用 west region" });
    assert.equal(employee.state().memories.length, 1);
    assert.equal(employee.state().memories[0].id, memory);
    phase = "forget";
    await engine.run(chat.id, { role: "user", text: "忘记这条环境约定" });
    assert.equal(employee.state().memories.length, 0);
    const other = engine.employee.for(engine.employee.create({ name: "Other" }, "other").id);
    assert.equal(other.state().memories.length, 0);
  } finally { await engine.close(); store.close(); }
});

test("chat recalls older relevant memories outside the latest 30 and reinforces only once per user turn, not once per tool call", async () => {
  const { store, engine, employee, chat } = fixture();
  const now = Date.now(), previousUse = now - 3 * 86400000;
  employee.update(state => {
    state.memories = [
      { id: "older", text: "项目银河统一使用TypeScript并在原目录开发", importance: 2, strength: 1, at: previousUse, usedAt: previousUse },
      ...Array.from({ length: 35 }, (_, index) => ({ id: "recent-" + index, text: "unrelated preference " + index, importance: 1, strength: 1, at: now, usedAt: now })),
    ];
  });
  let requests = 0;
  engine.providers.chat = async (_model, system) => {
    assert(system.includes("项目银河统一使用TypeScript并在原目录开发"), "relevant older facts cannot disappear merely because newer memories were appended");
    return requests++ < 2 ? action("list-" + requests, { action: "list" }) : { role: "assistant", text: "沿用项目银河现有约定。" };
  };
  try {
    await engine.run(chat.id, { role: "user", text: "项目银河统一使用TypeScript并在原目录开发，继续按这个约定" });
    const memory = employee.state().memories.find(item => item.id === "older")!;
    assert.equal(memory.strength, 2);
    assert(memory.usedAt > previousUse);
    assert.equal(requests, 3);
  } finally { await engine.close(); store.close(); }
});

test("stable facts saved by an execution task are accumulated by that employee and recalled by later chat", async () => {
  const { store, engine, employee, chat } = fixture();
  const created = await employee.execute("", { action: "add", kind: "todo", text: "核验项目银河的网关约定" });
  const fact = "项目银河网关固定使用HTTP/1.1，已核验调用链。";
  let requests = 0;
  engine.providers.chat = async (_model, system) => {
    assert(system.includes("有新的可复用事实时在complete前保存"));
    if (requests++ === 0) return action("remember", { action: "remember", text: fact, importance: 2 });
    assert(system.includes(fact));
    if (requests === 2) return action("verify", { action: "progress", text: "verified original gateway configuration", plan: [{ content: "verify gateway", status: "completed" }] });
    if (requests === 3) return action("complete", { action: "complete", text: "verified gateway without configuration changes", summary: "网关约定已核验。" });
    return { role: "assistant", text: "按项目银河已保存的网关约定处理。" };
  };
  try {
    employee.update(state => { state.tasks[0].status = "running"; });
    employee.busy.set(created.value.id, { computer: false, session: "" });
    await employee.run(employee.state().tasks[0]);
    assert.equal(employee.state().tasks[0].status, "done");
    assert.equal(employee.state().memories[0].text, fact);
    assert.equal(engine.employee.state().memories.length, 0, "a non-default employee never writes into the default employee's memory");
    await engine.run(chat.id, { role: "user", text: "项目银河网关后续怎么处理？" });
    assert.match(store.messages(chat.id).at(-1)!.text!, /已保存/);
    assert.equal(employee.state().memories.length, 1);
  } finally { await engine.close(); store.close(); }
});

test("read-only memory selection does not strengthen facts on each model request and legacy strength fields remain valid", () => {
  const now = Date.now();
  const state: any = { memories: [{ id: "legacy", text: "项目银河默认使用TypeScript", importance: 2, at: now }] };
  recallMemory(state, "项目银河默认使用TypeScript", now, false);
  assert.equal(state.memories[0].usedAt, undefined);
  assert.equal(state.memories[0].strength, undefined);
  recallMemory(state, "项目银河默认使用TypeScript", now);
  assert.equal(state.memories[0].strength, 2);
  assert.equal(state.memories[0].usedAt, now);
});
