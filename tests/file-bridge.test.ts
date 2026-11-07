import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { LocalAgentUnavailable } from "../server/core/local-agent";
import { exportClientFile, importClientFile, needsClientFileBridge, readRegularInside, workspaceRelative, type ClientFileOps } from "../server/core/file-bridge";
import { canCloseComputer } from "../server/core/handoff";

const offline = new LocalAgentUnavailable("客户端离线");

test("workspace paths reject traversal, absolute paths and home shortcuts before any IO", () => {
  assert.equal(workspaceRelative("notes/a.txt"), "notes/a.txt");
  for (const input of ["../secret", "/etc/passwd", "~/.ssh/id_rsa", "C:\\Users\\a", "notes/../../secret", "a\0b", ""])
    assert.throws(() => workspaceRelative(input), /工作区|相对路径|越出/);
});

test("import reads the client and never a same-named server file", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vega-bridge-")));
  const decoy = join(root, "note.txt");
  await writeFile(decoy, "SERVER-DECOY");
  let uploads = 0;
  const client: ClientFileOps = {
    upload: async () => { uploads++; return { path: "/client/work/note.txt" }; },
    read: async () => ({ content: Buffer.from("from-client").toString("base64") }),
    write: async () => { throw Error("import must not write"); },
  };
  const file = await importClientFile(client, "/client/work", "note.txt");
  assert.equal(file.data.toString(), "from-client");
  assert.equal(await readFile(decoy, "utf8"), "SERVER-DECOY");
  assert.equal(uploads, 1);
  await assert.rejects(importClientFile({ ...client, upload: async () => { throw offline; } }, "/client/work", "note.txt"), LocalAgentUnavailable);
  await assert.rejects(importClientFile({ ...client, upload: async () => ({ error: "Only regular files within the working directory may be uploaded" }) }, "/client/work", "escape.txt"), /不会改读/);
  await assert.rejects(importClientFile(client, "/client/work", "../note.txt"), /越出/);
  await rm(root, { recursive: true, force: true });
});

test("export requires authorization, refuses conflicts and existing symlinks, and fails closed offline", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vega-export-")));
  const downloads = join(root, "downloads");
  await mkdir(downloads);
  await writeFile(join(downloads, "report.txt"), "from-browser");
  await symlink(join(root, "secret.txt"), join(downloads, "linked.txt"));
  await writeFile(join(root, "secret.txt"), "SECRET");
  const outside = join(root, "note.txt");
  await writeFile(outside, "DECOY");
  assert.equal((await readRegularInside([downloads], join(downloads, "report.txt"))).toString(), "from-browser");
  await assert.rejects(readRegularInside([downloads], outside), /受控目录/);
  await assert.rejects(readRegularInside([downloads], join(downloads, "linked.txt")), /符号链接/);

  const writes: string[] = [];
  const client: ClientFileOps = {
    upload: async (_cwd, path) => ({ path: "/client/work/" + path }),
    read: async (_cwd, path) => path === "taken.txt" ? { content: Buffer.from("keep-me").toString("base64") } : { error: "ENOENT: no such file" },
    write: async (_cwd, path) => { writes.push(path); return { path: "/client/work/" + path }; },
  };
  await assert.rejects(exportClientFile(client, "/client/work", "out.txt", Buffer.from("x"), false), /显式授权/);
  assert.deepEqual(writes, []);
  await assert.rejects(exportClientFile(client, "/client/work", "taken.txt", Buffer.from("new"), true), /不会覆盖/);
  assert.deepEqual(writes, []);
  await assert.rejects(exportClientFile(client, "/client/work", "../out.txt", Buffer.from("x"), true), /越出/);
  const saved = await exportClientFile(client, "/client/work", "out.txt", Buffer.from("cloud-download"), true);
  assert.equal(saved.bytes, "cloud-download".length);
  assert.deepEqual(writes, ["out.txt"]);
  await assert.rejects(exportClientFile({ ...client, read: async () => { throw offline; } }, "/client/work", "other.txt", Buffer.from("x"), true), LocalAgentUnavailable);
  await rm(root, { recursive: true, force: true });
});

test("a cloud browser upload uses the supplied client source and does not read the server cwd", async () => {
  assert.equal(needsClientFileBridge({ localAgent: true }), true);
  assert.equal(needsClientFileBridge({ localAgent: true, browserLocation: "local" }), false);
  assert.equal(canCloseComputer({ owner: "cloud", deps: [], depsVerified: true }), false);
  assert.equal(canCloseComputer({ owner: "cloud", deps: [{ status: "cloud" }], depsVerified: false }), false);
  assert.equal(canCloseComputer({ owner: "local", deps: [{ status: "cloud" }], depsVerified: true }), false);
  assert.equal(canCloseComputer({ owner: "cloud", deps: [{ status: "cloud" }, { status: "blocked" }], depsVerified: true }), false);
  assert.equal(canCloseComputer({ owner: "cloud", deps: [{ status: "cloud" }], depsVerified: true }), true);

  const store = await Store.open(":memory:");
  try {
    const chrome = new Chrome(store, new ChromeBridge(), "");
    chrome.observations.set("s:tab", { id: "snap", tabTag: "tab", frames: [{ id: "f", context: 1 }], pages: [{}], coverageGaps: [], images: [], captured: 0, fullPage: false, screenshot: false } as any);
    let serverReads = 0;
    chrome.workspaceFile = async () => { serverReads++; throw Error("read server cwd"); };
    chrome.bridge.request = async (operation: string) => {
      if (operation === "tabs") return { tabs: [] };
      throw Error("cdp stopped after the file was chosen");
    };
    const staged = await chrome.execute("s", "/same/cwd", {
      operation: "act", tabTag: "tab", action: { action: "upload", selector: "input[type=file]", files: ["note.txt"], frame: 0 },
    }, undefined, [], async () => "/browser-profile/bridge-inbox/note.txt");
    assert.equal(serverReads, 0, staged.reason || staged.status);
    const fallback = await chrome.execute("s", "/same/cwd", {
      operation: "act", tabTag: "tab", action: { action: "upload", selector: "input[type=file]", files: ["note.txt"], frame: 0 },
    });
    assert.equal(fallback.status, "not_executed");
    assert.match(fallback.reason, /read server cwd/);
    assert.equal(serverReads, 1);
  } finally { await store.close(); }
});
