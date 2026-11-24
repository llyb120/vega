import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { assert, id, type Obj } from "./util";

const EXTENSION_ID = "bhiemmbmefifaloapbcopihahhckolce";

const LONG_OPS = new Set([
  "view", "act", "open", "new_tab", "goto", "reload", "eval",
  "cookies_export", "cookies_import", "apply_storage",
]);
const MED_OPS = new Set([
  "cdp", "devtools", "debug", "select_tab", "close_tab", "back", "forward",
  "stop", "downloads", "cursor_hide", "reload_ext", "set_proxy", "tabs", "status", "connect",
]);

export function requestTimeout(operation: string) {
  if (LONG_OPS.has(operation)) return 25000;
  if (MED_OPS.has(operation)) return 10000;
  return 8000;
}

const CLIENT_UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function browserNameFromUA(ua: string) {
  if (ua.includes("Edg/")) return "Microsoft Edge";
  if (ua.includes("OPR/")) return "Opera";
  if (ua.includes("Chrome/")) return "Google Chrome";
  return "unknown";
}

export class ChromeBridge {
  server?: Server;
  wss?: WebSocketServer;
  port = 0;
  token = randomBytes(32).toString("hex");
  clients = new Map<string, { at: number; browser: string; ws?: WebSocket }>();
  primaryID = "";
  queues = new Map<string, Obj[]>();
  pending = new Map<
    string,
    {
      client: string;
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  queued = new EventEmitter();
  onPoll?: () => void;
  version = "0.2.5";

  constructor(public privateInstance = false, public runtime = "") {}

  setRuntime(runtime: string) {
    if (!runtime || runtime === this.runtime) return;
    this.runtime = runtime;
    const hello = JSON.stringify({ type: "hello", version: this.version, runtime: this.runtime });
    for (const c of this.clients.values()) {
      if (c.ws && c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.send(hello); } catch {}
      }
    }
  }

  async start() {
    if (this.server) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 });
    const ports = this.privateInstance ? [0] : process.env.VEGA_CHROME_PORT
      ? [Number(process.env.VEGA_CHROME_PORT)]
      : Array.from({ length: 10 }, (_, n) => 47753 + n);
    for (const port of ports) {
      const server = createServer((req, res) => {
        void this.serve(req, res).catch((e) => {
          if (!res.headersSent) res.writeHead(400);
          if (!res.writableEnded) res.end(JSON.stringify({ error: e.message }));
        });
      });
      server.maxConnections = 32;
      server.headersTimeout = 10000;
      server.requestTimeout = 25000;
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
      try {
        await new Promise<void>((yes, no) => {
          server.once("error", no);
          server.listen(port, "127.0.0.1", yes);
        });
        this.server = server;
        this.port = (server.address() as import("node:net").AddressInfo).port;
        return;
      } catch (e: any) {
        server.close();
        if (e.code !== "EADDRINUSE") throw e;
      }
    }
    this.wss.close();
    this.wss = undefined;
    throw Error("Chrome extension loopback ports 47753–47762 are occupied");
  }

  private handleUpgrade(req: any, socket: any, head: Buffer) {
    const extOrigin = "chrome-extension://" + EXTENSION_ID;
    if (req.headers.origin !== extOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    if (parsed.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const clientId = parsed.searchParams.get("clientId") || "";
    const authHeader = String(req.headers.authorization || "");
    const tok = parsed.searchParams.get("token") || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");
    if (!CLIENT_UUID_RE.test(clientId) || tok !== this.token) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      if (this.privateInstance) this.primaryID = clientId;
      const old = this.clients.get(clientId)?.ws;
      const ua = String(req.headers["user-agent"] || "");
      this.clients.set(clientId, { at: Date.now(), browser: browserNameFromUA(ua), ws });
      if (old && old !== ws) {
        try { old.close(1000, "replaced"); } catch {}
      }
      this.onPoll?.();
      try {
        ws.send(JSON.stringify({ type: "hello", version: this.version, runtime: this.runtime }));
      } catch {}

      // Flush any commands queued while reconnecting.
      const queue = this.queues.get(clientId);
      if (queue?.length) {
        while (queue.length) {
          const cmd = queue.shift()!;
          if (this.pending.has(cmd.id) && cmd.expiresAt > Date.now()) {
            try {
              ws.send(JSON.stringify({ type: "cmd", id: cmd.id, op: cmd.operation, args: cmd.args, expiresAt: cmd.expiresAt }));
            } catch {}
          }
        }
      }

      ws.on("message", (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const cur = this.clients.get(clientId);
        if (cur) cur.at = Date.now();
        if (msg.type === "ping") {
          try { ws.send('{"type":"pong"}'); } catch {}
          return;
        }
        if (msg.type === "reply" && msg.id) {
          const pending = this.pending.get(msg.id);
          if (pending && pending.client === clientId) {
            if (msg.error || msg.ok === false) pending.reject(Error(msg.error || "Chrome command failed"));
            else pending.resolve(msg.result);
          }
          return;
        }
        if (msg.type === "miniapp_triggers") {
          try { ws.send(JSON.stringify({ type: "host_reply", id: msg.id, result: { triggers: [] } })); } catch {}
          return;
        }
        if (msg.type === "miniapp_launch") {
          try { ws.send(JSON.stringify({ type: "host_reply", id: msg.id, error: "No published miniapp launcher configured" })); } catch {}
        }
      });

      ws.on("close", () => {
        const cur = this.clients.get(clientId);
        if (cur?.ws === ws) {
          this.clients.delete(clientId);
          this.queues.delete(clientId);
          if (this.primaryID === clientId) this.primaryID = "";
        }
      });
    });
  }

  live() {
    for (const [key, v] of this.clients) {
      const wsOpen = v.ws && v.ws.readyState === WebSocket.OPEN;
      if (!wsOpen && Date.now() - v.at > 45000) {
        this.clients.delete(key);
        this.queues.delete(key);
      }
    }
    return [...this.clients].sort(([a], [b]) => a.localeCompare(b));
  }

  primary() {
    const live = this.live(),
      current = live.find(([key]) => key === this.primaryID),
      chrome = live.find(([, v]) => v.browser === "Google Chrome");
    const next =
      current && (this.privateInstance || current[1].browser === "Google Chrome" || !chrome)
        ? current
        : chrome || live[0];
    this.primaryID = next?.[0] || "";
    return next;
  }

  status() {
    return {
      connected: !!this.primary(),
      browser: this.primary()?.[1].browser,
      browsers: this.live().map(([, v]) => v.browser),
      origin: `http://127.0.0.1:${this.port}`,
      extensionId: EXTENSION_ID,
      extensionVersion: this.version,
    };
  }

  hideCursor(tabTag?: string) {
    const payload = JSON.stringify({
      type: "cmd",
      id: id(),
      op: "cursor_hide",
      args: { immediate: false, ...(tabTag ? { tabTag } : {}) },
    });
    for (const [, v] of this.live()) {
      if (v.ws && v.ws.readyState === WebSocket.OPEN) {
        try { v.ws.send(payload); } catch {}
      }
    }
  }

  async request(
    operation: string,
    args: Obj,
    signal?: AbortSignal,
    client = this.primary()?.[0],
  ): Promise<any> {
    assert(
      client,
      "Chrome extension is not connected; load local/extension/vega-chrome in Chrome",
    );
    signal?.throwIfAborted();
    const key = id(),
      timeout = requestTimeout(operation),
      expiresAt = Date.now() + timeout;
    return await new Promise((resolve, reject) => {
      const queue = this.queues.get(client!) || [];
      assert(queue.length < 128, "Chrome command queue is full");
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(key);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(
          Error(
            "Chrome operation cancelled; it may already have executed, inspect before deciding",
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          Error(
            "Chrome response timeout; operation may have executed, do not replay",
          ),
        );
      }, timeout);
      this.pending.set(key, {
        client: client!,
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });

      const peer = this.clients.get(client!);
      if (peer?.ws && peer.ws.readyState === WebSocket.OPEN) {
        try {
          peer.ws.send(JSON.stringify({ type: "cmd", id: key, op: operation, args, expiresAt }));
          return;
        } catch {}
      }
      queue.push({ id: key, operation, args, expiresAt });
      this.queues.set(client!, queue);
      this.queued.emit(client!);
    });
  }

  async serve(req: any, res: any) {
    const origin = "chrome-extension://" + EXTENSION_ID;
    if (req.headers.origin !== origin) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Invalid Chrome extension origin" }));
      req.resume();
      return;
    }
    res.setHeader("Connection", "close");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Content-Type", "application/json");
    const send = (data: any) => {
      if (!res.writableEnded) res.end(JSON.stringify(data));
    };
    const path = (req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") {
      send({});
      return;
    }
    if (path === "/health" && (req.method === "GET" || req.method === "POST")) {
      send({ ok: true, app: "vega", version: this.version });
      return;
    }
    assert(req.method === "POST", "POST required");
    if (path === "/pair") {
      assert(!this.privateInstance || req.headers.authorization === "Bearer " + this.token, "Private browser pairing denied");
      // The extension refuses any bridge that does not identify itself as Vega; Nova's client never answers here.
      send({ token: this.token, app: "vega" });
      return;
    }
    assert(
      req.headers.authorization === "Bearer " + this.token,
      "Chrome bridge unauthorized",
    );
    assert(
      ["/poll", "/reply", "/miniapp/triggers", "/miniapp/launch"].includes(path),
      "Unknown bridge route",
    );
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      assert(bytes <= 32 << 20, "Bridge body too large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert(
      typeof body.clientId === "string" && CLIENT_UUID_RE.test(body.clientId),
      "Invalid extension client ID",
    );
    if (path === "/poll") {
      if (this.privateInstance) this.primaryID = body.clientId;
      const ua = req.headers["user-agent"] || "";
      this.clients.set(body.clientId, {
        at: Date.now(),
        browser: browserNameFromUA(ua),
      });
      this.onPoll?.();
      const take = () => {
        const queue = this.queues.get(body.clientId) || [];
        while (queue.length) {
          const cmd = queue.shift()!;
          if (this.pending.has(cmd.id) && cmd.expiresAt > Date.now())
            return cmd;
        }
        return null;
      };
      let command = take();
      if (!command) {
        command = await new Promise((resolve) => {
          const finish = () => {
              clearTimeout(timer);
              this.queued.off(body.clientId, check);
              resolve(take());
            },
            check = () => {
              if ((this.queues.get(body.clientId) || []).some((c) => this.pending.has(c.id))) finish();
            },
            timer = setTimeout(finish, 20000);
          this.queued.on(body.clientId, check);
          res.once("close", finish);
        });
      }
      send({ command, version: this.version });
      return;
    }
    if (path === "/reply") {
      const pending = this.pending.get(body.id);
      if (pending && pending.client === body.clientId) {
        if (body.error) pending.reject(Error(body.error));
        else pending.resolve(body.result);
      }
      send({ ok: true });
      return;
    }
    if (path === "/miniapp/triggers") {
      send({ triggers: [] });
      return;
    }
    throw Error("No published miniapp launcher configured");
  }

  close() {
    for (const p of this.pending.values()) p.reject(Error("Chrome bridge stopped"));
    this.pending.clear();
    for (const c of this.clients.values()) {
      try { c.ws?.close(); } catch {}
    }
    this.wss?.close();
    this.wss = undefined;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.clients.clear();
    this.queues.clear();
    this.primaryID = "";
  }
}
