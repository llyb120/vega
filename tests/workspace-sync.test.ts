import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, compare, hash, manifest, merge, relativePath } from "../shared/workspace-sync.mjs";

const file = (path: string, content: string = path) => ({ path, data: Buffer.from(content) });

test("paths outside the workspace are never synced", () => {
  assert.equal(relativePath("./a\\b.ts"), "a/b.ts");
  assert.equal(relativePath("../etc/passwd"), "");
  assert.equal(relativePath("/abs/path"), "");
  assert.equal(relativePath("C:/Windows/system32"), "");
  assert.equal(allowed("src/index.ts"), true);
  assert.equal(allowed(".git/config"), false);
  assert.equal(allowed("web/node_modules/x/index.js"), false);
  assert.equal(allowed("deploy/.env.local"), false);
  assert.equal(allowed("keys/server.pem"), false);
});

test("manifest is sorted, hashed and refuses to silently truncate", () => {
  const list = manifest([file("b.ts"), file("a.ts"), { path: ".git/HEAD", data: Buffer.from("x") }]);
  assert.deepEqual(list.map((item) => item.path), ["a.ts", "b.ts"]);
  assert.equal(list[0].hash, hash(Buffer.from("a.ts")));
  assert.throws(() => manifest([file("a.ts")], { files: 0, bytes: 100, fileBytes: 100 }), /上限/);
  assert.throws(() => manifest([file("a.ts", "12345")], { files: 10, bytes: 100, fileBytes: 4 }), /文件过大/);
});

test("compare reports added, modified and removed paths", () => {
  const base = manifest([file("keep.ts"), file("change.ts", "old"), file("gone.ts")]);
  const next = manifest([file("keep.ts"), file("change.ts", "new"), file("added.ts")]);
  assert.deepEqual(compare(base, next), { added: ["added.ts"], modified: ["change.ts"], removed: ["gone.ts"] });
});

test("merge applies the only changed side and keeps real conflicts", () => {
  const base = manifest([file("both-changed-differently.ts", "base"), file("local-only.ts", "base"), file("remote-only.ts", "base"),
    file("same-change.ts", "base"), file("local-deleted.ts", "base"), file("remote-deleted.ts", "base"), file("local-delete-remote-edit.ts", "base")]);
  const local = manifest([file("both-changed-differently.ts", "local"), file("local-only.ts", "local"), file("remote-only.ts", "base"),
    file("same-change.ts", "same"), file("remote-deleted.ts", "base"), file("local-delete-remote-edit.ts", "")].filter((item) => item.path !== "local-delete-remote-edit.ts"));
  const remote = manifest([file("both-changed-differently.ts", "remote"), file("local-only.ts", "base"), file("remote-only.ts", "remote"),
    file("same-change.ts", "same"), file("local-deleted.ts", "base"), file("local-delete-remote-edit.ts", "remote")]);
  const plan = merge(base, local, remote);
  const actions = Object.fromEntries(plan.changes.map((change) => [change.path, change.side + ":" + change.action]));
  assert.equal(actions["local-only.ts"], "local:write");
  assert.equal(actions["remote-only.ts"], "remote:write");
  assert.equal(actions["same-change.ts"], undefined);
  // side 是改动来源侧：syncBack 把 side=remote 的改动写到本地，接回本地时反过来。
  assert.equal(actions["remote-deleted.ts"], "remote:delete");
  assert.equal(actions["local-deleted.ts"], "local:delete");
  assert.deepEqual(plan.conflicts.sort(), ["both-changed-differently.ts", "local-delete-remote-edit.ts"]);
});
