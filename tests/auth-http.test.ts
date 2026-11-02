import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import sharp from "sharp";
import { Store } from "../server/core/store";
import { sleep } from "../server/core/util";
type Login = { cookie: string; csrf: string; id: string };
test(
  "deployed website login/RBAC: cookie,CSRF,private sessions,WebSocket revocation and no token bypass",
  { timeout: 60000, skip: process.env.VEGA_TEST_DEPLOYED !== "1" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vega-web-auth-")),
      db = join(dir, "auth.db"),
      token = randomBytes(32).toString("base64url");
    const seeded = new Store(db),
      legacy = seeded.newSession({ title: "legacy admin-only", cwd: dir }),
      employeeSession = seeded.newSession({
        title: "employee-owned history",
        cwd: dir,
        taskId: "employee-test-task",
      }),
      secretBlob = seeded.blob(
        "image/png",
        Buffer.from("secret-image-fixture"),
      );
    seeded.close();
    let thinkingRequests = 0, triggerRequests = 0;
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
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (payload.tools?.some((tool: any) => tool.function?.name === "compile_duty_trigger")) {
        triggerRequests++;
        const condition = JSON.parse(payload.messages.at(-1).content).condition;
        const rule = condition.includes("unsupported-event-fixture") ? { mode: "unsupported", reason: "没有外部事件源，请明确检查频率" } : condition.includes("每天") ? { mode: "daily", times: ["23:59"] } : { mode: "manual" };
        res.setHeader("Content-Type", "text/event-stream");
        res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "duty-rule", type: "function", function: { name: "compile_duty_trigger", arguments: JSON.stringify(rule) } }] }, finish_reason: "tool_calls" }] }) + "\n\ndata: [DONE]\n\n");
        return;
      }
      const userAt = payload.messages?.findLastIndex((message: any) => message.role === "user") ?? -1;
      const content = payload.messages?.[userAt]?.content;
      const memory = typeof content === "string" ? content.match(/team-memory-fixture-(?:admin|member)/)?.[0] : undefined;
      const memoryCall = memory && !payload.messages.slice(userAt + 1).some((message: any) => message.role === "tool");
      const thinkingOnly = typeof content === "string" && content.includes("thinking-only-chat-fixture");
      if (thinkingOnly) thinkingRequests++;
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: thinkingOnly ? { reasoning_content: "I need to respond, but no answer was generated" } : memoryCall ? { tool_calls: [{ index: 0, id: "memory-fixture", type: "function", function: { name: "employee", arguments: JSON.stringify({ action: "remember", text: memory }) } }] } : { content: "private session response" },
                finish_reason: memoryCall ? "tool_calls" : "stop",
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
          VEGA_CHROMIUM_EXTERNAL: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    let logs = "";
    child.stdout!.on("data", (c) => (logs += c));
    child.stderr!.on("data", (c) => (logs += c));
    const sockets: WebSocket[] = [];
    const req = async (
      path: string,
      method = "GET",
      data?: any,
      login?: Login,
      extra: Record<string, string> = {},
    ) => {
      const r = await fetch(base + "/api" + path, {
        signal: AbortSignal.timeout(10000),
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
      const { ticket } = await ok("/events", "POST", {}, login),
        ws = new WebSocket(
          base.replace("http:", "ws:") + "/api/events?ticket=" + ticket,
          { headers: { Cookie: login.cookie, Origin: base } },
        );
      sockets.push(ws);
      let text = "",
        ended = false;
      ws.on("message", (data) => (text += data.toString()));
      ws.on("error", () => {});
      const done = new Promise<void>((yes) =>
        ws.once("close", () => {
          ended = true;
          yes();
        }),
      );
      await new Promise<void>((yes, no) => {
        ws.once("open", yes);
        ws.once("error", no);
      });
      for (let i = 0; i < 100 && !text.includes('"ready"'); i++)
        await sleep(10);
      assert(text.includes('"ready"'));
      return {
        get text() {
          return text;
        },
        get ended() {
          return ended;
        },
        done,
      };
    };
    try {
      let ready = false;
      for (let n = 0; n < 120; n++) {
        if (child.exitCode !== null) throw Error(logs);
        try {
          const r = await fetch(base + "/api/health", {
            headers: { Authorization: "Bearer " + token },
            signal: AbortSignal.timeout(1000),
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
      const normalBoot = await ok("/bootstrap", "GET", undefined, admin);
      assert(
        normalBoot.sessions.some((session: any) => session.id === legacy.id),
      );
      assert(
        !normalBoot.sessions.some(
          (session: any) => session.id === employeeSession.id,
        ),
      );
      const employeeRecord = await ok(
        "/sessions/" + employeeSession.id,
        "GET",
        undefined,
        admin,
      );
      assert.equal(employeeRecord.session.taskId, "employee-test-task");
      assert.equal(employeeRecord.canWrite, false);
      for (const action of ["messages", "steer", "stage", "fork", "cancel"]) {
        assert.equal(
          (
            await req(
              "/sessions/" + employeeSession.id + "/" + action,
              "POST",
              { text: "must not run" },
              admin,
            )
          ).r.status,
          400,
          action + " must use employee controls",
        );
      }
      assert.equal(
        (
          await req(
            "/sessions/" + employeeSession.id,
            "DELETE",
            undefined,
            admin,
          )
        ).r.status,
        400,
      );
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
      const workerA = await ok("/employees", "POST", { name: "Alice worker", cwd: dir }, a);
      const workerB = await ok("/employees", "POST", { name: "Bob worker", cwd: dir }, b);
      assert.notEqual(workerA.id, workerB.id);
      assert.equal((await req("/employees/" + workerA.id, "GET", undefined, b)).r.status, 404);
      assert.equal((await req("/employees", "GET", undefined, v)).r.status, 200);
      assert.deepEqual((await ok("/employees", "GET", undefined, a)).filter((employee: any) => employee.scope === "personal").map((employee: any) => employee.id), [workerA.id]);
      const team = await ok("/employees", "POST", { name: "Team worker", cwd: dir, scope: "personal" }, admin);
      assert.equal(team.scope, "team");
      const beforeDutyCalls = triggerRequests;
      for (const login of [a, b, v]) assert.equal((await req(`/employees/${team.id}`, "POST", { action: "add", kind: "duty", condition: "每天23:59", text: "两框职责" }, login)).r.status, 403);
      assert.equal(triggerRequests, beforeDutyCalls, "unauthorized writes do not invoke the trigger interpreter");
      const duty = await ok(`/employees/${team.id}`, "POST", { action: "add", kind: "duty", condition: "每天23:59", text: "两框职责内容" }, admin);
      let savedDuty = (await ok(`/employees/${team.id}`, "GET", undefined, admin)).duties.find((entry: any) => entry.id === duty.id);
      assert.equal(savedDuty.condition, "每天23:59"); assert.deepEqual(savedDuty.times, ["23:59"]);
      await ok(`/employees/${team.id}`, "POST", { action: "update", id: duty.id, enabled: false }, admin);
      const afterDutyCalls = triggerRequests;
      await ok(`/employees/${team.id}`, "POST", { action: "update", id: duty.id, condition: "每天23:59", text: "只修改职责内容" }, admin);
      assert.equal(triggerRequests, afterDutyCalls, "unchanged triggers preserve their compiled schedule");
      savedDuty = (await ok(`/employees/${team.id}`, "GET", undefined, admin)).duties.find((entry: any) => entry.id === duty.id);
      assert.equal(savedDuty.enabled, false); assert.equal(savedDuty.text, "只修改职责内容");
      assert.equal((await req(`/employees/${team.id}`, "POST", { action: "update", id: duty.id, condition: "unsupported-event-fixture" }, admin)).r.status, 400);
      assert.equal((await ok(`/employees/${team.id}`, "GET", undefined, admin)).duties.find((entry: any) => entry.id === duty.id).condition, "每天23:59");
      const avatarData = (await sharp({ create: { width: 32, height: 24, channels: 3, background: "#5577bb" } }).png().toBuffer()).toString("base64");
      const customAvatar = await ok(`/employees/${workerA.id}/avatar`, "POST", { mime: "image/png", data: avatarData }, a);
      assert.match(customAvatar.avatar, /^blob-/);
      const ownAvatar = await fetch(base + `/api/employees/${workerA.id}/avatar?v=${customAvatar.avatar}`, { headers: { Cookie: a.cookie } });
      assert.equal(ownAvatar.status, 200); assert.match(ownAvatar.headers.get("content-type")!, /image\/webp/);
      assert.equal((await sharp(Buffer.from(await ownAvatar.arrayBuffer())).metadata()).width, 512);
      assert.equal((await req(`/employees/${workerA.id}/avatar`, "GET", undefined, b)).r.status, 404);
      assert.equal((await req(`/blobs/${customAvatar.avatar}`, "GET", undefined, a)).r.status, 404, "custom avatars are not granted through an unrelated conversation");
      assert.equal((await req(`/employees/${workerA.id}/avatar`, "POST", { mime: "image/png", data: avatarData }, b)).r.status, 404);
      assert.equal((await req(`/employees/${team.id}/avatar`, "POST", { preset: "zodiac:leo" }, a)).r.status, 403);
      assert.equal((await req(`/employees/${team.id}/avatar`, "POST", { preset: "zodiac:leo" }, v)).r.status, 403);
      assert.equal((await req(`/employees/${workerA.id}/avatar`, "POST", { preset: "https://tracker.example/pixel" }, a)).r.status, 400);
      assert.equal((await ok(`/employees/${workerA.id}`, "GET", undefined, a)).avatar, customAvatar.avatar);
      await ok(`/employees/${team.id}/avatar`, "POST", { mime: "image/png", data: avatarData }, admin);
      for (const login of [a, b, v]) {
        const image = await fetch(base + `/api/employees/${team.id}/avatar`, { headers: { Cookie: login.cookie } });
        assert.equal(image.status, 200); await image.arrayBuffer();
      }
      await ok(`/employees/${team.id}/avatar`, "POST", { preset: "zodiac:pisces" }, admin);
      assert.equal((await ok(`/employees/${team.id}`, "GET", undefined, v)).avatar, "zodiac:pisces");
      const zodiacAsset = await fetch(base + "/avatars/zodiac/pisces.webp");
      assert.equal(zodiacAsset.status, 200); assert.match(zodiacAsset.headers.get("content-type")!, /image\/webp/); await zodiacAsset.arrayBuffer();
      for (const login of [a, b, v]) {
        assert((await ok("/employees", "GET", undefined, login)).some((employee: any) => employee.id === team.id));
        assert.equal((await ok(`/employees/${team.id}`, "GET", undefined, login)).canManage, false);
        assert.equal((await req(`/employees/${team.id}?confirmed=true`, "DELETE", undefined, login)).r.status, 403);
      }
      const teamChat = await ok(`/employees/${team.id}/chat`, "GET", undefined, v);
      for (const login of [a, b, v]) assert.equal((await req('/debug/sessions', 'GET', undefined, login)).r.status, 403);
      const debugSessions = await ok('/debug/sessions', 'GET', undefined, admin);
      assert(debugSessions.some((session: any) => session.id === teamChat.session.id && session.kind === 'chat' && session.employeeName === 'Team worker'));
      assert(debugSessions.some((session: any) => session.id === employeeSession.id && session.taskId === 'employee-test-task'));
      assert.equal((await req(`/sessions/${teamChat.session.id}`, "GET", undefined, b)).r.status, 200);
      assert.equal((await req(`/employees/${team.id}/messages`, "POST", { text: "must not execute" }, v)).r.status, 403);
      assert.equal((await req(`/employees/${team.id}/control`, "POST", { action: "settings", name: "unauthorized" }, a)).r.status, 403);
      for (const [login, marker] of [[admin, 'team-memory-fixture-admin'], [a, 'team-memory-fixture-member']] as const) {
        await ok(`/employees/${team.id}/messages`, 'POST', { text: marker, actorId: admin.id }, login);
        let finished = false;
        for (let index = 0; index < 100; index++) {
          const state = await ok(`/employees/${team.id}/chat`, 'GET', undefined, admin);
          if (!state.running && state.messages.some((message: any) => message.text === marker)) { finished = true; break; }
          await sleep(20);
        }
        assert(finished, 'team fixture turn must finish');
      }
      const teamState = await ok(`/employees/${team.id}`, 'GET', undefined, admin);
      assert(teamState.memories.some((memory: any) => memory.text === 'team-memory-fixture-admin'));
      assert(!teamState.memories.some((memory: any) => memory.text === 'team-memory-fixture-member'), 'a forged actorId cannot inherit the administrator who owns the team employee');
      await ok(`/employees/${team.id}/messages`, 'POST', { text: 'thinking-only-chat-fixture' }, admin);
      let failedChat: any;
      for (let index = 0; index < 100; index++) {
        failedChat = await ok(`/employees/${team.id}/chat`, 'GET', undefined, admin);
        if (!failedChat.running && failedChat.messages.at(-1)?.error) break;
        await sleep(20);
      }
      assert.equal(thinkingRequests, 2, 'an empty generation is recovered once, not treated as success or retried forever');
      assert.equal(failedChat.running, false);
      assert.equal(failedChat.messages.at(-1).error, true);
      assert.match(failedChat.messages.at(-1).text, /本轮未完成/);
      const readAfterFailure = await ok(`/sessions/${teamChat.session.id}`, 'GET', undefined, b);
      assert.equal(readAfterFailure.messages.at(-1).text, failedChat.messages.at(-1).text, 'the failure survives a new reader rather than depending on a transient event');
      assert.equal((await ok(`/employees/${team.id}`, 'GET', undefined, admin)).tasks.length, 0);
      const sharedCredential = await ok("/vault", "POST", { name: "shared service", condition: "authorized test", content: "shared-vault-test-secret" }, admin);
      for (const [worker, login] of [[team, admin], [workerA, a], [workerB, b]] as const) {
        const entries = await ok(`/employees/${worker.id}`, "POST", { action: "vault_list" }, login);
        assert(entries.entries.some((entry: any) => entry.id === sharedCredential.id), "employees share the global vault without grants");
        assert(!JSON.stringify(entries).includes("shared-vault-test-secret"));
        const value = await ok(`/employees/${worker.id}`, "POST", { action: "vault_get", id: sharedCredential.id, text: "authorized test" }, login);
        assert.equal(value.content, "shared-vault-test-secret");
      }
      for (const login of [a, b, v]) {
        assert.equal((await req("/vault", "GET", undefined, login)).r.status, 403);
        assert.equal((await req("/vault", "POST", { name: "forbidden", condition: "test", content: "must not save" }, login)).r.status, 403);
        assert.equal((await req(`/vault/${sharedCredential.id}`, "DELETE", undefined, login)).r.status, 403);
      }
      for (const [worker, login] of [[workerA, a], [workerB, b]] as const) {
        await ok(`/employees/${worker.id}`, "POST", { action: "add", kind: "todo", text: "isolated work", key: "same-key", nextCheckInMinutes: 60 }, login);
      }
      const stateA = await ok(`/employees/${workerA.id}`, "GET", undefined, a);
      const stateB = await ok(`/employees/${workerB.id}`, "GET", undefined, b);
      assert.notEqual(stateA.tasks[0].id, stateB.tasks[0].id);
      assert.equal((await req(`/employees/${workerB.id}`, "POST", { action: "done", id: stateA.tasks[0].id }, a)).r.status, 404);
      const chat = await ok(`/employees/${workerA.id}/chat`, "GET", undefined, a);
      assert.equal(chat.session.employeeId, workerA.id);
      assert.equal((await req(`/employees/${workerA.id}/messages`, "POST", { text: "quote unavailable", quoteSeq: 99999 }, a)).r.status, 400);
      const teamSource = teamChat.messages?.[0]?.seq || 1;
      assert.equal((await req(`/employees/${workerA.id}/messages`, "POST", { text: "cannot quote another employee", quoteSeq: teamSource, quote: { session: teamChat.session.id, text: "forged quote" } }, a)).r.status, 400);
      const source = failedChat.messages.find((message: any) => message.role === "user")!;
      assert.equal((await req(`/employees/${team.id}/messages`, "POST", { text: "viewer quote must not execute", quoteSeq: source.seq }, v)).r.status, 403);
      await ok(`/employees/${team.id}/messages`, "POST", { text: "explain the quoted finding", quoteSeq: source.seq, quote: { text: "forged content" } }, a);
      let quotedChat: any;
      for (let index = 0; index < 100; index++) {
        quotedChat = await ok(`/employees/${team.id}/chat`, "GET", undefined, a);
        if (!quotedChat.running && quotedChat.messages.some((message: any) => message.text === "explain the quoted finding")) break;
        await sleep(20);
      }
      const cited = quotedChat.messages.find((message: any) => message.text === "explain the quoted finding");
      assert.equal(cited.quote.seq, source.seq);
      assert.equal(cited.quote.text, source.text);
      assert(!JSON.stringify(cited.quote).includes("forged"));
      assert.equal((await req(`/sessions/${chat.session.id}/messages`, "POST", { text: "must use employee" }, a)).r.status, 400);
      assert(!(await ok("/bootstrap", "GET", undefined, a)).sessions.some((session: any) => session.id === chat.session.id));
      assert.equal((await req(`/sessions/${chat.session.id}`, "GET", undefined, b)).r.status, 404);
      assert.equal((await req(`/employees/${workerA.id}`, "DELETE", undefined, a)).r.status, 400);
      assert.equal((await req(`/employees/${workerA.id}?confirmed=true`, "DELETE", undefined, b)).r.status, 404);
      await ok(`/employees/${workerA.id}?confirmed=true`, "DELETE", undefined, a);
      assert.equal((await req(`/employees/${workerA.id}`, "GET", undefined, a)).r.status, 404);
      assert.equal((await req(`/employees/${workerA.id}/avatar`, "GET", undefined, a)).r.status, 404);
      assert.equal((await req(`/sessions/${chat.session.id}`, "GET", undefined, a)).r.status, 404);
      assert((await ok("/employees", "GET", undefined, b)).some((employee: any) => employee.id === workerB.id));
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
      for (const [path, method, data] of [
        ["/config", "PUT", {}],
        ["/skills", "GET", undefined],
        ["/employee", "POST", { action: "vault_list" }],
        ["/employee", "POST", { action: "vault_save", name: "x" }],
      ])
        assert.equal(
          (await req(path as string, method as string, data, a)).r.status,
          403,
          path + " must be admin-only",
        );
      const chromeList = await ok("/chrome/tabs", "GET", undefined, admin);
      assert(Array.isArray(chromeList.tabs));
      for (const login of [a, v]) {
        assert.equal(
          (
            await req(
              "/chrome/control",
              "POST",
              {
                tabTag: "not-a-real-tab",
                snapshotId: "not-real",
                action: { action: "press", key: "Enter" },
              },
              login,
            )
          ).r.status,
          403,
        );
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
            "/chrome/control",
            "POST",
            {
              tabTag: "not-a-real-tab",
              snapshotId: "not-real",
              action: { action: "press", key: "Enter" },
            },
            { ...admin, csrf: "" },
          )
        ).r.status,
        403,
      );
      assert.equal(
        (
          await req(
            "/chrome/control",
            "POST",
            {
              tabTag: "not-a-real-tab",
              snapshotId: "not-real",
              action: { action: "evaluate", expression: "alert(1)" },
            },
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
      assert.equal(
        (
          await req(
            "/sessions/" + s1.id + "/access",
            "PUT",
            { readerIds: [viewer.id] },
            admin,
          )
        ).r.status,
        404,
      );
      assert.equal(
        (await req("/sessions/" + s1.id, "GET", undefined, v)).r.status,
        404,
      );
      assert.equal(
        (await req("/sessions/" + s1.id, "GET", undefined, admin)).r.status,
        404,
      );
      assert(
        !(await ok("/bootstrap", "GET", undefined, v)).sessions.some(
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
      assert(!streamViewer.text.includes("private session response"));
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
          throw Error("Disabled user WebSocket was not revoked");
        }),
      ]);
      assert(streamB.ended);
      let continued: any,
        privateMessages: any[] = [];
      for (let n = 0; n < 150; n++) {
        const inspectPrivate = new Store(db);
        continued = inspectPrivate.session(s2.id);
        privateMessages = inspectPrivate.messages(s2.id);
        inspectPrivate.close();
        if (
          !continued.running &&
          privateMessages.some(
            (m: any) =>
              m.role === "assistant" && m.text === "private session response",
          )
        )
          break;
        await sleep(20);
      }
      assert(
        privateMessages.some(
          (m: any) =>
            m.role === "assistant" && m.text === "private session response",
        ),
        "Disabling website access must not cancel the already authorized internal run",
      );
      assert.equal(
        (await req("/sessions/" + s2.id, "GET", undefined, admin)).r.status,
        404,
        "Another user's private session stays hidden from administrators",
      );
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
      assert.equal(
        (
          await req(
            "/sessions/" + s1.id + "/access",
            "PUT",
            { readerIds: [] },
            admin,
          )
        ).r.status,
        404,
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
      for (const socket of sockets) socket.close();
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
