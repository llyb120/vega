import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { Store } from "../server/core/store";
import { sleep } from "../server/core/util";

test(
  "deployed realtime API: ticket auth, CSRF-preserving WS calls, large-read HTTP fallback",
  { timeout: 60000, skip: process.env.VEGA_TEST_DEPLOYED !== "1" },
  async () => {
    const reserve = createServer();
    await new Promise<void>((yes) => reserve.listen(0, "127.0.0.1", yes));
    const port = (reserve.address() as any).port;
    await new Promise<void>((yes) => reserve.close(() => yes()));
    const base = "http://127.0.0.1:" + port,
      token = randomBytes(32).toString("base64url"),
      dir = await mkdtemp(join(tmpdir(), "vega-events-http-")),
      db = join(dir, "events.db"),
      store = new Store(db),
      seeded = store.newSession({ title: "large history", cwd: dir });
    store.append(seeded.id, { role: "assistant", text: "x".repeat(300000) });
    store.close();
    const child = spawn(process.execPath, [resolve(".output/server/index.mjs")], {
      env: {
        ...process.env,
        NITRO_HOST: "127.0.0.1",
        NITRO_PORT: String(port),
        VEGA_PUBLIC_URL: base,
        VEGA_TOKEN: token,
        VEGA_DB: db,
        VEGA_SKILL_CACHE: join(dir, "skills"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout!.on("data", (data) => (logs += data));
    child.stderr!.on("data", (data) => (logs += data));
    const sockets: WebSocket[] = [];
    const request = async (path: string, method = "GET", body?: any, login?: any) => {
      const response = await fetch(base + "/api" + path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(login ? { cookie: login.cookie, "x-csrf-token": login.csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { response, value: await response.json() };
    };
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await request("/auth/me")).response.ok) {
            ready = true;
            break;
          }
        } catch {}
        await sleep(50);
      }
      assert(ready, logs);
      const setup = await request("/auth/setup", "POST", {
        setupToken: token,
        username: "admin-events",
        password: "a-really-long-test-password",
      });
      assert(setup.response.ok, JSON.stringify(setup.value));
      const login = {
        cookie: setup.response.headers.get("set-cookie")!.split(";")[0],
        csrf: setup.value.csrfToken,
      };
      assert.equal(
        (await request("/events", "POST", {}, { ...login, csrf: "" })).response.status,
        403,
      );
      const ticket = await request("/events", "POST", {}, login);
      assert(ticket.response.ok, JSON.stringify(ticket.value) + logs);
      const open = async (cookie: string, origin = base) => {
        const ws = new WebSocket(
          base.replace("http:", "ws:") + "/api/events?ticket=" + ticket.value.ticket,
          { headers: { cookie, origin } },
        );
        sockets.push(ws);
        ws.on("error", () => {});
        const messages: any[] = [];
        ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
        await new Promise<void>((yes, no) => {
          ws.once("open", yes);
          ws.once("error", no);
          ws.once("unexpected-response", (_req, res) => {
            res.resume();
            no(Error("upgrade status " + res.statusCode));
          });
        });
        for (let i = 0; i < 100 && !messages.some((v) => v.type === "ready"); i++)
          await sleep(10);
        assert(messages.some((v) => v.type === "ready"));
        return { ws, messages };
      };
      await assert.rejects(() => open(""), /upgrade status 403/);
      await assert.rejects(() => open(login.cookie, "https://evil.test"), /upgrade status 403/);
      const { ws, messages } = await open(login.cookie);
      const call = async (id: string, path: string, method = "GET", data?: any) => {
        ws.send(JSON.stringify({ type: "request", id, method, path, data }));
        let message;
        for (let i = 0; i < 400; i++) {
          message = messages.find((v) => v.id === id);
          if (message) break;
          await sleep(10);
        }
        assert(message, "missing WS response " + id + logs);
        return message;
      };
      const bootstrap = await call("request-bootstrap", "/bootstrap");
      assert.equal(bootstrap.status, 200, bootstrap.error || bootstrap.body);
      assert.equal(JSON.parse(bootstrap.body).user.username, "admin-events");
      const created = await call("request-create", "/sessions", "POST", { title: "via WS", cwd: dir });
      assert.equal(created.status, 200, created.error || created.body + "\n" + logs);
      assert.equal(JSON.parse(created.body).title, "via WS");
      ws.send(JSON.stringify({ type: "request", id: "request-create", method: "POST", path: "/sessions", data: { title: "duplicate", cwd: dir } }));
      for (let i = 0; i < 100 && !messages.some((v) => v.type === "error" && v.reason.includes("重复")); i++)
        await sleep(10);
      assert(messages.some((v) => v.type === "error" && v.reason.includes("重复")));
      const afterDuplicate = await call("request-after-duplicate", "/bootstrap");
      assert.equal(
        JSON.parse(afterDuplicate.body).sessions.filter((s: any) => s.title === "via WS").length,
        1,
      );
      const large = await call("request-large", "/sessions/" + seeded.id);
      assert.equal(large.httpFallback, true);
      const history = await request("/sessions/" + seeded.id, "GET", undefined, login);
      assert.equal(history.response.ok, true);
      assert.equal(history.value.messages[0].text.length, 300000);
      const plain = await fetch(base + "/api/events", { headers: { cookie: login.cookie } });
      assert.notEqual(plain.headers.get("content-type"), "text/event-stream");
      ws.close();
    } finally {
      for (const ws of sockets) ws.close();
      child.kill();
      await new Promise((yes) => child.once("exit", yes));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
