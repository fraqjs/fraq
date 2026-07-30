import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: 'webui',
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./webui/src', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/webui',
    emptyOutDir: false,
  },
  server: {
    proxy: {
      '/webui/auth': 'http://127.0.0.1:4649',
    },
  },
});
