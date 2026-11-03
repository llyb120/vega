import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ZODIAC_AVATARS, BOT_AVATAR_SHAPES, BOT_AVATAR_COLORS, isAvatarPreset, employeeAvatarURL, parseBotAvatar, defaultBotAvatar, botAvatarPreset } from "../shared/employee-avatars";
import { BOT_SHAPE_GEOMETRY, BOT_POSES, LOOK_POSES, MESSAGE_POSE, projectFace, shade, nextPose, holdDuration, blinkPlan } from "../web/src/bot-avatar.js";
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

test("bot avatars encode shape and color in the preset string and every shape has original geometry", () => {
  assert(BOT_AVATAR_SHAPES.length >= 15 && BOT_AVATAR_COLORS.length >= 12);
  assert.equal(new Set(BOT_AVATAR_SHAPES.map(shape => shape.id)).size, BOT_AVATAR_SHAPES.length);
  for (const shape of BOT_AVATAR_SHAPES) {
    const geometry = (BOT_SHAPE_GEOMETRY as any)[shape.id];
    assert(geometry, shape.id);
    assert.match(geometry.d, /^M[\d.\- ]+[CQLA]/, shape.id);
    assert(!/NaN|Infinity/.test(geometry.d), shape.id);
    for (const color of BOT_AVATAR_COLORS) {
      const value = botAvatarPreset(shape.id, color.id);
      assert(isAvatarPreset(value), value);
      assert.deepEqual(parseBotAvatar(value), { shape: shape.id, color: color.id, hex: color.hex });
      assert.equal(employeeAvatarURL("employee", value), "", "bot avatars render inline, never as a URL");
    }
  }
  for (const value of ["bot:", "bot:round", "bot:round:", "bot:unknown:red", "bot:round:unknown", "bot:round:red:extra", "bot:round:#ff0000", "bot:../x:red", "BOT:round:red"]) assert.equal(isAvatarPreset(value), false, value);
  assert.deepEqual(defaultBotAvatar("employee-a"), defaultBotAvatar("employee-a"), "the default bot is stable per employee");
  assert(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(seed => JSON.stringify(defaultBotAvatar(seed)))).size > 4, "default bots vary across employees");
  assert(LOOK_POSES.length >= 15 && !LOOK_POSES.some((id) => /blink|wink|cross|daze|skeptic|squint|sleepy/.test(id)), "variety comes from head turns, not 2D expressions");
  for (const id of LOOK_POSES) { const { yaw, pitch } = (BOT_POSES as Record<string, { yaw: number; pitch: number }>)[id]; assert(Math.abs(yaw) <= 40 && Math.abs(pitch) <= 30); }
  assert(LOOK_POSES.includes(MESSAGE_POSE) && BOT_POSES[MESSAGE_POSE].yaw >= 20 && BOT_POSES[MESSAGE_POSE].pitch >= 12, "message avatars turn up-right");
  for (let i = 0; i < 200; i++) { const pose = nextPose("left", "up"); assert(pose !== "left" && pose !== "up" && LOOK_POSES.includes(pose)); }
  // Random, not a fixed cycle: two independently generated sequences differ, and many poses get visited.
  const walk = () => { const seq: string[] = []; let current = "center", previous; for (let i = 0; i < 30; i++) { const next = nextPose(current, previous); previous = current; current = next; seq.push(next); } return seq; };
  const a = walk(), b = walk();
  assert.notDeepEqual(a, b);
  assert(new Set(a).size >= 8);
  assert(a.every((pose, i) => !i || pose !== a[i - 1]), "never repeats the same pose back to back");
  const holds = Array.from({ length: 200 }, () => holdDuration());
  assert(Math.min(...holds) >= 280 && Math.max(...holds) <= 1900 && new Set(holds.map(Math.round)).size > 100);
  const blinks = Array.from({ length: 400 }, () => blinkPlan());
  assert(blinks.some(plan => plan.double) && blinks.some(plan => !plan.double));
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
    await updateEmployeeAvatar(employee, { preset: "bot:cloud:teal" });
    assert.equal(employee.state().avatar, "bot:cloud:teal");
    await assert.rejects(updateEmployeeAvatar(employee, { preset: "bot:cloud:#00ffaa" }));
    assert.equal(employee.state().avatar, "bot:cloud:teal");
    await updateEmployeeAvatar(employee, { preset: "" });
    assert.equal(employee.state().avatar, "");
    assert.throws(() => root.create({ name: "Bad", avatar: "https://tracker.example/pixel" }, "owner"), /avatar/);
  } finally { root.close(); store.close(); }
});

test("new employees automatically get an unused shape/color pair without changing existing avatars", () => {
  const { store, root } = fixture();
  try {
    const selected = root.create({ name: "Selected", avatar: "bot:cloud:teal" }, "owner");
    const legacy = root.create({ name: "Legacy" }, "owner");
    root.for(legacy.id).update((state) => { state.avatar = ""; });
    const before = root.all().map((employee) => employee.state());
    const used = new Set(before.map((state) => {
      const bot = parseBotAvatar(state.avatar) || defaultBotAvatar(state.id);
      return botAvatarPreset(bot.shape, bot.color);
    }));
    const created = [];
    while (root.all().length < 50) {
      const state = root.create({ name: "Automatic", ...(created.length % 2 ? { avatar: "" } : {}) }, "owner");
      assert(parseBotAvatar(state.avatar), "persist an explicit preset, not a hash-only default");
      assert(!used.has(state.avatar!), state.avatar);
      used.add(state.avatar!);
      created.push(state);
    }
    for (const state of before) assert.equal(root.for(state.id).state().avatar, state.avatar);
    const reopened = new Employee(store, root.vault, root.runtime);
    for (const state of created) assert.equal(reopened.for(state.id).state().avatar, state.avatar);
    assert.equal(reopened.for(selected.id).state().avatar, "bot:cloud:teal");
    assert.throws(() => root.create({ name: "Full" }, "owner"), /capacity/);
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

test("bot faces are projected onto a turning 3D head", () => {
  const round = BOT_SHAPE_GEOMETRY.round, front = projectFace(round, 0, 0);
  assert(Math.abs(front.left.rx - front.right.rx) < 1e-9 && Math.abs(front.left.cx + front.right.cx - 100) < 1e-6, "symmetric when facing front");
  const right = projectFace(round, 30, 0), gap = (f: ReturnType<typeof projectFace>) => f.right.cx - f.left.cx;
  assert(right.left.cx > front.left.cx + 8 && right.right.cx > front.right.cx + 4, "eyes travel with the turn");
  assert(right.right.rx < right.left.rx * 0.85 && right.right.ry < right.left.ry, "far eye narrows and shrinks");
  assert(right.left.ry > front.left.ry, "near eye grows");
  assert(gap(right) < gap(front) * 0.9, "far eye moves toward the near eye");
  const up = projectFace(round, 0, 24);
  assert(up.left.cy < front.left.cy - 8 && up.left.ry < front.left.ry * 0.95, "vertical turns move and foreshorten the eyes");
  const rest = projectFace(round, BOT_POSES[MESSAGE_POSE].yaw, BOT_POSES[MESSAGE_POSE].pitch);
  assert(rest.left.rx > rest.right.rx * 1.15 && rest.light.x > front.light.x && rest.light.y < front.light.y, "up-right rest pose: near eye bigger, shading follows");
  const closed = projectFace(round, 10, 5, 0.05);
  assert(closed.left.ry < 1 && closed.right.ry < 1, "eyelids close vertically");
  assert.equal(shade("#000000", 0.5), "#808080");
  assert.equal(shade("#ffffff", -1), "#000000");
});

