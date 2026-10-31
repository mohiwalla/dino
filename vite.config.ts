import { defineConfig } from 'vite';

export default defineConfig({
  // The game is shared through a Cloudflare quick tunnel, so the Host header is *.trycloudflare.com.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
