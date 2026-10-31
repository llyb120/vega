import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync, deflateRawSync } from "node:zlib";
import { decodeRelayFrame, legacyRelayData } from "../server/core/relay";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { shell } from "../server/core/tools";
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
