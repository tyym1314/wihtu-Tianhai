import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRandom, evaluateBoard, generateRound, INITIAL_BOARD, MAX_CASCADES, MAX_MULTIPLIER, PAYTABLE_SCALE, settleMultiplier, SYMBOLS } from '../src/game/engine';
import type { Cell, RandomSource, SymbolId } from '../src/game/types';

const bet = 10000;
const boardWith = (counts: Partial<Record<SymbolId, number>>): Cell[] => {
  const cells: Cell[] = [];
  for (const [symbol, count] of Object.entries(counts)) for (let i = 0; i < count!; i++) cells.push({ id: `t${cells.length}`, symbol: symbol as SymbolId });
  while (cells.length < 30) cells.push({ id: `t${cells.length}`, symbol: 'scatter' });
  return cells;
};
const symbolRoll = (id: SymbolId) => SYMBOLS.slice(0, SYMBOLS.findIndex(s => s.id === id)).reduce((sum, s) => sum + s.weight, 0);
const scriptedBoard = (symbols: SymbolId[]): RandomSource => {
  let index = 0;
  return max => { assert.notEqual(max, 100, 'fixture must not contain multiplier'); return symbolRoll(symbols[index++ % symbols.length]); };
};

test('pay anywhere counts nonadjacent symbols, pays each symbol, and uses the right quantity band', () => {
  const board = boardWith({ ruby: 8, emerald: 10, sapphire: 12 });
  board.sort((a, b) => Number(a.id.slice(1)) % 7 - Number(b.id.slice(1)) % 7);
  const wins = evaluateBoard(board, bet);
  assert.equal(wins.length, 3);
  assert.deepEqual(wins.map(win => win.count), [8, 10, 12]);
  assert.deepEqual(wins.map(win => win.payout), [1200, 3500, 10000].map(p => Math.round(p * PAYTABLE_SCALE)));
  assert.equal(new Set(wins.flatMap(win => win.indices)).size, 30);
});

test('seven symbols do not pay; scatter is never a regular pay symbol', () => {
  assert.deepEqual(evaluateBoard(boardWith({ ruby: 7 }), bet), []);
  assert.throws(() => evaluateBoard(INITIAL_BOARD.slice(1), bet), /30 cells/);
});

test('base multiplier balls add instead of multiply', () => {
  assert.deepEqual(settleMultiplier(100, 2 + 5, false, 0), { multiplier: 7, nextFreeMultiplier: 0 });
  assert.deepEqual(settleMultiplier(100, 0, false, 0), { multiplier: 1, nextFreeMultiplier: 0 });
});

test('free multipliers are collected only on paying rounds, persist, and cap at 100', () => {
  assert.deepEqual(settleMultiplier(100, 5, true, 7), { multiplier: 12, nextFreeMultiplier: 12 });
  assert.deepEqual(settleMultiplier(0, 5, true, 7), { multiplier: 7, nextFreeMultiplier: 7 });
  assert.deepEqual(settleMultiplier(100, 0, true, 7), { multiplier: 7, nextFreeMultiplier: 7 });
  assert.deepEqual(settleMultiplier(100, 20, true, 99), { multiplier: MAX_MULTIPLIER, nextFreeMultiplier: MAX_MULTIPLIER });
});

test('two cascades settle once with the final multiplier sum and final scatter count', () => {
  const drawSequence: Array<{ symbol: SymbolId; ballRoll?: number }> = [
    ...Array.from({ length: 8 }, () => ({ symbol: 'ruby' as const })),
    { symbol: 'multiplier', ballRoll: 0 }, // 2×
    { symbol: 'multiplier', ballRoll: 60 }, // 3×
    ...(['sapphire', 'amethyst', 'amber', 'crown', 'chalice'] as const).flatMap(symbol => Array.from({ length: 4 }, () => ({ symbol }))),
    ...Array.from({ length: 8 }, () => ({ symbol: 'emerald' as const })),
    ...Array.from({ length: 4 }, () => ({ symbol: 'pearl' as const })),
    ...Array.from({ length: 4 }, () => ({ symbol: 'scatter' as const })),
  ];
  const scripted = (): RandomSource => {
    const commands = drawSequence.flatMap(draw => [{ range: 1000, value: symbolRoll(draw.symbol) }, ...(draw.ballRoll !== undefined ? [{ range: 100, value: draw.ballRoll }] : [])]);
    return range => {
      const command = commands.shift();
      assert.ok(command, 'No extra draws after the final nonwinning board');
      assert.equal(range, command.range);
      return command.value;
    };
  };
  const round = generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, scripted());
  const rawPayout = Math.round(1200 * PAYTABLE_SCALE) + Math.round(1400 * PAYTABLE_SCALE);
  assert.equal(round.steps.length, 2);
  assert.equal(round.baseWin, rawPayout);
  assert.equal(round.collectedMultiplier, 5);
  assert.equal(round.multiplier, 5);
  assert.equal(round.totalWin, rawPayout * 5);
  assert.equal(round.scatters, 4);
  assert.equal(round.freeSpinsAwarded, 15);
  const free = generateRound({ bet, freeSpins: 5, freeMultiplier: 7 }, scripted());
  assert.equal(free.nextFreeMultiplier, 12);
  assert.equal(free.totalWin, rawPayout * 12);
  assert.equal(free.freeSpinsAwarded, 5);
});

test('four scatters award 15 free spins, while three retrigger five only in free mode', () => {
  const filler: SymbolId[] = ['ruby', 'emerald', 'sapphire', 'amethyst', 'amber', 'crown', 'chalice', 'pearl'];
  const fixture = (count: number) => Array.from({ length: 30 }, (_, index) => index < count ? 'scatter' as const : filler[index % filler.length]);
  const base = generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, scriptedBoard(fixture(4)));
  assert.equal(base.freeSpinsAwarded, 15);
  assert.equal(base.scatters, 4);
  assert.equal(base.steps.length, 0);
  assert.equal(generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, scriptedBoard(fixture(3))).freeSpinsAwarded, 0);
  const free = generateRound({ bet, freeSpins: 2, freeMultiplier: 7 }, scriptedBoard(fixture(3)));
  assert.equal(free.freeSpinsAwarded, 5);
  assert.equal(free.nextFreeMultiplier, 7);
  assert.equal(free.totalWin, 0);
});

test('cascade ceiling pays the last board and ends without an unpriced extra refill', () => {
  const round = generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, () => 0);
  assert.equal(round.steps.length, MAX_CASCADES);
  assert.equal(round.cascadeLimitReached, true);
  assert.equal(round.endBoard, round.steps.at(-1)!.board);
  assert.equal(round.baseWin, MAX_CASCADES * Math.round(7000 * PAYTABLE_SCALE));
});

test('the total round win cap is applied after bonus multipliers', () => {
  const round = generateRound({ bet, freeSpins: 1, freeMultiplier: 100 }, () => 0);
  assert.ok(round.baseWin * round.multiplier > 1000 * bet);
  assert.equal(round.totalWin, 1000 * bet);
  assert.equal(round.winCapReached, true);
});

test('identical seeds yield identical rounds and gravity retains surviving cell identities', () => {
  const a = createSeededRandom(42);
  const b = createSeededRandom(42);
  let checkedCascade = false;
  for (let index = 0; index < 100; index++) {
    const round = generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, a);
    assert.deepEqual(round, generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, b));
    assert.equal(round.totalWin, Math.min(1000 * bet, round.baseWin * round.multiplier));
    for (let s = 0; s < round.steps.length; s++) {
      const step = round.steps[s];
      const next = round.steps[s + 1]?.board ?? round.endBoard;
      if (next === step.board) continue;
      checkedCascade = true;
      const removed = new Set(step.winningIndices);
      for (let col = 0; col < 6; col++) {
        const survivingIds = Array.from({ length: 5 }, (_, row) => row * 6 + col).filter(i => !removed.has(i)).map(i => step.board[i].id);
        const nextIds = Array.from({ length: 5 }, (_, row) => next[row * 6 + col].id);
        assert.deepEqual(nextIds.slice(5 - survivingIds.length), survivingIds);
      }
    }
  }
  assert.equal(checkedCascade, true);
});

test('invalid money and free state are rejected', () => {
  for (const invalid of [0, -1, 999, 1001, 100001, NaN]) assert.throws(() => generateRound({ bet: invalid, freeSpins: 0, freeMultiplier: 0 }));
  assert.throws(() => generateRound({ bet, freeSpins: -1, freeMultiplier: 0 }));
  assert.throws(() => generateRound({ bet, freeSpins: 0, freeMultiplier: 101 }));
});
