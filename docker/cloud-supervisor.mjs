import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, chmod, chown, lstat, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { frames, send, decode, encode } from "../shared/cloud-wire.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ownerPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export function validateOwner(owner) {
  if (typeof owner !== "string" || !ownerPattern.test(owner)) throw Error("Cloud execution requires an authenticated owner");
}
export function serviceEnvironment(env = process.env) {
  // setpriv changes UID/GID, not HOME; CLI discovery must use the service account's home.
  return { ...env, HOME: "/home/node", USER: "node", LOGNAME: "node" };
}
export function tenantEnvironment(identity, extra = {}) {
  // In particular, never inherit the service's database, vault, provider or Kubernetes credentials.
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: identity.home, USER: identity.name,
    LOGNAME: identity.name, TMPDIR: identity.tmp, XDG_CONFIG_HOME: join(identity.home, ".config"),
    XDG_CACHE_HOME: join(identity.home, ".cache") };
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw Error("Invalid execution environment");
    env[key] = value;
  }
  return env;
}
const dropPrivileges = (identity) => ["--reuid=" + identity.uid, "--regid=" + identity.uid, "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--"];
function system(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, env: { PATH: "/usr/sbin:/usr/bin:/bin", LANG: "C.UTF-8" } });
  if (result.error || result.status !== 0) throw Error(`${command} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
function lookup(kind, key) {
  const result = spawnSync("/usr/bin/getent", [kind, String(key)], { encoding: "utf8", timeout: 10000 });
  if (result.error || (result.status !== 0 && result.status !== 2)) throw Error("Cannot inspect system identities");
  return result.status === 0 ? result.stdout.trim().split(":") : undefined;
}
async function directory(path, uid, gid, mode) {
  let created = false;
  try { await mkdir(path, { mode }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (!created && (st.uid !== uid || st.gid !== gid))) throw Error("Unsafe cloud directory or lost identity mapping: " + path);
  await chown(path, uid, gid); await chmod(path, mode);
  const locked = await lstat(path);
  if (locked.uid !== uid || locked.gid !== gid || (locked.mode & 0o777) !== mode) throw Error("Cloud volumes must enforce POSIX ownership and permissions: " + path);
}

export class CloudSupervisor {
  constructor(data = "/data", workspace = "/workspace", socket = "/run/vega/cloud.sock") {
    this.data = data; this.workspace = workspace; this.socket = socket;
    this.children = new Map(); this.sockets = new Set(); this.tail = Promise.resolve(); this.ready = new Map();
  }
  async start() {
    if (process.platform !== "linux" || process.getuid() !== 0) throw Error("Docker cloud isolation requires the trusted root launcher; refusing shared-UID fallback");
    process.umask(0o077);
    // Preserve legacy data in place, but make its top-level entries private to their existing owners.
    for (const root of [this.data, this.workspace]) {
      const st = await lstat(root);
      if (!st.isDirectory() || st.isSymbolicLink() || ![0, 1000].includes(st.uid)) throw Error("Unsafe mounted directory: " + root);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if ((root === this.workspace && entry.name === ".vega-users") || (root === this.data && entry.name === ".vega-identities")) continue;
        const path = join(root, entry.name), item = await lstat(path);
        if (item.isSymbolicLink() || ![0, 1000].includes(item.uid)) throw Error("Legacy top-level entry requires administrator migration: " + path);
        await chmod(path, item.mode & 0o700);
      }
      await chown(root, 1000, 1000); await chmod(root, 0o711);
    }
    await chmod("/home/node", 0o700);
    await directory(join(this.data, ".vega-identities"), 0, 0, 0o700);
    this.db = new DatabaseSync(join(this.data, ".vega-identities", "users.sqlite"));
    this.db.exec("CREATE TABLE IF NOT EXISTS users(owner TEXT PRIMARY KEY,uid INTEGER UNIQUE NOT NULL)");
    const userRoot = join(this.workspace, ".vega-users");
    await directory(userRoot, 0, 0, 0o711);
    const rows = this.db.prepare("SELECT owner,uid FROM users").all(), known = new Map(rows.map((row) => [row.owner, row.uid]));
    // Lost identity data must never allocate an old UID to a new owner after an image replacement.
    for (const name of await readdir(userRoot)) {
      const st = await lstat(join(userRoot, name));
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || known.get(name) !== st.gid) throw Error("Cloud identity mapping does not match existing workspaces; restore both volumes from the same backup");
    }
    await mkdir(dirname(this.socket), { recursive: true, mode: 0o700 });
    await chown(dirname(this.socket), 1000, 1000); await chmod(dirname(this.socket), 0o700);
    await rm(this.socket, { force: true });
    // Recreate passwd/group entries after replacing the image; never reassign a saved UID.
    for (const row of rows) await this.ensure(row.owner);
    this.server = createServer((socket) => this.accept(socket));
    await new Promise((yes, no) => { this.server.once("error", no); this.server.listen(this.socket, yes); });
    await chown(this.socket, 1000, 1000); await chmod(this.socket, 0o600);
  }
  ensure(owner) {
    validateOwner(owner);
    const pending = this.ready.get(owner);
    if (pending) return pending;
    const task = this.tail.then(async () => {
      let row = this.db.prepare("SELECT uid FROM users WHERE owner=?").get(owner);
      if (!row) {
        let uid = Number(this.db.prepare("SELECT COALESCE(MAX(uid),10000)+1 AS uid FROM users").get().uid);
        while (uid < 60000 && (lookup("passwd", uid) || lookup("group", uid))) uid++;
        if (uid >= 60000) throw Error("Cloud UID range exhausted");
        this.db.prepare("INSERT INTO users VALUES(?,?)").run(owner, uid);
        row = { uid };
      }
      const uid = Number(row.uid);
      if (!Number.isInteger(uid) || uid < 10001 || uid >= 60000) throw Error("Invalid saved cloud UID");
      const name = "vega_u" + uid, guard = join(this.workspace, ".vega-users", owner);
      const identity = { owner, uid, name, home: join(guard, "home"), cwd: join(guard, "workspace"), tmp: join(guard, "tmp") };
      const account = lookup("passwd", uid), named = lookup("passwd", name), group = lookup("group", uid), namedGroup = lookup("group", name);
      if ((account && account[0] !== name) || (named && Number(named[2]) !== uid) || (group && group[0] !== name) || (namedGroup && Number(namedGroup[2]) !== uid)) throw Error("Saved cloud UID/GID conflicts with a system account");
      if (!group) system("/usr/sbin/groupadd", ["--gid", String(uid), name]);
      if (!account) system("/usr/sbin/useradd", ["--uid", String(uid), "--gid", String(uid), "--no-create-home", "--home-dir", identity.home, "--shell", "/usr/sbin/nologin", name]);
      else if (Number(account[3]) !== uid || account[5] !== identity.home || account[6] !== "/usr/sbin/nologin") throw Error("Saved cloud account attributes changed");
      // Root owns the guard: a task cannot expose its private directory by chmod'ing its own workspace.
      await directory(guard, 0, uid, 0o710);
      await directory(identity.home, uid, uid, 0o700);
      await directory(identity.cwd, uid, uid, 0o700);
      await directory(identity.tmp, uid, uid, 0o700);
      system("/usr/bin/setpriv", [...dropPrivileges(identity), process.execPath, "-e", "require('node:fs').rmSync(process.argv[1], {recursive:true,force:true})", join(identity.tmp, "keys")]);
      return identity;
    });
    this.tail = task.catch(() => {});
    this.ready.set(owner, task);
    task.catch(() => this.ready.delete(owner));
    return task;
  }
  accept(socket) {
    this.sockets.add(socket);
    let requested = false, child, identity, executing = false, cleaned = false;
    const kill = () => {
      if (!child?.pid || cleaned) return;
      cleaned = true;
      // A reused process-group ID must not let cleanup signal another user's processes as root.
      if (executing) spawnSync("/usr/bin/setpriv", [...dropPrivileges(identity), process.execPath, "-e", "try{process.kill(-Number(process.argv[1]),'SIGKILL')}catch{}", String(child.pid)], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    socket.on("error", () => {});
    socket.on("close", () => { this.sockets.delete(socket); kill(); });
    socket.setTimeout(30000, () => { if (!requested) socket.destroy(); });
    frames(socket, (message) => {
      if (requested) {
        if (!child || ![0, 3].includes(message.fd)) return socket.destroy(Error("Invalid cloud input"));
        const stream = child.stdio[message.fd];
        if (message.end) stream?.end();
        else if (typeof message.data === "string" && message.data.length <= 2 * 1024 * 1024) {
          if (stream && !stream.write(Buffer.from(message.data, "base64"))) { socket.pause(); stream.once("drain", () => socket.resume()); }
        } else socket.destroy(Error("Invalid cloud input"));
        return;
      }
      requested = true;
      void (async () => {
        const request = decode(message);
        if (request.kind === "health") { send(socket, { healthy: true }); return socket.end(); }
        identity = await this.ensure(request.owner);
        if (socket.destroyed) return;
        if (request.kind === "ensure") { send(socket, { identity }); return socket.end(); }
        if (!["fs", "exec"].includes(request.kind)) throw Error("Invalid cloud operation");
        const filesystem = request.kind === "fs";
        executing = !filesystem;
        const command = filesystem ? process.execPath : request.command;
        const args = filesystem ? [join(here, "cloud-worker.mjs")] : request.args || [];
        if (typeof command !== "string" || !command || command.includes("\0") || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw Error("Invalid cloud command");
        const env = tenantEnvironment(identity);
        if (!filesystem) {
          tenantEnvironment(identity, request.env); // Validate, but never give user variables to the privileged setpriv loader.
          env.VEGA_CLOUD_LAUNCH = JSON.stringify({ command, args, cwd: request.cwd || identity.cwd, env: request.env || {} });
        }
        child = spawn("/usr/bin/setpriv", [...dropPrivileges(identity), process.execPath, join(here, filesystem ? "cloud-worker.mjs" : "cloud-run.mjs")], {
          cwd: "/", env, detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        });
        this.children.set(child, kill);
        for (const stream of child.stdio) stream?.on("error", () => {});
        for (const fd of [1, 2, 4]) child.stdio[fd].on("data", (data) => {
          if (!send(socket, { fd, data: data.toString("base64") })) { child.stdio[fd].pause(); socket.once("drain", () => child.stdio[fd].resume()); }
        });
        child.once("error", (error) => { send(socket, { error: error.message }); socket.end(); });
        child.once("close", (code) => {
          this.children.delete(child); kill(); send(socket, { exit: code ?? 1 }); socket.end();
        });
        if (filesystem) child.stdin.end(JSON.stringify(encode({ method: request.method, args: request.args })));
        else send(socket, { ready: true });
      })().catch((error) => { send(socket, { error: error.message, code: error.code }); socket.end(); });
    });
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    for (const kill of this.children.values()) kill();
    if (this.server) await new Promise((yes) => this.server.close(yes));
    this.db?.close();
  }
}

async function main() {
  const supervisor = new CloudSupervisor();
  await supervisor.start();
  // The web service remains UID 1000. Only this fixed launcher retains identity-management privileges.
  const app = spawn("/usr/bin/setpriv", [...dropPrivileges({ uid: 1000 }), process.execPath, join(here, "start.mjs")], {
    env: { ...serviceEnvironment(), VEGA_CLOUD_ISOLATION: "1", VEGA_CLOUD_SOCKET: supervisor.socket }, stdio: "inherit",
  });
  const stop = () => app.kill("SIGTERM");
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const code = await new Promise((yes) => { app.once("exit", (code) => yes(code ?? 1)); app.once("error", () => yes(1)); });
  await supervisor.close(); process.exitCode = code;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error("[Vega] cloud isolation startup failed:", error.message); process.exitCode = 1; });
