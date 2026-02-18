# Virtual Spectacle Try-On

A real-time virtual glasses try-on demo using TensorFlow.js and MediaPipe FaceMesh. The app opens your webcam, detects your face landmarks, and overlays a glasses PNG aligned to your eyes with a 2.5D perspective effect that responds to head turns.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Generate placeholder glasses PNGs
npm run generate-assets

# 3. Start the dev server
npm run dev
```

The app opens at **http://localhost:3000**. Click **Start Camera**, allow webcam access, and you should see glasses overlaid on your face.

> If you skip step 2, the app automatically generates fallback glasses images in the browser — so it works either way.

## Tech Stack

| Layer | Choice |
|---|---|
| Bundler | Vite (vanilla JS, no framework) |
| Face detection | TensorFlow.js + `@tensorflow-models/face-landmarks-detection` (MediaPipe FaceMesh, 478 keypoints) |
| GPU backend | `@tensorflow/tfjs-backend-webgl` |
| Rendering | HTML `<canvas>` — video frame + PNG overlay composited per frame |

## Project Structure

```
.
├── index.html              Main page
├── package.json
├── vite.config.js
├── src/
│   ├── main.js             App bootstrap, UI wiring, render loop
│   ├── face.js             TF.js init, detector, landmark extraction
│   ├── render.js           Canvas drawing, 2.5D warp, debug overlay
│   └── styles.css
├── public/
│   └── assets/
│       ├── glasses.png     Classic rectangular frames
│       ├── glasses2.png    Round / aviator frames
│       └── glasses3.png    Cat-eye frames
├── scripts/
│   └── generate-glasses.mjs  Node script to create placeholder PNGs
└── README.md
```

## How It Works

### Face Detection
- MediaPipe FaceMesh runs via the TF.js runtime (pure WebGL, no WASM).
- `refineLandmarks: true` provides 478 keypoints including iris centres.
- Detection is throttled to every 2nd render frame to keep FPS high.

### Glasses Placement
1. **Position** — midpoint between left and right iris centres (landmarks 468 & 473).
2. **Scale** — `eyeDistance / anchorDistance` where anchor distance is the expected lens-centre gap in the PNG (30 % ↔ 70 % of image width by default).
3. **Roll** — `atan2` of the line between the two eye centres.

### 2.5D Perspective Effect
Instead of a full 3-D transform, the glasses PNG is split into left and right halves. Yaw (horizontal head turn) is estimated by comparing nose-to-face-edge distances and z-depth. Each half is then scaled independently:

- **Near side** (the side the head is turning toward): width and height increase slightly.
- **Far side**: width and height decrease slightly.

This creates a convincing depth cue at minimal computational cost.

### Robustness
- **Smoothing** — Exponential moving average on position, scale, roll, and yaw prevents jitter.
- **Face-loss grace period** — When no face is detected the last known transform persists for 500 ms, then the overlay hides. This avoids flicker during brief tracking drops.

## Using Your Own Glasses Images

Replace the PNGs in `public/assets/` with your own transparent-background glasses images. For best results:

1. Use images around **400 × 160 px** (wider than tall).
2. Place the left lens centre at roughly **30 % width, 45 % height**.
3. Place the right lens centre at roughly **70 % width, 45 % height**.
4. If your proportions differ, adjust the constants in `src/render.js`:
   ```js
   const ANCHOR_LEFT_X = 0.30;
   const ANCHOR_RIGHT_X = 0.70;
   const ANCHOR_Y = 0.45;
   ```

## Calibration Controls

| Control | Range | Purpose |
|---|---|---|
| Frame Scale | 0.80 – 1.30 | Multiplier on computed glasses size |
| Vertical Offset | -40 – +40 px | Shifts glasses up/down to fine-tune nose bridge alignment |
| Debug Landmarks | on/off | Draws all 478 face keypoints on the canvas |

## Browser Requirements

- Modern Chromium-based browser (Chrome, Edge, Brave) or Firefox.
- Webcam access must be granted.
- WebGL must be available (virtually all modern browsers).

## Scripts

```bash
npm run dev             # Vite dev server with HMR
npm run build           # Production build to dist/
npm run preview         # Preview production build
npm run generate-assets # Generate placeholder glasses PNGs
```
