/**
 * render3d.js — Three.js GLB glasses renderer.
 *
 * Creates a transparent WebGL canvas overlaid on the 2D webcam canvas.
 * Uses an orthographic camera in pixel-space so face landmark coordinates
 * map directly to 3D world positions without any unprojection math.
 *
 * Usage:
 *   init3DRenderer(containerEl, width, height)
 *   await loadGLBModel(url)
 *   update3DGlasses(transform, canvasWidth, canvasHeight, scale, offsetY)
 *   dispose3DRenderer()
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── Module-level singletons ──────────────────────────────────────

let scene      = null;
let camera     = null;
let renderer   = null;
let glassesModel = null;
let overlayCanvas = null;

// After loading, we normalise the model width to 1 unit so that
// scaling by `eyeDistance` gives a pixel-accurate fit.
let normalizedWidthUnit = 1;

// ─── Initialisation ───────────────────────────────────────────────

/**
 * Create the Three.js WebGL canvas and append it over the webcam canvas.
 *
 * @param {HTMLElement} container  — must wrap the 2D canvas (position:relative applied here)
 * @param {number}      width      — canvas width in CSS pixels
 * @param {number}      height     — canvas height in CSS pixels
 * @returns {HTMLCanvasElement}    the transparent overlay canvas
 */
export function init3DRenderer(container, width, height) {
  // Clean up any previous instance first
  if (renderer) dispose3DRenderer();

  overlayCanvas = document.createElement('canvas');
  overlayCanvas.width  = width;
  overlayCanvas.height = height;
  // transform:scaleX(-1) mirrors the 3D canvas to match the selfie-mirror
  // applied to the 2D canvas via CSS (#output-canvas { transform: scaleX(-1) }).
  // Without this, the GLB model lands on the opposite side of the face.
  overlayCanvas.style.cssText =
    'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;transform:scaleX(-1);';

  container.style.position = 'relative';
  container.appendChild(overlayCanvas);

  // ── Three.js orthographic camera in pixel-space ──
  // Origin is at canvas centre; x right, y up (Three.js convention).
  camera = new THREE.OrthographicCamera(
    -width / 2,  width / 2,
     height / 2, -height / 2,
    1, 2000,
  );
  camera.position.z = 1000;

  scene = new THREE.Scene();

  renderer = new THREE.WebGLRenderer({
    canvas: overlayCanvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // ── Lighting — key + fill for realistic frame materials ──
  const ambient = new THREE.AmbientLight(0xffffff, 1.4);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(50, 100, 200);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-50, -50, 100);
  scene.add(fill);

  return overlayCanvas;
}

// ─── Model loading ────────────────────────────────────────────────

/**
 * Load (or hot-swap) the GLB glasses model.
 * Disposes the previous model's geometry + materials automatically.
 *
 * @param {string} url  — absolute URL to a .glb file
 * @returns {Promise<THREE.Group>}
 */
export function loadGLBModel(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        // Dispose previous model
        if (glassesModel) {
          scene.remove(glassesModel);
          disposeModel(glassesModel);
        }

        glassesModel = gltf.scene;

        // Measure natural width and normalise to 1 unit.
        // Scaling by `eyeDistance` pixels later gives pixel-accurate sizing.
        const box  = new THREE.Box3().setFromObject(glassesModel);
        const size = box.getSize(new THREE.Vector3());
        normalizedWidthUnit = 1 / (size.x || 1);

        // Centre the model on its local origin so rotations feel natural.
        const centre = box.getCenter(new THREE.Vector3());
        glassesModel.position.sub(centre);

        scene.add(glassesModel);
        resolve(glassesModel);
      },
      undefined,
      reject,
    );
  });
}

// ─── Per-frame update ─────────────────────────────────────────────

/**
 * Position and orient the loaded GLB to match the current face transform.
 * Call this once per render frame after runDetection() fires.
 *
 * @param {Object} transform       — output of extractFaceTransform()
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} scaleMultiplier — user-adjustable fit (0.8 – 1.3)
 * @param {number} verticalOffset  — user-adjustable pixel shift (-40 – 40)
 */
export function update3DGlasses(
  transform,
  canvasWidth,
  canvasHeight,
  scaleMultiplier = 1.0,
  verticalOffset  = 0,
) {
  if (!glassesModel || !renderer || !scene || !camera) return;

  const { center, eyeDistance, roll, yaw } = transform;

  // Convert top-left pixel coords → orthographic centre-origin space.
  // Three.js y-axis points up, canvas y-axis points down — flip sign.
  const x =  center.x - canvasWidth  / 2;
  const y = -(center.y + verticalOffset - canvasHeight / 2);

  // Scale: normalised model width = 1 unit; eye distance ≈ half the glasses width.
  // Multiplier 2.4 is tuned so the frames align with the eye span.
  const scale = eyeDistance * normalizedWidthUnit * 2.4 * scaleMultiplier;

  glassesModel.position.set(x, y, 0);
  glassesModel.scale.setScalar(scale);

  // Roll: canvas roll is clockwise-positive; Three.js z-rotation is CCW-positive.
  glassesModel.rotation.z = -roll;

  // Yaw: lean the model as the head turns for a convincing 3-D perspective.
  glassesModel.rotation.y = -yaw * Math.PI * 0.28;

  renderer.render(scene, camera);
}

// ─── Cleanup helpers ──────────────────────────────────────────────

/** Clear the overlay canvas (call when no face is detected). */
export function clear3DOverlay() {
  if (renderer) {
    renderer.clear();
  }
}

/** Fully tear down Three.js resources and remove the overlay canvas. */
export function dispose3DRenderer() {
  if (glassesModel) {
    scene?.remove(glassesModel);
    disposeModel(glassesModel);
    glassesModel = null;
  }

  if (renderer) {
    renderer.dispose();
    renderer = null;
  }

  if (overlayCanvas?.parentElement) {
    overlayCanvas.parentElement.removeChild(overlayCanvas);
  }
  overlayCanvas = null;
  scene  = null;
  camera = null;
  normalizedWidthUnit = 1;
}

/** @returns {boolean} true if a model is loaded and ready to render */
export function is3DReady() {
  return !!(renderer && glassesModel);
}

// ─── Internal helpers ─────────────────────────────────────────────

function disposeModel(model) {
  model.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => m?.dispose());
  });
}
