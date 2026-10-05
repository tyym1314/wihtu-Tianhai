import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoPlay, AUTO_PLAY_COUNTS } from '../src/ui/autoplay';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('selected paid count is finite and the last paid spin drains all awarded and retriggered free spins', async () => {
  let freeSpins = 2;
  let paid = 0;
  let free = 0;
  const rounds: string[] = [];
  const auto = new AutoPlay({
    getState: () => ({ freeSpins, canPlay: true }),
    play: async () => {
      const isFreeSpin = freeSpins > 0;
      rounds.push(isFreeSpin ? 'free' : 'paid');
      if (isFreeSpin) {
        --freeSpins;
        ++free;
        if (free === 3) freeSpins += 2;
      } else {
        ++paid;
        if (paid === 10) freeSpins = 3;
      }
      return { isFreeSpin };
    },
    onChange: () => {},
  });
  await auto.start(10);
  assert.deepEqual(AUTO_PLAY_COUNTS, [10, 25, 50, 100]);
  assert.equal(paid, 10);
  assert.equal(free, 7);
  assert.deepEqual(rounds.slice(-5), Array(5).fill('free'));
  assert.equal(freeSpins, 0);
  assert.equal(auto.remaining, 0);
  assert.equal(auto.active, false);
  assert.equal(auto.inFlight, false);
});

test('no second request starts until the complete play promise resolves', async () => {
  const animation = deferred<{ isFreeSpin: boolean }>();
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const auto = new AutoPlay({
    getState: () => ({ freeSpins: 0, canPlay: true }),
    play: async () => {
      ++calls;
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      const result = calls === 1 ? await animation.promise : { isFreeSpin: false };
      --concurrent;
      return result;
    },
    onChange: () => {},
  });
  const running = auto.start(2);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(auto.inFlight, true);
  assert.equal(auto.remaining, 2);
  animation.resolve({ isFreeSpin: false });
  await running;
  assert.equal(calls, 2);
  assert.equal(maxConcurrent, 1);
  assert.equal(auto.remaining, 0);
});

test('duplicate starts and restart while a stopped round is in flight cannot issue more requests', async () => {
  const pending = deferred<{ isFreeSpin: boolean }>();
  let calls = 0;
  const auto = new AutoPlay({
    getState: () => ({ freeSpins: 0, canPlay: true }),
    play: async () => ++calls === 1 ? pending.promise : { isFreeSpin: false },
    onChange: () => {},
  });
  const running = auto.start(10);
  await assert.rejects(auto.start(25), /already running/);
  auto.stop();
  assert.equal(auto.active, false);
  assert.equal(auto.inFlight, true);
  await assert.rejects(auto.start(50), /already running/);
  assert.equal(calls, 1);
  pending.resolve({ isFreeSpin: false });
  await running;
  assert.equal(auto.remaining, 9);
  assert.equal(calls, 1);
  assert.equal(auto.inFlight, false);
  await auto.start(1);
  assert.equal(calls, 2);
});

test('stopping during a pause releases the queue, and resolving the old pause cannot revive it', async () => {
  const pause = deferred<void>();
  const enteredPause = deferred<void>();
  let calls = 0;
  const auto = new AutoPlay({
    getState: () => ({ freeSpins: 0, canPlay: true }),
    play: async () => { ++calls; return { isFreeSpin: false }; },
    onChange: () => {},
    betweenRounds: () => { enteredPause.resolve(); return pause.promise; },
  });
  const running = auto.start(10);
  await enteredPause.promise;
  assert.equal(calls, 1);
  auto.stop();
  await running;
  await auto.start(1);
  pause.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(auto.active, false);
});

test('null responses and errors stop the queue without charging the selection again', async () => {
  for (const result of ['null', 'error'] as const) {
    let calls = 0;
    const auto = new AutoPlay({
      getState: () => ({ freeSpins: 0, canPlay: true }),
      play: async () => {
        ++calls;
        if (result === 'error') throw new Error('disconnected');
        return null;
      },
      onChange: () => {},
    });
    if (result === 'error') await assert.rejects(auto.start(10), /disconnected/);
    else await auto.start(10);
    assert.equal(calls, 1);
    assert.equal(auto.remaining, 10);
    assert.equal(auto.active, false);
    assert.equal(auto.inFlight, false);
  }
});

test('fresh state prevents starting a paid spin once the balance or session is no longer playable', async () => {
  let canPlay = true;
  let calls = 0;
  const auto = new AutoPlay({
    getState: () => ({ freeSpins: 0, canPlay }),
    play: async () => { ++calls; canPlay = false; return { isFreeSpin: false }; },
    onChange: () => {},
  });
  await auto.start(10);
  assert.equal(calls, 1);
  assert.equal(auto.remaining, 9);
  await auto.start(10);
  assert.equal(calls, 1);
  assert.equal(auto.remaining, 10);
});

test('stop from a UI state callback cancels the request before it is sent', async () => {
  let calls = 0;
  let auto!: AutoPlay;
  auto = new AutoPlay({
    getState: () => ({ freeSpins: 0, canPlay: true }),
    play: async () => { ++calls; return { isFreeSpin: false }; },
    onChange: () => { if (auto.inFlight && auto.active) auto.stop(); },
  });
  await auto.start(10);
  assert.equal(calls, 0);
  assert.equal(auto.remaining, 10);
  assert.equal(auto.active, false);
  assert.equal(auto.inFlight, false);
});

test('invalid and unbounded selections never activate the queue', async () => {
  let calls = 0;
  const auto = new AutoPlay({
    getState: () => ({ freeSpins: 0, canPlay: true }),
    play: async () => { ++calls; return { isFreeSpin: false }; },
    onChange: () => {},
  });
  for (const count of [0, -1, 1.5, 101, Infinity, NaN]) {
    await assert.rejects(auto.start(count), RangeError);
  }
  assert.equal(calls, 0);
  assert.equal(auto.active, false);
});
