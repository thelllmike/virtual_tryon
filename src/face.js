/**
 * face.js — Face landmark detection using MediaPipe FaceMesh (tfjs runtime).
 *
 * Uses the @tensorflow/tfjs runtime so Vite can bundle it cleanly for
 * production (Vercel, Netlify, etc.).  The mediapipe runtime requires a
 * WASM binary that breaks when bundled by Rollup/esbuild in production.
 *
 * The tfjs runtime delivers equivalent accuracy for glasses try-on.
 * Iris refinement is not available in this runtime; the eye-corner
 * fallback in extractFaceTransform() handles that transparently.
 */

import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection';

// ─── Detector singleton ───
let detector = null;

// ─── Diagnostic counters (visible in debug mode) ───
export const diag = { attempts: 0, successes: 0, errors: 0, lastError: '' };

/**
 * Create the FaceMesh detector using the MediaPipe WASM runtime.
 * Model + WASM binaries are fetched from CDN on first load.
 *
 * @param {function} [onProgress] - optional callback for status messages
 * @returns {Promise<Object>} the created detector instance
 */
export async function initFaceDetector(onProgress) {
  if (onProgress) onProgress('Loading FaceMesh model…');

  const model = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;
  detector = await faceLandmarksDetection.createDetector(model, {
    runtime: 'tfjs',   // bundles cleanly — no WASM loader needed on Vercel
    maxFaces: 1,
  });

  if (onProgress) onProgress('Model loaded!');
  return detector;
}

/**
 * Run face estimation on the current video frame.
 * @param {HTMLVideoElement} video
 * @returns {Promise<Object|null>} first detected face or null
 */
export async function detectFace(video) {
  if (!detector) { diag.lastError = 'no detector'; return null; }
  if (video.readyState < 2) { diag.lastError = `video not ready (state=${video.readyState})`; return null; }

  diag.attempts++;
  try {
    const faces = await detector.estimateFaces(video);
    if (faces.length > 0) {
      diag.successes++;
      return faces[0];
    }
    diag.lastError = 'no face in frame';
    return null;
  } catch (err) {
    diag.errors++;
    diag.lastError = String(err.message || err);
    console.warn('[face] detection error:', err);
    return null;
  }
}

// ─── Key landmark indices (MediaPipe FaceMesh 478-point topology) ───
export const LM = {
  LEFT_EYE_OUTER: 33,
  LEFT_EYE_INNER: 133,
  RIGHT_EYE_INNER: 362,
  RIGHT_EYE_OUTER: 263,
  LEFT_IRIS: 468,   // available when refineLandmarks = true
  RIGHT_IRIS: 473,  // available when refineLandmarks = true
  NOSE_TIP: 1,
  LEFT_FACE_EDGE: 234,
  RIGHT_FACE_EDGE: 454,
  FOREHEAD: 10,
  CHIN: 152,
};

/**
 * Derive glasses-relevant transform data from raw face keypoints.
 *
 * Returns: { center, leftEye, rightEye, eyeDistance, roll, yaw, keypoints }
 */
export function extractFaceTransform(keypoints) {
  let leftEye, rightEye;

  if (keypoints.length > 473) {
    leftEye = keypoints[LM.LEFT_IRIS];
    rightEye = keypoints[LM.RIGHT_IRIS];
  } else {
    leftEye = midpoint(keypoints[LM.LEFT_EYE_OUTER], keypoints[LM.LEFT_EYE_INNER]);
    rightEye = midpoint(keypoints[LM.RIGHT_EYE_INNER], keypoints[LM.RIGHT_EYE_OUTER]);
  }

  const center = midpoint(leftEye, rightEye);
  const eyeDistance = dist(leftEye, rightEye);

  // Roll (in-plane rotation)
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  // Yaw (horizontal head turn) from nose-to-face-edge distances
  const noseTip = keypoints[LM.NOSE_TIP];
  const leftEdge = keypoints[LM.LEFT_FACE_EDGE];
  const rightEdge = keypoints[LM.RIGHT_FACE_EDGE];

  const dLeft = dist(noseTip, leftEdge);
  const dRight = dist(noseTip, rightEdge);

  let yaw = 0;
  if (dLeft + dRight > 0) {
    yaw = (dLeft - dRight) / (dLeft + dRight);
  }

  // Blend in z-depth signal if available
  if (leftEye.z !== undefined && rightEye.z !== undefined) {
    const zDiff = rightEye.z - leftEye.z;
    const zYaw = zDiff / Math.max(eyeDistance * 0.5, 1);
    yaw = yaw * 0.55 + zYaw * 0.45;
  }

  return {
    center,
    leftEye,
    rightEye,
    eyeDistance,
    roll,
    yaw: clamp(yaw, -1, 1),
    keypoints,
  };
}

// ─── Utility helpers ───

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: a.z !== undefined && b.z !== undefined ? (a.z + b.z) / 2 : undefined,
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
