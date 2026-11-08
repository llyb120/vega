import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { LocalAgentPairing } from "../web/src/local-agent.js";
import { sleep } from "../server/core/util";

test("native client pairs once, runs with every webpage closed, survives restarts and never replays lost operations", {
  skip: process.env.VEGA_TEST_LOCAL_AGENT !== "1", timeout: 90000,
}, async (t) => {
  const binary = resolve("local", process.platform === "win32" ? "vega-local.exe" : "vega-local");
  assert(existsSync(binary), "Build the updated native client first");
  const reserved = tcpServer();
  try { await new Promise<void>((yes, no) => { reserved.once("error", no); reserved.listen(47673, "127.0.0.1", yes); }); }
  catch { t.skip("Local client port is in use; do not interfere with a user's client"); return; }
  await new Promise<void>((yes) => reserved.close(() => yes()));
  const dir = await mkdtemp(join(tmpdir(), "vega-native-e2e-"));
  const clientDir = join(dir, "client"), serverDir = join(dir, "server"), configDir = join(dir, "config");
  await mkdir(clientDir); await mkdir(serverDir); await mkdir(join(configDir, "vega-local"), { recursive: true });
  const reserve = createServer();
  await new Promise<void>((yes) => reserve.listen(0, "127.0.0.1", yes));
  const port = (reserve.address() as any).port;
  await new Promise<void>((yes) => reserve.close(() => yes()));
  const base = "http://127.0.0.1:" + port, setupToken = randomBytes(32).toString("base64url");
  await writeFile(join(configDir, "vega-local", "trusted-sites.json"), JSON.stringify({ trustedOrigins: [base] }));
  // >1 MiB once base64-encoded, so the client must post it to /api/local-agent/result instead of the socket.
  await writeFile(join(clientDir, "large.txt"), "x".repeat(900000));
  let modelCalls = 0;
  const mock = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelCalls++;
    const latest = [...body.messages].reverse().find((m: any) => m.role === "user")?.content;
    const hasTool = body.messages.at(-1)?.role === "tool", loss = String(latest).includes("loss fixture");
    const command = process.platform === "win32"
      ? (loss ? "Add-Content -LiteralPath loss.txt -Value once; Start-Sleep -Seconds 10" : "Set-Content -LiteralPath from-client.txt -Value local-success")
      : (loss ? "printf 'once\\n' >> loss.txt; sleep 10" : "printf 'local-success\\n' > from-client.txt");
    const tool = String(latest).includes("large fixture") ? { name: "read", arguments: JSON.stringify({ path: "large.txt" }) } : { name: "bash", arguments: JSON.stringify({ command, timeout: 20 }) };
    const delta = hasTool || String(latest).includes("continue after repair")
      ? { content: "verified completion" }
      : { tool_calls: [{ index: 0, id: "fixture-" + modelCalls, function: tool }] };
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((yes) => mock.listen(0, "127.0.0.1", yes));
  const children: ChildProcess[] = [], sockets: WebSocket[] = [], events: any[] = [];
  let logs = "", cookie = "", csrf = "";
  const backendEnv = { ...process.env, VEGA_DB: join(dir, "app.db"), VEGA_TOKEN: setupToken, VEGA_PUBLIC_URL: base, VEGA_BROWSER_MODE: "", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), VEGA_SKILL_CACHE: join(dir, "skills") };
  const startBackend = () => {
    const child = spawn(process.execPath, [resolve(".output/server/index.mjs")], { windowsHide: true, stdio: "pipe", env: backendEnv });
    child.stdout!.on("data", (b) => logs += b); child.stderr!.on("data", (b) => logs += b);
    children.push(child); return child;
  };
  const startClient = () => {
    const child = spawn(binary, [], { cwd: clientDir, windowsHide: true, stdio: "ignore", env: { ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir } });
    children.push(child); return child;
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(); await new Promise<void>((yes) => child.once("exit", () => yes()));
  };
  let backend = startBackend(), client = startClient();
  const api = async (path: string, method = "GET", data?: any) => {
    const r = await fetch(base + "/api" + path, { method, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await r.json(); if (!r.ok) throw Error(JSON.stringify(value)); return value;
  };
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 600; i++) { if (await condition()) return; await sleep(20); }
    throw Error("Native client fixture timed out: " + logs);
  };
  const run = async (id: string, text: string) => {
    const before = (await api("/sessions/" + id)).messages.length;
    await api("/sessions/" + id + "/messages", "POST", { text });
    await until(async () => { const value = await api("/sessions/" + id); return !value.running && value.messages.length > before && value.messages.at(-1)?.role === "assistant"; });
    return api("/sessions/" + id);
  };
  const original = globalThis.WebSocket;
  class LocalSocket extends WebSocket {
    constructor(url: string) { super(url, { headers: { origin: base } }); sockets.push(this); }
  }
  globalThis.WebSocket = LocalSocket as any;
  let pairing: LocalAgentPairing | undefined;
  try {
    await until(async () => { try { return (await fetch(base + "/api/auth/me")).ok; } catch { return false; } });
    const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken, username: "native-fixture", password: "a-long-native-fixture-password" }) });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0]; const login = await setup.json(); csrf = login.csrfToken;
    const cookieAge = Number(/Max-Age=(\d+)/i.exec(setup.headers.get("set-cookie")!)?.[1]);
    assert(cookieAge >= 604790 && cookieAge <= 604800);
    const denied = await fetch(base + "/api/local-agent/ticket", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ instance: "a".repeat(32) }) });
    assert.equal(denied.status, 403);
    const ticket = await api("/events", "POST", {});
    const webpage = new WebSocket(base.replace("http:", "ws:") + "/api/events?ticket=" + ticket.ticket, { headers: { cookie, origin: base } });
    sockets.push(webpage); webpage.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    await until(() => events.some((event) => event.type === "ready"));
    const serverSession = await api("/sessions", "POST", { cwd: serverDir });
    const pairingStates: any[] = [];
    pairing = new LocalAgentPairing(api, login.user.id, (status) => pairingStates.push(status));
    await pairing.connect(); await until(() => !!(pairing as any).paired);
    assert.equal(pairingStates.at(-1).code, "connected", JSON.stringify(pairingStates));
    assert(pairingStates.some((status) => status.code === "authorizing"));
    assert(pairingStates.some((status) => status.code === "backend_connecting"));
    await until(async () => (await api("/bootstrap")).clients.length === 1);
    const device = (await api("/bootstrap")).clients[0];
    assert.equal((await api("/sessions/" + serverSession.id)).session.localAgent, false);
    pairing.close(); webpage.terminate();
    assert.equal(sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length, 0, "all frontend sockets are closed");
    await api("/config", "PUT", { model: "test/m", provider: { test: { api: "openai-completions", baseURL: "http://127.0.0.1:" + (mock.address() as any).port, models: { m: { limit: { context: 128000, output: 1000 } } } } } });
    await run(serverSession.id, "write server fixture");
    assert.match(await readFile(join(serverDir, "from-client.txt"), "utf8"), /local-success/);
    assert.equal(existsSync(join(clientDir, "from-client.txt")), false);
    const session = await api("/sessions", "POST", { localAgent: true, clientId: device.id });
    await run(session.id, "write fixture with the webpage closed");
    assert.match(await readFile(join(clientDir, "from-client.txt"), "utf8"), /local-success/);
    const large = await run(session.id, "large fixture with the webpage closed");
    assert(large.messages.some((item: any) => item.name === "read" && !item.error), "direct socket supports file results larger than the website RPC limit");
    assert.equal(events.some((event) => event.type === "local_agent_request"), false);
    await stop(client); client = startClient();
    await until(async () => (await api("/bootstrap")).clients.some((item: any) => item.id === device.id));
    await run(session.id, "write fixture after native restart without pairing again");
    await stop(backend); backend = startBackend();
    await until(async () => { try { return (await api("/bootstrap")).clients.some((item: any) => item.id === device.id); } catch { return false; } });
    await run(session.id, "write fixture after backend restart without a webpage");
    await api("/sessions/" + session.id + "/messages", "POST", { text: "loss fixture" });
    await until(() => existsSync(join(clientDir, "loss.txt")));
    await api("/local-agent/revoke", "POST", { clientId: device.id });
    await until(async () => !(await api("/sessions/" + session.id)).running);
    assert.match((await api("/sessions/" + session.id)).messages.at(-1).text, /本轮已暂停/);
    assert.equal((await readFile(join(clientDir, "loss.txt"), "utf8")).trim(), "once");
    const callsAtPause = modelCalls;
    await sleep(100);
    assert.equal(modelCalls, callsAtPause);
    await until(async () => (await api("/bootstrap")).clients.length === 0);
    pairing = new LocalAgentPairing(api, login.user.id);
    await pairing.connect(); await until(() => !!(pairing as any).paired);
    await until(async () => (await api("/bootstrap")).clients.some((item: any) => item.id === device.id));
    pairing.close();
    await run(session.id, "continue after repair");
    assert.equal((await readFile(join(clientDir, "loss.txt"), "utf8")).trim(), "once", "a renewed device credential must never replay the old mutation");
  } finally {
    pairing?.close(); globalThis.WebSocket = original;
    for (const socket of sockets) socket.terminate();
    for (const child of children) await stop(child);
    await new Promise<void>((yes) => mock.close(() => yes()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
