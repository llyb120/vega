import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync, deflateRawSync } from "node:zlib";
import sharp from "sharp";
import { decodeRelayFrame, legacyRelayData } from "../server/core/relay";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { imageTool, shell } from "../server/core/tools";
import { id } from "../server/core/util";
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
test("image generation/edit validate PNG, defaults and authenticated multipart without auto retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-image-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#00ff00" },
  })
    .png()
    .toBuffer();
  await writeFile(join(dir, "original.png"), image);
  let calls = 0,
    form = "";
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer image-key");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    form = Buffer.concat(chunks).toString();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  cleanup.push(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  const config = {
      baseURL: `http://127.0.0.1:${(server.address() as any).port}`,
      apiKey: "image-key",
      models: ["img"],
    },
    signal = new AbortController().signal;
  const generated = await imageTool(
    dir,
    "generate_image",
    { prompt: "tiny image" },
    config,
    signal,
  );
  assert.deepEqual(await readFile(generated.value.path), image);
  assert.equal(generated.value.model, "img");
  assert.match(generated.value.markdown, /!\[图片\]/);
  const edited = await imageTool(
    dir,
    "edit_image",
    { prompt: "change color", referenceImages: ["original.png"] },
    config,
    signal,
  );
  assert.match(form, /name="image"/);
  assert.notEqual(edited.value.path, generated.value.path);
  for (const a of [
    { prompt: "x", model: "missing" },
    { prompt: "x", outputDir: "missing" },
    { prompt: "x", size: "bogus" },
    { prompt: "x", unknown: true },
  ])
    await assert.rejects(() =>
      imageTool(dir, "generate_image", a, config, signal),
    );
  await assert.rejects(() =>
    imageTool(dir, "edit_image", { prompt: "x" }, config, signal),
  );
  assert.equal(calls, 2);
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
