import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync, deflateRawSync } from "node:zlib";
import { decodeRelayFrame, legacyRelayData } from "../server/core/relay";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { shell, Tools } from "../server/core/tools";
import { assertShellCommand, SHELL_POLICY_ERROR } from "../server/core/shell-policy";
import { LocalAgents, localShell } from "../server/core/local-agent";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { CODING_RULES } from "../server/core/prompt";
import commandCases from "../local/testdata/shell-policy.json";
const cleanup: (() => any)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
test("StarLink original gzip SSE and legacy _z raw-deflate envelopes", () => {
  const value = {
      op: "event",
      event: { type: "starlink.notify", data: { text: "hello" } },
    },
    encoded = {
      encoding: "gzip",
      data: gzipSync(JSON.stringify(value)).toString("base64"),
    };
  assert.deepEqual(decodeRelayFrame(JSON.stringify(encoded)), value);
  assert.deepEqual(
    legacyRelayData({
      _z: deflateRawSync(JSON.stringify(value)).toString("base64"),
    }),
    value,
  );
  assert.throws(() => decodeRelayFrame('{"encoding":"gzip"}'));
  assert.deepEqual(legacyRelayData({ _z: "bad" }), { _z: "bad" });
});
test("Chrome extension bridge pairing, client identity binding and no unauthorized commands", async () => {
  const bridge = new ChromeBridge();
  cleanup.push(() => bridge.close());
  await bridge.start();
  const origin = `http://127.0.0.1:${bridge.port}`,
    extension = "chrome-extension://mdicifjlbgnkkdkcbfdnebeghhlamjbm";
  const post = async (path: string, value: any, headers: any = {}) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: extension,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(value),
    });
  const bad = await post("/pair", {}, { Origin: "https://evil.test" });
  assert.equal(bad.status, 403);
  await bad.text();
  const pair = await (await post("/pair", {})).json();
  const clientId = crypto.randomUUID(),
    headers = { Authorization: "Bearer " + pair.token };
  const poll = post("/poll", { clientId }, headers);
  for (let i = 0; i < 100 && !bridge.clients.has(clientId); i++)
    await new Promise((yes) => setTimeout(yes, 5));
  const command = bridge.request("tabs", {});
  const payload = await (await poll).json();
  assert.equal(payload.command.operation, "tabs");
  const wrong = await post(
    "/reply",
    {
      clientId: crypto.randomUUID(),
      id: payload.command.id,
      result: { hijack: true },
    },
    headers,
  );
  await wrong.text();
  assert(bridge.pending.has(payload.command.id), "Wrong client forged a reply");
  await (
    await post(
      "/reply",
      {
        clientId,
        id: payload.command.id,
        result: { tabs: [{ tag: "stable" }] },
      },
      headers,
    )
  ).text();
  assert.equal((await command).tabs[0].tag, "stable");
  assert.equal(bridge.pending.size, 0);
});
test("shell uses real PowerShell/POSIX process and preserves split UTF-8 output", async () => {
  const script =
    "const b=Buffer.from('你好');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},5)";
  const quote = (s: string) =>
    process.platform === "win32"
      ? "'" + s.replaceAll("'", "''") + "'"
      : "'" + s.replaceAll("'", "'\\''") + "'";
  const command =
    (process.platform === "win32" ? "& " : "") +
    quote(process.execPath) +
    " -e " +
    quote(script);
  const result = await shell(
    process.cwd(),
    { command, timeout: 10 },
    new AbortController().signal,
    () => {},
  );
  assert.equal(result.error, false, JSON.stringify(result.value));
  assert.equal(result.value.output, "你好");
});
test("shell policy rejects desktop and alternative browser automation without blocking ordinary commands", () => {
  for (const command of commandCases.blocked)
    assert.throws(() => assertShellCommand(command), { message: SHELL_POLICY_ERROR }, command);
  for (const command of commandCases.allowed)
    assert.doesNotThrow(() => assertShellCommand(command), command);
});
test("forbidden shell input is rejected before server spawn or local job dispatch", async (t) => {
  const signal = new AbortController().signal;
  const command = "throw 'must not execute'; [Native]::SetCursorPos(10, 20)";
  let sent = 0;
  const hub = new LocalAgents((event) => { if (event.type === "local_agent_request") sent++; });
  t.after(() => hub.close());
  hub.connect("alice", { instance: "a".repeat(32), clientId: "b".repeat(32), platform: "windows", cwd: "C:\\client" });
  const agent = hub.active("alice")!;
  await assert.rejects(shell(process.cwd(), { command }, signal, () => {}), { message: SHELL_POLICY_ERROR });
  await assert.rejects(localShell(hub, agent, agent.cwd, { command }, signal), { message: SHELL_POLICY_ERROR });
  assert.equal(sent, 0);
  assert.equal(agent.pending.size, 0);
});
test("computer and coding scenes retain shell without allowing desktop automation", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const session = store.newSession({ scene: "computer" });
  const tools = new Tools({ store, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  const definitions = tools.definitions();
  assert(definitions.some((tool) => tool.name === "chrome"));
  assert(definitions.some((tool) => tool.name === "bash"));
  await assert.rejects(tools.execute({ id: "blocked", name: "bash", arguments: { command: "[Native]::SetCursorPos(10, 20)" } }, {} as any), { message: SHELL_POLICY_ERROR });
  assert.match(definitions.find((tool) => tool.name === "chrome")!.description, /禁止.*绕行/);
  assert.match(CODING_RULES, /Chrome 只能通过 chrome 工具的授权扩展操作/);
  session.scene = "coding";
  assert(tools.definitions().some((tool) => tool.name === "bash"));
});
