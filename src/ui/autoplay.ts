export const AUTO_PLAY_COUNTS = [10, 25, 50, 100] as const;

export interface AutoPlayOptions {
  /** Read fresh session state before every request. canPlay must include free rounds. */
  getState: () => { freeSpins: number; canPlay: boolean };
  /** Resolve only after settlement, animation, acknowledgement, and session refresh. */
  play: () => Promise<{ isFreeSpin: boolean } | null>;
  onChange: () => void;
  betweenRounds?: () => Promise<void>;
}

/** A finite, in-memory queue. Starting it always requires an explicit UI action. */
export class AutoPlay {
  private isActive = false;
  private paidRemaining = 0;
  private isInFlight = false;
  private running = false;
  private generation = 0;
  private cancelPause: (() => void) | null = null;

  constructor(private readonly options: AutoPlayOptions) {}

  get active(): boolean { return this.isActive; }
  get remaining(): number { return this.paidRemaining; }
  get inFlight(): boolean { return this.isInFlight; }

  /** Resolves when the sequence has finished or stopped; failures reject after cleanup. */
  start(paidSpins: number): Promise<void> {
    if (!Number.isSafeInteger(paidSpins) || paidSpins < 1 || paidSpins > 100) {
      return Promise.reject(new RangeError('Auto play requires 1–100 paid spins.'));
    }
    // A stopped request still owns its result until play() has completely finished.
    if (this.running || this.isInFlight) {
      return Promise.reject(new Error('Auto play is already running or finishing a round.'));
    }

    this.running = true;
    this.isActive = true;
    this.paidRemaining = paidSpins;
    const generation = ++this.generation;
    const cancelled = new Promise<void>(resolve => { this.cancelPause = resolve; });
    return this.run(generation, cancelled);
  }

  /** Never abort an already submitted round. Only prevent the next request. */
  stop(): void {
    if (!this.isActive) return;
    this.isActive = false;
    ++this.generation;
    this.cancelPause?.();
    this.options.onChange();
  }

  private ownsRun(generation: number): boolean {
    return this.isActive && this.generation === generation;
  }

  private canContinue(): boolean {
    const state = this.options.getState();
    return state.canPlay && (this.paidRemaining > 0 || state.freeSpins > 0);
  }

  private async run(generation: number, cancelled: Promise<void>): Promise<void> {
    try {
      this.options.onChange();
      while (this.ownsRun(generation) && this.canContinue()) {
        this.isInFlight = true;
        this.options.onChange();
        // An onChange handler may stop the queue, e.g. after a visibility change.
        if (!this.ownsRun(generation)) break;

        const result = await this.options.play();
        this.isInFlight = false;
        // A stopped, already submitted paid round still consumed one selection.
        if (result && !result.isFreeSpin) {
          this.paidRemaining = Math.max(0, this.paidRemaining - 1);
        }
        this.options.onChange();
        if (!result || !this.ownsRun(generation) || !this.canContinue()) break;

        if (this.options.betweenRounds) {
          // Cancel a cosmetic pause immediately, without cancelling a server round.
          await Promise.race([this.options.betweenRounds(), cancelled]);
        }
      }
    } finally {
      this.isInFlight = false;
      this.isActive = false;
      this.cancelPause?.();
      this.cancelPause = null;
      this.running = false;
      this.options.onChange();
    }
  }
}
