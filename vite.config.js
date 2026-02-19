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
    // @mediapipe/tasks-vision loads its WASM from CDN at runtime via
    // FilesetResolver — exclude it so Vite/esbuild never tries to bundle
    // the binary internals.
    exclude: ['@mediapipe/tasks-vision'],
  },
});
