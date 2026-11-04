import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessBrowser, killBrowsersSync, reclaimProfile } from "../server/core/headless";
import { EmployeeBrowsers } from "../server/core/employee-browsers";
import { Store } from "../server/core/store";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";

const linux = platform() === "linux";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await new Promise(r => setTimeout(r, 25)); return check(); };

async function dir(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "vega-headless-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function sleeper(t: TestContext, profile: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
  return child.pid!;
}
async function fakeChrome(t: TestContext, body: string) {
  const root = await dir(t), path = join(root, "chrome");
  await writeFile(path, `#!${process.execPath}\n${body}`);
  await chmod(path, 0o755);
  const previous = process.env.VEGA_CHROME_PATH;
  process.env.VEGA_CHROME_PATH = path;
  t.after(() => { if (previous === undefined) delete process.env.VEGA_CHROME_PATH; else process.env.VEGA_CHROME_PATH = previous; });
  return root;
}

test("an orphan Chromium on exactly this profile is killed and its locks removed", { skip: !linux }, async (t) => {
  const profile = await dir(t), pid = sleeper(t, profile);
  await symlink(`${hostname()}-${pid}`, join(profile, "SingletonLock"));
  await writeFile(join(profile, "SingletonCookie"), "");
  assert.equal(await reclaimProfile(profile), "killed");
  assert(await until(() => !alive(pid)));
  await assert.rejects(readlink(join(profile, "SingletonLock")));
});

test("a live process on another profile is never killed and its lock is left alone", { skip: !linux }, async (t) => {
  const profile = await dir(t), pid = sleeper(t, profile + "-other");
  await symlink(`${hostname()}-${pid}`, join(profile, "SingletonLock"));
  assert.equal(await reclaimProfile(profile), "foreign");
  assert(alive(pid));
  assert.equal(await readlink(join(profile, "SingletonLock")), `${hostname()}-${pid}`);
});

test("locks from a dead holder or a recreated container host are stale and removed", { skip: !linux }, async (t) => {
  const profile = await dir(t);
  await symlink(`old-container-${process.pid}`, join(profile, "SingletonLock"));
  assert.equal(await reclaimProfile(profile), "stale");
  await assert.rejects(readlink(join(profile, "SingletonLock")));
  assert.equal(await reclaimProfile(profile), "none");
});

test("a Chromium that exits at startup reports exit code, profile-in-use and stderr instead of ECONNRESET", { skip: !linux }, async (t) => {
  await fakeChrome(t, `process.stderr.write("x".repeat(10000) + "\\nThe profile appears to be in use by another Chromium process\\n"); process.exit(21);`);
  const profile = await dir(t), browser = new HeadlessBrowser();
  await assert.rejects(browser.start(join(profile, "vega.db"), { profile, port: 1, token: "t" }), (error: Error) => {
    assert.match(error.message, /^牛马浏览器 Chromium 启动即退出（code 21）/);
    assert.match(error.message, /配置目录正被残留 Chromium 占用/);
    assert.match(error.message, /profile appears to be in use/);
    assert(error.message.length < 2500, "stderr is clipped to its tail");
    return true;
  });
  assert.equal(browser.child, undefined);
});

const responder = `
const fs = require("fs"), { spawn } = require("child_process");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref();
process.on("SIGTERM", () => {});
fs.createReadStream(null, { fd: 3 }).on("data", () => {});
fs.createWriteStream(null, { fd: 4 }).write(JSON.stringify({ id: 1, result: {} }) + "\\0");
process.stderr.write("y".repeat(200000));
setInterval(() => {}, 1000);
`;

test("process exit kills the whole private Chromium process group synchronously", { skip: !linux }, async (t) => {
  await fakeChrome(t, responder);
  const profile = await dir(t), browser = new HeadlessBrowser();
  await browser.start(join(profile, "vega.db"), { profile, port: 1, token: "t" });
  const pid = browser.child!.pid!;
  t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
  assert(alive(pid), "a chatty stderr does not block startup");
  const group = () => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  assert(group());
  killBrowsersSync();
  assert(await until(() => !group()), "browser and its helpers are gone");
});

test("close escalates to killing the process group when Chromium ignores Browser.close", { skip: !linux, timeout: 15000 }, async (t) => {
  await fakeChrome(t, responder);
  const profile = await dir(t), browser = new HeadlessBrowser();
  await browser.start(join(profile, "vega.db"), { profile, port: 1, token: "t" });
  const pid = browser.child!.pid!;
  t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
  await browser.close();
  const group = () => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  assert(await until(() => !group()));
});

test("repeated launch failures back off, are reported by status, and reset on success", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const store = await Store.open(":memory:"), browsers = new EmployeeBrowsers(store, "");
  t.after(async () => { await browsers.close(); await store.close(); });
  const entry = { chrome: new Chrome(store, new ChromeBridge(true), ""), browser: new HeadlessBrowser() } as any;
  browsers.entries.set("ea", entry);
  t.mock.method(entry.chrome.bridge, "start", async () => {});
  const start = t.mock.method(entry.browser, "start", async () => { throw Error("牛马浏览器 Chromium 启动即退出（code 21）"); });
  await assert.rejects(browsers.get("ea"), (e: Error) => !/秒后/.test(e.message));
  await assert.rejects(browsers.get("ea"), /已连续失败 2 次，5 秒后/);
  await assert.rejects(browsers.get("ea"), /code 21.*5 秒后才会再次尝试/);
  assert.equal(start.mock.callCount(), 2, "no respawn during backoff");
  assert.deepEqual({ ...browsers.failure("ea"), at: undefined }, { error: "牛马浏览器 Chromium 启动即退出（code 21）", failures: 2, at: undefined, retryAfterSeconds: 5 });
  t.mock.timers.tick(5001);
  await assert.rejects(browsers.get("ea"), /3 次，15 秒后/);
  t.mock.timers.tick(15001);
  await assert.rejects(browsers.get("ea"), /4 次，60 秒后/);
  t.mock.timers.tick(60001);
  await assert.rejects(browsers.get("ea"), /5 次，60 秒后/);
  start.mock.mockImplementation(async () => { throw Error("bridge port busy"); });
  t.mock.timers.tick(60001);
  await assert.rejects(browsers.get("ea"), /^Error: 牛马浏览器启动失败：bridge port busy/);
  await browsers.stop("ea");
  assert.equal(browsers.failure("ea"), undefined, "an explicit stop/refresh retries immediately");
});

test("real Chromium: a private instance starts over an orphan holding the same profile", { skip: !linux || process.env.VEGA_TEST_CHROME !== "1", timeout: 60000 }, async (t) => {
  const binary = process.env.VEGA_CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  assert(binary, "Chrome required");
  const profile = await dir(t);
  const args = ["--headless=new", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"];
  if (process.env.VEGA_CHROMIUM_NO_SANDBOX === "1") args.unshift("--no-sandbox");
  const orphan = spawn(binary!, args, { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-orphan.pid!, "SIGKILL"); } catch {} });
  assert(await until(() => { try { readlinkSync(join(profile, "SingletonLock")); return true; } catch { return false; } }, 15000), "orphan took the profile lock");
  const browser = new HeadlessBrowser();
  t.after(() => browser.close());
  await browser.start(join(profile, "vega.db"), { profile, port: 1, token: "t" });
  assert(browser.child?.pid && alive(browser.child.pid));
  assert(await until(() => !alive(orphan.pid!)), "the orphan was reclaimed");
});
