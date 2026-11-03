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
  const store = new Store(":memory:");
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
  store.close();
});

test("forked image grants survive deletion of the source and preview grants stay user-scoped", async () => {
  const store = new Store(":memory:");
  for (const id of ["alice", "bob"])
    store.db.prepare("INSERT INTO web_users VALUES(?,?,?,?,?,?,?)").run(id, id, "fixture", "admin", 0, Date.now(), 0);
  const auth = new Auth(store, "fixture"), alice = auth.user("alice")!, bob = auth.user("bob")!;
  const source = store.newSession({ ownerId: "alice" }), blob = store.blob("image/png", Buffer.from("fixture"));
  store.grantBlob(blob, source.id);
  store.append(source.id, { role: "user", images: [{ mime: "image/png", blobId: blob }] });
  const fork = store.fork(source.id);
  store.deleteSession(source.id);
  assert.equal(auth.canBlob(alice, store.messages(fork.id)[0].images![0].blobId!), true);
  assert.equal(auth.canBlob(bob, blob), false);
  const preview = store.blob("image/png", Buffer.from("preview"));
  const chrome = new Chrome(store, {} as any, "");
  chrome.observe = async () => ({ id: "preview", tabTag: "C1", frames: [], pages: [{ url: "https://example.test" }], images: [], captured: Date.now() } as any);
  chrome.capture = async (o) => { o.images = [{ blobId: preview }]; return { fullPage: false, scrollExpanded: undefined, fullPageFallback: undefined, documentSize: undefined, screenshotComplete: true, totalTiles: 1, nextTile: undefined }; };
  await chrome.feedback("browser-view:alice", "C1", {}, "screenshot");
  assert.equal(auth.canBlob(alice, preview), true);
  assert.equal(auth.canBlob(bob, preview), false);
  store.close();
});

test("upgrading old histories backfills image grants for existing forks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vega-image-migration-"));
  const path = join(directory, "history.db");
  try {
    const old = new Store(path), session = old.newSession({ ownerId: "alice" });
    const blob = old.blob("image/png", Buffer.from("fixture"));
    old.append(session.id, { role: "user", images: [{ mime: "image/png", blobId: blob }] });
    old.db.exec("PRAGMA user_version=3");
    old.close();
    const migrated = new Store(path);
    assert.ok(migrated.db.prepare("SELECT 1 FROM blob_access WHERE blob=? AND session=?").get(blob, session.id));
    assert.equal(migrated.db.prepare("PRAGMA user_version").get()!.user_version, 4);
    migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a local response loss stops queued calls and persists the question instead of calling the model again", async () => {
  const store = new Store(":memory:");
  const subscriptions = new Subscriptions(store, "");
  const catalog = new Catalog(store, subscriptions);
  const chrome = new Chrome(store, new ChromeBridge(), "");
  const engine = new Engine(store, catalog, chrome);
  engine.employee.closed = true;
  store.put("config", { model: "fixture/model", provider: {} });
  const session = store.newSession({ ownerId: "alice", localAgent: true, clientId: "a".repeat(32), cwd: process.cwd() });
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
    assert.match(store.messages(session.id).at(-1)!.text!, /本轮已暂停.*不会自动重试/);
    assert.equal(engine.active.size, 0);
  } finally { await engine.close(); store.close(); }
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
