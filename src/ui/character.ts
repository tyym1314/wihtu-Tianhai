import './character.css';

type HeroReaction = 'spin' | 'win' | 'big' | 'bonus';

/** A small 2D cutout rig: independently articulated head, cape, torso and staff arm. */
export class HeroCharacter {
  private stage: HTMLDivElement;
  private body: HTMLElement;
  private head: HTMLElement;
  private arm: HTMLElement;
  private energy: HTMLElement;
  private actions = new Set<Animation>();
  private assets: HTMLImageElement[] = [];
  private media = matchMedia('(prefers-reduced-motion: reduce)');
  private disposed = false;
  private generation = 0;
  private loaded = 0;

  constructor(private hero: HTMLElement, private reduced: () => boolean) {
    this.stage = document.createElement('div');
    this.stage.className = 'hero-character-stage';
    this.stage.setAttribute('aria-hidden', 'true');
    this.stage.innerHTML = `
      <div class="character-rig">
        <div class="character-body-pose"><div class="character-breath">
          <div class="character-cape-pose"><div class="character-piece character-piece-cape"></div></div>
          <div class="character-piece character-piece-torso"></div>
          <div class="character-head-pose"><div class="character-head-idle"><div class="character-piece character-piece-head"></div></div></div>
          <div class="character-arm-pose"><div class="character-arm-idle"><div class="character-piece character-piece-arm"></div><div class="character-staff-light"></div><div class="character-energy"></div></div></div>
        </div></div>
      </div>`;
    this.body = this.stage.querySelector('.character-body-pose')!;
    this.head = this.stage.querySelector('.character-head-pose')!;
    this.arm = this.stage.querySelector('.character-arm-pose')!;
    this.energy = this.stage.querySelector('.character-energy')!;
    hero.appendChild(this.stage);
    document.addEventListener('visibilitychange', this.syncVisibility);
    this.media.addEventListener('change', this.syncVisibility);
    this.syncVisibility();
    // Swap away from the painted character only when both independent assets loaded.
    for (const source of ['/assets/hero-scene.png', '/assets/hero-character.png']) {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        if (this.disposed) return;
        if (++this.loaded === 2) {
          hero.classList.add('hero-character-ready');
          hero.dataset.characterReady = 'true';
        }
      };
      image.onerror = () => { if (!this.disposed) hero.dataset.characterReady = 'false'; };
      this.assets.push(image);
      image.src = source;
    }
  }

  private syncVisibility = () => {
    const quiet = this.reduced();
    this.hero.classList.toggle('hero-character-reduced', quiet);
    this.hero.classList.toggle('hero-character-paused', document.hidden);
    if (quiet) this.cancelAction();
    else this.actions.forEach(animation => {
      if (document.hidden) animation.pause();
      else if (animation.playState === 'paused') animation.play();
    });
  };

  private animate(element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = element.animate(frames, options);
    this.actions.add(animation);
    if (document.hidden) animation.pause();
    void animation.finished.catch(() => undefined).finally(() => this.actions.delete(animation));
    return animation;
  }

  private cancelAction() {
    this.generation++;
    this.actions.forEach(animation => animation.cancel());
    this.actions.clear();
    this.hero.classList.remove('hero-character-reacting', 'hero-character-bonus');
    delete this.hero.dataset.characterAction;
  }

  react(kind: HeroReaction): void {
    if (this.disposed || this.reduced() || document.hidden) return;
    this.cancelAction();
    const generation = this.generation;
    const duration = kind === 'spin' ? 1400 : kind === 'win' ? 1750 : kind === 'big' ? 2400 : 2650;
    const strength = kind === 'spin' ? 1 : kind === 'win' ? 1.32 : kind === 'big' ? 1.72 : 1.52;
    this.hero.classList.add('hero-character-reacting');
    this.hero.classList.toggle('hero-character-bonus', kind === 'bonus');
    this.hero.dataset.characterAction = kind;
    const options: KeyframeAnimationOptions = { duration, easing: 'cubic-bezier(.2,.7,.25,1)' };
    const body = this.animate(this.body, [
      { transform: 'translateY(0) rotate(0deg)', offset: 0 },
      { transform: `translateY(${1.5 * strength}px) rotate(${-1 * strength}deg)`, offset: .17 },
      { transform: `translateY(${-2 * strength}px) rotate(${.8 * strength}deg)`, offset: .45 },
      { transform: 'translateY(0) rotate(0deg)', offset: 1 },
    ], options);
    this.animate(this.arm, [
      { transform: 'rotate(0deg) translateY(0)', offset: 0 },
      { transform: `rotate(${3.4 * strength}deg) translateY(1px)`, offset: .18 },
      { transform: `rotate(${-9 * strength}deg) translateY(${-3.5 * strength}px)`, offset: .43 },
      { transform: `rotate(${-6.5 * strength}deg) translateY(${-2 * strength}px)`, offset: .66 },
      { transform: 'rotate(0deg) translateY(0)', offset: 1 },
    ], options);
    this.animate(this.head, [
      { transform: 'rotate(0deg) translateY(0)', offset: 0 },
      { transform: `rotate(${-2.2 * strength}deg) translateY(1px)`, offset: .2 },
      { transform: `rotate(${3.3 * strength}deg) translateY(${-1.8 * strength}px)`, offset: .46 },
      { transform: `rotate(${-1.4 * strength}deg) translateY(.5px)`, offset: .72 },
      { transform: 'rotate(0deg) translateY(0)', offset: 1 },
    ], options);
    this.animate(this.energy, [
      { opacity: 0, transform: 'scale(.75)', offset: 0 },
      { opacity: .4, transform: 'scale(.88)', offset: .21 },
      { opacity: kind === 'spin' ? .8 : 1, transform: `scale(${kind === 'bonus' ? 1.25 : 1})`, offset: .44 },
      { opacity: .64, transform: 'scale(1.09)', offset: .67 },
      { opacity: 0, transform: 'scale(1.2)', offset: 1 },
    ], options);
    void body.finished.catch(() => undefined).then(() => {
      if (this.disposed || generation !== this.generation) return;
      this.hero.classList.remove('hero-character-reacting', 'hero-character-bonus');
      delete this.hero.dataset.characterAction;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAction();
    document.removeEventListener('visibilitychange', this.syncVisibility);
    this.media.removeEventListener('change', this.syncVisibility);
    this.assets.forEach(image => { image.onload = null; image.onerror = null; });
    this.assets = [];
    this.stage.remove();
    this.hero.classList.remove('hero-character-ready', 'hero-character-reduced', 'hero-character-paused');
    delete this.hero.dataset.characterReady;
  }
}
