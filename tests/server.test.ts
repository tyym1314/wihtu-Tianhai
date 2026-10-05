import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDemoServer, type DemoServerOptions } from '../server/app.js';
import type { RoundInput, RoundResult, SymbolId } from '../src/game/types.js';

function outcome(input: RoundInput, overrides: Partial<RoundResult> = {}): RoundResult {
  const symbols: SymbolId[] = ['ruby', 'emerald', 'sapphire', 'amethyst', 'amber', 'crown', 'chalice', 'pearl'];
  const board = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, symbol: symbols[index % symbols.length] }));
  return {
    mathVersion: 'test', initialBoard: board, steps: [], endBoard: board, bet: input.bet,
    isFreeSpin: input.freeSpins > 0, baseWin: 0, totalWin: 0, multiplier: 1,
    collectedMultiplier: 0, nextFreeMultiplier: input.freeMultiplier, scatters: 0,
    freeSpinsAwarded: 0, cascadeLimitReached: false, winCapReached: false,
    ...overrides,
  };
}

async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function setup(t: TestContext, roundGenerator: DemoServerOptions['roundGenerator'] = input => outcome(input)) {
  const directory = await mkdtemp(join(tmpdir(), 'thunder-server-test-'));
  const servers: Server[] = [];
  const options = { storePath: join(directory, 'sessions.json'), staticDirectory: join(directory, 'dist'), roundGenerator };
  async function boot() {
    const server = await createDemoServer(options);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const versions = new Map<string, number>();
    async function request(path: string, body?: unknown, cookie?: string) {
      // Act like one client by default; concurrency tests can pass an explicit stale version.
      if (path === '/api/spin' && body && typeof body === 'object' && !('expectedVersion' in body)) {
        body = { ...body, expectedVersion: versions.get(cookie || '') ?? 0 };
      }
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      const responseCookie = response.headers.get('set-cookie')?.split(';')[0];
      const state = path === '/api/session' ? data : data.session;
      if (state?.stateVersion !== undefined) versions.set(responseCookie || cookie || '', state.stateVersion);
      return { status: response.status, data, cookie: responseCookie };
    }
    return { server, base, request };
  }
  t.after(async () => {
    for (const server of servers) await close(server);
    await rm(directory, { recursive: true, force: true });
  });
  return { ...await boot(), boot, directory };
}

test('concurrent retries settle exactly once and reject changed bets', async t => {
  let calls = 0;
  const app = await setup(t, input => {
    calls++;
    return outcome(input, { totalWin: 2500 });
  });
  const initial = await app.request('/api/session');
  const requests = await Promise.all(Array.from({ length: 8 }, () => app.request('/api/spin', { requestId: 'concurrent-retry-1', bet: 100 }, initial.cookie)));
  for (const response of requests) {
    assert.equal(response.status, 200);
    assert.equal(response.data.session.balance, 11925);
    assert.equal(response.data.round.win, 25);
    assert.equal(response.data.round.id, requests[0].data.round.id);
  }
  assert.equal(calls, 1);
  const oldVersionRetry = await app.request('/api/spin', { requestId: 'concurrent-retry-1', bet: 100, expectedVersion: 0 }, initial.cookie);
  assert.equal(oldVersionRetry.status, 200);
  assert.equal(oldVersionRetry.data.session.stateVersion, 1);
  assert.equal(calls, 1);
  const conflict = await app.request('/api/spin', { requestId: 'concurrent-retry-1', bet: 200 }, initial.cookie);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'REQUEST_CONFLICT');
  assert.equal((await app.request('/api/history', undefined, initial.cookie)).data.rounds.length, 1);
});

test('concurrent distinct rounds cannot charge while a settled round awaits acknowledgement', async t => {
  const app = await setup(t);
  const initial = await app.request('/api/session');
  const responses = await Promise.all(['request-first-1', 'request-second-2'].map(requestId => app.request('/api/spin', { requestId, bet: 100 }, initial.cookie)));
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
  const accepted = responses.find(item => item.status === 200)!;
  assert.equal((await app.request('/api/session', undefined, initial.cookie)).data.balance, 11900);
  const ack = await app.request('/api/round/ack', { roundId: accepted.data.round.id }, initial.cookie);
  assert.equal(ack.data.session.pendingRound, null);
  assert.equal(ack.data.session.balance, 11900);
  const repeatAck = await app.request('/api/round/ack', { roundId: accepted.data.round.id }, initial.cookie);
  assert.equal(repeatAck.status, 200);
  const next = await app.request('/api/spin', { requestId: 'request-after-ack', bet: 100 }, initial.cookie);
  assert.equal(next.data.session.balance, 11800);
  const lateAck = await app.request('/api/round/ack', { roundId: accepted.data.round.id }, initial.cookie);
  assert.equal(lateAck.data.session.pendingRound.id, next.data.round.id);
});

test('sessions are isolated and pending results survive process restart', async t => {
  const app = await setup(t);
  const first = await app.request('/api/session');
  const second = await app.request('/api/session');
  assert.notEqual(first.data.sessionId, second.data.sessionId);
  const spin = await app.request('/api/spin', { requestId: 'durable-spin-1', bet: 500 }, first.cookie);
  assert.equal((await app.request('/api/session', undefined, second.cookie)).data.balance, 12000);
  const forbidden = await app.request('/api/round/ack', { roundId: spin.data.round.id }, second.cookie);
  assert.equal(forbidden.status, 404);
  await close(app.server);
  const resumed = await app.boot();
  const state = await resumed.request('/api/session', undefined, first.cookie);
  assert.equal(state.data.balance, 11500);
  assert.equal(state.data.pendingRound.id, spin.data.round.id);
  const replay = await resumed.request('/api/spin', { requestId: 'durable-spin-1', bet: 500 }, first.cookie);
  assert.equal(replay.data.round.id, spin.data.round.id);
  assert.equal(replay.data.session.balance, 11500);
});

test('free spins retain their stake, do not debit credits, add retriggers and reset their multiplier on exit', async t => {
  let count = 0;
  const inputs: RoundInput[] = [];
  const app = await setup(t, input => {
    inputs.push(input);
    count++;
    return outcome(input, count === 1
      ? { freeSpinsAwarded: 1, nextFreeMultiplier: 0 }
      : count === 2
        ? { totalWin: 5000, freeSpinsAwarded: 1, nextFreeMultiplier: 5 }
        : { totalWin: 1000, nextFreeMultiplier: 8 });
  });
  const initial = await app.request('/api/session');
  const trigger = await app.request('/api/spin', { requestId: 'bonus-trigger-1', bet: 100 }, initial.cookie);
  assert.equal(trigger.data.session.freeSpins, 1);
  assert.equal(trigger.data.session.lockedBet, 100);
  await app.request('/api/round/ack', { roundId: trigger.data.round.id }, initial.cookie);
  const badBet = await app.request('/api/spin', { requestId: 'bonus-bad-bet-1', bet: 200 }, initial.cookie);
  assert.equal(badBet.data.error.code, 'BET_LOCKED');
  const free = await app.request('/api/spin', { requestId: 'bonus-free-one', bet: 100 }, initial.cookie);
  assert.equal(free.data.round.isFreeSpin, true);
  assert.equal(free.data.session.balance, 11950);
  assert.equal(free.data.session.freeSpins, 1);
  assert.equal(free.data.session.freeMultiplier, 5);
  await app.request('/api/round/ack', { roundId: free.data.round.id }, initial.cookie);
  const last = await app.request('/api/spin', { requestId: 'bonus-free-two', bet: 100 }, initial.cookie);
  assert.equal(last.data.session.balance, 11960);
  assert.equal(last.data.session.freeSpins, 0);
  assert.equal(last.data.session.freeMultiplier, 0);
  assert.equal(last.data.session.lockedBet, null);
  assert.deepEqual(inputs[2], { bet: 10000, freeSpins: 1, freeMultiplier: 5 });
});

test('reset clears pending and bonuses but preserves idempotency receipts', async t => {
  let calls = 0;
  const app = await setup(t, input => {
    calls++;
    return outcome(input, { freeSpinsAwarded: 15 });
  });
  const initial = await app.request('/api/session');
  const first = await app.request('/api/spin', { requestId: 'before-reset-1', bet: 100 }, initial.cookie);
  const reset = await app.request('/api/reset', { requestId: 'reset-request-1' }, initial.cookie);
  assert.equal(reset.data.session.balance, 12000);
  assert.equal(reset.data.session.freeSpins, 0);
  assert.equal(reset.data.session.pendingRound, null);
  assert.equal(reset.data.session.epoch, 1);
  assert.equal(reset.data.session.stateVersion, 2);
  assert.equal((await app.request('/api/history', undefined, initial.cookie)).data.rounds.length, 0);
  const oldRetry = await app.request('/api/spin', { requestId: 'before-reset-1', bet: 100 }, initial.cookie);
  assert.equal(oldRetry.data.round.id, first.data.round.id);
  assert.equal(oldRetry.data.session.balance, 12000);
  assert.equal(calls, 1);
  await app.request('/api/spin', { requestId: 'after-reset-1', bet: 100 }, initial.cookie);
  const repeatReset = await app.request('/api/reset', { requestId: 'reset-request-1' }, initial.cookie);
  assert.equal(repeatReset.data.session.balance, 11900);
  assert.equal(repeatReset.data.session.epoch, 1);
  assert.equal(repeatReset.data.session.stateVersion, 3);
});

test('invalid requests and failed engine settlement do not debit credits', async t => {
  const app = await setup(t, input => outcome(input, { totalWin: NaN }));
  const initial = await app.request('/api/session');
  for (const bet of [0, -1, 10.5, 999, '100']) {
    const response = await app.request('/api/spin', { requestId: 'invalid-bet-1', bet }, initial.cookie);
    assert.equal(response.status, 400);
  }
  const failed = await app.request('/api/spin', { requestId: 'failed-round-1', bet: 100 }, initial.cookie);
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(failed.data).includes('stack'), false);
  const state = await app.request('/api/session', undefined, initial.cookie);
  assert.equal(state.data.balance, 12000);
  assert.equal(state.data.pendingRound, null);
  const missingVersion = await app.request('/api/spin', { requestId: 'missing-version-1', bet: 100, expectedVersion: undefined }, initial.cookie);
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.data.error.code, 'INVALID_VERSION');
  const oversized = await app.request('/api/spin', { requestId: 'too-large-body', padding: 'x'.repeat(9000), bet: 100 }, initial.cookie);
  assert.equal(oversized.status, 413);
});

test('a stale tab cannot turn its last displayed free spin into a paid spin', async t => {
  let calls = 0;
  const app = await setup(t, input => outcome(input, { freeSpinsAwarded: ++calls === 1 ? 1 : 0 }));
  const initial = await app.request('/api/session');
  const trigger = await app.request('/api/spin', { requestId: 'version-trigger-1', bet: 100 }, initial.cookie);
  await app.request('/api/round/ack', { roundId: trigger.data.round.id }, initial.cookie);
  const tabA = (await app.request('/api/session', undefined, initial.cookie)).data;
  assert.equal(tabA.freeSpins, 1);
  assert.equal(tabA.stateVersion, 1);
  const tabB = await app.request('/api/spin', { requestId: 'version-tab-b-free', bet: 100, expectedVersion: tabA.stateVersion }, initial.cookie);
  await app.request('/api/round/ack', { roundId: tabB.data.round.id }, initial.cookie);
  const stale = await app.request('/api/spin', { requestId: 'version-tab-a-free', bet: 100, expectedVersion: tabA.stateVersion }, initial.cookie);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'STATE_CHANGED');
  const current = (await app.request('/api/session', undefined, initial.cookie)).data;
  assert.equal(current.balance, 11900);
  assert.equal(current.freeSpins, 0);
  assert.equal(current.stateVersion, 2);
  assert.equal(current.pendingRound, null);
  assert.equal(calls, 2);
});

test('reset advances epoch and version; an old tab must refresh before a new spin', async t => {
  const app = await setup(t);
  const initial = await app.request('/api/session');
  const reset = await app.request('/api/reset', { requestId: 'version-reset-1' }, initial.cookie);
  assert.equal(reset.data.session.epoch, 1);
  assert.equal(reset.data.session.stateVersion, 1);
  const stale = await app.request('/api/spin', { requestId: 'stale-after-reset', bet: 100, expectedVersion: initial.data.stateVersion }, initial.cookie);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'STATE_CHANGED');
  assert.equal((await app.request('/api/session', undefined, initial.cookie)).data.balance, 12000);
});

test('insufficient balance rejects the round without creating a pending result', async t => {
  const app = await setup(t);
  const initial = await app.request('/api/session');
  for (let index = 0; index < 24; index++) {
    const spin = await app.request('/api/spin', { requestId: `drain-balance-${index}`, bet: 500 }, initial.cookie);
    assert.equal(spin.status, 200);
    await app.request('/api/round/ack', { roundId: spin.data.round.id }, initial.cookie);
  }
  const rejected = await app.request('/api/spin', { requestId: 'empty-balance-1', bet: 10 }, initial.cookie);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.error.code, 'INSUFFICIENT_BALANCE');
  const state = await app.request('/api/session', undefined, initial.cookie);
  assert.equal(state.data.balance, 0);
  assert.equal(state.data.pendingRound, null);
  assert.equal((await app.request('/api/history', undefined, initial.cookie)).data.rounds.length, 20);
});

test('built frontend is served alongside the API without exposing parent files', async t => {
  const app = await setup(t);
  await mkdir(join(app.directory, 'dist'));
  await writeFile(join(app.directory, 'dist', 'index.html'), '<!doctype html><title>Demo</title>');
  await writeFile(join(app.directory, 'secret.txt'), 'do-not-serve');
  const page = await fetch(app.base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  const secret = await fetch(`${app.base}/%2e%2e%2fsecret.txt`);
  assert.equal(secret.status, 404);
  assert.equal((await secret.text()).includes('do-not-serve'), false);
  const config = await app.request('/api/config');
  assert.equal(config.data.demoOnly, true);
  assert.equal(config.data.currencyScale, 100);
  assert.equal(config.data.targetRtp, 0.99);
});
