import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventsSocket, publicEvent } from "../server/core/events-socket";
import { sleep } from "../server/core/util";

function fixture(options: ConstructorParameters<typeof EventsSocket>[3] = {}) {
  const principals: Record<string, any> = {
      cookie: { hash: "login-hash", user: { id: "admin", role: "admin" }, csrf: "csrf" },
      other: { hash: "other-hash", user: { id: "bob", role: "member" }, csrf: "csrf2" },
    },
    auth = {
      events: new EventEmitter(),
      authenticate: (token: string) => principals[token] || null,
      resolveHash: (hash: string) => Object.values(principals).find((p) => p.hash === hash) || null,
    },
    engine = { events: new EventEmitter() },
    hub = new EventsSocket(engine as any, auth as any, (user, event) => event.public === true || user.id === "admin", { heartbeatMs: 3600000, coalesceMs: 5, ...options });
  const open = async ({ origin = "http://local", cookie = "cookie", query = "" } = {}) => {
    const principal = principals[cookie];
    const { ticket } = await hub.ticket(principal),
      sent: any[] = [],
      wire = { pings: 0, pong: [] as (() => void)[], bufferedAmount: 0, terminated: false, ping() { this.pings++; }, on(_: string, f: () => void) { this.pong.push(f); }, terminate() { this.terminated = true; } },
      peer = {
        id: Math.random().toString(36).slice(2),
        request: new Request("http://local/api/events?ticket=" + ticket + query, { headers: { origin, cookie: "vega_session=" + cookie, host: "local" } }),
        send: (text: string) => sent.push(JSON.parse(text)),
        close: (code?: number) => sent.push({ type: "closed", code }),
        _internal: { ws: wire },
      };
    await hub.open(peer as any);
    return { peer, sent, wire };
  };
  return { hub, auth, engine, open };
}
const emit = (f: ReturnType<typeof fixture>, value: any) => f.engine.events.emit("event", value);
/** Delivery is ordered per page but asynchronous (permission checks may read the database). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("events WebSocket authenticates one-use tickets, filters events and only accepts subscriptions", async () => {
  const f = fixture();
  await assert.rejects(f.open({ origin: "https://evil.test" }));
  const first = await f.open({ cookie: "other" });
  await settle();
  assert.equal(first.sent[0].type, "ready");
  await assert.rejects(async () => await f.hub.open(first.peer as any), "ticket is single use");
  emit(f, { type: "private", data: 1 });
  emit(f, { type: "public", public: true });
  await settle();
  assert(!first.sent.some((v) => v.type === "private"));
  assert(first.sent.some((v) => v.type === "public" && v.seq > 0));
  f.hub.message(first.peer as any, JSON.stringify({ type: "request", id: "00000001", method: "POST", path: "/sessions" }));
  assert.match(first.sent.at(-1).reason, /只接收订阅/);
  f.auth.events.emit("logout", "other-hash");
  assert.equal(f.hub.sessions.size, 0);
  assert(first.sent.some((v) => v.type === "closed" && v.code === 4401));
});

test("token streams go only to subscribers while lifecycle events reach every permitted page", async () => {
  const f = fixture(),
    watching = await f.open({ query: "&sessions=s1" }),
    elsewhere = await f.open();
  for (const piece of ["a", "b", "c"]) emit(f, { type: "text_delta", session: "s1", data: piece });
  emit(f, { type: "tool_start", session: "s1", data: { id: "c1", name: "bash" } });
  emit(f, { type: "tool_end", session: "s1", data: { call: { id: "c1", name: "bash", arguments: { command: "x" } }, outcome: { value: "x".repeat(100000), error: false } } });
  emit(f, { type: "message_end", session: "s1", data: { role: "assistant", text: "long".repeat(1000) } });
  emit(f, { type: "tool_progress", session: "s1", data: "noise" });
  await sleep(20);
  const deltas = watching.sent.filter((v) => v.type === "text_delta");
  assert.equal(deltas.length, 1, "deltas within the window are merged");
  assert.equal(deltas[0].data, "abc");
  assert.ok(watching.sent.findIndex((v) => v.type === "text_delta") < watching.sent.findIndex((v) => v.type === "tool_start"), "merged deltas keep their order");
  assert(!elsewhere.sent.some((v) => ["text_delta", "tool_start"].includes(v.type)), "unsubscribed pages get no token stream");
  for (const page of [watching, elsewhere]) {
    const end = page.sent.find((v) => v.type === "tool_end");
    assert.deepEqual(end.data, { call: { id: "c1", name: "bash" }, outcome: { error: false } }, "tool_end carries no tool output");
    assert.equal(page.sent.find((v) => v.type === "message_end").data, undefined);
    assert(!page.sent.some((v) => v.type === "tool_progress"));
  }
  // Re-subscribing moves the stream without reconnecting.
  f.hub.message(elsewhere.peer as any, JSON.stringify({ type: "subscribe", sessions: ["s1"] }));
  f.hub.message(watching.peer as any, JSON.stringify({ type: "subscribe", sessions: [] }));
  emit(f, { type: "text_delta", session: "s1", data: "d" });
  await sleep(20);
  assert.equal(elsewhere.sent.filter((v) => v.type === "text_delta").at(-1).data, "d");
  assert.equal(watching.sent.filter((v) => v.type === "text_delta").length, 1);
  assert.equal(publicEvent({ type: "done", session: "s1", data: { error: false } })!.type, "done");
});

test("a reconnect inside the window replays missed events in order; outside it the page is told to reset", async () => {
  const f = fixture({ replayEvents: 5 }),
    first = await f.open({ query: "&sessions=s1" });
  emit(f, { type: "started", session: "s1" });
  await settle();
  const ready = first.sent[0];
  const cursor = ready.epoch + ":" + first.sent.at(-1).seq;
  f.hub.close(first.peer.id);
  emit(f, { type: "text_delta", session: "s1", data: "missed " });
  emit(f, { type: "message_end", session: "s1" });
  emit(f, { type: "done", session: "s1" });
  const back = await f.open({ query: "&sessions=s1&since=" + cursor });
  await settle();
  assert.deepEqual(back.sent.map((v) => v.type), ["text_delta", "message_end", "done", "ready"]);
  assert.equal(back.sent[0].data, "missed ");
  assert.equal(back.sent.at(-1).replayed, true);
  const seqs = back.sent.slice(0, 3).map((v) => v.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  // Older than the buffer, or another server process: reset.
  for (let i = 0; i < 10; i++) emit(f, { type: "employee_changed", data: {} });
  const old = await f.open({ query: "&since=" + cursor }), foreign = await f.open({ query: "&since=deadbeef:" + ready.seq });
  await settle();
  assert.equal(old.sent.at(-1).replayed, false);
  assert.equal(foreign.sent.at(-1).replayed, false);
});

test("heartbeats reap dead peers, re-check logins, and the per-account cap leaves other accounts alone", async () => {
  const f = fixture({ perUser: 2 }),
    alive = await f.open(),
    dead = await f.open();
  await f.hub.beat();
  assert.equal(alive.wire.pings, 1);
  assert.equal(alive.sent.at(-1).type, "heartbeat");
  alive.wire.pong.forEach((pong) => pong());
  const third = await f.open();
  await settle();
  assert.equal(third.sent.at(-1).code, 4429, "a third page of the same account is refused while two are alive");
  const other = await f.open({ cookie: "other" });
  await settle();
  assert.equal(other.sent[0].type, "ready", "another account is unaffected");
  await f.hub.beat();
  assert.equal(dead.wire.terminated, true, "no pong since the last ping: terminated");
  assert.equal(alive.wire.terminated, false);
  const again = await f.open();
  await settle();
  assert.equal(again.sent[0].type, "ready", "the reaped slot is free again");
});

test("a slow page sheds token streams first and is reset when its buffer keeps growing", async () => {
  const f = fixture(),
    page = await f.open({ query: "&sessions=s1" });
  page.wire.bufferedAmount = 2 << 20;
  emit(f, { type: "text_delta", session: "s1", data: "x" });
  emit(f, { type: "done", session: "s1" });
  await sleep(20);
  assert(!page.sent.some((v) => v.type === "text_delta"));
  assert(page.sent.some((v) => v.type === "done"));
  page.wire.bufferedAmount = 64 << 20;
  emit(f, { type: "done", session: "s1" });
  await settle();
  assert.equal(page.sent.at(-1).code, 4408);
  assert.equal(f.hub.sessions.size, 0);
});
