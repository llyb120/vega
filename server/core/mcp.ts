import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assert, expand, id, object, clip, type Obj } from "./util";
import type { CloudRuntime } from "./cloud";
export class MCP {
  connections = new Map<string, Client>();
  connecting = new Map<string, Promise<Client>>();
  async connection(name: string) {
    let pending = this.connecting.get(name);
    if (!pending) {
      pending = this.connect(name);
      this.connecting.set(name, pending);
      void pending
        .finally(() => {
          if (this.connecting.get(name) === pending)
            this.connecting.delete(name);
        })
        .catch(() => {});
    }
    return pending;
  }

  described = new Map<string, string>();
  pages = new Map<
    string,
    { server: string; query: string; rows: any[]; remote?: string }
  >();
  constructor(
    public config: Record<string, Obj> = {},
    public cwd: string,
    private cloud?: CloudRuntime,
  ) {}
  async connect(name: string) {
    if (this.connections.has(name)) return this.connections.get(name)!;
    const cfg = this.config[name];
    assert(cfg && cfg.enabled !== false, "MCP server not enabled/configured");
    const client = new Client(
      { name: "vega", version: "0.2.0" },
      { capabilities: {} },
    );
    const expanded = (h: Obj) =>
      Object.fromEntries(
        Object.entries(h || {}).map(([k, v]) => [k, this.cloud ? String(v) : expand(String(v))]),
      );
    const launch = !cfg.url && this.cloud?.launch(cfg.command, cfg.args || [], cfg.cwd || this.cwd || (await this.cloud.identity()).cwd, expanded(cfg.env));
    const transport = cfg.url
      ? new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: expanded(cfg.headers) },
        })
      : new StdioClientTransport({
          ...(launch || {
            command: cfg.command,
            args: cfg.args || [],
            cwd: cfg.cwd || this.cwd,
            env: { ...process.env, ...expanded(cfg.env) } as Record<string, string>,
          }),
          stderr: "pipe",
        });
    try {
      await client.connect(transport, {
        timeout: cfg.startupTimeoutMs || 10000,
      });
      this.connections.set(name, client);
      client.onclose = () => {
        if (this.connections.get(name) === client)
          this.connections.delete(name);
        for (const key of this.described.keys())
          if (key.startsWith(name + "/")) this.described.delete(key);
      };
      return client;
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }
  async close() {
    await Promise.allSettled([...this.connecting.values()]);
    this.connecting.clear();
    this.described.clear();
    this.pages.clear();
    await Promise.all(
      [...this.connections.values()].map((c) => c.close().catch(() => {})),
    );
    this.connections.clear();
  }
  async definition(client: Client, name: string) {
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await client.listTools({ cursor });
      const def = result.tools.find((t) => t.name === name);
      if (def) return def;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    throw Error("MCP tool not found within 32-page discovery budget");
  }
  async execute(a: Obj, readOnly = false, signal?: AbortSignal): Promise<any> {
    if (a.op === "list" && !a.server) {
      return {
        servers: await Promise.all(
          Object.keys(this.config).map(async (name) => {
            try {
              await this.connection(name);
              return { name, available: true };
            } catch (e: any) {
              return { name, available: false, error: e.message };
            }
          }),
        ),
      };
    }
    const client = await this.connection(a.server),
      key = a.server + "/" + a.tool;
    if (a.op === "describe") {
      const def = await this.definition(client, a.tool);
      this.described.set(key, JSON.stringify(def));
      return def;
    }
    if (a.op === "call") {
      assert(
        this.described.has(key),
        "MCP call requires successful describe in this session",
      );
      assert(
        !readOnly || this.config[a.server].readOnlyTools?.includes(a.tool),
        "Tool not in local read-only allowlist; annotations are not authorization",
      );
      const def = await this.definition(client, a.tool);
      assert(
        JSON.stringify(def) === this.described.get(key),
        "MCP definition changed; describe again",
      );
      try {
        return await client.callTool(
          { name: a.tool, arguments: object(a.arguments) },
          undefined,
          { timeout: this.config[a.server].requestTimeoutMs || 30000, signal },
        );
      } catch (e: any) {
        throw Error(
          `MCP call failed and may have executed; never retry automatically: ${e.message}`,
        );
      }
    }
    assert(a.op === "list", "MCP op must be list/describe/call");
    const limit = a.limit ?? 20;
    assert(
      Number.isInteger(limit) && limit >= 1 && limit <= 50,
      "MCP list limit is 1–50",
    );
    const query = String(a.query || "").toLowerCase();
    let page: { server: string; query: string; rows: any[]; remote?: string } =
      { server: a.server, query, rows: [], remote: undefined };
    if (a.cursor) {
      const saved = this.pages.get(a.cursor);
      assert(
        saved && saved.server === a.server && saved.query === query,
        "Invalid MCP discovery cursor",
      );
      page = saved;
    }
    if (!page.rows.length) {
      const result = await client.listTools({ cursor: page.remote });
      page.remote = result.nextCursor;
      page.rows = result.tools
        .filter(
          (t) =>
            !query ||
            (t.name + " " + t.description).toLowerCase().includes(query),
        )
        .map((t) => ({
          name: t.name,
          description: clip(t.description || "", 300),
        }));
    }
    const tools = page.rows.splice(0, limit);
    let nextCursor;
    if (page.rows.length || page.remote) {
      nextCursor = id();
      this.pages.set(nextCursor, page);
    }
    return { tools, nextCursor, moreAvailable: !!nextCursor };
  }
}
