/**
 * Real Tower Link lobby/training browser acceptance, entirely on disposable
 * loopback infrastructure. Does not mutate a deployed API or existing database.
 * Build arena first. Run normally for a report, or --serve for a manual free
 * training host (Ctrl-C stops both servers and drops only the owned database).
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import pg from 'pg';
import {chromium} from 'playwright';
import {createPartnerHost} from '../specs/examples/partner-host/server.mjs';
import {TRAINING_LESSONS} from '../arena/towerlink/training.mjs';
import {playOneArenaAction} from './android-game-actions.mjs';
import {provisionWallet} from '../server/wallet/index.mjs';

const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--serve') && args.length <= 1,
  'Usage: node scripts/review-towerlink-platform.mjs [--serve]');
const serveOnly = args.includes('--serve');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'review/towerlink-v2-platform');
const databaseName = `oasis_tower_ui_${process.pid}_${randomBytes(5).toString('hex')}`;
const adminURL = new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL || 'postgres://oasis_local@127.0.0.1:5487/postgres');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(adminURL.hostname), 'LOCAL_POSTGRES_REQUIRED');
adminURL.pathname = '/postgres';
const databaseURL = new URL(adminURL); databaseURL.pathname = '/' + databaseName;
const admin = new pg.Pool({connectionString: adminURL.href, max: 1});
const report = {
  schema_version: 1, started_at: new Date().toISOString(), passed: false,
  scope: 'Actual partner sample host, signed launch, built arena shell, real API, authoritative clock and disposable PostgreSQL. Desktop Chromium mobile emulation only; not physical-device, production-wallet or capacity acceptance.',
  isolation: {database: databaseName, public_services_used: false, balances: 'zero; free training only'},
  checks: [], screenshots: [], actions: [], page_errors: [], failed_assets: [], http_errors: [], cleanup: {},
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestID = () => 'tower_ui_' + randomUUID().replaceAll('-', '');
const terminal = room => room && ['settled', 'cancelled', 'voided'].includes(room.status);
const reviewUser = 'tower_training_player';
let db, createdDB = false, privateDir, child, childExit, hostServer, browser, context, page;
let api, host, app, token, latestRoom, frame, closing = false;
const rooms = new Map(), pendingResponses = new Set();
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw new Error('Timeout: ' + label);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function request(path, {method = 'GET', body, cookie, bearer} = {}) {
  const response = await fetch(api + path, {method, headers: {
    origin: api, 'content-type': 'application/json', ...(cookie ? {cookie} : {}),
    ...(bearer ? {authorization: 'Bearer ' + bearer} : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)});
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${value.error?.code || value.code || ''}`);
  return {value, response};
}
async function walletEvidence() {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM wallet_operations o JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) operations,
    (SELECT count(*)::int FROM wallet_ledger l JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) ledger_rows,
    (SELECT count(*)::int FROM wallet_matches m JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) matches,
    (SELECT count(*)::int FROM wallet_reservations r JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) reservations,
    (SELECT coalesce(sum(u.available),0)::text FROM wallet_users u JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) available,
    (SELECT coalesce(sum(u.reserved),0)::text FROM wallet_users u JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) reserved,
    (SELECT u.available::text FROM wallet_users u JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1 AND u.external_user_id=$2) review_user_available,
    (SELECT coalesce(sum(l.delta_available+l.delta_reserved),0)::text FROM wallet_ledger l JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1) ledger_sum`, [app.id, reviewUser])).rows[0];
}
async function setup() {
  // Missing/stale builds fail in the real UI; this script never substitutes a fixture.
  await readFile(resolve(root, 'arena/dist/index.html'));
  await mkdir(out, {recursive: true});
  privateDir = await mkdtemp(resolve(tmpdir(), 'oasis-tower-ui-'));
  await admin.query(`CREATE DATABASE "${databaseName}"`); createdDB = true;
  db = new pg.Pool({connectionString: databaseURL.href, max: 2});
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, databaseName);
  const ports = new Set(); while (ports.size < 3) ports.add(await freePort());
  const [apiPort, walletPort, hostPort] = [...ports];
  api = `http://127.0.0.1:${apiPort}`; host = `http://127.0.0.1:${hostPort}`;
  report.isolation.api_origin = api; report.isolation.host_origin = host;
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.mjs'], {cwd: root, env: {
    ...process.env, OASIS_ENVIRONMENT: 'sandbox', OASIS_DATABASE_URL: databaseURL.href,
    OASIS_LOCAL_DIR: privateDir, OASIS_PUBLIC_ORIGIN: api, OASIS_API_PORT: String(apiPort),
    OASIS_WALLET_PORT: String(walletPort), OASIS_START_WALLET: '1',
    OASIS_REFERENCE_WALLET_URL: `http://127.0.0.1:${walletPort}`,
    OASIS_WALLET_ALLOWED_ORIGINS: `http://127.0.0.1:${walletPort}`, OASIS_TRUST_LOOPBACK_PROXY: '0',
  }, stdio: ['ignore', 'ignore', 'pipe']});
  // Do not print startup credentials or any launch/access tokens.
  child.stderr.resume(); childExit = new Promise(resolve => child.once('exit', resolve));
  await until(async () => {
    assert.equal(child.exitCode, null, 'ISOLATED_API_EXITED');
    try { return (await fetch(api + '/health', {signal: AbortSignal.timeout(1000)})).ok; } catch { return false; }
  }, 'isolated API health');
  const credentials = JSON.parse(await readFile(resolve(privateDir, 'development-credentials.json'), 'utf8'));
  const login = await request('/api/admin/login', {method: 'POST', body: {username: credentials.username, password: credentials.password}});
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const created = (await request('/api/admin/apps', {method: 'POST', cookie, body: {name: 'Tower training browser QA'}})).value;
  app = created.app;
  await request(`/api/admin/apps/${app.id}`, {method: 'PATCH', cookie, body: {game_ids: ['towerlink']}});
  await request(`/api/admin/apps/${app.id}/integration/origins`, {method: 'POST', cookie, body: {allowed_origins: [host]}});
  const scope = {partner_id: app.partner_id, app_id: app.id, environment: 'sandbox', wallet_scope_id: app.wallet_scope_id, currency_id: app.currency_id};
  // Provision a new zero-coin identity through the reference-wallet initializer;
  // never rewrite existing balances, clock, room state or ledger for a test pass.
  const walletKey = (await db.query('SELECT k.key_id,k.secret_base64 FROM wallet_keys k JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=$1 AND k.active', [app.id])).rows[0];
  await provisionWallet(db, {scope, ...walletKey, treasury_minor: '0', users: [{external_user_id: reviewUser, balance_minor: '0'}]});
  hostServer = await createPartnerHost({platform_base_url: api, host_origin: host, external_user_id: reviewUser,
    key_id: created.credentials.key_id, secret_base64: created.credentials.secret_base64, scope});
  await new Promise((resolve, reject) => { hostServer.once('error', reject); hostServer.listen(hostPort, '127.0.0.1', resolve); });
  report.app_id = app.id; report.source_sha256 = {};
  for (const filename of ['arena/main.jsx', 'arena/towerlink/engine.mjs', 'arena/towerlink/training.mjs', 'arena/dist/index.html', 'scripts/android-game-actions.mjs']) {
    report.source_sha256[filename] = createHash('sha256').update(await readFile(resolve(root, filename))).digest('hex');
  }
  report.wallet_before = await walletEvidence();
}
function adopt(value) {
  const room = value.room || value;
  if (!room.id || !room.game_id) return;
  const previous = rooms.get(room.id);
  if (!previous || room.version >= previous.version) {
    rooms.set(room.id, room);
    if (!latestRoom || latestRoom.id === room.id || Number(room.created_at) >= Number(latestRoom.created_at)) latestRoom = room;
  }
}
async function observe(response) {
  const url = new URL(response.url()), pathname = url.pathname;
  if (response.status() >= 400 && /\.(png|webp|js|mjs|css|svg)$/.test(pathname)) report.failed_assets.push({path: pathname, status: response.status()});
  if (url.origin !== api) return;
  if (response.status() >= 400) report.http_errors.push({path: pathname, status: response.status()});
  if (!response.ok()) return;
  if (pathname === '/v1/launch/exchange') {
    const body = await response.json(); assert.equal(body.scope.app_id, app.id);
    assert.equal(body.external_user_id, reviewUser); token = body.access_token;
    report.session_id = body.session_id; report.launch_exchange_count = (report.launch_exchange_count || 0) + 1;
  }
  if (pathname.startsWith('/api/pvp/rooms')) {
    const body = await response.json(); adopt(body);
    if (pathname === '/api/pvp/rooms' && response.request().method() === 'POST') latestRoom = body.room || body;
    if (pathname.endsWith('/action')) report.actions.push({room_id: (body.room || body).id, action: response.request().postDataJSON().action, seq: (body.room || body).me_last_seq});
  }
}
async function screenshot(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ': host horizontal overflow');
  if (frame && !frame.isDetached()) assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ': game horizontal overflow');
  await page.screenshot({path: resolve(out, name + '.png'), fullPage: true}); report.screenshots.push(name + '.png');
}
async function enterGame() {
  await page.locator('[data-game="towerlink"]').click();
  await page.locator('#connection').filter({hasText: '已连接'}).waitFor({timeout: 30000});
  frame = page.frames().find(item => item.url() === api + '/play/towerlink'); assert.ok(frame);
  await frame.locator('.lobby-settings').waitFor();
  await until(() => frame.getByRole('button', {name: /策略训练/}).isEnabled(), 'real battlefield preload');
}
async function verifyTrainingRoom(lessonId, previousId) {
  await until(() => latestRoom?.training_lesson_id === lessonId && latestRoom.id !== previousId && latestRoom.status === 'active', lessonId + ' new active room');
  const room = latestRoom; assert.equal(room.practice, true); assert.equal(room.room_mode, 'practice');
  assert.equal(room.entry_minor, '0'); assert.equal(room.prize_minor, '0'); assert.equal(room.fee_bps, 0);
  assert.equal(room.game.training.lessonId, lessonId); assert.match(room.game.ruleVersion, /^towerlink-v2\./);
  assert.equal(room.game.players.filter(player => !player.isBot).length, 1);
  assert.equal(room.game.players.find(player => !player.isBot).seatIndex, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM pvp_active_users WHERE app_id=$1', [app.id])).rows[0].n, 1);
  return room.id;
}
async function completeFirstLesson(label) {
  await frame.locator('[data-testid="towerlink-game"][data-state="active"]').waitFor({timeout: 15000});
  assert.equal(latestRoom.game.training.lessonId, 'lesson-01');
  const action = await playOneArenaAction(frame, 'towerlink', () => latestRoom);
  assert.equal(action.towerEvidence.to, latestRoom.game.training.markers[0].towerId);
  report.checks.push({name: label + ': drag creates standing route and real marching troops', evidence: action});
  await screenshot(label + '-marching');
  await until(() => latestRoom?.status === 'settled' && latestRoom.game.training.completed, label + ' authoritative teaching goal', 35000);
  const finished = latestRoom;
  assert.ok(finished.game.training.progress.every(step => step.done && step.current >= step.target));
  assert.equal(finished.game.training.nextLessonId, 'lesson-02');
  assert.equal(finished.game.finishReason, 'training-complete');
  await frame.getByRole('button', {name: '下一关', exact: true}).waitFor({timeout: 12000});
  await frame.getByRole('button', {name: '重试本关', exact: true}).waitFor();
  assert.match(await frame.locator('body').innerText(), /TRAINING CLEAR/);
  const key = `oasis:tower-training:${app.id}:${reviewUser}`;
  assert.deepEqual(await frame.evaluate(key => JSON.parse(localStorage.getItem(key)), key), ['lesson-01']);
  assert.equal(await frame.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('oasis:tower-training:undefined:'))), false);
  assert.equal((await db.query('SELECT count(*)::int n FROM pvp_active_users WHERE app_id=$1', [app.id])).rows[0].n, 0);
  report.checks.push({name: label + ': server-completed progress, correct App storage and released seat', room_id: finished.id, training: finished.game.training});
  await screenshot(label + '-completed'); return finished.id;
}
async function browserReview() {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  page = await context.newPage();
  page.on('pageerror', error => report.page_errors.push(error.message));
  page.on('response', response => {
    const task = observe(response).catch(error => report.page_errors.push(error.message));
    pendingResponses.add(task); task.finally(() => pendingResponses.delete(task));
  });
  await page.goto(host);
  await page.locator('[data-game="towerlink"]').waitFor();
  assert.equal(await page.locator('[data-game]').count(), 1); await screenshot('platform-01-partner-lobby');
  await enterGame(); await screenshot('platform-02-game-lobby');
  await frame.getByRole('button', {name: /策略训练/}).click();
  const dialog = frame.getByRole('dialog', {name: '策略训练选关'}); await dialog.waitFor();
  const labels = await dialog.locator('.tower-training-list strong').allTextContents();
  assert.deepEqual(labels, TRAINING_LESSONS.map(lesson => lesson.title));
  assert.equal(await dialog.locator('.tower-training-list button').count(), 12);
  report.checks.push({name: 'All 12 real training lessons in actual platform shell', lessons: labels});
  await screenshot('platform-03-twelve-lessons');
  await dialog.locator('.tower-training-list button').first().click();
  const firstID = await verifyTrainingRoom('lesson-01');
  await frame.locator('[data-testid="towerlink-game"][data-state="countdown"]').waitFor({timeout: 5000});
  await screenshot('platform-04-countdown');
  assert.equal(await frame.locator('.tl-training-mission strong').innerText(), TRAINING_LESSONS[0].title);
  await completeFirstLesson('platform-05-first');
  await frame.getByRole('button', {name: '重试本关', exact: true}).click();
  const retryID = await verifyTrainingRoom('lesson-01', firstID);
  assert.equal(latestRoom.game.training.completed, false);
  assert.ok(latestRoom.game.training.progress.every(step => step.current === 0));
  report.checks.push({name: 'Retry creates a new zero-entry room and resets authoritative objective', previous_room: firstID, room_id: retryID});
  await screenshot('platform-06-retry');
  await completeFirstLesson('platform-07-retry');
  await frame.getByRole('button', {name: '下一关', exact: true}).click();
  const nextID = await verifyTrainingRoom('lesson-02', retryID);
  assert.equal(latestRoom.game.training.completed, false);
  await frame.locator('.tl-training-mission strong').filter({hasText: TRAINING_LESSONS[1].title}).waitFor();
  report.checks.push({name: 'Next lesson directly starts lesson 02 in a fresh free practice room', previous_room: retryID, room_id: nextID});
  await screenshot('platform-08-next-lesson');
  // Exit through the actual partner-back/confirm protocol, not a DB edit.
  await page.locator('#back').click();
  await frame.getByRole('button', {name: '确认离开', exact: true}).click();
  await page.locator('#home').waitFor({state: 'visible'});
  await until(async () => (await db.query('SELECT count(*)::int n FROM pvp_active_users WHERE app_id=$1', [app.id])).rows[0].n === 0, 'training exit releases seat');
  assert.equal(await page.locator('iframe').count(), 0);
  frame = null; latestRoom = null;
  await enterGame();
  assert.match(await frame.getByRole('button', {name: /策略训练/}).innerText(), /1 \/ 12 已完成/);
  await frame.getByRole('button', {name: /策略训练/}).click();
  await screenshot('platform-09-persisted-progress');
  await frame.getByRole('button', {name: '关闭选关', exact: true}).click();
  await page.locator('#back').click(); await page.locator('#home').waitFor({state: 'visible'}); frame = null;
  await Promise.all([...pendingResponses]);
  report.rooms = (await db.query('SELECT id, status, practice, entry_minor, game_options, result FROM pvp_rooms WHERE app_id=$1 ORDER BY created_at', [app.id])).rows;
  assert.equal(report.rooms.length, 3);
  assert.deepEqual(report.rooms.map(room => room.status), ['settled', 'settled', 'cancelled']);
  assert.ok(report.rooms.every(room => room.practice && room.entry_minor === '0'));
  report.wallet_after = await walletEvidence(); assert.deepEqual(report.wallet_after, report.wallet_before);
  assert.equal(report.wallet_after.operations, 0); assert.equal(report.wallet_after.matches, 0); assert.equal(report.wallet_after.reservations, 0);
  assert.equal(report.wallet_after.review_user_available, '0'); assert.equal(report.wallet_after.ledger_sum, '0');
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.failed_assets, []); assert.deepEqual(report.http_errors, []);
  report.checks.push({name: 'UI cancellation, relaunch progress, no hanging seat and no wallet operations', passed: true});
  report.passed = true;
}
async function cleanup() {
  if (closing) return; closing = true;
  if (db && app && token && child?.exitCode === null) {
    const active = (await db.query("SELECT id FROM pvp_rooms WHERE app_id=$1 AND status NOT IN ('settled','voided','cancelled')", [app.id])).rows;
    for (const room of active) await request(`/api/pvp/rooms/${room.id}/leave`, {method: 'POST', bearer: token, body: {request_id: requestID()}}).catch(() => {});
  }
  await context?.close(); await browser?.close();
  if (hostServer?.listening) await new Promise(resolve => { hostServer.close(resolve); hostServer.closeAllConnections(); });
  if (child?.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await childExit; } finally { clearTimeout(timer); }
  }
  report.cleanup.servers_stopped = !child || child.exitCode !== null || child.signalCode !== null;
  await db?.end();
  if (createdDB) {
    assert.match(databaseName, /^oasis_tower_ui_\d+_[a-f0-9]{10}$/);
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    report.cleanup.database_dropped = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount === 0;
  }
  await admin.end();
  if (privateDir) { await rm(privateDir, {recursive: true, force: true}); report.cleanup.private_directory_removed = true; }
}
try {
  await setup();
  if (serveOnly) {
    const manual = {url: host, pid: process.pid, database: databaseName, app_id: app.id, mode: 'FREE TRAINING ONLY',
      instructions: 'Open Tower Link, then 策略训练. This isolated account has zero coins. Ctrl-C cleans up the server and owned database.', started_at: report.started_at};
    await writeFile(resolve(out, 'manual-server.json'), JSON.stringify(manual, null, 2) + '\n');
    console.log(JSON.stringify(manual, null, 2));
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else await browserReview();
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  try { await page?.screenshot({path: resolve(out, 'platform-failure.png'), fullPage: true}); } catch {}
} finally {
  try { await cleanup(); } catch (error) { report.cleanup.error = error.message; process.exitCode = 1; report.passed = false; }
  report.finished_at = new Date().toISOString();
  await mkdir(out, {recursive: true});
  await writeFile(resolve(out, serveOnly ? 'manual-server-stopped.json' : 'browser-integration.json'), JSON.stringify(report, null, 2) + '\n');
  if (!serveOnly) console.log(JSON.stringify({report: resolve(out, 'browser-integration.json'), passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup}, null, 2));
}
