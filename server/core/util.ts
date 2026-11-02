import { randomUUID } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { fetch as proxyFetch } from "undici";
import { dispatcher as proxyDispatcher } from "./proxy";
export type Obj = Record<string, any>;
export const id = (prefix = "") => prefix + randomUUID().replaceAll("-", "");
export const clone = <T>(v: T): T => structuredClone(v);
export const object = (v: any): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
export const clip = (value: string, n = 32768) =>
  [...value].length > n
    ? [...value].slice(0, n).join("") +
      "\n[truncated; original archived in SQLite]"
    : value;
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((yes, no) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function abort() {
      clearTimeout(timer);
      no(signal?.reason);
    }
    function done() {
      signal?.removeEventListener("abort", abort);
      yes();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
export const expand = (s: string) =>
  s.replace(
    /\{env:([\w]+)\}|\$\{([\w]+)\}/g,
    (_, a, b) => process.env[a || b] || "",
  );
export function httpURL(raw: string, originOnly = false) {
  const u = new URL(raw);
  assert(
    ["http:", "https:"].includes(u.protocol) && !u.username && !u.password,
    "HTTP(S) URL without credentials required",
  );
  if (originOnly)
    assert(!u.search && !u.hash && u.pathname === "/", "URL must be an origin");
  return u;
}
export async function bounded(response: Response, max = 32 * 1024 * 1024) {
  assert(response.body, "Response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= max, "Response exceeds byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function request(
  url: string,
  init: RequestInit = {},
  timeout = 180000,
  headersTimeout = 180000,
): Promise<Response> {
  const dispatcher = await proxyDispatcher();
  // Nova gives model streams 180s for response headers, then a fresh 180s idle budget per chunk.
  const controller = timeout === 0 ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(
        () => controller.abort(Error(`HTTP response headers timed out after ${headersTimeout / 1000}s`)),
        headersTimeout,
      )
    : undefined;
  try {
    return (await proxyFetch(url, {
      ...init,
      redirect: init.redirect || "manual",
      signal:
        timeout > 0
          ? AbortSignal.any([
              AbortSignal.timeout(timeout),
              ...(init.signal ? [init.signal] : []),
            ])
          : AbortSignal.any([
              controller!.signal,
              ...(init.signal ? [init.signal] : []),
            ]),
      dispatcher,
    } as any)) as unknown as Response;
  } finally {
    clearTimeout(timer);
  }
}
export async function jsonRequest(
  url: string,
  init: RequestInit = {},
  timeout = 30000,
) {
  const r = await request(url, init, timeout);
  assert(r.ok, `HTTP ${r.status} from ${new URL(url).origin}`);
  return JSON.parse((await bounded(r)).toString("utf8"));
}
export function nativeArguments(text: string) {
  let value: any = text ? JSON.parse(text) : {};
  for (let depth = 0; typeof value === "string" && depth < 3; depth++)
    value = JSON.parse(value);
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Tool arguments must be a complete JSON object",
  );
  return value as Obj;
}
export function localJSON(file: string, optional = false, max = 4 << 20): Obj {
  try {
    const st = statSync(file);
    assert(
      st.isFile() && st.size <= max,
      "Credential/config file has invalid type or size",
    );
    return object(JSON.parse(readFileSync(file, "utf8")));
  } catch (e: any) {
    if (optional && e.code === "ENOENT") return {};
    throw e;
  }
}
export async function workspaceFile(cwd: string, input: string) {
  assert(input.trim(), "File required");
  const root = await realpath(cwd),
    file = await realpath(resolve(root, input)),
    rel = relative(root, file);
  assert(
    rel !== ".." &&
      !rel.startsWith(".." + sep) &&
      !isAbsolute(rel) &&
      statSync(file).isFile(),
    "Only regular files within the working directory may be uploaded",
  );
  return file;
}
export class Mutex {
  private tail = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((yes) => (release = yes));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
export class Redactor {
  values = new Set<string>();
  add(s: string) {
    if (!s) return;
    this.values.add(s);
    for (const line of s.split("\n"))
      if (line.length >= 4) this.values.add(line);
  }
  text(s: string) {
    for (const v of this.values) s = s.split(v).join("[credential redacted]");
    return s;
  }
  value<T>(v: T): T {
    const walk = (x: any): any =>
      typeof x === "string"
        ? this.text(x)
        : Array.isArray(x)
          ? x.map(walk)
          : x && typeof x === "object"
            ? Object.fromEntries(
                Object.entries(x).map(([k, v]) => [k, walk(v)]),
              )
            : x;
    return walk(v);
  }
}
export async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  idleMs = 180000,
) {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const cancel = (reason: unknown) => {
          reject(reason);
          void reader.cancel().catch(() => {});
        };
        timer = setTimeout(() => cancel(Error(`Stream idle for ${idleMs}ms`)), idleMs);
        abort = () => cancel(signal!.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
export async function* sse(
  response: Response,
  signal?: AbortSignal,
  idleMs = 180000,
  maxEventBytes = 8 << 20,
) {
  assert(response.body, "Missing stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await readChunk(reader, signal, idleMs);
      buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll(
        "\r\n",
        "\n",
      );
      assert(buffer.length <= maxEventBytes, "SSE event exceeds budget");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split("\n");
        const data = lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data)
          yield {
            event: lines
              .find((l) => l.startsWith("event:"))
              ?.slice(6)
              .trim(),
            data,
          };
        else yield { event: "activity", data: "" };
      }
      if (done) {
        if (buffer.trim()) throw Error("Truncated SSE event");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
