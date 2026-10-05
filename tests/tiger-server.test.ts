import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTigerHandler, type TigerHandlerOptions } from '../server/tiger.js';
import { generateTigerRound } from '../src/tiger/math.js';
import type { TigerRoundInput, TigerRoundResult } from '../src/tiger/types.js';

function outcome(input: TigerRoundInput, win = 0): TigerRoundResult {
  const round = generateTigerRound(input, () => 99);
  return { ...round, totalWin: win };
}
async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function setup(t: TestContext, roundGenerator: TigerHandlerOptions['roundGenerator'] = input => outcome(input)) {
  const directory = await mkdtemp(join(tmpdir(), 'tiger-server-test-'));
  const servers: Server[] = [];
  const options = { storePath: join(directory, 'sessions.json'), roundGenerator };
  async function boot() {
    const handle = await createTigerHandler(options);
    const server = createServer((req, res) => { void handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function request(path: string, body?: unknown, cookie?: string) {
      const response = await fetch(`${base}/api/tiger/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    return { server, base, request };
  }
  t.after(async () => { for (const server of servers) await close(server); await rm(directory, { recursive: true, force: true }); });
  return { ...await boot(), boot };
}

test('Tiger API concurrent same-request retries settle exactly once, including a stale version retry', async t => {
  let calls = 0;
  const app = await setup(t, input => { calls++; return outcome(input, 2500); });
  const start = await app.request('session');
  assert.match(start.cookie!, /^tiger_demo_sid=/);
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.request('spin', { requestId: 'tiger-retry-001', bet: 100, expectedVersion: 0 }, start.cookie)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.data.session.balance, 11925);
    assert.equal(response.data.round.win, 25);
    assert.equal(response.data.round.id, responses[0].data.round.id);
  }
  assert.equal(calls, 1);
  const conflict = await app.request('spin', { requestId: 'tiger-retry-001', bet: 200, expectedVersion: 0 }, start.cookie);
  assert.equal(conflict.data.error.code, 'REQUEST_CONFLICT');
  assert.equal((await app.request('history', undefined, start.cookie)).data.rounds.length, 1);
});

test('Tiger API serialized distinct requests cannot double-spend before acknowledgement', async t => {
  const app = await setup(t);
  const start = await app.request('session');
  const responses = await Promise.all(['tiger-first-001', 'tiger-second-002'].map(requestId => app.request('spin', { requestId, bet: 100, expectedVersion: 0 }, start.cookie)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const first = responses.find(response => response.status === 200)!;
  const pending = await app.request('spin', { requestId: 'tiger-pending-003', bet: 100, expectedVersion: 1 }, start.cookie);
  assert.equal(pending.data.error.code, 'ROUND_PENDING');
  await app.request('ack', { roundId: first.data.round.id }, start.cookie);
  const second = await app.request('spin', { requestId: 'tiger-next-004', bet: 100, expectedVersion: 1 }, start.cookie);
  assert.equal(second.data.session.balance, 11800);
  const lateAck = await app.request('ack', { roundId: first.data.round.id }, start.cookie);
  assert.equal(lateAck.data.session.pendingRound.id, second.data.round.id);
  assert.equal(lateAck.data.session.stateVersion, 2);
});

test('Tiger API pending rounds persist across restart and are isolated from other sessions', async t => {
  const app = await setup(t);
  const first = await app.request('session'), second = await app.request('session');
  const round = await app.request('spin', { requestId: 'tiger-durable-001', bet: 500, expectedVersion: 0 }, first.cookie);
  assert.equal((await app.request('session', undefined, second.cookie)).data.balance, 12000);
  assert.equal((await app.request('ack', { roundId: round.data.round.id }, second.cookie)).status, 404);
  await close(app.server);
  const restarted = await app.boot();
  const recovered = await restarted.request('session', undefined, first.cookie);
  assert.equal(recovered.data.balance, 11500);
  assert.equal(recovered.data.pendingRound.id, round.data.round.id);
  const replay = await restarted.request('spin', { requestId: 'tiger-durable-001', bet: 500, expectedVersion: 0 }, first.cookie);
  assert.equal(replay.data.round.id, round.data.round.id);
  assert.equal(replay.data.session.balance, 11500);
});

test('Tiger API resets preserve receipts and advance version so old tabs cannot charge again', async t => {
  const app = await setup(t);
  const start = await app.request('session');
  const first = await app.request('spin', { requestId: 'tiger-before-reset', bet: 100, expectedVersion: 0 }, start.cookie);
  const reset = await app.request('reset', { requestId: 'tiger-reset-001' }, start.cookie);
  assert.equal(reset.data.session.balance, 12000);
  assert.equal(reset.data.session.epoch, 1);
  assert.equal(reset.data.session.stateVersion, 2);
  assert.equal(reset.data.session.pendingRound, null);
  assert.equal((await app.request('history', undefined, start.cookie)).data.rounds.length, 0);
  const old = await app.request('spin', { requestId: 'tiger-before-reset', bet: 100, expectedVersion: 0 }, start.cookie);
  assert.equal(old.data.round.id, first.data.round.id);
  assert.equal(old.data.session.balance, 12000);
  assert.equal((await app.request('spin', { requestId: 'tiger-stale-tab', bet: 100, expectedVersion: 0 }, start.cookie)).data.error.code, 'STATE_CHANGED');
  await app.request('spin', { requestId: 'tiger-after-reset', bet: 100, expectedVersion: 2 }, start.cookie);
  const repeated = await app.request('reset', { requestId: 'tiger-reset-001' }, start.cookie);
  assert.equal(repeated.data.session.balance, 11900);
  assert.equal(repeated.data.session.stateVersion, 3);
});

test('Tiger API malformed stake/body/version and invalid engine settlements never debit', async t => {
  const app = await setup(t, input => outcome(input, NaN));
  const start = await app.request('session');
  for (const bet of [0, -1, 10.5, 999, '100']) assert.equal((await app.request('spin', { requestId: 'tiger-invalid-001', bet, expectedVersion: 0 }, start.cookie)).status, 400);
  for (const requestId of ['constructor', '__proto__', 'prototype']) assert.equal((await app.request('spin', { requestId, bet: 100, expectedVersion: 0 }, start.cookie)).status, 400);
  const missingVersion = await app.request('spin', { requestId: 'tiger-no-version', bet: 100 }, start.cookie);
  assert.equal(missingVersion.data.error.code, 'INVALID_VERSION');
  const oversized = await app.request('spin', { requestId: 'tiger-too-large', bet: 100, expectedVersion: 0, padding: 'a'.repeat(9000) }, start.cookie);
  assert.equal(oversized.status, 413);
  const failure = await app.request('spin', { requestId: 'tiger-bad-engine', bet: 100, expectedVersion: 0 }, start.cookie);
  assert.equal(failure.status, 500);
  const state = await app.request('session', undefined, start.cookie);
  assert.equal(state.data.balance, 12000);
  assert.equal(state.data.pendingRound, null);
});

test('Tiger API insufficient balance and foreign API URLs are rejected; config publishes fixed math', async t => {
  const app = await setup(t);
  const start = await app.request('session');
  for (let index = 0; index < 24; index++) {
    const round = await app.request('spin', { requestId: `tiger-drain-${index}`, bet: 500, expectedVersion: index }, start.cookie);
    assert.equal(round.status, 200);
    await app.request('ack', { roundId: round.data.round.id }, start.cookie);
  }
  const empty = await app.request('spin', { requestId: 'tiger-empty-wallet', bet: 10, expectedVersion: 24 }, start.cookie);
  assert.equal(empty.data.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal((await app.request('session', undefined, start.cookie)).data.pendingRound, null);
  assert.equal((await app.request('history', undefined, start.cookie)).data.rounds.length, 20);
  const config = await app.request('config');
  assert.equal(config.data.targetRtp, .99);
  assert.equal(config.data.unitsPerCoin, 100);
  assert.equal(config.data.paylines.length, 5);
  assert.equal(config.data.demoOnly, true);
  assert.equal((await fetch(`${app.base}/api/session`)).status, 404);
});
