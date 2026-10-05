/**
 * QA FIXTURE ONLY — deterministic bonus coverage for browser acceptance.
 * Never used by npm start or the normal demo server. Outcomes remain generated
 * by the real engine; only the random seed selection is controlled here.
 * One browser session should exercise this process at a time.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from '../server/app.js';
import { createSeededRandom, generateRound, type RoundInput, type RoundResult } from '../src/game/engine.js';

const PORT = 8788;
const HOST = '127.0.0.1';
const SEARCH_LIMIT = 5000;
const fixtureBet = 10000;

function findSeed(input: RoundInput, accepts: (round: RoundResult) => boolean): number {
  for (let seed = 1; seed <= SEARCH_LIMIT; seed++) {
    if (accepts(generateRound(input, createSeededRandom(seed)))) return seed;
  }
  throw new Error(`QA fixture could not find a matching seed within ${SEARCH_LIMIT} attempts.`);
}

const triggerSeed = findSeed(
  { bet: fixtureBet, freeSpins: 0, freeMultiplier: 0 },
  round => round.freeSpinsAwarded === 15,
);
const winningFreeSeed = findSeed(
  { bet: fixtureBet, freeSpins: 15, freeMultiplier: 0 },
  round => round.totalWin > 0 && round.collectedMultiplier > 0 && round.freeSpinsAwarded === 0,
);

let hasTriggered = false;
let hasPlayedWinningFree = false;
let nextSeed = 20000;
const fixtureEngine: typeof generateRound = input => {
  let seed: number;
  if (input.freeSpins === 0 && !hasTriggered) {
    hasTriggered = true;
    seed = triggerSeed;
  } else if (input.freeSpins > 0 && !hasPlayedWinningFree) {
    hasPlayedWinningFree = true;
    seed = winningFreeSeed;
  } else seed = nextSeed++;
  const round = generateRound(input, createSeededRandom(seed));
  console.log(`[QA fixture] seed=${seed} mode=${round.isFreeSpin ? 'free' : 'paid'} scatters=${round.scatters} awarded=${round.freeSpinsAwarded} multiplier=${round.multiplier} winMinorUnits=${round.totalWin}`);
  return round;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'thunder-ui-qa-'));
const server = await createDemoServer({
  storePath: join(temporaryDirectory, 'qa-sessions.json'),
  staticDirectory: join(projectRoot, 'dist'),
  roundGenerator: fixtureEngine,
});

try {
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.off('error', reject);
      resolveListening();
    });
  });
} catch (error) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}

console.log(`[QA FIXTURE ONLY] http://${HOST}:${PORT}`);
console.log(`[QA fixture] triggerSeed=${triggerSeed}; winningFreeSeed=${winningFreeSeed}; subsequentSeeds=20000,20001,…`);
console.log(`[QA fixture] temporaryStore=${temporaryDirectory}; normal demo data is untouched.`);
console.log('[QA fixture] Use one browser session. Restart this process to replay the same seed sequence.');

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void rm(temporaryDirectory, { recursive: true, force: true })
      .then(() => process.exit(0))
      .catch(error => { console.error('[QA fixture] Temporary cleanup failed:', error); process.exit(1); });
  });
  server.closeIdleConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
