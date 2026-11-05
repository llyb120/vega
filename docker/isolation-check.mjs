// Run inside the built image: node /app/docker/isolation-check.mjs (no production volumes).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { CloudSupervisor, serviceEnvironment } from "./cloud-supervisor.mjs";
import { cloudRequest, frames, send } from "../shared/cloud-wire.mjs";

assert.equal(process.platform, "linux", "This check requires Linux kernel permissions");
assert.equal(process.getuid(), 0, "Run this check through the image's trusted root entrypoint");
const root = await mkdtemp(join(tmpdir(), "vega-isolation-check-"));
await chmod(root, 0o711);
const data = join(root, "data"), workspace = join(root, "workspace"), socketPath = join(root, "run", "cloud.sock");
await mkdir(data); await mkdir(workspace);
let supervisor = new CloudSupervisor(data, workspace, socketPath);
const rpc = (owner, method, args) => cloudRequest(socketPath, { kind: "fs", owner, method, args });
function run(owner, command, args = [], cwd, env = {}, input) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath), chunks = { 1: [], 2: [], 4: [] };
    const timer = setTimeout(() => socket.destroy(Error("Check command timeout")), 15000);
    socket.on("error", reject);
    socket.on("close", () => clearTimeout(timer));
    socket.on("connect", () => send(socket, { kind: "exec", owner, command, args, cwd, env, pipes: input !== undefined }));
    frames(socket, (message) => {
      if (message.error) { socket.destroy(); reject(Error(message.error)); }
      if (message.ready) {
        send(socket, { fd: 0, end: true });
        if (input !== undefined) { send(socket, { fd: 3, data: Buffer.from(input).toString("base64") }); send(socket, { fd: 3, end: true }); }
      }
      if (message.fd) chunks[message.fd].push(Buffer.from(message.data, "base64"));
      if (message.exit !== undefined) {
        socket.destroy();
        resolve({ code: message.exit, out: Buffer.concat(chunks[1]).toString(), err: Buffer.concat(chunks[2]).toString(), pipe: Buffer.concat(chunks[4]).toString() });
      }
    });
  });
}
try {
  await supervisor.start();
  const service = spawnSync("/usr/bin/setpriv", ["--reuid=1000", "--regid=1000", "--clear-groups", "--no-new-privs", "--", process.execPath, "-e",
    "const fs=require('fs'),os=require('os'),path=require('path');console.log(os.homedir());console.log(process.getuid());try{fs.statSync(path.join(os.homedir(),'.config/devin/config.json'))}catch(e){if(e.code!=='ENOENT')throw e}",
  ], { cwd: "/", env: serviceEnvironment({ HOME: "/root", USER: "root", LOGNAME: "root" }), encoding: "utf8", timeout: 10000 });
  assert.equal(service.status, 0, service.error?.message || service.stderr);
  assert.deepEqual(service.stdout.trim().split("\n"), ["/home/node", "1000"]);
  const a = await cloudRequest(socketPath, { kind: "ensure", owner: "check_a" });
  const b = await cloudRequest(socketPath, { kind: "ensure", owner: "check_b" });
  assert.notEqual(a.uid, b.uid);
  assert.ok(a.uid >= 10001 && b.uid >= 10001);
  const secret = join(a.cwd, "secret.txt");
  await rpc("check_a", "writeFile", [secret, "private", { mode: 0o600 }]);
  assert.equal(await rpc("check_a", "readFile", [secret, "utf8"]), "private");
  await assert.rejects(rpc("check_b", "readFile", [secret]), { code: "EACCES" });
  await assert.rejects(rpc("check_b", "writeFile", [secret, "changed"]), { code: "EACCES" });
  assert.equal((await run("check_b", "/bin/cat", [secret], b.cwd)).code === 0, false);
  const link = join(b.cwd, "other-user-link");
  assert.equal((await run("check_b", "/bin/ln", ["-s", secret, link], b.cwd)).code, 0);
  await assert.rejects(rpc("check_b", "readFile", [link]), { code: "EACCES" });
  // Even a task accidentally publishing its own file cannot override the root-owned tenant guard.
  await rpc("check_a", "chmod", [a.cwd, 0o777]); await rpc("check_a", "chmod", [secret, 0o644]);
  await assert.rejects(rpc("check_b", "readFile", [secret]), { code: "EACCES" });
  const cwdEscape = await run("check_b", "/bin/cat", ["secret.txt"], a.cwd);
  assert.notEqual(cwdEscape.code, 0, "chdir must happen after dropping identity");
  await writeFile(join(data, "service-secret"), "service-only", { mode: 0o600 });
  await assert.rejects(rpc("check_a", "readFile", [join(data, "service-secret")]), { code: "EACCES" });
  const identity = await run("check_a", process.execPath, ["-e", "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),secret:process.env.VEGA_TOKEN,status:require('fs').readFileSync('/proc/self/status','utf8')}))"], a.cwd);
  assert.equal(identity.code, 0, identity.err);
  const info = JSON.parse(identity.out);
  assert.equal(info.uid, a.uid); assert.equal(info.gid, a.uid);
  assert.ok(info.groups.every((gid) => gid === a.uid)); assert.equal(info.secret, undefined);
  assert.match(info.status, /NoNewPrivs:\s+1/); assert.match(info.status, /CapEff:\s+0+\n/);
  const broker = await run("check_a", process.execPath, ["-e", "require('net').connect(process.argv[1]).on('error',e=>console.log(e.code)).on('connect',()=>process.exit(7))", socketPath], a.cwd);
  assert.equal(broker.code, 0); assert.match(broker.out, /EACCES/);
  const pipes = await run("check_a", process.execPath, ["-e", "const fs=require('fs');fs.createReadStream(null,{fd:3}).on('data',b=>fs.writeSync(4,b))"], a.cwd, {}, "browser-pipe");
  assert.equal(pipes.code, 0, pipes.err); assert.equal(pipes.pipe, "browser-pipe");
  await supervisor.close();
  supervisor = new CloudSupervisor(data, workspace, socketPath);
  await supervisor.start();
  const restored = await cloudRequest(socketPath, { kind: "ensure", owner: "check_a" });
  assert.equal(restored.uid, a.uid);
  assert.equal(await rpc("check_a", "readFile", [secret, "utf8"]), "private");
  await supervisor.close();
  await rm(join(data, ".vega-identities", "users.sqlite"));
  supervisor = new CloudSupervisor(data, workspace, socketPath);
  await assert.rejects(supervisor.start(), /identity mapping does not match/, "lost mappings must not reuse an old UID for a new owner");
  console.log("PASS: user identities, filesystem/shell/symlink/cwd isolation, protected launcher, clean environment, browser pipes, restart persistence and lost-map rejection");
} finally {
  await supervisor.close();
  await rm(root, { recursive: true, force: true });
}
