import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Vault, sshPrivateKey } from "../server/core/vault";
import { Engine } from "../server/core/engine";
import { Catalog } from "../server/core/catalog";
import { Subscriptions } from "../server/core/subscriptions";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { Tools } from "../server/core/tools";
import { KeyFiles, gitSshCommand, keyDir } from "../server/core/key-files";
import { Redactor } from "../server/core/util";
import { vaultCall } from "./public-call";

const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const encryptedPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pass" }) as string;
const openssh = (cipher: string) => {
  const name = Buffer.from(cipher), size = Buffer.alloc(4);
  size.writeUInt32BE(name.length);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), size, name, Buffer.alloc(48, 7)]).toString("base64");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\r\n${body.match(/.{1,70}/g)!.join("\r\n")}\r\n-----END OPENSSH PRIVATE KEY-----\r\n`;
};

test("vault entry types: labels by default, ssh_key validated and normalised", async () => {
  const store = await Store.open(":memory:"), vault = new Vault(store);
  try {
    await assert.rejects(vault.save({ type: "password", name: "x", condition: "c", content: "v" }), /Unknown vault entry type/);
    const plain = await vault.save({ name: "untyped", condition: "c", content: "v" });
    const token = await vault.save({ type: "token", name: "api", condition: "c", content: "tok" });
    const types = Object.fromEntries((await vault.list()).map((e) => [e.id, e.type]));
    assert.deepEqual(types, { [plain.id]: "general", [token.id]: "token" });
    assert.equal((await vault.get(token.id, "use")).type, "token");
    await assert.rejects(vault.save({ type: "ssh_key", name: "k", condition: "c", content: "ssh-ed25519 AAAA user@host" }), /SSH 私钥格式不对/);
    await assert.rejects(vault.save({ type: "ssh_key", name: "k", condition: "c", content: encryptedPem }), /带口令/);
    await assert.rejects(vault.save({ type: "ssh_key", name: "k", condition: "c", content: openssh("aes256-ctr") }), /带口令/);
    // Switching a kept non-key content to ssh_key is refused.
    await assert.rejects(vault.save({ id: token.id, type: "ssh_key", name: "api", condition: "c" }), /SSH 私钥格式不对/);
    const key = await vault.save({ type: "ssh_key", name: "deploy", condition: "c", content: openssh("none") });
    const stored = (await vault.get(key.id, "use")).content;
    assert(!stored.includes("\r") && stored.endsWith("-----END OPENSSH PRIVATE KEY-----\n"));
    assert.equal(sshPrivateKey(pem), pem.trim() + "\n");
    // Editing keeps the type unless a new one is given.
    await vault.save({ id: key.id, name: "deploy key", condition: "c" });
    assert.equal((await vault.list()).find((e) => e.id === key.id)!.type, "ssh_key");
  } finally { await store.close(); }
});


test("vault_get of an ssh_key writes a 0600 file, returns GIT_SSH_COMMAND without the key, and removes it when the run ends", async () => {
  const store = await Store.open(":memory:");
  // A crashed run's key file is removed at startup.
  mkdirSync(keyDir(store.files.root), { recursive: true });
  writeFileSync(join(keyDir(store.files.root), "stale"), "old");
  const engine = await Engine.create(store, new Catalog(store, new Subscriptions(store, "")), new Chrome(store, new ChromeBridge(), ""));
  engine.employee.closed = true;
  assert(!existsSync(join(keyDir(store.files.root), "stale")));
  await store.put("config", { scenes: { lightweight: ["fixture/light"], coding: ["fixture/light"], computer: ["fixture/light"] }, provider: { fixture: { api: "openai-completions", baseURL: "https://unused.test", models: { light: { modalities: { input: ["text"] }, limit: { context: 128000, output: 8192 } } } } } });
  engine.catalog.resolve = async () => ({ selection: "fixture/light" } as any);
  engine.providers.chat = async () => ({ role: "assistant", calls: [{ id: "check", name: "check_credential_use", arguments: { allowed: true, reason: "符合" } }] });
  const employee = await engine.employee.for((await engine.employee.create({ name: "A" }, "alice")).id);
  try {
    const entry = await employee.vault.save({ type: "ssh_key", name: "deploy", condition: "拉取公司 Git 仓库", content: pem });
    const job = (await employee.execute("", { action: "add", kind: "todo", text: "git pull the repo" })).value.id;
    await employee.update((state) => { state.tasks[0].status = "running"; });
    const session = await store.newSession({ cwd: ".", scene: "coding", employeeId: employee.employeeId, taskId: job });
    employee.busy.set(job, { session: session.id, computer: false });
    const redactor = new Redactor();
    engine.redactors.set(session.id, redactor);
    const tools = await Tools.create(engine, session, await engine.config(session), new AbortController().signal, () => {});
    const listed = await tools.execute({ id: "list", ...vaultCall({ action: "list" }) }, { supportsImages: true } as any);
    assert.deepEqual(listed.value.entries.map((e: any) => e.type), ["ssh_key"]);
    const got = await tools.execute({ id: "get", ...vaultCall({ action: "get", id: entry.id, text: "git pull" }) }, { supportsImages: true } as any);
    const body = pem.split("\n")[1];
    assert.equal(got.secret, undefined, "the key never reaches the model");
    assert(!JSON.stringify(got).includes(body));
    const file = got.value.keyFile;
    assert.equal(got.value.GIT_SSH_COMMAND, gitSshCommand(file));
    assert.match(got.value.GIT_SSH_COMMAND, /^ssh -i '.+' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes$/);
    // Windows has no POSIX mode bits for regular files: every file reads as 0o666.
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), pem.trim() + "\n");
    assert.equal(redactor.text("cat says " + body), "cat says [credential redacted]");
    await tools.close();
    assert(!existsSync(file));
  } finally { employee.busy.clear(); await engine.close(); await store.close(); }
});

test("on a local client the key file is written and removed by the client", async () => {
  const calls: any[] = [];
  const hub = { request: async (_agent: any, op: string, args: any) => { calls.push({ job: op, ...args }); return args.op === "write" ? { path: "C:\\Users\\a\\AppData\\Local\\Temp\\vega-keys\\key-1" } : { removed: true }; } };
  const files = new KeyFiles("/unused", hub as any), agent = {} as any;
  const path = await files.write("KEY\n", agent, new AbortController().signal);
  assert.equal(gitSshCommand(path), "ssh -i 'C:/Users/a/AppData/Local/Temp/vega-keys/key-1' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes");
  assert.deepEqual(calls[0], { job: "key", op: "write", content: Buffer.from("KEY\n").toString("base64") });
  await files.clear();
  assert.deepEqual(calls[1], { job: "key", op: "remove", path });
  const old = new KeyFiles("/unused", { request: async () => ({ error: "Unknown operation" }) } as any);
  await assert.rejects(old.write("KEY\n", agent, new AbortController().signal), /版本过旧/);
});
