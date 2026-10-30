import { Vault } from "./vault";
import { Mutex } from "./util";
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import TOML from "@iarna/toml";
import { parse as jsonc } from "jsonc-parser";
import type { Store } from "./store";
import {
  assert,
  expand,
  httpURL,
  jsonRequest,
  localJSON,
  object,
  sleep,
  type Obj,
} from "./util";
const exec = promisify(execFile);
export const CODEX = "https://chatgpt.com/backend-api/codex",
  CLAUDE = "https://api.anthropic.com";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const read = (path: string, optional = false) => {
  try {
    const st = statSync(path);
    assert(
      st.isFile() && st.size <= 4 << 20,
      "Invalid CLI config file size/type",
    );
    return readFileSync(path, "utf8");
  } catch (e: any) {
    if (optional && e.code === "ENOENT") return "";
    throw Error("Cannot read local CLI configuration; check CLI login");
  }
};
const parseTOML = (path: string) => {
  try {
    return object(TOML.parse(read(path, true)));
  } catch {
    throw Error("Invalid CLI TOML configuration");
  }
};
export function locateWorkBuddy(configured = "") {
  const bundle = (root: string) =>
    join(root, "resources/app.asar.unpacked/cli/bin/codebuddy");
  if (configured.trim()) {
    const p = configured.trim();
    if (existsSync(p) && statSync(p).isDirectory()) return bundle(p);
    if (/WorkBuddy\.exe$/i.test(p)) return bundle(dirname(p));
    return p;
  }
  if (process.platform === "win32")
    for (const [variable, relative] of [
      ["LOCALAPPDATA", "Programs/WorkBuddy"],
      ["ProgramFiles", "WorkBuddy"],
      ["ProgramFiles(x86)", "WorkBuddy"],
    ]) {
      const root = process.env[variable];
      if (root && existsSync(bundle(join(root, relative))))
        return bundle(join(root, relative));
    }
  return "";
}
export class Subscriptions {
  pending = new Map<
    string,
    {
      source: string;
      site: string;
      origin: string;
      created: number;
      verifier?: string;
      code?: string;
      close?: () => void;
    }
  >();
  vault: Vault;
  refreshLocks = new Map<string, Mutex>();
  workbuddyTokens = new Map<string, string>();
  constructor(
    public store: Store,
    public workbuddyHelper: string,
  ) {
    this.vault = new Vault(store);
  }
  saveLogin(source: string, value: Obj) {
    this.store.put("subscription:" + source, {
      encrypted: this.vault.sealObject(value),
    });
  }
  origin(source: string, site = "global") {
    assert(["codebuddy", "workbuddy"].includes(source), "Invalid login source");
    return source === "workbuddy"
      ? "https://www.workbuddy.cn"
      : site === "cn"
        ? "https://www.codebuddy.cn"
        : "https://www.codebuddy.ai";
  }
  normalizeAuth(data: Obj, domain: string): Obj {
    assert(
      typeof data.accessToken === "string" && data.accessToken,
      "Login did not return an accessToken",
    );
    const now = Date.now();
    return {
      ...data,
      domain: data.domain || domain,
      expiresAt:
        data.expiresAt ??
        (Number.isInteger(data.expiresIn) && data.expiresIn >= 0
          ? now + data.expiresIn * 1000
          : undefined),
      refreshExpiresAt:
        data.refreshExpiresAt ??
        (Number.isInteger(data.refreshExpiresIn) && data.refreshExpiresIn >= 0
          ? now + data.refreshExpiresIn * 1000
          : undefined),
    };
  }
  async saved(source: string) {
    let gate = this.refreshLocks.get(source);
    if (!gate) {
      gate = new Mutex();
      this.refreshLocks.set(source, gate);
    }
    return gate.run(() => this.readSaved(source));
  }
  async readSaved(source: string) {
    const persisted = this.store.get<Obj | null>(
      "subscription:" + source,
      null,
    );
    const saved: Obj | null = persisted?.encrypted
      ? this.vault.openObject(persisted.encrypted)
      : persisted;
    assert(saved, `Login to ${source} first`);
    if (source !== "devin" && saved.auth.expiresAt <= Date.now() + 300000) {
      assert(saved.auth.refreshToken, "Login expired; sign in again");
      assert(
        saved.origin === this.origin(source, saved.site),
        "Invalid stored login origin",
      );
      const data = await jsonRequest(
        saved.origin + "/v2/plugin/auth/token/refresh",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + saved.auth.accessToken,
            "X-Refresh-Token": saved.auth.refreshToken,
            "X-Auth-Refresh-Source": "plugin",
            "X-Domain": saved.auth.domain,
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      saved.auth = this.normalizeAuth(data.data, saved.auth.domain);
      this.saveLogin(source, saved);
    }
    return saved;
  }
  async loginStart(source: string, site = "global") {
    for (const [key, p] of this.pending)
      if (Date.now() - p.created > 600000) {
        p.close?.();
        this.pending.delete(key);
      }
    if (source === "devin") {
      const state = b64(randomBytes(24)),
        verifier = b64(randomBytes(48));
      const pending = {
        source,
        site,
        origin: "https://api.devin.ai",
        created: Date.now(),
        verifier,
        code: "",
      };
      const server = createServer((req, res) => {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        const valid =
          u.pathname === "/callback" &&
          u.searchParams.get("state") === state &&
          u.searchParams.get("code");
        res.writeHead(valid ? 200 : 400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        res.end(valid ? "登录完成，请返回 Vega" : "Invalid login callback");
        if (valid) pending.code = u.searchParams.get("code")!;
      });
      await new Promise<void>((yes, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", yes);
      });
      const port = (server.address() as any).port;
      this.pending.set(state, { ...pending, close: () => server.close() });
      server.on("request", () => {
        const p = this.pending.get(state);
        if (p) p.code = pending.code;
      });
      const url = new URL("https://app.devin.ai/auth/cli/continue");
      for (const [k, v] of Object.entries({
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        state,
        prompt: "select_account",
        code_challenge: b64(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      }))
        url.searchParams.set(k, v);
      return { state, url: url.href };
    }
    const origin = this.origin(source, site);
    const data = await jsonRequest(
      origin + "/v2/plugin/auth/state?platform=CLI",
      { method: "POST", headers: this.noAuth(), body: "{}" },
    );
    const { state, authUrl } = object(data.data);
    assert(
      state && authUrl && new URL(authUrl).origin === origin,
      "Invalid official login URL",
    );
    this.pending.set(state, { source, site, origin, created: Date.now() });
    return { state, url: authUrl };
  }
  noAuth() {
    return {
      "Content-Type": "application/json",
      "X-No-Authorization": "true",
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
    };
  }
  async loginPoll(source: string, state: string, pasted?: string) {
    const p = this.pending.get(state);
    assert(
      p && p.source === source && Date.now() - p.created < 600000,
      "Login state expired or belongs to another source",
    );
    if (source === "devin") {
      let code = p.code;
      if (pasted) {
        const url = new URL(pasted);
        assert(url.searchParams.get("state") === state, "Wrong callback state");
        code = url.searchParams.get("code") || "";
      }
      if (!code) return false;
      const data = await jsonRequest("https://api.devin.ai/auth/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, code_verifier: p.verifier }),
      });
      assert(data.token, "Devin did not return a token");
      this.saveLogin("devin", {
        windsurf_api_key: "devin-session-token$" + data.token,
        api_server_url: "https://server.codeium.com",
      });
      p.close?.();
      this.pending.delete(state);
      return true;
    }
    const data = await jsonRequest(
      p.origin + "/v2/plugin/auth/token?state=" + encodeURIComponent(state),
      { headers: this.noAuth() },
    );
    if (data.code === 11217) return false;
    const domain = new URL(p.origin).host,
      auth = this.normalizeAuth(object(data.data), domain);
    let account;
    for (let i = 0; i < 10; i++) {
      const response = await jsonRequest(p.origin + "/v2/plugin/account", {
        headers: {
          Authorization: "Bearer " + auth.accessToken,
          "X-Domain": domain,
        },
      });
      if (response.code !== 12151) {
        account = response.data;
        break;
      }
      await sleep(1000);
    }
    assert(
      account && typeof account === "object",
      "Cannot read account after login",
    );
    this.saveLogin(source, {
      origin: p.origin,
      site: p.site,
      auth,
      account,
    });
    this.pending.delete(state);
    return true;
  }
  logout(source: string) {
    this.store.put("subscription:" + source, null);
    for (const [key, p] of this.pending)
      if (p.source === source) {
        p.close?.();
        this.pending.delete(key);
      }
  }
  close() {
    for (const p of this.pending.values()) p.close?.();
  }
  async load(source: string, settings: Obj = {}): Promise<Obj> {
    if (["codebuddy", "workbuddy"].includes(source))
      return this.buddy(source, settings);
    if (source === "devin") return this.devin(settings);
    return this.local(source);
  }
  installed() {
    const roots = [
      process.env.NOVA_CODEBUDDY_PACKAGE,
      process.env.APPDATA &&
        join(
          process.env.APPDATA,
          "npm/node_modules/@tencent-ai/codebuddy-code",
        ),
      ...(process.env.PATH || "")
        .split(delimiter)
        .flatMap((p) => [
          join(p, "node_modules/@tencent-ai/codebuddy-code"),
          resolve(p, "../lib/node_modules/@tencent-ai/codebuddy-code"),
        ]),
    ].filter(Boolean) as string[];
    for (const path of roots) {
      const pkg = localJSON(join(path, "package.json"), true);
      if (pkg.name === "@tencent-ai/codebuddy-code")
        return { path, version: pkg.version };
    }
    return { path: undefined, version: "2.169.0" };
  }
  async buddy(source: string, settings: Obj) {
    const work = source === "workbuddy",
      prefix = source.toUpperCase(),
      home = homedir(),
      dir = process.env[prefix + "_CONFIG_DIR"] || join(home, "." + source);
    const cfg = localJSON(join(dir, "settings.json"), true);
    const env = { ...process.env, ...cfg.env };
    const key = work
      ? process.env.WORKBUDDY_AUTH_TOKEN ||
        process.env.WORKBUDDY_API_KEY ||
        cfg.env?.CODEBUDDY_AUTH_TOKEN ||
        cfg.env?.CODEBUDDY_API_KEY
      : env.CODEBUDDY_AUTH_TOKEN || env.CODEBUDDY_API_KEY;
    const dataRoot =
      process.platform === "win32"
        ? join(home, "AppData/Local")
        : process.platform === "darwin"
          ? join(home, "Library/Application Support")
          : join(home, ".local/share");
    const authPath =
      process.env["NOVA_" + prefix + "_AUTH_FILE"] ||
      join(
        dataRoot,
        "CodeBuddyExtension/Data/Public/auth",
        work ? "workbuddy-desktop.info" : "Tencent-Cloud.coding-copilot.info",
      );
    let session: Obj = {},
      pkg = this.installed(),
      version = work ? "5.8.2" : pkg.version;
    const configured =
      process.env.WORKBUDDY_EXE || settings.workbuddyPath || "";
    const cli = work ? locateWorkBuddy(configured) : "";
    let packagePath =
      process.env.NOVA_WORKBUDDY_PACKAGE ||
      (cli ? dirname(dirname(cli)) : undefined);
    let exe =
      process.env.WORKBUDDY_EXE ||
      (packagePath
        ? resolve(packagePath, "../../../WorkBuddy.exe")
        : undefined);
    if (work && packagePath) {
      const product = localJSON(join(packagePath, "product.json"));
      assert(
        product.authentication?.id === "workbuddy-desktop",
        "Select WorkBuddy built-in CLI, not global CodeBuddy",
      );
      version = product.genieVersion || version;
    }
    if (!key) {
      try {
        assert(!existsSync(authPath + ".logged-out"), "CLI is logged out");
        session = localJSON(authPath);
        assert(
          !session.auth?.expiresAt || session.auth.expiresAt > Date.now(),
          "CLI login expired",
        );
        if (work && typeof session.auth?.accessToken === "object") {
          assert(exe, "Set WorkBuddy executable path to decrypt its login");
          const identity = createHash("sha256")
            .update(
              JSON.stringify([
                exe,
                statSync(exe).mtimeMs,
                session.auth.accessToken,
              ]),
            )
            .digest("hex");
          if (this.workbuddyTokens.has(identity)) {
            session.auth.accessToken = this.workbuddyTokens.get(identity);
          } else {
            const { stdout } = await exec(
              exe,
              [
                "-e",
                this.workbuddyHelper,
                "--",
                "--nova-workbuddy-login",
                authPath,
              ],
              {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
                timeout: 15000,
                maxBuffer: 65536,
                windowsHide: true,
              },
            );
            const data = JSON.parse(stdout);
            assert(
              JSON.stringify(data.envelope) ===
                JSON.stringify(session.auth.accessToken),
              "WorkBuddy login changed during decryption",
            );
            assert(
              typeof data.accessToken === "string" && data.accessToken.trim(),
              "Cannot decrypt WorkBuddy login",
            );
            session.auth.accessToken = data.accessToken;
            this.workbuddyTokens.set(identity, data.accessToken);
            if (this.workbuddyTokens.size > 16)
              this.workbuddyTokens.delete(
                this.workbuddyTokens.keys().next().value!,
              );
          }
        }
      } catch {
        session = await this.saved(source);
      }
    }
    const accessToken = key || session.auth?.accessToken;
    assert(
      typeof accessToken === "string" && accessToken,
      `Login to ${source} first`,
    );
    const origin =
      process.env["NOVA_" + prefix + "_ENDPOINT"] ||
      session.origin ||
      "https://" +
        (session.auth?.domain ||
          (work ? "www.workbuddy.cn" : "www.codebuddy.ai"));
    const url = httpURL(origin, true);
    assert(
      url.protocol === "https:" ||
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "Subscription endpoint must be HTTPS",
    );
    const label = work ? "WorkBuddy" : "CodeBuddy";
    const headers: Obj = {
      "User-Agent": `CLI/${version} ${label}/${version}`,
      "X-IDE-Type": work ? "WorkBuddy" : "CLI",
      "X-IDE-Version": version,
      "X-Product": label,
      "X-Agent-Intent": "craft",
      "X-Agent-Runtime": "local-agent",
    };
    for (const [h, k] of [
      ["X-User-Id", "uid"],
      ["X-Enterprise-Id", "enterpriseId"],
    ])
      if (session.account?.[k] != null) headers[h] = String(session.account[k]);
    return {
      name: label + "（本地 API）",
      api: "codebuddy",
      options: {
        baseURL: url.origin + "/v2",
        apiKey: accessToken,
        headers,
        codebuddySource: source,
        codebuddyPackage: work ? packagePath : pkg.path,
        codebuddyModel: process.env[prefix + "_MODEL"] || cfg.model,
        requiresReasoningContentOnAssistantMessages: true,
      },
      models: {},
    };
  }
  async devin(settings: Obj) {
    const configRoot =
      process.platform === "win32"
        ? process.env.APPDATA
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const dataRoot =
      process.platform === "win32"
        ? process.env.APPDATA
        : process.platform === "darwin"
          ? join(homedir(), "Library/Application Support")
          : process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
    let saved: Obj | undefined;
    for (const root of [configRoot, dataRoot])
      if (root && existsSync(join(root, "devin/credentials.toml"))) {
        saved = parseTOML(join(root, "devin/credentials.toml"));
        break;
      }
    saved ??= await this.saved("devin");
    assert(
      saved.windsurf_api_key,
      "Devin credentials missing windsurf_api_key",
    );
    const url = httpURL(saved.api_server_url || "https://server.codeium.com");
    assert(!url.search && !url.hash, "Invalid Devin endpoint");
    const cfg = localJSON(
      join(
        process.env.DEVIN_CONFIG_HOME || configRoot || "",
        "devin/config.json",
      ),
      true,
    );
    return {
      name: "Devin（本地 API）",
      api: "devin",
      options: {
        baseURL: url.href.replace(/\/$/, ""),
        apiKey: saved.windsurf_api_key,
        devinCli: settings.devinPath || "devin",
        devinModel: process.env.DEVIN_MODEL || cfg.agent?.model || "adaptive",
        supportsReasoningEffort: false,
        supportsThinkingToggle: false,
      },
      models: {},
    };
  }
  async local(source: string) {
    assert(["codex", "claude-code"].includes(source), "Unknown local provider");
    if (source === "codex") {
      const root = process.env.CODEX_HOME || join(homedir(), ".codex");
      let cfg = parseTOML(join(root, "config.toml"));
      if (cfg.profile) {
        assert(cfg.profiles?.[cfg.profile], "Codex profile not found");
        cfg = { ...cfg, ...cfg.profiles[cfg.profile] };
      }
      const provider = cfg.model_provider || "openai",
        p = object(cfg.model_providers?.[provider]);
      assert(
        provider === "openai" || Object.keys(p).length,
        "Codex custom provider not found",
      );
      assert(
        !Object.keys(p.query_params || {}).length,
        "Codex query_params not supported by source protocol",
      );
      const auth = localJSON(join(root, "auth.json"), true);
      const apiKey = p.env_key
        ? process.env[p.env_key]
        : p.experimental_bearer_token ||
          auth.OPENAI_API_KEY ||
          process.env.OPENAI_API_KEY ||
          "";
      const headers: Obj = { ...p.http_headers };
      for (const [h, key] of Object.entries(p.env_http_headers || {})) {
        assert(process.env[String(key)], `Missing ${key}`);
        headers[h] = process.env[String(key)];
      }
      const direct =
        provider !== "openai" ||
        p.base_url ||
        process.env.OPENAI_BASE_URL ||
        apiKey ||
        Object.keys(headers).some((k) => /authorization|api-key/i.test(k));
      const baseURL =
        p.base_url ||
        process.env.OPENAI_BASE_URL ||
        "https://api.openai.com/v1";
      const model = cfg.model;
      return {
        name: "本地 Codex",
        api: direct
          ? p.wire_api === "chat"
            ? "openai-completions"
            : "openai-responses"
          : "openai-responses",
        localAuth: direct ? undefined : "codex",
        options: { baseURL: direct ? baseURL : CODEX, apiKey, headers },
        models: model
          ? {
              [model]: {
                modalities: { input: ["text", "image"] },
                options: { reasoningEffort: cfg.model_reasoning_effort },
              },
            }
          : {},
      };
    }
    const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      cfg = jsonc(read(join(root, "settings.json"), true) || "{}"),
      env = { ...process.env, ...cfg.env };
    const direct =
      env.ANTHROPIC_BASE_URL ||
      env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN;
    assert(!cfg.apiKeyHelper, "Will not execute Claude apiKeyHelper");
    const names = [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ].filter(Boolean);
    return {
      name: "本地 Claude Code",
      api: "anthropic-messages",
      localAuth: direct ? undefined : "claude-code",
      options: {
        baseURL: env.ANTHROPIC_BASE_URL || CLAUDE,
        apiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "",
      },
      models: Object.fromEntries(
        names.map((n) => [n, { modalities: { input: ["text", "image"] } }]),
      ),
    };
  }
  async credentials(source: string): Promise<{ key: string; headers: Obj }> {
    const now = Date.now() + 60000;
    if (source === "codex") {
      const root = process.env.CODEX_HOME || join(homedir(), ".codex"),
        cfg = parseTOML(join(root, "config.toml"));
      let auth: Obj;
      const mode = cfg.cli_auth_credentials_store || "file";
      if (mode === "file") auth = localJSON(join(root, "auth.json"));
      else if (
        ["keyring", "auto"].includes(mode) &&
        process.platform === "darwin" &&
        !cfg.features?.secret_auth_storage
      ) {
        const account =
          "cli|" +
          createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
        try {
          auth = JSON.parse(
            (
              await exec(
                "/usr/bin/security",
                [
                  "find-generic-password",
                  "-s",
                  "Codex Auth",
                  "-a",
                  account,
                  "-w",
                ],
                { timeout: 5000, maxBuffer: 1 << 20 },
              )
            ).stdout,
          );
        } catch (e: any) {
          assert(
            mode === "auto" && e.code === 44,
            "Cannot read Codex keychain",
          );
          auth = localJSON(join(root, "auth.json"));
        }
      } else throw Error("Unsupported Codex credential storage");
      assert(
        (!auth.auth_mode || auth.auth_mode === "chatgpt") &&
          !auth.OPENAI_API_KEY,
        "Codex is not using ChatGPT subscription login",
      );
      const key = auth.tokens?.access_token;
      assert(
        typeof key === "string" &&
          key.length <= 65536 &&
          /^[!-~]+$/.test(key) &&
          key.split(".").length === 3 &&
          key.split(".").every(Boolean),
        "Invalid Codex subscription token",
      );
      const jwt = (s: string) => {
        try {
          return JSON.parse(
            Buffer.from(s.split(".")[1], "base64url").toString(),
          );
        } catch {
          return {};
        }
      };
      const claims = jwt(key || ""),
        idClaims = jwt(auth.tokens?.id_token || ""),
        a = claims["https://api.openai.com/auth"] || {},
        b = idClaims["https://api.openai.com/auth"] || {};
      assert(
        claims.exp * 1000 > now &&
          !a.chatgpt_account_is_fedramp &&
          !b.chatgpt_account_is_fedramp,
        "Codex login expired or requires dedicated upstream",
      );
      const account =
        auth.tokens?.account_id || a.chatgpt_account_id || b.chatgpt_account_id;
      assert(
        typeof account === "string" &&
          account.length <= 65536 &&
          /^[!-~]+$/.test(account) &&
          key,
        "Codex login is missing account",
      );
      return {
        key,
        headers: {
          "chatgpt-account-id": account,
          "OpenAI-Beta": "responses=experimental",
          originator: "nova",
        },
      };
    }
    assert(source === "claude-code", "Unknown subscription source");
    const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      settings = jsonc(read(join(root, "settings.json"), true) || "{}"),
      env = { ...process.env, ...settings.env };
    assert(
      !settings.apiKeyHelper &&
        !env.ANTHROPIC_API_KEY &&
        !env.ANTHROPIC_AUTH_TOKEN,
      "Claude Code is using API authentication; use ordinary API provider",
    );
    assert(
      ![
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
      ].some((k) => /^(1|true|yes|on)$/i.test(String(env[k] || ""))),
      "Claude uses cloud platform authentication",
    );
    let key = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!key) {
      assert(
        !env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR,
        "Cannot borrow another process token descriptor",
      );
      let auth: Obj | undefined;
      if (process.platform === "darwin") {
        const suffix = process.env.CLAUDE_CONFIG_DIR
          ? "-" + createHash("sha256").update(root).digest("hex").slice(0, 8)
          : "";
        try {
          auth = JSON.parse(
            (
              await exec(
                "/usr/bin/security",
                [
                  "find-generic-password",
                  "-s",
                  "Claude Code-credentials" + suffix,
                  "-a",
                  process.env.USER || "",
                  "-w",
                ],
                { timeout: 5000, maxBuffer: 1 << 20 },
              )
            ).stdout,
          );
        } catch (e: any) {
          assert(e.code === 44, "Cannot read Claude keychain");
        }
      }
      auth ??= localJSON(join(root, ".credentials.json"));
      const oauth = auth.claudeAiOauth;
      assert(
        oauth?.expiresAt > now &&
          (!oauth.scopes || oauth.scopes.includes("user:inference")),
        "Claude login expired or lacks inference permission",
      );
      key = oauth.accessToken;
    }
    assert(
      typeof key === "string" &&
        key.startsWith("sk-ant-oat") &&
        !/[\s\r\n]/.test(key),
      "Invalid Claude subscription token",
    );
    return { key, headers: { "anthropic-beta": "oauth-2025-04-20" } };
  }
}
