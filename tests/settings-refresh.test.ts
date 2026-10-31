import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../server/core/store";
import { Subscriptions } from "../server/core/subscriptions";
import {
  requestedTime,
  nextFixed,
  workSlot,
  Employee,
} from "../server/core/employee";
import { Vault } from "../server/core/vault";
import { beijingDateTime, formatBeijing } from "../shared/time";

test("employee times are Beijing regardless of server timezone, including midnight,year rollover and overnight duty", () => {
  const before = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Shanghai"]) {
      process.env.TZ = zone;
      const now = Date.parse("2026-12-31T23:30:00Z");
      assert.equal(beijingDateTime(now), "2027-01-01 07:30");
      assert.equal(
        nextFixed(["09:00"], now),
        Date.parse("2027-01-01T01:00:00Z"),
      );
      assert.equal(
        workSlot("09:00", "18:00", now),
        Date.parse("2027-01-01T01:00:00Z"),
      );
      assert.equal(
        workSlot("22:00", "06:00", Date.parse("2027-01-01T15:00:00Z")),
        Date.parse("2027-01-01T15:00:00Z"),
      );
      assert.equal(
        workSlot("22:00", "06:00", Date.parse("2027-01-01T22:00:00Z")),
        Date.parse("2027-01-02T14:00:00Z"),
      );
      assert.equal(
        requestedTime({ nextAt: "2027-01-01 09:00" }, now),
        Date.parse("2027-01-01T01:00:00Z"),
      );
      assert.throws(() => requestedTime({ nextAt: "2027-02-30 09:00" }, now));
      assert(formatBeijing(now).includes("07:30"));
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("remote Devin PKCE returns to the website, is state/owner-bound and never binds a server loopback listener", async () => {
  const store = new Store(":memory:"),
    auth = new Subscriptions(store, "");
  let exchanges = 0;
  auth.loginRequest = async (url, init) => {
    assert.equal(url, "https://api.devin.ai/auth/cli/token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.code, "authorization-fixture");
    assert(body.code_verifier);
    exchanges++;
    return { token: "session-secret-fixture" };
  };
  try {
    const start = await auth.loginStart("devin", "global", {
        callbackOrigin: "https://vega.example",
        owner: "admin-one",
      }),
      url = new URL(start.url);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://vega.example/api/providers/callback/devin",
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.throws(() =>
      auth.receiveCallback("wrong-state", "authorization-fixture"),
    );
    auth.receiveCallback(start.state, "authorization-fixture");
    await assert.rejects(() =>
      auth.loginPoll("devin", start.state, undefined, "admin-two"),
    );
    assert.equal(
      await auth.loginPoll("devin", start.state, undefined, "admin-one"),
      true,
    );
    assert.equal(
      await auth.loginPoll("devin", start.state, undefined, "admin-one"),
      true,
    );
    assert.equal(exchanges, 1);
    assert.equal(auth.pending.get(start.state)?.verifier, undefined);
    await assert.rejects(() =>
      auth.loginPoll("devin", start.state, undefined, "admin-two"),
    );
    assert(
      !JSON.stringify(store.get("subscription:devin", {})).includes(
        "session-secret-fixture",
      ),
    );
    const remote = await auth.load("devin");
    assert.equal(
      remote.options.apiKey,
      "devin-session-token$session-secret-fixture",
    );
  } finally {
    auth.close();
    store.close();
  }
});

test("remote CodeBuddy polling preserves its site/source and accepts only official login domains", async () => {
  const store = new Store(":memory:"),
    auth = new Subscriptions(store, "");
  const urls: string[] = [];
  auth.loginRequest = async (url) => {
    urls.push(url);
    if (url.includes("/auth/state"))
      return {
        data: {
          state: "state-fixture",
          authUrl: "https://auth.codebuddy.cn/login?state=state-fixture",
        },
      };
    if (url.includes("/auth/token?"))
      return {
        data: { accessToken: "private-token-fixture", expiresIn: 3600 },
      };
    return { code: 0, data: { uid: "fixture-user" } };
  };
  try {
    const start = await auth.loginStart("codebuddy", "cn", {
      callbackOrigin: "https://vega.example",
      owner: "admin",
    });
    assert(start.url.startsWith("https://auth.codebuddy.cn/"));
    await assert.rejects(() =>
      auth.loginPoll("workbuddy", start.state, undefined, "admin"),
    );
    assert.equal(
      await auth.loginPoll("codebuddy", start.state, undefined, "admin"),
      true,
    );
    const calls = urls.length;
    assert.equal(
      await auth.loginPoll("codebuddy", start.state, undefined, "admin"),
      true,
    );
    assert.equal(urls.length, calls);
    assert(urls.every((url) => url.startsWith("https://www.codebuddy.cn/")));
    const saved = await auth.saved("codebuddy");
    assert.equal(saved.auth.accessToken, "private-token-fixture");
    assert.equal(saved.site, "cn");
    auth.loginRequest = async () => ({
      data: {
        state: "bad",
        authUrl: "https://www.codebuddy.cn.evil.test/login",
      },
    });
    await assert.rejects(() => auth.loginStart("codebuddy", "cn"));
  } finally {
    auth.close();
    store.close();
  }
});

test("removed Orbit is not exposed to the website or scheduler; prior data is retained without firing old subscriptions", async () => {
  const store = new Store(":memory:"),
    employee = new Employee(store, new Vault(store), {
      run: async () => {
        throw Error("must not run");
      },
      cancel: () => {},
      isRunning: () => false,
      emit: () => {},
      send: async () => {},
      config: () => ({}),
    });
  employee.closed = true;
  try {
    const state = employee.state();
    state.duties.push({
      id: "legacy",
      text: "old star workflow",
      enabled: true,
      events: ["orbit.added"],
      eventAt: 1,
      pending: ["old event"],
    });
    state.orbit.push({ id: "retained", text: "legacy data" });
    store.put("employee", state);
    assert.equal(employee.state().duties[0].enabled, false);
    assert.equal(employee.state().duties[0].eventAt, 0);
    await assert.rejects(() =>
      employee.execute("", { action: "orbit_add", text: "x" }),
    );
    assert.equal(store.get<any>("employee", {}).orbit[0].id, "retained");
  } finally {
    employee.close();
    store.close();
  }
});

test("UI keeps all pages Vapor, settings last, separate experiences, no whole-page bounce and no directory/config JSON inputs", () => {
  const app = readFileSync("web/src/App.vue", "utf8"),
    css = readFileSync("web/src/style.css", "utf8"),
    nav = app.slice(app.indexOf("<nav "), app.indexOf("</nav>"));
  assert(
    nav.indexOf("view = 'experiences'") <
      nav.lastIndexOf("view = 'settings'") ||
      nav.indexOf("view='experiences'") < nav.lastIndexOf("view='settings'"),
  );
  assert(!app.includes("星轨"));
  assert(!app.includes("员工工作目录"));
  assert(!app.includes("模型配置 JSON"));
  assert(!app.includes("Nitro · SQLite"));
  assert(!app.includes("T1/T2/T3"));
  assert.match(css, /overscroll-behavior:\s*none/);
  assert(
    !readFileSync("web/src/ProviderSettings.vue", "utf8").includes(
      "WorkBuddy.exe",
    ),
  );
});
