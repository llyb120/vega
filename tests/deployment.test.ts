import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { sleep } from "../server/core/util";
import WebSocket from "ws";
test(
  "built Nitro deployment: bundled frontend/assets, auth, streaming agent, SQLite tasks, restart",
  { timeout: 45000, skip: process.env.VEGA_TEST_DEPLOYED !== "1" },
  async () => {
    assert(existsSync(".output/server/index.mjs"), "Build Nitro first");
    const dir = await mkdtemp(join(tmpdir(), "vega-deploy-"));
    let calls = 0;
    const mock = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls++;
      res.setHeader("Content-Type", "text/event-stream");
      const message =
        calls === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "write-once",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      path: "result.txt",
                      content: "persisted once",
                    }),
                  },
                },
              ],
            }
          : {
              content: JSON.stringify(body.messages || []).includes(
                "独立验收者",
              )
                ? "Actual fixture verified\nFIRE_ACCEPTED"
                : "Complete from deployed Nitro",
            };
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: message,
                finish_reason: message.tool_calls ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((yes) => mock.listen(0, "127.0.0.1", yes));
    const reservation = createServer();
    await new Promise<void>((yes) => reservation.listen(0, "127.0.0.1", yes));
    const port = (reservation.address() as any).port;
    await new Promise<void>((yes) => reservation.close(() => yes()));
    const base = `http://127.0.0.1:${port}`,
      token = randomBytes(32).toString("base64url"),
      entry = resolve(".output/server/index.mjs");
    let child: ReturnType<typeof spawn> | undefined,
      log = "";
    const env = {
      ...process.env,
      VEGA_DB: join(dir, "app.db"),
      VEGA_SKILL_CACHE: join(dir, "skill-cache"),
      VEGA_TOKEN: token,
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
    };
    const start = async () => {
      child = spawn(process.execPath, [entry], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout!.on("data", (b) => (log += b));
      child.stderr!.on("data", (b) => (log += b));
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw Error(log);
        try {
          const r = await fetch(base + "/api/health", {
            headers: { Authorization: "Bearer " + token },
          });
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await sleep(50);
      }
      assert(ready, log);
    };
    const stop = async () => {
      if (!child || child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((yes, no) => {
        const timer = setTimeout(() => {
          child?.kill("SIGKILL");
          no(Error("Nitro shutdown timed out"));
        }, 5000);
        child!.once("exit", () => {
          clearTimeout(timer);
          yes();
        });
      });
    };
    let cookie = "",
      csrf = "",
      realtime: WebSocket | undefined;
    const api = async (path: string, method = "GET", data?: any) => {
      const r = await fetch(base + "/api" + path, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie")!.split(";")[0];
      const value = await r.json();
      if (value.csrfToken) csrf = value.csrfToken;
      assert(r.ok, JSON.stringify(value));
      return value;
    };
    try {
      await start();
      const unauth = await fetch(base + "/api/bootstrap");
      assert.equal(unauth.status, 401);
      await unauth.text();
      const badOrigin = await fetch(base + "/api/bootstrap", {
        headers: {
          Authorization: "Bearer " + token,
          Origin: "https://evil.test",
        },
      });
      assert.equal(badOrigin.status, 403);
      await badOrigin.text();
      const html = await fetch(base + "/");
      assert.equal(html.status, 200);
      assert.match(await html.text(), /assets\/index/);
      const extension = await fetch(
        base + "/extension/nova-chrome/manifest.json",
      );
      assert.equal(extension.status, 200);
      assert.equal((await extension.json()).version, "0.1.16");
      const signed = await api("/auth/setup", "POST", {
        setupToken: token,
        username: "deployed-admin",
        password: "valid deployment fixture password",
      });
      assert.equal(signed.user.role, "admin");
      const config = {
        model: "test/m",
        provider: {
          test: {
            api: "openai-completions",
            baseURL: `http://127.0.0.1:${(mock.address() as any).port}`,
            apiKey: "private-api-key",
            models: { m: { limit: { context: 128000, output: 8192 } } },
          },
        },
        contextMode: "acp",
      };
      const saved = await api("/config", "PUT", config);
      assert.equal(saved.provider.test.apiKey, "__stored_secret__");
      const session = await api("/sessions", "POST", { cwd: dir });
      const { ticket } = await api("/events", "POST", {});
      realtime = new WebSocket(
        base.replace("http:", "ws:") + "/api/events?ticket=" + ticket,
        { headers: { Cookie: cookie, Origin: base } },
      );
      let events = "";
      const reading = new Promise<void>((resolve, reject) => {
        realtime!.on("message", (data) => {
          events += data.toString();
          if (events.includes('"type":"done"')) resolve();
        });
        realtime!.on("error", reject);
      });
      await new Promise<void>((yes, no) => {
        realtime!.once("open", yes);
        realtime!.once("error", no);
      });
      await api(`/sessions/${session.id}/messages`, "POST", {
        text: "Write the local fixture once",
      });
      await Promise.race([
        reading,
        sleep(10000).then(() => {
          throw Error("WebSocket completion not observed");
        }),
      ]);
      realtime.close();
      assert(events.includes("tool_end"));
      assert.equal(
        await readFile(join(dir, "result.txt"), "utf8"),
        "persisted once",
      );
      const detail = await api("/sessions/" + session.id);
      assert(
        detail.messages.some(
          (m: any) => m.text === "Complete from deployed Nitro",
        ),
      );
      assert.equal(calls, 2);
      const task = await api("/employee", "POST", {
        action: "add",
        kind: "todo",
        text: "stored not executed while disabled",
        key: "fixture:task",
      });
      const duty = await api("/employee", "POST", {
        action: "add",
        kind: "duty",
        text: "manual fixture",
        manual: true,
      });
      assert(task.id && duty.id);
      const skillDir = join(dir, "fixture-skill");
      await mkdir(join(skillDir, "scripts"), { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: deployment-fixture\ndescription: only a smoke fixture\n---\nRead scripts/helper.mjs when explicitly asked.",
      );
      await writeFile(
        join(skillDir, "scripts/helper.mjs"),
        'console.log("retained fixture")',
      );
      const imported = await api("/skills", "POST", { path: skillDir });
      assert(imported.files.includes("scripts/helper.mjs"));
      assert(
        (await api("/skills")).some(
          (s: any) => s.name === "deployment-fixture",
        ),
      );
      const budget = await api("/sessions/" + session.id);
      assert.equal(budget.context.window, 128000);
      const fireSession = await api("/sessions", "POST", { cwd: dir });
      await api(`/sessions/${fireSession.id}/messages`, "POST", {
        text: "/fire inspect the existing local fixture\n/target real fixture is present",
      });
      let fire: any;
      for (let i = 0; i < 100; i++) {
        fire = (await api("/sessions/" + fireSession.id)).fire;
        if (fire?.status === "accepted") break;
        assert(fire?.status !== "paused", JSON.stringify(fire));
        await sleep(20);
      }
      assert.equal(fire?.status, "accepted");
      assert.equal(fire.phases.length, 2);
      await stop();
      await start();
      const restored = await api("/employee");
      assert(restored.tasks.some((t: any) => t.id === task.id));
      assert(restored.duties.some((d: any) => d.id === duty.id));
      assert.equal(
        (await api("/sessions/" + fireSession.id)).fire.status,
        "accepted",
      );
      assert(
        (await api("/skills")).some(
          (s: any) => s.name === "deployment-fixture",
        ),
      );
      assert.equal((await api("/sessions/" + session.id)).messages.length, 4);
    } finally {
      realtime?.close();
      await stop();
      mock.closeAllConnections();
      await new Promise<void>((yes) => mock.close(() => yes()));
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
