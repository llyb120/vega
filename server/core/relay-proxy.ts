import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyDir } from "./key-files";
import type { CloudRuntime } from "./cloud";

/**
 * ssh ProxyCommand: relays stdio through the account's loopback SOCKS5 gateway (see network-relay).
 * ssh needs a program, not an env value, so this source is written where the shell runs (server or tenant tmp).
 */
const SOURCE = `import { connect } from "node:net";

const [host, port] = process.argv.slice(2);
const [proxyHost, proxyPort] = (process.env.VEGA_SOCKS || "").split(":");
const fail = (message) => { process.stderr.write("vega relay: " + message + "\\n"); process.exit(1); };
if (!host || !proxyPort) fail("ProxyCommand needs HOST PORT and VEGA_SOCKS=host:port");
const socket = connect({ host: proxyHost, port: Number(proxyPort) });
socket.setNoDelay(true);
socket.on("error", (error) => fail(error.message));
socket.on("close", () => process.exit(0));
socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
let pending = Buffer.alloc(0), stage = 0;
const request = () => {
  const name = Buffer.from(host, "ascii"), bytes = Buffer.alloc(7 + name.length);
  bytes.set([5, 1, 0, 3, name.length]);
  name.copy(bytes, 5);
  bytes.writeUInt16BE(Number(port) || 22, bytes.length - 2);
  return bytes;
};
const relay = () => {
  stage = 2;
  socket.off("data", negotiate);
  socket.on("data", (data) => { if (!process.stdout.write(data)) socket.pause(); });
  process.stdout.on("drain", () => socket.resume());
  process.stdin.on("error", () => socket.destroy());
  process.stdin.on("end", () => socket.end());
  process.stdin.pipe(socket);
  if (pending.length) { process.stdout.write(pending); pending = Buffer.alloc(0); }
};
function negotiate(chunk) {
  pending = Buffer.concat([pending, chunk]);
  if (stage === 0) {
    if (pending.length < 2) return;
    if (pending[0] !== 5 || pending[1] !== 0) return fail("SOCKS5 gateway refused authentication");
    pending = pending.subarray(2);
    stage = 1;
    socket.write(request());
    return;
  }
  if (pending.length < 5) return;
  const length = pending[3] === 1 ? 10 : pending[3] === 4 ? 22 : 7 + pending[4];
  if (pending.length < length) return;
  if (pending[1] !== 0) return fail("SOCKS5 connect failed with code " + pending[1]);
  pending = pending.subarray(length);
  relay();
}
socket.on("data", negotiate);
`;

const files = new Map<string, Promise<string>>();
export function relayProxyFile(filesRoot: string, cloud?: CloudRuntime) {
  const key = cloud ? "cloud:" + cloud.owner : "server:" + filesRoot;
  let writing = files.get(key);
  if (!writing) {
    writing = (async () => {
      const fs = cloud?.fs || { mkdir, writeFile };
      const dir = cloud ? join((await cloud.identity()).tmp, "relay") : join(keyDir(filesRoot), "relay");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, "proxy-command.mjs");
      await fs.writeFile(path, SOURCE, { mode: 0o600 });
      return path;
    })();
    files.set(key, writing);
    void writing.catch(() => files.delete(key));
  }
  return writing;
}

// Paths are quoted only when they contain spaces: a quote character in a path is refused rather than guessed.
const quote = (value: string) => {
  if (!/[\s"']/.test(value)) return value;
  if (/["']/.test(value)) throw Error("中继 ProxyCommand 路径含引号，无法组成 ssh 命令");
  return `"${value}"`;
};

/**
 * Proxy settings for a server-side shell: HTTPS git and curl follow ALL_PROXY, git over SSH uses
 * GIT_SSH_COMMAND, a plain `ssh` needs `-o "ProxyCommand=$VEGA_PROXY_COMMAND"`. Hosts without a client
 * rule still dial from the server, so unmatched traffic keeps working.
 */
export async function relayShellEnvironment(proxy: string, filesRoot: string, cloud?: CloudRuntime) {
  const { hostname, port } = new URL(proxy), socks = `${hostname}:${port}`;
  const command = `${quote(process.execPath)} ${quote(await relayProxyFile(filesRoot, cloud))}`;
  // git runs GIT_SSH_COMMAND through sh on every platform, including git for Windows.
  return {
    VEGA_SOCKS: socks,
    VEGA_PROXY_COMMAND: `${command} %h %p`,
    ALL_PROXY: `socks5h://${socks}`,
    all_proxy: `socks5h://${socks}`,
    GIT_SSH_COMMAND: `ssh -o 'ProxyCommand=${command} %h %p'`,
  };
}
