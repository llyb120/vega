import { uploadSkill } from "../../core/skill-upload";
import {
  browserTabs,
  browserScreenshot,
  browserControl,
} from "../../core/browser-preview";
import { publicOrigin, principal } from "../../core/http-auth";
import { authRoute, bodyJSON } from "../../core/http-auth-routes";
import { check } from "../../core/auth";
import { readFile, stat } from "node:fs/promises";
import { importSkill, materializeSkill } from "../../core/skills";
import { skillMetadata } from "../../core/prompt";
import {
  defineEventHandler,
  getRequestURL,
  readBody,
  createError,
  setHeader,
  send,
} from "h3";
import { app } from "../../core/application";
import { assert, object, type Obj } from "../../core/util";
import { parseStage, Context } from "../../core/context";
import { maskedConfig, mergeSecrets, modelEntries } from "../../core/config";
import presets from "../../../shared/provider-presets.json";
async function inputMessage(
  a: Obj,
  store: ReturnType<typeof app>["store"],
  sessionId: string,
) {
  assert(
    typeof a.text === "string" || Array.isArray(a.images),
    "Message required",
  );
  assert((a.text || "").trim() || a.images?.length, "Empty message");
  assert(
    (a.text || "").length <= 2 << 20 && (!a.images || a.images.length <= 16),
    "Message too large",
  );
  const images: { mime: string; blobId?: string; data?: string }[] = [];
  let total = 0;
  for (const image of a.images || []) {
    assert(
      [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
      ].includes(image.mime) && typeof image.data === "string",
      "Invalid image",
    );
    const data = Buffer.from(image.data, "base64");
    total += data.length;
    assert(
      data.length <= 25 << 20 && total <= 64 << 20,
      "Image attachment limit exceeded",
    );
    const blobId = store.blob(image.mime, data);
    store.grantBlob(blobId, sessionId);
    images.push({ mime: image.mime, blobId });
  }
  return { role: "user", text: a.text || "", images };
}
export default defineEventHandler(async (event) => {
  const { store, engine, auth } = app(),
    method = event.method,
    path = getRequestURL(event)
      .pathname.replace(/^\/api\/?/, "")
      .split("/")
      .filter(Boolean);
  if (path[0] === "health")
    return { connected: engine.chrome.bridge.status().connected, ready: true };
  if (["auth", "users"].includes(path[0])) return authRoute(event, path);
  if (path[0] === "local-agent" && path[1] === "verify" && method === "POST") {
    const body = await bodyJSON(event, 4096);
    setHeader(event, "Cache-Control", "no-store");
    try { return engine.localAgents.verify(body.ticket, auth); }
    catch { throw createError({ statusCode: 401, statusMessage: "Local agent ticket invalid or expired" }); }
  }
  const who = principal(event),
    user = who.user;
  let a: Obj = {};
  if (["POST", "PUT", "PATCH"].includes(method))
    a = await bodyJSON(event, 90 << 20);
  if (path[0] === "local-agent") {
    setHeader(event, "Cache-Control", "no-store");
    check(method === "POST", 405, "POST required");
    if (path[1] === "ticket") return engine.localAgents.ticket(who, a.instance);
    if (path[1] === "connect") return engine.localAgents.connect(user.id, a);
    if (path[1] === "result") return engine.localAgents.result(user.id, a);
    if (path[1] === "disconnect") {
      check(typeof a.instance === "string", 400, "instance required");
      engine.localAgents.disconnect(user.id, a.instance);
      return { ok: true };
    }
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  try {
    if (["config", "providers", "skills", "employee", "vault"].includes(path[0]))
      check(user.role === "admin", 403, "Administrator permission required");
    if (path[0] === "bootstrap" && method === "GET")
      return {
        user,
        sessions: store
          .sessions()
          .filter((s) => !s.taskId && auth.canRead(user, s)),
        running: Object.fromEntries(
          [...engine.active.keys()]
            .filter((key) => {
              try {
                const session = store.session(key);
                return !session.taskId && auth.canRead(user, session);
              } catch {
                return false;
              }
            })
            .map((id) => [id, true]),
        ),
        config:
          user.role === "admin"
            ? maskedConfig(engine.config())
            : { model: engine.config().model, provider: {} },
        cwd: user.role === "viewer" ? "" : process.cwd(),
        clients: engine.localAgents.list(user.id),
        stack: {
          frontend: "Vue 3.6 Vapor",
          backend: "Nitro",
          storage: "SQLite",
        },
      };
    if (path[0] === "blobs" && method === "GET") {
      check(auth.canBlob(user, path[1]), 404, "Blob not found");
      const blob = store.blobData(path[1]);
      assert(blob, "Blob not found");
      setHeader(event, "Content-Type", blob.mime);
      return send(event, Buffer.from(blob.data));
    }
    if (path[0] === "sessions") {
      if (path.length === 1 && method === "POST") {
        assert(!a.model || typeof a.model === "string", "Invalid model");
        if (a.model) await engine.catalog.resolve(engine.config(), a.model);
        assert(a.clientId === undefined || (typeof a.clientId === "string" && /^[a-f0-9-]{32,36}$/.test(a.clientId)), "Invalid client ID");
        const clients = engine.localAgents.list(user.id),
          localAgent = a.localAgent === undefined ? clients.length > 0 : a.localAgent,
          agent = engine.localAgents.active(user.id, a.clientId);
        assert(typeof localAgent === "boolean", "Invalid execution mode");
        assert(!localAgent || agent, "客户端未连接或存在多个客户端，请选择在线执行客户端");
        return store.newSession({
          cwd: localAgent ? agent!.cwd : a.cwd,
          localAgent,
          localPlatform: localAgent ? agent!.platform : undefined,
          clientId: localAgent ? agent!.clientId : undefined,
          clientName: localAgent ? agent!.name : undefined,
          ownerId: user.id,
          model: a.model,
          title: a.title,
          readOnly: a.readOnly === true,
        });
      }
      const key = path[1],
        session = auth.session(user, key, method !== "GET");
      if (path[2] === "access")
        check(false, 404, "Private sessions cannot be shared");

      if (path.length === 2 && method === "GET")
        return {
          session,
          canWrite: !session.taskId && auth.canWrite(user, session),
          messages: store.messages(key),
          folds: engine.store.db
            .prepare("SELECT data FROM folds WHERE session=?")
            .all(key)
            .map((r: any) => JSON.parse(r.data)),
          fire: engine.fire.forSession(key),
          running: engine.active.has(key),
          context: new Context(
            store,
            key,
            engine.config().contextMode === "acp" ? "acp" : "auto",
          ).status(),
        };
      if (path.length === 2 && method === "DELETE") {
        const family = store.sessionFamily(key);
        assert(
          family.every(
            (s) =>
              !engine.active.has(s.id) &&
              engine.fire.forSession(s.id)?.status !== "running" &&
              !s.taskId,
          ),
          "Cannot delete running or employee-owned session",
        );
        store.deleteSession(key);
        for (const s of family) await engine.releaseSession(s.id);
        return { ok: true };
      }
      if (path[2] === "execution" && method === "POST")
        return await engine.switchExecution(key, a.localAgent, a.clientId, user.id);
      if (path[2] === "stage" && method === "POST")
        return store.stage(key, a.inheritModel === true);
      if (path[2] === "cancel" && method === "POST") {
        assert(!session.taskId, "Use employee controls to stop tasks");
        engine.fire.pause(key);
        engine.cancel(key);
        return { ok: true };
      }
      if (["messages", "steer"].includes(path[2]) && method === "POST") {
        assert(!session.taskId, "Use employee controls to resume tasks");
        const message = await inputMessage(a, store, key);
        if (path[2] === "steer") {
          engine.steer(key, message);
          return { ok: true };
        }
        if (
          path[2] === "messages" &&
          /^\s*\/fire(?:\s|$)/i.test(message.text)
        ) {
          assert(!engine.active.has(key), "Session already running");
          return engine.fire.start(key, message.text, message.images);
        }
        if (
          path[2] === "messages" &&
          /^\s*\/target(?:\s|$)/i.test(message.text)
        )
          throw Error("/target must be used inside /fire");
        if (path[2] === "messages" && engine.fire.resume(key, message))
          return { id: key, fire: engine.fire.forSession(key) };
        const stage = parseStage(message.text);
        let target = key;
        if (stage) {
          assert(
            !message.images?.length,
            "/stage does not support attachments",
          );
          if (stage.current)
            await engine.launch(key, { ...message, text: stage.current });
          target = store.stage(key).id;
          message.text = stage.prompt;
        }
        await engine.launch(target, message);
        return { id: target };
      }
      if (path[2] === "rename" && method === "POST") {
        assert(
          typeof a.title === "string" &&
            a.title.trim() &&
            a.title.length <= 200,
          "Title required",
        );
        session.title = a.title;
        store.saveSession(session);
        return { ok: true };
      }
      if (path[2] === "fork" && method === "POST") {
        assert(
          !engine.active.has(key),
          "Wait until the session stops before forking",
        );
        return store.fork(key);
      }
    }
    if (path[0] === "config" && method === "PUT")
      return engine.saveConfig(a as any);
    if (path[0] === "providers") {
      if (path[1] === "discover" && method === "POST") {
        check(
          a.provider &&
            typeof a.id === "string" &&
            /^[a-zA-Z0-9_.-]{1,80}$/.test(a.id),
          400,
          "服务商信息无效",
        );
        const raw = structuredClone(a.provider);
        mergeSecrets(raw, engine.config().provider?.[a.id]);
        const p = await engine.catalog.provider(raw, engine.config()),
          fetched = await engine.catalog.models(p, true),
          models = { ...fetched.models, ...modelEntries(p.models) };
        return { models };
      }
      if (path[1] === "presets") return presets;
      if (path[1] === "models")
        return engine.catalog.list(
          engine.config(),
          a.force === true ||
            getRequestURL(event).searchParams.get("force") === "true",
        );
      if (path[1] === "login") {
        if (a.action === "start")
          return engine.catalog.auth.loginStart(a.source, a.site, {
            callbackOrigin: a.manual === true ? undefined : publicOrigin(event),
            owner: user.id,
          });
        if (a.action === "poll")
          return {
            complete: await engine.catalog.auth.loginPoll(
              a.source,
              a.state,
              a.pasted,
              user.id,
            ),
          };
        if (a.action === "logout") {
          engine.catalog.auth.logout(a.source);
          return { ok: true };
        }
        if (a.action === "status") {
          try {
            await engine.catalog.auth.load(a.source, store.get("paths", {}));
            return { available: true };
          } catch (e: any) {
            return { available: false, reason: e.message };
          }
        }
        throw Error("Unknown subscription action");
      }
      if (path[1] === "import" && method === "POST") {
        const cfg = engine.config(),
          key = a.id || a.source;
        assert(
          [
            "codex",
            "claude-code",
            "codebuddy",
            "workbuddy",
            "devin",
            "server-support",
          ].includes(a.source),
          "Unknown local source",
        );
        const preset =
          a.source === "codex"
            ? "local-codex"
            : a.source === "claude-code"
              ? "local-claude-code"
              : a.source;
        const p = await engine.catalog.provider({ preset, models: {} }, cfg);
        const dynamic = await engine.catalog.models(p, true);
        const first =
          Object.keys(dynamic.models)[0] || Object.keys(p.models)[0];
        assert(first, "No usable models in provider catalog");
        cfg.provider ??= {};
        cfg.provider[key] = {
          ...cfg.provider[key],
          preset,
          name:
            typeof a.name === "string" && a.name.trim()
              ? a.name.trim().slice(0, 200)
              : cfg.provider[key]?.name || key,
          models: { ...cfg.provider[key]?.models },
        };
        if (!cfg.model) cfg.model = key + "/" + first;
        await engine.saveConfig(cfg);
        return {
          config: maskedConfig(cfg),
          models: await engine.catalog.list(cfg),
        };
      }
      if (path[1] === "paths" && method === "PUT") {
        store.put("paths", {
          workbuddyPath: a.workbuddyPath || "",
          devinPath: a.devinPath || "",
        });
        return { ok: true };
      }
    }
    if (path[0] === "skills") {
      if (path[1] === "upload" && method === "POST")
        return uploadSkill(store, a);
      if (method === "GET") {
        const rows = [];
        for (const skill of store.objects<any>("skill"))
          rows.push({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            ...(await materializeSkill(store, skill)),
            files: skill.assets?.map((a: Obj) => a.path) || ["SKILL.md"],
          });
        return rows;
      }
      if (method === "DELETE") {
        assert(path[1], "Skill id required");
        store.remove("skill", path[1]);
        return { ok: true };
      }
      if (method === "POST") {
        assert(typeof a.path === "string" && a.path, "Skill path required");
        return importSkill(store, a.path, a.id, a.replace === true);
      }
    }
    if (path[0] === "employee") {
      if (method === "GET")
        return {
          ...(() => {
            const { orbit, ...state } = engine.employee.state();
            return state;
          })(),
          systemPresence: engine.employee.nativePresence,
          busy: [...engine.employee.busy.keys()],
          takeovers: [...engine.employee.takeovers].map(([id, v]) => ({
            id,
            ...v,
          })),
        };
      if (path[1] === "control") return engine.employee.control(a);
      if (path[1] === "takeover") {
        engine.employee.takeover(a);
        return { ok: true };
      }
      if (path[1] === "activity") {
        engine.employee.lastActivity = Date.now() - (Number(a.idleMs) || 0);
        engine.employee.locked = a.locked === true;
        engine.employee.schedule();
        return { ok: true };
      }
      if (path[1] === "transcript")
        return engine.employee.transcript(a.threadId);
      const out = await engine.employee.execute("", a);
      return out.secret ? JSON.parse(out.secret) : out.value;
    }
    if (path[0] === "vault") {
      const vault = engine.vault;
      if (method === "GET" && path.length === 1)
        return { entries: vault.list() };
      if (method === "POST" && path.length === 1) return vault.save(a);
      if (method === "DELETE" && path.length === 2) {
        vault.remove(path[1]);
        return { ok: true };
      }
      check(false, 404, "Vault route not found");
    }
    if (path[0] === "chrome") {
      if (path.length === 2 && path[1] === "tabs" && method === "GET")
        return browserTabs(engine.chrome);
      if (path.length === 2 && path[1] === "screenshot" && method === "POST") {
        check(
          Object.keys(a).every((key) => key === "tabTag"),
          400,
          "Screenshot requests only accept tabTag",
        );
        return await browserScreenshot(
          engine.chrome,
          "browser-view:" + user.id,
          a.tabTag,
        );
      }
      if (path.length === 2 && path[1] === "control" && method === "POST")
        return await browserControl(
          engine.chrome,
          "browser-view:" + user.id,
          a,
        );
      if (path[1] === "tool")
        return engine.chrome.execute("browser-view:" + user.id, a.cwd || process.cwd(), a);
      if (a.operation === "close") {
        engine.chrome.bridge.close();
        return { ok: true };
      }
      await engine.chrome.bridge.start();
      return engine.chrome.bridge.status();
    }
    if (path[0] === "experiences" && method === "GET")
      return engine.chrome.experiences.graph(
        engine.chrome.experiences.all().filter((e) => !e.disabled),
      );
    if (path[0] === "team") {
      if (path[1] === "call")
        return engine.relay.call(a.peer, a.command, a.args || {});
      return { connected: engine.relay.connected, peers: engine.relay.peers };
    }
    throw createError({
      statusCode: 404,
      statusMessage: "API route not found",
    });
  } catch (e: any) {
    if (e.statusCode) throw e;
    throw createError({
      statusCode: 400,
      statusMessage: String(e.message).slice(0, 1000),
      data: { error: e.message },
    });
  }
});
