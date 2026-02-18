import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
  },
  optimizeDeps: {
    include: [
      '@tensorflow-models/face-landmarks-detection',
      '@mediapipe/face_mesh',
    ],
  },
});
