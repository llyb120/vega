import { test } from "node:test";
import assert from "node:assert/strict";
import { chainAncestors, chainTasks, flattenChainTree, groupTasksByChain, isBranchedChain } from "../shared/task-chain";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

test("flattenChainTree, chainAncestors and groupTasksByChain handle linear, branched and deleted nodes", () => {
  const tasks = [
    { id: "t1", chainId: "ch1", chainSeq: 1, text: "初版方案", status: "done", createdAt: 10 },
    { id: "t2", chainId: "ch1", chainSeq: 2, parentId: "t1", edgeKind: "follow_up" as const, text: "方向A", status: "cancelled", createdAt: 20 },
    { id: "t3", chainId: "ch1", chainSeq: 3, parentId: "t1", retryOf: "t2", edgeKind: "retry" as const, text: "方向B重做", status: "done", createdAt: 30 },
    { id: "t4", chainId: "ch1", chainSeq: 4, parentId: "t3", edgeKind: "follow_up" as const, text: "导出演示", status: "running", createdAt: 40 },
    { id: "solo", text: "独立任务", status: "done", createdAt: 50 },
  ];
  assert.deepEqual(chainTasks(tasks, "ch1").map((t) => t.id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(chainAncestors(tasks, "t4").map((t) => t.id), ["t1", "t3"]);
  const nodes = flattenChainTree(chainTasks(tasks, "ch1"));
  assert.equal(isBranchedChain(nodes), true);
  assert.deepEqual(nodes.map((n) => [n.id, n.depth, n.retryOfSeq]), [
    ["t1", 0, undefined],
    ["t2", 1, undefined],
    ["t3", 1, 2],
    ["t4", 2, undefined],
  ]);

  const activeGroups = groupTasksByChain([tasks[3]], tasks);
  assert.equal(activeGroups.length, 1);
  assert.equal(activeGroups[0].kind, "chain");
  if (activeGroups[0].kind === "chain") {
    assert.equal(activeGroups[0].headTask.id, "t4");
    assert.equal(activeGroups[0].count, 4);
    assert.equal(activeGroups[0].branchCount, 2);
    assert.equal(activeGroups[0].hasActive, true);
  }

  // Missing intermediate parent renders placeholder without breaking sibling hierarchy
  const missingParent = flattenChainTree([tasks[0], tasks[3]]);
  assert.equal(missingParent.some((n) => n.id === "t3" && n.missing), true);
  const childOfMissing = missingParent.find((n) => n.id === "t4");
  assert.equal(childOfMissing?.depth, 1);
});

test("groups route single-employee #taskRefs directly without narrator and aggregate chain messages in topicRows", async () => {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  try {
    const owner = { id: "u1", role: "operator" };
    await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", owner.id, "alice", "unused", owner.role, 0, Date.now(), 0);
    await store.put("config", { scenes: { lightweight: ["p/m"] }, provider: { p: { api: "openai-completions", baseURL: "https://unused.test", models: { m: { limit: { context: 128000, output: 8192 } } } } } });
    const emp = await engine.employee.for((await engine.employee.create({ name: "小A" }, owner.id)).id);
    const other = await engine.employee.for((await engine.employee.create({ name: "小B" }, owner.id)).id);
    const group = await engine.groups.create(owner, { name: "链群", employees: [emp.employeeId, other.employeeId] });

    const created1 = await emp.execute("", { action: "add", kind: "todo", text: "第一版" });
    await emp.update((s) => {
      const t = emp.task(s, created1.value.id);
      t.status = "done";
      t.group = { groupId: group.id, name: group.name, hop: 0, requester: { kind: "user", id: owner.id, name: "alice" }, byOwner: true };
    });
    const created2 = await emp.execute("", { action: "add", kind: "todo", text: "第二版", parentTaskId: created1.value.id, relation: "follow_up" });
    await emp.update((s) => {
      emp.task(s, created2.value.id).group = { groupId: group.id, name: group.name, hop: 0, requester: { kind: "user", id: owner.id, name: "alice" }, byOwner: true };
    });

    const liveGroup = (await engine.groups.get(group.id))!;
    await store.append(liveGroup.session, { role: "assistant", text: "第一版交付", delivery: true, topicTaskId: created1.value.id, tasks: [{ id: created1.value.id, title: "第一版", status: "done" }] });
    await store.append(liveGroup.session, { role: "assistant", text: "第二版进度", progress: true, topicTaskId: created2.value.id, tasks: [{ id: created2.value.id, title: "第二版", status: "queued" }] });

    const topicMsgs = await engine.groups.topicMessages(liveGroup, created1.value.id);
    assert.equal(topicMsgs.length, 2, "topic collects messages across the entire task chain");
    const detail = await engine.groups.task(owner, group.id, emp.employeeId, created2.value.id);
    assert.equal(detail.chainId, created2.value.chainId);
    assert.equal(detail.parentId, created1.value.id);
    assert.equal(detail.chainSeq, 2);

    let routedTo = "";
    engine.providers.chat = async (_model, _sys, msgs) => {
      routedTo = msgs.findLast((m) => m.role === "user")?.text || "";
      return { role: "assistant", text: "收到引用" };
    };
    const sent = await engine.groups.send(owner, group.id, {
      text: "请帮我改一下这个交付",
      taskRefs: [{ id: created1.value.id, intent: "follow_up" }, { id: "non-existent" }],
    });
    for (let i = 0; i < 40 && !routedTo; i++) await new Promise((r) => setTimeout(r, 15));
    const saved = await store.message(liveGroup.session, sent.seq!);
    assert.equal(saved?.taskRefs?.length, 1);
    assert.equal(saved?.taskRefs?.[0].id, created1.value.id);
    assert.equal(saved?.taskRefs?.[0].intent, "follow_up");
    assert.match(routedTo, /本次 # 显式引用任务/);
  } finally {
    await engine.close();
    await store.close();
  }
});
