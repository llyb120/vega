import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { Store } from "../server/core/store";
import { Auth } from "../server/core/auth";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Engine } from "../server/core/engine";
import { LocalAgentUnavailable } from "../server/core/local-agent";
import { sleep } from "../server/core/util";

test("snapshot-only and inferred Chrome targets use the same mutex as explicit tab and live controls", async () => {
  const store = await Store.open(":memory:");
  const chrome = new Chrome(store, {} as any, "");
  chrome.observations.set("owner:C1", { id: "snapshot", tabTag: "C1" } as any);
  const entered: string[] = [];
  chrome.inner = async (_owner, _cwd, args) => { entered.push(args.tabTag); return {}; };
  let release!: () => void;
  const held = chrome.tabGate("C1").run(() => new Promise<void>((yes) => { release = yes; }));
  await sleep(0);
  const jobs = [
    chrome.execute("owner", ".", { operation: "act", snapshotId: "snapshot" }),
    chrome.execute("owner", ".", { operation: "inspect" }),
    chrome.execute("owner", ".", { operation: "inspect", tabTag: "C1" }),
  ];
  await chrome.execute("owner", ".", { operation: "inspect", tabTag: "C2" });
  assert.deepEqual(entered, ["C2"]);
  release(); await held; await Promise.all(jobs);
  assert.deepEqual(entered, ["C2", "C1", "C1", "C1"]);
  await store.close();
});

test("forked images survive deletion of the source and preview files stay user-scoped", async () => {
  const store = await Store.open(":memory:");
  for (const id of ["alice", "bob"])
    await store.run("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)", id, id, "fixture", "admin", 0, Date.now(), 0);
  const auth = new Auth(store, "fixture"), alice = (await auth.user("alice"))!, bob = (await auth.user("bob"))!;
  const source = await store.newSession({ ownerId: "alice" }), blob = await store.blob("image/png", Buffer.from("fixture"));
  await store.grantBlob(blob, source.id);
  await store.append(source.id, { role: "user", images: [{ mime: "image/png", blobId: blob }] });
  const fork = await store.fork(source.id);
  await store.deleteSession(source.id);
  assert.equal(await auth.canBlob(alice, (await store.messages(fork.id))[0].images![0].blobId!), true);
  assert.equal(await auth.canBlob(bob, blob), false);
  const chrome = new Chrome(store, {} as any, "");
  chrome.observe = async () => ({ id: "preview", tabTag: "C1", frames: [], pages: [{ url: "https://example.test" }], images: [], captured: Date.now() } as any);
  chrome.capture = async (owner, o) => { o.images = [{ path: await store.files.write(owner, "preview-0.webp", "x") }]; return { fullPage: false, scrollExpanded: undefined, fullPageFallback: undefined, documentSize: undefined, screenshotComplete: true, totalTiles: 1, nextTile: undefined }; };
  const shown = await chrome.feedback("browser-view:alice", "C1", {}, "screenshot");
  const parts = (path: string) => path.slice(store.files.root.length + 1).split(/[\\/]/);
  // The browser view's screenshot and DOM record are files of that user only.
  assert.deepEqual(parts(shown.images[0].path).slice(0, 2), ["views", "alice"]);
  assert.deepEqual(parts(shown.documentPath!).slice(0, 2), ["views", "alice"]);
  assert.equal(await auth.canFile(alice, parts(shown.images[0].path)), true);
  assert.equal(await auth.canFile(bob, parts(shown.images[0].path)), false);
  // A fork owns copies of its files, so deleting the source keeps the fork's screenshots readable.
  const owner = await store.newSession({ ownerId: "alice" }), shot = await store.files.write(owner, "a.webp", "pixels");
  await store.append(owner.id, { role: "tool", name: "chrome_screenshot", text: JSON.stringify({ images: [{ path: shot }] }), images: [{ mime: "image/webp", path: shot, url: store.files.url(shot) }] });
  const copy = await store.fork(owner.id), copied = (await store.messages(copy.id))[0];
  await store.deleteSession(owner.id);
  assert(copied.images![0].path!.includes(copy.id));
  assert(copied.text!.includes(copy.id), "forked history must point at the copy's own files, including JSON nested inside tool text");
  assert.equal((await store.files.read(copied.images![0].path!)).toString(), "pixels");
  assert.equal(await auth.canFile(alice, parts(copied.images![0].path!)), true);
  assert.equal(await auth.canFile(bob, parts(copied.images![0].path!)), false);
  await assert.rejects(async () => await store.files.read(shot));
  await store.close();
});

test("a database from an older schema version is refused and left unchanged (no migration)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vega-old-schema-"));
  const path = join(directory, "history.db");
  try {
    const old = await Store.open(path), session = await old.newSession({ ownerId: "alice" });
    await old.run("UPDATE settings SET value='5' WHERE name='schema'");
    await old.close();
    await assert.rejects(async () => await Store.open(path), /Not a supported Vega database/);
    if (process.env.DB_TYPE !== "mysql") {
      const reopened = new DatabaseSync(path);
      assert.equal((reopened.prepare("SELECT value FROM settings WHERE name='schema'").get() as any).value, "5");
      assert.ok(reopened.prepare("SELECT 1 FROM sessions WHERE id=?").get(session.id));
      reopened.close();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a local response loss stops queued calls and persists the question instead of calling the model again", async () => {
  const store = await Store.open(":memory:");
  const subscriptions = new Subscriptions(store, "");
  const catalog = new Catalog(store, subscriptions);
  const chrome = new Chrome(store, new ChromeBridge(), "");
  const engine = await Engine.create(store, catalog, chrome);
  engine.employee.closed = true;
  await store.put("config", { scenes: { lightweight: ["fixture/model"], coding: ["fixture/model"], computer: ["fixture/model"] }, model: "fixture/model", provider: {} });
  const session = await store.newSession({ ownerId: "alice", localAgent: true, clientId: "a".repeat(32), cwd: process.cwd() });
  engine.localAgents.connect("alice", { instance: "a".repeat(32), cwd: session.cwd, platform: "windows" });
  let operations = 0, completions = 0;
  engine.localAgents.request = async () => { operations++; throw new LocalAgentUnavailable(); };
  const model = { selection: "fixture/model", contextWindow: 128000, maxOutputTokens: 1024 };
  catalog.resolve = async () => model as any;
  engine.providers.chat = async () => {
    completions++;
    return { role: "assistant", calls: ["first", "second"].map((id) => ({ id, name: "bash", arguments: { command: "fixture" } })) };
  };
  try {
    await engine.run(session.id, { role: "user", text: "run fixture" });
    assert.equal(operations, 1);
    assert.equal(completions, 1);
    assert.match((await store.messages(session.id)).at(-1)!.text!, /本轮已暂停.*不会自动重试/);
    assert.equal(engine.active.size, 0);
  } finally { await engine.close(); await store.close(); }
});

test("deleting a root clears a selected descendant Stage and invalidates pending UI refreshes", async () => {
  const source = readFileSync("web/src/App.vue", "utf8");
  const block = source.slice(source.indexOf("async function removeSession(s) {"), source.indexOf("async function send()"));
  const state: any = {
    current: { value: { id: "leaf", stageSource: "stage" } },
    sessions: { value: [{ id: "root" }, { id: "stage", stageSource: "root" }] },
    messages: { value: ["deleted transcript"] }, folds: { value: ["fold"] },
    contextBudget: { value: {} }, fireState: { value: {} }, live: { value: "stale" }, thinking: { value: "stale" },
    activeTools: { value: ["stale"] }, draft: { value: "stale" }, attachments: { value: ["stale"] },
    drafts: new Map([["leaf", { text: "private draft" }], ["root", { text: "root draft" }]]),
    restoreDraft: () => { state.draft.value = ""; state.attachments.value = []; },
    resetLive: () => { state.live.value = ""; state.thinking.value = ""; },
    sessionRequest: 4, confirm: () => true, attempt: (fn: any) => fn(), api: async () => ({ ok: true }), bootstrap: async () => {},
  };
  state.bootstrap = async () => { state.sessions.value = []; };
  const context = vm.createContext(state);
  const remove = vm.runInContext(block + "\nremoveSession", context);
  await remove({ id: "root" });
  assert.equal(state.current.value, null);
  assert.equal(state.messages.value.length, 0);
  assert.equal(state.sessionRequest, 5);
  assert.equal(state.drafts.size, 0);
  assert.equal(state.draft.value, "");
});
