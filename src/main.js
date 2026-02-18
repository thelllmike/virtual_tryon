/**
 * main.js — Application entry point.
 *
 * Wires up the UI controls, manages camera lifecycle, and runs the
 * requestAnimationFrame render loop that ties face detection to the
 * glasses overlay renderer.
 */

import { initFaceDetector, detectFace, extractFaceTransform, diag } from './face.js';
import {
  drawVideoFrame,
  drawGlasses,
  drawDebugLandmarks,
  splitGlassesImage,
  generateFallbackGlasses,
} from './render.js';

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

const state = {
  running: false,
  stream: null,

  // Detection throttle — run model every N render frames to keep FPS high.
  frameCount: 0,
  detectionInterval: 2,

  // UI-driven settings
  debugMode: false,
  frameScaleMultiplier: 1.0,
  verticalOffset: 0,
  currentFrameIndex: 0,

  // Smoothed transform (exponential moving average)
  smooth: null,
  smoothingFactor: 0.35, // 0 = frozen, 1 = raw

  // "No face" grace period
  lastFaceTime: 0,
  faceTimeoutMs: 500,
  lastRawTransform: null,

  // FPS counter
  fpsCount: 0,
  fpsLast: performance.now(),
  fps: 0,
};

// ═══════════════════════════════════════════════════════════════════
// DOM references
// ═══════════════════════════════════════════════════════════════════

const canvas = document.getElementById('output-canvas');
const ctx = canvas.getContext('2d');

// Hidden <video> used as the webcam source — never appended to the DOM.
const video = document.createElement('video');
video.playsInline = true;
video.autoplay = true;

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const frameSelect = document.getElementById('frame-select');
const debugToggle = document.getElementById('debug-toggle');
const scaleSlider = document.getElementById('scale-slider');
const offsetSlider = document.getElementById('offset-slider');
const scaleValue = document.getElementById('scale-value');
const offsetValue = document.getElementById('offset-value');
const statusOverlay = document.getElementById('status-overlay');

const infoScale = document.getElementById('info-scale');
const infoRotation = document.getElementById('info-rotation');
const infoYaw = document.getElementById('info-yaw');
const infoFps = document.getElementById('info-fps');

// ═══════════════════════════════════════════════════════════════════
// Glasses assets
// ═══════════════════════════════════════════════════════════════════

/** @type {Array<{ img: HTMLImageElement|HTMLCanvasElement, halves: {left,right} }>} */
const glassesAssets = [];

const GLASSES_URLS = [
  '/assets/glasses.png',
  '/assets/glasses2.png',
  '/assets/glasses3.png',
];
const FALLBACK_STYLES = ['classic', 'round', 'cateye'];

/**
 * Attempt to load each glasses PNG; fall back to programmatic generation.
 */
async function loadGlassesAssets() {
  for (let i = 0; i < GLASSES_URLS.length; i++) {
    let img;
    try {
      img = await loadImage(GLASSES_URLS[i]);
      // Treat tiny placeholder files (e.g. 1×1 px) as "missing".
      if (img.width < 20 || img.height < 20) throw new Error('image too small');
    } catch {
      // Generate a fallback on the fly.
      const fallbackCanvas = generateFallbackGlasses(FALLBACK_STYLES[i]);
      img = await canvasToImage(fallbackCanvas);
    }

    glassesAssets.push({
      img,
      halves: splitGlassesImage(img),
    });
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function canvasToImage(cvs) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = cvs.toDataURL('image/png');
  });
}

// ═══════════════════════════════════════════════════════════════════
// Camera lifecycle
// ═══════════════════════════════════════════════════════════════════

async function startCamera() {
  try {
    setStatus('Requesting camera access…');

    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    video.srcObject = state.stream;
    await video.play();

    // Match canvas resolution to actual video feed.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    state.running = true;
    state.frameCount = 0;
    btnStart.disabled = true;
    btnStop.disabled = false;

    setStatus('', true);
    requestAnimationFrame(renderLoop);
  } catch (err) {
    handleCameraError(err);
  }
}

function stopCamera() {
  state.running = false;

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;

  btnStart.disabled = false;
  btnStop.disabled = true;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Reset tracking state
  state.smooth = null;
  state.lastRawTransform = null;

  // Reset info panel
  infoScale.textContent = '\u2013';
  infoRotation.textContent = '\u2013';
  infoYaw.textContent = '\u2013';
  infoFps.textContent = '\u2013';

  setStatus('Camera stopped');
}

function handleCameraError(err) {
  const msgs = {
    NotAllowedError:
      'Camera permission denied. Allow camera access in your browser settings and reload.',
    PermissionDeniedError:
      'Camera permission denied. Allow camera access in your browser settings and reload.',
    NotFoundError: 'No camera found. Please connect a webcam and try again.',
    DevicesNotFoundError: 'No camera found. Please connect a webcam and try again.',
    NotReadableError: 'Camera is in use by another app. Close it and retry.',
    TrackStartError: 'Camera is in use by another app. Close it and retry.',
    OverconstrainedError:
      'Camera does not support requested resolution. Try a different camera.',
  };

  setStatus(msgs[err.name] || `Camera error: ${err.message || 'unknown'}`);
  console.error('[camera]', err);
}

// ═══════════════════════════════════════════════════════════════════
// Transform smoothing
// ═══════════════════════════════════════════════════════════════════

function applySmoothing(raw) {
  const a = state.smoothingFactor;

  if (!state.smooth) {
    // First frame — seed with raw values.
    state.smooth = {
      centerX: raw.center.x,
      centerY: raw.center.y,
      eyeDistance: raw.eyeDistance,
      roll: raw.roll,
      yaw: raw.yaw,
      keypoints: raw.keypoints,
    };
    return buildSmoothed(state.smooth, raw.keypoints);
  }

  const s = state.smooth;
  s.centerX = lerp(s.centerX, raw.center.x, a);
  s.centerY = lerp(s.centerY, raw.center.y, a);
  s.eyeDistance = lerp(s.eyeDistance, raw.eyeDistance, a);
  s.roll = lerp(s.roll, raw.roll, a);
  s.yaw = lerp(s.yaw, raw.yaw, a);
  s.keypoints = raw.keypoints;

  return buildSmoothed(s, raw.keypoints);
}

function buildSmoothed(s, keypoints) {
  return {
    center: { x: s.centerX, y: s.centerY },
    eyeDistance: s.eyeDistance,
    roll: s.roll,
    yaw: s.yaw,
    keypoints,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ═══════════════════════════════════════════════════════════════════
// Render loop  (detection runs on its own async cadence so it never
//               blocks requestAnimationFrame)
// ═══════════════════════════════════════════════════════════════════

let modelReady = false;
let detecting = false; // guard against overlapping detection calls

/**
 * Separate async detection loop — fires every detectionInterval frames.
 * Runs independently of the draw loop so awaiting the model never stalls rendering.
 */
async function runDetection() {
  if (!state.running || !modelReady || detecting) return;
  detecting = true;
  try {
    const face = await detectFace(video);
    if (face) {
      const raw = extractFaceTransform(face.keypoints);
      state.lastRawTransform = applySmoothing(raw);
      state.lastFaceTime = performance.now();
    }
  } finally {
    detecting = false;
  }
}

function renderLoop() {
  if (!state.running) return;

  // ── 1. Draw video frame ──
  drawVideoFrame(ctx, video, canvas.width, canvas.height);

  // ── 2. Kick off detection (non-blocking) ──
  state.frameCount++;
  if (state.frameCount % state.detectionInterval === 0) {
    runDetection();
  }

  // ── 3. Glasses overlay ──
  const now = performance.now();
  const elapsed = now - state.lastFaceTime;

  if (state.lastRawTransform && elapsed < state.faceTimeoutMs) {
    const gl = glassesAssets[state.currentFrameIndex];
    if (gl) {
      drawGlasses(
        ctx,
        gl.halves,
        state.lastRawTransform,
        gl.img,
        state.frameScaleMultiplier,
        state.verticalOffset,
      );
    }

    // Info panel
    const t = state.lastRawTransform;
    infoScale.textContent = (t.eyeDistance / 100).toFixed(2);
    infoRotation.textContent = `${(t.roll * (180 / Math.PI)).toFixed(1)}\u00B0`;
    infoYaw.textContent = t.yaw.toFixed(3);

    // Debug landmarks
    if (state.debugMode && t.keypoints) {
      drawDebugLandmarks(ctx, t.keypoints);
    }
  }

  // ── 4. FPS counter + diagnostics ──
  state.fpsCount++;
  if (now - state.fpsLast >= 1000) {
    state.fps = state.fpsCount;
    state.fpsCount = 0;
    state.fpsLast = now;
    infoFps.textContent = `${state.fps}  [D:${diag.attempts} S:${diag.successes} E:${diag.errors}]`;
    // Show last error in console when debugging
    if (diag.lastError && state.debugMode) {
      console.log('[diag]', diag.lastError);
    }
  }

  requestAnimationFrame(renderLoop);
}

// ═══════════════════════════════════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════════════════════════════════

function setStatus(msg, hide = false) {
  statusOverlay.textContent = msg;
  statusOverlay.classList.toggle('hidden', hide);
}

// ═══════════════════════════════════════════════════════════════════
// Event listeners
// ═══════════════════════════════════════════════════════════════════

btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);

frameSelect.addEventListener('change', (e) => {
  state.currentFrameIndex = parseInt(e.target.value, 10);
});

debugToggle.addEventListener('change', (e) => {
  state.debugMode = e.target.checked;
});

scaleSlider.addEventListener('input', (e) => {
  state.frameScaleMultiplier = parseFloat(e.target.value);
  scaleValue.textContent = state.frameScaleMultiplier.toFixed(2);
});

offsetSlider.addEventListener('input', (e) => {
  state.verticalOffset = parseInt(e.target.value, 10);
  offsetValue.textContent = state.verticalOffset;
});

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════

async function init() {
  setStatus('Loading assets and face model…');

  try {
    // Load glasses images (or generate fallbacks) while the model downloads.
    const [/* assets */] = await Promise.all([
      loadGlassesAssets(),
      initFaceDetector((msg) => setStatus(msg)),
    ]);

    modelReady = true;
    btnStart.disabled = false;
    setStatus('Ready! Click "Start Camera" to begin.');
  } catch (err) {
    setStatus(`Failed to initialise: ${err.message}`);
    console.error('[init]', err);
  }
}

init();
