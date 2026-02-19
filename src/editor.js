/**
 * editor.js — Spectacle Background Removal & Try-On Image Editor
 *
 * Features:
 *  - AI background removal  (@imgly/background-removal, runs in-browser via WASM)
 *  - Eraser brush           (make pixels transparent with a soft circle)
 *  - Restore brush          (paint back pixels from the original image)
 *  - Magic eraser           (flood-fill erase by colour similarity)
 *  - Undo / redo            (Ctrl+Z / Ctrl+Y, up to 30 states)
 *  - Zoom & pan             (scroll-wheel zoom, Alt+drag pan)
 *  - Auto-crop              (trim transparent edges + 5 % padding)
 *  - Export PNG             (fit into user-specified dimensions, centred)
 */

import { removeBackground } from '@imgly/background-removal';

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

// Off-screen canvas at full image resolution — this is where edits are stored.
const workCanvas = document.createElement('canvas');
const workCtx    = workCanvas.getContext('2d', { willReadFrequently: true });

// A copy of the image as it was right after upload (never modified).
// Used by the Restore brush to bring back erased pixels.
let originalImageData = null;

// Undo / redo ring
const history     = [];
let   histIndex   = -1;
const MAX_HISTORY = 30;

// Tool state
const tool = {
  active:         'eraser', // 'eraser' | 'restore' | 'magic'
  size:           20,
  magicTolerance: 32,
  isDrawing:      false,
  lastX:          0,
  lastY:          0,
};

// View state (zoom + pan applied to the display canvas)
const view = {
  scale:      1,
  minScale:   0.05,
  maxScale:   12,
  panX:       0,
  panY:       0,
  isPanning:  false,
  panStartX:  0,
  panStartY:  0,
};

let imageLoaded = false;

// ═══════════════════════════════════════════════════════════════════
// DOM references
// ═══════════════════════════════════════════════════════════════════

const uploadZone    = document.getElementById('upload-zone');
const fileInput     = document.getElementById('file-input');
const btnAutoRemove = document.getElementById('btn-auto-remove');
const btnUndo       = document.getElementById('btn-undo');
const btnRedo       = document.getElementById('btn-redo');
const btnFit        = document.getElementById('btn-fit');
const btnZoomIn     = document.getElementById('btn-zoom-in');
const btnZoomOut    = document.getElementById('btn-zoom-out');
const zoomLabel     = document.getElementById('zoom-label');

const toolBtns       = document.querySelectorAll('[data-tool]');
const brushSizeInput = document.getElementById('brush-size');
const brushLabel     = document.getElementById('brush-label');
const magicTolInput  = document.getElementById('magic-tolerance');
const tolLabel       = document.getElementById('tolerance-label');
const magicPanel     = document.getElementById('magic-panel');

const progressWrap = document.getElementById('progress-wrap');
const progressBar  = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

const exportWInput   = document.getElementById('export-w');
const exportHInput   = document.getElementById('export-h');
const downloadName   = document.getElementById('download-name');
const btnAutoCrop    = document.getElementById('btn-auto-crop');
const btnDownload    = document.getElementById('btn-download');

const emptyState  = document.getElementById('empty-state');
const editorWrap  = document.getElementById('editor-wrap');
const editorCanvas = document.getElementById('editor-canvas');
const editorCtx   = editorCanvas.getContext('2d');
const cursorRing  = document.getElementById('cursor-ring');

// ═══════════════════════════════════════════════════════════════════
// Display rendering
// ═══════════════════════════════════════════════════════════════════

/** Draw the current work canvas onto the display canvas with zoom/pan. */
function redraw() {
  if (!imageLoaded) return;

  // Fill display canvas to container size
  const cw = editorWrap.clientWidth;
  const ch = editorWrap.clientHeight;
  if (editorCanvas.width !== cw || editorCanvas.height !== ch) {
    editorCanvas.width  = cw;
    editorCanvas.height = ch;
  }

  // Checkerboard (full display canvas)
  const sq = 14;
  for (let y = 0; y < ch; y += sq) {
    for (let x = 0; x < cw; x += sq) {
      editorCtx.fillStyle = ((x / sq + y / sq) % 2 === 0) ? '#c0c0c0' : '#ebebeb';
      editorCtx.fillRect(x, y, sq, sq);
    }
  }

  // Work canvas with transform (pan + zoom, origin at display centre)
  editorCtx.save();
  editorCtx.translate(view.panX + cw / 2, view.panY + ch / 2);
  editorCtx.scale(view.scale, view.scale);
  editorCtx.drawImage(workCanvas, -workCanvas.width / 2, -workCanvas.height / 2);
  editorCtx.restore();

  // Thin border around the image
  const iw = workCanvas.width  * view.scale;
  const ih = workCanvas.height * view.scale;
  const ix = view.panX + cw / 2 - iw / 2;
  const iy = view.panY + ch / 2 - ih / 2;
  editorCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  editorCtx.lineWidth   = 1;
  editorCtx.strokeRect(ix, iy, iw, ih);

  // Update zoom badge
  if (zoomLabel) zoomLabel.textContent = Math.round(view.scale * 100) + '%';
}

// ═══════════════════════════════════════════════════════════════════
// Image loading
// ═══════════════════════════════════════════════════════════════════

async function loadImageFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Please upload an image file (JPG, PNG, WEBP…).');
    return;
  }

  const bitmap = await createImageBitmap(file);
  workCanvas.width  = bitmap.width;
  workCanvas.height = bitmap.height;
  workCtx.clearRect(0, 0, bitmap.width, bitmap.height);
  workCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Keep an untouched copy for the Restore brush
  originalImageData = workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height);

  // Reset history
  history.length = 0;
  histIndex = -1;
  saveHistory();

  imageLoaded = true;
  emptyState.style.display = 'none';
  editorWrap.style.display = 'block';

  fitToView();
  updateButtons();
}

// ═══════════════════════════════════════════════════════════════════
// AI background removal
// ═══════════════════════════════════════════════════════════════════

async function autoRemoveBg() {
  if (!imageLoaded) return;
  btnAutoRemove.disabled = true;
  showProgress(0, 'Preparing…');

  try {
    // Snapshot current work canvas as a PNG blob
    const blob = await canvasToBlob(workCanvas);

    const result = await removeBackground(blob, {
      progress: (key, current, total) => {
        const pct   = total > 0 ? Math.round((current / total) * 100) : 0;
        const label = key.includes('fetch')
          ? `Downloading AI model… ${pct}%`
          : key.includes('compute')
          ? `Removing background… ${pct}%`
          : `Processing… ${pct}%`;
        showProgress(pct, label);
      },
    });

    const bitmap = await createImageBitmap(result);
    workCtx.clearRect(0, 0, workCanvas.width, workCanvas.height);
    workCtx.drawImage(bitmap, 0, 0);
    bitmap.close();

    saveHistory();
    redraw();
    hideProgress();
  } catch (err) {
    console.error('[bg-remove]', err);
    hideProgress();
    alert('Background removal failed.\n\n' + err.message + '\n\nTry a different image or browser (Chrome recommended).');
  } finally {
    btnAutoRemove.disabled = false;
  }
}

function showProgress(pct, label) {
  progressWrap.style.display = 'flex';
  progressBar.style.width    = pct + '%';
  progressText.textContent   = label || pct + '%';
}

function hideProgress() {
  progressWrap.style.display = 'none';
}

function canvasToBlob(cvs) {
  return new Promise((res) => cvs.toBlob(res, 'image/png'));
}

// ═══════════════════════════════════════════════════════════════════
// Coordinate mapping  (display canvas → work canvas pixels)
// ═══════════════════════════════════════════════════════════════════

function displayToWork(dx, dy) {
  const cx = editorCanvas.width  / 2;
  const cy = editorCanvas.height / 2;
  return {
    x: (dx - cx - view.panX) / view.scale + workCanvas.width  / 2,
    y: (dy - cy - view.panY) / view.scale + workCanvas.height / 2,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Brush tools
// ═══════════════════════════════════════════════════════════════════

function applyBrush(dx, dy) {
  const { x, y } = displayToWork(dx, dy);
  // Brush radius is in work-canvas pixels, scaled inverse to zoom
  const r = (tool.size / 2) / view.scale;

  if (tool.active === 'eraser') {
    eraseCircle(x, y, r);
  } else if (tool.active === 'restore') {
    restoreCircle(x, y, r);
  }

  redraw();
}

function eraseCircle(cx, cy, r) {
  const x0 = Math.max(0,                   Math.floor(cx - r));
  const y0 = Math.max(0,                   Math.floor(cy - r));
  const x1 = Math.min(workCanvas.width  - 1, Math.ceil(cx + r));
  const y1 = Math.min(workCanvas.height - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;

  const imgData = workCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const w = imgData.width;
  const r2 = r * r;

  for (let iy = 0; iy < imgData.height; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const dx = (x0 + ix) - cx;
      const dy = (y0 + iy) - cy;
      if (dx * dx + dy * dy <= r2) {
        imgData.data[(iy * w + ix) * 4 + 3] = 0;
      }
    }
  }
  workCtx.putImageData(imgData, x0, y0);
}

function restoreCircle(cx, cy, r) {
  if (!originalImageData) return;
  const x0 = Math.max(0,                   Math.floor(cx - r));
  const y0 = Math.max(0,                   Math.floor(cy - r));
  const x1 = Math.min(workCanvas.width  - 1, Math.ceil(cx + r));
  const y1 = Math.min(workCanvas.height - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;

  const imgData = workCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const w  = imgData.width;
  const sw = originalImageData.width;
  const r2 = r * r;

  for (let iy = 0; iy < imgData.height; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const dx = (x0 + ix) - cx;
      const dy = (y0 + iy) - cy;
      if (dx * dx + dy * dy <= r2) {
        const si = ((y0 + iy) * sw + (x0 + ix)) * 4;
        const di = (iy * w + ix) * 4;
        imgData.data[di]     = originalImageData.data[si];
        imgData.data[di + 1] = originalImageData.data[si + 1];
        imgData.data[di + 2] = originalImageData.data[si + 2];
        imgData.data[di + 3] = originalImageData.data[si + 3];
      }
    }
  }
  workCtx.putImageData(imgData, x0, y0);
}

// ═══════════════════════════════════════════════════════════════════
// Magic eraser — BFS flood-fill by colour similarity
// ═══════════════════════════════════════════════════════════════════

function magicErase(dx, dy) {
  const { x, y } = displayToWork(dx, dy);
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px >= workCanvas.width || py < 0 || py >= workCanvas.height) return;

  const W   = workCanvas.width;
  const H   = workCanvas.height;
  const all = workCtx.getImageData(0, 0, W, H);
  const d   = all.data;
  const tol = tool.magicTolerance;

  const startI = (py * W + px) * 4;
  if (d[startI + 3] < 8) return; // clicked on already-transparent area

  const sR = d[startI], sG = d[startI + 1], sB = d[startI + 2];

  const visited = new Uint8Array(W * H);
  const queue   = [py * W + px];
  visited[py * W + px] = 1;

  while (queue.length > 0) {
    const idx = queue.shift();
    d[idx * 4 + 3] = 0; // erase

    const qx = idx % W;
    const qy = (idx - qx) / W;

    // 4-connected neighbours
    const nb = [
      qx - 1 >= 0 ? idx - 1   : -1,
      qx + 1 <  W ? idx + 1   : -1,
      qy - 1 >= 0 ? idx - W   : -1,
      qy + 1 <  H ? idx + W   : -1,
    ];

    for (const ni of nb) {
      if (ni < 0 || visited[ni]) continue;
      visited[ni] = 1;
      const di = ni * 4;
      if (d[di + 3] < 8) continue; // already transparent
      const diff = (Math.abs(d[di] - sR) + Math.abs(d[di + 1] - sG) + Math.abs(d[di + 2] - sB)) / 3;
      if (diff <= tol) queue.push(ni);
    }
  }

  workCtx.putImageData(all, 0, 0);
  saveHistory();
  redraw();
}

// ═══════════════════════════════════════════════════════════════════
// History  (undo / redo)
// ═══════════════════════════════════════════════════════════════════

function saveHistory() {
  // Drop any forward states
  history.splice(histIndex + 1);
  history.push(workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height));
  if (history.length > MAX_HISTORY) history.shift();
  histIndex = history.length - 1;
  updateButtons();
}

function undo() {
  if (histIndex <= 0) return;
  histIndex--;
  workCtx.putImageData(history[histIndex], 0, 0);
  redraw();
  updateButtons();
}

function redo() {
  if (histIndex >= history.length - 1) return;
  histIndex++;
  workCtx.putImageData(history[histIndex], 0, 0);
  redraw();
  updateButtons();
}

// ═══════════════════════════════════════════════════════════════════
// Zoom & pan
// ═══════════════════════════════════════════════════════════════════

function fitToView() {
  if (!imageLoaded) return;
  const cw = editorWrap.clientWidth;
  const ch = editorWrap.clientHeight;
  view.scale = Math.min((cw * 0.9) / workCanvas.width, (ch * 0.9) / workCanvas.height, 1);
  view.panX  = 0;
  view.panY  = 0;
  redraw();
}

/** Zoom toward/away from a pivot point on the display canvas. */
function zoom(factor, pivotX, pivotY) {
  const newScale = Math.min(view.maxScale, Math.max(view.minScale, view.scale * factor));
  const ratio    = newScale / view.scale;

  const cx = editorCanvas.width  / 2;
  const cy = editorCanvas.height / 2;

  if (pivotX !== undefined) {
    view.panX = (view.panX + cx - pivotX) * ratio + pivotX - cx;
    view.panY = (view.panY + cy - pivotY) * ratio + pivotY - cy;
  } else {
    view.panX *= ratio;
    view.panY *= ratio;
  }

  view.scale = newScale;
  redraw();
}

// ═══════════════════════════════════════════════════════════════════
// Auto-crop
// ═══════════════════════════════════════════════════════════════════

function getContentBounds() {
  const imgData = workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height);
  const d = imgData.data;
  const W = workCanvas.width;
  const H = workCanvas.height;
  let minX = W, minY = H, maxX = 0, maxY = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function autoCrop() {
  const b = getContentBounds();
  if (!b) { alert('The image appears fully transparent — nothing to crop.'); return; }

  // 5 % padding
  const pad = Math.ceil(Math.max(b.w, b.h) * 0.05);
  const x   = Math.max(0, b.x - pad);
  const y   = Math.max(0, b.y - pad);
  const w   = Math.min(workCanvas.width  - x, b.w + pad * 2);
  const h   = Math.min(workCanvas.height - y, b.h + pad * 2);

  const cropped = workCtx.getImageData(x, y, w, h);
  workCanvas.width  = w;
  workCanvas.height = h;
  workCtx.putImageData(cropped, 0, 0);

  // Original image data is now invalid after crop
  originalImageData = null;

  saveHistory();
  fitToView();
}

// ═══════════════════════════════════════════════════════════════════
// Export / download
// ═══════════════════════════════════════════════════════════════════

function downloadResult() {
  if (!imageLoaded) return;

  const targetW = Math.max(1, parseInt(exportWInput.value) || 800);
  const targetH = Math.max(1, parseInt(exportHInput.value) || 300);

  const out    = document.createElement('canvas');
  out.width    = targetW;
  out.height   = targetH;
  const outCtx = out.getContext('2d');

  // Fit glasses image inside the target size, centred, preserving aspect ratio
  const scale = Math.min(targetW / workCanvas.width, targetH / workCanvas.height);
  const dw = workCanvas.width  * scale;
  const dh = workCanvas.height * scale;
  const dx = (targetW - dw) / 2;
  const dy = (targetH - dh) / 2;

  outCtx.clearRect(0, 0, targetW, targetH);
  outCtx.drawImage(workCanvas, dx, dy, dw, dh);

  const fname = (downloadName.value.trim() || 'glasses') + '.png';
  out.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
}

// ═══════════════════════════════════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════════════════════════════════

function updateButtons() {
  btnUndo.disabled       = histIndex <= 0;
  btnRedo.disabled       = histIndex >= history.length - 1;
  btnAutoRemove.disabled = !imageLoaded;
  btnDownload.disabled   = !imageLoaded;
  btnAutoCrop.disabled   = !imageLoaded;
}

function setTool(t) {
  tool.active = t;
  toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  magicPanel.style.display = t === 'magic' ? 'block' : 'none';
  // Show/hide brush cursor based on tool
  if (t === 'magic') {
    cursorRing.style.display = 'none';
    editorCanvas.style.cursor = 'crosshair';
  } else {
    editorCanvas.style.cursor = 'none';
  }
}

function updateCursorRing(x, y) {
  if (!imageLoaded || tool.active === 'magic') { cursorRing.style.display = 'none'; return; }
  cursorRing.style.display = 'block';
  cursorRing.style.width   = tool.size + 'px';
  cursorRing.style.height  = tool.size + 'px';
  cursorRing.style.left    = (x - tool.size / 2) + 'px';
  cursorRing.style.top     = (y - tool.size / 2) + 'px';
}

// ═══════════════════════════════════════════════════════════════════
// Event wiring
// ═══════════════════════════════════════════════════════════════════

// ── Upload ──
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadImageFile(file);
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) { loadImageFile(file); fileInput.value = ''; }
});

// ── AI Remove ──
btnAutoRemove.addEventListener('click', autoRemoveBg);

// ── Tool buttons ──
toolBtns.forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

// ── Brush size ──
brushSizeInput.addEventListener('input', () => {
  tool.size = parseInt(brushSizeInput.value);
  brushLabel.textContent = tool.size + 'px';
});

// ── Magic tolerance ──
magicTolInput?.addEventListener('input', () => {
  tool.magicTolerance = parseInt(magicTolInput.value);
  tolLabel.textContent = tool.magicTolerance;
});

// ── Undo / redo ──
btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
});

// ── Zoom buttons ──
btnFit.addEventListener('click', fitToView);
btnZoomIn.addEventListener('click',  () => zoom(1.25));
btnZoomOut.addEventListener('click', () => zoom(0.80));

// ── Scroll-wheel zoom ──
editorCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = editorCanvas.getBoundingClientRect();
  zoom(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

// ── Canvas mouse events ──
editorCanvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const rect = editorCanvas.getBoundingClientRect();
  const cx   = e.clientX - rect.left;
  const cy   = e.clientY - rect.top;

  // Pan: middle mouse OR Alt + left click
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    view.isPanning  = true;
    view.panStartX  = e.clientX - view.panX;
    view.panStartY  = e.clientY - view.panY;
    editorCanvas.style.cursor = 'grabbing';
    return;
  }

  if (!imageLoaded || e.button !== 0) return;

  if (tool.active === 'magic') {
    magicErase(cx, cy);
    return;
  }

  tool.isDrawing = true;
  tool.lastX     = cx;
  tool.lastY     = cy;
  applyBrush(cx, cy);
});

editorCanvas.addEventListener('mousemove', (e) => {
  const rect = editorCanvas.getBoundingClientRect();
  const cx   = e.clientX - rect.left;
  const cy   = e.clientY - rect.top;

  updateCursorRing(cx, cy);

  if (view.isPanning) {
    view.panX = e.clientX - view.panStartX;
    view.panY = e.clientY - view.panStartY;
    redraw();
    return;
  }

  if (!tool.isDrawing) return;

  // Interpolate along the drag path for a smooth stroke
  const dx    = cx - tool.lastX;
  const dy    = cy - tool.lastY;
  const dist  = Math.hypot(dx, dy);
  const step  = Math.max(1, tool.size / 6);
  const steps = Math.ceil(dist / step);

  for (let i = 1; i <= steps; i++) {
    applyBrush(tool.lastX + (dx * i) / steps, tool.lastY + (dy * i) / steps);
  }
  tool.lastX = cx;
  tool.lastY = cy;
});

const endDraw = () => {
  if (view.isPanning) {
    view.isPanning = false;
    editorCanvas.style.cursor = tool.active === 'magic' ? 'crosshair' : 'none';
  }
  if (tool.isDrawing) {
    tool.isDrawing = false;
    saveHistory();
  }
  cursorRing.style.display = 'none';
};

editorCanvas.addEventListener('mouseup',    endDraw);
editorCanvas.addEventListener('mouseleave', endDraw);

// ── Export ──
btnAutoCrop.addEventListener('click', autoCrop);
btnDownload.addEventListener('click', downloadResult);

// ── Resize ──
window.addEventListener('resize', () => { if (imageLoaded) redraw(); });

// ── Init ──
updateButtons();
