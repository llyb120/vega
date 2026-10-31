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
type Login = { cookie: string; csrf: string; id: string };
test(
  "deployed website login/RBAC: cookie,CSRF,owners,readonly grants,SSE revocation and no token bypass",
  { timeout: 60000, skip: process.env.VEGA_TEST_DEPLOYED !== "1" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vega-web-auth-")),
      db = join(dir, "auth.db"),
      token = randomBytes(32).toString("base64url");
    const seeded = new Store(db),
      legacy = seeded.newSession({ title: "legacy admin-only", cwd: dir }),
      secretBlob = seeded.blob(
        "image/png",
        Buffer.from("secret-image-fixture"),
      );
    seeded.close();
    const mock = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            data: [
              {
                id: "fixture-text",
                name: "Fixture Text",
                context_length: 128000,
                max_output_tokens: 8192,
              },
              {
                id: "fixture-vision",
                name: "Fixture Vision",
                context_length: 200000,
                max_output_tokens: 8192,
                architecture: { input_modalities: ["text", "image"] },
                reasoning_options: [
                  { type: "effort", values: ["low", "high"] },
                ],
              },
            ],
          }),
        );
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (
        Buffer.concat(chunks)
          .toString()
          .includes("keep-running-after-web-access-revoked")
      )
        await sleep(1000);
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "private session response" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((yes) => mock.listen(0, "127.0.0.1", yes));
    const reserve = createServer();
    await new Promise<void>((yes) => reserve.listen(0, "127.0.0.1", yes));
    const port = (reserve.address() as any).port;
    await new Promise<void>((yes) => reserve.close(() => yes()));
    const base = `http://127.0.0.1:${port}`,
      child = spawn(process.execPath, [resolve(".output/server/index.mjs")], {
        env: {
          ...process.env,
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: String(port),
          VEGA_TOKEN: token,
          VEGA_DB: db,
          VEGA_SKILL_CACHE: join(dir, "skills"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    let logs = "";
    child.stdout!.on("data", (c) => (logs += c));
    child.stderr!.on("data", (c) => (logs += c));
    const controllers: AbortController[] = [];
    const req = async (
      path: string,
      method = "GET",
      data?: any,
      login?: Login,
      extra: Record<string, string> = {},
    ) => {
      const r = await fetch(base + "/api" + path, {
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(login
            ? { Cookie: login.cookie, "X-CSRF-Token": login.csrf }
            : {}),
          ...extra,
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      const value = await r.json();
      return { r, value };
    };
    const ok = async (
      path: string,
      method = "GET",
      data?: any,
      login?: Login,
    ) => {
      const out = await req(path, method, data, login);
      assert(out.r.ok, JSON.stringify(out.value));
      return out.value;
    };
    const sign = async (name: string, password: string): Promise<Login> => {
      const out = await req("/auth/login", "POST", {
        username: name,
        password,
      });
      assert.equal(out.r.status, 200, JSON.stringify(out.value));
      const cookie = out.r.headers.get("set-cookie")!;
      assert(cookie.includes("HttpOnly") && /SameSite=Strict/i.test(cookie));
      assert(!out.value.token);
      return {
        cookie: cookie.split(";")[0],
        csrf: out.value.csrfToken,
        id: out.value.user.id,
      };
    };
    const openStream = async (login: Login) => {
      const controller = new AbortController();
      controllers.push(controller);
      const r = await fetch(base + "/api/events", {
        headers: { Cookie: login.cookie },
        signal: controller.signal,
      });
      assert.equal(r.status, 200);
      const reader = r.body!.getReader();
      let text = "",
        ended = false;
      const done = (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        } catch {
        } finally {
          ended = true;
        }
      })();
      return {
        get text() {
          return text;
        },
        get ended() {
          return ended;
        },
        done,
        controller,
      };
    };
    try {
      let ready = false;
      for (let n = 0; n < 120; n++) {
        if (child.exitCode !== null) throw Error(logs);
        try {
          const r = await fetch(base + "/api/health", {
            headers: { Authorization: "Bearer " + token },
          });
          await r.text();
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await sleep(50);
      }
      assert(ready, logs);
      assert.equal((await req("/auth/me")).value.setupRequired, true);
      assert.equal(
        (
          await req("/bootstrap", "GET", undefined, undefined, {
            Authorization: "Bearer " + token,
          })
        ).r.status,
        401,
        "Setup token must not bypass website login",
      );
      assert.equal(
        (
          await req("/auth/setup", "POST", {
            setupToken: "wrong",
            username: "admin",
            password: "valid-admin-fixture-password",
          })
        ).r.status,
        401,
      );
      const setup = await req("/auth/setup", "POST", {
        setupToken: token,
        username: "admin",
        password: "valid-admin-fixture-password",
      });
      assert.equal(setup.r.status, 200, JSON.stringify(setup.value));
      const admin: Login = {
        cookie: setup.r.headers.get("set-cookie")!.split(";")[0],
        csrf: setup.value.csrfToken,
        id: setup.value.user.id,
      };
      assert.equal(
        (
          await req("/auth/setup", "POST", {
            setupToken: token,
            username: "again",
            password: "valid-admin-fixture-password",
          })
        ).r.status,
        409,
      );
      assert.equal(
        (
          await req("/auth/login", "POST", {
            username: "admin",
            password: "wrong",
          })
        ).r.status,
        401,
      );
      const config = {
        model: "test/m",
        contextMode: "acp",
        provider: {
          test: {
            api: "openai-completions",
            baseURL: `http://127.0.0.1:${(mock.address() as any).port}`,
            apiKey: "never-show-config-secret",
            models: { m: { limit: { context: 128000, output: 8192 } } },
          },
        },
      };
      assert.equal(
        (await req("/config", "PUT", config, { ...admin, csrf: "" })).r.status,
        403,
      );
      assert.equal(
        (
          await req("/config", "PUT", config, admin, {
            Origin: "https://evil.test",
          })
        ).r.status,
        403,
      );
      assert.equal(
        (
          await req("/config", "PUT", config, admin, {
            "Sec-Fetch-Site": "cross-site",
          })
        ).r.status,
        403,
      );
      await ok("/config", "PUT", config, admin);
      const discovered = await ok(
        "/providers/discover",
        "POST",
        {
          id: "test",
          provider: {
            preset: "openai-compatible",
            api: "openai-completions",
            options: {
              baseURL: config.provider.test.baseURL,
              apiKey: "__stored_secret__",
            },
            models: {},
          },
        },
        admin,
      );
      assert(discovered.models["fixture-text"]);
      assert(
        discovered.models["fixture-vision"].modalities.input.includes("image"),
      );
      const attempt = await ok(
          "/providers/login",
          "POST",
          { action: "start", source: "devin" },
          admin,
        ),
        callback = new URL(attempt.url).searchParams.get("redirect_uri")!;
      assert(callback.startsWith(base + "/api/providers/callback/devin"));
      const rejected = await fetch(callback + "?state=wrong&code=fixture", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(rejected.status, 400);
      await rejected.text();
      const accepted = await fetch(
        callback + "?state=" + attempt.state + "&code=fixture",
        { headers: { "Sec-Fetch-Site": "cross-site" } },
      );
      assert.equal(accepted.status, 200);
      assert((await accepted.text()).includes("授权已收到"));
      const runner1 = (
        await ok(
          "/users",
          "POST",
          {
            username: "runner-one",
            password: "valid-runner-one-password",
            role: "operator",
          },
          admin,
        )
      ).user;
      const runner2 = (
        await ok(
          "/users",
          "POST",
          {
            username: "runner-two",
            password: "valid-runner-two-password",
            role: "operator",
          },
          admin,
        )
      ).user;
      const viewer = (
        await ok(
          "/users",
          "POST",
          {
            username: "viewer-one",
            password: "valid-viewer-one-password",
            role: "viewer",
          },
          admin,
        )
      ).user;
      const a = await sign("runner-one", "valid-runner-one-password"),
        b = await sign("runner-two", "valid-runner-two-password"),
        v = await sign("viewer-one", "valid-viewer-one-password");
      assert(
        !JSON.stringify(await ok("/users", "GET", undefined, admin)).includes(
          "scrypt1:",
        ),
      );
      assert.equal((await req("/users", "GET", undefined, a)).r.status, 403);
      assert.equal(
        (
          await req(
            "/users",
            "POST",
            {
              username: "take-admin",
              password: "new-attacker-password",
              role: "admin",
            },
            a,
          )
        ).r.status,
        403,
      );
      for (const path of ["/employee", "skills", "team", "chrome"].map((p) =>
        p.startsWith("/") ? p : "/" + p,
      ))
        assert.equal(
          (await req(path, "GET", undefined, a)).r.status,
          403,
          path,
        );
      assert.equal(
        (
          await req(
            "/providers/login",
            "POST",
            { action: "start", source: "codebuddy" },
            a,
          )
        ).r.status,
        403,
      );
      const chromeList = await ok("/chrome/tabs", "GET", undefined, admin);
      assert(Array.isArray(chromeList.tabs));
      for (const login of [a, v]) {
        assert.equal(
          (await req("/chrome/tabs", "GET", undefined, login)).r.status,
          403,
        );
        assert.equal(
          (
            await req(
              "/chrome/screenshot",
              "POST",
              { tabTag: "not-a-real-tab" },
              login,
            )
          ).r.status,
          403,
        );
      }
      assert.equal(
        (
          await req(
            "/chrome/screenshot",
            "POST",
            { tabTag: "not-a-real-tab", operation: "act" },
            admin,
          )
        ).r.status,
        400,
      );
      assert.equal(
        (
          await req(
            "/chrome/screenshot",
            "POST",
            { tabTag: "not-a-real-tab" },
            { ...admin, csrf: "" },
          )
        ).r.status,
        403,
      );
      assert.equal((await req("/config", "PUT", config, a)).r.status, 403);
      assert.equal(
        (await req("/sessions", "POST", { cwd: dir }, v)).r.status,
        403,
      );
      const s1 = await ok(
          "/sessions",
          "POST",
          { cwd: dir, title: "runner-one-private" },
          a,
        ),
        s2 = await ok(
          "/sessions",
          "POST",
          { cwd: dir, title: "runner-two-private" },
          b,
        );
      assert.equal(s1.ownerId, runner1.id);
      assert.equal(s2.ownerId, runner2.id);
      const boot = await ok("/bootstrap", "GET", undefined, a);
      assert.deepEqual(
        boot.sessions.map((s: any) => s.id),
        [s1.id],
      );
      assert(!JSON.stringify(boot).includes("never-show-config-secret"));
      assert(!boot.sessions.some((s: any) => s.id === legacy.id));
      for (const login of [b, v]) {
        assert.equal(
          (await req("/sessions/" + s1.id, "GET", undefined, login)).r.status,
          404,
        );
        assert.equal(
          (
            await req(
              "/sessions/" + s1.id + "/messages",
              "POST",
              { text: "injection" },
              login,
            )
          ).r.status,
          login === v ? 403 : 404,
        );
      }
      assert.equal(
        (await req("/blobs/" + secretBlob, "GET", undefined, a)).r.status,
        404,
      );
      assert.equal(
        (
          await req(
            "/sessions/" + s1.id + "/access",
            "PUT",
            { readerIds: [viewer.id] },
            a,
          )
        ).r.status,
        403,
      );
      await ok(
        "/sessions/" + s1.id + "/access",
        "PUT",
        { readerIds: [viewer.id] },
        admin,
      );
      const read = await ok("/sessions/" + s1.id, "GET", undefined, v);
      assert.equal(read.canWrite, false);
      assert(
        (await ok("/bootstrap", "GET", undefined, v)).sessions.some(
          (s: any) => s.id === s1.id,
        ),
      );
      assert.equal(
        (await req("/sessions/" + s1.id, "DELETE", undefined, v)).r.status,
        403,
      );
      const stage = await ok("/sessions/" + s1.id + "/stage", "POST", {}, a),
        fork = await ok("/sessions/" + s1.id + "/fork", "POST", {}, a);
      assert.equal(stage.ownerId, runner1.id);
      assert.equal(fork.ownerId, runner1.id);
      const streamB = await openStream(b),
        streamViewer = await openStream(v);
      await ok(
        "/sessions/" + s1.id + "/messages",
        "POST",
        { text: "only runner-one can see this" },
        a,
      );
      for (let n = 0; n < 100; n++) {
        if (
          (await ok("/sessions/" + s1.id, "GET", undefined, a)).messages.some(
            (m: any) => m.text === "private session response",
          )
        )
          break;
        await sleep(10);
      }
      for (
        let n = 0;
        n < 100 && !streamViewer.text.includes("private session response");
        n++
      )
        await sleep(10);
      assert(streamViewer.text.includes("private session response"));
      assert(!streamB.text.includes(s1.id));
      assert(!streamB.text.includes("private session response"));
      await ok(
        "/sessions/" + s2.id + "/messages",
        "POST",
        { text: "keep-running-after-web-access-revoked" },
        b,
      );
      await ok("/users/" + runner2.id, "PUT", { disabled: true }, admin);
      await Promise.race([
        streamB.done,
        sleep(1500).then(() => {
          throw Error("Disabled user SSE was not revoked");
        }),
      ]);
      assert(streamB.ended);
      let continued: any;
      for (let n = 0; n < 150; n++) {
        continued = await ok("/sessions/" + s2.id, "GET", undefined, admin);
        if (
          !continued.running &&
          continued.messages.some(
            (m: any) =>
              m.role === "assistant" && m.text === "private session response",
          )
        )
          break;
        await sleep(20);
      }
      assert(
        continued.messages.some(
          (m: any) =>
            m.role === "assistant" && m.text === "private session response",
        ),
        "Disabling website access must not cancel the already authorized internal run",
      );
      assert.equal(continued.running, false);
      assert.equal(
        (await req("/bootstrap", "GET", undefined, b)).r.status,
        401,
      );
      assert.equal(
        (
          await req("/auth/login", "POST", {
            username: "runner-two",
            password: "valid-runner-two-password",
          })
        ).r.status,
        401,
      );
      await ok(
        "/sessions/" + s1.id + "/access",
        "PUT",
        { readerIds: [] },
        admin,
      );
      assert.equal(
        (await req("/sessions/" + s1.id, "GET", undefined, v)).r.status,
        404,
      );
      assert.equal(
        (await req("/users/" + admin.id, "PUT", { disabled: true }, admin)).r
          .status,
        409,
      );
      const logout = await req("/auth/logout", "POST", {}, a);
      assert.equal(logout.r.status, 200);
      assert.equal(
        (await req("/bootstrap", "GET", undefined, a)).r.status,
        401,
      );
      const again = await sign("runner-one", "valid-runner-one-password");
      await ok(
        "/auth/password",
        "POST",
        {
          currentPassword: "valid-runner-one-password",
          newPassword: "replacement-runner-password",
        },
        again,
      );
      assert.equal(
        (await req("/bootstrap", "GET", undefined, again)).r.status,
        401,
      );
      assert(!logs.includes("valid-admin-fixture-password"));
      assert(!logs.includes("valid-runner-one-password"));
    } finally {
      for (const c of controllers) c.abort();
      mock.closeAllConnections();
      await new Promise<void>((yes) => mock.close(() => yes()));
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((yes, no) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            no(Error("Auth test server shutdown timeout"));
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            yes();
          });
        });
      }
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
