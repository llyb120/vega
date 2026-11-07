import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Catalog } from "../server/core/catalog";
import { Chrome } from "../server/core/chrome";
import { Engine } from "../server/core/engine";
import type { Call } from "../server/core/store";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Subscriptions } from "../server/core/subscriptions";
import { readFileSync } from "node:fs";

const cleanup: (() => Promise<any> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function engine() {
  const s = await Store.open(":memory:"),
    auth = new Subscriptions(s, ""),
    catalog = new Catalog(s, auth),
    bridge = new ChromeBridge(),
    chrome = new Chrome(
      s,
      bridge,
      readFileSync(
        new URL("../server/assets/browser/browser-page.js", import.meta.url),
        "utf8",
      ),
    );
  const e = await Engine.create(s, catalog, chrome);
  e.employee.closed = true;
  cleanup.push(() => e.close());
  return e;
}

const cfg = {
  provider: {
    test: {
      api: "openai-completions",
      baseURL: "http://localhost:9999",
      models: {
        m: {
          limit: { context: 128000, output: 8000 },
          modalities: { input: ["text", "image"] },
        },
      },
    },
  },
  scenes: {
    lightweight: ["test/m"],
    coding: ["test/m"],
    computer: ["test/m"],
  },
};

const model = {
  selection: "test/m",
  id: "m",
  api: "openai-completions",
  baseURL: "http://localhost:9999",
  contextWindow: 128000,
  maxOutputTokens: 8000,
  supportsImages: true,
  reasoning: false,
  options: {},
} as any;

test("batch independent read calls execute concurrently", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ title: "Concurrent Test" });
  
  // 创建5个独立的read调用
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
    { id: "call_3", name: "read", arguments: { path: "tsconfig.json" } },
    { id: "call_4", name: "read", arguments: { path: "server/core/engine.ts", offset: 1, limit: 10 } },
    { id: "call_5", name: "read", arguments: { path: "server/core/tools.ts", offset: 1, limit: 10 } },
  ];

  // 记录执行时间和并发情况
  const execTimes: { id: string; start: number; end: number }[] = [];
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  // Mock tools.execute
  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      const start = Date.now();
      execTimes.push({ id: call.id, start, end: 0 });
      
      // 模拟50ms的I/O操作
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const end = Date.now();
      const record = execTimes.find(r => r.id === call.id)!;
      record.end = end;
      currentConcurrent--;
      
      return { value: { content: `read ${call.arguments.path}` } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  // 验证所有调用都成功
  assert.equal(outcomes.length, 5);
  outcomes.forEach((outcome, i) => {
    assert(!outcome.error, `Call ${i + 1} should succeed`);
  });

  // 验证确实有并发执行（至少有2个调用同时执行）
  assert(maxConcurrent >= 2, `Expected concurrent execution (max: ${maxConcurrent}), but got serial execution`);
  
  // 验证并发数不超过4
  assert(maxConcurrent <= 4, `Max concurrent (${maxConcurrent}) should not exceed 4`);

  // 验证有时间重叠（证明并发）
  let foundOverlap = false;
  for (let i = 0; i < execTimes.length - 1; i++) {
    for (let j = i + 1; j < execTimes.length; j++) {
      const a = execTimes[i];
      const b = execTimes[j];
      const overlaps = (a.start < b.end && b.start < a.end);
      if (overlaps) {
        foundOverlap = true;
        break;
      }
    }
    if (foundOverlap) break;
  }
  
  assert(foundOverlap, "No concurrent execution detected - all calls were serial");
});

test("bash calls remain serial", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ title: "Bash Serial Test" });
  
  // 创建多个bash调用
  const calls: Call[] = [
    { id: "call_1", name: "bash", arguments: { command: "echo test1" } },
    { id: "call_2", name: "bash", arguments: { command: "echo test2" } },
    { id: "call_3", name: "bash", arguments: { command: "echo test3" } },
  ];

  const execTimes: { id: string; start: number; end: number }[] = [];
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      const start = Date.now();
      execTimes.push({ id: call.id, start, end: 0 });
      
      await new Promise(resolve => setTimeout(resolve, 30));
      
      const end = Date.now();
      const record = execTimes.find(r => r.id === call.id)!;
      record.end = end;
      currentConcurrent--;
      
      return { value: { stdout: "test output" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  outcomes.forEach((outcome, i) => {
    assert(!outcome.error, `Bash call ${i + 1} should succeed`);
  });

  // bash应该保持串行（maxConcurrent应该是1）
  assert.equal(maxConcurrent, 1, `Bash calls should be serial, but got max concurrent: ${maxConcurrent}`);
});

test("_after dependencies are respected", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ title: "Dependency Test" });
  
  // call_2依赖call_1，call_3独立
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md", _after: [1] } },
    { id: "call_3", name: "read", arguments: { path: "tsconfig.json" } },
  ];

  const execOrder: string[] = [];
  const execTimes: { id: string; start: number; end: number }[] = [];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      execOrder.push(call.id);
      const start = Date.now();
      execTimes.push({ id: call.id, start, end: 0 });
      
      await new Promise(resolve => setTimeout(resolve, 30));
      
      const end = Date.now();
      const record = execTimes.find(r => r.id === call.id)!;
      record.end = end;
      
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  
  // call_2必须在call_1之后开始
  const call1End = execTimes.find(r => r.id === "call_1")!.end;
  const call2Start = execTimes.find(r => r.id === "call_2")!.start;
  assert(call2Start >= call1End, "call_2 should start after call_1 ends");
  
  // call_3可以与call_1并发
  const call1Start = execTimes.find(r => r.id === "call_1")!.start;
  const call3Start = execTimes.find(r => r.id === "call_3")!.start;
  const call3End = execTimes.find(r => r.id === "call_3")!.end;
  const overlaps = call1Start < call3End && call3Start < call1End;
  // call_3应该能与call_1并发
  assert(overlaps, "call_3 should be able to run concurrently with call_1");
});

test("approval stops subsequent calls", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ title: "Approval Test", employeeId: "test-employee", taskId: "test-task" });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "context_budget", arguments: {} },
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
  ];

  const executed: string[] = [];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      executed.push(call.id);
      
      if (call.name === "context_budget") {
        // 模拟一个返回stop的工具
        return { value: { status: "pending" }, stop: true };
      }
      
      await new Promise(resolve => setTimeout(resolve, 10));
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  assert(!outcomes[0].error, "call_1 should succeed");
  assert(outcomes[1].stop, "call_2 should have stop flag");
  
  // call_3应该被跳过（因为call_2返回了stop）
  assert(outcomes[2].error, "call_3 should be skipped");
  assert(outcomes[2].value.error.includes("Skipped"), "call_3 should have skip error");
  
  // 只有call_1和call_2实际执行了
  assert.equal(executed.length, 2, "Only first two calls should execute");
  assert.deepEqual(executed, ["call_1", "call_2"]);
});

test("signal cancellation is checked", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ title: "Cancel Test" });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
  ];

  const controller = new AbortController();
  // 立即取消
  controller.abort();

  const executed: string[] = [];

  const tools = {
    session,
    signal: controller.signal,
    execute: async (call: Call) => {
      executed.push(call.id);
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);
  
  // 所有调用都应该被捕获为错误（因为signal已aborted）
  assert.equal(outcomes.length, 2);
  outcomes.forEach((outcome, i) => {
    assert(outcome.error, `Call ${i + 1} should be caught as error`);
  });
  
  // 没有调用应该真正执行
  assert.equal(executed.length, 0, "No calls should execute when signal is already aborted");
});
