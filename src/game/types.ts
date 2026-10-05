export type SymbolId = 'ruby' | 'emerald' | 'sapphire' | 'amethyst' | 'amber' | 'crown' | 'chalice' | 'pearl' | 'scatter' | 'multiplier';

export interface Cell {
  id: string;
  symbol: SymbolId;
  multiplier?: number;
}

export interface SymbolDefinition {
  id: SymbolId;
  name: string;
  label: string;
  color: string;
  weight: number;
  /** Total stake multiples, represented in basis points, for 8–9 / 10–11 / 12+ symbols. */
  payouts: readonly [number, number, number];
}

export interface SymbolWin {
  symbol: SymbolId;
  count: number;
  indices: number[];
  /** Before the round multiplier; integer minor currency units. */
  payout: number;
}

export interface CascadeStep {
  index: number;
  board: Cell[];
  winningIndices: number[];
  wins: SymbolWin[];
  baseWin: number;
}

export interface RoundInput {
  /** Integer minor units. 100 minor units = 1 displayed coin. */
  bet: number;
  /** Remaining free spins before this round. 0 selects a paid round. */
  freeSpins: number;
  freeMultiplier: number;
}

export interface RoundResult {
  mathVersion: string;
  initialBoard: Cell[];
  steps: CascadeStep[];
  endBoard: Cell[];
  bet: number;
  isFreeSpin: boolean;
  baseWin: number;
  totalWin: number;
  /** The actual multiplier used on this round; always at least 1. */
  multiplier: number;
  /** Sum of all multiplier balls in the final board, before the 100× cap. */
  collectedMultiplier: number;
  nextFreeMultiplier: number;
  scatters: number;
  freeSpinsAwarded: number;
  cascadeLimitReached: boolean;
  winCapReached: boolean;
}

/** Must return a uniform integer in [0, maxExclusive). */
export type RandomSource = (maxExclusive: number) => number;
