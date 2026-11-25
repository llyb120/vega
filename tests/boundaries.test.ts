import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { shell, Tools } from "../server/core/tools";
import { assertShellCommand, explicitShellDirectory, SHELL_POLICY_ERROR } from "../server/core/shell-policy";
import { LocalAgents, localShell } from "../server/core/local-agent";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { CODING_RULES } from "../server/core/prompt";
import commandCases from "../local/testdata/shell-policy.json";

test("model commands explicitly address a checkout on the execution platform", () => {
  assert.equal(explicitShellDirectory("set -eu\ncd '/repo a' && git status", false), "/repo a");
  assert.equal(explicitShellDirectory("set -euo pipefail\ncd /repo && npm test", false), "/repo");
  assert.equal(explicitShellDirectory('git -C "D:/repo a" status', true), 'D:/repo a');
  assert.equal(explicitShellDirectory("Set-Location -LiteralPath 'C:\\repo a'; npm test", true), 'C:\\repo a');
  for (const command of [
    'node --version',
    'pwd',
    'which node; node --version',
    'node --version; echo "---"; ls -la /workspace/home',
    'cat /repo/file',
    'ls -la /repo | head -n 10',
    'mkdir -p /repo/a && ls /repo/a',
  ])
    assert.equal(explicitShellDirectory(command, false), null, command);
  for (const command of ['cd ../repo; git status', 'cd subdir && ls', 'git -C ../repo status', 'cd C:\\repo && ls'])
    assert.throws(() => explicitShellDirectory(command, false), /绝对路径/, command);
  for (const command of ['cd D:repo; git status', 'Set-Location .\\repo; git status', 'cd /repo && ls'])
    assert.throws(() => explicitShellDirectory(command, true), /绝对路径/, command);
});
const cleanup: (() => any)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
test("Chrome extension bridge pairing, client identity binding and no unauthorized commands", async () => {
  const bridge = new ChromeBridge();
  cleanup.push(() => bridge.close());
  await bridge.start();
  const origin = `http://127.0.0.1:${bridge.port}`,
    extension = "chrome-extension://bhiemmbmefifaloapbcopihahhckolce";
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
test("shell policy permits browser cold starts but rejects shell navigation and desktop automation", () => {
  for (const command of commandCases.blocked)
    assert.throws(() => assertShellCommand(command), { message: SHELL_POLICY_ERROR }, command);
  for (const command of commandCases.allowed)
    assert.doesNotThrow(() => assertShellCommand(command), command);
});
test("forbidden shell input is rejected before server spawn or local job dispatch", async (t) => {
  const signal = new AbortController().signal;
  const command = "throw 'must not execute'; [Native]::SetCursorPos(10, 20)";
  let sent = 0;
  const hub = new LocalAgents();
  t.after(() => hub.close());
  hub.connect("alice", { instance: "a".repeat(32), clientId: "b".repeat(32), platform: "windows", cwd: "C:\\client" }, { send: () => { sent++; }, close() {} });
  const agent = hub.active("alice")!;
  await assert.rejects(shell(process.cwd(), { command }, signal, () => {}), { message: SHELL_POLICY_ERROR });
  await assert.rejects(localShell(hub, agent, agent.cwd, { command }, signal), { message: SHELL_POLICY_ERROR });
  assert.equal(sent, 0);
  assert.equal(agent.pending.size, 0);
});
test("computer and coding scenes retain shell without allowing desktop automation", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  const session = await store.newSession({ scene: "computer" });
  const tools = await Tools.create({ store, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  const definitions = await tools.definitions();
  assert(definitions.some((tool) => tool.name === "browser_act"));
  assert(definitions.some((tool) => tool.name === "bash"));
  await assert.rejects(tools.execute({ id: "blocked", name: "bash", arguments: { command: "[Native]::SetCursorPos(10, 20)" } }, {} as any), { message: SHELL_POLICY_ERROR });
  assert.match(await tools.rules(), /禁止.*绕行/);
  assert.match(CODING_RULES, /Chrome 只能通过 browser_\* 工具的授权扩展操作/);
  assert.match(CODING_RULES, /例外仅限进程冷启动/);
  assert.match(CODING_RULES, /确认任务绑定的客户端 Chrome 未启动时/);
  assert.match(CODING_RULES, /网页输入和回车不是系统键盘注入/);
  assert.match(CODING_RULES, /不能用拼接\/打开结果 URL 或读取浏览历史替代并标记完成/);
  assert.match(await tools.rules(), /网页填框和回车用 browser_act/);
  session.scene = "coding";
  assert((await tools.definitions()).some((tool) => tool.name === "bash"));
});
test("bash executes pathless commands and runs leading cd fallbacks inside the shell", async (t) => {
  const store = await Store.open(":memory:");
  t.after(async () => await store.close());
  const session = await store.newSession({ cwd: process.cwd(), scene: "coding" });
  const tools = await Tools.create({ store, vault: new Vault(store), mcpFor: () => ({}) } as any, session, { model: "", provider: {} }, new AbortController().signal, () => {});
  const version = await tools.execute({ id: "node-ver", name: "bash", arguments: { command: "node --version" } }, {} as any);
  assert.equal(version.error, false, JSON.stringify(version.value));
  assert.match(version.value.output, /^v\d+\./);
  const missing = join(tmpdir(), `vega-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const command = process.platform === "win32"
    ? `cd '${missing.replaceAll("'", "''")}' 2>$null; if (-not $?) { Write-Output fallback }`
    : `cd '${missing.replaceAll("'", "'\\''")}' 2>/dev/null || echo fallback`;
  const fallback = await tools.execute({ id: "cd-fallback", name: "bash", arguments: { command } }, {} as any);
  assert.equal(fallback.error, false, JSON.stringify(fallback.value));
  assert.match(fallback.value.output, /fallback/);
});
