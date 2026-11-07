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

test("batch independent read calls execute concurrently with localAgent", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  // 设置localAgent=true，走真实调度路径
  const session = await e.store.newSession({ 
    cwd: process.cwd(),
    title: "Concurrent Test", 
    localAgent: true,
    clientId: "test-client-123",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
    { id: "call_3", name: "read", arguments: { path: "tsconfig.json" } },
    { id: "call_4", name: "read", arguments: { path: "server/core/engine.ts", offset: 1, limit: 10 } },
    { id: "call_5", name: "read", arguments: { path: "server/core/tools.ts", offset: 1, limit: 10 } },
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

  assert.equal(outcomes.length, 5);
  outcomes.forEach((outcome, i) => {
    assert(!outcome.error, `Call ${i + 1} should succeed`);
  });

  // 验证确实有并发执行（修复后应该并发）
  assert(maxConcurrent >= 2, `Expected concurrent execution (max: ${maxConcurrent}), but got serial`);
  assert(maxConcurrent <= 4, `Max concurrent (${maxConcurrent}) should not exceed 4`);

  let foundOverlap = false;
  for (let i = 0; i < execTimes.length - 1; i++) {
    for (let j = i + 1; j < execTimes.length; j++) {
      const a = execTimes[i];
      const b = execTimes[j];
      if (a.start < b.end && b.start < a.end) {
        foundOverlap = true;
        break;
      }
    }
    if (foundOverlap) break;
  }
  
  assert(foundOverlap, "No concurrent execution detected - all calls were serial");
});

test("bash acts as barrier against all tools including read", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Bash Barrier Test",
    localAgent: true,
    clientId: "test-client-456",
  });
  
  // bash应该与read串行
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "bash", arguments: { command: "echo test" } },
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
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
      
      return { value: call.name === "bash" ? { stdout: "test" } : { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  outcomes.forEach((outcome, i) => {
    assert(!outcome.error, `Call ${i + 1} should succeed`);
  });

  // bash应该作为屏障，maxConcurrent应该是1
  assert.equal(maxConcurrent, 1, `Bash should act as barrier, but got max concurrent: ${maxConcurrent}`);
  
  // 验证执行顺序：call_1 -> call_2 -> call_3
  const call1End = execTimes.find(r => r.id === "call_1")!.end;
  const call2Start = execTimes.find(r => r.id === "call_2")!.start;
  const call2End = execTimes.find(r => r.id === "call_2")!.end;
  const call3Start = execTimes.find(r => r.id === "call_3")!.start;
  
  assert(call2Start >= call1End, "bash should start after read1 ends");
  assert(call3Start >= call2End, "read3 should start after bash ends");
});

test("write acts as barrier against read", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Write Barrier Test",
    localAgent: true,
    clientId: "test-client-789",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "write", arguments: { path: "test.txt", content: "test" } },
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
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
      return { value: { ok: true } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  // write是barrier，应该串行
  assert.equal(maxConcurrent, 1, `Write should act as barrier, but got max concurrent: ${maxConcurrent}`);
});

test("_after dependencies are respected with localAgent", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Dependency Test",
    localAgent: true,
    clientId: "test-client-dep",
  });
  
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
  assert(overlaps, "call_3 should be able to run concurrently with call_1");
});

test("stop flag prevents subsequent executions", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Stop Test",
    localAgent: true,
    clientId: "test-client-stop",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
    { id: "call_3", name: "read", arguments: { path: "tsconfig.json", _after: [2] } }, // 依赖call_2
  ];

  const executed: string[] = [];
  let stopAfterSecond = false;

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      executed.push(call.id);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // call_2触发stop
      if (call.id === "call_2") {
        stopAfterSecond = true;
        return { value: { content: "test" }, stop: true };
      }
      
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  assert(!outcomes[0].error, "call_1 should succeed");
  assert(outcomes[1].stop, "call_2 should have stop flag");
  
  // call_3应该被跳过
  assert(outcomes[2].error, "call_3 should be skipped");
  assert(outcomes[2].value.error.includes("Skipped") || outcomes[2].value.error.includes("suspended"), 
    "call_3 should have skip error");
  
  // 验证只有前两个真正执行
  assert(executed.length <= 2, "At most first two calls should execute");
  assert(executed.includes("call_1"), "call_1 should execute");
  assert(executed.includes("call_2"), "call_2 should execute");
  assert(!executed.includes("call_3"), "call_3 should not execute");
});

test("signal cancellation is checked before execution", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Cancel Test",
    localAgent: true,
    clientId: "test-client-cancel",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "README.md" } },
  ];

  const controller = new AbortController();
  controller.abort(); // 立即取消

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
  
  assert.equal(outcomes.length, 2);
  outcomes.forEach((outcome, i) => {
    assert(outcome.error, `Call ${i + 1} should be caught as error due to abort`);
  });
  
  assert.equal(executed.length, 0, "No calls should execute when signal is already aborted");
});

test("failed call does not block independent calls", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Failure Isolation Test",
    localAgent: true,
    clientId: "test-client-fail",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "read", arguments: { path: "package.json" } },
    { id: "call_2", name: "read", arguments: { path: "nonexistent.txt" } }, // 会失败
    { id: "call_3", name: "read", arguments: { path: "README.md" } },
  ];

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      
      if (call.arguments.path === "nonexistent.txt") {
        throw new Error("File not found");
      }
      
      return { value: { content: "test" } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  assert(!outcomes[0].error, "call_1 should succeed");
  assert(outcomes[1].error, "call_2 should fail");
  assert(outcomes[1].value.error.includes("File not found"), "call_2 should have correct error");
  assert(!outcomes[2].error, "call_3 should succeed despite call_2 failure");
});

test("result IDs correspond to call IDs", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "ID Correspondence Test",
    localAgent: true,
    clientId: "test-client-id",
  });
  
  const calls: Call[] = [
    { id: "call_A", name: "read", arguments: { path: "package.json" } },
    { id: "call_B", name: "read", arguments: { path: "README.md" } },
    { id: "call_C", name: "read", arguments: { path: "tsconfig.json" } },
  ];

  const resultMap = new Map<string, string>();

  const tools = {
    session,
    signal: AbortSignal.timeout(30000),
    execute: async (call: Call) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = `result_${call.id}`;
      resultMap.set(call.id, result);
      return { value: { data: result } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  
  // 虽然可能乱序执行，但结果应该在正确的位置
  assert.equal(outcomes[0].value.data, "result_call_A", "outcome[0] should be for call_A");
  assert.equal(outcomes[1].value.data, "result_call_B", "outcome[1] should be for call_B");
  assert.equal(outcomes[2].value.data, "result_call_C", "outcome[2] should be for call_C");
});

test("Chrome tools remain serial", async () => {
  const e = await engine();
  await e.saveConfig(cfg);

  const session = await e.store.newSession({ 
    cwd: process.cwd(), 
    title: "Chrome Serial Test",
    localAgent: true,
    clientId: "test-client-chrome",
  });
  
  const calls: Call[] = [
    { id: "call_1", name: "chrome_tabs", arguments: { query: "test1" } },
    { id: "call_2", name: "chrome_tabs", arguments: { query: "test2" } },
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
      return { value: { tabs: [] } };
    },
  } as any;

  const outcomes = await e.batch(tools, calls, model);

  assert.equal(outcomes.length, 3);
  outcomes.forEach((outcome, i) => {
    assert(!outcome.error, `Chrome call ${i + 1} should succeed`);
  });
  
  // Chrome工具应该串行
  assert.equal(maxConcurrent, 1, `Chrome tools should be serial, but got max concurrent: ${maxConcurrent}`);
});
