import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { sleep, type Obj } from "../server/core/util";

test(
  "deployed live browser: one-use cookie/Origin/CSRF ticket, SSE frames, upstream input POSTs, disconnect release and revoke",
  {
    timeout: 60000,
    skip: process.env.VEGA_TEST_DEPLOYED !== "1",
  },
  async () => {
    const reserve = async () => {
      const server = createServer();
      await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
      const port = (server.address() as any).port;
      await new Promise<void>((yes) => server.close(() => yes()));
      return port;
    };
    const [port, bridgePort] = await Promise.all([reserve(), reserve()]),
      base = "http://127.0.0.1:" + port,
      bridge = "http://127.0.0.1:" + bridgePort,
      token = randomBytes(32).toString("base64url"),
      dir = await mkdtemp(join(tmpdir(), "vega-live-http-"));
    const child = spawn(
      process.execPath,
      [resolve(".output/server/index.mjs")],
      {
        env: {
          ...process.env,
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: String(port),
          NOVA_CHROME_PORT: String(bridgePort),
          VEGA_PUBLIC_URL: base,
          VEGA_TOKEN: token,
          VEGA_DB: join(dir, "live.db"),
          VEGA_SKILL_CACHE: join(dir, "skills"),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout!.on("data", (data) => (logs += data));
    child.stderr!.on("data", (data) => (logs += data));
    const abort = new AbortController(),
      streams: AbortController[] = [],
      calls: Obj[] = [];
    const state = {
      url: "https://remote.test/",
      title: "Remote SSE test",
      document: "document",
      stamp: "viewport",
      focus: { identity: 1, editable: true },
      width: 800,
      height: 600,
    };
    const image = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#ddeeff" },
    })
      .jpeg()
      .toBuffer();
    let poll: Promise<void> | undefined;
    const request = async (
      path: string,
      method = "GET",
      value?: Obj,
      login?: Obj,
    ) => {
      const response = await fetch(base + "/api" + path, {
        method,
        headers: {
          ...(value ? { "Content-Type": "application/json" } : {}),
          ...(login
            ? { Cookie: login.cookie, "X-CSRF-Token": login.csrf }
            : {}),
        },
        body: value ? JSON.stringify(value) : undefined,
      });
      return { response, value: await response.json() };
    };
    /**
     * Opens the downstream SSE the way the page does: lane 0 with the one-use ticket, then every gesture is a
     * plain POST carrying the channel id. `ended` is the equivalent of "the socket closed".
     */
    const open = async (ticket: string, login?: Obj, origin = base) => {
      const controller = new AbortController();
      streams.push(controller);
      const response = await fetch(
        base + "/api/chrome/live?ticket=" + ticket,
        {
          headers: {
            Accept: "text/event-stream",
            Origin: origin,
            ...(login?.cookie ? { Cookie: login.cookie } : {}),
          },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw Object.assign(
          Error("live stream refused: HTTP " + response.status),
          { status: response.status },
        );
      }
      const messages: Obj[] = [],
        channel = { id: "" };
      let settled!: () => void;
      const ended = new Promise<void>((yes) => (settled = yes));
      let queue: Promise<unknown> = Promise.resolve();
      const input = async (message: Obj) => {
        const posted = await fetch(base + "/api/chrome/live/input", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(login?.cookie ? { Cookie: login.cookie } : {}),
            ...(login?.csrf ? { "X-CSRF-Token": login.csrf } : {}),
          },
          body: JSON.stringify({ channel: channel.id, message }),
        });
        const text = await posted.text();
        if (!posted.ok)
          throw Error("input refused: HTTP " + posted.status + " " + text);
        return text;
      };
      const send = (value: Obj) => (queue = queue.then(() => input(value)));
      void (async () => {
        const reader = response.body!.getReader(),
          decoder = new TextDecoder();
        let pending = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            pending += decoder.decode(value, { stream: true });
            for (let cut; (cut = pending.indexOf("\n\n")) >= 0; ) {
              const block = pending.slice(0, cut);
              pending = pending.slice(cut + 2);
              const data = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue;
              const message = JSON.parse(data);
              if (message.type === "channel") {
                channel.id = String(message.channel);
                continue;
              }
              messages.push(message);
              if (message.type === "frame")
                void send({
                  type: "frame_ack",
                  frameId: message.frameId,
                }).catch(() => {});
            }
          }
        } catch {
          // An aborted stream is a deliberate disconnect, not a failure.
        } finally {
          settled();
        }
      })();
      const wait = async (
        type: string,
        predicate: (v: Obj) => boolean = () => true,
      ) => {
        for (let i = 0; i < 400; i++) {
          const m = messages.find((v) => v.type === type && predicate(v));
          if (m) return m;
          await sleep(10);
        }
        throw Error(
          "Missing " +
            type +
            JSON.stringify(
              messages.map((m) => ({ type: m.type, reason: m.reason })),
            ) +
            "\n" +
            logs,
        );
      };
      return {
        channel,
        messages,
        wait,
        ended,
        send,
        frame: () => messages.filter((m) => m.type === "frame").at(-1)!,
        close: () => controller.abort(),
      };
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
        username: "admin-live",
        password: "a-really-long-test-password",
      });
      assert(setup.response.ok, JSON.stringify(setup.value));
      const admin = {
        cookie: setup.response.headers.get("set-cookie")!.split(";")[0],
        csrf: setup.value.csrfToken,
      };
      const extension = "chrome-extension://mdicifjlbgnkkdkcbfdnebeghhlamjbm",
        clientId = randomUUID();
      const pair = await (
        await fetch(bridge + "/pair", {
          method: "POST",
          headers: { Origin: extension },
        })
      ).json();
      const post = async (path: string, value: Obj) =>
        (
          await fetch(bridge + path, {
            method: "POST",
            headers: {
              Origin: extension,
              Authorization: "Bearer " + pair.token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...value, clientId }),
            signal: abort.signal,
          })
        ).json();
      poll = (async () => {
        while (!abort.signal.aborted) {
          const { command } = await post("/poll", {});
          if (!command) continue;
          let result: Obj = {};
          const { operation, args } = command;
          if (operation === "tabs")
            result = {
              tabs: [
                {
                  tag: "C1-live",
                  url: state.url,
                  title: state.title,
                  controllable: true,
                  active: true,
                },
              ],
            };
          else if (operation === "cdp") {
            const { method, params } = args;
            calls.push({ method, params });
            if (method === "Page.getFrameTree")
              result = { frameTree: { frame: { id: "root", url: state.url } } };
            else if (method === "Target.getTargets")
              result = { targetInfos: [] };
            else if (method === "Page.createIsolatedWorld")
              result = { executionContextId: 1 };
            else if (method === "Page.captureScreenshot")
              result = { data: image.toString("base64") };
            else if (method === "Runtime.evaluate") {
              const value = params.expression.includes("__novaWebview.observe(")
                ? {
                    ...state,
                    items: [],
                    viewport: { width: 800, height: 600 },
                    documentSize: { width: 800, height: 600 },
                    text: "",
                  }
                : params.expression === "__novaWebview.inputState()"
                  ? state.focus
                  : state;
              result = { result: { value } };
            }
          } else if (operation === "goto") state.url = args.url;
          await post("/reply", { id: command.id, result });
        }
      })().catch((e) => {
        if (!abort.signal.aborted) throw e;
      });
      for (let i = 0; i < 100; i++) {
        const list = await request("/chrome/tabs", "GET", undefined, admin);
        if (list.value.connected) break;
        await sleep(10);
      }
      const first = await request(
        "/chrome/live",
        "POST",
        { tabTag: "C1-live" },
        admin,
      );
      assert(first.response.ok, JSON.stringify(first.value) + "\n" + logs);
      assert.equal(
        (
          await request(
            "/chrome/live",
            "POST",
            { tabTag: "C1-live" },
            { ...admin, csrf: "" },
          )
        ).response.status,
        403,
      );
      // A stream without the login cookie, or from another origin, never opens.
      const anonymous = await open(first.value.ticket, {}).catch((e) => e),
        crossOrigin = await open(first.value.ticket, admin, "https://evil.test").catch((e) => e);
      assert.equal(anonymous.status, 401, "a stream without the session cookie is unauthorized");
      assert.equal(crossOrigin.status, 403, "another origin cannot read this browser");
      const live = await open(first.value.ticket, admin);
      await live.wait("frame");
      await live.wait("frame", (m) => m.frameId > 1);
      assert.match(live.channel.id, /^[A-Za-z0-9_-]{16,}$/, "the stream opens with its channel id");
      // The ticket was consumed by the stream that is running: a second one is refused.
      const reused = await open(first.value.ticket, admin).catch((e) => e);
      assert.equal(reused.status, 403, "the ticket opened one stream and cannot open another");
      // A different login cannot drive this channel even though it can read its id: upstream posts are owned.
      assert.equal(
        (await request("/users", "POST", { username: "intruder-live", password: "another-long-test-password", role: "operator" }, admin)).response.status,
        200,
      );
      const intruder = await request("/auth/login", "POST", { username: "intruder-live", password: "another-long-test-password" });
      assert(intruder.response.ok, JSON.stringify(intruder.value));
      const hijack = await fetch(base + "/api/chrome/live/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: intruder.response.headers.get("set-cookie")!.split(";")[0],
          "X-CSRF-Token": intruder.value.csrfToken,
        },
        body: JSON.stringify({ channel: live.channel.id, message: { type: "ping" } }),
      });
      await hijack.text();
      assert.equal(hijack.ok, false, "another login cannot post into this channel");
      assert.equal(live.messages.some((m) => m.type === "pong"), false, "and the viewer's session never sees it");
      await live.send({ type: "mode", mode: "control" });
      await live.wait("mode", (m) => m.mode === "control");
      const input = async (seq: number, action: Obj) => {
        await live.send({
          type: "input",
          seq,
          frameId: live.frame().frameId,
          action,
        });
        return live.wait("input_result", (m) => m.seq === seq);
      };
      assert.equal(
        (await input(1, { action: "type", text: "SSE中文" })).status,
        "executed",
      );
      assert.equal(
        calls.filter((c) => c.method === "Input.insertText").length,
        1,
      );
      const dragFrame = live.frame().frameId;
      assert.equal(
        (await input(2, { action: "pointer", phase: "down", x: 100, y: 100 }))
          .status,
        "executed",
      );
      for (let seq = 3; seq <= 20; seq++)
        void live.send({ type: "pointer", seq, dragSeq: 2, frameId: dragFrame, action: { action: "pointer", phase: "move", x: 100 + seq, y: 100 } });
      void live.send({ type: "pointer", seq: 21, dragSeq: 2, frameId: dragFrame, action: { action: "pointer", phase: "up", x: 150, y: 120 } });
      assert.equal((await live.wait("pointer_result", m => m.seq === 21)).status, "executed");
      await live.wait("frame", m => m.inputSeq === 21);
      assert.equal((await input(22, { action: "pointer", phase: "down", x: 100, y: 100 })).status, "executed", "a second drag starts cleanly on the post-release frame");
      const releasesBeforeClose = calls.filter(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased").length;
      live.close();
      for (
        let i = 0;
        i < 100 &&
        calls.filter(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased").length === releasesBeforeClose;
        i++
      )
        await sleep(10);
      assert.equal(
        calls.filter(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased").length,
        releasesBeforeClose + 1,
        "dropping lane 0 releases the second held pointer and the browser lease",
      );
      const next = await request(
          "/chrome/live",
          "POST",
          { tabTag: "C1-live" },
          admin,
        ),
        again = await open(next.value.ticket, admin);
      await again.wait("frame");
      assert.equal(
        (await request("/auth/logout", "POST", {}, admin)).response.status,
        200,
      );
      // Logging out ends every lane with the same close code the WebSocket used to send.
      assert.equal((await again.wait("closed")).code, 4401);
      await again.ended;
    } finally {
      for (const controller of streams) controller.abort();
      abort.abort();
      await poll?.catch(() => {});
      child.kill();
      if (child.exitCode === null)
        await new Promise<void>((yes) => child.once("exit", () => yes()));
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
