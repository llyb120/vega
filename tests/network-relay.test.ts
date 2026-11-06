import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { NetworkRelay, relayRules } from "../server/core/network-relay";
import { Store } from "../server/core/store";
import { LocalAgents } from "../server/core/local-agent";

const grant = { userId: "alice", clientId: "c".repeat(32), hash: "device-hash" };
async function fixture(t: TestContext) {
  const store = await Store.open(":memory:"), hub = new LocalAgents(), relay = new NetworkRelay(store, hub);
  let command: (job: any) => void = () => {};
  const transport = { send: (job: any) => command(job), close() {} };
  const details = { clientId: grant.clientId, instance: "a".repeat(32), platform: "windows", cwd: "C:\\work" };
  hub.connect(grant.userId, details, transport);
  t.after(async () => { hub.close(); await relay.close(); await store.close(); });
  return { store, hub, relay, transport, details, onCommand: (handler: (job: any) => void) => { command = handler; } };
}
function read(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((yes, no) => {
    const cleanup = () => { clearTimeout(timer); socket.off("readable", poll); socket.off("close", close); };
    const close = () => { cleanup(); no(Error("Connection closed")); };
    const poll = () => { const data = socket.read(size); if (data) { cleanup(); yes(data); } };
    const timer = setTimeout(() => { cleanup(); no(Error("Read timed out")); }, 3000);
    socket.on("readable", poll).once("close", close); poll();
  });
}
async function socks(proxy: string, host: string, port: number, t: TestContext) {
  const socket = connect(Number(new URL(proxy).port), "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  // Deliberately fragmented negotiation.
  socket.write(Buffer.from([5])); socket.write(Buffer.from([1, 0]));
  assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]));
  const address = Buffer.from(host), request = Buffer.alloc(7 + address.length);
  request.set([5, 1, 0, 3, address.length]); address.copy(request, 5); request.writeUInt16BE(port, request.length - 2);
  socket.write(request);
  return socket;
}

test("relay rule validation is bounded and exact", () => {
  assert.deepEqual(relayRules(["Git.Internal:443", "git.internal:0443"]), ["git.internal:443"]);
  for (const value of [null, {}, [1], ["localhost:80"], ["127.0.0.1:80"], ["x.localhost:443"], ["*.internal:443"], ["bad..test:80"], ["good.test:0"], ["good.test:+80"], ["good.test:65536"], ["https://good.test"], Array(65).fill("a.test:80")]) assert.throws(() => relayRules(value));
});

test("account policies persist offline, block conflicts and never fall back to direct or another device", async (t) => {
  const f = await fixture(t);
  await f.relay.configure(grant, ["git.internal:443"]);
  assert.equal((await f.relay.route("alice", "git.internal", 443))?.agent.clientId, grant.clientId);
  assert.equal(await f.relay.route("bob", "git.internal", 443), undefined);
  assert.equal(await f.relay.route("alice", "notgit.internal", 443), undefined);
  await assert.rejects(f.relay.route("alice", "git.internal", 80), /端口/);
  f.hub.suspend("alice", f.details.instance);
  await assert.rejects(f.relay.route("alice", "git.internal", 443), /离线/);
  const restarted = new NetworkRelay(f.store, new LocalAgents());
  await assert.rejects(restarted.route("alice", "git.internal", 443), /离线/);
  await restarted.close();
  await f.relay.configure({ ...grant, clientId: "d".repeat(32) }, ["git.internal:443"]);
  await assert.rejects(f.relay.route("alice", "git.internal", 443), /多个客户端/);
  await f.relay.configure({ ...grant, clientId: "d".repeat(32) }, []);
  await f.relay.configure(grant, []);
  assert.equal(await f.relay.route("alice", "git.internal", 443), undefined);
});

test("unmatched TCP traffic goes directly through the account proxy", async (t) => {
  const f = await fixture(t), server = createServer((s) => s.pipe(s));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const proxy = await f.relay.proxy("alice");
  assert.equal(await f.relay.proxy("alice"), proxy);
  assert.notEqual(await f.relay.proxy("bob"), proxy);
  const socket = await socks(proxy, "localhost", (server.address() as any).port, t);
  assert.equal((await read(socket, 10))[1], 0);
  socket.write("direct payload");
  assert.equal((await read(socket, 14)).toString(), "direct payload");
});

test("SOCKS routes binary streams through one authenticated device tunnel with bounded backpressure", async (t) => {
  const f = await fixture(t);
  await f.relay.configure(grant, ["git.internal:443"]);
  const outbound: Buffer[] = [];
  let peer: any, command: any;
  f.onCommand((job) => {
    command = job;
    peer = { id: "tunnel", close() {}, send: (data: Uint8Array) => { outbound.push(Buffer.from(data)); } };
    assert.throws(() => f.relay.open(peer, { ...grant, userId: "bob" }, job.id));
    assert.throws(() => f.relay.open(peer, { ...grant, hash: "wrong" }, job.id));
    f.relay.open(peer, grant, job.id);
    assert.throws(() => f.relay.open({ ...peer, id: "replay" }, grant, job.id));
    f.relay.message(peer, Buffer.from([2]));
  });
  const socket = await socks(await f.relay.proxy("alice"), "git.internal", 443, t);
  assert.equal((await read(socket, 10))[1], 0);
  assert.deepEqual(command.args, { host: "git.internal", port: 443 });
  assert(f.relay.inUse(grant.clientId));
  const payload = Buffer.alloc(70000, 171);
  socket.write(payload);
  const until = async (check: () => boolean) => { for (let i=0; i<200 && !check(); i++) await new Promise(r => setTimeout(r,5)); assert(check()); };
  await until(() => outbound.length === 1);
  assert(outbound[0].length <= (32 << 10) + 1);
  await new Promise(r => setTimeout(r,20));
  assert.equal(outbound.length, 1, "no second data frame before acknowledgement");
  const sent: Buffer[] = [];
  while (Buffer.concat(sent).length < payload.length) {
    await until(() => outbound.length > 0);
    const frame = outbound.shift()!; assert.equal(frame[0], 0); sent.push(frame.subarray(1));
    f.relay.message(peer, Buffer.from([1]));
  }
  assert.deepEqual(Buffer.concat(sent), payload);
  f.relay.message(peer, Buffer.from([0, 255, 0, 8]));
  assert.deepEqual(await read(socket, 3), Buffer.from([255, 0, 8]));
  await until(() => outbound.some(frame => frame.length === 1 && frame[0] === 1));
  const closed = once(socket, "close");
  f.relay.disconnect("alice", grant.clientId, f.transport);
  await closed;
  assert(!f.relay.inUse(grant.clientId));
  assert.throws(() => f.relay.open(peer, grant, command.id));
});

test("relay rejection logs the destination and reason without device credentials", async (t) => {
  const warn = t.mock.method(console, "warn", () => {}), f = await fixture(t);
  await f.relay.configure(grant, ["git.internal:443"]);
  const socket = await socks(await f.relay.proxy("alice"), "git.internal", 80, t);
  assert.equal((await read(socket, 10))[1], 1);
  const calls = warn.mock.calls.map(call => call.arguments);
  assert(calls.some(([label, details]) => label === "[Vega relay] SOCKS rejected" && details.userId === "alice" && /git\.internal:80:.*端口/.test(details.reason)));
  assert(!JSON.stringify(calls).includes(grant.hash));
});

test("a tunnel closing before readiness logs its stage once without replay", async (t) => {
  const warn = t.mock.method(console, "warn", () => {}), f = await fixture(t);
  await f.relay.configure(grant, ["git.internal:443"]);
  let opened!: (id: string) => void;
  const opening = new Promise<string>(resolve => { opened = resolve; });
  let commands = 0;
  f.onCommand((job) => {
    commands++;
    f.relay.open({ id: job.id, send() {}, close() {} }, grant, job.id);
    opened(job.id);
  });
  const socket = await socks(await f.relay.proxy("alice"), "git.internal", 443, t);
  const peerId = await opening, closed = once(socket, "close");
  f.relay.closePeer(peerId);
  f.relay.closePeer(peerId);
  await closed;
  assert.equal(commands, 1);
  const calls = warn.mock.calls.map(call => call.arguments);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].stage, "target_connect");
  assert.equal(calls[0][1].host, "git.internal");
  assert(!JSON.stringify(calls).includes(grant.hash));
});

test("saving a changed policy flushes pooled sockets; invalid rules preserve the policy", async (t) => {
  const f = await fixture(t);
  await f.relay.configure(grant, ["git.internal:443"]);
  f.onCommand((job) => { const peer = { id: job.id, send() {}, close() {} }; f.relay.open(peer, grant, job.id); f.relay.message(peer, Buffer.from([2])); });
  const socket = await socks(await f.relay.proxy("alice"), "git.internal", 443, t);
  await read(socket, 10);
  await assert.rejects(f.relay.configure(grant, ["*:443"]));
  assert(f.relay.inUse(grant.clientId));
  const closed = once(socket, "close");
  await f.relay.configure(grant, []);
  await closed;
  assert(!f.relay.inUse(grant.clientId));
});
