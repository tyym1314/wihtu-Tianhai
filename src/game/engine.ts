import type { Cell, RandomSource, RoundInput, RoundResult, SymbolDefinition, SymbolId, SymbolWin } from './types';

export type { Cell, RandomSource, RoundInput, RoundResult, SymbolDefinition, SymbolId, SymbolWin } from './types';

export const COLUMNS = 6;
export const ROWS = 5;
export const BOARD_SIZE = COLUMNS * ROWS;
export const MATH_VERSION = 'thunder-0.1.0';
export const MAX_CASCADES = 24;
export const MAX_MULTIPLIER = 100;
export const MAX_WIN_MULTIPLE = 1000;
export const MIN_BET = 500;
export const MAX_BET = 100000;
/** A fixed, public paytable scale calibrated through the simulation script. */
export const PAYTABLE_SCALE = 2.176;

const define = (id: SymbolId, name: string, label: string, color: string, weight: number, payouts: readonly [number, number, number]): SymbolDefinition => ({ id, name, label, color, weight, payouts });
export const SYMBOLS: readonly SymbolDefinition[] = [
  define('ruby', 'Ruby', '红宝石', '#ff4b69', 172, [1200, 3000, 7000]),
  define('emerald', 'Emerald', '祖母绿', '#5dfbc0', 157, [1400, 3500, 8000]),
  define('sapphire', 'Sapphire', '蓝宝石', '#55bfff', 142, [1700, 4200, 10000]),
  define('amethyst', 'Amethyst', '紫水晶', '#b277ff', 127, [2000, 5000, 12000]),
  define('amber', 'Amber', '琥珀', '#ffd260', 112, [2500, 6500, 15000]),
  define('crown', 'Crown', '王冠', '#ffcf7a', 97, [3500, 8500, 20000]),
  define('chalice', 'Chalice', '圣杯', '#ffeac0', 82, [5000, 12000, 30000]),
  define('pearl', 'Pearl', '珍珠', '#ef9aff', 67, [7000, 17000, 40000]),
  define('scatter', 'Scatter', '雷霆之门', '#f7d681', 24, [0, 0, 0]),
  define('multiplier', 'Multiplier', '倍率球', '#bd9bff', 20, [0, 0, 0]),
];
const TOTAL_WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
const PAYING_SYMBOLS = SYMBOLS.filter(symbol => symbol.payouts[0] > 0);
const MULTIPLIERS = [{ value: 2, weight: 60 }, { value: 3, weight: 25 }, { value: 5, weight: 10 }, { value: 10, weight: 4 }, { value: 20, weight: 1 }];

export const GAME_CONFIG = {
  mathVersion: MATH_VERSION, columns: COLUMNS, rows: ROWS,
  minBet: MIN_BET, maxBet: MAX_BET, currencyScale: 100,
  targetRtp: 0.99, symbols: SYMBOLS, paytableScale: PAYTABLE_SCALE,
  maxCascades: MAX_CASCADES, maxMultiplier: MAX_MULTIPLIER, maxWinMultiple: MAX_WIN_MULTIPLE,
  scatterTrigger: 4, freeSpinsOnTrigger: 15, scatterRetrigger: 3, freeSpinsOnRetrigger: 5,
  multiplierValues: MULTIPLIERS,
} as const;

/** Cryptographic default. Rejection sampling avoids modulo bias. */
export const secureRandomInt: RandomSource = (maxExclusive) => {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) throw new RangeError('Invalid random range');
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const value = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(value); } while (value[0] >= limit);
  return value[0] % maxExclusive;
};

/** Seeded, reproducible simulation RNG; never use this for production outcomes. */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  const word = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return maxExclusive => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) throw new RangeError('Invalid random range');
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let value: number;
    do { value = word(); } while (value >= limit);
    return value % maxExclusive;
  };
}

/** Board-only pay evaluation, shared by the engine and tests. */
export function evaluateBoard(board: readonly Cell[], bet: number): SymbolWin[] {
  if (board.length !== BOARD_SIZE) throw new RangeError('Expected exactly 30 cells');
  const positions: Partial<Record<SymbolId, number[]>> = {};
  for (let index = 0; index < board.length; index++) (positions[board[index].symbol] ??= []).push(index);
  const wins: SymbolWin[] = [];
  for (const symbol of PAYING_SYMBOLS) {
    const indices = positions[symbol.id];
    if (!indices || indices.length < 8) continue;
    const band = indices.length >= 12 ? 2 : indices.length >= 10 ? 1 : 0;
    wins.push({ symbol: symbol.id, count: indices.length, indices, payout: Math.round(bet * symbol.payouts[band] * PAYTABLE_SCALE / 10000) });
  }
  return wins;
}

/** Deterministic settlement rules for already-drawn multipliers. */
export function settleMultiplier(baseWin: number, collectedMultiplier: number, isFreeSpin: boolean, freeMultiplier: number) {
  const earned = baseWin > 0 ? collectedMultiplier : 0;
  const nextFreeMultiplier = isFreeSpin ? Math.min(MAX_MULTIPLIER, freeMultiplier + earned) : 0;
  const multiplier = isFreeSpin ? Math.max(1, nextFreeMultiplier) : Math.max(1, Math.min(MAX_MULTIPLIER, collectedMultiplier));
  return { multiplier, nextFreeMultiplier };
}

export function generateRound(input: RoundInput, random: RandomSource = secureRandomInt): RoundResult {
  const { bet, freeSpins, freeMultiplier } = input;
  if (!Number.isSafeInteger(bet) || bet < MIN_BET || bet > MAX_BET || bet % 100 !== 0) throw new RangeError('Stake must be 5–1000 coins in whole coins');
  if (!Number.isSafeInteger(freeSpins) || freeSpins < 0 || freeSpins > 100000) throw new RangeError('Invalid free spins');
  if (!Number.isSafeInteger(freeMultiplier) || freeMultiplier < 0 || freeMultiplier > MAX_MULTIPLIER) throw new RangeError('Invalid free multiplier');
  let id = 0;
  const drawCell = (): Cell => {
    let draw = random(TOTAL_WEIGHT);
    let symbol = SYMBOLS[SYMBOLS.length - 1];
    for (const candidate of SYMBOLS) {
      if (draw < candidate.weight) { symbol = candidate; break; }
      draw -= candidate.weight;
    }
    const cell: Cell = { id: `c${id++}`, symbol: symbol.id };
    if (symbol.id === 'multiplier') {
      let multiplierDraw = random(100);
      for (const candidate of MULTIPLIERS) {
        if (multiplierDraw < candidate.weight) { cell.multiplier = candidate.value; break; }
        multiplierDraw -= candidate.weight;
      }
    }
    return cell;
  };
  let board = Array.from({ length: BOARD_SIZE }, drawCell);
  const initialBoard = board;
  const steps: RoundResult['steps'] = [];
  let baseWin = 0;
  let cascadeLimitReached = false;
  for (let cascade = 0; cascade < MAX_CASCADES; cascade++) {
    const wins = evaluateBoard(board, bet);
    if (wins.length === 0) break;
    const winningIndices = wins.flatMap(win => win.indices);
    const stepWin = wins.reduce((sum, win) => sum + win.payout, 0);
    steps.push({ index: cascade, board, winningIndices, wins, baseWin: stepWin });
    baseWin += stepWin;
    // The last permitted winning board is paid, then ends without another refill.
    if (cascade === MAX_CASCADES - 1) { cascadeLimitReached = true; break; }
    const removed = new Set(winningIndices);
    const nextBoard: Cell[] = new Array(BOARD_SIZE);
    for (let column = 0; column < COLUMNS; column++) {
      const survivors = Array.from({ length: ROWS }, (_, row) => row * COLUMNS + column)
        .filter(index => !removed.has(index)).map(index => board[index]);
      const additions = Array.from({ length: ROWS - survivors.length }, drawCell);
      const columnCells = [...additions, ...survivors];
      columnCells.forEach((cell, row) => { nextBoard[row * COLUMNS + column] = cell; });
    }
    board = nextBoard;
  }
  const scatters = board.filter(cell => cell.symbol === 'scatter').length;
  const collectedMultiplier = board.reduce((sum, cell) => sum + (cell.multiplier ?? 0), 0);
  const isFreeSpin = freeSpins > 0;
  const { multiplier, nextFreeMultiplier } = settleMultiplier(baseWin, collectedMultiplier, isFreeSpin, freeMultiplier);
  const uncappedWin = baseWin * multiplier;
  return {
    mathVersion: MATH_VERSION, initialBoard, steps, endBoard: board, bet, isFreeSpin,
    baseWin, totalWin: Math.min(bet * MAX_WIN_MULTIPLE, uncappedWin), multiplier,
    collectedMultiplier, nextFreeMultiplier, scatters,
    freeSpinsAwarded: isFreeSpin ? (scatters >= 3 ? 5 : 0) : (scatters >= 4 ? 15 : 0),
    cascadeLimitReached, winCapReached: uncappedWin > bet * MAX_WIN_MULTIPLE,
  };
}

/** Static attract screen, without implying a settled or winning round. */
export const INITIAL_BOARD: Cell[] = [
  'crown', 'emerald', 'ruby', 'sapphire', 'amethyst', 'chalice',
  'amethyst', 'sapphire', 'amber', 'ruby', 'emerald', 'pearl',
  'ruby', 'crown', 'multiplier', 'scatter', 'sapphire', 'amber',
  'amber', 'pearl', 'emerald', 'amethyst', 'chalice', 'ruby',
  'sapphire', 'amethyst', 'chalice', 'amber', 'ruby', 'crown',
].map((symbol, index) => ({ id: `initial-${index}`, symbol: symbol as SymbolId, ...(symbol === 'multiplier' ? { multiplier: 5 } : {}) }));
