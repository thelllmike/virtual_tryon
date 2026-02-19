/**
 * face.js — Face landmark detection using @mediapipe/tasks-vision FaceLandmarker.
 *
 * The WASM runtime and model are fetched from CDN at runtime, so Vite/Rollup
 * never tries to bundle binary files.  This is the most reliable approach for
 * Vercel / Netlify production deployments.
 *
 * Landmark topology: MediaPipe FaceMesh 478 points (including iris 468-477).
 * Iris refinement IS available in this runtime.
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// ─── Detector singleton ───
let faceLandmarker = null;
let lastVideoTime  = -1;

// ─── Diagnostic counters (visible in debug mode) ───
export const diag = { attempts: 0, successes: 0, errors: 0, lastError: '' };

/**
 * Create the FaceLandmarker using the MediaPipe Tasks-Vision runtime.
 * WASM binaries and model are fetched from CDN on first load.
 *
 * @param {function} [onProgress] - optional callback for status messages
 * @returns {Promise<Object>} the created FaceLandmarker instance
 */
export async function initFaceDetector(onProgress) {
  if (onProgress) onProgress('Loading FaceMesh model…');

  const vision = await FilesetResolver.forVisionTasks(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm`,
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    runningMode:                         'VIDEO',
    numFaces:                            1,
    outputFaceBlendshapes:               false,
    outputFacialTransformationMatrixes:  false,
  });

  if (onProgress) onProgress('Model loaded!');
  return faceLandmarker;
}

/**
 * Run face estimation on the current video frame (synchronous under the hood).
 * Returns the same shape as before so main.js needs no changes.
 *
 * @param {HTMLVideoElement} video
 * @returns {{ keypoints: Array } | null}
 */
export function detectFace(video) {
  if (!faceLandmarker) { diag.lastError = 'no detector'; return null; }
  if (video.readyState < 2) {
    diag.lastError = `video not ready (state=${video.readyState})`;
    return null;
  }

  // tasks-vision requires a strictly-increasing timestamp per unique frame
  if (video.currentTime === lastVideoTime) {
    diag.lastError = 'duplicate frame';
    return null;
  }
  lastVideoTime = video.currentTime;

  diag.attempts++;
  try {
    const result = faceLandmarker.detectForVideo(video, performance.now());

    if (result.faceLandmarks && result.faceLandmarks.length > 0) {
      diag.successes++;
      const w = video.videoWidth;
      const h = video.videoHeight;

      // Convert normalised [0-1] coords → pixel coords matching the old API shape
      const keypoints = result.faceLandmarks[0].map((lm) => ({
        x: lm.x * w,
        y: lm.y * h,
        z: lm.z * w, // z is normalised relative to face width; scale to pixels
      }));

      return { keypoints };
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
  LEFT_EYE_OUTER:  33,
  LEFT_EYE_INNER:  133,
  RIGHT_EYE_INNER: 362,
  RIGHT_EYE_OUTER: 263,
  LEFT_IRIS:       468,   // iris centre — available with tasks-vision runtime
  RIGHT_IRIS:      473,
  NOSE_TIP:        1,
  LEFT_FACE_EDGE:  234,
  RIGHT_FACE_EDGE: 454,
  FOREHEAD:        10,
  CHIN:            152,
};

/**
 * Derive glasses-relevant transform data from raw face keypoints.
 *
 * Returns: { center, leftEye, rightEye, eyeDistance, roll, yaw, keypoints }
 */
export function extractFaceTransform(keypoints) {
  let leftEye, rightEye;

  if (keypoints.length > 473) {
    leftEye  = keypoints[LM.LEFT_IRIS];
    rightEye = keypoints[LM.RIGHT_IRIS];
  } else {
    leftEye  = midpoint(keypoints[LM.LEFT_EYE_OUTER], keypoints[LM.LEFT_EYE_INNER]);
    rightEye = midpoint(keypoints[LM.RIGHT_EYE_INNER], keypoints[LM.RIGHT_EYE_OUTER]);
  }

  const center      = midpoint(leftEye, rightEye);
  const eyeDistance = dist(leftEye, rightEye);

  // Roll (in-plane rotation)
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  // Yaw (horizontal head turn) from nose-to-face-edge distances
  const noseTip  = keypoints[LM.NOSE_TIP];
  const leftEdge = keypoints[LM.LEFT_FACE_EDGE];
  const rightEdge = keypoints[LM.RIGHT_FACE_EDGE];

  const dLeft  = dist(noseTip, leftEdge);
  const dRight = dist(noseTip, rightEdge);

  let yaw = 0;
  if (dLeft + dRight > 0) {
    yaw = (dLeft - dRight) / (dLeft + dRight);
  }

  // Blend in z-depth signal if available
  if (leftEye.z !== undefined && rightEye.z !== undefined) {
    const zDiff = rightEye.z - leftEye.z;
    const zYaw  = zDiff / Math.max(eyeDistance * 0.5, 1);
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
