import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { ConnectDecoder, decodeProto, envelope, fieldBytes, fieldNumber } from "../server/core/devin";

// Exercise the actual transport functions with a virtual clock, not a three-minute wall-clock wait.
function transport() {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, ms: number) => { const id = ++sequence; timers.set(id, { at: now + ms, callback }); return id; };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  };
  const requests: { signal: AbortSignal; headers: (response: Response) => void }[] = [];
  const source = readFileSync("server/core/util.ts", "utf8");
  const extract = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end)).replace("export ", "");
  const code = extract("export async function request(", "export async function jsonRequest(") + extract("export async function readChunk(", "export async function* sse(");
  const compiled = ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  const methods = vm.runInNewContext(compiled + "\n({ request, readChunk })", {
    setTimeout: schedule, clearTimeout: (id: number) => timers.delete(id), AbortController,
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: (ms: number) => { const controller = new AbortController(); schedule(() => controller.abort(Error("total request timeout")), ms); return controller.signal; } },
    proxyDispatcher: async () => undefined,
    proxyFetch: (_url: string, init: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      requests.push({ signal: init.signal, headers: resolve });
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  return { ...methods, requests, advance, timers };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("Nova streaming requests allow slow headers beyond 20s and have no whole-response deadline after headers", async () => {
  const state = transport(), controller = new AbortController();
  const waiting = state.request("https://fixture.test/stream", { signal: controller.signal }, 0);
  void waiting.catch(() => {});
  await flush();
  state.advance(21000);
  assert.equal(state.requests[0].signal.aborted, false, "20s is not the model response-header deadline");
  const response = new Response("stream fixture");
  state.requests[0].headers(response);
  assert.equal(await waiting, response);
  state.advance(180000);
  assert.equal(state.requests[0].signal.aborted, false, "the header timer is cleared, not left to kill a healthy long stream");
  controller.abort(Error("user cancelled"));
  assert.equal(state.requests[0].signal.aborted, true, "caller cancellation remains connected after response headers");
  assert.equal(state.timers.size, 0);
});

test("Nova response-header timeout is 180s while explicit non-stream request deadlines retain their value", async () => {
  const state = transport();
  const waiting = state.request("https://fixture.test/stream", {}, 0);
  const observed = waiting.then(() => undefined, (error: Error) => error);
  await flush();
  state.advance(179999);
  assert.equal(state.requests[0].signal.aborted, false);
  state.advance(1);
  assert.equal(state.requests[0].signal.aborted, true);
  assert.match((await observed).message, /response headers.*180s/);
  assert.equal(state.timers.size, 0);

  const regular = transport();
  const request = regular.request("https://fixture.test/login", {}, 30000);
  const result = request.then(() => undefined, (error: Error) => error);
  await flush();
  regular.advance(29999);
  assert.equal(regular.requests[0].signal.aborted, false);
  regular.advance(1);
  assert.equal(regular.requests[0].signal.aborted, true);
  assert.match((await result).message, /total request timeout/);

  const relay = transport();
  const relayResult = relay.request("https://fixture.test/events", {}, 0, 20000).then(() => undefined, (error: Error) => error);
  await flush();
  relay.advance(20000);
  assert.match((await relayResult).message, /response headers.*20s/, "relay connection keeps its separate existing header deadline");
});

test("stream idle timeout resets per received chunk, even when total elapsed time exceeds 180s", async () => {
  const state = transport();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const reader = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }).getReader();
  try {
    for (let index = 0; index < 3; index++) {
      const waiting = state.readChunk(reader);
      state.advance(179999);
      stream.enqueue(Uint8Array.of(index));
      assert.equal((await waiting).value[0], index);
      assert.equal(state.timers.size, 0);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
});

test("180s of stream silence rejects as an idle timeout and cancels the read instead of reporting normal EOF", async () => {
  const state = transport();
  let cancelled = false;
  const reader = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }).getReader();
  try {
    const result = state.readChunk(reader).then(() => undefined, (error: Error) => error);
    state.advance(179999);
    assert.equal(cancelled, false);
    state.advance(1);
    assert.match((await result).message, /Stream idle for 180000ms/);
    assert.equal(cancelled, true);
    assert.equal(state.timers.size, 0);
  } finally { await reader.cancel(); reader.releaseLock(); }
});

test("native Devin uses the same header-only request mode rather than a 180s whole-body timer", async () => {
  const state = transport();
  const source = readFileSync("server/core/devin.ts", "utf8");
  const compiled = ts.transpile(source.slice(source.indexOf("export async function devinStream(")).replace("export ", ""), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  const payload = Buffer.concat([envelope(Buffer.concat([fieldBytes(3, "native reply"), fieldNumber(5, 1)])), envelope(Buffer.from("{}"), 2)]);
  const run = vm.runInNewContext(compiled + "\ndevinStream", {
    URL, Buffer, assert, ConnectDecoder, decodeProto, readChunk: state.readChunk,
    utf8: (value: Buffer) => value.toString("utf8"), encodeDevin: () => Buffer.alloc(0),
    request: async (_url: string, _init: RequestInit, timeout: number) => {
      assert.equal(timeout, 0, "native streaming must opt out of the non-stream total deadline");
      return new Response(payload, { headers: { "Content-Type": "application/connect+proto" } });
    },
  });
  const result = await run({ baseURL: "https://fixture.test", headers: {}, selection: "fixture/native" }, {}, "fixture", new AbortController().signal, () => {});
  assert.equal(result.text, "native reply");
  assert.equal(state.timers.size, 0);
});

test("user cancellation interrupts a silent stream immediately and cleans up its idle timer", async () => {
  const state = transport(), controller = new AbortController(), reason = Error("user cancelled");
  let cancelled = false;
  const reader = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }).getReader();
  try {
    const result = state.readChunk(reader, controller.signal).then(() => undefined, (error: Error) => error);
    controller.abort(reason);
    assert.equal(cancelled, true, "no need to wait for another chunk or the 180s idle timeout");
    assert.equal(await result, reason);
    assert.equal(state.timers.size, 0);
  } finally { await reader.cancel(); reader.releaseLock(); }
});
