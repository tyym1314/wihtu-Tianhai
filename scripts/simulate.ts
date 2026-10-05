import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSeededRandom, generateRound, MATH_VERSION, PAYTABLE_SCALE, GAME_CONFIG } from '../src/game/engine';

const paidRounds = Number(process.argv[2] ?? 1000000);
const seed = Number(process.argv[3] ?? 19092026);
const bet = Number(process.argv[4] ?? 10000);
const reportPath = process.argv[5];
if (!Number.isSafeInteger(paidRounds) || paidRounds < 1) throw new RangeError('Pass a positive number of paid rounds');
const rng = createSeededRandom(seed);
const started = performance.now();
let totalBaseReturn = 0;
let totalBonusReturn = 0;
let sumCycleReturnsSquared = 0;
let freeRounds = 0;
let bonusEntries = 0;
let bonusRetriggers = 0;
let baseHits = 0;
let baseProfits = 0;
let cycleProfits = 0;
let cascades = 0;
let cascadeLimits = 0;
let winCaps = 0;
let maxCycleReturn = 0;
let maxBonusLength = 0;
let maxSpinReturn = 0;
for (let index = 0; index < paidRounds; index++) {
  const base = generateRound({ bet, freeSpins: 0, freeMultiplier: 0 }, rng);
  let cycleReturn = base.totalWin / bet;
  totalBaseReturn += cycleReturn;
  if (base.totalWin > 0) baseHits++;
  if (base.totalWin > bet) baseProfits++;
  if (base.freeSpinsAwarded > 0) bonusEntries++;
  let remaining = base.freeSpinsAwarded;
  let multiplier = 0;
  let bonusLength = 0;
  cascades += base.steps.length;
  cascadeLimits += Number(base.cascadeLimitReached);
  winCaps += Number(base.winCapReached);
  maxSpinReturn = Math.max(maxSpinReturn, base.totalWin / bet);
  while (remaining > 0) {
    const free = generateRound({ bet, freeSpins: remaining, freeMultiplier: multiplier }, rng);
    remaining = remaining - 1 + free.freeSpinsAwarded;
    multiplier = free.nextFreeMultiplier;
    const win = free.totalWin / bet;
    cycleReturn += win;
    totalBonusReturn += win;
    freeRounds++;
    bonusLength++;
    if (free.freeSpinsAwarded > 0) bonusRetriggers++;
    cascades += free.steps.length;
    cascadeLimits += Number(free.cascadeLimitReached);
    winCaps += Number(free.winCapReached);
    maxSpinReturn = Math.max(maxSpinReturn, win);
    // Diagnostic only: fail the report rather than silently truncating a bonus.
    if (bonusLength > 100000) throw new Error('Unexpected bonus length; simulation not truncated');
  }
  if (cycleReturn > 1) cycleProfits++;
  sumCycleReturnsSquared += cycleReturn * cycleReturn;
  maxCycleReturn = Math.max(maxCycleReturn, cycleReturn);
  maxBonusLength = Math.max(maxBonusLength, bonusLength);
  if ((index + 1) % 500000 === 0) process.stderr.write(`Simulated ${index + 1} paid cycles\n`);
}
const observedRtp = (totalBaseReturn + totalBonusReturn) / paidRounds;
const variance = paidRounds > 1 ? Math.max(0, (sumCycleReturnsSquared - paidRounds * observedRtp ** 2) / (paidRounds - 1)) : 0;
const standardError = Math.sqrt(variance / paidRounds);
const report = {
  mathVersion: MATH_VERSION,
  engineSha256: createHash('sha256').update(readFileSync(resolve('src/game/engine.ts'))).digest('hex'),
  generatedAt: new Date().toISOString(),
  method: 'Independent paid cycles; every awarded/retriggered free round runs to completion. Same generateRound function as the server. Normal-approximation 95% interval for the cycle mean, not a certification.',
  rng: 'Seeded Mulberry32 with rejection sampling; production uses crypto.randomInt instead.',
  paidRounds, freeRounds, seed, betMinorUnits: bet, paytableScale: PAYTABLE_SCALE,
  observedRtp, standardError, confidence95: [observedRtp - 1.96 * standardError, observedRtp + 1.96 * standardError],
  baseRtp: totalBaseReturn / paidRounds, bonusRtp: totalBonusReturn / paidRounds,
  bonusEntries, bonusEntryRate: bonusEntries / paidRounds, averagePaidRoundsPerBonus: paidRounds / bonusEntries,
  bonusRetriggers, averageFreeRoundsPerBonus: freeRounds / bonusEntries,
  paidRoundReturnFrequency: baseHits / paidRounds, paidRoundNetProfitFrequency: baseProfits / paidRounds,
  fullCycleNetProfitFrequency: cycleProfits / paidRounds,
  meanCascadesPerRound: cascades / (paidRounds + freeRounds),
  maxObservedSingleRoundReturnMultiple: maxSpinReturn, maxObservedPaidCycleReturnMultiple: maxCycleReturn,
  maxObservedBonusLength: maxBonusLength, cascadeLimitEvents: cascadeLimits, winCapEvents: winCaps,
  durationSeconds: (performance.now() - started) / 1000,
  rules: GAME_CONFIG,
};
const serialized = JSON.stringify(report, null, 2) + '\n';
if (reportPath) { mkdirSync(resolve(reportPath, '..'), { recursive: true }); writeFileSync(reportPath, serialized); }
process.stdout.write(serialized);
