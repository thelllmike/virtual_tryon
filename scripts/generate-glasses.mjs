#!/usr/bin/env node

/**
 * generate-glasses.mjs
 *
 * Generates three placeholder glasses PNG files (with transparency) using
 * only Node.js built-ins (no native canvas dependency).
 *
 * Usage:  node scripts/generate-glasses.mjs
 * Output: public/assets/glasses.png, glasses2.png, glasses3.png
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'assets');

// ─── Tiny PNG encoder (pure JS) ──────────────────────────────────

function makeCRC32Table() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
}

const CRC_TABLE = makeCRC32Table();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);

  const typeAndData = Buffer.alloc(4 + data.length);
  typeAndData.write(type, 0, 4, 'ascii');
  if (data.length) Buffer.from(data).copy(typeAndData, 4);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData));

  return Buffer.concat([len, typeAndData, crcBuf]);
}

function encodePNG(width, height, rgba) {
  // Raw scanlines with filter byte 0 (None) per row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 4);
    raw[rowOff] = 0; // filter: None
    rgba.copy(raw, rowOff + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = deflateSync(raw, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Pixel-level drawing primitives ──────────────────────────────

function createBuffer(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function setPixel(buf, x, y, r, g, b, a) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || x >= buf.w || y < 0 || y >= buf.h) return;
  const i = (y * buf.w + x) * 4;
  // Simple alpha-over compositing
  const srcA = a / 255;
  const dstA = buf.data[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA > 0) {
    buf.data[i + 0] = Math.round((r * srcA + buf.data[i + 0] * dstA * (1 - srcA)) / outA);
    buf.data[i + 1] = Math.round((g * srcA + buf.data[i + 1] * dstA * (1 - srcA)) / outA);
    buf.data[i + 2] = Math.round((b * srcA + buf.data[i + 2] * dstA * (1 - srcA)) / outA);
    buf.data[i + 3] = Math.round(outA * 255);
  }
}

function fillRect(buf, x1, y1, x2, y2, r, g, b, a) {
  for (let y = Math.max(0, Math.round(y1)); y <= Math.min(buf.h - 1, Math.round(y2)); y++)
    for (let x = Math.max(0, Math.round(x1)); x <= Math.min(buf.w - 1, Math.round(x2)); x++)
      setPixel(buf, x, y, r, g, b, a);
}

function drawThickLine(buf, x0, y0, x1, y1, thickness, r, g, b, a) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(Math.ceil(len * 2), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    fillCircle(buf, cx, cy, thickness / 2, r, g, b, a);
  }
}

function fillCircle(buf, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++)
    for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++)
      if (dx * dx + dy * dy <= r2) setPixel(buf, cx + dx, cy + dy, r, g, b, a);
}

function strokeEllipse(buf, cx, cy, rx, ry, thickness, r, g, b, a) {
  const steps = Math.max(Math.ceil(Math.max(rx, ry) * 4), 60);
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const px = cx + rx * Math.cos(angle);
    const py = cy + ry * Math.sin(angle);
    fillCircle(buf, px, py, thickness / 2, r, g, b, a);
  }
}

function fillEllipse(buf, cx, cy, rx, ry, r, g, b, a) {
  for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++)
    for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++)
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1)
        setPixel(buf, cx + dx, cy + dy, r, g, b, a);
}

function strokeRoundRect(buf, x, y, w, h, rad, thickness, r, g, b, a) {
  // Top / bottom
  drawThickLine(buf, x + rad, y, x + w - rad, y, thickness, r, g, b, a);
  drawThickLine(buf, x + rad, y + h, x + w - rad, y + h, thickness, r, g, b, a);
  // Left / right
  drawThickLine(buf, x, y + rad, x, y + h - rad, thickness, r, g, b, a);
  drawThickLine(buf, x + w, y + rad, x + w, y + h - rad, thickness, r, g, b, a);
  // Corners (quarter arcs)
  const corners = [
    [x + rad, y + rad, Math.PI, Math.PI * 1.5],
    [x + w - rad, y + rad, Math.PI * 1.5, Math.PI * 2],
    [x + w - rad, y + h - rad, 0, Math.PI * 0.5],
    [x + rad, y + h - rad, Math.PI * 0.5, Math.PI],
  ];
  for (const [cx, cy, startA, endA] of corners) {
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const angle = startA + ((endA - startA) * i) / steps;
      fillCircle(buf, cx + rad * Math.cos(angle), cy + rad * Math.sin(angle), thickness / 2, r, g, b, a);
    }
  }
}

// ─── Glasses drawing functions ───────────────────────────────────

function drawClassic(buf) {
  const W = buf.w, H = buf.h;
  const cx = W / 2, cy = H * 0.45;
  const lensW = W * 0.20, lensH = H * 0.32;
  const gap = W * 0.035;
  const thick = 4;

  // Left lens frame
  strokeRoundRect(buf, cx - gap / 2 - lensW * 2, cy - lensH, lensW * 2, lensH * 2, 5, thick, 30, 30, 30, 255);
  // Left tint
  fillRect(buf, cx - gap / 2 - lensW * 2 + 3, cy - lensH + 3, cx - gap / 2 - 3, cy + lensH - 3, 120, 190, 255, 30);

  // Right lens frame
  strokeRoundRect(buf, cx + gap / 2, cy - lensH, lensW * 2, lensH * 2, 5, thick, 30, 30, 30, 255);
  // Right tint
  fillRect(buf, cx + gap / 2 + 3, cy - lensH + 3, cx + gap / 2 + lensW * 2 - 3, cy + lensH - 3, 120, 190, 255, 30);

  // Bridge
  drawThickLine(buf, cx - gap / 2, cy, cx + gap / 2, cy, thick, 30, 30, 30, 255);

  // Temples
  drawThickLine(buf, cx - gap / 2 - lensW * 2, cy, 6, cy - 3, thick - 1, 30, 30, 30, 255);
  drawThickLine(buf, cx + gap / 2 + lensW * 2, cy, W - 6, cy - 3, thick - 1, 30, 30, 30, 255);
}

function drawRound(buf) {
  const W = buf.w, H = buf.h;
  const cx = W / 2, cy = H * 0.45;
  const r = H * 0.27;
  const gap = W * 0.04;
  const thick = 3;

  const lCx = cx - gap / 2 - r;
  const rCx = cx + gap / 2 + r;

  // Tinted fill
  fillEllipse(buf, lCx, cy, r - 2, r * 0.95 - 2, 200, 180, 120, 22);
  fillEllipse(buf, rCx, cy, r - 2, r * 0.95 - 2, 200, 180, 120, 22);

  // Stroke
  strokeEllipse(buf, lCx, cy, r, r * 0.95, thick, 139, 115, 85, 255);
  strokeEllipse(buf, rCx, cy, r, r * 0.95, thick, 139, 115, 85, 255);

  // Bridge (slight arc via midpoint)
  drawThickLine(buf, cx - gap / 2, cy, cx, cy - 6, thick, 139, 115, 85, 255);
  drawThickLine(buf, cx, cy - 6, cx + gap / 2, cy, thick, 139, 115, 85, 255);

  // Temples
  drawThickLine(buf, lCx - r, cy, 6, cy - 2, thick - 0.5, 139, 115, 85, 255);
  drawThickLine(buf, rCx + r, cy, W - 6, cy - 2, thick - 0.5, 139, 115, 85, 255);
}

function drawCatEye(buf) {
  const W = buf.w, H = buf.h;
  const cx = W / 2, cy = H * 0.45;
  const lensW = W * 0.18, lensH = H * 0.28;
  const gap = W * 0.035;
  const thick = 3.5;

  const col = [155, 27, 48]; // deep red

  // Cat-eye shape approximated with ellipses + upswept corners
  const lCx = cx - gap / 2 - lensW;
  const rCx = cx + gap / 2 + lensW;

  // Lens fills
  fillEllipse(buf, lCx, cy, lensW, lensH, 220, 100, 120, 15);
  fillEllipse(buf, rCx, cy, lensW, lensH, 220, 100, 120, 15);

  // Lens outlines (ellipse)
  strokeEllipse(buf, lCx, cy, lensW, lensH, thick, ...col, 255);
  strokeEllipse(buf, rCx, cy, lensW, lensH, thick, ...col, 255);

  // Cat-eye upswept flicks (upper outer corners)
  drawThickLine(buf, lCx - lensW, cy - lensH * 0.3, lCx - lensW - 8, cy - lensH * 0.9, thick + 1, ...col, 255);
  drawThickLine(buf, rCx + lensW, cy - lensH * 0.3, rCx + lensW + 8, cy - lensH * 0.9, thick + 1, ...col, 255);

  // Bridge
  drawThickLine(buf, cx - gap / 2, cy, cx + gap / 2, cy, thick, ...col, 255);

  // Temples (angled upward like cat-eye style)
  drawThickLine(buf, lCx - lensW - 8, cy - lensH * 0.9, 6, cy - lensH * 0.6, thick - 0.5, ...col, 255);
  drawThickLine(buf, rCx + lensW + 8, cy - lensH * 0.9, W - 6, cy - lensH * 0.6, thick - 0.5, ...col, 255);
}

// ─── Main ────────────────────────────────────────────────────────

const WIDTH = 400;
const HEIGHT = 160;

const specs = [
  { name: 'glasses.png', draw: drawClassic },
  { name: 'glasses2.png', draw: drawRound },
  { name: 'glasses3.png', draw: drawCatEye },
];

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

for (const { name, draw } of specs) {
  const buf = createBuffer(WIDTH, HEIGHT);
  draw(buf);
  const png = encodePNG(WIDTH, HEIGHT, buf.data);
  const outPath = join(OUT_DIR, name);
  writeFileSync(outPath, png);
  console.log(`  wrote ${outPath}  (${png.length} bytes)`);
}

console.log('\nDone! Glasses assets generated in public/assets/');
