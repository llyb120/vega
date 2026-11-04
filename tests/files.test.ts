import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { Redactor } from "../server/core/util";
import type { Session } from "../server/core/store";

function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const a = engine.employee.for(engine.employee.create({ name: "A" }, "owner").id), b = engine.employee.for(engine.employee.create({ name: "B" }, "owner").id);
  const tools = (session: Session) => new Tools(engine, session, engine.config(), new AbortController().signal, () => {});
  return { store, engine, a, b, tools };
}

test("archived files are written per employee task or user session and read back only from their own scope", async () => {
  const { store, engine, a, b, tools } = fixture();
  try {
    const work = store.newSession({ cwd: process.cwd(), taskId: "t1", employeeId: a.employeeId }), chat = a.chat("owner"), other = b.chat("owner");
    const plain = store.newSession({ cwd: process.cwd(), ownerId: "alice" });
    const pixels = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).webp().toBuffer();
    const shot = store.files.write(work, "snap-0.webp", pixels);
    assert.equal(shot, join(store.files.root, "employees", a.employeeId, "t1", "snap-0.webp"));
    assert.equal(store.files.url(shot), `/api/files/employees/${a.employeeId}/t1/snap-0.webp`);
    // The same employee reads it from another of its sessions (the task's screenshot from the chat).
    const read = await tools(chat).read({ path: shot });
    assert.deepEqual(read.images, [{ mime: "image/webp", path: shot, url: store.files.url(shot) }]);
    assert.equal(store.imageData(read.images![0]).data, pixels.toString("base64"));
    // Another employee, a plain session, or a path climbing out of the employee directory cannot.
    for (const [session, path] of [[other, shot], [plain, shot], [chat, join(store.files.employee(a.employeeId), "..", b.employeeId, "x.webp")]] as const)
      await assert.rejects(tools(session).read({ path }), /只能读取本牛马/);
    await assert.rejects(tools(chat).read({ path: join(store.files.dir(work), "gone.webp") }), /存档文件不存在/);
    // A plain session writes under its owner and reads its own files.
    const own = store.files.write(plain, "note.json", JSON.stringify({ hello: "world" }));
    assert.equal(own, join(store.files.root, "users", "alice", plain.id, "note.json"));
    assert.match((await tools(plain).read({ path: own })).value.text, /"hello": "world"/);
    // An oversized result becomes a file in the task directory; history keeps a preview and its path.
    engine.outcome(work.id, { id: "call-1", name: "bash", arguments: {} }, { value: { out: "x".repeat(40000) } }, () => {}, new Redactor());
    const archived = JSON.parse(store.messages(work.id).at(-1)!.text!);
    assert.equal(archived.archivePath, join(store.files.dir(work), "output-call-1.json"));
    assert(archived.preview.length < 33000);
    const page = await tools(work).read({ path: archived.archivePath, offset: 1, limit: 3 });
    assert.match(page.value.text, /^1\|\{/);
  } finally { await engine.close(); store.close(); }
});

test("files go with clear chat, task removal, reset and employee removal", async () => {
  const { store, engine, a, b } = fixture();
  try {
    const chat = a.chat("owner"), work = store.newSession({ cwd: process.cwd(), taskId: "t1", employeeId: a.employeeId });
    a.update((state) => { state.tasks.push({ id: "t1", text: "t1", status: "done", createdAt: Date.now(), profile: "coding", cwd: state.cwd, owner: { token: "", name: "owner" }, workSession: work.id }); });
    const chatFile = store.files.write(chat, "c.webp", "c"), taskFile = store.files.write(work, "t.webp", "t");
    engine.clearEmployeeChat(a.employeeId);
    assert(!existsSync(chatFile) && existsSync(taskFile), "clearing the chat keeps task files");
    await a.control({ action: "remove", id: "t1" });
    assert(!existsSync(taskFile), "a removed task record takes its files");
    store.files.write(work, "t.webp", "t");
    await engine.resetEmployee(a.employeeId);
    assert(!existsSync(store.files.employee(a.employeeId)));
    const bFile = store.files.write(b.chat("owner"), "b.webp", "b");
    await engine.removeEmployee(b.employeeId);
    assert(!existsSync(bFile) && !existsSync(store.files.employee(b.employeeId)));
    const plain = store.newSession({ cwd: process.cwd(), ownerId: "alice" }), plainFile = store.files.write(plain, "p.webp", "p");
    store.clearSessionHistory(plain.id);
    assert(!existsSync(plainFile));
    store.files.write(plain, "p.webp", "p");
    store.deleteSession(plain.id);
    assert(!existsSync(store.files.dir(plain)));
  } finally { await engine.close(); store.close(); }
  assert(!existsSync(store.files.root), "an in-memory store removes its files on close");
});

test("delivery Markdown shows archived screenshots by their url and never a path outside the files route", async () => {
  const { renderInline } = await import("../web/src/markdown.js");
  assert.match(renderInline("![登录成功](/api/files/employees/e1/t1/snap-0.webp)"), /<img src="\/api\/files\/employees\/e1\/t1\/snap-0\.webp" alt="登录成功"/);
  for (const bad of ["/api/files/../vega.db.webp", "/api/files/employees/./x.webp", "/api/files/a/b.json"])
    assert.doesNotMatch(renderInline(`![x](${bad})`), /<img/);
});
