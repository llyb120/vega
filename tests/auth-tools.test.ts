import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Auth } from "../server/core/auth";
import { Engine } from "../server/core/engine";
import { Tools } from "../server/core/tools";
import { Subscriptions } from "../server/core/subscriptions";
import { Catalog } from "../server/core/catalog";
import { Chrome } from "../server/core/chrome";
import { ChromeBridge } from "../server/core/chrome-bridge";
import { resolveModel } from "../server/core/config";
test("website login and role revocation never filter internal tools or interrupt authorized runtime work", async () => {
  const store = new Store(":memory:"),
    auth = new Auth(store, "website-only-permissions-fixture-token"),
    subscriptions = new Subscriptions(store, ""),
    engine = new Engine(
      store,
      new Catalog(store, subscriptions),
      new Chrome(store, new ChromeBridge(), ""),
    );
  engine.employee.closed = true;
  const cfg: any = {
    scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] },
    model: "p/m",
    contextMode: "acp",
    provider: {
      p: {
        api: "openai-completions",
        baseURL: "https://unused.test",
        models: { m: { limit: { context: 128000, output: 8192 } } },
      },
    },
  };
  store.put("config", cfg);
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>((yes) => (started = yes)),
    wait = new Promise<void>((yes) => (release = yes));
  let requests = 0,
    tools: Tools | undefined,
    reference: Tools | undefined;
  try {
    await auth.setup({
      setupToken: auth.setupToken,
      username: "admin",
      password: "valid-web-admin-fixture-password",
    });
    const user = await auth.add({
        username: "runner",
        password: "valid-web-operator-fixture-password",
        role: "operator",
      }),
      login = await auth.login({
        username: "runner",
        password: "valid-web-operator-fixture-password",
      });
    const session = store.newSession({ ownerId: user.id }),
      system = store.newSession(),
      model = resolveModel(cfg);
    tools = new Tools(
      engine,
      session,
      cfg,
      new AbortController().signal,
      () => {},
    );
    reference = new Tools(
      engine,
      system,
      cfg,
      new AbortController().signal,
      () => {},
    );
    const definitions = () =>
      tools!
        .definitions(model)
        .map((t) => t.name)
        .sort();
    assert.deepEqual(
      definitions(),
      reference
        .definitions(model)
        .map((t) => t.name)
        .sort(),
    );
    assert(definitions().includes("employee"));
    engine.providers.chat = async () => {
      if (++requests === 1) {
        started();
        await wait;
        return {
          role: "assistant",
          calls: [
            {
              id: "runtime-employee-list",
              name: "employee",
              arguments: { action: "list" },
            },
          ],
        };
      }
      return {
        role: "assistant",
        text: "internal run completed without any website login",
      };
    };
    const running = engine.run(session.id, {
      role: "user",
      text: "An already-authorized internal task",
    });
    await begun;
    auth.logout(login.principal.hash);
    await auth.update(user.id, { role: "viewer", disabled: true });
    assert.equal(auth.authenticate(login.token), undefined);
    assert.deepEqual(
      definitions(),
      reference
        .definitions(model)
        .map((t) => t.name)
        .sort(),
    );
    release();
    await running;
    assert(
      store.messages(session.id).some((m) => m.name === "employee" && !m.error),
    );
    assert(
      store
        .messages(session.id)
        .some(
          (m) => m.text === "internal run completed without any website login",
        ),
    );
    assert(
      (await tools.read({ path: "sqlite:config" })).value.text.includes(
        "provider",
      ),
    );
    await engine.run(session.id, {
      role: "user",
      text: "Internal scheduler continuation with no browser session",
    });
    assert.equal(requests, 3);
  } finally {
    release?.();
    await tools?.close();
    await reference?.close();
    await engine.close();
    store.close();
  }
});
