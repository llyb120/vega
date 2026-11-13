import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { Auth } from "../server/core/auth";
import { ATTACHMENT_BYTES } from "../server/core/attachments";
import { Redactor } from "../server/core/util";

const owner = { id: "u1", role: "operator" } as any;
const guest = { id: "u2", role: "operator" } as any;
const outsider = { id: "u3", role: "operator" } as any;
const clientId = "d".repeat(32);

async function fixture(t: TestContext, client = false) {
  const cwd = await mkdtemp(join(tmpdir(), "vega-step-files-"));
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { limit: { context: 128000, output: 8192 } } } } } });
  for (const user of [owner, guest, outsider]) await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", user.id, user.id, "x", "operator", 0, Date.now(), 0);
  const employee = await engine.employee.for((await engine.employee.create({ name: "Builder", cwd }, owner.id)).id);
  const chat = await employee.chat(owner.id);
  const created = await employee.execute("", { action: "add", kind: "todo", text: "生成步骤产物并继续" });
  if (client) engine.localAgents.connect(owner.id, { clientId, instance: "a".repeat(32), name: "本机", cwd: "C:\\work", platform: "windows" });
  const session = await store.newSession({ employeeId: employee.employeeId, taskId: created.value.id, ownerId: owner.id, cwd: client ? "C:\\work" : cwd, scene: "lightweight", ...(client ? { localAgent: true, clientId, localPlatform: "windows" } : {}) });
  await employee.update((state) => { Object.assign(employee.task(state, created.value.id), { status: "running", workSession: session.id, plan: [{ content: "生成可交付产物", status: "completed" }, { content: "继续工作", status: "in_progress" }] }); });
  employee.busy.set(created.value.id, { session: session.id, computer: false });
  const tools = await Tools.create(engine, session, await engine.config(), new AbortController().signal, () => {});
  const auth = new Auth(store, "fixture-token-at-least-16-bytes");
  let seq = 0;
  const invoke = async (stepOutput: any) => {
    const call = { id: "output-" + ++seq, name: "task_progress", arguments: { message: "产物已生成，继续工作", stepOutput } };
    await store.append(session.id, { role: "assistant", model: "fixture/model", text: "", calls: [call] });
    return { call, result: await tools.execute(call, {} as any) };
  };
  t.after(async () => { employee.busy.clear(); await engine.close(); await store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, store, engine, employee, chat, session, job: created.value.id, tools, auth, invoke };
}

test("生成文件作为独立产物保存快照，工作继续且重复回执不会重复发文件", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, "dist"));
  const path = join(f.cwd, "dist", "build.zip"), original = Buffer.from([0, 1, 2, 255, 42]);
  await writeFile(path, original);
  const { call, result } = await f.invoke({ step: 1, paths: ["dist/build.zip"] });
  assert.equal(result.value.stepOutput.duplicate, false);
  const task = (await f.employee.findTask(f.job))!;
  assert.equal(task.status, "running");
  assert.equal(task.stepOutputs.length, 1);
  const output = task.stepOutputs[0], file = output.files[0];
  assert.equal(output.text, "", "仅交付文件时不把同条助手消息当作产物文本");
  assert.deepEqual([file.name, file.size, file.mime], ["build.zip", original.length, "application/octet-stream"]);
  const message = (await f.store.messages(f.chat.id)).find((item) => item.stepOutput)!;
  assert.equal(message.text, "产物已生成，继续工作");
  assert.equal(typeof message.stepOutput === "object" && message.stepOutput.files?.[0].blobId, file.blobId);
  assert(await f.auth.canBlob(owner, file.blobId));
  assert(!await f.auth.canBlob(outsider, file.blobId));
  await writeFile(path, "later change");
  assert.deepEqual(Buffer.from((await f.store.blobData(file.blobId))!.data), original, "原文件变化后下载仍是交付时的快照");
  await writeFile(path, original);
  assert.equal((await f.tools.execute(call, {} as any)).value.stepOutput.duplicate, true);
  assert.equal((await f.employee.findTask(f.job))!.stepOutputs.length, 1);
  assert.equal((await f.store.messages(f.chat.id)).filter((item) => item.stepOutput).length, 1);
});

test("独立文本产物能在明确引用时成为最终正文", async (t) => {
  const f = await fixture(t);
  const { result } = await f.invoke({ step: 1, text: "独立步骤方案" });
  await f.employee.update((state) => { f.employee.task(state, f.job).plan[1].status = "completed"; });
  await f.employee.execute(f.job, { action: "complete", text: "工作已验证", summary: "已完成", deliverableRef: [result.value.stepOutput.ref] });
  assert.equal((await f.employee.findTask(f.job))!.deliverable, "独立步骤方案");
});

test("产物只读取工作区内普通文件，拒绝常见凭据、超限及本轮凭据，不留下半成品", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "safe.txt"), "safe");
  await writeFile(join(f.cwd, ".env"), "private");
  const large = await open(join(f.cwd, "large.bin"), "w");
  await large.truncate(ATTACHMENT_BYTES + 1); await large.close();
  await assert.rejects(f.invoke({ step: 1, paths: ["../outside"] }));
  await assert.rejects(f.invoke({ step: 1, paths: [".env"] }), /凭据文件/);
  await assert.rejects(f.invoke({ step: 1, paths: ["large.bin"] }), /25MiB/);
  const outside = await mkdtemp(join(tmpdir(), "vega-step-outside-"));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(outside, "secret.txt"), "outside");
  try {
    await symlink(join(outside, "secret.txt"), join(f.cwd, "link.txt"));
    await assert.rejects(f.invoke({ step: 1, paths: ["link.txt"] }), /within the working directory/);
  } catch (error: any) { if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error; }
  const redactor = new Redactor(); redactor.add("private-test-token"); f.engine.redactors.set(f.session.id, redactor);
  await writeFile(join(f.cwd, "safe.txt"), "artifact private-test-token");
  await assert.rejects(f.invoke({ step: 1, paths: ["safe.txt"] }), /含有本轮凭据/);
  await assert.rejects(f.invoke({ step: 1, text: "private-test-token" }), /密码本凭据/);
  assert.equal((await f.employee.findTask(f.job))!.stepOutputs, undefined);
  assert.equal(Number((await f.store.one("SELECT count(*) n FROM blobs"))!.n), 0);
  assert(!(await f.store.messages(f.chat.id)).some((message) => message.stepOutput));
});

test("客户端产物在绑定客户端校验后读取，不静默改用服务端文件", async (t) => {
  const f = await fixture(t, true), operations: string[] = [];
  (f.engine.localAgents as any).request = async (_agent: unknown, op: string, args: any) => {
    assert.equal(op, "file"); operations.push(args.op);
    if (args.op === "read_workspace") return { path: "C:\\work\\dist\\agent.zip", content: Buffer.from("client bytes").toString("base64") };
    throw Error("unexpected operation");
  };
  const { result } = await f.invoke({ step: 1, paths: ["dist/agent.zip"] });
  assert.equal(result.value.ok, true);
  assert.deepEqual(operations, ["read_workspace"]);
  const file = (await f.employee.findTask(f.job))!.stepOutputs[0].files[0];
  assert.equal(file.name, "agent.zip");
  assert.equal(Buffer.from((await f.store.blobData(file.blobId))!.data).toString(), "client bytes");
  (f.engine.localAgents as any).request = async () => ({ error: "Unknown file operation" });
  await assert.rejects(f.invoke({ step: 2, paths: ["dist/agent.zip"] }), /升级客户端/);
  assert.equal((await f.employee.findTask(f.job))!.stepOutputs.length, 1, "旧客户端不退回到不安全的两次读取");
  f.engine.localAgents.disconnect(owner.id, "a".repeat(32));
  const unavailable = await f.invoke({ step: 2, paths: ["dist/agent.zip"] });
  assert.equal(unavailable.result.error, true);
  assert.equal((await f.employee.findTask(f.job))!.stepOutputs.length, 1);
});

test("云端隔离文件按租户文件系统读取", async (t) => {
  const f = await fixture(t), calls: string[] = [];
  await writeFile(join(f.cwd, "artifact.txt"), "cloud result");
  const fs = await import("node:fs/promises");
  (f.tools as any).cloud = { fs: {
    realpath: async (path: string) => { calls.push("realpath"); return fs.realpath(path); },
    stat: async (path: string) => { calls.push("stat"); return fs.stat(path); },
    readFile: async (path: string) => { calls.push("readFile"); return fs.readFile(path); },
  } };
  await f.invoke({ step: 1, paths: ["artifact.txt"] });
  assert(calls.includes("realpath") && calls.includes("stat") && calls.includes("readFile"));
  const file = (await f.employee.findTask(f.job))!.stepOutputs[0].files[0];
  assert.equal(Buffer.from((await f.store.blobData(file.blobId))!.data).toString(), "cloud result");
});

test("群成员只取得本群产物文件；原生客户端下载同样校验 blob 权限", async (t) => {
  const f = await fixture(t);
  const group = await f.engine.groups.create(owner, { name: "产物群", users: [guest.id], employees: [f.employee.employeeId] });
  await f.employee.update((state) => { f.employee.task(state, f.job).group = { groupId: group.id, name: "产物群", hop: 0, requester: { kind: "user", id: guest.id, name: "u2" }, byOwner: false }; });
  await writeFile(join(f.cwd, "output.bin"), Buffer.from([1, 2, 255]));
  await f.invoke({ step: 1, text: "单独说明", paths: ["output.bin"] });
  const groupSession = (await f.engine.groups.get(group.id))!.session;
  const message = (await f.store.messages(groupSession)).find((row) => row.stepOutput)!;
  assert.equal(message.text, "产物已生成，继续工作");
  assert.equal(typeof message.stepOutput === "object" && message.stepOutput.text, "单独说明");
  const file = (message.stepOutput as any).files[0];
  assert(await f.auth.canBlob(guest, file.blobId));
  assert(!await f.auth.canBlob(outsider, file.blobId));
  const shared = (await f.engine.groups.tasks(guest, group.id)).members.find((m) => m.id === f.employee.employeeId)!.tasks[0] as any;
  assert.equal(shared.stepOutputs[0].files[0].blobId, file.blobId);
  assert.equal(shared.stepOutputs[0].session, undefined);
  assert.equal(shared.stepOutputs[0].fingerprint, undefined);
  const source = await readFile("server/routes/api/[...path].ts", "utf8");
  const fragment = source.slice(source.indexOf("async function clientChat("), source.indexOf("/** 群聊 (groups.ts)"));
  const javascript = ts.transpileModule(fragment, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const clientChat = new Function("app", "assert", "ATTACHMENT_BYTES", javascript + "\nreturn clientChat;")(() => ({ engine: f.engine, store: f.store, auth: f.auth }), assert, ATTACHMENT_BYTES);
  const response = await clientChat("file", { blobId: file.blobId }, guest.id);
  assert.deepEqual(Buffer.from(response.data, "base64"), Buffer.from([1, 2, 255]));
  await assert.rejects(clientChat("file", { blobId: file.blobId }, outsider.id), /File not found/);
  await assert.rejects(clientChat("file", { blobId: "../other" }, owner.id), /File not found/);
  await f.engine.groups.removeUser(owner, group.id, guest.id);
  assert(!await f.auth.canBlob(guest, file.blobId), "退出群聊后不能继续下载群产物");
  await assert.rejects(clientChat("file", { blobId: file.blobId }, guest.id), /File not found/);
});
