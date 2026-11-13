import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import {
  inheritView,
  withoutOpenTail,
  userTurns,
  validTaskName,
  reserveAgent,
  beginAgent,
  finishAgent,
  interruptAgent,
  hasPendingAgents,
  takeReadyAgents,
  awaitPendingAgents,
  MAX_ACTIVE_AGENTS,
  agentTools,
  formatAgentHandoff,
  AGENT_HANDOFF_PREFIX,
  resetAgents,
  agentPath,
} from "../server/core/spawn-agent";
import type { Message } from "../server/core/store";

afterEach(() => resetAgents());

const view: Message[] = [
  { role: "user", text: "first ask" },
  { role: "assistant", text: "first reply" },
  { role: "user", text: "second ask" },
  { role: "assistant", calls: [{ id: "r1", name: "read", arguments: { path: "a.ts" } }] },
  { role: "tool", callId: "r1", name: "read", text: "file body" },
];

test("inheritView supports omit, none, and turn:N, and falls back to full history when out of range", () => {
  assert.deepEqual(userTurns(view), [0, 2]);
  assert.equal(inheritView(view, "").length, 5);
  assert.equal(inheritView(view).length, 5);
  assert.equal(inheritView(view, "none").length, 0);
  assert.equal(inheritView(view, "NONE").length, 0);
  assert.deepEqual(inheritView(view, "turn:1").map((m) => m.text), ["first ask", "first reply"]);
  assert.equal(inheritView(view, "turn:2").length, 5, "the last user turn is the same as omit");
  assert.equal(inheritView(view, "turn:0").length, 5);
  assert.equal(inheritView(view, "turn:9").length, 5);
  assert.equal(inheritView(view, "nope").length, 5);
  assert.equal(inheritView(view, "turn:1").length, 2);
  assert.deepEqual(userTurns([view[0], { role: "user", text: "aborted", runtime: "turn_aborted" }, { role: "user", text: "dynamic", runtime: "dynamic" }, view[2]]), [0, 3], "host runtime messages are not user turns");
});

test("withoutOpenTail drops an in-flight assistant tool call so the child does not see unread results", () => {
  const open: Message[] = [
    ...view,
    { role: "assistant", calls: [{ id: "pending", name: "read", arguments: { path: "b.ts" } }] },
  ];
  const trimmed = withoutOpenTail(open);
  assert.equal(trimmed.length, view.length);
  assert.equal(trimmed.at(-1)?.role, "tool");
  assert.equal(withoutOpenTail(view).length, view.length);
});

test("at most 6 agents run at once; a finished name can be reused; failures are not auto-respawned", () => {
  const parent = "parent";
  for (let i = 0; i < MAX_ACTIVE_AGENTS; i++) {
    const name = "task_" + i;
    reserveAgent(parent, name, "do " + i);
    beginAgent(parent, { name, sessionId: "s" + i, path: agentPath(name), status: "running", running: true, cancelled: false });
  }
  assert.throws(() => reserveAgent(parent, "task_extra", "nope"), /6 agents are already running/);
  finishAgent(parent, agentPath("task_0"), "completed", "done");
  const ready = takeReadyAgents(parent);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].status, "completed");
  assert.equal(ready[0].message, "done");
  reserveAgent(parent, "task_0", "reuse after finish");
  beginAgent(parent, { name: "task_0", sessionId: "s0b", path: agentPath("task_0"), status: "running", running: true, cancelled: false });
  finishAgent(parent, agentPath("task_0"), "errored", "boom");
  const failed = takeReadyAgents(parent);
  assert.equal(failed[0].status, "errored");
  assert.equal(failed[0].message, "boom");
  assert.equal(hasPendingAgents(parent), true, "the other five are still running");
});

test("interrupt_agent stops a running child and finished-first delivery does not wait for slower peers", async () => {
  const parent = "p-int";
  reserveAgent(parent, "slow", "slow work");
  beginAgent(parent, { name: "slow", sessionId: "slow", path: agentPath("slow"), status: "running", running: true, cancelled: false });
  reserveAgent(parent, "fast", "fast work");
  beginAgent(parent, { name: "fast", sessionId: "fast", path: agentPath("fast"), status: "running", running: true, cancelled: false });
  finishAgent(parent, agentPath("fast"), "completed", "fast done");
  const first = await awaitPendingAgents(parent);
  assert.equal(first?.length, 1);
  assert.equal(first![0].task_name, "fast");
  const row = interruptAgent(parent, "slow");
  assert.equal(row.status, "interrupted");
  finishAgent(parent, agentPath("slow"), "interrupted", "stopped");
  const second = await awaitPendingAgents(parent);
  assert.equal(second?.[0].status, "interrupted");
});

test("agent tool schema mentions all three context modes and does not bake in an example turn number", () => {
  const tools = agentTools();
  const spawn = tools.find((t) => t.name === "spawn_agent")!;
  const schema = JSON.stringify(spawn.parameters);
  assert.match(schema, /turn:N/);
  assert.doesNotMatch(schema, /turn:3/);
  assert.match(spawn.description, /do not auto-retry/i);
  assert.ok(formatAgentHandoff([{ path: "/root/a", task_name: "a", sessionId: "s", status: "completed" }]).startsWith(AGENT_HANDOFF_PREFIX));
  assert.equal(validTaskName("ok_1"), true);
  assert.equal(validTaskName("Bad"), false);
});

test("store.stage still rejects task and employee sessions; agentStage creates a linked 分身 Stage", async () => {
  const store = await Store.open(":memory:");
  try {
    const ordinary = await store.newSession({ title: "chat" });
    const stage = await store.stage(ordinary.id);
    assert.equal(stage.title, "Stage");
    assert.equal(stage.stageSource, ordinary.id);
    const task = await store.newSession({ title: "work", taskId: "t1", employeeId: "e1", promptCacheKey: "parent-cache-key" });
    await assert.rejects(() => store.stage(task.id), /Employee history must continue through its workspace/);
    const child = await store.agentStage(task, "probe");
    assert.equal(child.title, "[分身] probe");
    assert.equal(child.agentChild, true);
    assert.equal(child.spawnParent, task.id);
    assert.equal(child.taskId, "t1");
    assert.equal(child.employeeId, "e1");
    assert.equal(child.promptCacheKey, "parent-cache-key");
    const listed = await store.sessionsByStageSource(task.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, child.id);
  } finally {
    await store.close();
  }
});
