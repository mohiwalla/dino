// End-to-end playtest against an already running server (dev or preview).
//
//   node scripts/playtest.mjs http://localhost:4173 [outDir]
//
// Drives the game through window.__dino: title, a real Space jump, then (frozen, autopilot)
// the first cacti, pterodactyls and night in every camera mode, a forced crash, and a few
// phone-sized shots. Fails (exit 1) on any page error or console error.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2];
const outDir = process.argv[3] ?? '/tmp/dino-shots/playtest';
if (!base) {
  console.error('usage: node scripts/playtest.mjs <base url> [outDir]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const MODES = ['cinematic', 'side', 'chase'];
const SETTLE_MS = 1600;
const errors = [];
const phases = new Set();
const stats = [];

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

function url(query) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

async function openPage(name, contextOptions) {
  const context = await browser.newContext({ deviceScaleFactor: 1, ...contextOptions });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] console.error: ${m.text()}`);
    else if (m.type() === 'warning') console.log(`[${name}] console.warn: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.stack || e.message}`));
  await page.goto(url({ seed: '7' }), { waitUntil: 'load' });
  await page.waitForFunction(() => '__dino' in window);
  await page.waitForTimeout(1500);
  return { context, page };
}

async function shot(page, file) {
  const path = `${outDir}/${file}.png`;
  await page.screenshot({ path });
  const info = await page.evaluate(() => window.__dino.info);
  const s = await snapshot(page);
  stats.push({ file, phase: s.phase, score: s.score, speed: +s.speed.toFixed(2), night: +s.night.toFixed(2), ...info });
  phases.add(s.phase);
  console.log(`saved ${path}  phase=${s.phase} score=${s.score} tris=${info.triangles} calls=${info.calls}`);
}

function snapshot(page) {
  return page.evaluate(() => window.__dino.getSnapshot());
}

/**
 * Advance (frozen, autopilot) in chunks until `pred(snapshot)` is true. `pred` is a source
 * string evaluated in the page, so it can use the snapshot's fields directly.
 */
async function advanceUntil(page, pred, { chunk = 30, max = 60000 } = {}) {
  const ok = await page.evaluate(
    ({ pred, chunk, max }) => {
      const test = new Function('s', `return (${pred});`);
      for (let n = 0; n < max; n += chunk) {
        const s = window.__dino.getSnapshot();
        if (test(s)) return true;
        window.__dino.advance(chunk);
      }
      return false;
    },
    { pred, chunk, max },
  );
  if (!ok) throw new Error(`never reached: ${pred}`);
  return snapshot(page);
}

async function allModes(page, name) {
  for (const mode of MODES) {
    await page.evaluate((m) => window.__dino.setCameraMode(m), mode);
    await page.waitForTimeout(SETTLE_MS);
    await shot(page, `${name}-${mode}`);
  }
  await page.evaluate(() => window.__dino.setCameraMode('cinematic'));
}

/** An obstacle of `kind` sitting between the T-Rex and ~450 px ahead, so every camera sees it. */
const inView = (kind) => `s.obstacles.some(o => ${kind} && o.x > 140 && o.x < 420)`;

async function desktop() {
  const { context, page } = await openPage('desktop', { viewport: { width: 1280, height: 720 } });
  await shot(page, '01-title');

  await page.keyboard.down('Space');
  await page.waitForFunction(() => window.__dino.getSnapshot().trex.y > 45, null, { timeout: 5000 });
  await shot(page, '02-jump');
  await page.keyboard.up('Space');

  await page.evaluate(() => {
    window.__dino.freeze(true);
    window.__dino.setAutoplay(true);
  });
  await advanceUntil(page, inView("o.kind !== 'pterodactyl'"), { chunk: 4 });
  await allModes(page, '03-cacti');

  await advanceUntil(page, 's.speed >= 8.5', { chunk: 60 });
  await advanceUntil(page, inView("o.kind === 'pterodactyl'"), { chunk: 4 });
  await allModes(page, '04-ptero');

  await advanceUntil(page, 's.score >= 700 && s.night >= 1', { chunk: 60 });
  await advanceUntil(page, inView('true'), { chunk: 4 });
  await allModes(page, '05-night');

  await page.evaluate(() => window.__dino.setAutoplay(false));
  await advanceUntil(page, "s.phase === 'crashed'", { chunk: 1, max: 5000 });
  await page.evaluate(() => window.__dino.advance(60));
  await page.waitForTimeout(900);
  await shot(page, '06-gameover');
  await page.evaluate(() => window.__dino.setCameraMode('side'));
  await page.waitForTimeout(SETTLE_MS);
  await shot(page, '06-gameover-side');

  const final = await snapshot(page);
  await context.close();
  return final;
}

async function mobile() {
  const { context, page } = await openPage('mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await shot(page, '10-m-title');
  await page.touchscreen.tap(195, 600);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__dino.freeze(true);
    window.__dino.setAutoplay(true);
  });
  await advanceUntil(page, inView("o.kind !== 'pterodactyl'"), { chunk: 4 });
  await page.waitForTimeout(SETTLE_MS);
  await shot(page, '11-m-cacti-cinematic');
  await page.evaluate(() => window.__dino.setCameraMode('chase'));
  await page.waitForTimeout(SETTLE_MS);
  await shot(page, '12-m-cacti-chase');
  await page.evaluate(() => window.__dino.setAutoplay(false));
  await advanceUntil(page, "s.phase === 'crashed'", { chunk: 1, max: 5000 });
  await page.evaluate(() => window.__dino.advance(60));
  await page.waitForTimeout(900);
  await shot(page, '13-m-gameover');
  await context.close();
}

let failed = false;
let final = null;
try {
  final = await desktop();
  await mobile();
} catch (e) {
  failed = true;
  errors.push(`script: ${e.stack || e.message}`);
}
await browser.close();

const maxTris = Math.max(...stats.map((s) => s.triangles));
const maxCalls = Math.max(...stats.map((s) => s.calls));
console.log('\n── summary ──');
console.log(`score reached: ${final ? final.score : '?'} (high ${final ? final.highScore : '?'})`);
console.log(`phases seen: ${[...phases].join(', ')}`);
console.log(`triangles max ${maxTris}, draw calls max ${maxCalls}`);
console.table(stats);
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors) console.log(e);
}
process.exit(failed || errors.length ? 1 : 0);
