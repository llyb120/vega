import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { Store } from "../server/core/store";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { clip, Redactor } from "../server/core/util";
import type { Session } from "../server/core/store";

async function fixture() {
  const store = await Store.open(":memory:");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { model: { modalities: { input: ["text", "image"] }, limit: { context: 128000, output: 8192 } } } } } });
  const a = await engine.employee.for((await engine.employee.create({ name: "A" }, "owner")).id), b = await engine.employee.for((await engine.employee.create({ name: "B" }, "owner")).id);
  const tools = async (session: Session) => await Tools.create(engine, session, await engine.config(), new AbortController().signal, () => {});
  return { store, engine, a, b, tools };
}

test("task screenshot Markdown resolves against real task files without redirecting existing or foreign links", async () => {
  const store = await Store.open(":memory:");
  try {
    const files = store.files, task = await store.newSession({ cwd: process.cwd(), employeeId: "e1", taskId: "t-right" });
    const name = "a".repeat(32) + "-0.webp";
    const somName = "a".repeat(32) + "-0-som.webp";
    const url = files.url(await files.write(task, name, "archived screenshot"));
    await files.write(task, somName, "som screenshot");
    const somUrl = files.url(join(files.task("e1", "t-right"), somName));
    const sibling = files.url(await files.write({ ...task, taskId: "t-other" }, name, "other screenshot"));
    const typo = url.replace("t-right", "t-typo");
    const missing = typo.replace(name, "b".repeat(32) + "-0.webp");
    const untouched = [
      `![其他任务](${sibling})`,
      `![其他热心市民](${typo.replace("e1", "e2")})`,
      `![外部图片](https://example.test${typo})`,
      `![未知截图](${missing})`,
      `![正确地址](${url})`,
      `[文本链接](${typo})`,
      `\`![代码示例](<${typo}>)\``,
      "```md", `![代码块](<${typo}>)`, "```",
    ].join("\n");
    const text = `![短引用](<${name}>)\n![错用标注图](<${somUrl}>)\n![错误目录](</api/team/vega/${typo.slice(5)}?v=1> "标题")\n${untouched}`;
    assert.equal(await files.resolveTaskScreenshots(task, text), `![短引用](<${url}>)\n![错用标注图](<${url}>)\n![错误目录](<${url}?v=1> "标题")\n${untouched}`);
    assert.equal(await files.resolveTaskScreenshots({ ...task, taskId: undefined }, text), text);
  } finally { await store.close(); }
});

test("archived files are written per employee task or user session and read back only from their own scope", async () => {
  const { store, engine, a, b, tools } = await fixture();
  try {
    const work = await store.newSession({ cwd: process.cwd(), taskId: "t1", employeeId: a.employeeId }), chat = await a.chat("owner"), other = await b.chat("owner");
    const plain = await store.newSession({ cwd: process.cwd(), ownerId: "alice" });
    const pixels = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).webp().toBuffer();
    const shot = await store.files.write(work, "snap-0.webp", pixels);
    assert.equal(shot, join(store.files.root, "employees", a.employeeId, "t1", "snap-0.webp"));
    assert.equal(store.files.url(shot), `/api/files/employees/${a.employeeId}/t1/snap-0.webp`);
    // The same employee reads it from another of its sessions (the task's screenshot from the chat).
    const read = await (await tools(chat)).read({ path: shot });
    assert.deepEqual(read.images, [{ mime: "image/webp", path: shot, url: store.files.url(shot) }]);
    assert.equal((await store.imageData(read.images![0])).data, pixels.toString("base64"));
    // Another employee, a plain session, or a path climbing out of the employee directory cannot.
    for (const [session, path] of [[other, shot], [plain, shot], [chat, join(store.files.employee(a.employeeId), "..", b.employeeId, "x.webp")]] as const)
      await assert.rejects((await tools(session)).read({ path }), /只能读取当前热心市民/);
    await assert.rejects((await tools(chat)).read({ path: join(store.files.dir(work), "gone.webp") }), /存档文件不存在/);
    // A plain session writes under its owner and reads its own files.
    const own = await store.files.write(plain, "note.json", JSON.stringify({ hello: "world" }));
    assert.equal(own, join(store.files.root, "users", "alice", plain.id, "note.json"));
    assert.match((await (await tools(plain)).read({ path: own })).value.text, /"hello": "world"/);
    // An oversized result becomes a file in the task directory; history keeps a preview and its path.
    await engine.outcome(work.id, { id: "call-1", name: "bash", arguments: {} }, { value: { out: "x".repeat(40000) } }, () => {}, new Redactor());
    const archived = JSON.parse((await store.messages(work.id)).at(-1)!.text!);
    assert.equal(dirname(archived.archivePath), store.files.dir(work));
    assert.match(basename(archived.archivePath), /^output-[a-f\d]{64}\.json$/);
    assert(archived.preview.length < 33000);
    const page = await (await tools(work)).read({ path: archived.archivePath, offset: 1, limit: 3 });
    assert.match(page.value.text, /^1\|\{/);
  } finally { await engine.close(); await store.close(); }
});

test("oversized tool results use bounded, distinct archive names and preserve the original call IDs", async () => {
  const { store, engine, a } = await fixture();
  try {
    const work = await store.newSession({ cwd: process.cwd(), taskId: "t-long-id", employeeId: a.employeeId });
    const prefix = "call_123__thought__" + "x".repeat(800);
    const ids = [prefix + "a", prefix + "b", "call/a", "call?a", "调用-" + "长".repeat(300)];
    const paths = new Set<string>();
    for (const [index, id] of ids.entries()) {
      const value = { out: String(index).repeat(40000) };
      await engine.outcome(work.id, { id, name: "bash", arguments: {} }, { value }, () => {}, new Redactor());
      const receipt = (await store.messages(work.id)).at(-1)!;
      assert.equal(receipt.callId, id);
      const archived = JSON.parse(receipt.text!);
      assert.equal(dirname(archived.archivePath), store.files.dir(work));
      assert.match(basename(archived.archivePath), /^output-[a-f\d]{64}\.json$/);
      assert(!paths.has(archived.archivePath), "different call IDs must not overwrite each other's results");
      paths.add(archived.archivePath);
      assert.deepEqual(JSON.parse((await store.files.read(archived.archivePath)).toString("utf8")), value);
    }
  } finally { await engine.close(); await store.close(); }
});

test("clipping reports truncation without claiming a database type or successful archiving", () => {
  assert.equal(clip("完整文本", 4), "完整文本");
  assert.equal(clip("😀😀😀", 2), "😀😀\n[truncated]");
});

test("failed file archiving saves the full redacted result in the database with a readable, access-controlled reference", async (t) => {
  const { store, engine, a, tools } = await fixture();
  try {
    const work = await store.newSession({ cwd: process.cwd(), taskId: "t-fallback", employeeId: a.employeeId, ownerId: "owner" });
    const other = await store.newSession({ cwd: process.cwd(), ownerId: "other" });
    const redact = new Redactor();
    redact.add("private-token");
    t.mock.method(store.files, "write", async () => { throw Object.assign(new Error("private-token: disk full"), { code: "ENOSPC" }); });
    const value = { out: "x".repeat(40000), secret: "private-token" };
    await engine.outcome(work.id, { id: "completed-call", name: "bash", arguments: {} }, { value }, () => {}, redact);
    const receipt = (await store.messages(work.id)).at(-1)!;
    assert(!receipt.error, "a failed archive must not change the tool's successful outcome");
    const archived = JSON.parse(receipt.text!);
    assert.match(archived.archiveWarning, /disk full/);
    assert(!receipt.text!.includes("private-token"));
    assert.match(archived.archivePath, /^\/api\/blobs\/blob-[a-f\d]{32}$/);
    const blob = await store.blobData(archived.archivePath.split("/").at(-1));
    assert.equal(blob!.mime, "application/json");
    assert.deepEqual(JSON.parse(Buffer.from(blob!.data).toString("utf8")), redact.value(value));
    const page = await (await tools(work)).read({ path: archived.archivePath, limit: 3 });
    assert.equal(page.value.path, archived.archivePath);
    assert.match(page.value.text, /^1\|\{/);
    assert.equal(page.value.hasMore, true);
    assert(!page.images, "JSON archives must be paged as text, not treated as images");
    await assert.rejects((await tools(other)).read({ path: archived.archivePath }), /not accessible/);
  } finally { await engine.close(); await store.close(); }
});

test("archive failure never claims success when the database fallback also fails", async (t) => {
  const { store, engine } = await fixture();
  try {
    const session = await store.newSession({ cwd: process.cwd() });
    t.mock.method(store.files, "write", async () => { throw Error("disk unavailable"); });
    t.mock.method(store, "blob", async () => { throw Error("database unavailable"); });
    await assert.rejects(engine.outcome(session.id, { id: "once", name: "bash", arguments: {} }, { value: { out: "x".repeat(40000) } }, () => {}, new Redactor()), /database unavailable/);
    assert.equal((await store.messages(session.id)).length, 0, "no false successful receipt is saved");
  } finally { await engine.close(); await store.close(); }
});

test("archive failures preserve completed tool receipts and continue the same turn without replay", async (t) => {
  const { store, engine } = await fixture();
  try {
    const session = await store.newSession({ cwd: process.cwd(), scene: "lightweight", ownerId: "owner" });
    let executions = 0, turns = 0;
    t.mock.method(store.files, "write", async () => { throw Object.assign(new Error("archive unavailable"), { code: "EACCES" }); });
    t.mock.method(engine, "batch", async () => {
      executions++;
      return [{ value: { completed: true, out: "x".repeat(40000) } }];
    });
    engine.providers.chat = async (_model, _system, messages) => {
      if (turns++ === 0) return { role: "assistant", calls: [{ id: "once", name: "read", arguments: { path: "proof.txt" } }] };
      const receipt = messages.find((message) => message.role === "tool" && message.callId === "once");
      assert(receipt && !receipt.error);
      assert.match(receipt.text!, /archiveWarning/);
      return { role: "assistant", text: "原操作已经完成，归档已降级，无需重做。" };
    };
    await engine.run(session.id, { role: "user", text: "读取已有结果" });
    assert.equal(executions, 1);
    assert.equal(turns, 2);
    const rows = await store.messages(session.id);
    assert.equal(rows.filter((message) => message.role === "tool" && message.callId === "once").length, 1);
    assert(!rows.some((message) => message.runtime === "turn_aborted"));
  } finally { await engine.close(); await store.close(); }
});

test("read resolves /api/files and /api/blobs URLs on the server even for local-agent sessions", async () => {
  const { store, engine, a, tools } = await fixture();
  try {
    const work = await store.newSession({ cwd: process.cwd(), taskId: "t-url", employeeId: a.employeeId, localAgent: true, clientId: "client-1" });
    const pixels = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).webp().toBuffer();
    const shot = await store.files.write(work, "shot.webp", pixels);
    const url = store.files.url(shot);
    const viaUrl = await (await tools(work)).read({ path: url });
    assert.deepEqual(viaUrl.images, [{ mime: "image/webp", path: shot, url }]);
    const viaHost = await (await tools(work)).read({ path: `https://vega.example${url}` });
    assert.equal(viaHost.images![0].path, shot);
    const blobId = await store.blob("image/webp", pixels);
    await store.grantBlob(blobId, work.id);
    const viaBlob = await (await tools(work)).read({ path: `/api/blobs/${blobId}` });
    assert.equal(viaBlob.images![0].blobId, blobId);
    await assert.rejects((await tools(work)).read({ path: "/api/files/employees/other/x.webp" }), /只能读取当前热心市民|Invalid file path/);
  } finally { await engine.close(); await store.close(); }
});

test("files go with clear chat, task removal, reset and employee removal", async () => {
  const { store, engine, a, b } = await fixture();
  try {
    const chat = await a.chat("owner"), work = await store.newSession({ cwd: process.cwd(), taskId: "t1", employeeId: a.employeeId });
    await a.update((state) => { state.tasks.push({ id: "t1", text: "t1", status: "done", createdAt: Date.now(), profile: "coding", cwd: state.cwd, owner: { token: "", name: "owner" }, workSession: work.id }); });
    const chatFile = await store.files.write(chat, "c.webp", "c"), taskFile = await store.files.write(work, "t.webp", "t");
    await engine.clearEmployeeChat(a.employeeId);
    assert(!existsSync(chatFile) && existsSync(taskFile), "clearing the chat keeps task files");
    await a.control({ action: "remove", id: "t1" });
    assert(!existsSync(taskFile), "a removed task record takes its files");
    await store.files.write(work, "t.webp", "t");
    await engine.resetEmployee(a.employeeId);
    assert(!existsSync(store.files.employee(a.employeeId)));
    const bFile = await store.files.write(await b.chat("owner"), "b.webp", "b");
    await engine.removeEmployee(b.employeeId);
    assert(!existsSync(bFile) && !existsSync(store.files.employee(b.employeeId)));
    const plain = await store.newSession({ cwd: process.cwd(), ownerId: "alice" }), plainFile = await store.files.write(plain, "p.webp", "p");
    await store.clearSessionHistory(plain.id);
    assert(!existsSync(plainFile));
    await store.files.write(plain, "p.webp", "p");
    await store.deleteSession(plain.id);
    assert(!existsSync(store.files.dir(plain)));
  } finally { await engine.close(); await store.close(); }
  assert(!existsSync(store.files.root), "an in-memory store removes its files on close");
});

test("delivery Markdown shows archived screenshots by their url and never a path outside the files route", async () => {
  const { renderInline, renderMarkdown, filesArchiveBase } = await import("../web/src/markdown.js");
  assert.match(renderInline("![登录成功](/api/files/employees/e1/t1/snap-0.webp)"), /<img src="\/api\/files\/employees\/e1\/t1\/snap-0\.webp" alt="登录成功"/);
  assert.match(renderInline("见图 /api/files/employees/e1/t1/snap-0.webp。"), /<img src="\/api\/files\/employees\/e1\/t1\/snap-0\.webp"/);
  const shot = "59dbfad813894d67afaf57644b977910-0.webp";
  assert.match(renderMarkdown(`留底（${shot}）`, { archiveBase: filesArchiveBase("e1", "t1") }).html, new RegExp(`src="/api/files/employees/e1/t1/${shot}"`));
  for (const bad of ["/api/files/../vega.db.webp", "/api/files/employees/./x.webp", "/api/files/a/b.json"])
    assert.doesNotMatch(renderInline(`![x](${bad})`), /<img/);
});
