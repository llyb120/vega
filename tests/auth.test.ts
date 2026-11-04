import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/core/store";
import { Auth, AuthError, digest } from "../server/core/auth";
const secret = "auth-test-only-initialization-token";
const password = "Correct horse fixture battery";
test("initial administrator is one-time and passwords/cookie tokens are not stored in plaintext", async () => {
  const store = await Store.open(":memory:"),
    auth = new Auth(store, secret);
  try {
    await assert.rejects(
      () => auth.setup({ setupToken: "wrong", username: "admin", password }),
      { statusCode: 401 },
    );
    const { principal, token } = await auth.setup({
      setupToken: secret,
      username: "Admin",
      password,
    });
    assert.equal(principal.user.username, "admin");
    assert.equal(principal.user.role, "admin");
    assert.equal((await auth.authenticate(token))?.user.id, principal.user.id);
    assert.equal(await auth.hasUsers(), true);
    await assert.rejects(
      () => auth.setup({ setupToken: secret, username: "second", password }),
      { statusCode: 409 },
    );
    const persisted = JSON.stringify(
      await store.all("SELECT * FROM web_users"),
    );
    assert(!persisted.includes(password));
    assert(persisted.includes("scrypt1:"));
    assert(
      !JSON.stringify(
        await store.all("SELECT * FROM web_sessions"),
      ).includes(token),
    );
    const login = await auth.login({ username: "ADMIN", password });
    assert.equal(login.principal.user.id, principal.user.id);
    await assert.rejects(
      () => auth.login({ username: "ADMIN", password: "wrong-password" }),
      { statusCode: 401 },
    );
    await assert.rejects(() => auth.login({ username: "missing", password }), {
      statusCode: 401,
    });
    assert.equal(await auth.authenticate("invalid"), undefined);
    await auth.logout(login.principal.hash);
    assert.equal(await auth.authenticate(login.token), undefined);
  } finally {
    await store.close();
  }
});
test("each successful login starts a fresh seven-day period, not the first login date", async (t) => {
  const store = await Store.open(":memory:"), auth = new Auth(store, secret);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    const first = await auth.setup({ setupToken: secret, username: "seven-days", password });
    assert.equal(first.principal.expiresAt, now + 7 * 24 * 60 * 60 * 1000);
    now += 3 * 24 * 60 * 60 * 1000;
    const latest = await auth.login({ username: "seven-days", password });
    assert.equal(latest.principal.expiresAt, now + 7 * 24 * 60 * 60 * 1000);
    now = first.principal.expiresAt;
    assert.equal(await auth.authenticate(first.token), undefined);
    assert(await auth.authenticate(latest.token));
    now = latest.principal.expiresAt - 1;
    assert(await auth.authenticate(latest.token));
    now++;
    assert.equal(await auth.authenticate(latest.token), undefined);
  } finally { await store.close(); }
});

test("concurrent initial setup cannot create two initial administrators", async () => {
  const store = await Store.open(":memory:"),
    auth = new Auth(store, secret);
  try {
    const results = await Promise.allSettled([
      auth.setup({ setupToken: secret, username: "first", password }),
      auth.setup({ setupToken: secret, username: "second", password }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await auth.users()).length, 1);
  } finally {
    await store.close();
  }
});
test("last enabled admin remains recoverable; demotion, disable and password reset revoke every login", async () => {
  const store = await Store.open(":memory:"),
    auth = new Auth(store, secret);
  try {
    const { principal, token } = await auth.setup({
      setupToken: secret,
      username: "admin",
      password,
    });
    await assert.rejects(
      () => auth.update(principal.user.id, { role: "viewer" }),
      { statusCode: 409 },
    );
    await assert.rejects(
      () => auth.update(principal.user.id, { disabled: true }),
      { statusCode: 409 },
    );
    const other = await auth.add({
      username: "second-admin",
      password,
      role: "admin",
    });
    let revoked = "";
    auth.events.on("revoke", (id) => (revoked = id));
    await auth.update(principal.user.id, { role: "operator" });
    assert.equal(revoked, principal.user.id);
    assert.equal(await auth.authenticate(token), undefined);
    assert((await auth.user(other.id))?.role === "admin");
    const firstLogin = await auth.login({ username: "admin", password }),
      secondLogin = await auth.login({ username: "admin", password });
    await auth.update(principal.user.id, {
      password: "new-valid-fixture-password",
    });
    assert.equal(await auth.authenticate(firstLogin.token), undefined);
    assert.equal(await auth.authenticate(secondLogin.token), undefined);
    await assert.rejects(() => auth.login({ username: "admin", password }), {
      statusCode: 401,
    });
    const fresh = await auth.login({
      username: "admin",
      password: "new-valid-fixture-password",
    });
    await auth.update(principal.user.id, { disabled: true });
    assert.equal(await auth.authenticate(fresh.token), undefined);
    await assert.rejects(
      () =>
        auth.login({
          username: "admin",
          password: "new-valid-fixture-password",
        }),
      { statusCode: 401 },
    );
    await assert.rejects(
      () => auth.add({ username: "bad user", password, role: "viewer" }),
      { statusCode: 400 },
    );
    await assert.rejects(
      () =>
        auth.add({ username: "short-pass", password: "short", role: "viewer" }),
      { statusCode: 400 },
    );
  } finally {
    await store.close();
  }
});
test("private ownership covers session descendants and screenshot blob access", async () => {
  const store = await Store.open(":memory:"),
    auth = new Auth(store, secret);
  try {
    const admin = (
        await auth.setup({ setupToken: secret, username: "admin", password })
      ).principal.user,
      operator = await auth.add({
        username: "runner",
        password,
        role: "operator",
      }),
      viewer = await auth.add({ username: "reader", password, role: "viewer" });
    const legacy = await store.newSession(),
      session = await store.newSession({ ownerId: operator.id });
    assert(await auth.canRead(admin, legacy));
    assert(!await auth.canRead(operator, legacy));
    assert(auth.canWrite(operator, session));
    assert(!await auth.canRead(viewer, session));
    assert(!await auth.canRead(admin, session));
    session.readerIds = [viewer.id];
    await store.saveSession(session);
    assert(!await auth.canRead(viewer, session));
    assert(!auth.canWrite(viewer, session));
    await assert.rejects(async () => await auth.session(viewer, session.id, true), {
      statusCode: 404,
    });
    await assert.rejects(async () => await auth.session(operator, legacy.id), { statusCode: 404 });
    const child = await store.stage(session.id),
      fork = await store.fork(session.id);
    assert.equal(child.ownerId, operator.id);
    assert.deepEqual(child.readerIds, [viewer.id]);
    assert.equal(fork.ownerId, operator.id);
    const blob = await store.blob("image/png", Buffer.from("fixture"));
    assert(!await auth.canBlob(viewer, blob));
    await store.grantBlob(blob, session.id);
    assert(!await auth.canBlob(viewer, blob));
    assert(!await auth.canBlob(admin, blob));
    assert(await auth.canBlob(operator, blob));
    session.readerIds = [];
    await store.saveSession(session);
    assert(!await auth.canBlob(viewer, blob));
    assert(await auth.canBlob(operator, blob));
    assert(!await auth.canBlob(admin, blob));
    await auth.update(operator.id, { role: "viewer" });
    assert(!auth.canWrite((await auth.user(operator.id))!, session));
  } finally {
    await store.close();
  }
});
test("cookie sessions survive restart but expire and disappear on password change; rate limiting is bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-auth-")),
    path = join(dir, "auth.db");
  let store = await Store.open(path);
  try {
    let auth = new Auth(store, secret);
    const created = await auth.setup({
      setupToken: secret,
      username: "admin",
      password,
    });
    await store.close();
    store = await Store.open(path);
    auth = new Auth(store, "rotated-setup-token-is-not-login");
    assert.equal(
      (await auth.authenticate(created.token))?.user.id,
      created.principal.user.id,
    );
    await store.run("UPDATE web_sessions SET expiresAt=? WHERE hash=?", Date.now() - 1, digest(created.token));
    assert.equal(await auth.authenticate(created.token), undefined);
    const login = await auth.login({ username: "admin", password });
    await assert.rejects(
      () =>
        auth.changePassword(
          login.principal.user.id,
          "wrong",
          "new-long-enough-password",
        ),
      { statusCode: 401 },
    );
    await auth.changePassword(
      login.principal.user.id,
      password,
      "new-long-enough-password",
    );
    assert.equal(await auth.authenticate(login.token), undefined);
    for (let i = 0; i < 12; i++) auth.rate("client", "name");
    assert.throws(() => auth.rate("client", "name"), { statusCode: 429 });
    auth.running = 4;
    await assert.rejects(() => auth.crypto(async () => true), {
      statusCode: 429,
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
