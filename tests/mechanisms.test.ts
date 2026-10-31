import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { MCP } from "../server/core/mcp";
import { Store } from "../server/core/store";
import { Providers } from "../server/core/provider";
import { resolveModel } from "../server/core/config";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Chrome } from "../server/core/chrome";
import { Engine } from "../server/core/engine";
import { Relay } from "../server/core/relay";
import { compileScript, parse } from "@vue/compiler-sfc";
const cleanup: (() => any)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function http(handler: any) {
  const server = createServer(handler);
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  cleanup.push(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function body(req: any) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return JSON.parse(Buffer.concat(parts).toString());
}
const completion = (res: any, m: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: m,
            finish_reason: m.tool_calls ? "tool_calls" : "stop",
          },
        ],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
};
const call = (id: string, name: string, args: any) => ({
  index: 0,
  id,
  function: { name, arguments: JSON.stringify(args) },
});
function setup(url: string) {
  const s = new Store(":memory:"),
    auth = new Subscriptions(s, ""),
    catalog = new Catalog(s, auth),
    chrome = new Chrome(
      s,
      new ChromeBridge(),
      readFileSync("server/assets/browser/browser-page.js", "utf8"),
    ),
    engine = new Engine(s, catalog, chrome);
  engine.employee.closed = true;
  s.put("config", {
    model: "p/m",
    provider: {
      p: {
        api: "openai-completions",
        baseURL: url,
        models: {
          m: {
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text", "image"] },
          },
        },
      },
    },
    contextMode: "acp",
  });
  cleanup.push(async () => {
    await engine.close();
    s.close();
  });
  return engine;
}
test("MCP Streamable HTTP describe-before-call, definition revalidation, readOnly allowlist", async () => {
  let calls = 0,
    changed = false;
  const url = await http(async (req: any, res: any) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const q = await body(req);
    let result: any = {};
    if (q.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    if (q.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (q.method === "tools/list")
      result = {
        tools: [
          {
            name: "get",
            description: changed ? "changed" : "read",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    if (q.method === "tools/call") {
      calls++;
      result = { content: [{ type: "text", text: "value" }] };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  const m = new MCP({ test: { url } }, process.cwd());
  cleanup.push(() => m.close());
  await assert.rejects(() =>
    m.execute({ op: "call", server: "test", tool: "get" }),
  );
  await m.execute({ op: "describe", server: "test", tool: "get" });
  await assert.rejects(() =>
    m.execute({ op: "call", server: "test", tool: "get" }, true),
  );
  assert.equal(calls, 0);
  await m.execute({ op: "call", server: "test", tool: "get" });
  changed = true;
  await assert.rejects(() =>
    m.execute({ op: "call", server: "test", tool: "get" }),
  );
  assert.equal(calls, 1);
});
test("MCP stdio lifecycle closes helper and does not auto-retry calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-mcp-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "server.cjs");
  await writeFile(
    script,
    `const readline=require('node:readline');const rl=readline.createInterface({input:process.stdin});rl.on('line',l=>{const q=JSON.parse(l);if(q.id===undefined)return;let result={};if(q.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};if(q.method==='tools/call')result={content:[{type:'text',text:'echoed'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}))});`,
  );
  const m = new MCP(
    { stdio: { command: process.execPath, args: [script] } },
    dir,
  );
  cleanup.push(() => m.close());
  await m.execute({ op: "describe", server: "stdio", tool: "echo" });
  const result = await m.execute({
    op: "call",
    server: "stdio",
    tool: "echo",
    arguments: {},
  });
  assert.equal(result.content[0].text, "echoed");
  await m.close();
  assert.equal(m.connections.size, 0);
});
test("Responses continuation survives SQLite seq/at metadata; invalid continuation falls back once", async () => {
  const requests: any[] = [];
  let count = 0;
  const url = await http(async (req: any, res: any) => {
    const b = await body(req);
    requests.push(b);
    count++;
    if (count === 2) {
      res.writeHead(404);
      res.end("previous response not found");
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "answer",
        }) +
        "\n\ndata: " +
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed", id: "r" + count, usage: {} },
        }) +
        "\n\n",
    );
  });
  const model = resolveModel({
      model: "p/m",
      provider: {
        p: {
          api: "openai-responses",
          baseURL: url,
          models: { m: { limit: { context: 128000, output: 8192 } } },
        },
      },
    }),
    p = new Providers(),
    signal = new AbortController().signal;
  const user = { role: "user", text: "one" },
    first = await p.chat(
      model,
      "sys",
      [user],
      [],
      signal,
      undefined,
      "session",
    );
  const prior = [
    { ...user, seq: 1, at: 1 },
    { ...first, seq: 2, at: 2 },
    { role: "user", text: "two" },
  ];
  await p.chat(model, "sys", prior, [], signal, undefined, "session");
  assert.equal(requests[1].previous_response_id, "r1");
  assert.equal(requests[1].input.length, 1);
  assert.equal(requests[2].previous_response_id, undefined);
  assert(requests[2].input.length >= 3);
  assert.equal(count, 3);
});
test("employee external-job defer and Chrome relay reuse exactly two isolated sessions", async () => {
  let calls = 0;
  const url = await http(async (req: any, res: any) => {
    const q = await body(req);
    calls++;
    if (calls === 1)
      completion(res, {
        tool_calls: [
          call("relay", "employee", {
            action: "relay",
            scene: "computer",
            text: "inspect authorized page",
          }),
        ],
      });
    else if (calls === 2) {
      assert.equal(q.model, "vision");
      assert(!q.messages.some((m: any) => m.role === "assistant"));
      completion(res, { content: "Chrome result" });
    } else if (calls === 3) {
      assert(JSON.stringify(q.messages).includes("Chrome result"));
      completion(res, {
        tool_calls: [
          call("defer", "employee", {
            action: "defer",
            text: "job123 already submitted, check only job123",
            nextCheckInMinutes: 1,
          }),
        ],
      });
    } else completion(res, { content: "job123 complete" });
  });
  const e = setup(url),
    cfg = e.config();
  cfg.provider.p.models.vision = {
    limit: { context: 128000, output: 8192 },
    modalities: { input: ["text", "image"] },
  };
  cfg.scenes = { computer: ["p/vision"] };
  e.store.put("config", cfg);
  const dir = await mkdtemp(join(tmpdir(), "vega-worker-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const created = await e.employee.execute("", {
    action: "add",
    kind: "todo",
    text: "work",
    cwd: dir,
  });
  const key = created.value.id;
  for (let segment = 0; segment < 4; segment++) {
    e.employee.update((s) => {
      const t = s.tasks.find((t) => t.id === key)!;
      t.status = "running";
      t.nextCheckAt = 0;
    });
    const task = e.employee.state().tasks.find((t) => t.id === key)!;
    e.employee.busy.set(key, {
      computer: task.side === "computer",
      session: "",
    });
    await e.employee.run(task);
  }
  const task = e.employee.state().tasks.find((t) => t.id === key)!;
  assert.equal(task.status, "done");
  assert(
    task.workSession &&
      task.computerSession &&
      task.workSession !== task.computerSession,
  );
  assert.equal(e.store.sessions().length, 2);
  assert.equal(calls, 4);
  assert.equal(e.employee.busy.size, 0);
});
test("StarLink validates peer identity and preserves authenticated owner for tasks and support", async () => {
  const e = setup("https://unused.test");
  e.employee.update((s) => (s.public = true));
  const owner = { token: "alice/token", name: "Alice" };
  await e.relay.serve(owner, "employee_say", { text: "remote task" });
  const task = e.employee.state().tasks[0];
  assert.equal(task.owner.token, owner.token);
  await assert.rejects(() =>
    e.employee.control(
      { action: "remove", id: task.id },
      { token: "other/token", name: "Other" },
    ),
  );
  await assert.rejects(() =>
    e.employee.remote({ token: "unsolicited", name: "Bad" }, "starlink.help", {
      id: "r",
      question: "do something",
    }),
  );
  e.employee.update((s) => s.links.push(owner.token));
  await e.employee.remote(owner, "starlink.help", {
    id: "request",
    task: "need info",
    question: "what is the value?",
  });
  await e.employee.remote(owner, "starlink.help", {
    id: "request",
    task: "need info",
    question: "duplicate",
  });
  assert.equal(
    e.employee.state().tasks.filter((t) => t.replyTo?.id === "request").length,
    1,
  );
});
test("Vue3.6 components use Vapor compiler, not VDOM fallback", () => {
  for (const file of [
    "App.vue",
    "Integrations.vue",
    "Team.vue",
    "Accounts.vue",
    "BrowserView.vue",
  ]) {
    const code = readFileSync("web/src/" + file, "utf8"),
      descriptor = parse(code, { filename: file }).descriptor;
    assert.equal(descriptor.scriptSetup?.attrs.vapor, true);
    const compiled = compileScript(descriptor, {
      id: file,
      inlineTemplate: true,
    });
    assert(
      descriptor.vapor &&
        compiled.content.includes("_template(") &&
        compiled.content.includes("_renderEffect"),
      "Vapor DOM output missing for " + file,
    );
  }
  assert.match(readFileSync("web/src/main.js", "utf8"), /createVaporApp/);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.dependencies.vue, /^3\.6\./);
});
