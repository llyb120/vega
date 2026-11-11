import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../server/core/store";
import { sleep } from "../server/core/util";

/** Reads an SSE response as JSON events, the way the page's fetch-based stream does. */
async function stream(response: Response) {
  const messages: any[] = [], reader = response.body!.getReader(), decoder = new TextDecoder();
  let pending = "", closed = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          if (block.startsWith("data: ")) messages.push(JSON.parse(block.slice("data: ".length)));
        }
      }
    } catch {} finally { closed = true; }
  })();
  return {
    messages,
    get closed() { return closed; },
    until: async (ready: () => boolean) => {
      for (let i = 0; i < 200 && !ready(); i++) await sleep(10);
      assert(ready(), "stream timed out");
    },
    stop: () => reader.cancel().catch(() => {}),
  };
}

test(
  "deployed realtime events: ticket auth, events-only stream, replay cursor; API stays on HTTP",
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
    const opened: { stop: () => void }[] = [];
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
      const connect = async (cookie: string, origin = base, query = "") => {
        const ticket = await request("/events", "POST", {}, login);
        assert(ticket.response.ok, JSON.stringify(ticket.value) + logs);
        return await fetch(base + "/api/events?ticket=" + ticket.value.ticket + query, {
          headers: { ...(cookie ? { cookie } : {}), origin },
        });
      };
      const open = async (cookie: string, origin = base, query = "") => {
        const response = await connect(cookie, origin, query);
        assert(response.ok, "stream refused: " + response.status + logs);
        const page = await stream(response);
        opened.push(page);
        await page.until(() => page.messages.some((v: any) => v.type === "ready"));
        return page;
      };
      assert.equal((await connect("")).status, 401, "a stream without the login cookie is refused as unauthenticated, never opened");
      assert.equal((await connect(login.cookie, "https://evil.test")).status, 403);
      // 浏览器对同源 GET 不带 Origin（只有 POST 和跳源请求才带），事件流必须照样开；
      // 跨站信号仍被 sec-fetch-site 拦住。这两条就是“网页里永远 403”那个故障的回归。
      const browserTicket = (await request("/events", "POST", {}, login)).value.ticket;
      const browserStream = await fetch(
        base + "/api/events?ticket=" + browserTicket,
        { headers: { cookie: login.cookie, "sec-fetch-site": "same-origin" } },
      );
      assert.equal(browserStream.status, 200, "同源 GET 没有 Origin 也不能当成跨站");
      const browserPage = await stream(browserStream);
      opened.push(browserPage);
      await browserPage.until(() => browserPage.messages.some((v: any) => v.type === "ready"));
      const crossSiteTicket = (await request("/events", "POST", {}, login)).value.ticket;
      assert.equal(
        (await fetch(base + "/api/events?ticket=" + crossSiteTicket, { headers: { cookie: login.cookie, "sec-fetch-site": "cross-site" } })).status,
        403,
        "跨站请求仍然拒绝",
      );
      const page = await open(login.cookie);
      const hello = page.messages.find((v: any) => v.type === "ready");
      assert.equal(typeof hello.epoch, "string");
      // Upstream is HTTP only: the stream never carries API calls, and no frames can be sent into it.
      page.messages.length = 0;
      const replay = await open(login.cookie, base, "&since=" + hello.epoch + ":" + hello.seq);
      assert.equal(replay.messages.find((v: any) => v.type === "ready").replayed, true);
      const history = await request("/sessions/" + seeded.id, "GET", undefined, login);
      assert.equal(history.response.ok, true);
      assert.equal(history.value.messages[0].text.length, 300000);
      assert.equal(history.response.headers.get("content-encoding"), "gzip", "large JSON is compressed");
      assert.ok(history.value.context, "a full read includes the context budget");
      const incremental = await request("/sessions/" + seeded.id + "?after=1", "GET", undefined, login);
      assert.equal(incremental.value.context, undefined, "incremental reads skip the budget");
      const plain = await fetch(base + "/api/events", { headers: { cookie: login.cookie } });
      assert.equal(plain.status, 403, "a stream without a ticket is refused");
      assert.match(plain.headers.get("content-type") || "", /application\/json/, "refusals are JSON, never a stream");
      const unauthenticated = await fetch(base + "/api/events?ticket=deadbeef");
      assert.equal(unauthenticated.status, 401, "an anonymous stream is refused as unauthenticated");
      page.stop();
    } finally {
      for (const page of opened) page.stop();
      child.kill();
      await new Promise((yes) => child.once("exit", yes));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
