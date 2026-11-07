import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LocalAgents } from "../server/core/local-agent";
import { Tools } from "../server/core/tools";
import { Store } from "../server/core/store";

const client = { instance: "a".repeat(32), clientId: "b".repeat(32), name: "笔记本", platform: "windows", cwd: "C:\\client" };
const png = Buffer.from("fake-png");

async function setup(t: any) {
  const store = await Store.open(":memory:"), hub = new LocalAgents();
  hub.connect("alice", client, { send() {}, close() {} });
  t.after(async () => { hub.close(); await store.close(); });
  const session = await store.newSession({ ownerId: "alice", cwd: client.cwd, localAgent: true, localPlatform: "windows", clientId: client.clientId });
  const tools = await Tools.create({ store, localAgents: hub, mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  return { store, hub, session, tools };
}

test("appuse is listed with its rules only in a Windows client session", async (t) => {
  const { store, tools } = await setup(t);
  assert((await tools.definitions()).some((tool) => tool.name === "appuse"));
  assert.match(await tools.rules(), /\[桌面操作\]/);
  const server = await Tools.create({ store, localAgents: new LocalAgents(), mcpFor: () => ({}) } as any, await store.newSession({ ownerId: "alice" }), { model: "", provider: {} }, new AbortController().signal, () => {});
  assert(!(await server.definitions()).some((tool) => tool.name === "appuse"));
  assert.doesNotMatch(await server.rules(), /\[桌面操作\]/);
  const linux = await Tools.create({ store, localAgents: new LocalAgents(), mcpFor: () => ({}) } as any, await store.newSession({ ownerId: "alice", localAgent: true, localPlatform: "linux", clientId: client.clientId, cwd: "/home/alice" }), { model: "", provider: {} }, new AbortController().signal, () => {});
  assert(!(await linux.definitions()).some((tool) => tool.name === "appuse"));
});

test("appuse dispatch binds the owner and stores returned screenshots as session files", async (t) => {
  const { hub, session, tools } = await setup(t);
  let seen: { op?: string; args?: any } = {};
  (hub as any).request = async (_agent: unknown, op: string, args: any) => {
    seen = { op, args };
    return { snapshotId: "snap1", images: [{ imageId: "monitor-0", mime: "image/png", path: "C:\\shots\\monitor-0.png", data: png.toString("base64") }] };
  };
  const result = await tools.execute({ id: "shot", name: "appuse", arguments: { operation: "screenshot", monitorId: 0 } }, {} as any);
  assert.equal(seen.op, "appuse");
  assert.equal(seen.args.owner, session.id);
  assert.equal(seen.args.monitorId, 0);
  const image = result.images![0];
  assert.equal(image.mime, "image/png");
  assert.match(image.url!, /^\/api\/files\//);
  assert((await readFile(image.path!)).equals(png));
  // The base64 payload is dropped from the tool result; only the saved path and URL stay.
  assert.equal(result.value.images[0].data, undefined);
  assert.equal(result.value.images[0].path, image.path);
});
