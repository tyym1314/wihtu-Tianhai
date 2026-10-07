import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, extname, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';

const platform = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'domino-render-cadence-'));
const baseline = process.env.DOMINO_BASELINE === '1';
const baselineRevision = '063063c41fb99c298b92a699501d76955677a6e0';
const plugin = {name: 'static-image-url', setup(bundler) {
  bundler.onLoad({filter: /\.[cm]?[jt]sx?$/}, async args => {
    if (!args.path.startsWith(join(platform, 'arena') + sep)) return;
    const source = baseline && args.path === join(platform, 'arena/domino/DominoGame.jsx')
      ? execFileSync('git', ['show', `${baselineRevision}:platform/arena/domino/DominoGame.jsx`], {cwd: platform, encoding: 'utf8'})
      : await readFile(args.path, 'utf8');
    const imports = [];
    const contents = source.replace(/new URL\(\s*(['"])(\.{1,2}\/[^'"]+\.(?:png|webp|jpe?g|svg))\1\s*,\s*import\.meta\.url\s*\)\.href/g,
      (_match, _quote, path) => { const variable = `__asset${imports.length}`; imports.push(`import ${variable} from ${JSON.stringify(path)};`); return variable; });
    return {contents: imports.join('\n') + '\n' + contents, loader: args.path.endsWith('x') ? 'jsx' : 'js', resolveDir: dirname(args.path)};
  });
}};
const bundled = await build({absWorkingDir: platform, entryPoints: ['arena/domino/performance-fixture.jsx'],
  outfile: join(temporary, 'bundle.js'), bundle: true, format: 'esm', jsx: 'automatic', metafile: true,
  assetNames: 'assets/[name]-[hash]', publicPath: '/', loader: {'.png': 'file', '.webp': 'file', '.jpg': 'file', '.jpeg': 'file', '.svg': 'file'}, plugins: [plugin]});
const files = new Map(Object.keys(bundled.metafile.outputs).map(path => {
  const absolute = resolve(platform, path);
  return ['/' + relative(temporary, absolute).split(sep).join('/'), absolute];
}));
const mime = {'.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml'};
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script>'); return; }
  const file = files.get(path);
  if (!file) { response.statusCode = 404; response.end('Not found'); return; }
  response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); response.end(await readFile(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
  const errors = [], resourceErrors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('requestfailed', request => resourceErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) resourceErrors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.do-chain [data-tile]').first().waitFor();
  assert.equal(await page.locator('.do-chain [data-tile]').count(), 20);
  await page.waitForTimeout(500);
  const countdownBefore = Number((await page.locator('.do-turn-banner b').innerText()).replace('s',''));
  await page.evaluate(() => window.dominoPerformance.start());
  await page.waitForTimeout(5000);
  const sample = await page.evaluate(() => window.dominoPerformance.stop());
  const countdownAfter = Number((await page.locator('.do-turn-banner b').innerText()).replace('s',''));
  assert(countdownBefore - countdownAfter >= 4 && countdownBefore - countdownAfter <= 6, 'turn countdown advances correctly');
  const intervals = sample.frames.slice(1).map((at, index) => at - sample.frames[index]).sort((a,b) => a-b);
  if (await page.locator('.do-hand>button.is-legal').count()) await page.locator('.do-hand>button.is-legal').first().click();
  const actionButtons = page.locator('.do-actions button');
  const enabled = await actionButtons.evaluateAll(buttons => buttons.findIndex(button => !button.disabled));
  assert(enabled >= 0, 'fixture exposes a legal action');
  const action = actionButtons.nth(enabled);
  const start = await page.evaluate(() => window.dominoPerformance.setBusy(420));
  assert.equal(await action.isDisabled(), true);
  await action.waitFor({state: 'visible'});
  await page.waitForFunction(index => !document.querySelectorAll('.do-actions button')[index]?.disabled, enabled, {timeout: 1200});
  const unlockDelay = await page.evaluate(start => performance.now() - start, start);
  assert(unlockDelay >= 390 && unlockDelay < 1000, `busy action unlock time ${unlockDelay}ms`);
  assert.deepEqual(errors, []);
  assert.deepEqual(resourceErrors, []);
  if (!baseline) assert(sample.commits.length <= 18, 'idle clock should not re-render the whole board every 80ms');
  const result = {environment: 'local Chromium 390x844 DPR2 touch, idle 20-tile Domino fixture, 5 seconds',
    variant: baseline ? `${baselineRevision} baseline` : 'working-tree candidate', countdownBefore, countdownAfter,
    commits: sample.commits.length, reactDurationMs: sample.commits.reduce((sum, item) => sum + item.actualDuration, 0),
    frames: intervals.length, frameP95Ms: intervals[Math.ceil(intervals.length * .95) - 1],
    frameP99Ms: intervals[Math.ceil(intervals.length * .99) - 1], frameMaxMs: intervals.at(-1),
    unlockDelayMs: unlockDelay, pageErrors: errors, resourceErrors};
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
