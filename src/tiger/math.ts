import type { TigerLineWin, TigerRandom, TigerRoundInput, TigerRoundResult, TigerStep, TigerSymbol } from './types.js';
export type * from './types.js';

export const TIGER_MATH_VERSION = 'tiger-original-1.0.0';
export const TIGER_UNITS_PER_COIN = 100;
export const TIGER_BET_CHOICES = [10, 50, 100, 200, 500];
export const TIGER_PAYLINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [6, 4, 2]] as const;
export const TIGER_MAX_RESPINS = 7;
/** Public, fixed paytable. A payout of 10000 means 1x TOTAL stake per winning line. */
export const TIGER_SYMBOLS: readonly { id: TigerSymbol; weight: number; payoutBps: number }[] = [
  { id: 'tiger', weight: 2, payoutBps: 91000 },
  { id: 'ingot', weight: 8, payoutBps: 45500 },
  { id: 'coin', weight: 10, payoutBps: 27300 },
  { id: 'jade', weight: 14, payoutBps: 18200 },
  { id: 'envelope', weight: 18, payoutBps: 10920 },
  { id: 'firecracker', weight: 22, payoutBps: 7280 },
  { id: 'orange', weight: 26, payoutBps: 4550 },
];
const totalWeight = TIGER_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
const paytable = Object.fromEntries(TIGER_SYMBOLS.map(symbol => [symbol.id, symbol.payoutBps])) as Record<TigerSymbol, number>;
const validSymbols = new Set(TIGER_SYMBOLS.map(symbol => symbol.id));

function pick(random: TigerRandom): TigerSymbol {
  let roll = random(totalWeight);
  if (!Number.isInteger(roll) || roll < 0 || roll >= totalWeight) throw new Error('Random source returned an out-of-range integer.');
  for (const symbol of TIGER_SYMBOLS) {
    if (roll < symbol.weight) return symbol.id;
    roll -= symbol.weight;
  }
  throw new Error('Invalid symbol weights.');
}

export function evaluateTigerBoard(board: readonly TigerSymbol[], bet: number) {
  if (board.length !== 9 || board.some(symbol => !validSymbols.has(symbol))) throw new Error('A Tiger board must contain 9 valid symbols.');
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > 100_000_000) throw new Error('Invalid minor-unit stake.');
  const lineWins: TigerLineWin[] = [];
  const winning = new Set<number>();
  for (let lineIndex = 0; lineIndex < TIGER_PAYLINES.length; lineIndex++) {
    const indices = TIGER_PAYLINES[lineIndex];
    const regular = indices.map(index => board[index]).filter(symbol => symbol !== 'tiger');
    const symbol = regular[0] ?? 'tiger';
    if (regular.every(item => item === symbol)) {
      const payout = Math.floor(bet * paytable[symbol] / 10_000);
      lineWins.push({ lineIndex, symbol, indices: [...indices], payout });
      indices.forEach(index => winning.add(index));
    }
  }
  return {
    lineWins, winningIndices: [...winning].sort((a, b) => a - b),
    baseWin: lineWins.reduce((sum, line) => sum + line.payout, 0),
    fullBoard: winning.size === 9,
  };
}

/**
 * Independent local-demo mathematics; not PG's engine/paytable/RNG.
 * Initial wins retain every winning cell and every matching feature symbol.
 * Re-spins retain more matching symbols and any newly completed line. A step
 * with no newly held cells ends the feature. Only the final board is paid.
 */
export function generateTigerRound(input: TigerRoundInput, random: TigerRandom): TigerRoundResult {
  if (!Number.isSafeInteger(input.bet) || input.bet < 1 || input.bet > 100_000_000) throw new Error('Invalid minor-unit stake.');
  const board: TigerSymbol[] = Array.from({ length: 9 }, () => pick(random));
  const initialBoard = [...board];
  const first = evaluateTigerBoard(board, input.bet);
  const featureSymbol = first.lineWins.length
    ? first.lineWins.reduce((best, win) => paytable[win.symbol] > paytable[best.symbol] ? win : best).symbol
    : null;
  const locked = new Set(first.winningIndices);
  if (featureSymbol) board.forEach((symbol, index) => {
    if (symbol === featureSymbol || symbol === 'tiger') locked.add(index);
  });
  const orderedLocked = () => [...locked].sort((a, b) => a - b);
  const steps: TigerStep[] = [{ index: 0, kind: 'spin', board: [...board], lockedIndices: orderedLocked(), addedIndices: orderedLocked(), ...first }];
  while (featureSymbol && locked.size < 9 && steps.length <= TIGER_MAX_RESPINS) {
    const before = new Set(locked);
    for (let index = 0; index < 9; index++) if (!locked.has(index)) board[index] = pick(random);
    board.forEach((symbol, index) => {
      if (symbol === featureSymbol || symbol === 'tiger') locked.add(index);
    });
    const evaluation = evaluateTigerBoard(board, input.bet);
    evaluation.winningIndices.forEach(index => locked.add(index));
    const addedIndices = orderedLocked().filter(index => !before.has(index));
    steps.push({ index: steps.length, kind: 'respin', board: [...board], lockedIndices: orderedLocked(), addedIndices, ...evaluation });
    if (addedIndices.length === 0) break;
  }
  const final = steps[steps.length - 1];
  const multiplier = final.fullBoard ? 10 : 1;
  return {
    mathVersion: TIGER_MATH_VERSION, bet: input.bet, initialBoard, steps, endBoard: [...board],
    baseWin: final.baseWin, totalWin: final.baseWin * multiplier,
    fullBoard: final.fullBoard, multiplier, respinCount: steps.length - 1, featureSymbol,
  };
}

/** Reproducible simulation/test RNG only; the server uses node:crypto randomInt. */
export function createTigerSeededRandom(seed: number): TigerRandom {
  let state = seed >>> 0;
  return max => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return Math.floor(((value ^ value >>> 14) >>> 0) / 4294967296 * max);
  };
}

export const TIGER_CONFIG = {
  mathVersion: TIGER_MATH_VERSION, columns: 3, rows: 3, paylines: TIGER_PAYLINES,
  symbols: TIGER_SYMBOLS, unitsPerCoin: TIGER_UNITS_PER_COIN, targetRtp: 0.99,
  maxRespins: TIGER_MAX_RESPINS, fullBoardMultiplier: 10, maxWinMultiple: 455,
  note: 'Independent original demo mathematics. Target RTP is a long-run expectation, not a promise for a session or a reproduction of PG mathematics.',
};
