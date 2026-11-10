import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeyFiles } from "../server/core/key-files";
import { validateClient } from "../server/core/local-agent";

const client = (sshKeys?: unknown) => ({
  instance: "0123456789abcdef0123456789abcdef", clientId: "0123456789abcdef0123456789abcdef",
  cwd: "/work", platform: "windows", sshKeys,
} as any);

// 客户端「本地 SSH 密钥授权」（默认允许）才能把本机 ~/.ssh 借给服务端的 git over SSH。
test("server git over SSH borrows the client's own keys while it allows it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vega-ssh-keys-"));
  const answers = new Map<string, any>([
    ["ssh", { keys: [
      { name: "config", content: Buffer.from("Host work\n  User git\n").toString("base64") },
      { name: "id_ed25519", content: Buffer.from("KEY\n").toString("base64") },
    ] }],
    ["remove", { removed: true }],
  ]);
  const calls: any[] = [];
  const hub = { request: async (_agent: any, op: string, args: any) => { calls.push({ job: op, ...args }); return answers.get(args.op || ""); } };
  const files = new KeyFiles(dir, hub as any), signal = new AbortController().signal, agent = client();
  const options = await files.localSshCommand(agent, signal);
  assert.deepEqual(calls[0], { job: "key", op: "ssh" });
  const paths = [...options.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(paths.length, 2);
  assert.match(options, /^-F '.+' -i '.+'$/);
  assert(!options.includes("\\"), "ssh options must use forward slashes");
  // Windows reports 0o666 for every writable file; the 0600 mode is only observable on POSIX.
  if (process.platform !== "win32") assert.equal(statSync(paths[0]).mode & 0o777, 0o600);
  assert(existsSync(paths[1]));
  await files.clear();
  assert(!paths.some((path) => existsSync(path)), "the borrowed keys are removed when the run ends");
});

test("no keys are requested once the client turns the authorization off", async () => {
  const calls: string[] = [];
  const hub = { request: async (_agent: any, _op: string, args: any) => { calls.push(args.op); return { keys: [] }; } };
  const files = new KeyFiles(mkdtempSync(join(tmpdir(), "vega-ssh-keys-")), hub as any);
  assert.equal(await files.localSshCommand(client(false), new AbortController().signal), "");
  assert.deepEqual(calls, []);
});

test("a client without ssh keys, an old client and an empty answer all fall back to the server's own ssh", async () => {
  const answer = (result: any) => new KeyFiles(mkdtempSync(join(tmpdir(), "vega-ssh-keys-")), { request: async () => result } as any);
  assert.equal(await answer({ error: "Unknown key operation" }).localSshCommand(client(), new AbortController().signal), "");
  assert.equal(await answer({ keys: [] }).localSshCommand(client(), new AbortController().signal), "");
});

test("the client ssh flag is validated like the other client capabilities", async () => {
  assert.equal(validateClient(client()), "0123456789abcdef0123456789abcdef");
  validateClient(client(true));
  validateClient(client(false));
  assert.throws(() => validateClient(client("yes")), /Invalid client ssh keys/);
});
