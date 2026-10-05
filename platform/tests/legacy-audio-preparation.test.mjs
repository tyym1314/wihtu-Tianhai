import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { prepareLegacyAudio } from '../legacy/audio-preparation-transform.mjs';

const cues = ['click', 'spin', 'land', 'small', 'big', 'scatter'];
const games = await Promise.all(['ui', 'tiger'].map(async game => {
  const original = await readFile(new URL(`../../src/${game}/audio.ts`, import.meta.url), 'utf8');
  const result = prepareLegacyAudio(original);
  const { code } = await transform(result.source, {
    loader: 'ts', format: 'cjs', target: 'es2022', define: { 'import.meta.url': '"https://test.invalid/audio.ts"' },
  });
  return { game: game === 'ui' ? 'Thunder' : 'Tiger', original, result, code };
}));
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function harness(code, options = {}) {
  const state = { constructors: 0, contexts: [], workers: [], buffers: [], sources: [], timers: new Map(),
    gesture: false, resumeGestures: [], copyGestures: [], gainCount: 0, connectCount: 0, bufferCount: 0,
    hostListeners: new Set(), hostUnsubscribes: 0 };
  let timerId = 0;
  const pageListeners = new Set();
  const page = { hidden: false, addEventListener: (_, fn) => pageListeners.add(fn), removeEventListener: (_, fn) => pageListeners.delete(fn) };
  class Context {
    constructor() {
      state.constructors++;
      if (state.constructors <= (options.constructorFailures ?? 0)) throw new Error('early context unavailable');
      this.state = options.initialState ?? 'suspended'; this.currentTime = 0; this.destination = {};
      this.gains = []; this.closeCount = 0; this.resumeCount = 0; state.contexts.push(this);
    }
    createGain() {
      if (++state.gainCount === options.failGainAt) throw new Error('gain failed');
      const gain = { gain: { value: 0 }, disconnectCount: 0,
        connect() { if (++state.connectCount === options.failConnectAt) throw new Error('connect failed'); },
        disconnect() { this.disconnectCount++; } };
      this.gains.push(gain); return gain;
    }
    createBuffer(channels, length, rate) {
      state.copyGestures.push(state.gesture);
      if (++state.bufferCount === options.failBufferAt) throw new Error('buffer failed');
      const pcm = new Float32Array(length);
      const buffer = { channels, length, rate, getChannelData: () => pcm };
      state.buffers.push(buffer); return buffer;
    }
    createBufferSource() {
      const source = { context: this, loop: false, startCount: 0, stopCount: 0, disconnectCount: 0, onended: null,
        connect(target) { this.target = target; },
        start(...args) { this.startCount++; this.startArgs = args; },
        stop() { this.stopCount++; }, disconnect() { this.disconnectCount++; } };
      state.sources.push(source); return source;
    }
    resume() {
      this.resumeCount++; state.resumeGestures.push(state.gesture);
      if (options.resumeMode === 'pending') return new Promise(resolve => { this.finishResume = () => { this.state = 'running'; resolve(); }; });
      if (options.resumeMode === 'reject') return Promise.reject(new Error('gesture denied'));
      this.state = 'running'; return Promise.resolve();
    }
    close() { this.closeCount++; this.state = 'closed'; return Promise.resolve(); }
  }
  class Worker {
    constructor(url, init) {
      if (options.workerFails) throw new Error('worker failed');
      this.url = String(url); this.init = init; this.terminateCount = 0; state.workers.push(this);
    }
    terminate() { this.terminateCount++; }
  }
  const module = { exports: {} };
  const globals = { module, exports: module.exports, URL, Float32Array, Map, Set, console,
    document: page, window: options.webkit ? { webkitAudioContext: Context } : { AudioContext: Context }, Worker,
    setTimeout(fn, ms) { const id = ++timerId; state.timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { state.timers.delete(id); },
    require(id) {
      assert.equal(id, '../../bridge');
      return { subscribeHostState(fn) {
        state.hostListeners.add(fn); fn({ visible: true, muted: false, voiceActive: false });
        return () => { if (state.hostListeners.delete(fn)) state.hostUnsubscribes++; };
      } };
    },
  };
  vm.runInNewContext(code, globals);
  const audio = new module.exports.GameAudio(options.enabled ?? true);
  const bank = { music: new Float32Array([.1, -.2, .3]), sounds: cues.map((cue, i) => ({ cue, pcm: new Float32Array([i / 10, -.1]) })) };
  return {
    audio, state, page, bank, exports: module.exports,
    deliver() { state.workers[0].onmessage?.({ data: bank }); },
    unlock() { state.gesture = true; try { return audio.unlock(); } finally { state.gesture = false; } },
    runTimers(ms) { for (const [id, timer] of [...state.timers]) if (timer.ms === ms) { state.timers.delete(id); timer.fn(); } },
    host(values) { for (const fn of state.hostListeners) fn({ visible: true, muted: false, voiceActive: false, ...values }); },
    visibility(hidden) { page.hidden = hidden; for (const fn of pageListeners) fn(); },
    get pageListenerCount() { return pageListeners.size; },
  };
}

for (const { game, original, result, code } of games) {
  test(`${game}: exact synthesis is isolated and build fails on state-machine anchor drift`, () => {
    assert.equal(result.synthesis, original.slice(0, original.indexOf('export class GameAudio')));
    assert.throws(() => prepareLegacyAudio(original.replace('  private musicOffset = 0;', '  private musicOffset = 1;')), /anchor changed/);
    assert.match(result.worker, /postMessage\(\{music,sounds\},\[music.buffer,\.\.\.sounds.map\(s=>s.pcm.buffer\)\]\)/);
  });
  test(`${game}: prepares one graph and exact bank before gesture, with no source or resume`, async () => {
    const h = harness(code); h.deliver();
    assert.equal(h.state.constructors, 1); assert.equal(h.state.contexts[0].gains.length, 2);
    assert.equal(h.state.buffers.length, 7); assert.equal(h.state.sources.length, 0); assert.deepEqual(h.state.resumeGestures, []);
    assert.equal(h.audio.audioState, 'locked'); assert.equal(h.state.workers[0].terminateCount, 1);
    assert.deepEqual(h.state.buffers[0].getChannelData(0), h.bank.music);
    for (let i = 0; i < cues.length; i++) assert.deepEqual(h.state.buffers[i + 1].getChannelData(0), h.bank.sounds[i].pcm);
    const pending = h.unlock(); assert.deepEqual(h.state.resumeGestures, [true]); await pending;
    assert.equal(h.audio.audioState, 'playing'); assert.equal(h.state.sources.filter(s => s.loop).length, 1);
    h.audio.spin(); await h.unlock();
    assert.equal(h.state.constructors, 1); assert.equal(h.state.buffers.length, 7); assert.equal(h.state.sources.length, 2);
    assert.ok(h.state.copyGestures.every(v => v === false)); h.audio.dispose(); assert.equal(h.state.timers.size, 0);
  });
  test(`${game}: autoplay-allowed context still cannot play music or SFX before gesture`, async () => {
    const h = harness(code, { initialState: 'running' }); h.deliver();
    h.audio.click(); h.audio.spin(); h.audio.setEnabled(false); h.audio.setEnabled(true); h.audio.setMusicEnabled(true);
    h.host({ voiceActive: true }); h.visibility(true); h.visibility(false); await flush();
    assert.equal(h.state.sources.length, 0); assert.equal(h.audio.audioState, 'locked');
    await h.unlock(); h.audio.click(); assert.equal(h.state.sources.length, 2); h.audio.dispose();
  });
  test(`${game}: bank readiness never delays synchronous gesture resume or queues stale SFX`, async () => {
    const h = harness(code); const pending = h.unlock(); assert.deepEqual(h.state.resumeGestures, [true]); await pending;
    h.audio.spin(); assert.equal(h.state.sources.length, 0); assert.equal(h.state.buffers.length, 0);
    h.deliver(); assert.equal(h.state.sources.length, 1); assert.equal(h.state.sources[0].loop, true);
    h.audio.spin(); assert.equal(h.state.sources.length, 2); h.audio.dispose();
  });
  test(`${game}: denied early preparation retries inside gesture and defers all buffer copies`, async () => {
    const h = harness(code, { constructorFailures: 2 }); assert.equal(h.audio.audioState, 'locked');
    h.deliver(); assert.equal(h.state.constructors, 2); assert.equal(h.state.buffers.length, 0);
    const pending = h.unlock(); assert.equal(h.state.constructors, 3); assert.deepEqual(h.state.resumeGestures, [true]);
    assert.equal(h.state.buffers.length, 0); await pending; assert.equal(h.state.sources.length, 0);
    h.runTimers(0); assert.equal(h.state.buffers.length, 7); assert.equal(h.state.sources.length, 1);
    assert.ok(h.state.copyGestures.every(v => !v)); h.audio.dispose();
  });
  for (const failure of [{ failGainAt: 2 }, { failConnectAt: 2 }]) {
    test(`${game}: partial ${Object.keys(failure)[0]} graph closes and disconnects before retry`, async () => {
      const h = harness(code, failure); const failed = h.state.contexts[0];
      assert.equal(failed.closeCount, 1); assert.ok(failed.gains.every(g => g.disconnectCount === 1));
      assert.equal(h.audio.audioState, 'locked'); h.deliver(); assert.equal(h.state.contexts.length, 2);
      await h.unlock(); assert.equal(h.audio.audioState, 'playing'); h.audio.dispose();
      assert.equal(failed.closeCount, 1); assert.equal(h.state.contexts[1].closeCount, 1);
    });
  }
  test(`${game}: copied bank survives a partial buffer failure and retries only in deferred work`, async () => {
    const h = harness(code, { failBufferAt: 3 }); h.deliver(); assert.equal(h.state.buffers.length, 2);
    await h.unlock(); assert.equal(h.state.buffers.length, 2); h.runTimers(0);
    assert.equal(h.state.buffers.length, 7); assert.ok(h.state.copyGestures.every(v => !v));
    for (const cue of cues) cue === 'small' || cue === 'big' ? h.audio.win(cue) : h.audio[cue]();
    assert.equal(h.state.sources.length, 7); h.audio.dispose();
  });
  test(`${game}: unlock is single-flight, bounded at 400ms, and retryable`, async () => {
    const h = harness(code, { resumeMode: 'pending' }); h.deliver();
    const first = h.unlock(); assert.equal(first, h.unlock()); assert.equal(h.state.contexts[0].resumeCount, 1);
    h.runTimers(400); await first; assert.equal(h.audio.audioState, 'unavailable'); assert.equal(h.state.sources.length, 0);
    const second = h.unlock(); assert.equal(h.state.contexts[0].resumeCount, 2);
    h.state.contexts[0].finishResume(); await second; assert.equal(h.audio.audioState, 'playing');
    assert.equal(h.state.sources.length, 1); h.audio.dispose();
  });
  test(`${game}: rejected resume can recover on a later real gesture`, async () => {
    const options = { resumeMode: 'reject' }; const h = harness(code, options); h.deliver();
    await h.unlock(); assert.equal(h.audio.audioState, 'unavailable'); assert.equal(h.state.timers.size, 0);
    options.resumeMode = 'resolve'; await h.unlock(); assert.equal(h.audio.audioState, 'playing');
    assert.deepEqual(h.state.resumeGestures, [true, true]); h.audio.dispose();
  });
  test(`${game}: host ducking and mute preserve user volume, preferences, and one subscription`, async () => {
    const h = harness(code); h.deliver(); await h.unlock();
    h.audio.setMusicVolume(.5); h.audio.setSfxVolume(.4); h.host({ voiceActive: true });
    const [music, sfx] = h.state.contexts[0].gains;
    assert.equal(music.gain.value, .5 * .48 * .25); assert.equal(sfx.gain.value, .4 * .9 * .25);
    h.host({ muted: true }); assert.equal(music.gain.value, 0); assert.equal(sfx.gain.value, 0);
    h.host({ visible: false }); assert.equal(music.gain.value, 0);
    h.audio.setEnabled(false); h.audio.setEnabled(true); h.host({});
    assert.equal(h.audio.musicVolume, .5); assert.equal(h.audio.sfxVolume, .4);
    assert.equal(music.gain.value, .5 * .48); assert.equal(sfx.gain.value, .4 * .9);
    assert.equal(h.state.hostListeners.size, 1);
    h.audio.setMusicEnabled(false); h.audio.setSfxEnabled(false); h.host({ voiceActive: true });
    assert.equal(h.audio.musicEnabled, false); assert.equal(h.audio.sfxEnabled, false); assert.equal(h.audio.audioState, 'muted');
    h.audio.dispose(); h.audio.dispose(); assert.equal(h.state.hostUnsubscribes, 1); assert.equal(h.state.contexts[0].closeCount, 1);
  });
  test(`${game}: hidden page stops voices and restores a single loop at its saved offset`, async () => {
    const h = harness(code); h.deliver(); await h.unlock(); h.audio.click();
    h.state.contexts[0].currentTime = 9; h.visibility(true);
    assert.ok(h.state.sources.every(s => s.stopCount === 1 && s.disconnectCount === 1));
    assert.equal(h.audio.audioState, 'paused'); h.audio.spin(); assert.equal(h.state.sources.length, 2);
    h.visibility(false); await flush(); const music = h.state.sources.at(-1);
    assert.equal(music.loop, true); assert.deepEqual(music.startArgs, [0, 9]);
    assert.equal(h.state.buffers.length, 7); assert.equal(h.state.constructors, 1); h.audio.dispose();
  });
  test(`${game}: disabled audio stays silent during preparation and retains bounded voices after enable`, async () => {
    const h = harness(code, { enabled: false, webkit: true }); h.deliver(); await h.unlock();
    assert.equal(h.state.sources.length, 0); assert.equal(h.state.resumeGestures.length, 0);
    h.audio.setEnabled(true); h.audio.click(); assert.equal(h.state.sources.length, 0); await h.unlock();
    for (let i = 0; i < 30; i++) h.audio.click(); assert.equal(h.state.sources.length, 21);
    h.state.sources[1].onended(); h.audio.click(); assert.equal(h.state.sources.length, 22);
    h.audio.setSfxVolume(0); const count = h.state.sources.length; h.audio.click(); assert.equal(h.state.sources.length, count);
    h.audio.setMusicVolume(Number.NaN); assert.equal(h.audio.musicVolume, .6);
    h.audio.setMusicVolume(100); assert.equal(h.audio.musicVolume, 1); h.audio.dispose();
  });
  test(`${game}: worker failure/timeout terminates once, remains bounded and cannot bypass the sound gate`, async () => {
    for (const failure of ['timeout', 'error', 'constructor']) {
      const h = harness(code, { workerFails: failure === 'constructor' });
      if (failure === 'timeout') h.runTimers(15000);
      if (failure === 'error') h.state.workers[0].onerror();
      await h.unlock(); h.audio.spin(); assert.equal(h.audio.audioState, 'unavailable'); assert.equal(h.state.sources.length, 0);
      h.audio.dispose(); assert.equal(h.state.timers.size, 0);
      for (const worker of h.state.workers) assert.equal(worker.terminateCount, 1);
    }
  });
  test(`${game}: disposal cancels worker, deferred bank and pending resume; late events cannot revive audio`, async () => {
    const h = harness(code, { resumeMode: 'pending' });
    const lateMessage = h.state.workers[0].onmessage; const lateError = h.state.workers[0].onerror;
    const pending = h.unlock(); h.audio.dispose(); await pending;
    lateMessage({ data: h.bank }); lateError(); h.runTimers(0); h.runTimers(15000);
    assert.equal(h.state.workers[0].terminateCount, 1); assert.equal(h.state.sources.length, 0);
    assert.equal(h.state.buffers.length, 0); assert.equal(h.state.timers.size, 0); assert.equal(h.pageListenerCount, 0);
    h.state.contexts[0].finishResume(); await flush(); assert.equal(h.state.sources.length, 0);
    assert.equal(h.state.hostListeners.size, 0); assert.equal(h.state.contexts[0].closeCount, 1);
    const fallback = harness(code, { constructorFailures: 2 }); fallback.deliver(); const unlock = fallback.unlock();
    fallback.audio.dispose(); await unlock; fallback.runTimers(0); assert.equal(fallback.state.buffers.length, 0);
  });
}
