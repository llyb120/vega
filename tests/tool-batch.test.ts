import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../server/core/engine";
import type { Call } from "../server/core/store";

// batch 只用到 session/signal/execute 和 this.emit：用最小替身覆盖调度，不建整个 Engine。
const call = (id: string, name: string, args: Record<string, any> = {}): Call => ({ id, name, arguments: args });
function run(calls: Call[], execute: (call: Call) => Promise<any>, cwd = process.cwd(), onSettled?: any) {
  const engine = { emit: () => {} } as any;
  const tools = { session: { id: "s", cwd, localAgent: true }, signal: new AbortController().signal, execute } as any;
  return Engine.prototype.batch.call(engine, tools, calls, {} as any, new Set(calls.map((c) => c.name)), onSettled) as Promise<any[]>;
}

test("independent calls overlap up to 8 and each result keeps its own call", async () => {
  const calls = Array.from({ length: 9 }, (_, i) => call("r" + i, "read", { path: `f${i}` }));
  let active = 0,
    peak = 0;
  const results = await run(calls, async (c) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((yes) => setTimeout(yes, 5));
    active--;
    return { value: { read: c.id } };
  });
  assert.equal(peak, 8, "bounded concurrency");
  assert.deepEqual(results.map((r) => r.value.read), calls.map((c) => c.id));
});

test("a delayed dependency cannot overbook a slot handed to an existing waiter", async () => {
  const calls = Array.from({ length: 24 }, (_, i) => call(String(i), "read", { path: String(i), ...(i >= 16 ? { _after: [i - 15] } : {}) }));
  let active = 0, peak = 0;
  const results = await run(calls, async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return { value: {} };
  });
  assert.equal(peak, 8);
  assert(!results.some(result => result.error));
});

test("screen resources stay ordered and UI/MCP/agent outcomes cannot authorize automatic dependents", async () => {
  const order: string[] = [];
  await run([call("web", "chrome_act"), call("desktop", "appuse_act")], async c => {
    order.push(c.id + ":start");
    await new Promise(resolve => setTimeout(resolve, 1));
    order.push(c.id + ":end"); return { value: {} };
  });
  assert.deepEqual(order, ["web:start", "web:end", "desktop:start", "desktop:end"]);
  for (const name of ["chrome_inspect", "appuse_elements", "spawn_agent", "mcp"]) {
    let inputs = 0;
    const outcomes = await run([call("observe", name), call("write", "write", { path: "x", _after: [1] })], async () => { inputs++; return { value: {} }; });
    assert.equal(inputs, 1);
    assert.match(outcomes[1].value.error, /require model review/);
  }
});

test("a finished call is reported at once instead of after the whole batch", async () => {
  const settled: string[] = [];
  await run(
    [call("slow", "read", { path: "a" }), call("fast", "read", { path: "b" })],
    async (c) => {
      await new Promise((yes) => setTimeout(yes, c.id === "slow" ? 30 : 1));
      return { value: {} };
    },
    process.cwd(),
    (_i: number, outcome: any) => settled.push(outcome.value?.tag ?? "done"),
  );
  assert.equal(settled.length, 2, "every call reported");
});

test("only known shared resources wait: same bash command and same mutated file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-batch-"));
  try {
    await writeFile(join(dir, "one.txt"), "x");
    const log: string[] = [];
    const track = (c: Call) => {
      log.push(c.id + ":start");
      return new Promise<any>((yes) => setTimeout(() => (log.push(c.id + ":end"), yes({ value: {} })), 5));
    };
    await run([call("same1", "bash", { command: "cmd" }), call("same2", "bash", { command: "cmd" })], track as any, dir);
    assert.deepEqual(log, ["same1:start", "same1:end", "same2:start", "same2:end"], "same command stays ordered");

    log.length = 0;
    await run([call("w1", "write", { path: "one.txt", content: "a" }), call("w2", "edit", { path: "one.txt", edits: [] })], track as any, dir);
    assert.deepEqual(log, ["w1:start", "w1:end", "w2:start", "w2:end"], "same file stays ordered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_after waits for its prerequisite and skips when it failed", async () => {
  const order: string[] = [];
  const skipped = await run(
    [call("first", "read", { path: "a" }), call("second", "read", { path: "b", _after: [1] })],
    async (c) => (order.push(c.id), c.id === "first" ? { value: { error: "boom" }, error: true } : { value: {} }),
  );
  assert.deepEqual(order, ["first"]);
  assert.match(skipped[1].value.error, /prerequisite failed/);

  const waited = await run(
    [call("first", "read", { path: "a" }), call("second", "read", { path: "b", _after: [1] })],
    async () => (await new Promise((yes) => setTimeout(yes, 5)), { value: { at: Date.now() } }),
  );
  assert(waited[1].value.at >= waited[0].value.at, "dependent starts after its prerequisite");
});

test("cancellation and a suspended call run nothing further", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let executed = 0;
  const tools = {
    session: { id: "s", cwd: process.cwd(), localAgent: true },
    signal: aborted.signal,
    execute: async () => (executed++, { value: {} }),
  } as any;
  const out = await Engine.prototype.batch.call({ emit: () => {} } as any, tools, [call("a", "read", { path: "x" })], {} as any, new Set(["read"]));
  assert.equal(executed, 0);
  assert.equal(out[0].error, true);

  const stop = await run([call("a", "read", { path: "x" }), call("b", "bash", { command: "cmd" })], async (c) =>
    c.id === "a" ? { value: { error: "waiting for approval" }, error: true, stop: true } : { value: {} },
  );
  assert.match(stop[1].value.error, /suspended/);
});
