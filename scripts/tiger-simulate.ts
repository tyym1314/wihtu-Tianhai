import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTigerSeededRandom, generateTigerRound, TIGER_CONFIG } from '../src/tiger/math.js';

const count = Number(process.argv[2] || 1_000_000);
const seed = Number(process.argv[3] || 9182026);
const label = process.argv[4] || 'validation';
if (!Number.isSafeInteger(count) || count < 1000 || count > 100_000_000) throw new Error('Choose 1,000–100,000,000 paid rounds.');
if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error('Invalid output label.');
const random = createTigerSeededRandom(seed);
const bet = 10_000;
let sum = 0, sumSquares = 0, hits = 0, profitHits = 0, features = 0, fullBoards = 0, maxWin = 0, respins = 0;
const start = performance.now();
const buckets = { loss: 0, belowStake: 0, oneToFive: 0, fiveToTwenty: 0, twentyToHundred: 0, hundredPlus: 0 };
for (let index = 0; index < count; index++) {
  const round = generateTigerRound({ bet }, random);
  const multiple = round.totalWin / bet;
  sum += multiple; sumSquares += multiple * multiple;
  if (multiple > 0) hits++;
  if (multiple > 1) profitHits++;
  if (round.respinCount) features++;
  if (round.fullBoard) fullBoards++;
  maxWin = Math.max(maxWin, multiple);
  respins += round.respinCount;
  buckets[multiple === 0 ? 'loss' : multiple < 1 ? 'belowStake' : multiple < 5 ? 'oneToFive' : multiple < 20 ? 'fiveToTwenty' : multiple < 100 ? 'twentyToHundred' : 'hundredPlus']++;
}
const rtp = sum / count;
const standardError = Math.sqrt(Math.max(0, sumSquares / count - rtp * rtp) / count);
const report = {
  mathVersion: TIGER_CONFIG.mathVersion,
  mathSha256: createHash('sha256').update(await readFile(new URL('../src/tiger/math.ts', import.meta.url))).digest('hex'),
  generatedAt: new Date().toISOString(), count, seed, stakeMinorUnits: bet,
  rtp, confidence95: [rtp - 1.96 * standardError, rtp + 1.96 * standardError],
  standardError, hitRate: hits / count, netProfitRate: profitHits / count,
  featureRate: features / count, fullBoardRate: fullBoards / count,
  meanRespinsPerPaidRound: respins / count, maxObservedWinMultiple: maxWin,
  buckets, elapsedSeconds: (performance.now() - start) / 1000,
  config: TIGER_CONFIG,
  scope: 'Seeded independent Monte Carlo of complete paid rounds, including every re-spin and final-board multiplier. Seeded RNG only for reproducibility; live API uses crypto.randomInt. This is not a certified theoretical RTP or PG mathematics.',
};
await mkdir('output/math', { recursive: true });
await writeFile(`output/math/tiger-${label}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
