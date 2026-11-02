// Original bot avatar geometry: soft silhouettes drawn procedurally in a 100×100 box,
// with two white oval eyes whose pose (look direction, blink, squint…) can be animated or frozen.
const TAU = Math.PI * 2;
const f = value => Math.round(value * 100) / 100;

/** Closed Catmull-Rom spline through points → smooth cubic Bézier path. */
function smooth(points) {
  const n = points.length, at = i => points[(i + n) % n];
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}
/** Polar outline r(θ) around a center (θ grows clockwise on screen). */
function polar(radius, cx = 50, cy = 50, samples = 96) {
  return smooth(Array.from({ length: samples }, (_, i) => { const t = (i / samples) * TAU; const r = radius(t); return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; }));
}
/** Superellipse |x/a|^n + |y/b|^n = 1, optionally rotated (degrees). */
function superellipse(a, b, n, cx = 50, cy = 50, rotate = 0, samples = 72) {
  const rot = rotate * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
  return smooth(Array.from({ length: samples }, (_, i) => {
    const t = (i / samples) * TAU, ct = Math.cos(t), st = Math.sin(t);
    const x = a * Math.sign(ct) * Math.abs(ct) ** (2 / n), y = b * Math.sign(st) * Math.abs(st) ** (2 / n);
    return [cx + x * c - y * s, cy + x * s + y * c];
  }));
}
/** Polygon with every corner rounded by a quadratic curve of the given radius. */
function rounded(points, radius) {
  const n = points.length, toward = (a, b, distance) => { const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy); const k = Math.min(distance, length / 2) / length; return [a[0] + dx * k, a[1] + dy * k]; };
  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n], point = points[i], next = points[(i + 1) % n];
    const start = toward(point, prev, radius), end = toward(point, next, radius);
    d += `${i ? "L" : "M"}${f(start[0])} ${f(start[1])}Q${f(point[0])} ${f(point[1])} ${f(end[0])} ${f(end[1])}`;
  }
  return d + "Z";
}
const regular = (sides, radius, cx = 50, cy = 50, start = -90) => Array.from({ length: sides }, (_, i) => { const t = (start + (360 / sides) * i) * Math.PI / 180; return [cx + radius * Math.cos(t), cy + radius * Math.sin(t)]; });
/** Clockwise circle sub-path, so overlapping circles union under the nonzero fill rule. */
const circle = (cx, cy, r) => `M${f(cx - r)} ${cy}A${r} ${r} 0 1 1 ${f(cx + r)} ${cy}A${r} ${r} 0 1 1 ${f(cx - r)} ${cy}Z`;

function ghost() {
  const points = [];
  for (let i = 0; i <= 24; i++) { const t = Math.PI + (i / 24) * Math.PI; points.push([50 + 32 * Math.cos(t), 44 + 32 * Math.sin(t)]); }
  for (let y = 52; y < 80; y += 7) points.push([82, y]);
  // Three rounded scallops along the hem.
  for (let i = 0; i <= 36; i++) { const u = i / 36; points.push([82 - u * 64, 76 + 9 * Math.abs(Math.sin(3 * Math.PI * u)) ** 0.8]); }
  for (let y = 76; y > 46; y -= 7) points.push([18, y]);
  return smooth(points);
}
function heart() {
  return smooth(Array.from({ length: 90 }, (_, i) => {
    const t = (i / 90) * TAU;
    return [50 + 2.55 * 16 * Math.sin(t) ** 3, 47 - 2.55 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
  }));
}

// Each shape: outline path plus where the eyes sit (center x/y, half gap between eyes, eye size).
export const BOT_SHAPE_GEOMETRY = {
  round: { d: polar(t => 39 + 1.6 * Math.sin(2 * t + 0.6), 50, 51), eyes: { x: 50, y: 50 } },
  cloud: { center: [50, 56], d: [circle(30, 60, 18), circle(50, 45, 23), circle(71, 59, 18), circle(50, 63, 20)].join(""), eyes: { x: 50, y: 55 } },
  tile: { d: rounded(regular(4, 42, 50, 50, -31), 15), eyes: { x: 50, y: 50 } },
  sparkle: { d: polar(t => 24 + 21 * Math.abs(Math.cos(2 * t)) ** 2.6, 50, 50, 160), eyes: { x: 50, y: 50, gap: 7.5, rx: 4.4, ry: 6.6 }, center: [50, 50], radius: 28 },
  clover: { d: [circle(50, 32, 17), circle(68, 50, 17), circle(50, 68, 17), circle(32, 50, 17), circle(50, 50, 20)].join(""), eyes: { x: 50, y: 50 } },
  chonk: { d: superellipse(42, 31, 2.6, 50, 55), eyes: { x: 50, y: 53, gap: 11 }, center: [50, 55] },
  flower: { d: polar(t => 32 + 8 * Math.cos(6 * t), 50, 50, 144), eyes: { x: 50, y: 50, gap: 8.5 }, center: [50, 50], radius: 30 },
  drop: { center: [53, 55], d: polar(t => 32 + 15 * Math.max(0, Math.cos(t + 2.36)) ** 5, 53, 54, 120), eyes: { x: 52, y: 55 } },
  bean: { d: superellipse(41, 26, 2.3, 50, 52, -12), eyes: { x: 52, y: 51, gap: 10 } },
  triangle: { d: rounded([[22, 14], [90, 50], [22, 86]], 16), eyes: { x: 44, y: 50 }, center: [44, 50], radius: 32 },
  gem: { d: rounded([[17, 24], [83, 24], [85, 56], [50, 89], [15, 56]], 13), eyes: { x: 50, y: 46 }, center: [50, 50] },
  cog: { d: polar(t => 35 + 4.5 * Math.tanh(3 * Math.cos(8 * t)) / Math.tanh(3), 50, 50, 192), eyes: { x: 50, y: 50 } },
  hexagon: { d: rounded(regular(6, 42, 50, 50, 0), 11), eyes: { x: 50, y: 50 } },
  apple: { center: [50, 57], d: polar(t => 36 - 8 * Math.max(0, -Math.sin(t)) ** 14, 50, 56, 120) + "M47.5 10Q50 8 52.5 10L53.5 31Q50 33 46.5 31Z" + "M53 15Q64 6 70 14Q60 22 53 15Z", eyes: { x: 50, y: 58 } },
  star: { center: [50, 55], radius: 30, d: rounded(Array.from({ length: 10 }, (_, i) => { const t = (-90 + 36 * i) * Math.PI / 180, r = i % 2 ? 23 : 45; return [50 + r * Math.cos(t), 54 + r * Math.sin(t)]; }), 7), eyes: { x: 50, y: 55, gap: 7.5, rx: 4.4, ry: 6.6 } },
  heart: { d: heart(), eyes: { x: 50, y: 48 } },
  blob: { d: polar(t => 36 + 4 * Math.sin(2 * t + 1) + 3 * Math.cos(3 * t) + 2 * Math.sin(5 * t + 2), 50, 51, 120), eyes: { x: 50, y: 50 } },
  ghost: { d: ghost(), eyes: { x: 50, y: 48 } },
};
export const DEFAULT_EYES = { gap: 9.5, rx: 5.2, ry: 7.8 };

/**
 * Head poses as 3D rotations, in degrees: yaw > 0 turns toward the viewer's right, pitch > 0 looks up.
 * Variety comes from many turn directions and amplitudes (plus random jitter and blinks), not from
 * 2D expressions: every pose is the same face seen from another angle.
 */
export const BOT_POSES = {
  center: { yaw: 0, pitch: 0 },
  left: { yaw: -30, pitch: 0 }, right: { yaw: 30, pitch: 0 },
  slightLeft: { yaw: -16, pitch: 4 }, slightRight: { yaw: 16, pitch: 4 },
  up: { yaw: 0, pitch: 24 }, down: { yaw: 0, pitch: -20 },
  upLeft: { yaw: -26, pitch: 20 }, upRight: { yaw: 26, pitch: 18 },
  downLeft: { yaw: -26, pitch: -16 }, downRight: { yaw: 26, pitch: -16 },
  farLeft: { yaw: -36, pitch: 6 }, farRight: { yaw: 36, pitch: 6 },
  lowLeft: { yaw: -14, pitch: -22 }, lowRight: { yaw: 14, pitch: -22 },
  highLeft: { yaw: -12, pitch: 26 }, highRight: { yaw: 12, pitch: 26 },
};
/** Poses the typing animation glances between. */
export const LOOK_POSES = Object.keys(BOT_POSES);
/** Message avatars all rest on one pose: head turned up-right, toward the sender name and the bubble. */
export const MESSAGE_POSE = "upRight";

const RAD = Math.PI / 180, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Mix a #rrggbb color toward white (amount > 0) or black (amount < 0). */
export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16), t = amount < 0 ? 0 : 255, k = Math.abs(amount);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (t - v) * k));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Project the face for a head rotation. The body is treated as a sphere of radius R behind the silhouette:
 * eyes are disks on its surface, rotated by yaw/pitch and drawn with mild perspective, so the eye on the side
 * turning away slides toward the other, narrows and shrinks, the near eye grows, and vertical turns
 * foreshorten the eyes vertically. The facing point drives the body shading and highlight.
 * `lid` is 1 for open eyes and ~0 for closed (blink).
 */
export function projectFace(geometry, yaw = 0, pitch = 0, lid = 1) {
  const e = { ...DEFAULT_EYES, ...geometry.eyes };
  const [cx, cy] = geometry.center || [e.x, 51], R = geometry.radius || 38, F = 120;
  const Y = yaw * RAD, P = pitch * RAD, cY = Math.cos(Y), sY = Math.sin(Y), cP = Math.cos(P), sP = Math.sin(P);
  const point = (lx, ly) => {
    const a = Math.asin(clamp(lx / R, -0.95, 0.95)), b = Math.asin(clamp(ly / R, -0.95, 0.95));
    let x = R * Math.sin(a) * Math.cos(b), y = R * Math.sin(b), z = R * Math.cos(a) * Math.cos(b);
    [x, z] = [x * cY + z * sY, -x * sY + z * cY];
    [y, z] = [y * cP - z * sP, y * sP + z * cP];
    // perspective relative to where the eye sits when facing front: the near eye comes forward and grows
    const s = F / (F - (z - R * Math.cos(a) * Math.cos(b)));
    return { x: cx + x * s, y: cy + y * s, nx: x / R, ny: y / R, nz: z / R, s };
  };
  const eye = (side) => {
    const p = point(side * e.gap + (e.x - cx), e.y - cy);
    // exaggerate the near/far size difference a little so it reads at 40px
    p.s *= 1 - 0.2 * side * sY;
    const ry = e.ry * p.s * Math.sqrt(Math.max(0.02, 1 - p.ny * p.ny));
    return {
      cx: p.x, cy: p.y + ry * (1 - lid) * 0.45,
      rx: e.rx * p.s * Math.sqrt(Math.max(0.02, 1 - p.nx * p.nx)),
      ry: Math.max(0.35, ry * lid),
      opacity: clamp((p.nz - 0.12) / 0.22, 0, 1),
    };
  };
  const facing = point(0, 0);
  return {
    left: eye(-1), right: eye(1),
    // where the head faces: lightest there, darker rim on the side turning away
    light: { x: facing.x - 9, y: facing.y - 11 },
    highlight: { x: cx - 13 + (facing.x - cx) * 0.45, y: cy - 17 + (facing.y - cy) * 0.4 },
    // the silhouette barely changes for a round body, but a little parallax and narrowing sells the turn
    body: `translate(${(sY * 3.2).toFixed(2)} ${(-sP * 2.6).toFixed(2)}) translate(${cx} ${cy}) scale(${(1 - 0.06 * Math.abs(sY)).toFixed(3)} ${(1 - 0.05 * Math.abs(sP)).toFixed(3)}) rotate(${(yaw * 0.06).toFixed(2)}) translate(${-cx} ${-cy})`,
    shadow: { x: cx + sY * 2, rx: 27 * (1 - 0.18 * Math.max(0, sP)), opacity: 1 - 0.3 * Math.max(0, sP) },
  };
}

/**
 * Next head turn for the typing animation, chosen at random. Never repeats the current pose, and avoids
 * bouncing straight back to the previous one, so no two typing bursts play the same sequence.
 */
export function nextPose(current, previous, random = Math.random) {
  if (current !== "center" && previous !== "center" && random() < 0.08) return "center";
  const options = LOOK_POSES.filter(id => id !== current && id !== previous);
  return options[Math.floor(random() * options.length)];
}
/** How long to hold a turn: mostly short glances, sometimes a longer look. */
export function holdDuration(random = Math.random) {
  return random() < 0.2 ? 1000 + random() * 900 : 380 + random() * 620;
}
/** When the next blink starts, and whether it is a double blink (about one in four). */
export function blinkPlan(random = Math.random) {
  return { delay: 700 + random() * 2600, double: random() < 0.25 };
}
