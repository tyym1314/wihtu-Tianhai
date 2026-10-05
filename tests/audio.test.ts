import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio, renderMusicPcm, renderSoundPcm, AUDIO_SAMPLE_RATE, MUSIC_SECONDS, type SoundCue } from '../src/ui/audio';

class FakeSource {
  buffer: { samples: Float32Array } | null = null;
  loop = false;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  disconnected = false;
  offset = 0;
  connect() {}
  disconnect() { this.disconnected = true; }
  start(_when = 0, offset = 0) { this.started = true; this.offset = offset; }
  stop() { this.stopped = true; }
}
class FakeContext {
  static instances: FakeContext[] = [];
  static rejectResume = false;
  static hangResume = false;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  gains: Array<{ gain: { value: number }; connect(): void; disconnect(): void }> = [];
  resumeCount = 0;
  constructor() { FakeContext.instances.push(this); }
  createGain() { const gain = { gain: { value: 1 }, connect() {}, disconnect() {} }; this.gains.push(gain); return gain; }
  createBuffer(_channels: number, length: number) { const samples = new Float32Array(length); return { samples, getChannelData: () => samples }; }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  async resume() { this.resumeCount++; if (FakeContext.hangResume) return new Promise<void>(() => {}); if (FakeContext.rejectResume) throw new Error('blocked'); this.state = 'running'; }
  async close() { this.state = 'closed'; }
  get activeLoops() { return this.sources.filter(source => source.loop && source.started && !source.stopped); }
  get activeEffects() { return this.sources.filter(source => !source.loop && source.started && !source.stopped); }
}
class FakeDocument extends EventTarget { hidden = false; changeVisibility(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); } }

async function environment(run: (page: FakeDocument) => Promise<void>) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  FakeContext.instances = []; FakeContext.rejectResume = false; FakeContext.hangResume = false;
  const page = new FakeDocument();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeContext } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  try { await run(page); }
  finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
}

function energy(pcm: Float32Array) {
  let squares = 0; let peak = 0;
  for (const sample of pcm) { assert.ok(Number.isFinite(sample)); squares += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
  return { rms: Math.sqrt(squares / pcm.length), peak };
}

test('music and every effect produce finite, audible PCM with headroom', () => {
  const music = renderMusicPcm();
  assert.equal(music.length, AUDIO_SAMPLE_RATE * MUSIC_SECONDS);
  const parts: Array<Float32Array> = [music, ...(['click', 'spin', 'land', 'small', 'big', 'scatter'] as SoundCue[]).map(cue => renderSoundPcm(cue))];
  for (const pcm of parts) { const levels = energy(pcm); assert.ok(levels.rms > 0.015); assert.ok(levels.peak > 0.1 && levels.peak < 0.9); }
  for (let second = 0; second < MUSIC_SECONDS; second++) assert.ok(energy(music.subarray(second * AUDIO_SAMPLE_RATE, (second + 1) * AUDIO_SAMPLE_RATE)).rms > 0.04, `silent music at ${second}s`);
  // A real melody evolves; the first and second sixteen seconds are not a duplicated drone.
  assert.notDeepEqual(music.subarray(0, AUDIO_SAMPLE_RATE * 16), music.subarray(AUDIO_SAMPLE_RATE * 16));
  assert.ok(Math.abs(music[0] - music[music.length - 1]) < 0.05, 'loop boundary discontinuity');
});

test('nothing plays before the user gesture, repeated unlock shares one context and one loop', async () => environment(async () => {
  const audio = new GameAudio();
  audio.spin(); audio.win('big');
  assert.equal(audio.audioState, 'locked');
  assert.equal(FakeContext.instances.length, 0);
  await Promise.all([audio.unlock(), audio.unlock(), audio.unlock()]);
  await audio.unlock();
  const context = FakeContext.instances[0];
  assert.equal(FakeContext.instances.length, 1);
  assert.equal(context.activeLoops.length, 1);
  assert.equal(audio.getStatus().music.playing, true);
  assert.equal(audio.audioState, 'playing');
  assert.ok(energy(context.activeLoops[0].buffer!.samples).rms > 0.04);
  audio.win('small');
  assert.equal(context.activeEffects.length, 1);
  assert.equal(audio.getStatus().sfx.playing, true);
  context.activeEffects[0].onended?.();
  assert.equal(audio.getStatus().sfx.playing, false);
  audio.dispose();
}));

test('master mute stops every voice, preserves per-channel preferences, and resumes the score position', async () => environment(async () => {
  const audio = new GameAudio();
  audio.setSfxEnabled(false); audio.setMusicVolume(0.42); audio.setSfxVolume(0.73);
  await audio.unlock();
  const context = FakeContext.instances[0];
  context.currentTime = 5.5;
  audio.setEnabled(false);
  assert.equal(audio.audioState, 'muted');
  assert.equal(context.activeLoops.length, 0);
  assert.equal(audio.getStatus().music.playing, false);
  audio.win('big');
  assert.equal(context.activeEffects.length, 0);
  audio.setEnabled(true);
  assert.equal(context.activeLoops.length, 1);
  assert.equal(context.activeLoops[0].offset, 5.5);
  assert.equal(audio.sfxEnabled, false);
  assert.equal(audio.musicVolume, 0.42); assert.equal(audio.sfxVolume, 0.73);
  audio.dispose();
}));

test('music and SFX can be independently disabled and volume cannot leave the supported range', async () => environment(async () => {
  const audio = new GameAudio();
  await audio.unlock();
  const context = FakeContext.instances[0];
  audio.setMusicEnabled(false);
  assert.equal(context.activeLoops.length, 0);
  audio.win('big');
  assert.equal(context.activeEffects.length, 1);
  audio.setSfxEnabled(false);
  assert.equal(context.activeEffects.length, 0);
  assert.equal(audio.audioState, 'muted');
  audio.setMusicEnabled(true);
  assert.equal(context.activeLoops.length, 1);
  audio.setMusicVolume(0);
  assert.equal(context.activeLoops.length, 0);
  audio.setMusicVolume(5); assert.equal(audio.musicVolume, 1);
  assert.equal(context.activeLoops.length, 1);
  audio.setSfxVolume(-5); assert.equal(audio.sfxVolume, 0);
  audio.setSfxVolume(Number.NaN); assert.equal(audio.sfxVolume, 0);
  audio.dispose();
}));

test('hidden tabs stop music and effects, foreground only restores previously unlocked audio', async () => environment(async page => {
  const audio = new GameAudio();
  page.changeVisibility(true); page.changeVisibility(false);
  assert.equal(FakeContext.instances.length, 0);
  await audio.unlock(); audio.spin();
  const context = FakeContext.instances[0];
  page.changeVisibility(true);
  assert.equal(context.activeLoops.length, 0); assert.equal(context.activeEffects.length, 0);
  assert.equal(audio.audioState, 'paused');
  audio.win('big');
  assert.equal(context.activeEffects.length, 0);
  page.changeVisibility(false); await Promise.resolve(); await Promise.resolve();
  assert.equal(context.activeLoops.length, 1);
  audio.dispose();
}));

test('resume failures resolve safely and a later gesture can recover without a second context', async () => environment(async () => {
  FakeContext.rejectResume = true;
  const audio = new GameAudio();
  await assert.doesNotReject(audio.unlock());
  assert.equal(audio.audioState, 'unavailable');
  assert.equal(FakeContext.instances[0].activeLoops.length, 0);
  FakeContext.rejectResume = false;
  await audio.unlock();
  assert.equal(audio.audioState, 'playing');
  assert.equal(FakeContext.instances.length, 1);
  audio.dispose();
}));

test('dispose terminates voices and listeners, and no later gesture or preference can restart it', async () => environment(async page => {
  const audio = new GameAudio();
  await audio.unlock(); audio.win('big');
  const context = FakeContext.instances[0];
  audio.dispose(); audio.dispose();
  page.changeVisibility(true); page.changeVisibility(false);
  audio.setEnabled(true); audio.setMusicEnabled(true); audio.setSfxEnabled(true); await audio.unlock(); audio.spin();
  assert.equal(context.state, 'closed');
  assert.equal(context.activeLoops.length, 0); assert.equal(context.activeEffects.length, 0);
  assert.equal(FakeContext.instances.length, 1);
  assert.equal(audio.enabled, false);
}));

test('a browser that never resolves resume cannot freeze a spin, and dispose releases a pending unlock', async () => environment(async () => {
  FakeContext.hangResume = true;
  const audio = new GameAudio();
  const started = Date.now();
  await audio.unlock();
  assert.ok(Date.now() - started < 800);
  assert.equal(audio.audioState, 'unavailable');
  assert.equal(FakeContext.instances[0].activeLoops.length, 0);
  const pending = audio.unlock();
  audio.dispose();
  await pending;
  assert.equal(FakeContext.instances[0].state, 'closed');
}));
