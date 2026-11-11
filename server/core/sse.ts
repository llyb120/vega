import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { getRequestURL, setHeader, type H3Event } from "h3";

/**
 * Realtime transport: one HTTP request carries the downstream direction as Server-Sent Events, upstream
 * messages are plain POSTs. A WebSocket is a single ordered byte stream, so one big frame stalls every
 * event behind it; here a channel owns several lanes and can ask the page/client for more lanes while
 * a lane is backed up. Lane 0 carries control (ready/mode/results/close), lanes ≥1 carry bulk payloads.
 */
export type Request = { url: string; headers: Headers };
export type SendOptions = { data?: boolean; key?: string };
export type Wire = {
  id: string;
  request: Request;
  /** Enqueues one JSON message; `data` payloads may be spread over the expandable lanes. */
  send(value: unknown, options?: SendOptions): void;
  /** Ends every lane after one final `{type:"closed", code, reason}` so the peer learns why. */
  close(code: number, reason: string): void;
  /** Bytes queued on every lane; a slow peer must never grow memory without bound. */
  readonly buffered: number;
};

/** A lane sink is whatever can accept text and report its backlog (an SSE response, or a test double). */
export type Sink = {
  write(chunk: string): boolean;
  end(): void;
  buffered(): number;
  onclose(callback: () => void): void;
};

/** One lane is idle enough for another payload. */
export const HIGH_WATER = 512 * 1024;
/** An extra lane below this backlog is closed again once it is no longer needed. */
const LOW_WATER = 64 * 1024;
const KEEPALIVE_MS = 15000;
const LANE_PATIENCE_MS = 5000;
const PRUNE_MS = 10000;

type Lane = { index: number; sink: Sink; keepalive: ReturnType<typeof setInterval> };
export type SseOptions = {
  /** Highest data lane index this channel may grow to; 1 disables expansion (ordered byte streams). */
  lanes?: number;
  /** Called when the peer dropped lane 0: the owner must forget this channel. */
  ongone?: () => void;
};

const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";

export class SseChannel {
  id = randomBytes(16).toString("base64url");
  lanes = new Map<number, Lane>();
  /** Lane indexes already announced to the peer and not attached yet. */
  requested = new Set<number>();
  private askedAt = new Map<number, number>();
  private round = 1;
  private pruner?: ReturnType<typeof setInterval>;
  private options: Required<Pick<SseOptions, "lanes">> & Pick<SseOptions, "ongone">;
  constructor(options: SseOptions = {}) {
    this.options = { lanes: Math.max(1, Math.min(8, options.lanes ?? 1)), ongone: options.ongone };
  }
  /** Registers a lane sink; lane 0 opens the channel and its disappearance ends it. */
  attach(index: number, sink: Sink) {
    if (this.lanes.has(index)) throw Error("Realtime lane already attached");
    if (index > 0 && !this.requested.has(index)) {
      // Never let a peer attach lanes it did not ask for (index 0 is the entry ticket).
      throw Error("Realtime lane was not requested");
    }
    this.requested.delete(index);
    const lane: Lane = { index, sink, keepalive: setInterval(() => this.beat(lane), KEEPALIVE_MS) };
    lane.keepalive.unref?.();
    this.lanes.set(index, lane);
    sink.onclose(() => this.detach(index));
    if (index === 0) {
      // Last-resort liveness for peers that never close cleanly; the peer also reconnects on silence.
      this.pruner = setInterval(() => this.prune(), PRUNE_MS);
      this.pruner.unref?.();
    }
    return lane;
  }
  /** Reserves the next data lane and asks the peer to open it. */
  grow() {
    if (this.lanes.size === 0) return;
    const data = [...this.lanes.keys()].filter((index) => index > 0);
    if (data.length >= this.options.lanes - 1) return;
    let index = 1;
    while (this.lanes.has(index) || this.requested.has(index)) index++;
    if (index >= this.options.lanes) return;
    // One request at a time: the peer answers with a new request that the next payload fills.
    const now = Date.now();
    for (const [asked, at] of this.askedAt) if (now - at > LANE_PATIENCE_MS) this.askedAt.delete(asked);
    if (this.askedAt.size) return;
    this.requested.add(index);
    this.askedAt.set(index, now);
    this.control({ type: "lane", open: index });
  }
  /** Control messages keep their order on lane 0; they are never spread or dropped. */
  control(value: unknown) {
    const lane = this.lanes.get(0);
    if (lane) lane.sink.write(frame(value));
  }
  /** Bulk payloads: sticky by key so one conversation keeps its order, spread across lanes otherwise. */
  data(value: unknown, key?: string) {
    const control = this.lanes.get(0);
    if (!control) return;
    const text = frame(value),
      data = [...this.lanes.values()].filter((lane) => lane.index > 0);
    if (!data.length) {
      // No extra lane yet: the payload still goes on lane 0 so it cannot stall, and once that lane is carrying
      // a full high-water mark the peer is asked for the first data lane. Without this the channel never expands.
      if (control.sink.buffered() + text.length >= HIGH_WATER) this.grow();
      control.sink.write(text);
      return;
    }
    const usable = data.filter((lane) => lane.sink.buffered() < HIGH_WATER);
    if (!usable.length) this.grow();
    const pool = usable.length ? usable : data;
    let lane: Lane;
    if (key) {
      // FNV-1a: cheap, stable across the channel's lifetime, no allocation per message.
      let hash = 2166136261;
      for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
      lane = pool[(hash >>> 0) % pool.length];
    } else lane = pool[this.round++ % pool.length];
    lane.sink.write(text);
  }
  get buffered() {
    let total = 0;
    for (const lane of this.lanes.values()) total += lane.sink.buffered();
    return total;
  }
  get open() {
    return this.lanes.size > 0;
  }
  private beat(lane: Lane) {
    if (this.lanes.get(lane.index) !== lane) return;
    lane.sink.write(": keepalive\n\n");
  }
  /** Closes data lanes that are no longer earning their connection; the lowest one stays, so traffic keeps a stream. */
  private prune() {
    if (!this.lanes.has(0)) return;
    const data = [...this.lanes.values()].filter((lane) => lane.index > 0);
    if (data.length < 2) return;
    for (const lane of data.slice(1)) {
      if (lane.sink.buffered() > LOW_WATER) continue;
      this.control({ type: "lane", close: lane.index });
      this.detach(lane.index);
      lane.sink.end();
    }
  }
  detach(index: number) {
    const lane = this.lanes.get(index);
    if (!lane) return;
    this.lanes.delete(index);
    clearInterval(lane.keepalive);
    if (index !== 0) return;
    clearInterval(this.pruner);
    this.pruner = undefined;
    this.options.ongone?.();
  }
  /** Ends the channel; every lane gets the same final event so the peer knows why not to reconnect blindly. */
  close(code: number, reason: string) {
    const lanes = [...this.lanes.values()];
    if (!lanes.length) return;
    for (const lane of lanes) {
      if (lane.index === 0) this.control({ type: "closed", code, reason });
      else lane.sink.write(frame({ type: "closed", code, reason }));
      this.detach(lane.index);
      lane.sink.end();
    }
  }
}

/**
 * Live channels owned by one hub: lane 0 opens a channel, extra lanes must come back from the same identity
 * with its id, and the last lane leaving tells the hub to forget it.
 */
export class SseChannels {
  private entries = new Map<string, { channel: SseChannel; owner: string }>();
  create(owner: string, options: SseOptions) {
    let channel!: SseChannel;
    channel = new SseChannel({
      ...options,
      ongone: () => {
        this.entries.delete(channel.id);
        options.ongone?.();
      },
    });
    this.entries.set(channel.id, { channel, owner });
    return channel;
  }
  /** The channel a `?channel=`/`?lane=` request may attach to; a foreign id is a hard error. */
  owned(id: string, owner: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw Error("实时连接已失效，请重新连接");
    return entry.channel;
  }
  get size() {
    return this.entries.size;
  }
}

/** Adapts one H3 response into a lane sink, so the rest of the server never touches HTTP headers. */
export function openStream(event: H3Event) {
  setHeader(event, "Content-Type", "text/event-stream; charset=utf-8");
  setHeader(event, "Cache-Control", "no-store");
  setHeader(event, "Connection", "keep-alive");
  // nginx buffers proxied responses by default; a buffered event stream is not realtime.
  setHeader(event, "X-Accel-Buffering", "no");
  const body = new PassThrough({ highWaterMark: 16 * 1024 });
  const response = event.node.res;
  const sink: Sink = {
    write(chunk) {
      if (body.writableEnded || body.destroyed) return false;
      return body.write(chunk);
    },
    end() {
      if (!body.writableEnded) body.end();
    },
    // Both buffers count: the pass-through queue and whatever the socket has not flushed yet.
    buffered: () => body.writableLength + (response.writableLength || 0),
    onclose(closed) {
      response.once("close", closed);
      body.once("close", closed);
    },
  };
  return { sink, body };
}

/** Request view shared by the channels: they only ever read the URL and a few headers. */
export function wireRequest(event: H3Event): Request {
  return {
    // The real URL, not a placeholder: the channels compare its origin with the Origin header for CSRF.
    url: getRequestURL(event).href,
    headers: new Headers(event.node.req.headers as Record<string, string>),
  };
}

/** The wire handed to a channel owner: `send` routes payloads onto the expandable lanes. */
export function wire(channel: SseChannel, request: Request): Wire {
  return {
    id: channel.id,
    request,
    send(value, options) {
      if (options?.data) channel.data(value, options.key);
      else channel.control(value);
    },
    close: (code, reason) => channel.close(code, reason),
    get buffered() {
      return channel.buffered;
    },
  };
}

/** Base64 for tunnels that used to carry raw binary frames over a WebSocket. */
export const encodeFrame = (data: Uint8Array | Buffer) => Buffer.from(data).toString("base64");
export const decodeFrame = (text: unknown) => {
  if (typeof text !== "string" || !text) throw Error("中继帧无效");
  return new Uint8Array(Buffer.from(text, "base64"));
};

/** Reads the `lane`/`channel` query parameters of one stream request. */
export function laneParams(event: H3Event) {
  const url = new URL(event.node.req.url || "/", "http://realtime.invalid"),
    raw = url.searchParams.get("lane"),
    channel = url.searchParams.get("channel") || "";
  const lane = raw === null ? 0 : Number(raw);
  if (!Number.isSafeInteger(lane) || lane < 0 || lane > 7) throw Error("Invalid realtime lane");
  return { lane, channel, url };
}
