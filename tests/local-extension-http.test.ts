import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { MIN_CLIENT_VERSION } from "../server/core/client-socket";

test("deployed device endpoint creates an installation task on the authenticated client", { skip: process.env.VEGA_TEST_DEPLOYED !== "1", timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vega-extension-http-"));
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as any).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`, token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [resolve(".output/server/index.mjs")], {
    env: { ...process.env, NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), VEGA_PUBLIC_URL: base, VEGA_TOKEN: token, VEGA_DB: join(directory, "db.sqlite"), VEGA_CHROMIUM_EXTERNAL: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let logs = "";
  child.stdout!.on("data", (chunk) => { logs += chunk; });
  child.stderr!.on("data", (chunk) => { logs += chunk; });
  const controller = new AbortController();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw Error(logs);
      try {
        const response = await fetch(base + "/api/health", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await sleep(50);
    }
    assert(ready, logs);
    const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setupToken: token, username: "admin", password: "extension-http-fixture-password" }) });
    assert.equal(setup.status, 200, await setup.clone().text());
    const login: any = await setup.json(), cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const website = { Cookie: cookie, "X-CSRF-Token": login.csrfToken, "Content-Type": "application/json" };
    const boot = await fetch(base + "/api/bootstrap", { headers: website });
    assert(boot.ok, await boot.text());
    const employees: any[] = await (await fetch(base + "/api/employees", { headers: website })).json() as any[];
    assert(employees.length);
    const instance = "a".repeat(32), clientId = "d".repeat(32);
    const ticketResponse = await fetch(base + "/api/local-agent/ticket", { method: "POST", headers: website, body: JSON.stringify({ instance }) });
    assert(ticketResponse.ok, await ticketResponse.clone().text());
    const ticket: any = await ticketResponse.json();
    const pair = await fetch(base + "/api/local-agent/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: ticket.ticket, clientId }) });
    assert(pair.ok, await pair.clone().text());
    const proof: any = await pair.json(), device = { Authorization: "Bearer " + proof.deviceToken, "Content-Type": "application/json" };
    const stream = await fetch(base + "/api/local-agent/socket", { headers: device, signal: controller.signal });
    assert.equal(stream.status, 200);
    const frames: any[] = [], reader = stream.body!.getReader(), decoder = new TextDecoder();
    void (async () => {
      let pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          pending += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, cut); pending = pending.slice(cut + 2);
            if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)));
          }
        }
      } catch {}
    })();
    const until = async (predicate: () => boolean) => { for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await sleep(25); assert(predicate(), logs); };
    await until(() => frames.some((frame) => frame.type === "channel"));
    const channel = frames.find((frame) => frame.type === "channel").channel;
    const hello = await fetch(base + "/api/local-agent/socket", { method: "POST", headers: device, body: JSON.stringify({ channel, message: { type: "hello", clientId, instance, name: "Fixture PC", cwd: "C:\\work", platform: "windows", version: MIN_CLIENT_VERSION, resume: true } }) });
    assert(hello.ok, await hello.text());
    await until(() => frames.some((frame) => frame.type === "ready"));
    const payload = JSON.stringify({ path: "C:\\extension\\vega-chrome" });
    const withoutToken = await fetch(base + "/api/local-agent/extension", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    assert.equal(withoutToken.status, 403);
    const browserOrigin = await fetch(base + "/api/local-agent/extension", { method: "POST", headers: { ...device, Origin: base }, body: payload });
    assert.equal(browserOrigin.status, 403);
    const install = await fetch(base + "/api/local-agent/extension", { method: "POST", headers: device, body: payload });
    assert.equal(install.status, 200, await install.clone().text());
    const result: any = await install.json();
    const response = await fetch(base + "/api/employees/" + result.employeeId, { headers: website });
    assert(response.ok, await response.clone().text());
    const employee: any = await response.json();
    const task = employee.tasks.find((item: any) => item.text.includes("C:\\extension\\vega-chrome"));
    assert(task, "installation task not persisted");
    assert.equal(task.execution.localAgent, true);
    assert.equal(task.execution.localBrowser, true);
    assert.equal(task.execution.clientId, clientId);
    assert.equal(task.execution.localPlatform, "windows");
    assert.equal(task.cwd, "C:\\work");
  } finally {
    controller.abort();
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), sleep(4000)]);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
