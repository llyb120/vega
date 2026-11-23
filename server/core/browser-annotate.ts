// Fast JPEG screenshot pipeline & crisp host-side Set-of-Mark ([1], [2]...) renderer.
// Badges are drawn ONLY on the screenshot copy sent to the model — the live webpage stays clean
// with just the sleek animated virtual mouse cursor.
import sharp from "sharp";

const IMAGE_MAX_EDGE = 1568;
const IMAGE_MAX_PIXELS = 1_150_000;

export function visionScale(w: number, h: number): number {
  return Math.min(IMAGE_MAX_EDGE / Math.max(1, w, h), Math.sqrt(IMAGE_MAX_PIXELS / Math.max(1, w * h)));
}

export type SomBox = {
  id: number;
  rect: [number, number, number, number]; // [x, y, width, height] in CSS pixels
};

export class ShotMapping {
  constructor(
    public pixelWidth: number,
    public pixelHeight: number,
    public cssX: number,
    public cssY: number,
    public cssWidth: number,
    public cssHeight: number,
  ) {}

  /** Convert a model-supplied screenshot pixel coordinate (px, py) to CSS viewport (x, y). */
  imageToCss(px: number, py: number): [number, number] {
    if (
      !Number.isFinite(px) || !Number.isFinite(py)
      || px < 0 || py < 0 || px > this.pixelWidth || py > this.pixelHeight
    ) {
      throw Error(`坐标 (${Math.round(px)}, ${Math.round(py)}) 超出当前截图范围 ${this.pixelWidth}x${this.pixelHeight}`);
    }
    const x = this.cssX + (px * this.cssWidth) / Math.max(1, this.pixelWidth);
    const y = this.cssY + (py * this.cssHeight) / Math.max(1, this.pixelHeight);
    return [x, y];
  }

  /** Convert a CSS viewport coordinate (cx, cy) to screenshot pixel coordinate (px, py). */
  cssToImage(cx: number, cy: number): [number, number] {
    const px = Math.round(((cx - this.cssX) * this.pixelWidth) / Math.max(1, this.cssWidth));
    const py = Math.round(((cy - this.cssY) * this.pixelHeight) / Math.max(1, this.cssHeight));
    return [
      Math.max(0, Math.min(this.pixelWidth, px)),
      Math.max(0, Math.min(this.pixelHeight, py)),
    ];
  }
}

export async function processScreenshot(options: {
  jpegBase64: string;
  cssViewport: [number, number];
  cropCss?: [number, number, number, number] | null;
  boxes: SomBox[];
  drawSom: boolean;
}): Promise<{ buffer: Buffer; mapping: ShotMapping; mime: "image/jpeg" }> {
  const raw = Buffer.from(options.jpegBase64, "base64");
  const vw = Math.max(1, options.cssViewport[0]);
  const vh = Math.max(1, options.cssViewport[1]);
  const crop = options.cropCss || null;

  const meta = await sharp(raw, { limitInputPixels: 64_000_000 }).metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!srcW || !srcH) throw Error("截图尺寸为空");

  // Zero-reencode fast path: no crop, no SoM badges, JPEG already within model vision cap.
  if (!crop && (!options.drawSom || options.boxes.length === 0) && meta.format === "jpeg" && visionScale(srcW, srcH) >= 1) {
    return {
      buffer: raw,
      mapping: new ShotMapping(srcW, srcH, 0, 0, vw, vh),
      mime: "image/jpeg",
    };
  }

  let cssX = 0, cssY = 0, cssW = vw, cssH = vh;
  let pipeline = sharp(raw, { limitInputPixels: 64_000_000 });
  let curW = srcW, curH = srcH;

  if (crop) {
    const [cx, cy, cw, ch] = crop;
    const x0 = Math.max(0, Math.min(vw, cx));
    const y0 = Math.max(0, Math.min(vh, cy));
    const x1 = Math.max(0, Math.min(vw, cx + cw));
    const y1 = Math.max(0, Math.min(vh, cy + ch));
    if (x1 <= x0 + 1 || y1 <= y0 + 1) throw Error("局部放大区域超出当前视口");
    cssX = x0; cssY = y0; cssW = x1 - x0; cssH = y1 - y0;

    const sx = srcW / vw;
    const sy = srcH / vh;
    const left = Math.max(0, Math.min(srcW - 1, Math.round(cssX * sx)));
    const top = Math.max(0, Math.min(srcH - 1, Math.round(cssY * sy)));
    const right = Math.max(left + 1, Math.min(srcW, Math.round((cssX + cssW) * sx)));
    const bottom = Math.max(top + 1, Math.min(srcH, Math.round((cssY + cssH) * sy)));
    curW = right - left;
    curH = bottom - top;
    pipeline = pipeline.extract({ left, top, width: curW, height: curH });
  }

  const scale = visionScale(curW, curH);
  if (scale < 1) {
    const nw = Math.max(1, Math.round(curW * scale));
    const nh = Math.max(1, Math.round(curH * scale));
    pipeline = pipeline.resize(nw, nh, { fit: "fill", kernel: "cubic" });
  }

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (options.drawSom && options.boxes.length > 0) {
    drawSomRaw(data, info.width, info.height, options.boxes, [cssX, cssY, cssW, cssH]);
  }

  const encoded = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .removeAlpha()
    .jpeg({ quality: 82 })
    .toBuffer();

  return {
    buffer: encoded,
    mapping: new ShotMapping(info.width, info.height, cssX, cssY, cssW, cssH),
    mime: "image/jpeg",
  };
}

/** Crisp 6x9 bold bitmap font for digits '0'..'9' (readable even after JPEG q82 compression). */
const GLYPH_W = 6;
const GLYPH_H = 9;
const DIGITS: number[][] = [
  [0b011110, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110], // 0
  [0b001100, 0b011100, 0b111100, 0b001100, 0b001100, 0b001100, 0b001100, 0b001100, 0b111111], // 1
  [0b011110, 0b110011, 0b000011, 0b000110, 0b001100, 0b011000, 0b110000, 0b110011, 0b111111], // 2
  [0b011110, 0b110011, 0b000011, 0b001110, 0b000011, 0b000011, 0b000011, 0b110011, 0b011110], // 3
  [0b000110, 0b001110, 0b011110, 0b110110, 0b110110, 0b111111, 0b000110, 0b000110, 0b000110], // 4
  [0b111111, 0b110000, 0b110000, 0b111110, 0b000011, 0b000011, 0b000011, 0b110011, 0b011110], // 5
  [0b011110, 0b110011, 0b110000, 0b111110, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110], // 6
  [0b111111, 0b110011, 0b000011, 0b000110, 0b001100, 0b001100, 0b011000, 0b011000, 0b011000], // 7
  [0b011110, 0b110011, 0b110011, 0b011110, 0b110011, 0b110011, 0b110011, 0b110011, 0b011110], // 8
  [0b011110, 0b110011, 0b110011, 0b110011, 0b011111, 0b000011, 0b000011, 0b110011, 0b011110], // 9
];

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function blendPx(rgba: Uint8Array, w: number, h: number, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
  const off = (y * w + x) * 4;
  if (a >= 255) {
    rgba[off] = r; rgba[off + 1] = g; rgba[off + 2] = b; rgba[off + 3] = 255;
    return;
  }
  const inv = 255 - a;
  rgba[off] = (r * a + rgba[off] * inv) / 255;
  rgba[off + 1] = (g * a + rgba[off + 1] * inv) / 255;
  rgba[off + 2] = (b * a + rgba[off + 2] * inv) / 255;
  rgba[off + 3] = 255;
}

function drawRectOutline(rgba: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  for (let x = x0; x <= x1; x++) {
    blendPx(rgba, w, h, x, y0, 79, 70, 229, 96);
    blendPx(rgba, w, h, x, y1, 79, 70, 229, 96);
  }
  for (let y = y0 + 1; y < y1; y++) {
    blendPx(rgba, w, h, x0, y, 79, 70, 229, 96);
    blendPx(rgba, w, h, x1, y, 79, 70, 229, 96);
  }
}

function drawPillBadge(rgba: Uint8Array, imgW: number, imgH: number, x: number, y: number, pw: number, ph: number, label: string) {
  for (let dy = 0; dy < ph; dy++) {
    for (let dx = 0; dx < pw; dx++) {
      if ((dx === 0 || dx === pw - 1) && (dy === 0 || dy === ph - 1)) continue;
      const isBorder = dx === 0 || dx === pw - 1 || dy === 0 || dy === ph - 1
        || ((dx === 1 || dx === pw - 2) && (dy === 1 || dy === ph - 2));
      if (isBorder) blendPx(rgba, imgW, imgH, x + dx, y + dy, 255, 255, 255, 245);
      else blendPx(rgba, imgW, imgH, x + dx, y + dy, 30, 41, 59, 232);
    }
  }
  let cursorX = x + 3;
  const cursorY = y + 2;
  for (let i = 0; i < label.length; i++) {
    const d = label.charCodeAt(i) - 48;
    const glyph = DIGITS[d];
    if (!glyph) continue;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < GLYPH_W; col++) {
        if ((bits >> (GLYPH_W - 1 - col)) & 1) {
          blendPx(rgba, imgW, imgH, cursorX + col, cursorY + row, 255, 255, 255, 255);
        }
      }
    }
    cursorX += GLYPH_W + 1;
  }
}

function overlaps(placed: [number, number, number, number][], x: number, y: number, w: number, h: number) {
  const x1 = x + w, y1 = y + h;
  return placed.some(([ax0, ay0, ax1, ay1]) => x < ax1 && x1 > ax0 && y < ay1 && y1 > ay0);
}

/** Draw subtle 1px outlines + collision-avoiding `[id]` pill badges onto a tightly-packed RGBA buffer. */
export function drawSomRaw(
  rgba: Uint8Array,
  width: number,
  height: number,
  boxes: SomBox[],
  cssView: [number, number, number, number],
): void {
  if (!boxes.length || !width || !height) return;
  const [vx, vy, vw, vh] = cssView;
  const sx = width / Math.max(1, vw);
  const sy = height / Math.max(1, vh);
  const mapped: [number, number, number, number, number][] = [];

  for (const b of boxes) {
    const x0 = clampInt(Math.round((b.rect[0] - vx) * sx), 0, width - 1);
    const y0 = clampInt(Math.round((b.rect[1] - vy) * sy), 0, height - 1);
    const x1 = clampInt(Math.round((b.rect[0] + b.rect[2] - vx) * sx), 0, width - 1);
    const y1 = clampInt(Math.round((b.rect[1] + b.rect[3] - vy) * sy), 0, height - 1);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    drawRectOutline(rgba, width, height, x0, y0, x1, y1);
    mapped.push([b.id, x0, y0, x1, y1]);
  }

  const placed: [number, number, number, number][] = [];
  for (const [idNum, x0, y0, x1, y1] of mapped) {
    const label = String(idNum);
    const pw = label.length * (GLYPH_W + 1) - 1 + 6;
    const ph = GLYPH_H + 4;
    const maxX = Math.max(0, width - pw);
    const maxY = Math.max(0, height - ph);

    const candidates: [number, number][] = [
      [x0 - 1, y0 - ph + 1],
      [x0, y0],
      [x1 - pw + 1, y0 - ph + 1],
      [x0 - 1, y1],
      [x1 - pw, y0],
    ];
    let chosen: [number, number] = [clampInt(x0, 0, maxX), clampInt(y0 - ph + 1, 0, maxY)];
    let found = false;
    for (const [cx, cy] of candidates) {
      const bx = clampInt(cx, 0, maxX);
      const by = clampInt(cy, 0, maxY);
      if (!overlaps(placed, bx, by, pw, ph)) {
        chosen = [bx, by];
        found = true;
        break;
      }
    }
    if (!found && overlaps(placed, chosen[0], chosen[1], pw, ph)) {
      for (const [dx, dy] of [[pw + 1, 0], [0, ph + 1], [-(pw + 1), 0], [0, -(ph + 1)]]) {
        const bx = clampInt(chosen[0] + dx, 0, maxX);
        const by = clampInt(chosen[1] + dy, 0, maxY);
        if (!overlaps(placed, bx, by, pw, ph)) {
          chosen = [bx, by];
          break;
        }
      }
    }
    placed.push([chosen[0], chosen[1], chosen[0] + pw, chosen[1] + ph]);
    drawPillBadge(rgba, width, height, chosen[0], chosen[1], pw, ph, label);
  }
}
