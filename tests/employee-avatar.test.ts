import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ZODIAC_AVATARS, isAvatarPreset, employeeAvatarURL } from "../shared/employee-avatars";
import { updateEmployeeAvatar } from "../server/core/employee-avatar";
import { Employee, type EmployeeRuntime } from "../server/core/employee";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";

function fixture() {
  const store = new Store(":memory:");
  const runtime: EmployeeRuntime = { run: async () => {}, cancel() {}, isRunning: () => false, emit() {}, send: async () => ({}), config: () => ({ model: "fixture/model" }) };
  const root = new Employee(store, new Vault(store), runtime); root.closed = true;
  const employee = root.for(root.create({ name: "Avatar employee", avatar: "zodiac:aries" }, "owner").id);
  return { store, root, employee };
}

test("all 12 zodiac presets are real square WebP assets and avatar URLs never accept arbitrary paths or remote tracking URLs", async () => {
  assert.equal(ZODIAC_AVATARS.length, 12);
  assert.equal(new Set(ZODIAC_AVATARS.map(avatar => avatar.id)).size, 12);
  for (const avatar of ZODIAC_AVATARS) {
    const value = "zodiac:" + avatar.id;
    assert(isAvatarPreset(value));
    assert.equal(employeeAvatarURL("employee", value), `/avatars/zodiac/${avatar.id}.webp`);
    const metadata = await sharp(`web/public/avatars/zodiac/${avatar.id}.webp`).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
  }
  assert.equal(employeeAvatarURL("employee", ""), "");
  const blob = "blob-" + "1".repeat(32);
  assert.equal(employeeAvatarURL("employee", blob), `/api/employees/employee/avatar?v=${blob}`);
  for (const value of ["https://tracker.example/avatar", "javascript:alert(1)", "data:image/svg+xml,...", "zodiac:../secret", "/api/blobs/" + blob, "zodiac:unknown"]) {
    assert.equal(isAvatarPreset(value), false);
    assert.equal(employeeAvatarURL("employee", value), "");
  }
});

test("preset selection, clearing and reopening preserve the employee's own avatar without accepting an arbitrary blob reference", async () => {
  const { store, root, employee } = fixture();
  try {
    assert.equal(employee.state().avatar, "zodiac:aries");
    await updateEmployeeAvatar(employee, { preset: "zodiac:pisces" });
    const reopened = new Employee(store, root.vault, root.runtime);
    assert.equal(reopened.for(employee.employeeId).state().avatar, "zodiac:pisces");
    await assert.rejects(employee.control({ action: "settings", avatar: "blob-" + "1".repeat(32) }), /avatar/);
    assert.equal(employee.state().avatar, "zodiac:pisces");
    await updateEmployeeAvatar(employee, { preset: "" });
    assert.equal(employee.state().avatar, "");
    assert.throws(() => root.create({ name: "Bad", avatar: "https://tracker.example/pixel" }, "owner"), /avatar/);
  } finally { root.close(); store.close(); }
});

test("custom avatar uploads are normalized, metadata-free and stored separately from employee state", async () => {
  const { store, root, employee } = fixture();
  try {
    const input = await sharp({ create: { width: 300, height: 180, channels: 4, background: "#6699dd" } }).withMetadata({ orientation: 6 }).png().toBuffer();
    const result = await updateEmployeeAvatar(employee, { mime: "image/png", data: input.toString("base64") });
    assert.equal(result.employeeId, employee.employeeId);
    assert.match(result.avatar, /^blob-[a-f\d]{32}$/);
    assert.equal(employee.state().avatar, result.avatar);
    const image = store.blobData(result.avatar)!;
    assert.equal(image.mime, "image/webp");
    const metadata = await sharp(image.data).metadata();
    assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
    assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
    assert(!JSON.stringify(employee.state()).includes(input.toString("base64")));
    assert.equal(root.state().avatar, undefined, "another employee's avatar is unchanged");
  } finally { root.close(); store.close(); }
});

test("invalid, oversized and disguised image uploads leave the current avatar and blob store unchanged", async () => {
  const { store, root, employee } = fixture();
  try {
    const before = (store.db.prepare("SELECT COUNT(*) count FROM blobs").get() as any).count;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>').toString("base64");
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).jpeg().toBuffer();
    for (const input of [
      { preset: "zodiac:unknown" }, { preset: "javascript:alert(1)" },
      { mime: "image/svg+xml", data: svg }, { mime: "image/png", data: svg },
      { mime: "image/png", data: jpeg.toString("base64") }, { mime: "image/png", data: "not base64!" },
      { mime: "__proto__", data: "YQ==" }, { mime: "image/png", data: "A".repeat(7 * 1024 * 1024 + 1) },
    ]) await assert.rejects(updateEmployeeAvatar(employee, input));
    assert.equal(employee.state().avatar, "zodiac:aries");
    assert.equal((store.db.prepare("SELECT COUNT(*) count FROM blobs").get() as any).count, before);
  } finally { root.close(); store.close(); }
});
