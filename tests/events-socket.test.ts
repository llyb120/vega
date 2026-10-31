import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventsSocket, WS_BODY_LIMIT } from "../server/core/events-socket";
import { sleep } from "../server/core/util";

function fixture() {
  const principal = {
      hash: "login-hash",
      user: { id: "admin", role: "admin" },
      csrf: "csrf",
    },
    auth = {
      events: new EventEmitter(),
      authenticate: (token: string) => (token === "cookie" ? principal : null),
      resolveHash: (hash: string) => (hash === principal.hash ? principal : null),
    },
    engine = { events: new EventEmitter() },
    hub = new EventsSocket(
      engine as any,
      auth as any,
      (_user, event) => event.public === true,
    );
  const open = (origin = "http://local") => {
    const { ticket } = hub.ticket(principal as any),
      sent: any[] = [],
      peer = {
        id: Math.random().toString(36).slice(2),
        request: new Request("http://local/api/events?ticket=" + ticket, {
          headers: { origin, cookie: "vega_session=cookie", host: "local" },
        }),
        send: (text: string) => sent.push(JSON.parse(text)),
        close: () => sent.push({ type: "closed" }),
      };
    hub.open(peer as any);
    return { peer, sent };
  };
  const dispatch = async (
    peer: any,
    value: any,
    handler: (method: string, path: string, body: string | undefined, signal: AbortSignal) => Promise<Response>,
  ) => {
    hub.message(peer, JSON.stringify(value), handler);
    for (let i = 0; i < 100 && hub.sessions.get(peer.id)?.pending.size; i++)
      await sleep(1);
  };
  return { hub, auth, engine, open, dispatch };
}

test("events WebSocket authenticates one-use tickets and filters events", () => {
  const { hub, auth, engine, open } = fixture();
  assert.throws(() => open("https://evil.test"));
  const first = open();
  assert.equal(first.sent[0].type, "ready");
  assert.throws(() => hub.open(first.peer as any), "ticket is single use");
  engine.events.emit("event", { type: "private", data: 1 });
  engine.events.emit("event", { type: "public", public: true });
  assert(!first.sent.some((v) => v.type === "private"));
  assert(first.sent.some((v) => v.type === "public"));
  auth.events.emit("logout", "login-hash");
  assert.equal(hub.sessions.size, 0);
  assert(first.sent.some((v) => v.type === "closed"));
});

test("events WebSocket dispatches small API calls once and falls back for large reads", async () => {
  const { hub, open, dispatch } = fixture(),
    { peer, sent } = open();
  let calls = 0;
  await dispatch(
    peer,
    { type: "request", id: "00000001", method: "POST", path: "/sessions", data: { title: "one" } },
    async (method, path, body) => {
      calls++;
      assert.equal(method, "POST");
      assert.equal(path, "/sessions");
      assert.equal(JSON.parse(body!).title, "one");
      return Response.json({ id: "session-1" }, { status: 201 });
    },
  );
  assert.equal(calls, 1);
  const response = sent.find((v) => v.id === "00000001");
  assert.equal(response.status, 201);
  assert.equal(JSON.parse(response.body).id, "session-1");
  await dispatch(
    peer,
    { type: "request", id: "00000001", method: "POST", path: "/sessions" },
    async () => {
      calls++;
      return Response.json({});
    },
  );
  assert.equal(calls, 1, "duplicate request IDs are not dispatched");
  assert(sent.some((v) => v.type === "error" && v.reason.includes("重复")));
  await dispatch(
    peer,
    { type: "request", id: "request-2", path: "/sessions/large" },
    async () => new Response("x".repeat(300000)),
  );
  assert.equal(sent.find((v) => v.id === "request-2").httpFallback, true);
  await dispatch(
    peer,
    { type: "request", id: "request-3", method: "POST", path: "/sessions", data: "x".repeat(WS_BODY_LIMIT + 1) },
    async () => {
      calls++;
      return Response.json({});
    },
  );
  assert.equal(calls, 1, "large mutation stays on HTTP");
});

test("closing realtime socket aborts pending work and never replays it", async () => {
  const { hub, open, dispatch } = fixture(),
    { peer, sent } = open();
  let calls = 0,
    aborted = false;
  const pending = dispatch(
    peer,
    { type: "request", id: "request-4", method: "POST", path: "/sessions/1/messages" },
    async (_method, _path, _body, signal) => {
      calls++;
      signal.addEventListener("abort", () => (aborted = true));
      await new Promise(() => {});
      return Response.json({});
    },
  );
  for (let i = 0; i < 100 && !hub.sessions.get(peer.id)?.pending.size; i++)
    await sleep(1);
  hub.close(peer.id);
  await pending;
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert(!sent.some((v) => v.id === "request-4" && v.status === 200));
});
