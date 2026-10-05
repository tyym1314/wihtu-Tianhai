/** PREPARED ONLY until the root agent releases the measurement window.
 * Future invocation: OASIS_MOBILE_LIFECYCLE_RUN=1 node tests/mobile-lifecycle-review.mjs
 * Optional: LIFE_BROWSER=chromium LIFE_GAMES=match,darts LIFE_OUT=/absolute/review/path
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webkit, chromium} from 'playwright';
import {startMobileLifecycleServer, games as allGames} from './mobile-lifecycle-server.mjs';
import {installMobileLifecycleProbe} from './mobile-lifecycle-probe.mjs';

if (process.env.OASIS_MOBILE_LIFECYCLE_RUN !== '1') throw Error('Prepared lifecycle harness: execute only after the performance window is released, with OASIS_MOBILE_LIFECYCLE_RUN=1');
const platform = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.env.LIFE_BROWSER || 'webkit';
assert(['webkit', 'chromium'].includes(engine), 'LIFE_BROWSER must be webkit or chromium');
const selected = process.env.LIFE_GAMES?.split(',') || allGames;
assert(selected.length && new Set(selected).size === selected.length && selected.every(game => allGames.includes(game)), 'Invalid LIFE_GAMES');
const out = resolve(process.env.LIFE_OUT || resolve(platform, 'review/deep-mobile-20260928/eight-game-lifecycle', engine));
const selectors = {match: '.match-board', towerlink: '.tl-world-canvas', carrom: '[data-testid="carrom-board"]', darts: '.da-board', ludo: '.ludo-board', jackaroo: '.jack-board', domino: '.do-chain', pool: '[data-testid="pool-board"]'};
const gestures = {match: '[data-cell="0"]', towerlink: '[data-tower][data-owner="p0"]', carrom: '[data-testid="carrom-board"]', darts: '.da-board', ludo: '[data-pawn-choice]', jackaroo: '.jack-card', domino: '.do-hand>button', pool: '[data-testid="pool-board"]'};
const report = {
  status: 'running', checkedAt: new Date().toISOString(), engine, games: [], errors: [], consoleErrors: [], assetFailures: [], resources: [],
  scope: 'Ten consecutive actual Game mounts/unmounts per game, one document/browser context/React root. Local isolated authority engines; full production CSS and authored images. Counters are functional ownership evidence, not FPS, server load or physical iPhone measurements.',
  visibilityMechanism: 'Synthetic document.hidden/visibilityState plus visibilitychange, to exercise presentation gates; not an OS background/suspension claim.',
  inputMethod: engine === 'chromium' ? 'Trusted native touch through CDP; no synthetic PointerEvent dispatch' : 'Trusted desktop WebKit mouse pointer, representative cancellation only; not iPhone touch',
  unmeasured: ['JavaScript/native heap and GC retention; no forced GC or heap snapshot', 'Production audio owner / AudioContext (silent counted subscriber adapter)', 'Authoritative network disconnect/reconnect and room settlement', 'All gameplay branches: opening boards plus Match accepted cascade and Darts accepted flight are exercised; this is not full rules acceptance'],
  cleanup: {},
};
const failures = [];
function check(condition, message, details) { if (!condition) failures.push({message, ...(details === undefined ? {} : {details})}); return condition; }
let server, browser, context, page;
const pendingAssets = new Set();
const isAsset = request => ['image', 'font'].includes(request.resourceType()) || /\.(?:png|webp|jpe?g|svg|woff2?|glb)(?:\?|$)/i.test(request.url());
const sleep = ms => page.evaluate(ms => window.__mobileLife.settle(ms), ms);
const snap = () => page.evaluate(() => window.__mobileLife.snapshot());
function persistentListeners(snapshot) { return snapshot.listeners.filter(item => !['detached-dom', 'abort-signal'].includes(item.scope)); }
function retiredDelta(snapshot, baseline) {
  const extras = field => snapshot[field].filter(item => !baseline[field].some(base => base.id === item.id));
  const baseListeners = new Set(persistentListeners(baseline).map(item => item.id));
  const liveGL = snapshot.gpu.filter(item => !item.contextLost);
  return {
    raf: extras('raf'), timeouts: extras('timeouts'), intervals: extras('intervals'),
    listeners: persistentListeners(snapshot).filter(item => !baseListeners.has(item.id)),
    observers: Math.max(0, snapshot.observers.length - baseline.observers.length),
    workers: Math.max(0, snapshot.workers.length - baseline.workers.length),
    blobURLs: snapshot.blobURLs.filter(url => !baseline.blobURLs.includes(url)), captures: snapshot.captures,
    liveGL, audioSubscribers: snapshot.audioSubscribers - baseline.audioSubscribers,
    domChildren: snapshot.domChildren, connectedCanvases: snapshot.canvases.filter(item => item.connected),
    cssAnimations: snapshot.cssAnimations.filter(item => item.state !== 'finished'),
    // React installs image/DOM listeners on elements it later detaches. They are
    // separately observed via WeakRef; collection is not manufactured or asserted.
    detachedDOMListeners: snapshot.listeners.filter(item => item.scope === 'detached-dom').length,
    detachedNonReactListeners: snapshot.listeners.filter(item => item.scope === 'detached-dom' && !/react-dom/.test(item.stack || '') && !baseline.listeners.some(base => base.id === item.id)),
    detachedCanvasesObserved: snapshot.canvases.filter(item => !item.connected).length,
  };
}
function lifecycleClean(delta) {
  return ['raf', 'timeouts', 'intervals', 'listeners', 'blobURLs', 'captures', 'liveGL', 'connectedCanvases', 'cssAnimations', 'detachedNonReactListeners'].every(key => delta[key].length === 0) && delta.observers === 0 && delta.workers === 0 && delta.audioSubscribers === 0 && delta.domChildren === 0;
}
async function assetsSettled() {
  const deadline = Date.now() + 22000;
  while (pendingAssets.size && Date.now() < deadline) await sleep(50);
  assert.equal(pendingAssets.size, 0, 'Authored artwork still downloading: ' + [...pendingAssets].map(request => request.url()).join(', '));
  await page.evaluate(async () => { await document.fonts.ready; await window.__mobileLife.nextPaint(); });
}
async function center(selector) {
  const node = page.locator(selector).first(); await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox(); assert(box && box.width > 0 && box.height > 0, 'Visible pointer target ' + selector);
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}
try {
  await mkdir(out, {recursive: true});
  server = await startMobileLifecycleServer();
  browser = engine === 'webkit' ? await webkit.launch({headless: true}) : await chromium.launch({headless: true, ...(process.env.LIFE_CHROME_CHANNEL ? {channel: process.env.LIFE_CHROME_CHANNEL} : {})});
  context = await browser.newContext({viewport: {width: 393, height: 852}, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'no-preference'});
  await context.addInitScript(installMobileLifecycleProbe);
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', request => { if (isAsset(request)) pendingAssets.add(request); });
  page.on('requestfinished', request => { pendingAssets.delete(request); });
  page.on('requestfailed', request => { pendingAssets.delete(request); if (isAsset(request)) report.assetFailures.push({url: request.url(), failure: request.failure()?.errorText}); });
  page.on('response', response => { const request = response.request(); if (isAsset(request)) report.resources.push({url: response.url(), status: response.status(), type: request.resourceType()}); });
  await page.goto(server.url, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => window.__lifeReady === true);
  const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
  const start = async at => { if (cdp) await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{...at, id: 1}]}); else { await page.mouse.move(at.x, at.y); await page.mouse.down(); } };
  const move = async at => { if (cdp) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{...at, id: 1}]}); else await page.mouse.move(at.x, at.y); };
  const end = async () => { if (cdp) await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); else await page.mouse.up(); };
  const cancel = async () => {
    if (cdp) await cdp.send('Input.dispatchTouchEvent', {type: 'touchCancel', touchPoints: []});
    else { await page.evaluate(() => { for (const id of window.__mobileLife.snapshot().captures) for (const node of document.querySelectorAll('*')) if (node.hasPointerCapture?.(id)) node.releasePointerCapture(id); }); await end(); }
  };
  // Every source cache is resolved before the *first* Game mounts. No first-game
  // residue may be silently promoted to the baseline, even when later games run.
  for (const game of selected) await page.evaluate(game => window.mobileLifecycle.prepare(game), game);
  await assetsSettled(); await sleep(300);
  report.retainedArtworkBaseline = await page.evaluate(() => window.mobileLifecycle.retainedCache());
  report.baseline = await snap();
  assert.equal(report.baseline.domChildren, 0);
  report.cachePolicy = 'Successful shared Image promises and Tower five-image map intentionally retain decoded CPU artwork; URLs/dimensions are recorded before any Game mounts. They are not retired per-game objects. Vite/React native subscriptions and the Vite interval are recorded by identity in the empty-root baseline.';
  for (const game of selected) {
    const gameReport = {game, mounts: [], hidden: null, cancellation: null, animation: null, failures: []}; report.games.push(gameReport);
    for (let cycle = 1; cycle <= 10; cycle++) {
      let held = false;
      try {
        const authority = await page.evaluate(({game, cycle}) => window.mobileLifecycle.mount(game, game === 'pool' && cycle === 2 ? 'free' : 'normal'), {game, cycle});
        await page.locator(selectors[game]).waitFor({state: 'visible'});
        await assetsSettled(); await sleep(100);
        const rendered = await snap();
        if (['towerlink', 'carrom', 'pool'].includes(game)) assert(rendered.canvases.some(item => item.connected && item.kind === '2d' && item.width > 100 && item.height > 100 && item.draws > 0), 'Actual Canvas2D board must draw');
        if (game === 'match') { assert.equal(await page.locator('[data-cell]').count(), 36); assert.equal(await page.locator('.match-piece').count(), 36); }
        assert(!rendered.images.some(image => !image.complete || image.width === 0), 'No incomplete DOM images');
        assert.equal(await page.locator('[data-life-error]').count(), 0, 'Actual Game rendered without boundary error');
        const sample = {cycle, authority, rendered, cancellationStage: null}; gameReport.mounts.push(sample);
        if (cycle === 1) {
          await page.screenshot({path: resolve(out, game + '-complete.png'), fullPage: true});
          await page.evaluate(() => window.__mobileLife.visibility(true)); await sleep(160);
          const hidden = await snap();
          await page.evaluate(() => window.__mobileLife.visibility(false)); await sleep(160);
          const resumed = await snap();
          const hiddenRAF = hidden.raf.filter(item => !report.baseline.raf.some(base => base.id === item.id));
          const hiddenIntervals = hidden.intervals.filter(item => !report.baseline.intervals.some(base => base.id === item.id));
          gameReport.hidden = {hidden, resumed, hiddenRAF, hiddenIntervals, passed: hiddenRAF.length === 0 && hiddenIntervals.length === 0};
          check(gameReport.hidden.passed, game + ': hidden presentation must stop game RAF/interval', {hiddenRAF, hiddenIntervals});
          if (['towerlink', 'carrom', 'pool'].includes(game)) check(resumed.raf.length > report.baseline.raf.length, game + ': visible Canvas2D loop resumes');
        }
        if (cycle === 2) {
          const selector = gestures[game];
          if (await page.locator(selector).count()) {
            const before = server.actions.length, point = await center(selector);
            await start(point); held = true;
            if (['match', 'towerlink', 'carrom', 'darts', 'pool'].includes(game)) await move({x: point.x + 12, y: point.y - 10});
            await sleep(30); const beforeCancel = await snap();
            if (['match', 'towerlink', 'carrom', 'darts', 'pool'].includes(game)) check(beforeCancel.captures.length > 0, game + ': cancellation branch starts a real captured gesture');
            await cancel(); held = false; await sleep(40);
            const afterCancel = await snap();
            check(server.actions.length === before, game + ': cancelled pointer must not submit an authority action');
            check(afterCancel.captures.length === 0, game + ': cancellation releases pointer capture');
            // Start again and remove the actual component while the pointer is held.
            await start(point); held = true; await move({x: point.x + 8, y: point.y - 8});
            sample.cancellationStage = await snap();
            gameReport.cancellation = {method: report.inputMethod, beforeCancel, afterCancel, actionCountBefore: before, coversInProgressCapture: beforeCancel.captures.length > 0, scope: 'Native pointer cancellation and pointer held across component unmount; card/pawn taps without capture are identified separately'};
          } else {
            gameReport.cancellation = {status: 'not-covered', reason: 'No opening-state pointer target ' + selector};
            check(false, game + ': cancellation target missing');
          }
        }
        if (cycle === 3 && game === 'match') {
          const legal = authority.legalMove;
          assert(legal && Number.isInteger(legal.from) && Number.isInteger(legal.to), 'Authoritative legal swap exists');
          const before = server.actions.length;
          await page.locator(`[data-cell="${legal.from}"]`).tap();
          await page.locator(`[data-cell="${legal.to}"]`).tap();
          await page.waitForFunction(() => !document.querySelector('.match-board')?.classList.contains('match-phase-idle'));
          gameReport.animation = {kind: 'Accepted engine swap, unmount during actual component cascade', phase: await page.locator('.match-board').getAttribute('class'), resources: await snap(), actions: server.actions.slice(before)};
          assert.equal(server.actions.length, before + 1);
          assert(server.actions.at(-1).accepted, 'Swap accepted by real engine');
        }
        if (cycle === 3 && game === 'darts') {
          // gestureToward spans 400ms; wait within the real authoritative turn.
          await sleep(450);
          const event = await page.evaluate(() => window.mobileLifecycle.authorityAnimation());
          await page.getByTestId('darts-flight').waitFor();
          const first = await page.getByTestId('darts-flight').getAttribute('data-tip-y'); await sleep(45);
          const second = await page.getByTestId('darts-flight').getAttribute('data-tip-y');
          assert.notEqual(first, second, 'Real FlyingDart moves before it is removed');
          gameReport.animation = {kind: 'Real engine accepts recorded gesture; authoritative flight snapshot fed to actual Game; no claim of a UI throw in this lifecycle branch', event, first, second, resources: await snap()};
        }
        if (cycle === 4 && game === 'match') {
          await page.getByRole('button', {name: '给自己加油', exact: true}).tap();
          await page.locator('.match-cheer-reaction').waitFor();
          sample.pendingCheer = await snap();
        }
        const actionCount = server.actions.length;
        await page.evaluate(() => window.mobileLifecycle.unmount());
        sample.immediate = await snap();
        if (held) { await end(); held = false; }
        await sleep(cycle === 3 || cycle === 4 ? 1450 : 220);
        sample.retired = await snap(); sample.delta = retiredDelta(sample.retired, report.baseline);
        sample.callbacksAfterUnmount = await page.evaluate(({sequence, game}) => window.__mobileLife.callbacksSince(sequence).filter(item => item.label?.startsWith(game + ':mount-')), {sequence: sample.immediate.callbackSequence, game});
        sample.actionsAfterUnmount = server.actions.length - actionCount;
        sample.passed = lifecycleClean(sample.delta) && sample.actionsAfterUnmount === 0 && sample.callbacksAfterUnmount.length === 0;
        check(sample.passed, game + ': mount ' + cycle + ' retires resources before context closure', sample.delta);
        check(sample.actionsAfterUnmount === 0, game + ': no authority action after component removal');
        check(sample.callbacksAfterUnmount.length === 0, game + ': no retired game RAF/timer callback executes after component removal', sample.callbacksAfterUnmount);
      } catch (error) {
        gameReport.failures.push({cycle, message: error.message}); check(false, game + ': cycle ' + cycle + ' incomplete', error.message);
        await page.evaluate(() => { window.__mobileLife.visibility(false); window.mobileLifecycle.unmount(); }).catch(() => {});
        if (held) await end().catch(() => {});
        await sleep(250).catch(() => {});
        // Keep running other cycles/games to retain diagnostic evidence. A
        // failed cycle is never counted as one of ten successful mounts.
      }
    }
    gameReport.tenMountsPassed = gameReport.mounts.length === 10 && gameReport.mounts.every(sample => sample.passed);
    gameReport.final = await snap();
    gameReport.gpuScope = gameReport.final.gpu.length ? 'WebGL contexts unexpectedly created: inspect actual ledger; do not claim N/A' : 'No WebGL context was created; Canvas2D/SVG rendering, GPU handle cleanup not applicable';
    await writeFile(resolve(out, game + '.json'), JSON.stringify(gameReport, null, 2));
  }
  report.finalBeforeClosingAnything = await snap();
  report.inputs = await page.evaluate(() => window.__mobileLife.inputs);
  report.renderErrors = await page.evaluate(() => window.mobileLifecycle.renderErrors);
  report.authorityActions = server.actions;
  check(report.inputs.some(event => event.trusted), 'Trusted pointer input actually occurred');
  check(report.errors.length === 0 && report.renderErrors.length === 0, 'No page or React render errors', [...report.errors, ...report.renderErrors]);
  check(report.consoleErrors.length === 0, 'No console errors', report.consoleErrors);
  check(report.assetFailures.length === 0 && report.resources.every(resource => resource.status < 400), 'Every actual artwork request succeeded', report.assetFailures);
  check(lifecycleClean(retiredDelta(report.finalBeforeClosingAnything, report.baseline)), 'Final resource state is clean while the original page/context/server remain alive');
  report.lifecyclePassed = report.games.length === selected.length && report.games.every(game => game.tenMountsPassed) && report.errors.length === 0 && report.renderErrors.length === 0;
  report.passed = failures.length === 0; report.status = report.passed ? 'passed' : 'failed';
  report.measurementFinishedBeforeBrowserClose = true;
} catch (error) { failures.push({message: error.message, stack: error.stack}); report.status = 'failed'; report.passed = false; }
finally {
  // Teardown is recorded separately; it cannot make a resource assertion pass.
  try { await context?.close(); report.cleanup.contextClosed = true; } catch (error) { report.cleanup.contextError = error.message; }
  try { await browser?.close(); report.cleanup.browserClosed = true; } catch (error) { report.cleanup.browserError = error.message; }
  try { await server?.close(); report.cleanup.serverClosed = true; report.cleanup.privateViteCacheRemoved = true; } catch (error) { report.cleanup.serverError = error.message; }
  report.failures = failures;
  report.preparationFiles = {};
  for (const name of ['probe.mjs', 'fixture.jsx', 'server.mjs', 'review.mjs']) {
    const path = resolve(platform, 'tests/mobile-lifecycle-' + name);
    report.preparationFiles['tests/mobile-lifecycle-' + name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  await mkdir(out, {recursive: true}); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: report.status, lifecyclePassed: report.lifecyclePassed, failures, report: resolve(out, 'report.json'), cleanup: report.cleanup}, null, 2));
  if (!report.passed) process.exitCode = 1;
}
