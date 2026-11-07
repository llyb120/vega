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

test("batch multiple read calls execute concurrently with localAgent", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Concurrent Read Test", 
    localAgent: true,
    clientId: "test-client-concurrent",
  });
  
  // 验证session确实设置了localAgent
  assert.equal(session.localAgent, true, "session.localAgent should be true");
  assert.equal(session.clientId, "test-client-concurrent", "session.clientId should be set");

  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
    { id: "call_3", name: "read", arguments: { path: "tsconfig.json" } },
    { id: "call_4", name: "read", arguments: { path: "server/core/engine.ts", offset: 1, limit: 10 } },
    { id: "call_5", name: "read", arguments: { path: "server/core/tools.ts", offset: 1, limit: 10 } },
  ];

  // 使用deferred确认并发
  const deferreds = new Map<string, { resolve: () => void; promise: Promise<void> }>();
  for (const call of calls) {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    deferreds.set(call.id, { resolve, promise });
  }

  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      
      // 等待deferred
      await deferreds.get(call.id)!.promise;
      
      currentConcurrent--;
      return { value: { content: `read ${call.arguments.path}` } };
    },
  } as any;

  const batchPromise = e.batch(tools, calls, model);
  
  // 等待一小段时间让调度启动
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // 现在应该有多个并发执行（受并发上限4限制）
  assert(currentConcurrent >= 2 && currentConcurrent <= 4, 
    `Expected 2-4 concurrent reads, got ${currentConcurrent}`);
  
  // 释放所有deferred
  for (const d of deferreds.values()) {
    d.resolve();
  }
  
  const outcomes = await batchPromise;

  assert.equal(outcomes.length, 5);
  outcomes.forEach((outcome, i) => {
    assert(!outcome.error, `Call ${i + 1} should succeed`);
  });

  assert(maxConcurrent >= 2, `Expected concurrent execution (max: ${maxConcurrent})`);
  assert(maxConcurrent <= 4, `Max concurrent (${maxConcurrent}) should not exceed 4`);
});

test("bash conflicts with read in both directions", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Bash vs Read Test",
    localAgent: true,
    clientId: "test-client-bash",
  });
  
  // 测试bash -> read方向
  const calls1: Call[] = [
    { id: "call_1", name: "bash", arguments: { command: "echo test" } },
    { id: "call_2", name: "read", arguments: { path: "package.json" } },
  ];

  const defer1 = { resolve: () => {}, promise: Promise.resolve() };
  const defer2 = { resolve: () => {}, promise: Promise.resolve() };
  defer1.promise = new Promise<void>(r => { defer1.resolve = r; });
  defer2.promise = new Promise<void>(r => { defer2.resolve = r; });

  let call2Started = false;

  const tools1 = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      if (call.id === "call_1") {
        await defer1.promise;
        return { value: { stdout: "test" } };
      } else {
        call2Started = true;
        await defer2.promise;
        return { value: { content: "test" } };
      }
    },
  } as any;

  const batch1 = e.batch(tools1, calls1, model);
  await new Promise(resolve => setTimeout(resolve, 20));
  
  // call_1应该已启动，call_2因为冲突还未启动
  assert(!call2Started, "read should wait for bash to complete");
  
  defer1.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  
  // 现在call_2应该启动了
  assert(call2Started, "read should start after bash completes");
  
  defer2.resolve();
  await batch1;

  // 测试read -> bash方向
  const calls2: Call[] = [
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
    { id: "call_4", name: "bash", arguments: { command: "echo test2" } },
  ];

  const defer3 = { resolve: () => {}, promise: Promise.resolve() };
  const defer4 = { resolve: () => {}, promise: Promise.resolve() };
  defer3.promise = new Promise<void>(r => { defer3.resolve = r; });
  defer4.promise = new Promise<void>(r => { defer4.resolve = r; });

  let call4Started = false;

  const tools2 = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      if (call.id === "call_3") {
        await defer3.promise;
        return { value: { content: "test" } };
      } else {
        call4Started = true;
        await defer4.promise;
        return { value: { stdout: "test2" } };
      }
    },
  } as any;

  const batch2 = e.batch(tools2, calls2, model);
  await new Promise(resolve => setTimeout(resolve, 20));
  
  assert(!call4Started, "bash should wait for read to complete");
  
  defer3.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(call4Started, "bash should start after read completes");
  
  defer4.resolve();
  await batch2;
});

test("Chrome conflicts with read in both directions", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Chrome vs Read Test",
    localAgent: true,
    clientId: "test-client-chrome",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "chrome_tabs", arguments: { query: "test" } },
    { id: "call_2", name: "read", arguments: { path: "package.json" } },
    { id: "call_3", name: "chrome_inspect", arguments: { tabTag: "tab1" } },
  ];

  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      currentConcurrent--;
      return { value: call.name.startsWith("chrome") ? { tabs: [] } : { content: "test" } };
    },
  } as any;

  await e.batch(tools, calls, model);

  // Chrome和read应该完全串行
  assert.equal(maxConcurrent, 1, `Chrome and read should be serial, got max concurrent: ${maxConcurrent}`);
});

test("write/edit conflict with read in both directions", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Write vs Read Test",
    localAgent: true,
    clientId: "test-client-write",
  });
  
  // 测试write -> read方向
  const calls1: Call[] = [
    { id: "call_1", name: "write", arguments: { path: "test.txt", content: "test" } },
    { id: "call_2", name: "read", arguments: { path: "package.json" } },
  ];

  const defer1 = { resolve: () => {}, promise: Promise.resolve() };
  const defer2 = { resolve: () => {}, promise: Promise.resolve() };
  defer1.promise = new Promise<void>(r => { defer1.resolve = r; });
  defer2.promise = new Promise<void>(r => { defer2.resolve = r; });

  let call2Started = false;

  const tools1 = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      if (call.id === "call_1") {
        await defer1.promise;
        return { value: { ok: true } };
      } else {
        call2Started = true;
        await defer2.promise;
        return { value: { content: "test" } };
      }
    },
  } as any;

  const batch1 = e.batch(tools1, calls1, model);
  await new Promise(resolve => setTimeout(resolve, 20));
  
  assert(!call2Started, "read should wait for write to complete");
  
  defer1.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(call2Started, "read should start after write completes");
  
  defer2.resolve();
  await batch1;

  // 测试read -> edit方向
  const calls2: Call[] = [
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
    { id: "call_4", name: "edit", arguments: { path: "test2.txt", edits: [{ oldText: "a", newText: "b" }] } },
  ];

  const defer3 = { resolve: () => {}, promise: Promise.resolve() };
  const defer4 = { resolve: () => {}, promise: Promise.resolve() };
  defer3.promise = new Promise<void>(r => { defer3.resolve = r; });
  defer4.promise = new Promise<void>(r => { defer4.resolve = r; });

  let call4Started = false;

  const tools2 = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      if (call.id === "call_3") {
        await defer3.promise;
        return { value: { content: "test" } };
      } else {
        call4Started = true;
        await defer4.promise;
        return { value: { ok: true } };
      }
    },
  } as any;

  const batch2 = e.batch(tools2, calls2, model);
  await new Promise(resolve => setTimeout(resolve, 20));
  
  assert(!call4Started, "edit should wait for read to complete");
  
  defer3.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(call4Started, "edit should start after read completes");
  
  defer4.resolve();
  await batch2;
});

test("concurrent read with one failure - others succeed and results match IDs", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Failure Test",
    localAgent: true,
    clientId: "test-client-fail",
  });
  
  const calls: Call[] = [
    { id: "call_A", name: "read", arguments: { path: "package.json" } },
    { id: "call_B", name: "read", arguments: { path: "nonexistent.file" } },
    { id: "call_C", name: "read", arguments: { path: "README.md" } },
    { id: "call_D", name: "read", arguments: { path: "tsconfig.json" } },
  ];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      
      if (call.arguments.path === "nonexistent.file") {
        throw new Error("File not found");
      }
      
      return { value: { data: `result_${call.id}` } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 4);
  
  // 验证结果与ID对应
  assert.equal(outcomes[0].value.data, "result_call_A", "outcome[0] should be for call_A");
  assert(outcomes[1].error, "call_B should fail");
  assert(outcomes[1].value.error.includes("File not found"), "call_B should have correct error");
  assert.equal(outcomes[2].value.data, "result_call_C", "outcome[2] should be for call_C");
  assert.equal(outcomes[3].value.data, "result_call_D", "outcome[3] should be for call_D");
  
  // 其他调用成功
  assert(!outcomes[0].error, "call_A should succeed");
  assert(!outcomes[2].error, "call_C should succeed");
  assert(!outcomes[3].error, "call_D should succeed");
});

test("9+ concurrent reads with slot waiting and abort - no deadlock", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Slot Test",
    localAgent: true,
    clientId: "test-client-slot",
  });
  
  // 10个read，超过并发上限4
  const calls: Call[] = [];
  for (let i = 1; i <= 10; i++) {
    calls.push({ 
      id: `call_${i}`, 
      name: "read", 
      arguments: { path: `file${i}.txt` } 
    });
  }

  const controller = new AbortController();
  const executed: string[] = [];

  const tools = {
    session,
    signal: controller.signal,
    execute: async (call: Call) => {
      executed.push(call.id);
      
      // 前5个执行一会儿后取消
      if (executed.length === 5) {
        setTimeout(() => controller.abort(), 10);
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
      return { value: { content: "test" } };
    },
  } as any;

  try {
    await e.batch(tools, calls, model);
    assert.fail("Should have been aborted");
  } catch (error: any) {
    // 应该被取消
  }

  // 应该有一些调用开始执行，但不是全部
  assert(executed.length > 0, "Some calls should have started");
  assert(executed.length < 10, "Not all calls should have started (aborted)");
  
  // 验证没有死锁（测试能完成）
  assert(true, "No deadlock");
});

test("event start is emitted for each call", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Event Test",
    localAgent: true,
    clientId: "test-client-event",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
    { id: "call_3", name: "read", arguments: { path: "tsconfig.json" } },
  ];

  const startEvents: string[] = [];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { value: { content: "test" } };
    },
  } as any;

  // 监听start事件
  const originalEmit = e.emit.bind(e);
  e.emit = (event: any) => {
    if (event.type === "tool_start") {
      startEvents.push(event.data.id);
    }
    originalEmit(event);
  };

  await e.batch(tools, calls, model);

  // 验证每个call都有start
  assert.equal(startEvents.length, 3, "Should have 3 start events");
  assert(startEvents.includes("call_1"), "call_1 should have start event");
  assert(startEvents.includes("call_2"), "call_2 should have start event");
  assert(startEvents.includes("call_3"), "call_3 should have start event");
  
  // Note: tool_end事件由engine.outcome发出，不在batch函数内部
  // batch只负责调度和执行，事件发送在run函数中
});

test("task_request_approval cannot be batched with other tools", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Approval Standalone Test",
    employeeId: "test-employee",
    taskId: "test-task",
    localAgent: true,
    clientId: "test-client-approval",
  });
  
  // task_request_approval与read一起调用应该被拒绝
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "task_request_approval", arguments: { question: "Continue?" } },
  ];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  // 所有调用都应该被拒绝（因为task_request_approval必须单独调用）
  assert.equal(outcomes.length, 2);
  assert(outcomes[0].error, "call_1 should be rejected");
  assert(outcomes[1].error, "call_2 should be rejected");
  assert(outcomes[0].value.error.includes("must be called alone"), 
    "Should indicate standalone requirement");
});

test("non-read barrier returns stop - subsequent calls not executed", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Stop Barrier Test",
    localAgent: true,
    clientId: "test-client-stop",
  });
  
  // bash返回stop应该阻止后续read（不依赖_after）
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "bash", arguments: { command: "echo test" } },
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
  ];

  const executed: string[] = [];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      executed.push(call.id);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      if (call.id === "call_2") {
        return { value: { stdout: "test" }, stop: true };
      }
      
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  assert(!outcomes[0].error, "call_1 should succeed");
  assert(outcomes[1].stop, "call_2 should have stop flag");
  assert(outcomes[2].error, "call_3 should be skipped");
  
  // 验证call_3没有执行（冲突已经保证串行，所以不会执行）
  assert.equal(executed.length, 2, "Only first two calls should execute");
  assert(executed.includes("call_1"), "call_1 should execute");
  assert(executed.includes("call_2"), "call_2 should execute");
  assert(!executed.includes("call_3"), "call_3 should not execute");
});
