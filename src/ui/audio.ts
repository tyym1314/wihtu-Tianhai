export type AudioState = 'locked' | 'playing' | 'muted' | 'unavailable' | 'paused';
export type SoundCue = 'click' | 'spin' | 'land' | 'small' | 'big' | 'scatter';
export type AudioStatus = {
  state: AudioState;
  music: { enabled: boolean; volume: number; playing: boolean };
  sfx: { enabled: boolean; volume: number; playing: boolean };
};

// Original score: sixteen 4/4 bars at 120 BPM. PCM is shared by the player and
// export-audio.ts, so the reviewable WAV is exactly the sound used in the game.
export const MUSIC_SECONDS = 32;
export const AUDIO_SAMPLE_RATE = 22050;
const TAU = Math.PI * 2;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
type Instrument = 'pad' | 'bell' | 'pluck' | 'brass' | 'bass';

function synthesizer(seconds: number, sampleRate: number, loop = false) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new RangeError('Invalid audio sample rate');
  const samples = new Float32Array(Math.ceil(seconds * sampleRate));
  const add = (index: number, value: number) => {
    if (loop) samples[index % samples.length] += value;
    else if (index < samples.length) samples[index] += value;
  };
  function note(midi: number, at: number, duration: number, amplitude: number, instrument: Instrument) {
    const start = Math.round(at * sampleRate);
    const length = Math.ceil(duration * sampleRate);
    const frequency = hz(midi);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const p = TAU * frequency * t;
      const end = Math.min(1, (duration - t) / 0.06);
      let value: number;
      if (instrument === 'pad') {
        const envelope = Math.min(1, t / 0.16) * Math.min(1, (duration - t) / 0.4);
        value = (Math.sin(p) + 0.24 * Math.sin(p * 1.002) + 0.16 * Math.sin(2 * p)) * envelope / 1.4;
      } else if (instrument === 'bell') {
        value = (Math.sin(p) + 0.3 * Math.sin(p * 2.76) * Math.exp(-t * 5) + 0.14 * Math.sin(p * 5.4) * Math.exp(-t * 9)) * Math.min(1, t / 0.003) * Math.exp(-t * 4.2) * end;
      } else if (instrument === 'brass') {
        value = (Math.sin(p + 0.012 * Math.sin(t * TAU * 5)) + 0.32 * Math.sin(p * 2) + 0.14 * Math.sin(p * 3)) * Math.min(1, t / 0.035) * Math.min(1, (duration - t) / 0.15) / 1.46;
      } else if (instrument === 'bass') {
        value = (Math.sin(p) + 0.25 * Math.sin(p * 2)) * Math.min(1, t / 0.012) * Math.exp(-t * 1.8) * end;
      } else {
        value = (Math.sin(p) + 0.45 * Math.sin(p * 2) + 0.18 * Math.sin(p * 3)) * Math.min(1, t / 0.002) * Math.exp(-t * 9) * end / 1.63;
      }
      add(start + i, value * amplitude);
    }
  }
  function drum(at: number, amplitude = 0.35, duration = 0.3) {
    const start = Math.round(at * sampleRate);
    for (let i = 0; i < Math.ceil(duration * sampleRate); i++) {
      const t = i / sampleRate;
      const phase = TAU * (48 * t + 70 / 30 * (1 - Math.exp(-30 * t)));
      const envelope = Math.min(1, t / 0.003) * Math.exp(-t * 14) * Math.min(1, (duration - t) / 0.03);
      add(start + i, Math.sin(phase) * envelope * amplitude);
    }
  }
  function noise(at: number, duration: number, amplitude: number, low = false, seed = 811) {
    let random = seed >>> 0;
    let filtered = 0;
    const start = Math.round(at * sampleRate);
    for (let i = 0; i < Math.ceil(duration * sampleRate); i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const raw = random / 0x80000000 - 1;
      filtered += (raw - filtered) * (low ? 0.045 : 0.55);
      const t = i / sampleRate;
      const envelope = Math.min(1, t / 0.005) * Math.exp(-t / duration * 5) * Math.min(1, (duration - t) / 0.03);
      add(start + i, filtered * amplitude * envelope);
    }
  }
  function finish() {
    // Headroom even when orchestral parts overlap; no hard clipping.
    for (let i = 0; i < samples.length; i++) samples[i] = Math.tanh(samples[i] * 1.1) * 0.86;
    return samples;
  }
  return { note, drum, noise, finish };
}

export function renderMusicPcm(sampleRate = AUDIO_SAMPLE_RATE): Float32Array {
  const synth = synthesizer(MUSIC_SECONDS, sampleRate, true);
  const chords = [[50, 57, 62, 65], [46, 53, 58, 62], [43, 50, 58, 62], [45, 52, 57, 61]];
  const melody = [
    [74, 77, 81, 77], [74, 70, 77, 74], [74, 79, 77, 74], [73, 76, 81, 76],
    [77, 81, 86, 81], [82, 81, 77, 74], [79, 82, 81, 77], [76, 73, 69, 73],
    [74, 77, 76, 74], [70, 74, 77, 81], [79, 77, 74, 70], [73, 76, 81, 85],
    [86, 81, 77, 74], [82, 77, 74, 70], [79, 77, 74, 70], [73, 76, 81, 73],
  ];
  for (let bar = 0; bar < 16; bar++) {
    const at = bar * 2;
    const chord = chords[bar % chords.length];
    chord.slice(1).forEach(midi => synth.note(midi, at, 2.22, 0.075, 'pad'));
    synth.note(chord[0] - 12, at, 1.15, 0.29, 'bass');
    synth.note(chord[0] - 12, at + 1, 0.85, 0.2, 'bass');
    synth.drum(at, 0.36);
    synth.drum(at + 1, 0.23);
    for (let beat = 0; beat < 4; beat++) {
      synth.note(melody[bar][beat], at + beat * 0.5, 0.8, beat === 0 ? 0.29 : 0.21, 'bell');
      synth.noise(at + beat * 0.5 + 0.25, 0.09, 0.1, false, bar * 4 + beat + 51);
    }
    for (let part = 0; part < 8; part++) synth.note(chord[1 + part % 3] + 12, at + part * 0.25, 0.24, 0.14, 'pluck');
    if (bar % 4 === 3) {
      synth.drum(at + 1.5, 0.15, 0.2);
      synth.drum(at + 1.75, 0.12, 0.18);
    }
  }
  return synth.finish();
}

export function renderSoundPcm(cue: SoundCue, sampleRate = AUDIO_SAMPLE_RATE): Float32Array {
  const duration = { click: 0.16, spin: 1.0, land: 0.25, small: 1.3, big: 3.2, scatter: 1.7 }[cue];
  const synth = synthesizer(duration, sampleRate);
  switch (cue) {
    case 'click':
      synth.note(84, 0, 0.11, 0.38, 'pluck');
      synth.noise(0, 0.07, 0.17);
      break;
    case 'spin':
      synth.noise(0, 0.8, 0.52, true);
      for (let i = 0; i < 16; i++) {
        const at = i * 0.049;
        synth.note(55 + i % 4 * 3, at, 0.07, 0.22 * (1 - i / 25), 'pluck');
        synth.noise(at, 0.04, 0.28, false, 501 + i);
      }
      break;
    case 'land':
      synth.drum(0, 0.6, 0.2);
      synth.note(81, 0.015, 0.16, 0.4, 'bell');
      synth.noise(0, 0.075, 0.3);
      break;
    case 'small':
      [74, 77, 81, 86].forEach((note, index) => synth.note(note, index * 0.1, 0.9, 0.53, 'bell'));
      [0.3, 0.42, 0.53, 0.65, 0.75].forEach((at, index) => {
        synth.note(96 + index % 3 * 3, at, 0.27, 0.24, 'bell');
        synth.noise(at, 0.04, 0.18, false, 900 + index);
      });
      break;
    case 'big':
      synth.drum(0, 0.8, 0.5);
      synth.noise(0, 1.6, 1.0, true);
      [62, 65, 69, 74].forEach((note, index) => {
        synth.note(note, index * 0.18, 0.5, 0.42, 'brass');
        synth.note(note + 12, index * 0.18, 1.1, 0.35, 'bell');
      });
      [62, 65, 69, 74, 81].forEach(note => synth.note(note, 0.9, 1.8, 0.2, 'brass'));
      [0.9, 1.45, 2.0].forEach(at => synth.drum(at, 0.55, 0.5));
      for (let i = 0; i < 18; i++) synth.note([86, 89, 93, 98][i % 4], 0.65 + i * 0.105, 0.55, 0.24, 'bell');
      synth.noise(0.9, 1.5, 0.55);
      break;
    case 'scatter':
      [74, 77, 81, 86, 89, 93].forEach((note, index) => synth.note(note, index * 0.13, 0.95, 0.52, 'bell'));
      [62, 69, 74].forEach(note => synth.note(note, 0.55, 1.0, 0.16, 'pad'));
      synth.noise(0.56, 0.65, 0.23);
      break;
  }
  return synth.finish();
}

/** User-gesture unlocked music + sound effects, with one AudioContext. */
export class GameAudio {
  private context: AudioContext | null = null;
  private musicOutput: GainNode | null = null;
  private sfxOutput: GainNode | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicBuffer: AudioBuffer | null = null;
  private readonly sounds = new Map<SoundCue, AudioBuffer>();
  private readonly voices = new Set<AudioBufferSourceNode>();
  private isEnabled: boolean;
  private wantsMusic = true;
  private wantsSfx = true;
  private musicLevel = 0.6;
  private sfxLevel = 0.85;
  private disposed = false;
  private unlocked = false;
  private unavailable = false;
  private pendingUnlock: Promise<void> | null = null;
  private cancelResume: (() => void) | null = null;
  private page: Document | null;
  private musicOffset = 0;
  private musicStartedAt = 0;

  constructor(enabled = true) {
    this.isEnabled = enabled;
    this.page = typeof document === 'undefined' ? null : document;
    this.page?.addEventListener('visibilitychange', this.handleVisibility);
  }
  get enabled(): boolean { return this.isEnabled && !this.disposed; }
  get musicEnabled(): boolean { return this.wantsMusic; }
  get sfxEnabled(): boolean { return this.wantsSfx; }
  get musicVolume(): number { return this.musicLevel; }
  get sfxVolume(): number { return this.sfxLevel; }
  get audioState(): AudioState {
    if (this.unavailable) return 'unavailable';
    if (!this.enabled || (!this.wantsMusic || this.musicLevel === 0) && (!this.wantsSfx || this.sfxLevel === 0)) return 'muted';
    if (!this.unlocked) return 'locked';
    if (this.page?.hidden || this.context?.state !== 'running') return 'paused';
    return 'playing';
  }
  getStatus(): AudioStatus {
    return {
      state: this.audioState,
      music: { enabled: this.wantsMusic, volume: this.musicLevel, playing: !!this.musicSource && this.wantsMusic && this.musicLevel > 0 && this.audioState === 'playing' },
      sfx: { enabled: this.wantsSfx, volume: this.sfxLevel, playing: this.voices.size > 0 && this.wantsSfx && this.sfxLevel > 0 && this.audioState === 'playing' },
    };
  }
  /** Call directly inside a real user gesture. Never rejects or blocks gameplay. */
  unlock(): Promise<void> {
    if (this.disposed || !this.enabled || typeof window === 'undefined') return Promise.resolve();
    if (this.pendingUnlock) return this.pendingUnlock;
    this.pendingUnlock = this.ensureContext().finally(() => { this.pendingUnlock = null; });
    return this.pendingUnlock;
  }
  private async ensureContext(): Promise<void> {
    try {
      if (!this.context) {
        const browser = window as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Constructor = browser.AudioContext ?? browser.webkitAudioContext;
        if (!Constructor) { this.unavailable = true; return; }
        const context = new Constructor();
        this.context = context;
        this.musicOutput = context.createGain();
        this.sfxOutput = context.createGain();
        this.musicOutput.connect(context.destination);
        this.sfxOutput.connect(context.destination);
        this.updateVolumes();
      }
      const context = this.context;
      if (context.state !== 'running') {
        // Some embedded browsers leave resume() pending when playback is
        // disallowed. Bound that wait so audio can never freeze a spin.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([context.resume(), new Promise<void>(resolve => {
            this.cancelResume = resolve;
            timeout = setTimeout(resolve, 400);
          })]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          this.cancelResume = null;
        }
      }
      if (this.disposed) return;
      this.unavailable = context.state !== 'running';
      this.unlocked = !this.unavailable;
      if (this.page?.hidden) { this.stopAll(); return; }
      this.syncMusic();
    } catch { this.unavailable = true; }
  }
  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.isEnabled = enabled;
    this.updateVolumes();
    if (!enabled) this.stopAll();
    else this.syncMusic();
  }
  setMusicEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.wantsMusic = enabled;
    this.syncMusic();
  }
  setSfxEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.wantsSfx = enabled;
    if (!enabled) this.stopVoices();
    this.updateVolumes();
  }
  setMusicVolume(volume: number): void {
    if (this.disposed) return;
    this.musicLevel = this.clampVolume(volume, this.musicLevel);
    this.updateVolumes();
    this.syncMusic();
  }
  setSfxVolume(volume: number): void {
    if (this.disposed) return;
    this.sfxLevel = this.clampVolume(volume, this.sfxLevel);
    this.updateVolumes();
    if (this.sfxLevel === 0) this.stopVoices();
  }
  click(): void { this.play('click'); }
  spin(): void { this.play('spin'); }
  land(): void { this.play('land'); }
  win(level: 'small' | 'big'): void { this.play(level); }
  scatter(): void { this.play('scatter'); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelResume?.();
    this.page?.removeEventListener('visibilitychange', this.handleVisibility);
    this.stopAll();
    this.musicOutput?.disconnect();
    this.sfxOutput?.disconnect();
    this.musicOutput = this.sfxOutput = null;
    this.musicBuffer = null;
    this.sounds.clear();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
  private clampVolume(value: number, fallback: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback; }
  private updateVolumes(): void {
    // Music sits beneath the symbols/coins; both channels retain their settings.
    if (this.musicOutput) this.musicOutput.gain.value = this.enabled ? this.musicLevel * 0.48 : 0;
    if (this.sfxOutput) this.sfxOutput.gain.value = this.enabled && this.wantsSfx ? this.sfxLevel * 0.9 : 0;
  }
  private makeBuffer(pcm: Float32Array): AudioBuffer {
    const buffer = this.context!.createBuffer(1, pcm.length, AUDIO_SAMPLE_RATE);
    buffer.getChannelData(0).set(pcm);
    return buffer;
  }
  private syncMusic(): void {
    if (!this.enabled || !this.wantsMusic || this.musicLevel === 0 || !this.unlocked || this.page?.hidden || this.context?.state !== 'running') { this.stopMusic(); return; }
    if (this.musicSource || !this.musicOutput) return;
    try {
      this.musicBuffer ??= this.makeBuffer(renderMusicPcm());
      const source = this.context.createBufferSource();
      source.buffer = this.musicBuffer;
      source.loop = true;
      source.connect(this.musicOutput);
      this.musicStartedAt = this.context.currentTime;
      source.start(0, this.musicOffset);
      this.musicSource = source;
    } catch { this.unavailable = true; }
  }
  private play(cue: SoundCue): void {
    const context = this.context;
    if (!this.enabled || !this.wantsSfx || !this.sfxLevel || !context || !this.sfxOutput || this.page?.hidden || context.state !== 'running') return;
    // Repeated taps/cascades cannot leak an unbounded number of one-shot voices.
    if (this.voices.size >= 20) return;
    try {
      let buffer = this.sounds.get(cue);
      if (!buffer) { buffer = this.makeBuffer(renderSoundPcm(cue)); this.sounds.set(cue, buffer); }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.sfxOutput);
      source.onended = () => { this.voices.delete(source); source.disconnect(); };
      this.voices.add(source);
      source.start();
    } catch { this.unavailable = true; }
  }
  private stopMusic(): void {
    if (!this.musicSource) return;
    this.musicOffset = (this.musicOffset + Math.max(0, (this.context?.currentTime ?? this.musicStartedAt) - this.musicStartedAt)) % MUSIC_SECONDS;
    try { this.musicSource.stop(); } catch { /* Already ended. */ }
    this.musicSource.disconnect();
    this.musicSource = null;
  }
  private stopVoices(): void {
    for (const source of this.voices) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    }
    this.voices.clear();
  }
  private stopAll(): void { this.stopMusic(); this.stopVoices(); }
  private handleVisibility = (): void => {
    if (this.page?.hidden) { this.stopAll(); return; }
    if (this.unlocked && this.enabled && !this.disposed) void this.unlock();
  };
}
