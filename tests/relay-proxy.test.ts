import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRelay } from "../server/core/network-relay";
import { Store } from "../server/core/store";
import { LocalAgents } from "../server/core/local-agent";
import { relayProxyFile, relayShellEnvironment } from "../server/core/relay-proxy";

const grant = { userId: "alice", clientId: "c".repeat(32), hash: "device-hash" };
async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), hub = new LocalAgents();
  const relay = new NetworkRelay(store, hub);
  const root = await mkdtemp(join(tmpdir(), "vega-relay-test-"));
  const details = { clientId: grant.clientId, instance: "a".repeat(32), platform: "windows", cwd: "C:\\work" };
  hub.connect(grant.userId, details, { send() {}, close() {} });
  t.after(async () => { hub.close(); await relay.close(); await store.close(); });
  return { store, hub, relay, root, offline: () => hub.disconnect(grant.userId, details.instance) };
}
function read(stream: NodeJS.ReadableStream, size: number): Promise<Buffer> {
  return new Promise((yes, no) => {
    let collected = Buffer.alloc(0);
    const timer = setTimeout(() => no(Error("Read timed out: " + collected.toString())), 5000);
    stream.on("data", (chunk: Buffer) => {
      collected = Buffer.concat([collected, chunk]);
      if (collected.length < size) return;
      clearTimeout(timer);
      yes(collected);
    });
  });
}

test("the shell environment points curl, git and ssh at the account gateway", async (t) => {
  const f = await fixture(t), file = await relayProxyFile(f.root);
  const env = await relayShellEnvironment("socks5://127.0.0.1:41234", f.root);
  assert.deepEqual(env, {
    VEGA_SOCKS: "127.0.0.1:41234",
    VEGA_PROXY_COMMAND: `${process.execPath} ${file} %h %p`,
    ALL_PROXY: "socks5h://127.0.0.1:41234",
    all_proxy: "socks5h://127.0.0.1:41234",
    GIT_SSH_COMMAND: `ssh -o 'ProxyCommand=${process.execPath} ${file} %h %p'`,
  });
  assert.equal(await relayProxyFile(f.root), file, "one file per files root");
});

test("server shells get the proxy whenever a borrowable client is online, with or without rules", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.relay.enabled("alice"), false, "还没上报中继配置的客户端不参与兜底");
  await f.relay.configure(grant, []);
  assert.equal(await f.relay.enabled("alice"), true, "没有规则也能兜底借用（开关字段已取消）");
  assert.equal(await f.relay.enabled("bob"), false, "没有在线客户端就没有代理");
  f.offline();
  assert.equal(await f.relay.enabled("alice"), false, "客户端离线时不借云端出口");
});

test("the ProxyCommand relays a TCP stream through the gateway", async (t) => {
  const f = await fixture(t), echo = createServer((socket) => socket.pipe(socket));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  t.after(() => echo.close());
  const env = await relayShellEnvironment(await f.relay.proxy("alice"), f.root);
  const child = spawn(process.execPath, [await relayProxyFile(f.root), "127.0.0.1", String((echo.address() as any).port)], {
    env: { ...process.env, VEGA_SOCKS: env.VEGA_SOCKS }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  child.stdin.write("ssh banner");
  assert.equal((await read(child.stdout, 10)).toString(), "ssh banner");
});

test("a host rule without that port fails the tunnel instead of dialing directly", async (t) => {
  const f = await fixture(t);
  await f.relay.configure(grant, ["git.internal:443"]);
  const env = await relayShellEnvironment(await f.relay.proxy("alice"), f.root);
  const child = spawn(process.execPath, [await relayProxyFile(f.root), "git.internal", "22"], {
    env: { ...process.env, VEGA_SOCKS: env.VEGA_SOCKS }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const stderr = read(child.stderr, 1);
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match((await stderr).toString(), /SOCKS5 connect failed with code 1/);
});
