// Applied only to the isolated legacy build. The original synthesis functions
// remain byte-for-byte identical and execute in a single disposable worker.
export function prepareLegacyAudio(original) {
  const boundary = original.indexOf('export class GameAudio');
  if (boundary < 0) throw new Error('Audio synthesis boundary changed');
  let source = original;
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`Audio preparation anchor changed: ${before.slice(0, 80)}`);
    source = source.replace(before, after);
  };
  replace('  private musicOffset = 0;', `  private hostGain = 1;
  private stopHostState: (() => void) | null = null;
  private stopPreparation: (() => void) | null = null;
  private preparationTimer: ReturnType<typeof setTimeout> | null = null;
  private pcmFailed = false;
  private preparedMusic: Float32Array | null = null;
  private preparedSounds = new Map<SoundCue, Float32Array>();
  private musicOffset = 0;`);
  replace("    this.page?.addEventListener('visibilitychange', this.handleVisibility);", `    this.page?.addEventListener('visibilitychange', this.handleVisibility);
    this.stopHostState = subscribeHostState(state => {
      this.hostGain = state.muted || !state.visible ? 0 : state.voiceActive ? .25 : 1;
      this.updateVolumes();
    });
    this.startPreparation();
    // Creating a suspended context is allowed before a gesture in supporting
    // browsers. Failure here is temporary: unlock() retries inside the gesture.
    this.prepareContext();`);
  const oldContext = `      if (!this.context) {
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
      const context = this.context;`;
  replace(oldContext, `      if (!this.prepareContext()) { this.unavailable = true; return; }
      const context = this.context!;
      // A fallback graph may have been created in this gesture. Copy its bank
      // in a later task; never put PCM allocation/copy before native resume().
      this.queuePreparedBuffers();`);
  replace("      this.unavailable = context.state !== 'running';", "      this.unavailable = this.pcmFailed || context.state !== 'running';");
  replace('      this.musicBuffer ??= this.makeBuffer(renderMusicPcm());', '      if (!this.musicBuffer) return;');
  replace('    if (!this.enabled || !this.wantsSfx || !this.sfxLevel || !context || !this.sfxOutput || this.page?.hidden || context.state !== \'running\') return;', '    if (!this.enabled || !this.unlocked || !this.wantsSfx || !this.sfxLevel || !context || !this.sfxOutput || this.page?.hidden || context.state !== \'running\') return;');
  replace('      let buffer = this.sounds.get(cue);\n      if (!buffer) { buffer = this.makeBuffer(renderSoundPcm(cue)); this.sounds.set(cue, buffer); }', '      const buffer = this.sounds.get(cue);\n      if (!buffer) return;');
  replace('    this.disposed = true;', `    this.disposed = true;
    this.stopHostState?.();
    this.stopHostState = null;
    this.stopPreparation?.();
    if (this.preparationTimer !== null) clearTimeout(this.preparationTimer);
    this.preparationTimer = null;
    this.preparedMusic = null;
    this.preparedSounds.clear();`);
  replace('this.musicLevel * 0.48 : 0', 'this.musicLevel * 0.48 * this.hostGain : 0');
  replace('this.sfxLevel * 0.9 : 0', 'this.sfxLevel * 0.9 * this.hostGain : 0');
  replace('  private async ensureContext(): Promise<void> {', `  private startPreparation(): void {
    let worker: Worker | null = null;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
      this.stopPreparation = null;
    };
    const fail = (): void => {
      if (done || this.disposed) return;
      this.pcmFailed = true;
      this.unavailable = true;
      finish();
    };
    const timer = setTimeout(fail, 15000);
    this.stopPreparation = finish;
    try {
      worker = new Worker(new URL('./audio-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        if (done || this.disposed) return;
        this.preparedMusic = event.data.music;
        for (const sound of event.data.sounds) this.preparedSounds.set(sound.cue, sound.pcm);
        finish();
        this.prepareBuffers();
        this.syncMusic();
      };
      worker.onerror = fail;
    } catch { fail(); }
  }
  private prepareContext(): boolean {
    if (this.disposed || typeof window === 'undefined') return false;
    if (this.context) return true;
    let context: AudioContext | null = null;
    let music: GainNode | null = null;
    let sfx: GainNode | null = null;
    try {
      const browser = window as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Constructor = browser.AudioContext ?? browser.webkitAudioContext;
      if (!Constructor) return false;
      context = new Constructor();
      music = context.createGain();
      sfx = context.createGain();
      music.connect(context.destination);
      sfx.connect(context.destination);
      music.gain.value = this.enabled ? this.musicLevel * 0.48 * this.hostGain : 0;
      sfx.gain.value = this.enabled && this.wantsSfx ? this.sfxLevel * 0.9 * this.hostGain : 0;
      // Publish the singleton only after the complete graph is usable.
      this.context = context;
      this.musicOutput = music;
      this.sfxOutput = sfx;
      return true;
    } catch {
      try { music?.disconnect(); } catch { /* Partially connected graph. */ }
      try { sfx?.disconnect(); } catch { /* Partially connected graph. */ }
      try { if (context && context.state !== 'closed') void context.close().catch(() => {}); } catch { /* Failed context. */ }
      return false;
    }
  }
  private prepareBuffers(): void {
    if (this.disposed || !this.prepareContext()) return;
    try {
      if (this.preparedMusic) {
        this.musicBuffer = this.makeBuffer(this.preparedMusic);
        this.preparedMusic = null;
      }
      for (const [cue, pcm] of this.preparedSounds) {
        this.sounds.set(cue, this.makeBuffer(pcm));
        this.preparedSounds.delete(cue);
      }
    } catch { /* Keep uncopied PCM for a later unlock attempt. */ }
  }
  private queuePreparedBuffers(): void {
    if (this.preparationTimer !== null || (!this.preparedMusic && !this.preparedSounds.size)) return;
    this.preparationTimer = setTimeout(() => {
      this.preparationTimer = null;
      this.prepareBuffers();
      this.syncMusic();
    }, 0);
  }
  private async ensureContext(): Promise<void> {`);
  return {
    source: "import {subscribeHostState} from '../../bridge';\n" + source,
    synthesis: original.slice(0, boundary),
    worker: `import {renderMusicPcm,renderSoundPcm} from './audio-synthesis';
const cues=['click','spin','land','small','big','scatter'] as const;
const music=renderMusicPcm(),sounds=cues.map(cue=>({cue,pcm:renderSoundPcm(cue)}));
self.postMessage({music,sounds},[music.buffer,...sounds.map(s=>s.pcm.buffer)]);
`,
  };
}
