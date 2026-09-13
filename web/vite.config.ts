import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard talks to the API on :3000. Rather than enable CORS on the
 * backend, the dev server proxies every /api/* call to it and strips the
 * prefix — so the browser only ever sees same-origin requests, and the API
 * stays free of any cross-origin concessions.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
