import './motion.css';
import type { Cell, SymbolId } from '../game/types';

type Point = { x: number; y: number };
type Particle = Point & {
  vx: number; vy: number; life: number; maxLife: number; radius: number;
  angle: number; spin: number; color: string; kind: 'spark' | 'shard' | 'coin';
};
type Wave = Point & { life: number; maxLife: number; radius: number; color: string };
type Bolt = { points: Point[]; branches: Point[][]; life: number; maxLife: number; strength: number };
type Counter = { element: HTMLElement; from: number; value: number; target: number; start: number; duration: number; format: (value: number) => string; resolve: () => void };
const DECORATIVE_SYMBOLS: SymbolId[] = ['sapphire', 'emerald', 'ruby', 'amethyst', 'pearl', 'amber', 'crown', 'chalice', 'emerald', 'ruby', 'sapphire', 'amethyst'];
const MAX_PARTICLES = 200;

/** All randomness here is decorative. Only supplied server cells are used at reel landing. */
export class GameMotion {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D | null;
  private atmosphere: HTMLElement | null = null;
  private resizeObserver: ResizeObserver;
  private media = matchMedia('(prefers-reduced-motion: reduce)');
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private bolts: Bolt[] = [];
  private counters = new Map<HTMLElement, Counter>();
  private activeAnimations = new Set<Animation>();
  private reelAnimations: Animation[] = [];
  private delayTasks = new Map<ReturnType<typeof setTimeout>, () => void>();
  private reelLayer: HTMLElement | null = null;
  private generation = 0;
  private raf = 0;
  private lastFrame = 0;
  private width = 0;
  private height = 0;
  private heroHeight = 0;
  private boardBounds = { x: 0, y: 0, width: 0, height: 0 };
  private nextAmbient = 0;
  private nextArc = 0;
  private nextCoin = 0;
  private celebration = false;
  private disposed = false;
  private visualSeed = 0x7468726f;

  constructor(
    private shell: HTMLElement,
    private board: HTMLElement,
    private symbolMarkup: (symbolId: string, multiplier?: number) => string,
    private reduced: () => boolean,
    private quick: () => boolean,
  ) {
    shell.classList.add('motion-enabled');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'motion-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    shell.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d', { alpha: true });
    const hero = shell.querySelector<HTMLElement>('.hero');
    if (hero) {
      this.atmosphere = document.createElement('div');
      this.atmosphere.className = 'motion-hero-atmosphere';
      this.atmosphere.setAttribute('aria-hidden', 'true');
      this.atmosphere.innerHTML = '<div class="motion-character-aura"></div><div class="motion-character"></div><div class="motion-staff-halo"></div><div class="motion-cloud"></div><div class="motion-cloud secondary"></div>';
      hero.appendChild(this.atmosphere);
    }
    this.resizeObserver = new ResizeObserver(this.measure);
    this.resizeObserver.observe(shell);
    this.resizeObserver.observe(board);
    if (hero) this.resizeObserver.observe(hero);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.media.addEventListener('change', this.onVisibility);
    this.measure();
    this.onVisibility();
  }

  private random() {
    let seed = this.visualSeed;
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    this.visualSeed = seed >>> 0;
    return this.visualSeed / 4294967296;
  }

  private measure = () => {
    const shellRect = this.shell.getBoundingClientRect();
    const boardRect = this.board.getBoundingClientRect();
    this.width = this.shell.clientWidth;
    this.height = this.shell.clientHeight;
    this.heroHeight = this.shell.querySelector<HTMLElement>('.hero')?.offsetHeight ?? this.height * .25;
    this.boardBounds = { x: boardRect.left - shellRect.left, y: boardRect.top - shellRect.top, width: boardRect.width, height: boardRect.height };
    const ratio = Math.min(devicePixelRatio || 1, 1.75);
    this.canvas.width = Math.max(1, Math.round(this.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  private onVisibility = () => {
    const quiet = this.reduced();
    this.shell.classList.toggle('motion-reduced', quiet);
    this.shell.classList.toggle('motion-paused', document.hidden);
    if (document.hidden || quiet) {
      cancelAnimationFrame(this.raf); this.raf = 0; this.lastFrame = 0;
      this.activeAnimations.forEach(animation => animation.pause());
      if (quiet) {
        this.particles = []; this.waves = []; this.bolts = [];
        this.context?.clearRect(0, 0, this.width, this.height);
        for (const counter of [...this.counters.values()]) this.finishCounter(counter);
        this.cancelReels();
      }
    } else {
      this.activeAnimations.forEach(animation => { if (animation.playState === 'paused') animation.play(); });
      this.ensureFrame();
    }
  };

  private ensureFrame() {
    if (!this.raf && !this.disposed && !document.hidden && !this.reduced()) this.raf = requestAnimationFrame(this.frame);
  }

  private track(animation: Animation) {
    this.activeAnimations.add(animation);
    if (document.hidden) animation.pause();
    void animation.finished.catch(() => undefined).finally(() => this.activeAnimations.delete(animation));
    return animation;
  }

  private delay(ms: number) {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.delayTasks.delete(timer); resolve(); }, ms);
      this.delayTasks.set(timer, resolve);
    });
  }

  private reelSymbol(symbol: string, height: number, multiplier?: number) {
    return `<div class="motion-reel-symbol symbol-${symbol}" style="height:${height}px">${this.symbolMarkup(symbol, multiplier)}</div>`;
  }

  startReels(): void {
    this.cancelReels();
    if (this.disposed || this.reduced()) return;
    this.measure();
    const layer = document.createElement('div');
    layer.className = 'motion-reels';
    layer.setAttribute('aria-hidden', 'true');
    const cellHeight = (this.board.clientHeight - 1) / 5;
    for (let column = 0; column < 6; column++) {
      const reel = document.createElement('div');
      reel.className = 'motion-reel';
      const strip = document.createElement('div');
      strip.className = 'motion-reel-strip';
      // Two identical strips make the wrap mathematically seamless; no outcome is sampled here.
      const cycle = Array.from({ length: 12 }, (_, row) => this.reelSymbol(DECORATIVE_SYMBOLS[(row * 5 + column * 3 + this.generation) % DECORATIVE_SYMBOLS.length], cellHeight)).join('');
      strip.innerHTML = cycle + cycle;
      reel.appendChild(strip); layer.appendChild(reel);
      const animation = this.track(strip.animate([
        { transform: `translate3d(0,${-12 * cellHeight}px,0)` },
        { transform: 'translate3d(0,0,0)' },
      ], { duration: (this.quick() ? 450 : 650) + column * 21, iterations: Infinity, easing: 'linear' }));
      animation.currentTime = column * 47;
      this.reelAnimations.push(animation);
    }
    this.reelLayer = layer;
    this.board.appendChild(layer);
    this.lightning(.45);
  }

  /** Render finalBoard in the underlying board first, then await this reveal. */
  async landReels(finalBoard: Cell[]): Promise<void> {
    const layer = this.reelLayer;
    if (!layer || this.reduced() || this.disposed) { this.cancelReels(); return; }
    const generation = this.generation;
    const cellHeight = (this.board.clientHeight - 1) / 5;
    const fast = this.quick();
    await Promise.all(Array.from(layer.children).map(async (node, column) => {
      await this.delay(column * (fast ? 42 : 100));
      if (generation !== this.generation || this.disposed) return;
      const reel = node as HTMLElement;
      const strip = reel.firstElementChild as HTMLElement;
      this.reelAnimations[column]?.cancel();
      const final = Array.from({ length: 5 }, (_, row) => finalBoard[row * 6 + column]);
      if (final.some(cell => !cell)) { reel.classList.add('stopped'); return; }
      const symbols = final.map(cell => this.reelSymbol(cell.symbol, cellHeight, cell.multiplier));
      for (let row = 0; row < 15; row++) symbols.push(this.reelSymbol(DECORATIVE_SYMBOLS[(row * 7 + column * 3) % DECORATIVE_SYMBOLS.length], cellHeight));
      strip.innerHTML = symbols.join('');
      reel.classList.add('landing');
      const animation = this.track(strip.animate([
        { transform: `translate3d(0,${-10 * cellHeight}px,0)`, offset: 0 },
        { transform: `translate3d(0,${cellHeight * .1}px,0)`, offset: .84 },
        { transform: `translate3d(0,${-cellHeight * .035}px,0)`, offset: .94 },
        { transform: 'translate3d(0,0,0)', offset: 1 },
      ], { duration: fast ? 330 : 670, easing: 'cubic-bezier(.12,.65,.14,1)', fill: 'forwards' }));
      await animation.finished.catch(() => undefined);
      if (generation !== this.generation || this.disposed) return;
      reel.classList.add('stopped');
      this.waves.push({ x: this.boardBounds.x + (column + .5) * this.boardBounds.width / 6, y: this.boardBounds.y + this.boardBounds.height, life: .28, maxLife: .28, radius: cellHeight * .45, color: '#81c9ff' });
    }));
    if (generation === this.generation) { layer.remove(); this.reelLayer = null; this.reelAnimations = []; }
  }

  cancelReels(): void {
    this.generation++;
    this.reelAnimations.forEach(animation => { animation.cancel(); this.activeAnimations.delete(animation); });
    this.reelAnimations = [];
    // Landing animations also target descendants of the current strip.
    if (this.reelLayer) this.reelLayer.getAnimations({ subtree: true }).forEach(animation => { animation.cancel(); this.activeAnimations.delete(animation); });
    for (const [timer, resolve] of this.delayTasks) { clearTimeout(timer); resolve(); }
    this.delayTasks.clear();
    this.reelLayer?.remove(); this.reelLayer = null;
  }

  hit(indices: number[], strength = 1): void {
    if (this.disposed || this.reduced()) return;
    this.measure();
    const shellRect = this.shell.getBoundingClientRect();
    const cells = Array.from(this.board.querySelectorAll<HTMLElement>(':scope > .cell'));
    const colors = ['#ffeaa2', '#fff8db', '#96e9ff', '#91ffdb'];
    for (const [order, index] of [...new Set(indices)].entries()) {
      const cell = cells[index]; if (!cell) continue;
      cell.classList.remove('motion-cell-impact'); void cell.offsetWidth; cell.classList.add('motion-cell-impact');
      const rect = cell.getBoundingClientRect();
      const x = rect.left - shellRect.left + rect.width / 2;
      const y = rect.top - shellRect.top + rect.height / 2;
      const color = colors[order % colors.length];
      this.waves.push({ x, y, life: .55, maxLife: .55, radius: rect.width * .75, color });
      const count = Math.min(12, Math.round(7 + strength * 2));
      for (let i = 0; i < count; i++) {
        const angle = (i / count * Math.PI * 2) + this.random() * .5;
        const speed = 40 + this.random() * 105;
        this.addParticle({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 35, life: .55 + this.random() * .55, radius: 1.2 + this.random() * 2.5, color, kind: i % 3 ? 'spark' : 'shard' });
      }
    }
    if (indices.length >= 8) this.lightning(Math.min(1.4, .7 + strength * .2));
    this.ensureFrame();
  }

  lightning(strength = 1): void {
    if (this.disposed || this.reduced()) return;
    const power = Math.max(.2, Math.min(2, strength));
    const start = { x: this.width * .84, y: this.heroHeight * .17 };
    const end = { x: this.boardBounds.x + this.boardBounds.width * (power > .7 ? .14 + this.random() * .72 : .93), y: this.boardBounds.y + (power > .7 ? this.boardBounds.height * (.15 + this.random() * .65) : 2) };
    const points = this.makeBolt(start, end, 11, 19);
    const branches = [this.makeBolt(points[5], { x: points[5].x + (this.random() - .5) * 80, y: points[5].y + 55 }, 4, 9)];
    this.bolts.push({ points, branches, life: .34 + power * .1, maxLife: .34 + power * .1, strength: power });
    if (this.bolts.length > 5) this.bolts.shift();
    if (power >= .7) this.waves.push({ ...end, life: .65, maxLife: .65, radius: 55 * power, color: '#9be7ff' });
    this.ensureFrame();
  }

  private makeBolt(start: Point, end: Point, count: number, jitter: number): Point[] {
    return Array.from({ length: count + 1 }, (_, i) => ({ x: start.x + (end.x - start.x) * i / count + (i && i < count ? (this.random() - .5) * jitter * 2 : 0), y: start.y + (end.y - start.y) * i / count }));
  }

  countUp(element: HTMLElement, amount: number, format: (value: number) => string, duration = 1400): Promise<void> {
    const previous = this.counters.get(element);
    const displayed = Number(element.textContent?.replace(/[,\s]/g, ''));
    const from = previous?.value ?? (Number.isFinite(displayed) ? displayed : 0);
    if (previous) { this.counters.delete(element); previous.resolve(); }
    if (this.disposed || this.reduced() || document.hidden || duration <= 0) { element.textContent = format(amount); return Promise.resolve(); }
    return new Promise<void>(resolve => {
      this.counters.set(element, { element, from, value: from, target: amount, start: performance.now(), duration: this.quick() ? duration * .65 : duration, format, resolve });
      element.textContent = format(from); this.ensureFrame();
    });
  }

  private finishCounter(counter: Counter) {
    counter.element.textContent = counter.format(counter.target);
    this.counters.delete(counter.element); counter.resolve();
  }

  startCelebration(): void {
    if (this.disposed) return;
    this.celebration = true;
    this.shell.classList.add('motion-celebrating');
    this.nextCoin = 0;
    if (this.reduced()) return;
    this.lightning(1.5);
    for (let i = 0; i < 45; i++) this.spawnCoin(true);
    this.ensureFrame();
  }

  stopCelebration(): void {
    this.celebration = false;
    this.shell.classList.remove('motion-celebrating');
    this.particles = this.particles.filter(particle => particle.kind !== 'coin');
    for (const counter of [...this.counters.values()]) if (counter.element.closest('.celebration')) this.finishCounter(counter);
  }

  private spawnCoin(initial = false) {
    const life = 2.7 + this.random() * 2;
    this.addParticle({ x: this.random() * this.width, y: initial ? this.random() * this.height * .82 - 30 : -20, vx: (this.random() - .5) * 60, vy: 55 + this.random() * 80, life, radius: 4 + this.random() * 7, color: '#edb64f', kind: 'coin' });
  }

  private addParticle(particle: Omit<Particle, 'maxLife' | 'angle' | 'spin'>) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ ...particle, maxLife: particle.life, angle: this.random() * Math.PI * 2, spin: (this.random() - .5) * 8 });
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed || document.hidden || this.reduced()) return;
    const dt = Math.min(.034, this.lastFrame ? (now - this.lastFrame) / 1000 : .016);
    this.lastFrame = now;
    const context = this.context;
    if (context) {
      context.clearRect(0, 0, this.width, this.height);
      if (now >= this.nextAmbient) {
        this.nextAmbient = now + 120;
        this.addParticle({ x: this.width * (.05 + this.random() * .9), y: this.heroHeight * (.3 + this.random() * .75), vx: 4 + this.random() * 8, vy: -8 - this.random() * 19, life: 1.7 + this.random(), radius: .7 + this.random() * 1.2, color: this.random() > .3 ? '#82d4ff' : '#f4cc7d', kind: 'spark' });
      }
      if (now >= this.nextArc) { this.nextArc = now + 3900 + this.random() * 3200; if (!this.celebration) this.lightning(.3); }
      if (this.celebration) {
        this.drawCelebrationRays(context, now);
        if (now >= this.nextCoin) { this.nextCoin = now + 85; for (let i = 0; i < 2; i++) this.spawnCoin(); }
      }
      this.drawBolts(context, dt);
      this.drawWaves(context, dt);
      this.drawParticles(context, dt);
    }
    for (const counter of [...this.counters.values()]) {
      const fraction = Math.min(1, Math.max(0, (now - counter.start) / counter.duration));
      counter.value = counter.from + (counter.target - counter.from) * (1 - Math.pow(1 - fraction, 3));
      counter.element.textContent = counter.format(counter.value);
      if (fraction >= 1) this.finishCounter(counter);
    }
    this.ensureFrame();
  };

  private drawCelebrationRays(context: CanvasRenderingContext2D, now: number) {
    context.save();
    context.translate(this.width * .5, this.height * .47);
    context.rotate(now / 19000);
    const radius = Math.max(this.width, this.height) * .8;
    const gradient = context.createRadialGradient(0, 0, 15, 0, 0, radius);
    gradient.addColorStop(0, '#ffdb8928'); gradient.addColorStop(.52, '#f6bd5712'); gradient.addColorStop(1, '#ffd27600');
    context.fillStyle = gradient;
    for (let i = 0; i < 12; i++) { context.rotate(Math.PI / 6); context.beginPath(); context.moveTo(0, 0); context.lineTo(-radius * .075, -radius); context.lineTo(radius * .075, -radius); context.closePath(); context.fill(); }
    context.restore();
  }

  private drawBolts(context: CanvasRenderingContext2D, dt: number) {
    context.save(); context.globalCompositeOperation = 'lighter'; context.lineJoin = 'round';
    this.bolts = this.bolts.filter(bolt => {
      bolt.life -= dt; if (bolt.life <= 0) return false;
      const ratio = bolt.life / bolt.maxLife;
      context.globalAlpha = Math.min(.85, ratio * 1.3) * bolt.strength;
      for (const points of [bolt.points, ...bolt.branches]) {
        context.beginPath(); points.forEach((point, i) => i ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.shadowColor = '#5abaff'; context.shadowBlur = 13;
        context.strokeStyle = '#3d98fc'; context.lineWidth = 3.5; context.stroke();
        context.shadowBlur = 4; context.strokeStyle = '#e2faff'; context.lineWidth = 1.1; context.stroke();
      }
      return true;
    });
    context.restore();
  }

  private drawWaves(context: CanvasRenderingContext2D, dt: number) {
    context.save(); context.globalCompositeOperation = 'lighter';
    this.waves = this.waves.filter(wave => {
      wave.life -= dt; if (wave.life <= 0) return false;
      const progress = 1 - wave.life / wave.maxLife;
      context.globalAlpha = (1 - progress) * .65;
      context.strokeStyle = wave.color; context.lineWidth = 1.8 * (1 - progress) + .3;
      context.beginPath(); context.arc(wave.x, wave.y, 4 + wave.radius * Math.sqrt(progress), 0, Math.PI * 2); context.stroke();
      if (progress < .35) {
        context.globalAlpha = (.35 - progress) * .9;
        const glow = context.createRadialGradient(wave.x, wave.y, 0, wave.x, wave.y, wave.radius * .7);
        glow.addColorStop(0, '#fffdeb'); glow.addColorStop(.25, wave.color); glow.addColorStop(1, '#80dbff00');
        context.fillStyle = glow; context.fillRect(wave.x - wave.radius, wave.y - wave.radius, wave.radius * 2, wave.radius * 2);
      }
      return true;
    });
    context.restore();
  }

  private drawParticles(context: CanvasRenderingContext2D, dt: number) {
    this.particles = this.particles.filter(particle => {
      particle.life -= dt; if (particle.life <= 0 || particle.y > this.height + 35) return false;
      particle.x += particle.vx * dt; particle.y += particle.vy * dt;
      if (particle.kind !== 'spark') particle.vy += (particle.kind === 'coin' ? 26 : 110) * dt;
      particle.angle += particle.spin * dt;
      context.save(); context.translate(particle.x, particle.y); context.rotate(particle.angle);
      context.globalAlpha = Math.min(1, particle.life / .35, (particle.maxLife - particle.life) / .07);
      if (particle.kind === 'coin') {
        const squeeze = .27 + Math.abs(Math.cos(particle.angle * 1.4)) * .73;
        context.scale(squeeze, 1);
        const gradient = context.createLinearGradient(-particle.radius, -particle.radius, particle.radius, particle.radius);
        gradient.addColorStop(0, '#fff4b2'); gradient.addColorStop(.38, '#efbd51'); gradient.addColorStop(.57, '#a7681f'); gradient.addColorStop(.84, '#ffdf7b'); gradient.addColorStop(1, '#dba142');
        context.fillStyle = gradient; context.strokeStyle = '#ffe8a0'; context.lineWidth = 1;
        context.beginPath(); context.ellipse(0, 0, particle.radius * .84, particle.radius, 0, 0, Math.PI * 2); context.fill(); context.stroke();
        context.strokeStyle = '#8f5b2399'; context.lineWidth = .7;
        context.beginPath(); context.ellipse(0, 0, particle.radius * .59, particle.radius * .75, 0, 0, Math.PI * 2); context.stroke();
        context.fillStyle = '#ffec94'; context.fillRect(-.6, -particle.radius * .4, 1.2, particle.radius * .8);
      } else {
        context.globalCompositeOperation = 'lighter'; context.fillStyle = particle.color;
        if (particle.kind === 'shard') { context.beginPath(); context.moveTo(0, -particle.radius * 2); context.lineTo(particle.radius, 0); context.lineTo(0, particle.radius * 2); context.lineTo(-particle.radius, 0); context.closePath(); context.fill(); }
        else { context.shadowBlur = 5; context.shadowColor = particle.color; context.fillRect(-particle.radius / 2, -particle.radius / 2, particle.radius, particle.radius); }
      }
      context.restore(); return true;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.cancelReels();
    this.activeAnimations.forEach(animation => animation.cancel()); this.activeAnimations.clear();
    for (const counter of [...this.counters.values()]) this.finishCounter(counter);
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.media.removeEventListener('change', this.onVisibility);
    this.canvas.remove(); this.atmosphere?.remove();
    this.shell.classList.remove('motion-enabled', 'motion-celebrating', 'motion-paused', 'motion-reduced');
    this.particles = []; this.waves = []; this.bolts = [];
  }
}
