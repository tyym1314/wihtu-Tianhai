import test from 'node:test';
import assert from 'node:assert/strict';
import { createTigerSeededRandom, evaluateTigerBoard, generateTigerRound, TIGER_MAX_RESPINS, TIGER_SYMBOLS } from '../src/tiger/math.js';
import type { TigerSymbol } from '../src/tiger/types.js';

function draws(symbols: TigerSymbol[]) {
  const rolls = new Map<TigerSymbol, number>(); let sum = 0;
  TIGER_SYMBOLS.forEach(symbol => { rolls.set(symbol.id, sum); sum += symbol.weight; });
  let index = 0;
  return () => {
    assert.ok(index < symbols.length, 'Fixture must supply every RNG draw');
    return rolls.get(symbols[index++])!;
  };
}
const wager = 10000;
const noWin: TigerSymbol[] = ['ingot', 'coin', 'jade', 'envelope', 'firecracker', 'orange', 'coin', 'jade', 'ingot'];

test('Tiger pays exactly the five published lines, with wild substitution and no 2-symbol payouts', () => {
  const evaluated = evaluateTigerBoard(['coin', 'tiger', 'coin', 'jade', 'envelope', 'orange', 'orange', 'ingot', 'jade'], wager);
  assert.equal(evaluated.lineWins.length, 1);
  assert.equal(evaluated.lineWins[0].symbol, 'coin');
  assert.deepEqual(evaluated.lineWins[0].indices, [0, 1, 2]);
  assert.equal(evaluated.baseWin, TIGER_SYMBOLS.find(s => s.id === 'coin')!.payoutBps);
  assert.equal(evaluateTigerBoard(noWin, wager).baseWin, 0);
  const allWild = evaluateTigerBoard(Array(9).fill('tiger'), wager);
  assert.equal(allWild.lineWins.length, 5);
  assert.equal(allWild.baseWin, TIGER_SYMBOLS[0].payoutBps * 5);
  assert.equal(allWild.fullBoard, true);
});

test('Tiger initial loss uses only nine random draws and has no respin', () => {
  const round = generateTigerRound({ bet: wager }, draws(noWin));
  assert.equal(round.totalWin, 0);
  assert.equal(round.respinCount, 0);
  assert.equal(round.featureSymbol, null);
  assert.deepEqual(round.initialBoard, round.endBoard);
});

test('Tiger respins retain all winning cells and end when no new cells are held', () => {
  const initial: TigerSymbol[] = ['coin', 'coin', 'coin', 'jade', 'envelope', 'orange', 'orange', 'ingot', 'jade'];
  const round = generateTigerRound({ bet: wager }, draws([...initial, 'jade', 'envelope', 'orange', 'orange', 'ingot', 'jade']));
  assert.equal(round.respinCount, 1);
  assert.equal(round.featureSymbol, 'coin');
  assert.deepEqual(round.steps[0].lockedIndices, [0, 1, 2]);
  assert.deepEqual(round.steps[1].addedIndices, []);
  assert.deepEqual(round.steps[1].board.slice(0, 3), initial.slice(0, 3));
  assert.equal(round.totalWin, round.steps[1].baseWin);
  assert.notEqual(round.totalWin, round.steps.reduce((sum, step) => sum + step.baseWin, 0));
});

test('Tiger holds wilds and grows to a full board, applying x10 once to the final total', () => {
  const initial: TigerSymbol[] = ['coin', 'coin', 'coin', 'jade', 'envelope', 'orange', 'orange', 'ingot', 'jade'];
  const round = generateTigerRound({ bet: wager }, draws([...initial, 'coin', 'tiger', 'coin', 'coin', 'coin', 'coin']));
  assert.equal(round.respinCount, 1);
  assert.equal(round.fullBoard, true);
  assert.equal(round.multiplier, 10);
  assert.deepEqual(round.steps[1].addedIndices, [3, 4, 5, 6, 7, 8]);
  assert.equal(round.totalWin, round.baseWin * 10);
  assert.equal(round.baseWin, TIGER_SYMBOLS.find(s => s.id === 'coin')!.payoutBps * 5);
});

test('Tiger full-board bonus means every position participates, not necessarily one identical symbol', () => {
  const initial: TigerSymbol[] = ['coin', 'coin', 'coin', 'jade', 'jade', 'jade', 'orange', 'orange', 'orange'];
  const round = generateTigerRound({ bet: wager }, draws(initial));
  assert.equal(round.fullBoard, true);
  assert.equal(round.respinCount, 0);
  assert.equal(round.steps[0].lineWins.length, 3);
  assert.equal(round.totalWin, round.baseWin * 10);
});

test('Tiger seeded complete rounds are reproducible, bounded, integer and preserve locks', () => {
  const random = createTigerSeededRandom(998877);
  const replay = createTigerSeededRandom(998877);
  for (let index = 0; index < 2000; index++) {
    const round = generateTigerRound({ bet: 1000 }, random);
    assert.deepEqual(round, generateTigerRound({ bet: 1000 }, replay));
    assert.ok(Number.isSafeInteger(round.totalWin));
    assert.ok(round.respinCount <= TIGER_MAX_RESPINS);
    assert.equal(round.steps.length, round.respinCount + 1);
    for (let step = 1; step < round.steps.length; step++) {
      const previous = round.steps[step - 1], current = round.steps[step];
      previous.lockedIndices.forEach(position => assert.equal(current.board[position], previous.board[position]));
      assert.ok(current.baseWin >= previous.baseWin, 'Held wins never disappear');
    }
  }
});

test('Tiger rejects malformed boards, stakes and RNG outputs', () => {
  assert.throws(() => evaluateTigerBoard([], wager));
  for (const bet of [-1, 0, .5, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => generateTigerRound({ bet }, createTigerSeededRandom(1)));
  for (const value of [-1, .5, 100, NaN]) assert.throws(() => generateTigerRound({ bet: wager }, () => value));
});

test('Tiger simulation RNG wraps at 32 bits for long runs instead of losing Number precision', () => {
  const count = 5_000_000;
  const seed = 914321;
  const longRun = createTigerSeededRandom(seed);
  for (let index = 0; index < count; index++) longRun(100);
  const checkpoint = createTigerSeededRandom((seed + Math.imul(count, 0x6D2B79F5)) >>> 0);
  for (let index = 0; index < 100; index++) assert.equal(longRun(100), checkpoint(100));
});
