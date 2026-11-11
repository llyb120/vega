import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ZODIAC_AVATARS, BOT_AVATAR_SHAPES, BOT_AVATAR_COLORS, isAvatarPreset, employeeAvatarURL, parseBotAvatar, defaultBotAvatar, botAvatarPreset, parseAvatarColor, inkOn, bubbleTint } from "../shared/employee-avatars";
import { BOT_SHAPE_GEOMETRY, BOT_POSES, LOOK_POSES, MESSAGE_POSE, projectFace, shade, nextPose, holdDuration, blinkPlan } from "../web/src/bot-avatar.js";
import { updateEmployeeAvatar, updateUserAvatar } from "../server/core/employee-avatar";
import { Employee, type EmployeeRuntime } from "../server/core/employee";
import { Store } from "../server/core/store";
import { Vault } from "../server/core/vault";

async function fixture() {
  const store = await Store.open(":memory:");
  const runtime: EmployeeRuntime = { run: async () => {}, cancel() {}, isRunning: () => false, emit() {}, config: () => ({ scenes: { lightweight: ["p/m"], coding: ["p/m"], computer: ["p/m"] }, model: "fixture/model" }) };
  const root = new Employee(store, new Vault(store), runtime); root.closed = true;
  const employee = await root.for((await root.create({ name: "Avatar employee", avatar: "zodiac:aries" }, "owner")).id);
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
  const { store, root, employee } = await fixture();
  try {
    assert.equal((await employee.state()).avatar, "zodiac:aries");
    await updateEmployeeAvatar(employee, { preset: "zodiac:pisces" });
    const reopened = new Employee(store, root.vault, root.runtime);
    assert.equal((await (await reopened.for(employee.employeeId)).state()).avatar, "zodiac:pisces");
    await assert.rejects(employee.control({ action: "settings", avatar: "blob-" + "1".repeat(32) }), /avatar/);
    assert.equal((await employee.state()).avatar, "zodiac:pisces");
    await updateEmployeeAvatar(employee, { preset: "bot:cloud:teal" });
    assert.equal((await employee.state()).avatar, "bot:cloud:teal");
    await assert.rejects(updateEmployeeAvatar(employee, { preset: "bot:cloud:#00ffaa" }));
    assert.equal((await employee.state()).avatar, "bot:cloud:teal");
    await updateEmployeeAvatar(employee, { preset: "" });
    assert.equal((await employee.state()).avatar, "");
    await assert.rejects(async () => await root.create({ name: "Bad", avatar: "https://tracker.example/pixel" }, "owner"), /avatar/);
  } finally { root.close(); await store.close(); }
});

test("new employees automatically get an unused shape/color pair without changing existing avatars", async () => {
  const { store, root } = await fixture();
  try {
    const selected = await root.create({ name: "Selected", avatar: "bot:cloud:teal" }, "owner");
    const legacy = await root.create({ name: "Legacy" }, "owner");
    await (await root.for(legacy.id)).update((state) => { state.avatar = ""; });
    const before = await Promise.all((await root.all()).map(async (employee) => await employee.state()));
    const used = new Set(before.map((state) => {
      const bot = parseBotAvatar(state.avatar) || defaultBotAvatar(state.id);
      return botAvatarPreset(bot.shape, bot.color);
    }));
    const created = [];
    while ((await root.all()).length < 50) {
      const state = await root.create({ name: `Automatic ${created.length}`, ...(created.length % 2 ? { avatar: "" } : {}) }, "owner");
      assert(parseBotAvatar(state.avatar), "persist an explicit preset, not a hash-only default");
      assert(!used.has(state.avatar!), state.avatar);
      used.add(state.avatar!);
      created.push(state);
    }
    for (const state of before) assert.equal((await (await root.for(state.id)).state()).avatar, state.avatar);
    const reopened = new Employee(store, root.vault, root.runtime);
    for (const state of created) assert.equal((await (await reopened.for(state.id)).state()).avatar, state.avatar);
    assert.equal((await (await reopened.for(selected.id)).state()).avatar, "bot:cloud:teal");
    await assert.rejects(async () => await root.create({ name: "Full" }, "owner"), /capacity/);
  } finally { root.close(); await store.close(); }
});

test("custom avatar uploads are normalized, metadata-free and stored separately from employee state", async () => {
  const { store, root, employee } = await fixture();
  try {
    const input = await sharp({ create: { width: 300, height: 180, channels: 4, background: "#6699dd" } }).withMetadata({ orientation: 6 }).png().toBuffer();
    const result = await updateEmployeeAvatar(employee, { mime: "image/png", data: input.toString("base64") });
    assert.equal(result.employeeId, employee.employeeId);
    assert.match(result.avatar, /^blob-[a-f\d]{32}$/);
    assert.equal((await employee.state()).avatar, result.avatar);
    const image = (await store.blobData(result.avatar))!;
    assert.equal(image.mime, "image/webp");
    const metadata = await sharp(image.data).metadata();
    assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
    assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
    assert(!JSON.stringify(await employee.state()).includes(input.toString("base64")));
    assert.equal((await root.state()).avatar, undefined, "another employee's avatar is unchanged");
  } finally { root.close(); await store.close(); }
});

test("invalid, oversized and disguised image uploads leave the current avatar and blob store unchanged", async () => {
  const { store, root, employee } = await fixture();
  try {
    const before = (await store.one("SELECT COUNT(*) count FROM blobs") as any).count;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>').toString("base64");
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).jpeg().toBuffer();
    for (const input of [
      { preset: "zodiac:unknown" }, { preset: "javascript:alert(1)" },
      { mime: "image/svg+xml", data: svg }, { mime: "image/png", data: svg },
      { mime: "image/png", data: jpeg.toString("base64") }, { mime: "image/png", data: "not base64!" },
      { mime: "__proto__", data: "YQ==" }, { mime: "image/png", data: "A".repeat(7 * 1024 * 1024 + 1) },
    ]) await assert.rejects(updateEmployeeAvatar(employee, input));
    assert.equal((await employee.state()).avatar, "zodiac:aries");
    assert.equal((await store.one("SELECT COUNT(*) count FROM blobs") as any).count, before);
  } finally { root.close(); await store.close(); }
});

test("a user's chosen avatar color paints their tile and their bubbles, and only known ids are accepted", async () => {
  const store = await Store.open(":memory:");
  try {
    assert.deepEqual(parseAvatarColor("color:blue"), { id: "blue", hex: "#3878fb" });
    for (const value of ["bot:round:red", "color:", "color:unknown", "color:#ff0000", "color:red:blue", "blob-" + "1".repeat(32), "", undefined, null]) assert.equal(parseAvatarColor(value), undefined, String(value));
    // Bright fills keep dark text, deep fills white: the ink is what makes every color readable.
    assert.equal(inkOn("#ffa424"), "#1d1d21");
    assert.equal(inkOn("#30b4f0"), "#1d1d21");
    assert.equal(inkOn("#1d1d21"), "#fff");
    assert.equal(inkOn("#3878fb"), "#fff");
    const luminance = (hex: string) => {
      const full = hex.length === 4 ? "#" + hex.slice(1).replace(/./g, (digit) => digit + digit) : hex;
      const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(full.slice(at, at + 2), 16) / 255)
        .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const color of BOT_AVATAR_COLORS) {
      const { fill, ink } = bubbleTint(color.hex);
      assert(["#1d1d21", "#fff"].includes(ink), color.id);
      const [light, dark] = [luminance(fill), luminance(ink)].sort((a, b) => b - a);
      assert((light + 0.05) / (dark + 0.05) >= 4.5, `${color.id} bubble text is below WCAG AA`);
    }
    assert.equal((await updateUserAvatar(store, "u1", { color: "teal" })).avatar, "color:teal");
    assert.deepEqual(await store.object<{ avatar: string }>("user-avatar", "u1"), { avatar: "color:teal" });
    for (const color of ["#00ff00", "bot:round:red", ""])
      await assert.rejects(updateUserAvatar(store, "u1", { color }), /头像颜色/);
    assert.deepEqual(await store.object<{ avatar: string }>("user-avatar", "u1"), { avatar: "color:teal" }, "a rejected color leaves the current one");
    await updateUserAvatar(store, "u1", { clear: true });
    assert.equal(await store.object("user-avatar", "u1"), undefined);
  } finally {
    await store.close();
  }
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

