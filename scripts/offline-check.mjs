// Verifies offline play: loads the production build once, cuts the network, reloads and
// plays a little. Run against `bun run preview` (service workers only exist in builds).
//
//   node scripts/offline-check.mjs http://localhost:4173/ [out.png]
import { chromium } from 'playwright';

const [url, out = '/tmp/dino-shots/offline.png'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node scripts/offline-check.mjs <preview url> [out.png]');
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() !== 'log' && console.log('[console]', m.text()));
page.on('requestfailed', (r) => console.log('[failed]', r.url()));

await page.goto(url);
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 }).catch(() => page.reload());
console.log('online: service worker active');

await context.setOffline(true);
await page.goto(new URL('?seed=3&cam=side', url).href);
console.log('offline page:', await page.title(), await page.evaluate(() => [typeof window.__dino, !!navigator.serviceWorker.controller, document.scripts.length].join(' ')));
const snapshot = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  window.__dino.setAutoplay(true);
  return window.__dino.advance(1200);
});
await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log(`offline: phase ${snapshot.phase}, score ${snapshot.score}, page errors ${errors.length}; saved ${out}`);
await browser.close();
process.exit(errors.length || snapshot.score === 0 ? 1 : 0);
