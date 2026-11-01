import { assert, bounded } from "./util";
import { textSlice } from "./file-read";
import { Buffer } from "node:buffer";

// A running vega-local process on the same machine as this Vega server.
// Registered via loopback /api/local-agent/register, kept alive by ~2s pings.
type Agent = {
  port: number;
  token: string;
  cwd: string;
  lastSeen: number;
};

// Consider the agent online if it pinged within this window. Missed pings
// (sleep, brief network hiccup) are tolerated; a graceful quit deregisters.
const ONLINE_MS = 3500;

export class LocalAgents {
  private agents = new Map<string, Agent>();

  register(port: number, token: string, cwd: string): Agent {
    assert(
      Number.isInteger(port) && port > 0 && port < 65536,
      "Invalid local agent port",
    );
    assert(typeof token === "string" && token.length >= 16, "Invalid token");
    const agent: Agent = { port, token, cwd: cwd || "", lastSeen: Date.now() };
    this.agents.set(String(port), agent);
    return agent;
  }

  ping(port: number, token: string, cwd?: string) {
    const a = this.agents.get(String(port));
    assert(a && a.token === token, "Unknown local agent");
    a.lastSeen = Date.now();
    if (typeof cwd === "string") a.cwd = cwd;
    return a;
  }

  remove(port: number, token: string) {
    const a = this.agents.get(String(port));
    if (a && a.token === token) this.agents.delete(String(port));
  }

  // Most recently-seen agent on this machine, or undefined when none is live.
  active(): Agent | undefined {
    const now = Date.now();
    let best: Agent | undefined;
    for (const a of this.agents.values()) {
      if (now - a.lastSeen > ONLINE_MS) continue;
      if (!best || a.lastSeen > best.lastSeen) best = a;
    }
    return best;
  }

  online() {
    return this.active() !== undefined;
  }
}

async function call(agent: Agent, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${agent.port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Local-Token": agent.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(660000),
  });
  const text = await bounded(response);
  if (!response.ok) throw Error(`Local agent HTTP ${response.status}`);
  return JSON.parse(text.toString());
}

// ---- tool behavior parity ----

// Mirror server shell(): same Outcome shape so the model sees no difference.
export async function localShell(agent: Agent, cwd: string, a: any) {
  const timeout = a.timeout ?? 120;
  const r = await call(agent, "/exec", {
    cwd,
    command: a.command,
    timeout: Number.isInteger(timeout) && timeout >= 1 && timeout <= 600 ? timeout : 120,
  });
  return {
    value: {
      output: String(r.output ?? ""),
      truncated: r.truncated === true,
      exitCode: Number(r.exitCode ?? -1),
      ...(r.error ? { error: String(r.error) } : {}),
    },
    error: (Number(r.exitCode) !== 0) || Boolean(r.error),
  };
}

// Mirror the file branch of Tools.read for plain filesystem paths: stat +
// text read + numbered slice. Images are kept on the server (sharp/blob)
// because they need the BLOB store; only text is delegated.
export async function localRead(agent: Agent, path: string, a: any) {
  const st = await call(agent, "/file", { op: "stat", path });
  assert(st.isFile, `Not a regular file on local machine: ${path}`);
  assert(st.size <= 32 << 20, "Text file exceeds32MiB; use bounded shell extraction");
  const r = await call(agent, "/file", { op: "read", path });
  assert(!r.error, r.error);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(r.content, "base64"),
  );
  assert(!content.includes("\0"), "Not a UTF-8 text file");
  return {
    value: { path, ...textSlice(content, a.offset, a.limit) },
  };
}

export async function localWrite(agent: Agent, path: string, content: string) {
  const r = await call(agent, "/file", {
    op: "write",
    path,
    content: Buffer.from(content, "utf8").toString("base64"),
  });
  assert(!r.error, r.error);
  return { value: { path, bytes: Buffer.byteLength(content) } };
}

// Edit is delegated verbatim: the local agent applies the same exact-match
// replacement and returns the change list the model expects.
export async function localEdit(agent: Agent, path: string, edits: any[]) {
  const r = await call(agent, "/file", { op: "edit", path, edits });
  assert(!r.error, r.error);
  return {
    value: {
      path,
      bytes: r.bytes,
      ...(r.changes?.length ? { changes: r.changes } : {}),
    },
  };
}

// change_working_directory: just verify the directory exists locally.
export async function localCwdExists(agent: Agent, path: string) {
  const st = await call(agent, "/file", { op: "stat", path });
  assert(st.isDir, `Not a directory on local machine: ${path}`);
}
