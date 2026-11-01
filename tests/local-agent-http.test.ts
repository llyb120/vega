import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { LocalAgentBridge } from "../web/src/local-agent.js";
import { sleep } from "../server/core/util";

test("deployed login → frontend WebSocket → local client executes once, pauses on lost response and resumes only on user input", {
  skip: process.env.VEGA_TEST_LOCAL_AGENT !== "1", timeout: 60000,
}, async (t) => {
  const binary = resolve("local", process.platform === "win32" ? "vega-local.exe" : "vega-local");
  assert(existsSync(binary), "Build the local client first");
  const reserved = tcpServer();
  try { await new Promise<void>((yes, no) => { reserved.once("error", no); reserved.listen(47673, "127.0.0.1", yes); }); }
  catch { t.skip("Local agent port is in use; do not interfere with a user's client"); return; }
  await new Promise<void>((yes) => reserved.close(() => yes()));
  const dir = await mkdtemp(join(tmpdir(), "vega-local-e2e-"));
  const clientDir = join(dir, "client"), serverDir = join(dir, "server"), configDir = join(dir, "config");
  await mkdir(clientDir); await mkdir(serverDir); await mkdir(join(configDir, "vega-local"), { recursive: true });
  const reserve = createServer();
  await new Promise<void>((yes) => reserve.listen(0, "127.0.0.1", yes));
  const port = (reserve.address() as any).port;
  await new Promise<void>((yes) => reserve.close(() => yes()));
  const base = "http://127.0.0.1:" + port, token = randomBytes(32).toString("base64url");
  await writeFile(join(configDir, "vega-local", "trusted-sites.json"), JSON.stringify({ trustedOrigins: [base] }));
  let modelCalls = 0;
  const mock = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelCalls++;
    const latest = [...body.messages].reverse().find((m: any) => m.role === "user")?.content;
    const hasTool = body.messages.at(-1)?.role === "tool";
    const loss = String(latest).includes("loss fixture");
    const command = process.platform === "win32"
      ? (loss ? "Add-Content -LiteralPath loss.txt -Value once; Start-Sleep -Seconds 10" : "Set-Content -LiteralPath from-client.txt -Value local-success")
      : (loss ? "printf 'once\\n' >> loss.txt; sleep 10" : "printf 'local-success\\n' > from-client.txt");
    const delta = hasTool || String(latest).includes("continue after repair")
      ? { content: "verified completion" }
      : { tool_calls: [{ index: 0, id: "fixture-" + modelCalls, function: { name: "bash", arguments: JSON.stringify({ command, timeout: 20 }) } }] };
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((yes) => mock.listen(0, "127.0.0.1", yes));
  const backend = spawn(process.execPath, [resolve(".output/server/index.mjs")], { windowsHide: true, stdio: "pipe", env: {
    ...process.env, VEGA_DB: join(dir, "app.db"), VEGA_TOKEN: token, VEGA_PUBLIC_URL: base,
    VEGA_BROWSER_MODE: "", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), VEGA_SKILL_CACHE: join(dir, "skills"),
  } });
  const client = spawn(binary, [], { cwd: clientDir, windowsHide: true, stdio: "ignore", env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir } });
  let logs = "", cookie = "", csrf = "", online = false, dropNext = false;
  backend.stdout!.on("data", (b) => logs += b); backend.stderr!.on("data", (b) => logs += b);
  const events: any[] = [], sockets: WebSocket[] = [];
  const api = async (path: any, method: any = "GET", data?: any) => {
    const r = await fetch(base + "/api" + path, { method, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await r.json(); if (!r.ok) throw Error(JSON.stringify(value)); return value;
  };
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300; i++) { if (await condition()) return; await sleep(20); }
    throw Error("Local bridge fixture timed out: " + logs);
  };
  const original = globalThis.WebSocket;
  class LocalSocket extends WebSocket {
    constructor(url: string) { super(url, { headers: { origin: base } }); sockets.push(this); }
  }
  globalThis.WebSocket = LocalSocket as any;
  let bridge: LocalAgentBridge | undefined;
  try {
    await until(async () => { try { return (await fetch(base + "/api/auth/me")).ok; } catch { return false; } });
    const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: token, username: "local-fixture", password: "a-long-local-fixture-password" }) });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0]; const login = await setup.json(); csrf = login.csrfToken;
    const denied = await fetch(base + "/api/local-agent/ticket", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ instance: "a".repeat(32) }) });
    assert.equal(denied.status, 403, "login tickets still require CSRF");
    const once = await api("/local-agent/ticket", "POST", { instance: "a".repeat(32) });
    assert.equal((await fetch(base + "/api/local-agent/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(once) })).status, 200);
    assert.equal((await fetch(base + "/api/local-agent/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(once) })).status, 401);
    const ticket = await api("/events", "POST", {});
    const eventsSocket = new WebSocket(base.replace("http:", "ws:") + "/api/events?ticket=" + ticket.ticket, { headers: { cookie, origin: base } });
    sockets.push(eventsSocket);
    bridge = new LocalAgentBridge(api, login.user.id, (value) => online = value);
    eventsSocket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()); events.push(event);
      if (event.type === "local_agent_request") {
        bridge!.forward(event.data);
        if (dropNext && event.data.op === "exec") {
          dropNext = false;
          void until(async () => existsSync(join(clientDir, "loss.txt"))).then(() => (bridge as any).socket.close());
        }
      }
    });
    await until(() => events.some((e) => e.type === "ready"));
    const serverSession = await api("/sessions", "POST", { cwd: serverDir });
    assert.equal(serverSession.localAgent, false);
    assert.equal(serverSession.cwd, serverDir);
    await assert.rejects(api("/sessions", "POST", { localAgent: true }), /客户端未连接/);
    await bridge.connect(); await until(() => online);
    assert.equal((await api("/sessions/" + serverSession.id)).session.localAgent, false, "connecting must not migrate existing sessions");
    const explicitServer = await api("/sessions", "POST", { cwd: serverDir, localAgent: false });
    assert.equal(explicitServer.localAgent, false);
    assert.equal(explicitServer.cwd, serverDir);
    await assert.rejects(api("/sessions", "POST", { localAgent: "client" }), /Invalid execution mode/);
    const switched = await api("/sessions/" + serverSession.id + "/execution", "POST", { localAgent: true });
    assert.equal(switched.localAgent, true); assert.equal(switched.cwd, clientDir);
    const restored = await api("/sessions/" + serverSession.id + "/execution", "POST", { localAgent: false });
    assert.equal(restored.localAgent, false); assert.equal(restored.cwd, serverDir);
    await api("/config", "PUT", { model: "test/m", provider: { test: { api: "openai-completions", baseURL: "http://127.0.0.1:" + (mock.address() as any).port, models: { m: { limit: { context: 128000, output: 1000 } } } } } });
    await api("/sessions/" + serverSession.id + "/messages", "POST", { text: "write server execution fixture after connecting" });
    await until(() => events.some((e) => e.type === "done" && e.session === serverSession.id));
    assert.match(await readFile(join(serverDir, "from-client.txt"), "utf8"), /local-success/);
    assert.equal(existsSync(join(clientDir, "from-client.txt")), false, "the old server session must not write on the newly connected client");
    events.length = 0;
    await api("/sessions/" + serverSession.id + "/execution", "POST", { localAgent: true });
    await api("/sessions/" + serverSession.id + "/messages", "POST", { text: "write client execution fixture after a manual switch" });
    await until(() => events.some((e) => e.type === "done" && e.session === serverSession.id));
    assert.match(await readFile(join(clientDir, "from-client.txt"), "utf8"), /local-success/);
    await api("/sessions/" + serverSession.id + "/execution", "POST", { localAgent: false });
    events.length = 0;
    const session = await api("/sessions", "POST", {});
    assert.equal(session.localAgent, true); assert.equal(session.cwd, clientDir);
    await api("/sessions/" + session.id + "/messages", "POST", { text: "write fixture" });
    await until(() => events.some((e) => e.type === "done" && e.session === session.id));
    assert.match(await readFile(join(clientDir, "from-client.txt"), "utf8"), /local-success/);
    events.length = 0;
    dropNext = true;
    await api("/sessions/" + session.id + "/messages", "POST", { text: "loss fixture" });
    await until(() => events.some((e) => e.type === "done" && e.session === session.id));
    const paused = await api("/sessions/" + session.id);
    assert.match(paused.messages.at(-1).text, /本轮已暂停/);
    assert.equal((await readFile(join(clientDir, "loss.txt"), "utf8")).trim(), "once");
    const callsAtPause = modelCalls;
    await sleep(100);
    assert.equal(modelCalls, callsAtPause, "must not ask the model to retry while user repairs the client");
    await until(() => online);
    events.length = 0;
    await api("/sessions/" + session.id + "/messages", "POST", { text: "continue after repair" });
    await until(() => events.some((e) => e.type === "done" && e.session === session.id));
    assert.equal((await readFile(join(clientDir, "loss.txt"), "utf8")).trim(), "once", "reconnect must not replay the original mutation");
  } finally {
    bridge?.close(); globalThis.WebSocket = original;
    for (const socket of sockets) socket.terminate();
    for (const child of [client, backend]) { child.kill(); if (child.exitCode === null) await new Promise<void>((yes) => child.once("exit", () => yes())); }
    await new Promise<void>((yes) => mock.close(() => yes()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
