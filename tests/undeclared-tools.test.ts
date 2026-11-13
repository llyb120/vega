import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

test("undeclared tools become error receipts; a session corrects itself without bypassing scene or batch permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-undeclared-"));
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const bodies: any[] = [], events: any[] = [];
  engine.events.on("event", (event) => events.push(event));
  const call = (index: number, id: string, name: string, args: object) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    bodies.push(JSON.parse(body));
    const delta = bodies.length === 1
      ? { tool_calls: [call(0, "bad-one", "switch_scene", { scene: "coding", message: "do not switch" })] }
      : bodies.length === 2
        ? { tool_calls: [
            call(0, "good", "write", { path: "once.txt", content: "written once" }),
            call(1, "bad-two", "switch_scene", { scene: "coding", message: "still forbidden" }),
            call(2, "bad-three", "unlisted_tool", {}),
            call(3, "dependent", "write", { path: "blocked.txt", content: "must not exist", _after: [3] }),
          ] }
        : bodies.length === 4
          ? { tool_calls: [call(0, "bad-write", "write", { path: "read-only.txt", content: "must not exist" })] }
          : { content: "finished" };
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  await store.put("config", { scenes: { lightweight: ["fixture/m"], coding: ["fixture/m"] }, provider: { fixture: { api: "openai-completions", baseURL: url, models: { m: { limit: { context: 128000, output: 1000 }, modalities: { input: ["text"] } } } } } });
  try {
    const session = await store.newSession({ cwd: dir, scene: "lightweight", model: "fixture/m", sceneEnumFrozen: [] });
    await engine.run(session.id, { role: "user", text: "do the authorized work" });
    assert.equal(bodies.length, 3, "the same session continues after the tool error");
    assert(!bodies[0].tools.some((tool: any) => tool.function.name === "switch_scene"));
    const history = await store.messages(session.id);
    for (const [id, name] of [["bad-one", "switch_scene"], ["bad-two", "switch_scene"], ["bad-three", "unlisted_tool"]]) {
      const receipt = history.find((message) => message.role === "tool" && message.callId === id);
      assert.equal(receipt?.error, true);
      assert.equal(JSON.parse(receipt?.text || "{}").error, `当前会话未授权工具：${name}；本步未执行`);
      assert(bodies.some((body) => body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === id && message.content.includes("未授权工具"))), "the model sees the rejected call");
    }
    assert.match(history.find((message) => message.callId === "dependent")?.text || "", /prerequisite failed/);
    assert.equal(await readFile(join(dir, "once.txt"), "utf8"), "written once");
    await assert.rejects(readFile(join(dir, "blocked.txt")), /ENOENT/);
    assert.equal(history.filter((message) => message.callId === "good").length, 1, "successful calls are not replayed");
    assert(!events.some((event) => event.type === "scene" && event.data?.scene === "coding"), "an undeclared runtime-only tool cannot change scenes");
    assert.equal((await store.session(session.id)).scene, "lightweight");
    assert.equal(history.at(-1)?.text, "finished");

    const readOnly = await store.newSession({ cwd: dir, scene: "lightweight", model: "fixture/m", readOnly: true });
    await engine.run(readOnly.id, { role: "user", text: "read only" });
    assert(!bodies[3].tools.some((tool: any) => tool.function.name === "write"));
    const denied = (await store.messages(readOnly.id)).find((message) => message.callId === "bad-write");
    assert.equal(denied?.error, true);
    assert.match(denied?.text || "", /当前会话未授权工具：write/);
    await assert.rejects(readFile(join(dir, "read-only.txt")), /ENOENT/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
