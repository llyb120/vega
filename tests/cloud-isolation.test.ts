import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CloudRuntime, cloudFor, within } from "../server/core/cloud";
import { Store } from "../server/core/store";
import { Tools, shell } from "../server/core/tools";
import { LocalAgents } from "../server/core/local-agent";
import { encode, decode, frames, send } from "../shared/cloud-wire.mjs";
import { validateOwner, tenantEnvironment, serviceEnvironment } from "../docker/cloud-supervisor.mjs";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { resolveModel } from "../server/core/config";

test("dropping the service UID also changes its HOME without losing configured provider settings", () => {
  const env = serviceEnvironment({ HOME: "/root", USER: "root", LOGNAME: "root", VEGA_TOKEN: "service-only", DEVIN_CONFIG_HOME: "/data/devin" });
  assert.deepEqual(env, { HOME: "/home/node", USER: "node", LOGNAME: "node", VEGA_TOKEN: "service-only", DEVIN_CONFIG_HOME: "/data/devin" });
});

test("cloud identities reject path/UID injection and do not inherit controller credentials", () => {
  for (const owner of ["", "../bob", "root/../bob", "a\0b", {}, 1000]) assert.throws(() => validateOwner(owner));
  validateOwner("u_abcd-123");
  const before = process.env.VEGA_TOKEN;
  process.env.VEGA_TOKEN = "controller-only";
  try {
    const env = tenantEnvironment({ home: "/private/home", name: "vega_u10001", tmp: "/private/tmp" });
    assert.equal((env as any).VEGA_TOKEN, undefined);
    assert.equal(env.HOME, "/private/home");
    assert.equal(env.TMPDIR, "/private/tmp");
    assert.throws(() => tenantEnvironment({ home: "/a", name: "a", tmp: "/t" }, { "bad=name": "x" }));
  } finally { if (before === undefined) delete process.env.VEGA_TOKEN; else process.env.VEGA_TOKEN = before; }
  assert.equal(within(resolve("a"), resolve("ab")), false);
  assert.equal(within(resolve("a"), resolve("a", "..", "b")), false);
});

test("cloud tools route all filesystem access by owner, preserve edits, and fail closed without an executor", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "vega-cloud-unit-"));
  const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\vega-cloud-" + randomUUID() : join(root, "executor.sock");
  const ids = Object.fromEntries(["alice", "bob"].map((owner, i) => [owner, { owner, uid: 10001 + i, name: "vega_u" + (10001 + i), home: join(root, owner), cwd: join(root, owner, "workspace"), tmp: join(root, owner, "tmp") }]));
  for (const identity of Object.values(ids)) await fs.mkdir(identity.cwd, { recursive: true });
  const protectedFile = join(root, "controller-secret");
  await fs.writeFile(protectedFile, "must not be read directly");
  const calls: any[] = [], sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let echo = false;
    frames(socket, (message: any) => {
      if (echo && message.fd === 0) {
        if (message.end) { send(socket, { exit: 0 }); socket.end(); }
        else send(socket, { fd: 1, data: message.data });
        return;
      }
      const request = decode(message); calls.push(request);
      void (async () => {
        const identity = ids[request.owner];
        assert(identity, "owner required");
        if (request.kind === "ensure") { send(socket, { identity }); return socket.end(); }
        if (request.kind === "exec" && request.command === "/mock/echo") { echo = true; send(socket, { ready: true }); return; }
        if (request.kind === "exec") { send(socket, { fd: 1, data: Buffer.from(request.owner + ":executed").toString("base64") }); send(socket, { exit: 0 }); return socket.end(); }
        assert.equal(request.kind, "fs");
        for (const arg of request.args.slice(0, ["rename", "cp"].includes(request.method) ? 2 : 1)) {
          if (!within(identity.home, resolve(arg))) throw Object.assign(Error("permission denied"), { code: "EACCES" });
        }
        let value = await (fs as any)[request.method](...request.args);
        if (["stat", "lstat"].includes(request.method)) value = { size: value.size, mode: value.mode, file: value.isFile(), directory: value.isDirectory(), symlink: value.isSymbolicLink() };
        send(socket, { fd: 1, data: Buffer.from(JSON.stringify({ value: encode(value) })).toString("base64") }); send(socket, { exit: 0 }); socket.end();
      })().catch((error) => { send(socket, { error: error.message, code: error.code }); socket.end(); });
    });
  });
  await new Promise<void>((yes) => server.listen(socketPath, yes));
  const old = { mode: process.env.VEGA_CLOUD_ISOLATION, socket: process.env.VEGA_CLOUD_SOCKET, exec: process.env.VEGA_CLOUD_EXEC };
  process.env.VEGA_CLOUD_ISOLATION = "1"; process.env.VEGA_CLOUD_SOCKET = socketPath;
  process.env.VEGA_CLOUD_EXEC = resolve("docker/cloud-exec.mjs");
  const store = await Store.open(":memory:"), hub = new LocalAgents();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((yes) => server.close(() => yes()));
    hub.close(); await store.close(); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of [["VEGA_CLOUD_ISOLATION", old.mode], ["VEGA_CLOUD_SOCKET", old.socket], ["VEGA_CLOUD_EXEC", old.exec]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  assert.throws(() => cloudFor({}), /所属用户/);
  assert.equal(cloudFor({ localAgent: true }), undefined);
  await assert.rejects(store.newSession({}), /所属用户/);
  const session = await store.newSession({ ownerId: "alice", scene: "coding" });
  assert.equal(session.cwd, ids.alice.cwd);
  await assert.rejects(store.newSession({ ownerId: "alice", cwd: ids.bob.cwd }), /私有工作区/);
  const tools = await Tools.create({ store, localAgents: hub, mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  await tools.execute({ id: "w", name: "write", arguments: { path: "test.txt", content: "before\n" } }, {} as any);
  await tools.execute({ id: "e", name: "edit", arguments: { path: "test.txt", edits: [{ oldText: "before", newText: "after" }] } }, {} as any);
  assert.match((await tools.read({ path: "test.txt" })).value.text, /after/);
  await store.saveSession({ ...session, id: "bob-archive", ownerId: "bob", cwd: ids.bob.cwd });
  const foreignBlob = await store.blob("image/png", Buffer.from("private-bob-image"));
  await store.grantBlob(foreignBlob, "bob-archive");
  await assert.rejects(tools.read({ path: "sqlite:blob/" + foreignBlob }), /not accessible/);
  const ownBlob = await store.blob("image/png", Buffer.from("alice-image"));
  await store.grantBlob(ownBlob, session.id);
  assert.equal((await tools.read({ path: "sqlite:blob/" + ownBlob })).images?.[0].blobId, ownBlob);
  await assert.rejects(tools.read({ path: protectedFile }), { code: "EACCES" });
  await assert.rejects(tools.execute({ id: "escape", name: "change_working_directory", arguments: { path: ids.bob.cwd } }, {} as any), /私有工作区/);
  const result = await shell(session.cwd, { command: "echo harmless", timeout: 5 }, new AbortController().signal, () => {}, new CloudRuntime("alice"));
  assert.equal(result.value.output, "alice:executed");
  const launch = new CloudRuntime("alice").launch("/mock/echo", [], session.cwd);
  const echo = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "pipe" });
  let echoed = "";
  echo.stdout.on("data", (chunk) => { echoed += chunk; });
  echo.stdin.end("MCP stdin roundtrip\n");
  assert.equal(await new Promise((yes, no) => { echo.on("error", no); echo.on("close", yes); }), 0);
  assert.equal(echoed, "MCP stdin roundtrip\n");
  assert(calls.some((request) => request.kind === "exec" && request.owner === "alice"));
  assert(calls.filter((request) => request.kind === "fs").every((request) => request.owner === "alice"));
  await t.test("default employees and legacy communication sessions use private cloud cwd without retargeting tasks or clients", async (sub) => {
    await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", "alice", "alice", "unused-test-password", "admin", 0, 1, 0);
    const config = { model: "fixture/model", provider: { fixture: { baseURL: "https://unused.test", models: { model: {} } } }, scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] } };
    await store.put("config", config);
    const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store)), new Chrome(store, new ChromeBridge(), ""));
    engine.employee.closed = true;
    sub.after(() => engine.close());
    engine.catalog.resolve = async (_config, selection) => resolveModel(config, selection || config.model);
    const initial = await engine.employee.profile();
    assert.equal(initial.ownerId, "alice");
    assert.equal(initial.cwd, ids.alice.cwd, "the built-in employee bypasses create(), but still needs a private default");
    const freshJob = await engine.employee.execute("", { action: "add", kind: "todo", text: "use the private default" });
    assert.equal(engine.employee.task(await engine.employee.state(), freshJob.value.id).cwd, ids.alice.cwd);
    const job = await engine.employee.execute("", { action: "add", kind: "todo", text: "keep the original task binding", cwd: process.cwd() });
    const chat = await engine.employee.chat("alice");
    chat.cwd = process.cwd();
    await store.saveSession(chat);
    await store.append(chat.id, { role: "assistant", text: "keep this earlier reply" });
    await engine.employee.update((state) => { state.cwd = process.cwd(); state.executionCwds = { server: process.cwd() }; });
    const migrated = await engine.employee.profile();
    assert.equal(migrated.cwd, ids.alice.cwd);
    assert.equal(migrated.executionCwds?.server, ids.alice.cwd);
    let prompt = "";
    engine.providers.chat = async (_model, system) => { prompt = system; return { role: "assistant", text: "recovered" }; };
    await engine.run(chat.id, { role: "user", text: "continue chatting" });
    assert.equal((await store.session(chat.id)).cwd, ids.alice.cwd);
    assert(prompt.includes(ids.alice.cwd.replaceAll("\\", "/")));
    assert.equal((await store.lastMessage(chat.id, "assistant"))?.text, "recovered");
    assert((await store.messages(chat.id)).some((message) => message.text === "keep this earlier reply"));
    assert.equal(engine.employee.task(await engine.employee.state(), job.value.id).cwd, process.cwd());
    await assert.rejects(store.newSession({ ownerId: "alice", employeeId: "default", taskId: job.value.id, cwd: process.cwd() }), /私有工作区/);
    const created = await engine.employee.create({ name: "client-bound employee" }, "alice"), employee = await engine.employee.for(created.id);
    employee.closed = true;
    await employee.update((state) => {
      state.cwd = "C:\\client-only";
      state.execution = { prefer: "client" };
      state.executionCwds = { server: process.cwd() };
    });
    const clientChat = await employee.chat("alice");
    assert.equal(clientChat.cwd, ids.alice.cwd, "communication is server-side even when future tasks use a client");
    assert(!clientChat.localAgent);
    const client = await employee.profile();
    assert.equal(client.cwd, "C:\\client-only");
    assert.equal(client.execution?.prefer, "client");
    assert.equal(client.executionCwds?.server, ids.alice.cwd);
    const custom = join(process.cwd(), "custom-project");
    await employee.update((state) => { state.execution = { prefer: "cloud" }; state.cwd = custom; state.executionCwds = { server: custom }; });
    assert.equal((await employee.profile()).cwd, custom, "an explicitly selected legacy project is not silently migrated");
  });
  assert.equal(await fs.readFile(protectedFile, "utf8"), "must not be read directly");
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((yes) => server.close(() => yes()));
  await assert.rejects(tools.read({ path: protectedFile }));
  assert.equal(await fs.readFile(protectedFile, "utf8"), "must not be read directly");
});
