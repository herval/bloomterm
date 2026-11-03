import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @bloomterm/web dev` proxies the API to a running bloomd. bloomd refuses
// other origins, so the dev proxy drops the browser's Origin header.
export default defineConfig({
  plugins: [react()],
  // Served from localhost, so one ~500 KB bundle (mostly React and the chart library) is fine.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.BLOOMD_PORT ?? 4320}`,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('origin'));
          proxy.on('proxyReqWs', (req) => req.removeHeader('origin'));
        },
      },
    },
  },
});
