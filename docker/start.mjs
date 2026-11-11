import { spawn } from "node:child_process";
import { mkdir, access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { apiAddress, connected } from "./healthcheck.mjs";

export function chromiumArguments(profile, extension, sandbox = "0") {
  if (!["0", "1"].includes(sandbox))
    throw Error("VEGA_CHROMIUM_NO_SANDBOX must be 0 or 1");
  return [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--password-store=basic",
    // No debugging bar resizing the viewport on attach; only the Vega extension runs in this profile.
    "--silent-debugger-extension-api",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    ...(sandbox === "1" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

export async function supervise() {
  if (process.platform !== "linux")
    throw Error("This launcher is for the Linux Docker image");
  process.umask(0o077);
  const app = fileURLToPath(new URL("../", import.meta.url));
  const env = {
    ...process.env,
    NITRO_HOST: "0.0.0.0",
    VEGA_CHROME_PORT: "47753",
    VEGA_BROWSER_MODE: "isolated",
    VEGA_CHROMIUM_EXTERNAL: "1",
  };
  const address = apiAddress(env);
  const profile = "/data/chromium",
    extension = join(app, "extension");
  const args = chromiumArguments(
    profile,
    extension,
    env.VEGA_CHROMIUM_NO_SANDBOX || "0",
  );
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  if (manifest.manifest_version !== 3 || !manifest.key)
    throw Error("Bundled Chrome extension manifest/key missing");
  for (const path of ["/data", profile, "/data/downloads", "/workspace"]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await access(path, constants.W_OK);
  }
  if (args.includes("--no-sandbox"))
    console.warn(
      "[Vega] Chromium sandbox explicitly disabled. Do not expose this container to untrusted users or mount host credentials.",
    );
  const children = [];
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, requestStop);
  const launch = (name, command, args) => {
    const child = spawn(command, args, {
      cwd: "/workspace",
      env,
      stdio: "inherit",
      detached: true,
    });
    const state = { name, child, exit: null, done: null };
    state.done = new Promise((resolve) => {
      child.once("error", (error) => {
        state.exit = 1;
        console.error(`[Vega] ${name}: ${error.message}`);
        resolve(1);
      });
      child.once("exit", (code, signal) => {
        state.exit = code ?? 1;
        if (!stop.signal.aborted)
          console.error(`[Vega] ${name} exited (${code ?? signal})`);
        resolve(state.exit);
      });
    });
    children.push(state);
    return state;
  };
  const alive = () => {
    const failed = children.find((child) => child.exit !== null);
    if (failed)
      throw Error(
        `${failed.name} stopped. Check the logs above. Chromium requires a working Linux sandbox; no automatic --no-sandbox fallback is performed.`,
      );
    stop.signal.throwIfAborted();
  };
  let stopped;
  try {
    stopped = new Promise((resolve) =>
      stop.signal.addEventListener("abort", () => resolve(0), { once: true }),
    );
    launch("Nitro", process.execPath, [join(app, ".output/server/index.mjs")]);
    let ready = false;
    for (const deadline = Date.now() + 30000; Date.now() < deadline; ) {
      alive();
      try {
        const response = await fetch(address, {
          headers: { Authorization: `Bearer ${env.VEGA_TOKEN}` },
          signal: AbortSignal.timeout(1000),
        });
        ready = response.ok;
        await response.body?.cancel();
      } catch {}
      if (ready) break;
      await delay(250, undefined, { signal: stop.signal });
    }
    if (!ready)
      throw Error("Nitro did not become ready within the startup budget");
    if (env.VEGA_CLOUD_ISOLATION === "1") {
      if (!await connected(env)) throw Error("Cloud identity executor is not ready");
      console.info("[Vega] Per-user cloud execution ready; private browsers start on demand.");
      const result = await Promise.race([stopped, ...children.map((child) => child.done)]);
      return stop.signal.aborted ? 0 : result || 1;
    }
    launch("Chromium", "/usr/bin/chromium", args);
    let paired = false;
    for (const deadline = Date.now() + 50000; Date.now() < deadline; ) {
      alive();
      try {
        paired = await connected(env);
      } catch {}
      if (paired) break;
      await delay(500, undefined, { signal: stop.signal });
    }
    if (!paired)
      throw Error(
        "Chrome extension did not pair within the startup budget; inspect Chromium/extension logs",
      );
    console.info(
      `[Vega] Chromium extension ${manifest.version} loaded and paired. Open the published web port; no debugger or bridge port is exposed.`,
    );
    const result = await Promise.race([
      stopped,
      ...children.map((child) => child.done),
    ]);
    return stop.signal.aborted ? 0 : result || 1;
  } catch (error) {
    if (stop.signal.aborted) return 0;
    throw error;
  } finally {
    stop.abort();
    for (const { child } of children)
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
    const kill = setTimeout(() => {
      for (const { child } of children)
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
    }, 10000);
    try {
      await Promise.all(children.map((child) => child.done));
    } finally {
      clearTimeout(kill);
    }
    for (const signal of ["SIGTERM", "SIGINT"])
      process.off(signal, requestStop);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await supervise();
  } catch (error) {
    console.error(`[Vega] Container startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
