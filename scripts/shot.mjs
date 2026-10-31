// Headless screenshot / probe tool shared by everyone working on the game.
//
//   node scripts/shot.mjs <url> <out.png> [options]
//
//   --size 1280x720       viewport (default 1280x720)
//   --wait 1500           ms to wait after load before acting (default 1500)
//   --eval "<js>"         run JS in the page after the wait (may return a value / promise); printed as JSON
//   --after 500           ms to wait after --eval before the screenshot (default 300)
//   --mobile              emulate a touch phone (390x844, hasTouch, isMobile)
//   --shots 3 --every 400 take N screenshots spaced by ms: out-1.png, out-2.png, ...
//   --press "Space"       press a key before --eval (repeatable via comma: "Space,ArrowDown")
//
// Prints console errors/warnings and page errors. Exit code 2 if any page error happened.
import { chromium } from 'playwright';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--size WxH] [--wait ms] [--eval js] [--after ms] [--mobile] [--shots n --every ms] [--press keys]');
  process.exit(1);
}
const opt = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
};
const flag = (name) => rest.includes(`--${name}`);

const mobile = flag('mobile');
const [w, h] = (opt('size', mobile ? '390x844' : '1280x720')).split('x').map(Number);
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: w, height: h },
  deviceScaleFactor: 1,
  hasTouch: mobile,
  isMobile: mobile,
});
const page = await context.newPage();
let pageErrors = 0;
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => {
  pageErrors++;
  console.log(`[pageerror] ${e.stack || e.message}`);
});

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(opt('wait', '1500')));
const press = opt('press', '');
if (press) for (const k of press.split(',')) await page.keyboard.press(k);
const js = opt('eval', '');
if (js) {
  const result = await page.evaluate(`(async () => { ${js.includes('return') ? js : `return (${js})`} })()`);
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  await page.waitForTimeout(Number(opt('after', '300')));
}
const shots = Number(opt('shots', '1'));
const every = Number(opt('every', '400'));
for (let i = 1; i <= shots; i++) {
  const file = shots === 1 ? out : out.replace(/(\.png)?$/, `-${i}.png`);
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
  if (i < shots) await page.waitForTimeout(every);
}
await browser.close();
process.exit(pageErrors ? 2 : 0);
