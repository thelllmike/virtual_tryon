import { defineConfig } from 'vite';
import { resolve } from 'path';

const isWordPressBuild = process.env.BUILD_TARGET === 'wordpress';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
  },

  base: isWordPressBuild ? './' : '/',

  build: isWordPressBuild
    ? {
        outDir: 'wordpress-plugin/virtual-tryon/app',
        emptyOutDir: true,
        rollupOptions: {
          input: { main: resolve(__dirname, 'index.html') },
          output: {
            entryFileNames: 'js/tryon.js',
            chunkFileNames: 'js/[name].js',
            assetFileNames: (info) =>
              info.name?.endsWith('.css') ? 'assets/tryon.css' : 'assets/[name][extname]',
          },
        },
      }
    : {
        outDir: 'dist',
        rollupOptions: {
          input: {
            main:   resolve(__dirname, 'index.html'),
            editor: resolve(__dirname, 'editor.html'),
          },
        },
      },

  optimizeDeps: {
    include: [
      '@tensorflow-models/face-landmarks-detection',
      '@tensorflow/tfjs-core',
      '@tensorflow/tfjs-backend-webgl',
      '@tensorflow/tfjs-converter',
    ],
    // @mediapipe/face_mesh is no longer used — switched to tfjs runtime
    // to avoid WASM bundling failures in Vite production builds.
  },
});
