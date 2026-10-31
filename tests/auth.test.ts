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
  const store = new Store(":memory:"),
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
    assert.equal(auth.authenticate(token)?.user.id, principal.user.id);
    assert.equal(auth.hasUsers(), true);
    await assert.rejects(
      () => auth.setup({ setupToken: secret, username: "second", password }),
      { statusCode: 409 },
    );
    const persisted = JSON.stringify(
      store.db.prepare("SELECT * FROM web_users").all(),
    );
    assert(!persisted.includes(password));
    assert(persisted.includes("scrypt1:"));
    assert(
      !JSON.stringify(
        store.db.prepare("SELECT * FROM web_sessions").all(),
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
    assert.equal(auth.authenticate("invalid"), undefined);
    auth.logout(login.principal.hash);
    assert.equal(auth.authenticate(login.token), undefined);
  } finally {
    store.close();
  }
});
test("concurrent initial setup cannot create two initial administrators", async () => {
  const store = new Store(":memory:"),
    auth = new Auth(store, secret);
  try {
    const results = await Promise.allSettled([
      auth.setup({ setupToken: secret, username: "first", password }),
      auth.setup({ setupToken: secret, username: "second", password }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(auth.users().length, 1);
  } finally {
    store.close();
  }
});
test("last enabled admin remains recoverable; demotion, disable and password reset revoke every login", async () => {
  const store = new Store(":memory:"),
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
    assert.equal(auth.authenticate(token), undefined);
    assert(auth.user(other.id)?.role === "admin");
    const firstLogin = await auth.login({ username: "admin", password }),
      secondLogin = await auth.login({ username: "admin", password });
    await auth.update(principal.user.id, {
      password: "new-valid-fixture-password",
    });
    assert.equal(auth.authenticate(firstLogin.token), undefined);
    assert.equal(auth.authenticate(secondLogin.token), undefined);
    await assert.rejects(() => auth.login({ username: "admin", password }), {
      statusCode: 401,
    });
    const fresh = await auth.login({
      username: "admin",
      password: "new-valid-fixture-password",
    });
    await auth.update(principal.user.id, { disabled: true });
    assert.equal(auth.authenticate(fresh.token), undefined);
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
    store.close();
  }
});
test("ownership and explicit readonly grants cover session descendants and screenshot blob access", async () => {
  const store = new Store(":memory:"),
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
    const legacy = store.newSession(),
      session = store.newSession({ ownerId: operator.id });
    assert(auth.canRead(admin, legacy));
    assert(!auth.canRead(operator, legacy));
    assert(auth.canWrite(operator, session));
    assert(!auth.canRead(viewer, session));
    session.readerIds = [viewer.id];
    store.saveSession(session);
    assert(auth.canRead(viewer, session));
    assert(!auth.canWrite(viewer, session));
    assert.throws(() => auth.session(viewer, session.id, true), {
      statusCode: 403,
    });
    assert.throws(() => auth.session(operator, legacy.id), { statusCode: 404 });
    const child = store.stage(session.id),
      fork = store.fork(session.id);
    assert.equal(child.ownerId, operator.id);
    assert.deepEqual(child.readerIds, [viewer.id]);
    assert.equal(fork.ownerId, operator.id);
    const blob = store.blob("image/png", Buffer.from("fixture"));
    assert(!auth.canBlob(viewer, blob));
    store.grantBlob(blob, session.id);
    assert(auth.canBlob(viewer, blob));
    session.readerIds = [];
    store.saveSession(session);
    assert(!auth.canBlob(viewer, blob));
    assert(auth.canBlob(operator, blob));
    assert(auth.canBlob(admin, blob));
    await auth.update(operator.id, { role: "viewer" });
    assert(!auth.canWrite(auth.user(operator.id)!, session));
  } finally {
    store.close();
  }
});
test("cookie sessions survive restart but expire and disappear on password change; rate limiting is bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-auth-")),
    path = join(dir, "auth.db");
  let store = new Store(path);
  try {
    let auth = new Auth(store, secret);
    const created = await auth.setup({
      setupToken: secret,
      username: "admin",
      password,
    });
    store.close();
    store = new Store(path);
    auth = new Auth(store, "rotated-setup-token-is-not-login");
    assert.equal(
      auth.authenticate(created.token)?.user.id,
      created.principal.user.id,
    );
    store.db
      .prepare("UPDATE web_sessions SET expiresAt=? WHERE hash=?")
      .run(Date.now() - 1, digest(created.token));
    assert.equal(auth.authenticate(created.token), undefined);
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
    assert.equal(auth.authenticate(login.token), undefined);
    for (let i = 0; i < 12; i++) auth.rate("client", "name");
    assert.throws(() => auth.rate("client", "name"), { statusCode: 429 });
    auth.running = 4;
    await assert.rejects(() => auth.crypto(async () => true), {
      statusCode: 429,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
