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
  "deployed realtime events: ticket auth, events-only socket, replay cursor; API stays on HTTP",
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
      store = await Store.open(db),
      seeded = await store.newSession({ title: "large history", cwd: dir });
    await store.append(seeded.id, { role: "assistant", text: "x".repeat(300000) });
    await store.close();
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
      const open = async (cookie: string, origin = base, query = "") => {
        const ticket = await request("/events", "POST", {}, login);
        assert(ticket.response.ok, JSON.stringify(ticket.value) + logs);
        const ws = new WebSocket(
          base.replace("http:", "ws:") + "/api/events?ticket=" + ticket.value.ticket + query,
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
      const hello = messages.find((v) => v.type === "ready");
      assert.equal(typeof hello.epoch, "string");
      ws.send(JSON.stringify({ type: "request", id: "request-bootstrap", method: "GET", path: "/bootstrap" }));
      for (let i = 0; i < 100 && !messages.some((v) => v.type === "error"); i++) await sleep(10);
      assert.match(messages.find((v) => v.type === "error").reason, /只接收订阅/, "API calls are not tunnelled");
      ws.send(JSON.stringify({ type: "subscribe", sessions: [seeded.id] }));
      ws.send(JSON.stringify({ type: "ping" }));
      for (let i = 0; i < 100 && !messages.some((v) => v.type === "pong"); i++) await sleep(10);
      assert.equal(messages.find((v) => v.type === "pong").epoch, hello.epoch);
      const replay = await open(login.cookie, base, "&since=" + hello.epoch + ":" + hello.seq);
      assert.equal(replay.messages.find((v) => v.type === "ready").replayed, true);
      const history = await request("/sessions/" + seeded.id, "GET", undefined, login);
      assert.equal(history.response.ok, true);
      assert.equal(history.value.messages[0].text.length, 300000);
      assert.equal(history.response.headers.get("content-encoding"), "gzip", "large JSON is compressed");
      assert.ok(history.value.context, "a full read includes the context budget");
      const incremental = await request("/sessions/" + seeded.id + "?after=1", "GET", undefined, login);
      assert.equal(incremental.value.context, undefined, "incremental reads skip the budget");
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
