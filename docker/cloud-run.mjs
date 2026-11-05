import { spawn } from "node:child_process";

// Chdir and user-supplied environment are applied only AFTER setpriv drops UID and capabilities.
// Applying either to setpriv itself would let a task bypass directory traversal checks or preload code as root.
const request = JSON.parse(process.env.VEGA_CLOUD_LAUNCH || "null");
delete process.env.VEGA_CLOUD_LAUNCH;
if (!request || process.platform !== "linux" || process.getuid() < 10001 || process.geteuid() !== process.getuid()) throw Error("User execution identity missing");
process.umask(0o077);
const child = spawn(request.command, request.args, {
  cwd: request.cwd, env: { ...process.env, ...request.env }, stdio: [0, 1, 2, 3, 4],
});
child.on("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
