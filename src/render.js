/**
 * render.js — Canvas drawing helpers: video frame, 2.5D glasses overlay, debug landmarks.
 *
 * The 2.5D effect works by splitting the glasses image into left/right halves
 * and scaling each half independently based on the estimated yaw angle.
 * When the head turns, the "near" half grows and the "far" half shrinks,
 * producing a convincing perspective cue without a full 3-D transform.
 */

// ─── Glasses PNG anchor constants (ratios relative to image size) ───
// These describe where the lens centres sit in the source PNG.
// Tweak if you swap in your own glasses artwork.
const ANCHOR_LEFT_X = 0.30;   // left lens centre at 30 % of image width
const ANCHOR_RIGHT_X = 0.70;  // right lens centre at 70 %
const ANCHOR_Y = 0.45;        // both lens centres at 45 % of image height

// ─── 2.5D tuning knobs ───
const YAW_WIDTH_FACTOR = 0.40;   // how much yaw affects each half's width
const YAW_HEIGHT_FACTOR = 0.12;  // subtle vertical scaling for perspective

// ─── Image splitting ─────────────────────────────────────────────

/**
 * Pre-split a glasses image into left and right halves on offscreen canvases.
 * Call once per image; reuse the halves every frame.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} img
 * @returns {{ left: HTMLCanvasElement, right: HTMLCanvasElement }}
 */
export function splitGlassesImage(img) {
  const halfW = Math.ceil(img.width / 2);

  const leftCanvas = document.createElement('canvas');
  leftCanvas.width = halfW;
  leftCanvas.height = img.height;
  leftCanvas.getContext('2d').drawImage(
    img, 0, 0, halfW, img.height, 0, 0, halfW, img.height,
  );

  const rightW = img.width - halfW;
  const rightCanvas = document.createElement('canvas');
  rightCanvas.width = rightW;
  rightCanvas.height = img.height;
  rightCanvas.getContext('2d').drawImage(
    img, halfW, 0, rightW, img.height, 0, 0, rightW, img.height,
  );

  return { left: leftCanvas, right: rightCanvas };
}

// ─── Frame drawing ───────────────────────────────────────────────

/**
 * Draw the current video frame to the canvas, filling the entire area.
 */
export function drawVideoFrame(ctx, video, w, h) {
  ctx.drawImage(video, 0, 0, w, h);
}

/**
 * Draw the glasses overlay with a 2.5D split-half perspective warp.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ left: HTMLCanvasElement, right: HTMLCanvasElement }} halves
 * @param {Object}  transform   — output of extractFaceTransform()
 * @param {HTMLImageElement|HTMLCanvasElement} glassesImg — full source image (for dimensions)
 * @param {number}  scaleMultiplier — user-adjustable calibration (0.8 – 1.3)
 * @param {number}  verticalOffset  — user-adjustable pixel shift (-40 – 40)
 */
export function drawGlasses(ctx, halves, transform, glassesImg, scaleMultiplier, verticalOffset) {
  const { center, eyeDistance, roll, yaw } = transform;

  // Distance between the two anchor points in the source image (pixels in the PNG).
  const anchorSpan = (ANCHOR_RIGHT_X - ANCHOR_LEFT_X) * glassesImg.width;

  // Scale so anchor span matches the detected eye distance.
  const baseScale = (eyeDistance / anchorSpan) * scaleMultiplier;

  const glassesW = glassesImg.width * baseScale;
  const glassesH = glassesImg.height * baseScale;
  const halfW = glassesW / 2;

  // Per-half yaw-based scaling
  const lWidthScale = 1 + yaw * YAW_WIDTH_FACTOR;
  const rWidthScale = 1 - yaw * YAW_WIDTH_FACTOR;
  const lHeightScale = 1 + yaw * YAW_HEIGHT_FACTOR;
  const rHeightScale = 1 - yaw * YAW_HEIGHT_FACTOR;

  // Vertical anchor offset: the anchor row sits at ANCHOR_Y of the image.
  // We shift so that row lands on the eye midpoint.
  const anchorOffsetY = (ANCHOR_Y - 0.5) * glassesH;

  ctx.save();
  ctx.translate(center.x, center.y + verticalOffset);
  ctx.rotate(roll);

  // ── Left half (extends from centre to the left) ──
  const lw = halfW * lWidthScale;
  const lh = glassesH * lHeightScale;
  ctx.drawImage(
    halves.left,
    0, 0, halves.left.width, halves.left.height,
    -lw, -lh / 2 + anchorOffsetY, lw, lh,
  );

  // ── Right half (extends from centre to the right) ──
  const rw = halfW * rWidthScale;
  const rh = glassesH * rHeightScale;
  ctx.drawImage(
    halves.right,
    0, 0, halves.right.width, halves.right.height,
    0, -rh / 2 + anchorOffsetY, rw, rh,
  );

  ctx.restore();
}

// ─── Debug landmarks ─────────────────────────────────────────────

/** Highlight keypoint indices considered "important" for glasses placement. */
const KEY_INDICES = [33, 133, 362, 263, 468, 473, 1, 234, 454, 10, 152];

/**
 * Draw all 468/478 face landmarks as small dots, with key landmarks highlighted.
 */
export function drawDebugLandmarks(ctx, keypoints) {
  // All points — small green dots
  ctx.fillStyle = 'rgba(0, 255, 128, 0.45)';
  for (const kp of keypoints) {
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Key points — larger red dots
  ctx.fillStyle = 'rgba(255, 60, 60, 0.9)';
  for (const idx of KEY_INDICES) {
    if (idx < keypoints.length) {
      ctx.beginPath();
      ctx.arc(keypoints[idx].x, keypoints[idx].y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ─── Fallback glasses generator ──────────────────────────────────

/**
 * When the real PNG assets are missing, generate a recognisable glasses shape
 * on an offscreen canvas so the demo is still fully functional.
 *
 * @param {'classic'|'round'|'cateye'} style
 * @param {number} [width=400]
 * @param {number} [height=160]
 * @returns {HTMLCanvasElement}
 */
export function generateFallbackGlasses(style, width = 400, height = 160) {
  const cvs = document.createElement('canvas');
  cvs.width = width;
  cvs.height = height;
  const c = cvs.getContext('2d');

  const cx = width / 2;
  const cy = height * ANCHOR_Y;
  const lensR = height * 0.28;
  const gap = width * 0.04;

  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (style === 'classic') {
    // ── Rectangular wayfarer-style ──
    c.strokeStyle = '#1a1a1a';
    c.lineWidth = 5;

    const lensW = width * 0.22;
    const lensH = height * 0.42;
    const r = 6;

    // Left lens
    roundRect(c, cx - gap / 2 - lensW * 2, cy - lensH, lensW * 2, lensH * 2, r);
    c.stroke();
    c.fillStyle = 'rgba(120, 190, 255, 0.13)';
    roundRect(c, cx - gap / 2 - lensW * 2, cy - lensH, lensW * 2, lensH * 2, r);
    c.fill();

    // Right lens
    roundRect(c, cx + gap / 2, cy - lensH, lensW * 2, lensH * 2, r);
    c.stroke();
    c.fillStyle = 'rgba(120, 190, 255, 0.13)';
    roundRect(c, cx + gap / 2, cy - lensH, lensW * 2, lensH * 2, r);
    c.fill();

    // Bridge
    c.beginPath();
    c.moveTo(cx - gap / 2, cy);
    c.lineTo(cx + gap / 2, cy);
    c.stroke();

    // Temples
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(cx - gap / 2 - lensW * 2, cy);
    c.lineTo(8, cy - 4);
    c.stroke();
    c.beginPath();
    c.moveTo(cx + gap / 2 + lensW * 2, cy);
    c.lineTo(width - 8, cy - 4);
    c.stroke();

  } else if (style === 'round') {
    // ── Round / aviator ──
    c.strokeStyle = '#8B7355';
    c.lineWidth = 3.5;

    const rx = lensR * 1.05;
    const ry = lensR * 1.0;

    // Left lens
    c.beginPath();
    c.ellipse(cx - gap / 2 - rx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(200, 180, 120, 0.10)';
    c.fill();

    // Right lens
    c.beginPath();
    c.ellipse(cx + gap / 2 + rx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(200, 180, 120, 0.10)';
    c.fill();

    // Bridge
    c.beginPath();
    c.moveTo(cx - gap / 2, cy);
    c.quadraticCurveTo(cx, cy - 12, cx + gap / 2, cy);
    c.stroke();

    // Temples
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(cx - gap / 2 - rx * 2, cy);
    c.lineTo(8, cy - 3);
    c.stroke();
    c.beginPath();
    c.moveTo(cx + gap / 2 + rx * 2, cy);
    c.lineTo(width - 8, cy - 3);
    c.stroke();

  } else {
    // ── Cat-eye ──
    c.strokeStyle = '#9B1B30';
    c.lineWidth = 4;

    const lw = width * 0.19;
    const lh = height * 0.30;

    // Left lens
    c.beginPath();
    c.moveTo(cx - gap / 2 - lw * 2, cy + lh * 0.3);
    c.quadraticCurveTo(cx - gap / 2 - lw * 2, cy - lh * 1.5, cx - gap / 2 - lw, cy - lh * 1.2);
    c.quadraticCurveTo(cx - gap / 2 - lw * 0.2, cy - lh * 0.5, cx - gap / 2, cy + lh * 0.1);
    c.quadraticCurveTo(cx - gap / 2 - lw * 0.4, cy + lh * 1.2, cx - gap / 2 - lw, cy + lh * 1.0);
    c.quadraticCurveTo(cx - gap / 2 - lw * 1.8, cy + lh * 0.9, cx - gap / 2 - lw * 2, cy + lh * 0.3);
    c.closePath();
    c.stroke();
    c.fillStyle = 'rgba(220, 100, 120, 0.08)';
    c.fill();

    // Right lens (mirrored)
    c.beginPath();
    c.moveTo(cx + gap / 2 + lw * 2, cy + lh * 0.3);
    c.quadraticCurveTo(cx + gap / 2 + lw * 2, cy - lh * 1.5, cx + gap / 2 + lw, cy - lh * 1.2);
    c.quadraticCurveTo(cx + gap / 2 + lw * 0.2, cy - lh * 0.5, cx + gap / 2, cy + lh * 0.1);
    c.quadraticCurveTo(cx + gap / 2 + lw * 0.4, cy + lh * 1.2, cx + gap / 2 + lw, cy + lh * 1.0);
    c.quadraticCurveTo(cx + gap / 2 + lw * 1.8, cy + lh * 0.9, cx + gap / 2 + lw * 2, cy + lh * 0.3);
    c.closePath();
    c.stroke();
    c.fillStyle = 'rgba(220, 100, 120, 0.08)';
    c.fill();

    // Bridge
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(cx - gap / 2, cy);
    c.lineTo(cx + gap / 2, cy);
    c.stroke();

    // Temples
    c.beginPath();
    c.moveTo(cx - gap / 2 - lw * 2, cy - lh * 0.4);
    c.lineTo(8, cy - lh * 0.6);
    c.stroke();
    c.beginPath();
    c.moveTo(cx + gap / 2 + lw * 2, cy - lh * 0.4);
    c.lineTo(width - 8, cy - lh * 0.6);
    c.stroke();
  }

  return cvs;
}

// ─── Canvas helpers ──────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
