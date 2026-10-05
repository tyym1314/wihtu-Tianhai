import './character.css';

export type TigerReaction = 'spin' | 'anticipation' | 'win' | 'big' | 'respin';

/** A transparent, articulated 2D rig made from original rendered 3D character art. */
export class TigerCharacter {
  private readonly root: HTMLDivElement;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly active = new Set<Animation>();
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly onVisibility = () => this.syncMotion();
  private readonly onReduced = () => this.syncMotion();

  constructor(private readonly host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tiger-mascot';
    this.root.dataset.action = 'idle';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <div class="tiger-mascot-halo"></div>
      <div class="tiger-mascot-sparkles"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="tiger-mascot-pose"><div class="tiger-mascot-breath">
        <div class="tiger-tail-idle"><div class="tiger-sprite tiger-part-tail"></div></div>
        <div class="tiger-left-pose"><div class="tiger-left-idle"><div class="tiger-sprite tiger-part-left"></div></div></div>
        <div class="tiger-right-pose"><div class="tiger-right-idle"><div class="tiger-sprite tiger-part-right"></div></div></div>
        <div class="tiger-sprite tiger-part-body"></div>
        <div class="tiger-head-pose"><div class="tiger-head-idle">
          <div class="tiger-sprite tiger-part-head"></div>
          <div class="tiger-sprite tiger-part-blink"></div>
        </div></div>
      </div></div>`;
    host.append(this.root);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.reduced.addEventListener('change', this.onReduced);
    this.syncMotion();

    Promise.all(['idle', 'win', 'blink'].map(pose => new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Tiger ${pose} artwork did not load`));
      image.src = `/assets/tiger/character-${pose}.png`;
    }))).then(() => {
      if (!this.disposed) {
        this.root.dataset.ready = 'true';
        this.host.dataset.characterReady = 'true';
      }
    }).catch(() => {
      if (!this.disposed) this.host.dataset.characterReady = 'partial';
    });
  }

  private part(selector: string) { return this.root.querySelector<HTMLElement>(selector)!; }

  private play(selector: string, frames: Keyframe[], duration: number, delay = 0) {
    const animation = this.part(selector).animate(frames, {
      duration, delay, easing: 'cubic-bezier(.22,.7,.2,1)', fill: 'none',
    });
    this.active.add(animation);
    animation.finished.then(() => this.active.delete(animation)).catch(() => this.active.delete(animation));
    return animation;
  }

  react(kind: TigerReaction) {
    if (this.disposed) return;
    clearTimeout(this.resetTimer);
    for (const animation of this.active) animation.cancel();
    this.active.clear();
    this.root.dataset.action = kind;
    const celebration = kind === 'win' || kind === 'big' || kind === 'respin';
    this.root.classList.toggle('is-cheering', celebration);
    const duration = kind === 'big' ? 3300 : kind === 'respin' ? 2700 : kind === 'win' ? 2200 : 1900;
    if (!this.reduced.matches && !document.hidden) {
      if (celebration) {
        this.play('.tiger-mascot-pose', [
          { transform: 'translateY(0) scale(1)' },
          { transform: 'translateY(5px) scale(.97,1.02)', offset: .08 },
          { transform: 'translateY(-14px) scale(1.045,.985)', offset: .23 },
          { transform: 'translateY(1px) scale(1.015)', offset: .4 },
          { transform: 'translateY(-8px) scale(1.025)', offset: .6 },
          { transform: 'translateY(0) scale(1)' },
        ], duration);
        this.play('.tiger-head-pose', [
          { transform: 'rotate(0deg)' }, { transform: 'rotate(-5deg)', offset: .23 },
          { transform: 'rotate(3.5deg)', offset: .46 }, { transform: 'rotate(-2.5deg)', offset: .72 },
          { transform: 'rotate(0deg)' },
        ], duration);
        this.play('.tiger-left-pose', [
          { transform: 'rotate(0deg)' }, { transform: 'rotate(9deg)', offset: .2 },
          { transform: 'rotate(-4deg)', offset: .38 }, { transform: 'rotate(9deg)', offset: .6 },
          { transform: 'rotate(-3deg)', offset: .8 }, { transform: 'rotate(0deg)' },
        ], duration);
        this.play('.tiger-right-pose', [
          { transform: 'rotate(0deg)' }, { transform: 'rotate(-9deg)', offset: .2 },
          { transform: 'rotate(4deg)', offset: .38 }, { transform: 'rotate(-9deg)', offset: .6 },
          { transform: 'rotate(3deg)', offset: .8 }, { transform: 'rotate(0deg)' },
        ], duration, 40);
      } else {
        const anticipation = kind === 'anticipation';
        this.play('.tiger-mascot-pose', [
          { transform: 'translateY(0) scale(1)' },
          { transform: `translateY(${anticipation ? '6' : '3'}px) scale(.99,1.01)`, offset: .3 },
          { transform: 'translateY(0) scale(1)' },
        ], duration);
        this.play('.tiger-head-pose', [
          { transform: 'rotate(0deg) translateY(0)' },
          { transform: 'rotate(5deg) translateY(3px)', offset: .25 },
          { transform: 'rotate(-3deg) translateY(1px)', offset: .62 },
          { transform: 'rotate(0deg) translateY(0)' },
        ], duration);
        this.play('.tiger-left-pose', [
          { transform: 'rotate(0)' }, { transform: 'rotate(-8deg)', offset: .25 },
          { transform: 'rotate(2deg)', offset: .64 }, { transform: 'rotate(0)' },
        ], duration);
        this.play('.tiger-right-pose', [
          { transform: 'rotate(0)' }, { transform: 'rotate(8deg)', offset: .27 },
          { transform: 'rotate(-2deg)', offset: .68 }, { transform: 'rotate(0)' },
        ], duration);
      }
    }
    this.resetTimer = setTimeout(() => {
      if (!this.disposed) {
        this.root.dataset.action = 'idle';
        this.root.classList.remove('is-cheering');
      }
    }, duration + 90);
  }

  private syncMotion() {
    const paused = document.hidden || this.reduced.matches;
    this.root.classList.toggle('is-paused', paused);
    for (const animation of this.active) paused ? animation.pause() : animation.play();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.resetTimer);
    for (const animation of this.active) animation.cancel();
    this.active.clear();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reduced.removeEventListener('change', this.onReduced);
    this.root.remove();
    delete this.host.dataset.characterReady;
  }
}
