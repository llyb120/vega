import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromiumArguments } from "../docker/start.mjs";
import { connected, apiAddress } from "../docker/healthcheck.mjs";
import { isolatedBrowserPresence } from "../server/core/presence";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";
import { Employee } from "../server/core/employee";
import { sleep } from "../server/core/util";

test("container Chromium automatically loads the fixed extension in its private persistent profile without opening CDP", () => {
  const args = chromiumArguments("/data/chromium", "/app/extension", "0");
  assert(args.includes("--headless=new"));
  assert(args.includes("--user-data-dir=/data/chromium"));
  assert(args.includes("--load-extension=/app/extension"));
  assert(args.includes("--disable-extensions-except=/app/extension"));
  assert(
    !args.some((arg: string) =>
      /no-sandbox|disable.*sandbox|remote-debugging|ignore-certificate|disable-web-security/.test(
        arg,
      ),
    ),
  );
  assert(
    chromiumArguments("/data/chromium", "/app/extension", "1").includes(
      "--no-sandbox",
    ),
  );
  assert.throws(() =>
    chromiumArguments("/data/chromium", "/app/extension", "yes"),
  );
});

test("container health requires authenticated extension pairing, not merely an alive HTTP server", async () => {
  let paired = false,
    status = 200,
    calls = 0;
  const token = "test-only-docker-access-token";
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.url, "/api/health");
    assert.equal(req.headers.authorization, "Bearer " + token);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: paired }));
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  const env = {
    NITRO_PORT: String((server.address() as any).port),
    VEGA_TOKEN: token,
  };
  try {
    assert.equal(await connected(env), false);
    paired = true;
    assert.equal(await connected(env), true);
    status = 401;
    assert.equal(await connected(env), false);
    assert.throws(() => apiAddress({ ...env, VEGA_TOKEN: "short" }));
    assert.throws(() => apiAddress({ ...env, NITRO_PORT: "0" }));
    assert.throws(() => apiAddress({ ...env, NITRO_PORT: "not-a-port" }));
    assert.equal(calls, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  }
});

test("isolated-browser presence is opt-in on Linux and cannot masquerade as host activity or locking", () => {
  assert.equal(isolatedBrowserPresence("linux", undefined), undefined);
  assert.equal(isolatedBrowserPresence("win32", "isolated"), undefined);
  assert.equal(isolatedBrowserPresence("darwin", "isolated"), undefined);
  const first = isolatedBrowserPresence("linux", "isolated", 10000)!,
    next = isolatedBrowserPresence("linux", "isolated", 30000)!;
  assert.equal(first.source, "isolated-chromium");
  assert(first.available && !first.locked);
  assert.equal(first.sampledAt! - first.idleMs, 0);
  assert.equal(next.sampledAt! - next.idleMs, 0);
});

test("dedicated container browser tasks start without claiming a physical desktop and retain normal task isolation", async () => {
  const store = new Store(":memory:");
  let runs = 0,
    takeovers = 0;
  const employee = new Employee(store, new Vault(store), {
    run: async () => {
      runs++;
      employee.update((s) => (s.enabled = false));
    },
    cancel: () => {},
    isRunning: () => false,
    emit: (type) => {
      if (type === "employee_takeover") takeovers++;
    },
    send: async () => {},
    config: () => ({ model: "p/vision" }),
    presence: async () => isolatedBrowserPresence("linux", "isolated")!,
  });
  employee.closed = true;
  try {
    await employee.execute("", {
      action: "add",
      kind: "todo",
      text: "only control the private browser",
    });
    employee.update((s) => {
      s.enabled = true;
      s.workStart = s.workEnd = "00:00";
      s.tasks[0].side = "computer";
    });
    employee.lastActivity = Date.now();
    employee.closed = false;
    await employee.tick();
    for (let i = 0; i < 30 && employee.busy.size; i++) await sleep(5);
    assert.equal(runs, 1);
    assert.equal(takeovers, 0);
    assert(employee.state().tasks[0].computerSession);
  } finally {
    employee.close();
    store.close();
  }
});

test("Docker image builds Linux-native artifacts, runs non-root, persists state and keeps bridge/debug ports private", () => {
  const docker = readFileSync("Dockerfile", "utf8"),
    ignore = readFileSync(".dockerignore", "utf8");
  assert.match(docker, /FROM node:24-bookworm-slim AS build/);
  assert.match(docker, /RUN npm ci/);
  assert.match(docker, /RUN npm run build/);
  assert.match(docker, /COPY --from=build \/app\/\.output \/app\/\.output/);
  assert.match(docker, /USER node/);
  assert.match(docker, /chromium-sandbox/);
  assert.match(docker, /VEGA_CHROMIUM_NO_SANDBOX=0/);
  assert.deepEqual(docker.match(/^EXPOSE .+$/gm), ["EXPOSE 8080"]);
  assert.match(docker, /VOLUME \["\/data", "\/workspace"\]/);
  assert.match(ignore, /^\*\*$/m);
  assert(
    !/COPY \. /m.test(docker),
    "Do not copy host credentials or native .output artifacts",
  );
  assert.equal(
    JSON.parse(readFileSync("docker/chromium-policy.json", "utf8"))
      .DownloadDirectory,
    "/data/downloads",
  );
});
