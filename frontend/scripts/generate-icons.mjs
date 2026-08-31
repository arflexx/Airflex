/**
 * generate-icons.mjs
 *
 * Generates the PWA home-screen icons (issue #107) as minimal valid PNGs with
 * no image dependencies: a violet rounded square with a white "A" motif
 * rendered as a triangle + bar, drawn per-pixel.
 *
 * Run: node scripts/generate-icons.mjs
 * Output: public/icons/icon-192.png, public/icons/icon-512.png
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "public", "icons");

// Brand colors from tailwind.config.ts (violet-600)
const BG = [124, 58, 237, 255]; // #7c3aed
const FG = [255, 255, 255, 255]; // white

/** CRC32 table-based implementation (PNG spec). */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is prefixed with filter byte 0 (None)
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y, size);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Rounded-rect mask: 1 inside the rounded square, 0 outside (transparent).
 */
function insideRoundedRect(x, y, size, radiusFrac = 0.18) {
  const r = size * radiusFrac;
  const min = r;
  const max = size - r;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * White "A": a triangle (apex top-center) with a horizontal crossbar, drawn
 * with distance-based anti-aliasing for smooth edges.
 */
function insideLetterA(x, y, size) {
  const u = x / size; // 0..1
  const v = y / size; // 0..1

  // Triangle: apex at (0.5, 0.16), base at y=0.78, half-width at base 0.34
  const apexY = 0.16;
  const baseY = 0.78;
  const halfBase = 0.34;
  const t = (v - apexY) / (baseY - apexY);
  const halfWidth = t * halfBase;

  const inTriangle =
    v >= apexY && v <= baseY && Math.abs(u - 0.5) <= halfWidth;

  // Crossbar: horizontal band spanning the triangle at v ~ 0.52
  const barHalfWidth = 0.26;
  const inBar =
    Math.abs(v - 0.52) <= 0.045 &&
    Math.abs(u - 0.5) <= barHalfWidth;

  // Anti-aliased edge: distance from triangle edge in pixel units
  const distToTriangleEdge = (Math.abs(u - 0.5) - halfWidth) * size;
  const edgeAlpha =
    v >= apexY && v <= baseY
      ? Math.max(0, Math.min(1, 1 + distToTriangleEdge))
      : 0;

  if (inBar) return 1;
  if (inTriangle) return 1 - Math.max(0, Math.min(1, -edgeAlpha));
  return 0;
}

function pixelAt(x, y, size) {
  if (!insideRoundedRect(x + 0.5, y + 0.5, size)) {
    return [0, 0, 0, 0];
  }
  const alpha = insideLetterA(x + 0.5, y + 0.5, size);
  const blend = (bg, fg) => Math.round(bg + (fg - bg) * alpha);
  return [blend(BG[0], FG[0]), blend(BG[1], FG[1]), blend(BG[2], FG[2]), 255];
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [192, 512]) {
  const png = encodePng(size, pixelAt);
  const out = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
