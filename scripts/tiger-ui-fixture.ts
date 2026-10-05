/** QA ONLY. Isolated wallet and deterministic REAL engine seeds; never imported by production. */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTigerHandler } from '../server/tiger.js';
import { createTigerSeededRandom, generateTigerRound } from '../src/tiger/math.js';
import type { TigerRoundResult } from '../src/tiger/types.js';

const port = 8789;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-tiger');
const directory = await mkdtemp(join(tmpdir(), 'tiger-ui-qa-'));
function findSeed(predicate: (round: TigerRoundResult) => boolean) {
  for (let seed = 1; seed <= 100000; seed++) if (predicate(generateTigerRound({ bet: 10000 }, createTigerSeededRandom(seed)))) return seed;
  throw new Error('Unable to find a deterministic QA seed.');
}
const seeds = {
  loss: findSeed(round => round.totalWin === 0),
  respin: findSeed(round => round.respinCount >= 2 && !round.fullBoard),
  fullBoard: findSeed(round => round.fullBoard && round.respinCount >= 2),
  big: findSeed(round => round.totalWin / round.bet >= 50 && round.fullBoard),
};
const sequence = process.env.TIGER_QA_SEEDS
  ? process.env.TIGER_QA_SEEDS.split(',').map(Number)
  : [seeds.respin, seeds.fullBoard, seeds.big, seeds.loss];
if (sequence.some(seed => !Number.isSafeInteger(seed))) throw new Error('TIGER_QA_SEEDS must be comma-separated integers.');
let index = 0;
const handler = await createTigerHandler({
  storePath: join(directory, 'sessions.json'),
  roundGenerator: (input) => {
    const seed = sequence[index++] ?? 20000 + index;
    const round = generateTigerRound(input, createTigerSeededRandom(seed));
    console.log(`[Tiger QA] round=${index} seed=${seed} respins=${round.respinCount} fullBoard=${round.fullBoard} winMinor=${round.totalWin}`);
    return round;
  },
});
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  void (async () => {
    if (await handler(req, res)) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    const file = resolve(root, `.${pathname === '/' || pathname === '/tiger' ? '/tiger.html' : pathname}`);
    if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  })().catch(() => { if (!res.headersSent) { res.writeHead(404); res.end('Not found. Build the Tiger frontend first.'); } });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[QA FIXTURE ONLY] http://127.0.0.1:${port}/tiger.html`);
  console.log(JSON.stringify({ seeds, sequence, temporaryStore: directory, normalWalletUntouched: true }));
});
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  server.closeAllConnections();
  server.close(() => { void rm(directory, { recursive: true, force: true }).then(() => process.exit(0)); });
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
