import * as fs from "node:fs/promises";
import { encode, decode, MAX_FRAME } from "../shared/cloud-wire.mjs";

// Only this fixed worker is used for filesystem RPC; it is already running with the tenant's UID.
const methods = new Set(["access", "readFile", "writeFile", "stat", "lstat", "mkdir", "rm", "realpath", "rename", "unlink", "chmod", "readdir", "cp", "mkdtemp", "readlink", "signal"]);
try {
  if (process.platform !== "linux" || process.getuid() < 10001 || process.geteuid() !== process.getuid()) throw Error("User filesystem identity missing");
  process.umask(0o077);
  const parts = []; let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > MAX_FRAME) throw Error("Cloud request too large");
    parts.push(part);
  }
  const { method, args } = decode(JSON.parse(Buffer.concat(parts).toString("utf8")));
  if (!methods.has(method) || !Array.isArray(args)) throw Error("Unsupported filesystem operation");
  if (method === "readFile") {
    const st = await fs.stat(args[0]);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) throw Error("Regular file up to 64MiB required");
  }
  let value;
  if (method === "signal") {
    if (!Number.isInteger(args[0]) || args[0] === 0 || ![0, "SIGTERM", "SIGKILL"].includes(args[1])) throw Error("Invalid process signal");
    value = process.kill(args[0], args[1]);
  } else value = await fs[method](...args);
  const describe = (entry) => ({ name: entry.name, size: entry.size, mode: entry.mode, uid: entry.uid, gid: entry.gid,
    file: entry.isFile(), directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
  if (method === "stat" || method === "lstat") value = describe(value);
  if (method === "readdir" && args[1]?.withFileTypes) value = value.map(describe);
  process.stdout.write(JSON.stringify({ value: encode(value) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message, code: error.code }));
  process.exitCode = 1;
}
