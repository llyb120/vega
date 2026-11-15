import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { Store } from "../server/core/store";
import { chatHistory } from "../server/core/chat-page";
import { storeAttachments } from "../server/core/attachments";
import { clientSettings } from "../server/core/client-settings";

const route = readFileSync("server/routes/api/[...path].ts", "utf8");
const fragment = route.slice(route.indexOf("async function clientChat("), route.indexOf("/** 群聊 (groups.ts)"));
const code = ts.transpileModule(fragment, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const check = (ok: any, statusCode: number, message: string) => { if (!ok) throw Object.assign(Error(message), { statusCode }); };
async function fixture(t: any, role = "admin") {
  const store = await Store.open(":memory:");
  t.after(() => store.close());
  const session = await store.newSession({ ownerId: "u1" });
  const submitted: any[] = [], created: any[] = [], controlled: any[] = [];
  const employee: any = { employeeId: "e1", accessible: async (user: any) => user.id === "u1", manageable: async (user: any) => user.id === "u1" && user.role !== "viewer", chat: async () => session, state: async () => ({ name: "Bot", instruction: "stay", tasks: [] as { id: string; status: string }[] }), profile: async () => ({ id: "e1", name: "Bot", instruction: "stay" }), control: async (...args: any[]) => { controlled.push(args); return { ok: true }; } };
  const engine: any = { active: new Map(), employee: { all: async () => [employee], create: async (input: any, owner: string) => { created.push([input, owner]); return { id: "e2" }; } }, submitChat: async (...args: any[]) => { submitted.push(args); } };
  const app = () => ({ engine, store, auth: { user: async (id: string) => ({ id, role, username: id }) } });
  const inputMessage = async (input: any, store: Store, id: string) => {
    assert(input.text?.trim() || input.images?.length || input.files?.length);
    return { role: "user", text: input.text || "", ...await storeAttachments(store, id, input) };
  };
  const call = new Function("app", "assert", "check", "chatHistory", "inputMessage", "createHash", "clientSettings", code + "\nreturn clientChat;")(app, assert, check, chatHistory, inputMessage, createHash, clientSettings);
  return { store, session, submitted, created, controlled, engine, employee, call: (op: string, body: any, user = "u1") => call(op, body, user) };
}

test("native chat preserves backwards pagination and incremental server cursors", async t => {
  const f = await fixture(t);
  for (let seq = 1; seq <= 5; seq++) await f.store.append(f.session.id, { role: "assistant", text: "m" + seq });
  const page = await f.call("messages", { thread: "employee:e1", before: 5, limit: 2 });
  assert.deepEqual(page.messages.map((m: any) => m.seq), [3, 4]);
  assert.equal(page.hasMore, true);
  const tail = await f.call("messages", { thread: "employee:e1", after: 4 });
  assert.equal(tail.lastSeq, 5);
  assert.deepEqual(tail.messages.map((m: any) => m.seq), [5]);
  await assert.rejects(f.call("messages", { thread: "employee:e1" }, "u2"), /Employee not found/);
  await assert.rejects(f.call("messages", { thread: "invalid:e1" }), /Invalid thread/);
});

test("native send forwards attachments, actor and a content-bound nonce to the existing idempotent queue", async t => {
  const f = await fixture(t), nonce = "n".repeat(32);
  await f.call("send", { thread: "employee:e1", text: "", clientMessageId: nonce, files: [{ name: "notes.txt", mime: "text/plain", data: "aGVsbG8=" }] });
  const [session, input] = f.submitted[0];
  assert.equal(session, f.session.id);
  assert.equal(input.actorId, "u1");
  assert.equal(input.clientMessageId, nonce);
  assert.match(input.clientMessageHash, /^[a-f\d]{64}$/);
  assert.equal(Buffer.from((await f.store.blobData(input.files[0].blobId))!.data).toString(), "hello");
  await assert.rejects(f.call("send", { thread: "employee:e1", text: "bad nonce", clientMessageId: "bad" }), /Invalid message nonce/);
  assert.equal(f.submitted.length, 1);
});

test("viewer devices can read and mark seen, but cannot create, send or control", async t => {
  const f = await fixture(t, "viewer");
  await f.call("messages", { thread: "employee:e1" });
  await f.call("read", { thread: "employee:e1" });
  for (const [op, body] of [["create", { name: "Bot" }], ["send", { thread: "employee:e1", text: "denied" }], ["control", { thread: "employee:e1", action: "stop", id: "t1" }]] as const)
    await assert.rejects(f.call(op, body), (error: any) => error.statusCode === 403);
  assert.equal(f.created.length + f.submitted.length + f.controlled.length, 0);
});

test("native messages expose the live turn and current task status without changing history cursors", async t => {
  const f = await fixture(t);
  f.engine.live = { snapshot: (id: string) => id === f.session.id ? { at: 5, text: "partial", thinking: "", progress: "", tools: [] } : null };
  f.employee.state = async () => ({ name: "Bot", instruction: "stay", tasks: [{ id: "t1", status: "approval" }] });
  const page = await f.call("messages", { thread: "employee:e1" });
  assert.equal(page.live.text, "partial");
  assert.equal(page.taskStatus.t1, "approval");
  assert.deepEqual(page.messages.map((m: any) => m.seq), []);
});

test("native settings load is on the chat route and a viewer cannot save", async t => {
  const f = await fixture(t, "viewer");
  const loaded = await f.call("settings", { action: "load" });
  assert.equal(loaded.viewer, true);
  assert.equal(loaded.admin, false);
  assert.equal(loaded.employees[0].instruction, "stay");
  assert.equal(loaded.employees[0].canManage, false);
  assert.equal("scenes" in loaded, false);
  await assert.rejects(f.call("settings", { action: "employee", employeeId: "e1", instruction: "changed" }), (error: any) => error.statusCode === 403);
  await assert.rejects(f.call("settings", { action: "workspace", scenes: {}, scheduler: {} }), (error: any) => error.statusCode === 403);
  assert.equal(f.controlled.length, 0);
});

test("native bot creation uses employee validation and controls retain the authenticated owner", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.call("create", { name: " New Bot ", instruction: "Be useful" }), { id: "e2" });
  assert.deepEqual(f.created, [[{ name: "New Bot", instruction: "Be useful" }, "u1"]]);
  await assert.rejects(f.call("create", { name: "x".repeat(81) }), /1–80/);
  await assert.rejects(f.call("create", { name: "Bot", instruction: "x".repeat(8001) }), /8000/);
  await f.call("control", { thread: "employee:e1", action: "approve", id: "t1", approved: false });
  assert.equal(f.controlled[0][1].token, "u1");
});
