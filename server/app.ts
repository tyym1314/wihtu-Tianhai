import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { generateRound, GAME_CONFIG } from '../src/game/engine.js';
import { JsonStore } from './store.js';

const UNITS_PER_COIN = 100;
const INITIAL_BALANCE = 12_000 * UNITS_PER_COIN;
const BET_CHOICES = [10, 50, 100, 200, 500];
const COOKIE_NAME = 'thunder_demo_sid';
const BODY_LIMIT = 8192;

type EngineRound = ReturnType<typeof generateRound>;
type RoundGenerator = typeof generateRound;

export interface DemoRound {
  id: string;
  requestId: string;
  epoch: number;
  bet: number;
  isFreeSpin: boolean;
  win: number;
  balanceBefore: number;
  balanceAfter: number;
  freeSpinsBefore: number;
  freeSpinsAfter: number;
  createdAt: string;
  engine: EngineRound;
}

interface StoredSession {
  id: string;
  epoch: number;
  /** Advances when wallet/bonus state changes; acknowledging animation does not advance it. */
  stateVersion: number;
  balanceUnits: number;
  freeSpins: number;
  freeMultiplier: number;
  lockedBetUnits: number | null;
  pendingRequestId: string | null;
  rounds: Record<string, DemoRound>;
  history: string[];
  resetRequests: string[];
}

interface StoredData {
  version: 1;
  sessions: Record<string, StoredSession>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function freshSession(): StoredSession {
  return {
    id: randomUUID(), epoch: 0, stateVersion: 0, balanceUnits: INITIAL_BALANCE, freeSpins: 0,
    freeMultiplier: 0, lockedBetUnits: null, pendingRequestId: null,
    rounds: {}, history: [], resetRequests: [],
  };
}

function publicSession(session: StoredSession) {
  return {
    mode: 'demo' as const,
    sessionId: session.id,
    epoch: session.epoch,
    stateVersion: session.stateVersion,
    mathVersion: GAME_CONFIG.mathVersion,
    balance: session.balanceUnits / UNITS_PER_COIN,
    betChoices: BET_CHOICES,
    freeSpins: session.freeSpins,
    freeMultiplier: session.freeMultiplier,
    lockedBet: session.lockedBetUnits === null ? null : session.lockedBetUnits / UNITS_PER_COIN,
    pendingRound: session.pendingRequestId ? session.rounds[session.pendingRequestId] : null,
  };
}

function cookieSession(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`));
  const value = cookie?.slice(COOKIE_NAME.length + 1);
  return value && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
}

function validateId(value: unknown, label = 'requestId'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new HttpError(400, 'INVALID_REQUEST_ID', `${label} must contain 8–128 letters, numbers, underscores or hyphens.`);
  }
  return value;
}

function validateBet(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !BET_CHOICES.includes(value)) {
    throw new HttpError(400, 'INVALID_BET', 'Choose a supported whole-coin bet.');
  }
  return value;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Send application/json.');
  }
  if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 8 KB.');
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 8 KB.'));
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.once('end', () => {
      if (tooLarge) return;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
        resolveBody(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Send a valid JSON object.'));
      }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new HttpError(400, 'REQUEST_ABORTED', 'Request was interrupted.')));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, directory: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This resource accepts GET requests.');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new HttpError(400, 'INVALID_PATH', 'Invalid URL.'); }
  const root = resolve(directory);
  let file = resolve(root, `.${decoded}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
  } catch {
    if (extname(file)) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
    file = resolve(root, 'index.html');
  }
  let content: Buffer;
  try { content = await readFile(file); }
  catch { throw new HttpError(404, 'NOT_FOUND', 'Build the frontend first, or open the Vite development URL.'); }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'content-length': content.length,
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

export interface DemoServerOptions {
  storePath: string;
  staticDirectory?: string;
  roundGenerator?: RoundGenerator;
}

export async function createDemoServer(options: DemoServerOptions) {
  const store = await JsonStore.open<StoredData>(options.storePath, { version: 1, sessions: {} });
  await store.transact(state => {
    if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
      throw new Error('Unsupported or invalid demo data file. Preserve it for inspection before resetting the demo.');
    }
    let changed = false;
    // Preserve demo sessions created before optimistic concurrency was added.
    for (const session of Object.values(state.sessions)) {
      if (session.stateVersion === undefined) { session.stateVersion = 0; changed = true; }
    }
    return { value: undefined, changed };
  });
  const play = options.roundGenerator ?? generateRound;

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/api/')) {
        if (options.staticDirectory) return serveStatic(req, res, pathname, options.staticDirectory);
        throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
      }
      const method = req.method || 'GET';
      const routes = new Set(['GET /api/session', 'GET /api/config', 'GET /api/history', 'POST /api/spin', 'POST /api/round/ack', 'POST /api/reset']);
      if (!routes.has(`${method} ${pathname}`)) throw new HttpError(404, 'NOT_FOUND', 'API route not found.');
      const body = method === 'POST' ? await readJson(req) : {};
      const sid = cookieSession(req);
      const result = await store.transact(state => {
        let session = sid ? state.sessions[sid] : undefined;
        const isNew = !session;
        if (!session) {
          session = freshSession();
          state.sessions[session.id] = session;
        }
        const current = session;
        let changed = isNew;
        let payload: unknown;
        if (pathname === '/api/session') payload = publicSession(current);
        else if (pathname === '/api/config') payload = {
          ...GAME_CONFIG,
          demoOnly: true, unitsPerCoin: UNITS_PER_COIN, initialBalance: INITIAL_BALANCE / UNITS_PER_COIN,
          betChoices: BET_CHOICES,
          note: 'Local demonstration with isolated virtual credits; not connected to an App wallet.',
        };
        else if (pathname === '/api/history') payload = { rounds: current.history.slice(-20).reverse().map(id => current.rounds[id]) };
        else if (pathname === '/api/spin') {
          const requestId = validateId(body.requestId);
          const bet = validateBet(body.bet);
          const previous = current.rounds[requestId];
          if (previous) {
            if (previous.bet !== bet) throw new HttpError(409, 'REQUEST_CONFLICT', 'This requestId was already used with another bet.');
            payload = { session: publicSession(current), round: previous };
          } else {
            if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
              throw new HttpError(400, 'INVALID_VERSION', 'Send the stateVersion shown in your current demo session.');
            }
            if (body.expectedVersion !== current.stateVersion) {
              throw new HttpError(409, 'STATE_CHANGED', 'The wallet or free spins changed in another tab. Reload the session before starting a new round.');
            }
            if (current.pendingRequestId) throw new HttpError(409, 'ROUND_PENDING', 'Finish or restore the pending round before starting another.');
            const isFreeSpin = current.freeSpins > 0;
            const betUnits = bet * UNITS_PER_COIN;
            if (isFreeSpin && current.lockedBetUnits !== betUnits) throw new HttpError(409, 'BET_LOCKED', 'Free spins retain their triggering bet.');
            if (!isFreeSpin && current.balanceUnits < betUnits) throw new HttpError(409, 'INSUFFICIENT_BALANCE', 'Not enough demo credits for this bet.');
            const engine = play({ bet: betUnits, freeSpins: current.freeSpins, freeMultiplier: current.freeMultiplier }, randomInt);
            if (!Number.isSafeInteger(engine.totalWin) || engine.totalWin < 0 ||
              !Number.isSafeInteger(engine.freeSpinsAwarded) || engine.freeSpinsAwarded < 0 ||
              !Number.isSafeInteger(engine.nextFreeMultiplier) || engine.nextFreeMultiplier < 0) {
              throw new Error('Engine returned invalid settlement values.');
            }
            const balanceBefore = current.balanceUnits;
            const freeSpinsBefore = current.freeSpins;
            const balanceAfter = balanceBefore - (isFreeSpin ? 0 : betUnits) + engine.totalWin;
            const freeSpinsAfter = freeSpinsBefore - (isFreeSpin ? 1 : 0) + engine.freeSpinsAwarded;
            if (!Number.isSafeInteger(balanceAfter) || !Number.isSafeInteger(freeSpinsAfter)) throw new Error('Settlement exceeds safe integer bounds.');
            const round: DemoRound = {
              id: randomUUID(), requestId, epoch: current.epoch, bet, isFreeSpin,
              win: engine.totalWin / UNITS_PER_COIN,
              balanceBefore: balanceBefore / UNITS_PER_COIN, balanceAfter: balanceAfter / UNITS_PER_COIN,
              freeSpinsBefore, freeSpinsAfter, createdAt: new Date().toISOString(), engine,
            };
            current.balanceUnits = balanceAfter;
            current.stateVersion += 1;
            current.freeSpins = freeSpinsAfter;
            current.freeMultiplier = freeSpinsAfter > 0 ? engine.nextFreeMultiplier : 0;
            current.lockedBetUnits = freeSpinsAfter > 0 ? (current.lockedBetUnits ?? betUnits) : null;
            current.pendingRequestId = requestId;
            current.rounds[requestId] = round;
            current.history.push(requestId);
            changed = true;
            payload = { session: publicSession(current), round };
          }
        } else if (pathname === '/api/round/ack') {
          const roundId = validateId(body.roundId, 'roundId');
          const pending = current.pendingRequestId ? current.rounds[current.pendingRequestId] : null;
          if (pending?.id === roundId) {
            current.pendingRequestId = null;
            changed = true;
          } else if (!Object.values(current.rounds).some(round => round.id === roundId)) {
            throw new HttpError(404, 'ROUND_NOT_FOUND', 'Round not found in this demo session.');
          }
          payload = { session: publicSession(current) };
        } else if (pathname === '/api/reset') {
          const requestId = validateId(body.requestId);
          if (!current.resetRequests.includes(requestId)) {
            current.epoch += 1;
            current.stateVersion += 1;
            current.balanceUnits = INITIAL_BALANCE;
            current.freeSpins = 0;
            current.freeMultiplier = 0;
            current.lockedBetUnits = null;
            current.pendingRequestId = null;
            current.history = [];
            // Retain request receipts so delayed network retries cannot settle twice.
            current.resetRequests.push(requestId);
            changed = true;
          }
          payload = { session: publicSession(current) };
        }
        return { value: { payload, sessionId: current.id, isNew }, changed };
      });
      if (result.isNew) res.setHeader('set-cookie', `${COOKIE_NAME}=${result.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      sendJson(res, 200, result.payload);
    })().catch(error => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      else {
        console.error('[demo-server] Request failed:', error instanceof Error ? error.message : 'Unknown error');
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'The demo could not save this operation. Reload to recover the last saved state.' } });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
