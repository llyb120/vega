import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { assert, id, type Obj } from "./util";
const EXTENSION_ID = "mdicifjlbgnkkdkcbfdnebeghhlamjbm";

/** Navigation / readiness probes need headroom for extension reconnect gaps; CDP stays aligned. */
const BRIDGE_NAV = new Set(["tabs", "goto", "open", "new_tab", "status", "close_tab", "back", "forward", "reload", "downloads", "connect"]);
export function requestTimeout(operation: string) {
  if (["cdp", "devtools"].includes(operation) || BRIDGE_NAV.has(operation)) return 10000;
  // act / evaluate / inspect / screenshot / run: slightly above the old 3s default
  return 8000;
}
export class ChromeBridge {
  server?: Server;
  port = 0;
  token = randomBytes(32).toString("hex");
  clients = new Map<string, { at: number; browser: string }>();
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
  version = "0.1.15";
  constructor(public privateInstance = false) {}
  async start() {
    if (this.server) return;
    const ports = this.privateInstance ? [0] : process.env.NOVA_CHROME_PORT
      ? [Number(process.env.NOVA_CHROME_PORT)]
      : Array.from({ length: 10 }, (_, n) => 47653 + n);
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
    throw Error("Chrome extension loopback ports 47653–47662 are occupied");
  }
  live() {
    for (const [key, v] of this.clients)
      if (Date.now() - v.at > 45000) {
        this.clients.delete(key);
        this.queues.delete(key);
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
  async request(
    operation: string,
    args: Obj,
    signal?: AbortSignal,
    client = this.primary()?.[0],
  ): Promise<any> {
    assert(
      client,
      "Chrome extension is not connected; load extensions/nova-chrome in Chrome",
    );
    signal?.throwIfAborted();
    const key = id(),
      timeout = requestTimeout(operation);
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
      queue.push({ id: key, operation, args, expiresAt: Date.now() + timeout });
      this.queues.set(client!, queue);
      signal?.addEventListener("abort", abort, { once: true });
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
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Content-Type", "application/json");
    const send = (data: any) => {
      if (!res.writableEnded) res.end(JSON.stringify(data));
    };
    if (req.method === "OPTIONS") {
      send({});
      return;
    }
    assert(req.method === "POST", "POST required");
    if (req.url === "/pair") {
      assert(!this.privateInstance || req.headers.authorization === "Bearer " + this.token, "Private browser pairing denied");
      send({ token: this.token });
      return;
    }
    assert(
      req.headers.authorization === "Bearer " + this.token,
      "Chrome bridge unauthorized",
    );
    assert(
      ["/poll", "/reply", "/miniapp/triggers", "/miniapp/launch"].includes(
        req.url,
      ),
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
      typeof body.clientId === "string" &&
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
          body.clientId,
        ),
      "Invalid extension client ID",
    );
    if (req.url === "/poll") {
      // A private bridge has one browser; a reloaded worker supersedes its stale client ID.
      if (this.privateInstance) this.primaryID = body.clientId;
      const ua = req.headers["user-agent"] || "";
      this.clients.set(body.clientId, {
        at: Date.now(),
        browser: ua.includes("Edg/")
          ? "Microsoft Edge"
          : ua.includes("OPR/")
            ? "Opera"
            : ua.includes("Chrome/")
              ? "Google Chrome"
              : "unknown",
      });
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
              if (
                (this.queues.get(body.clientId) || []).some((c) =>
                  this.pending.has(c.id),
                )
              )
                finish();
            },
            timer = setTimeout(finish, 20000);
          this.queued.on(body.clientId, check);
          res.once("close", finish);
        });
      }
      send({ command, version: this.version });
      return;
    }
    if (req.url === "/reply") {
      const pending = this.pending.get(body.id);
      if (pending && pending.client === body.clientId) {
        if (body.error) pending.reject(Error(body.error));
        else pending.resolve(body.result);
      }
      send({ ok: true });
      return;
    }
    if (req.url === "/miniapp/triggers") {
      send({ triggers: [] });
      return;
    }
    throw Error("No published miniapp launcher configured");
  }
  close() {
    for (const p of this.pending.values())
      p.reject(Error("Chrome bridge stopped"));
    this.pending.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.clients.clear();
    this.queues.clear();
    this.primaryID = "";
  }
}
