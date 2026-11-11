import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  browserExtensionPrompt,
  installBrowserExtension,
  type ExtensionDeps,
} from "../server/core/local-extension";

const EXTENSION = "local/extension/vega-chrome";
const WINDOWS_PATH = String.raw`C:\Users\owner\AppData\Roaming\vega-local\example.com\extension\vega-chrome`;
const POSIX_PATH = "/home/owner/.config/vega-local/example.com/extension/vega-chrome";
const GRANT = { userId: "u1", clientId: "c1" };

type Masters = { fsMaster: string; browserMaster: string };
type Options = { masters?: Record<string, Masters>; employees?: any[]; busy?: boolean };

/** One employe's chat session, its two Masters and the spies the endpoint must (not) touch. */
function fixture(options: Options = {}) {
  const submitted: { id: string; message: any }[] = [];
  const touched: string[] = [];
  const employeeOf = (id: string, name: string) => ({
    employeeId: id,
    deleting: false,
    manageable: async () => true,
    chat: async () => ({ id: "chat-" + id }),
    state: async () => ({ name }),
  });
  const employees = options.employees ?? [employeeOf("e1", "牛马一号")];
  const masters = options.masters ?? {};
  const engine = {
    active: new Map<string, unknown>(options.busy ? [["chat-e1", {}]] : []),
    employee: { all: async () => employees },
    // Selected clients that are offline fall back to "cloud" inside MasterRuntimes; the endpoint reads the result.
    runtimes: {
      get: async (employeeId: string) => masters[employeeId] ?? { fsMaster: "c1", browserMaster: "c1" },
    },
    localAgents: {
      list: () => [{ id: "c1", name: "本机", cwd: "C:/work", platform: "windows", browser: "local", active: true }],
    },
    // The endpoint must never rewrite the employee chat's execution again: Masters decide that.
    store: {
      session: async () => {
        touched.push("session");
        throw Error("an employee chat must not be rebound");
      },
      saveSession: async () => {
        touched.push("saveSession");
      },
    },
    submitChat: async (id: string, message: any) => {
      submitted.push({ id, message });
    },
  };
  const auth = {
    user: async (id: string) => ({ id, username: "owner", role: "admin", disabled: false, createdAt: 0, lastLogin: 0 }),
  };
  return { deps: { auth, engine } as unknown as ExtensionDeps, submitted, touched };
}

/** Chrome derives the extension ID from the manifest key: sha256 of the SPKI DER, first 16 bytes, 0-f → a-p. */
function extensionId(key: string) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

test("the Vega extension keeps one identity: manifest key → extension ID used by the server bridge and the native client", async () => {
  const manifest = JSON.parse(await readFile(`${EXTENSION}/manifest.json`, "utf8"));
  const bridge = await readFile("server/core/chrome-bridge.ts", "utf8");
  const client = await readFile("local/browser.go", "utf8");
  assert.equal(manifest.name, "Vega Chrome");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_title, "Vega Chrome");
  const id = extensionId(manifest.key);
  assert.equal(id, "bhiemmbmefifaloapbcopihahhckolce", "the key and the documented extension ID match");
  assert.equal(bridge.match(/const EXTENSION_ID = "([^"]+)"/)?.[1], id, "the server bridge only accepts this extension");
  assert.equal(client.match(/extensionOrigin = "chrome-extension:\/\/([^"]+)"/)?.[1], id, "the native client only accepts this extension");
  assert.equal(bridge.match(/version = "([^"]+)";/)?.[1], manifest.version, "bridge reloads the extension once per version");
  assert.equal(client.match(/extensionVersion = "([^"]+)"/)?.[1], manifest.version);
});

test("the Vega extension only discovers its own loopback ports, never Nova's", async () => {
  const worker = await readFile(`${EXTENSION}/worker.js`, "utf8");
  const bridge = await readFile("server/core/chrome-bridge.ts", "utf8");
  const client = await readFile("local/browser.go", "utf8");
  assert.match(worker, /for \(let port=47753; port<=47762; port\+\+\)/);
  assert.doesNotMatch(worker, /for \(let port=47653/, "the shared Nova range must not come back");
  assert(client.includes("for port := 47753; port <= 47762; port++"), "native client listens on the Vega range");
  assert(bridge.includes("47753 + n"), "server bridge asks for the Vega range");
  assert(!bridge.includes("47653"));
});

test("the install prompt names the extracted directory and forbids installing the extension by shell", () => {
  const text = browserExtensionPrompt(WINDOWS_PATH, { name: "本机" });
  assert(text.includes(WINDOWS_PATH), "the employee must get the exact directory to load");
  assert.match(text, /appuse/, "desktop input is the only allowed channel");
  assert.match(text, /电脑会话/, "the chat alone has no appuse: the work happens in an employee task's computer scene");
  assert.match(text, /不要用 bash/);
  assert.match(text, /47753–47762/, "it must verify the connection on the Vega bridge ports");
  assert.doesNotMatch(text, /Nova/);
});

test("the install endpoint refuses missing employees, a foreign filesystem or browser Master and a bad directory", async () => {
  await assert.rejects(
    () => installBrowserExtension(fixture({ employees: [] }).deps, GRANT, { path: WINDOWS_PATH }),
    /没有可用的牛马/,
  );
  await assert.rejects(
    () => installBrowserExtension(fixture({ masters: { e1: { fsMaster: "cloud", browserMaster: "c1" } } }).deps, GRANT, { path: WINDOWS_PATH }),
    /文件系统 Master 现在是云端/,
  );
  await assert.rejects(
    () => installBrowserExtension(fixture({ masters: { e1: { fsMaster: "c1", browserMaster: "c2" } } }).deps, GRANT, { path: WINDOWS_PATH }),
    /浏览器 Master 现在是另一台设备/,
  );
  for (const path of ["relative/dir", "", `/${"x".repeat(2000)}`, 42])
    await assert.rejects(
      () => installBrowserExtension(fixture().deps, GRANT, { path }),
      (error: any) => error.statusCode === 400 && /扩展目录无效/.test(error.message),
    );
  await assert.rejects(
    () => installBrowserExtension(fixture({ busy: true }).deps, GRANT, { path: WINDOWS_PATH }),
    /正在执行别的请求/,
  );
  const ok = fixture();
  assert.equal(ok.touched.length, 0, "nothing is refused before the checks pass");
});

test("only an employee whose filesystem and browser Master are this computer gets the install task", async () => {
  const ok = fixture();
  assert.deepEqual(await installBrowserExtension(ok.deps, GRANT, { path: WINDOWS_PATH }), {
    employee: "牛马一号",
    employeeId: "e1",
    session: "chat-e1",
  });
  assert.equal(ok.submitted.length, 1);
  assert.equal(ok.submitted[0].id, "chat-e1");
  assert.equal(ok.submitted[0].message.role, "user");
  assert.equal(ok.submitted[0].message.actorId, "u1");
  assert(ok.submitted[0].message.text.includes(WINDOWS_PATH));
  assert.match(ok.submitted[0].message.text, /本机/, "the prompt names the computer that will load it");
  assert.deepEqual(ok.touched, [], "the employee chat's execution is left to the Masters, not rewritten here");

  // The first employee belongs to the cloud; the second one is owned by this computer.
  const second = fixture({
    employees: [
      { employeeId: "e1", deleting: false, manageable: async () => true, chat: async () => ({ id: "chat-e1" }), state: async () => ({ name: "云端牛马" }) },
      { employeeId: "e2", deleting: false, manageable: async () => true, chat: async () => ({ id: "chat-e2" }), state: async () => ({ name: "本机牛马" }) },
    ],
    masters: { e1: { fsMaster: "cloud", browserMaster: "cloud" }, e2: { fsMaster: "c1", browserMaster: "c1" } },
  });
  const picked = await installBrowserExtension(second.deps, GRANT, { path: POSIX_PATH });
  assert.equal(picked.employeeId, "e2");
  assert.equal(second.submitted[0].id, "chat-e2");
  assert(second.submitted[0].message.text.includes(POSIX_PATH));
});
