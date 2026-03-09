import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverTarget = process.env.TERMINAL_CANVAS_PROXY_TARGET ?? 'http://127.0.0.1:4312';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': serverTarget,
      '/ws': {
        target: serverTarget.replace('http', 'ws'),
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: false,
  },
});
