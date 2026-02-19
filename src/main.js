/**
 * main.js — Virtual Try-On entry point (2D PNG mode).
 *
 * Standalone demo: loads preset PNG assets from /assets/
 * WordPress iframe:  reads a single PNG URL from ?png=URL
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
// URL param config  (WordPress iframe mode)
// ═══════════════════════════════════════════════════════════════════

const params = new URLSearchParams(window.location.search);
const CONFIG = {
  pngUrl:   params.get('png')      || null,
  embedded: params.has('embedded'),
};

if (CONFIG.embedded) document.body.classList.add('embedded');

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

const state = {
  running:  false,
  stream:   null,
  frameCount:        0,
  detectionInterval: 2,
  debugMode:            false,
  frameScaleMultiplier: 1.0,
  verticalOffset:       0,
  currentFrameIndex:    0,
  smooth:           null,
  smoothingFactor:  0.35,
  lastFaceTime:     0,
  faceTimeoutMs:    500,
  lastRawTransform: null,
  fpsCount: 0,
  fpsLast:  performance.now(),
  fps:      0,
};

// ═══════════════════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════════════════

const canvas  = document.getElementById('output-canvas');
const ctx     = canvas.getContext('2d');

const video   = document.createElement('video');
video.playsInline = true;
video.autoplay    = true;

const btnStart    = document.getElementById('btn-start');
const btnStop     = document.getElementById('btn-stop');
const frameSelect = document.getElementById('frame-select');
const debugToggle = document.getElementById('debug-toggle');
const scaleSlider = document.getElementById('scale-slider');
const offsetSlider = document.getElementById('offset-slider');
const scaleValue  = document.getElementById('scale-value');
const offsetValue = document.getElementById('offset-value');
const statusOverlay = document.getElementById('status-overlay');
const infoScale    = document.getElementById('info-scale');
const infoRotation = document.getElementById('info-rotation');
const infoYaw      = document.getElementById('info-yaw');
const infoFps      = document.getElementById('info-fps');

// ═══════════════════════════════════════════════════════════════════
// Glasses assets
// ═══════════════════════════════════════════════════════════════════

const glassesAssets  = [];
const GLASSES_URLS   = ['/assets/glasses.png', '/assets/glasses2.png', '/assets/glasses3.png'];
const FALLBACK_STYLES = ['classic', 'round', 'cateye'];

async function loadGlassesAssets() {
  if (CONFIG.pngUrl) {
    const img = await tryLoadImage(CONFIG.pngUrl, generateFallbackGlasses('classic'));
    glassesAssets.push({ img, halves: splitGlassesImage(img) });
    // Hide frame selector — only one product
    frameSelect?.closest('.control-group')?.style.setProperty('display', 'none');
    return;
  }
  for (let i = 0; i < GLASSES_URLS.length; i++) {
    const img = await tryLoadImage(GLASSES_URLS[i], generateFallbackGlasses(FALLBACK_STYLES[i]));
    glassesAssets.push({ img, halves: splitGlassesImage(img) });
  }
}

async function tryLoadImage(src, fallback) {
  try {
    const img = await loadImage(src);
    if (img.width < 20 || img.height < 20) throw new Error('too small');
    return img;
  } catch {
    return canvasToImage(fallback);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
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
// Camera
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
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    state.running    = true;
    state.frameCount = 0;
    btnStart.disabled = true;
    btnStop.disabled  = false;
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
  btnStop.disabled  = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.smooth          = null;
  state.lastRawTransform = null;
  infoScale.textContent    = '–';
  infoRotation.textContent = '–';
  infoYaw.textContent      = '–';
  infoFps.textContent      = '–';
  setStatus('Camera stopped');
}

function handleCameraError(err) {
  const msgs = {
    NotAllowedError:       'Camera permission denied. Allow access and reload.',
    PermissionDeniedError: 'Camera permission denied. Allow access and reload.',
    NotFoundError:         'No camera found. Connect a webcam and try again.',
    NotReadableError:      'Camera in use by another app. Close it and retry.',
    OverconstrainedError:  'Camera does not support requested resolution.',
  };
  setStatus(msgs[err.name] || `Camera error: ${err.message}`);
  console.error('[camera]', err);
}

// ═══════════════════════════════════════════════════════════════════
// Smoothing
// ═══════════════════════════════════════════════════════════════════

function applySmoothing(raw) {
  const a = state.smoothingFactor;
  if (!state.smooth) {
    state.smooth = {
      centerX: raw.center.x, centerY: raw.center.y,
      eyeDistance: raw.eyeDistance, roll: raw.roll, yaw: raw.yaw,
    };
    return buildSmoothed(state.smooth, raw.keypoints);
  }
  const s = state.smooth;
  s.centerX     = lerp(s.centerX,     raw.center.x,   a);
  s.centerY     = lerp(s.centerY,     raw.center.y,   a);
  s.eyeDistance = lerp(s.eyeDistance, raw.eyeDistance, a);
  s.roll        = lerp(s.roll,        raw.roll,        a);
  s.yaw         = lerp(s.yaw,         raw.yaw,         a);
  return buildSmoothed(s, raw.keypoints);
}

function buildSmoothed(s, keypoints) {
  return { center: { x: s.centerX, y: s.centerY }, eyeDistance: s.eyeDistance, roll: s.roll, yaw: s.yaw, keypoints };
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ═══════════════════════════════════════════════════════════════════
// Render loop
// ═══════════════════════════════════════════════════════════════════

let modelReady = false;
let detecting  = false;

async function runDetection() {
  if (!state.running || !modelReady || detecting) return;
  detecting = true;
  try {
    const face = await detectFace(video);
    if (face) {
      state.lastRawTransform = applySmoothing(extractFaceTransform(face.keypoints));
      state.lastFaceTime = performance.now();
    }
  } finally {
    detecting = false;
  }
}

function renderLoop() {
  if (!state.running) return;
  drawVideoFrame(ctx, video, canvas.width, canvas.height);

  state.frameCount++;
  if (state.frameCount % state.detectionInterval === 0) runDetection();

  const elapsed = performance.now() - state.lastFaceTime;
  if (state.lastRawTransform && elapsed < state.faceTimeoutMs) {
    const t  = state.lastRawTransform;
    const gl = glassesAssets[state.currentFrameIndex];
    if (gl) drawGlasses(ctx, gl.halves, t, gl.img, state.frameScaleMultiplier, state.verticalOffset);

    infoScale.textContent    = (t.eyeDistance / 100).toFixed(2);
    infoRotation.textContent = `${(t.roll * 180 / Math.PI).toFixed(1)}°`;
    infoYaw.textContent      = t.yaw.toFixed(3);

    if (state.debugMode && t.keypoints) drawDebugLandmarks(ctx, t.keypoints);
  }

  state.fpsCount++;
  const now = performance.now();
  if (now - state.fpsLast >= 1000) {
    state.fps = state.fpsCount; state.fpsCount = 0; state.fpsLast = now;
    infoFps.textContent = `${state.fps}  [D:${diag.attempts} S:${diag.successes} E:${diag.errors}]`;
  }

  requestAnimationFrame(renderLoop);
}

// ═══════════════════════════════════════════════════════════════════
// UI helpers + events
// ═══════════════════════════════════════════════════════════════════

function setStatus(msg, hide = false) {
  statusOverlay.textContent = msg;
  statusOverlay.classList.toggle('hidden', hide);
}

btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
frameSelect?.addEventListener('change', (e) => { state.currentFrameIndex = parseInt(e.target.value, 10); });
debugToggle?.addEventListener('change', (e) => { state.debugMode = e.target.checked; });
scaleSlider?.addEventListener('input', (e) => {
  state.frameScaleMultiplier = parseFloat(e.target.value);
  if (scaleValue) scaleValue.textContent = state.frameScaleMultiplier.toFixed(2);
});
offsetSlider?.addEventListener('input', (e) => {
  state.verticalOffset = parseInt(e.target.value, 10);
  if (offsetValue) offsetValue.textContent = state.verticalOffset;
});

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════

async function init() {
  setStatus('Loading face model…');
  try {
    await Promise.all([
      initFaceDetector((msg) => setStatus(msg)),
      loadGlassesAssets(),
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
