import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Auth } from "../server/core/auth";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { clientChat, clientChatMessage, watchClientChat } from "../server/core/client-chat";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  const auth = new Auth(store, "fixture-setup-token");
  const user = { id: "owner", username: "owner", role: "operator", disabled: false, createdAt: 0, lastLogin: 0 };
  auth.user = async (id) => ({ ...user, id, ...(id === "viewer" ? { role: "viewer" as const } : {}) }) as any;
  const application = { store, engine, auth };
  const call = (op: string, args: any = {}, owner = "owner") => clientChat(application, op, args, owner);
  const close = async () => { await engine.close(); await store.close(); };
  return { store, engine, auth, application, call, close };
}

test("native bot create is owner-scoped, validated and durable against duplicate submissions", async () => {
  const f = await fixture();
  const input = { name: "Vega fixture", instruction: "fixture instructions", avatar: "bot:sparkle:blue", clientNonce: "creation-fixture-0001" };
  try {
    const [a, b] = await Promise.all([f.call("create", input), f.call("create", input)]) as any[];
    assert.equal(a.id, b.id);
    const employee = await f.engine.employee.for(a.id);
    assert.equal((await employee.profile()).instruction, input.instruction);
    assert.equal((await f.call("threads") as any).employees.length, 1);
    assert.equal((await f.call("threads", {}, "other") as any).employees.length, 0);
    await assert.rejects(f.call("create", { ...input, name: "changed" }), /different content/);
    await assert.rejects(f.call("create", { ...input, clientNonce: "short" }), /creation ID/);
    await assert.rejects(f.call("create", { ...input, clientNonce: "creation-fixture-0002", avatar: "http://tracker.test" }), /avatar/);
    await assert.rejects(f.call("create", input, "viewer"), /permission/);
    await f.call("update", { thread: "employee:" + a.id, name: "Renamed", avatar: "bot:round:red" });
    assert.equal((await employee.profile()).name, "Renamed");
    await f.call("update", { thread: "employee:" + a.id, avatar: "bot:wedge:violet" });
    assert.equal((await employee.profile()).avatar, "bot:wedge:violet");
    assert.deepEqual((await f.call("threads") as any).employees[0].botAvatar, { shape: "wedge", color: "violet", hex: "#9b4ff0" });
    await assert.rejects(f.call("update", { thread: "employee:" + a.id, name: "stolen" }, "other"), /not found/);
    await assert.rejects(f.call("cancel", { thread: "employee:" + a.id }, "viewer"), /permission/);
  } finally { await f.close(); }
});

test("native messages share Vega history, pagination, read marks and send deduplication", async () => {
  const f = await fixture();
  try {
    const employee = await f.engine.employee.for((await f.call("create", { name: "Chat", clientNonce: "creation-fixture-chat" }) as any).id);
    const chat = await employee.chat("owner"), thread = "employee:" + employee.employeeId;
    await f.store.append(chat.id, { role: "user", text: "visible" });
    await f.store.append(chat.id, { role: "assistant", text: "reply", thinking: "secret thinking" });
    await f.store.append(chat.id, { role: "tool", text: "secret tool output" });
    const page = await f.call("messages", { thread, limit: 2 }) as any;
    assert.deepEqual(page.messages.map((m: any) => m.text), ["reply"]);
    assert.equal(page.hasMore, true);
    assert.equal((await f.call("threads") as any).employees[0].lastMessageId, "entry-2");
    const hidden = await f.call("messages", { thread, limit: 1 }) as any;
    assert.deepEqual(hidden.messages, []);
    assert.equal(hidden.nextBeforeSeq, 3, "filtered pages still retain a usable history cursor");
    const older = await f.call("messages", { thread, limit: 2, before: 2 }) as any;
    assert.equal(older.messages[0].text, "visible");
    await assert.rejects(f.call("messages", { thread, limit: 501 }), /Invalid limit/);
    await assert.rejects(f.call("messages", { thread }, "other"), /not found/);
    await f.call("read", { thread });
    assert.equal(await f.store.unread("owner", chat.id), 0);
    let launches = 0;
    f.engine.launch = async (id, message) => { launches++; await f.store.append(id, message); };
    const send = { thread, text: "fixture only", clientMessageId: "fixture-message-nonce-001" };
    await Promise.all([f.call("send", send), f.call("send", send)]);
    await f.call("send", send);
    assert.equal(launches, 1);
    assert.equal((await f.call("acceptance", send) as any).record.status, "accepted");
    await assert.rejects(f.call("send", { ...send, text: "different" }), /different content/);
    await assert.rejects(f.call("send", send, "viewer"), /permission/);
    let cancelled = "";
    f.engine.cancel = (id) => { cancelled = id; };
    await f.call("cancel", { thread });
    assert.equal(cancelled, chat.id);
  } finally { await f.close(); }
});

test("native realtime stream carries only visible messages of the authorized chat and detaches cleanly", async () => {
  const f = await fixture();
  try {
    const employee = await f.engine.employee.for((await f.call("create", { name: "Stream", clientNonce: "creation-fixture-stream" }) as any).id);
    const chat = await employee.chat("owner"), thread = "employee:" + employee.employeeId;
    const events: any[] = [];
    const detach = await watchClientChat(f.application, "owner", thread, (event) => events.push(event));
    f.engine.emit({ type: "text_delta", session: "another-chat", data: "private" });
    f.engine.emit({ type: "thinking_delta", session: chat.id, data: "private" });
    f.engine.emit({ type: "message_end", session: chat.id, data: { role: "tool", text: "private" } });
    f.engine.emit({ type: "text_delta", session: chat.id, data: "streamed" });
    f.engine.emit({ type: "message_end", session: chat.id, data: { seq: 1, role: "assistant", text: "answer", thinking: "private", calls: [{ name: "bash" }] } });
    assert.deepEqual(events.map((e) => e.type), ["text_delta", "message"]);
    assert(!JSON.stringify(events).includes("private"));
    f.engine.emit({ type: "message_end", session: chat.id });
    f.engine.emit({ type: "steer", session: chat.id, data: { role: "user", text: "follow-up", clientMessageId: "fixture-follow-up" } });
    assert.deepEqual(events.slice(2).map((e) => e.type), ["history-changed", "history-changed"]);
    detach();
    f.engine.emit({ type: "done", session: chat.id });
    assert.equal(events.length, 4);
    await assert.rejects(watchClientChat(f.application, "other", thread, () => {}), /not found/);
    await f.store.append(chat.id, { role: "assistant", text: "等待你确认：发布", tasks: [{ id: "task-1", title: "发布", status: "waiting" }], delivery: true });
    await f.store.putEmployeeTask(employee.employeeId, "task-1", true, Date.now(), JSON.stringify({ id: "task-1", text: "发布", status: "approval", partialDelivery: "secret-key", createdAt: Date.now() }));
    const live = await f.call("messages", { thread, limit: 20 }) as any;
    const bubble = live.messages.find((message: any) => message.tasks?.[0]?.id === "task-1");
    assert.equal(bubble.tasks[0].status, "approval");
    assert.equal(bubble.tasks[0].partialDelivery, true);
    assert(!JSON.stringify(live).includes("secret-key"));
    assert.equal(clientChatMessage({ role: "user", text: "runtime", runtime: "dynamic" }), null);
    assert.equal(clientChatMessage({ role: "user", text: "follow-up", runtime: "steer", clientMessageId: "fixture-follow-up" })?.text, "follow-up");
    assert.equal(clientChatMessage({ role: "user", text: "internal", runtime: "steer" }), null);
    const projected = clientChatMessage({
      role: "assistant", text: "answer", thinking: "private", signature: "private",
      calls: [{ id: "c1", name: "bash", arguments: { token: "private" } }],
      files: [{ name: "notes.txt", mime: "text/plain", size: 4, blobId: "blob-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      images: [{ mime: "image/png", path: "/tmp/private.png", url: "https://files.example/shot.png" }],
      quote: { seq: 4, role: "user", text: "quoted" }, error: true, notice: true, progress: true, delivery: true, newSession: true,
      stepOutput: { step: 2, label: "日志", text: "ok", files: [{ name: "out.txt", mime: "text/plain", size: 2, blobId: "blob-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] },
    });
    assert.equal(projected?.calls?.[0].name, "bash");
    assert.equal((projected as any)?.calls?.[0].arguments, undefined);
    assert.equal(projected?.quote?.text, "quoted");
    assert.equal(projected?.files?.[0].name, "notes.txt");
    assert.equal(projected?.images?.[0].url, "https://files.example/shot.png");
    assert.equal((projected?.images?.[0] as any).path, undefined);
    assert.equal((projected?.stepOutput as any).label, "日志");
    assert.equal(projected?.error, true);
    assert.equal(clientChatMessage({ role: "tool", text: "private" }), null);
    assert.equal(clientChatMessage({ role: "user", files: [{ name: "only.bin", mime: "application/octet-stream", size: 1, blobId: "blob-cccccccccccccccccccccccccccccccc" }] })?.files?.[0].name, "only.bin");
    assert(!JSON.stringify(projected).includes("private"));
  } finally { await f.close(); }
});

test("desktop settings follow owner and administrator rules and round-trip without secrets", async () => {
  const f = await fixture();
  try {
    const created = await f.call("create", { name: "Settings", instruction: "先核对再改", clientNonce: "creation-fixture-settings" }) as any;
    const employee = await f.engine.employee.for(created.id);
    const ownerView = await f.call("settings") as any;
    assert.equal(ownerView.admin, false);
    assert.equal(ownerView.scenes, undefined);
    assert.equal(ownerView.bots[0].instruction, "先核对再改");
    assert.equal(ownerView.bots[0].editable, true);
    assert.equal(ownerView.bots[0].idleMinutes, 10);
    await f.call("settings", { save: "bot", bot: { id: created.id, instruction: "先看现有实现", idleMinutes: 12, takeoverSeconds: 20, cwd: "" } });
    assert.equal((await employee.profile()).instruction, "先看现有实现");
    assert.equal((await employee.profile()).idleMinutes, 12);
    assert.equal((await employee.profile()).takeoverSeconds, 20);
    await assert.rejects(f.call("settings", { save: "bot", bot: { id: created.id, idleMinutes: 121 } }), /0 到 120/);
    await assert.rejects(f.call("settings", { save: "scenes", scenes: {} }), /Administrator/);
    await assert.rejects(f.call("settings", { save: "bot", bot: { id: created.id, instruction: "stolen" } }, "other"), /not found/);
    await assert.rejects(f.call("settings", { save: "bot", bot: { id: created.id, instruction: "nope" } }, "viewer"), /permission/);
    const viewer = await f.call("settings", {}, "viewer") as any;
    assert.equal(viewer.admin, false);
    assert.deepEqual(viewer.bots, []);
    f.auth.user = async (id: string) => ({ id, username: id, role: id === "admin" ? "admin" : id === "viewer" ? "viewer" : "operator", disabled: false, createdAt: 0, lastLogin: 0 }) as any;
    await f.store.put("config", { model: "old", provider: { demo: { name: "示例", apiKey: "secret-key", models: { fast: { name: "Fast", supportsImages: true } } } }, scenes: { lightweight: ["demo/fast"], coding: ["demo/fast"], computer: ["demo/fast"] } });
    const admin = await f.call("settings", {}, "admin") as any;
    assert.equal(admin.admin, true);
    assert.deepEqual(admin.bots, []);
    assert.equal(admin.scenes.lightweight[0].model, "demo/fast");
    assert.equal(admin.providers[0].name, "示例");
    assert.equal(admin.models[0].id, "demo/fast");
    assert.equal(admin.models[0].supportsImages, true);
    assert(!JSON.stringify(admin).includes("secret-key"));
    f.engine.catalog.resolve = async () => ({ supportsImages: true }) as any;
    await assert.rejects(f.call("settings", { save: "scheduler", scheduler: { globalSlots: 0, perEmployeeSlots: 3 } }, "admin"), /1 到 64/);
    await f.call("settings", { save: "scheduler", scheduler: { globalSlots: 4, perEmployeeSlots: 2 } }, "admin");
    assert.deepEqual((await f.engine.config()).scheduler, { globalSlots: 4, perEmployeeSlots: 2 });
    await assert.rejects(f.call("settings", { save: "scenes", scenes: { lightweight: ["demo/fast"], coding: [], computer: ["demo/fast"] } }, "admin"), /编码/);
    await f.call("settings", { save: "scenes", scenes: { lightweight: [{ model: "demo/fast", allowSpawn: true }], coding: ["demo/fast"], computer: [{ model: "demo/fast", allowSpawn: true }] } }, "admin");
    const saved = await f.engine.config();
    assert.deepEqual(saved.scenes?.lightweight, [{ model: "demo/fast", allowSpawn: true }]);
    assert.deepEqual(saved.scenes?.computer, ["demo/fast"]);
    assert.equal((saved.provider as any).demo.apiKey, "secret-key");
  } finally { await f.close(); }
});
