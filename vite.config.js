import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'client'),
  base: '/',
  publicDir: path.join(here, 'client', 'public'),
  resolve: {
    alias: {
      '@shared': path.join(here, 'shared'),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [here],
    },
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: path.join(here, 'dist', 'client'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.join(here, 'client', 'index.html'),
        display: path.join(here, 'client', 'display.html'),
        play: path.join(here, 'client', 'play.html'),
      },
    },
  },
});
