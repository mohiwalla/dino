import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Emits sw.js with every file of the build in its precache list, so the game runs offline. */
function serviceWorker(): Plugin {
  return {
    name: 'dino3d-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).sort();
      const hash = createHash('sha256');
      for (const name of files) {
        const out = bundle[name];
        hash.update(name).update(out.type === 'chunk' ? out.code : out.source);
      }
      // Public-dir files are copied after the bundle, so list them explicitly.
      const precache = ['./', ...files.filter((f) => f !== 'index.html'), 'favicon.ico'];
      const source = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8')
        .replace('__VERSION__', JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so the build (and its service worker scope) works from any path.
  base: './',
  // The game is shared through a Cloudflare quick tunnel, so the Host header is *.trycloudflare.com.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  plugins: [serviceWorker()],
});
