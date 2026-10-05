import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { JsonStore } from './store.js';
import { generateTigerRound, TIGER_BET_CHOICES, TIGER_CONFIG, TIGER_MATH_VERSION, TIGER_UNITS_PER_COIN } from '../src/tiger/math.js';
import type { TigerDemoRound, TigerSession } from '../src/tiger/types.js';

const INITIAL_BALANCE = 12_000 * TIGER_UNITS_PER_COIN;
const COOKIE_NAME = 'tiger_demo_sid';
const BODY_LIMIT = 8192;
interface StoredSession {
  id: string; epoch: number; stateVersion: number; balanceUnits: number;
  pendingRequestId: string | null;
  rounds: Record<string, TigerDemoRound>; history: string[]; resetRequests: string[];
}
interface StoredData { version: 1; sessions: Record<string, StoredSession> }
class TigerHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface TigerHandlerOptions {
  storePath: string;
  /** Dependency injection for deterministic tests only. Production defaults to crypto.randomInt. */
  roundGenerator?: typeof generateTigerRound;
}
function freshSession(): StoredSession {
  return { id: randomUUID(), epoch: 0, stateVersion: 0, balanceUnits: INITIAL_BALANCE, pendingRequestId: null, rounds: {}, history: [], resetRequests: [] };
}
function publicSession(session: StoredSession): TigerSession {
  return {
    mode: 'demo', sessionId: session.id, epoch: session.epoch, stateVersion: session.stateVersion,
    mathVersion: TIGER_MATH_VERSION, balance: session.balanceUnits / TIGER_UNITS_PER_COIN,
    betChoices: [...TIGER_BET_CHOICES], pendingRound: session.pendingRequestId ? session.rounds[session.pendingRequestId] : null,
  };
}
function cookieSession(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  const value = cookie?.slice(COOKIE_NAME.length + 1);
  return value && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
}
function validateId(value: unknown, label = 'requestId'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new TigerHttpError(400, 'INVALID_REQUEST_ID', `${label} must contain 8–128 letters, numbers, underscores or hyphens.`);
  return value;
}
function validateBet(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !TIGER_BET_CHOICES.includes(value)) throw new TigerHttpError(400, 'INVALID_BET', 'Choose a supported whole-coin stake.');
  return value;
}
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { req.resume(); throw new TigerHttpError(415, 'JSON_REQUIRED', 'Send application/json.'); }
  if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) { req.resume(); throw new TigerHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 8 KB.'); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { tooLarge = true; chunks.length = 0; reject(new TigerHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 8 KB.')); }
      else if (!tooLarge) chunks.push(chunk);
    });
    req.once('end', () => {
      if (tooLarge) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
        resolve(value as Record<string, unknown>);
      } catch { reject(new TigerHttpError(400, 'INVALID_JSON', 'Send a valid JSON object.')); }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new TigerHttpError(400, 'REQUEST_ABORTED', 'Request was interrupted.')));
  });
}
function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

/** One server process must own this store file. Returns false for non-Tiger URLs. */
export async function createTigerHandler(options: TigerHandlerOptions): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>> {
  const store = await JsonStore.open<StoredData>(options.storePath, { version: 1, sessions: {} });
  await store.transact(state => {
    if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) throw new Error('Unsupported Tiger demo data. Preserve the file before resetting.');
    return { value: undefined, changed: false };
  });
  const play = options.roundGenerator ?? generateTigerRound;
  return async function handleTigerRequest(req, res) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/api/tiger/')) return false;
    try {
      const method = req.method || 'GET';
      const routes = new Set(['GET /api/tiger/session', 'GET /api/tiger/config', 'GET /api/tiger/history', 'POST /api/tiger/spin', 'POST /api/tiger/ack', 'POST /api/tiger/reset']);
      if (!routes.has(`${method} ${pathname}`)) throw new TigerHttpError(404, 'NOT_FOUND', 'Tiger API route not found.');
      const body = method === 'POST' ? await readJson(req) : {};
      const sid = cookieSession(req);
      const result = await store.transact(state => {
        let session = sid ? state.sessions[sid] : undefined;
        const isNew = !session;
        if (!session) { session = freshSession(); state.sessions[session.id] = session; }
        const current = session;
        let changed = isNew;
        let payload: unknown;
        if (pathname === '/api/tiger/session') payload = publicSession(current);
        else if (pathname === '/api/tiger/config') payload = { ...TIGER_CONFIG, demoOnly: true, initialBalance: INITIAL_BALANCE / TIGER_UNITS_PER_COIN, betChoices: TIGER_BET_CHOICES };
        else if (pathname === '/api/tiger/history') payload = { rounds: current.history.slice(-20).reverse().map(id => current.rounds[id]) };
        else if (pathname === '/api/tiger/spin') {
          const requestId = validateId(body.requestId);
          const bet = validateBet(body.bet);
          const previous = current.rounds[requestId];
          if (previous) {
            if (previous.bet !== bet) throw new TigerHttpError(409, 'REQUEST_CONFLICT', 'This requestId was already used with another stake.');
            payload = { session: publicSession(current), round: previous };
          } else {
            if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) throw new TigerHttpError(400, 'INVALID_VERSION', 'Send the current session stateVersion.');
            if (body.expectedVersion !== current.stateVersion) throw new TigerHttpError(409, 'STATE_CHANGED', 'The wallet changed in another tab. Reload the session before starting a new round.');
            if (current.pendingRequestId) throw new TigerHttpError(409, 'ROUND_PENDING', 'Finish or restore the pending round first.');
            const betUnits = bet * TIGER_UNITS_PER_COIN;
            if (current.balanceUnits < betUnits) throw new TigerHttpError(409, 'INSUFFICIENT_BALANCE', 'Not enough demo credits for this stake.');
            const engine = play({ bet: betUnits }, randomInt);
            if (!Number.isSafeInteger(engine.totalWin) || engine.totalWin < 0 || engine.bet !== betUnits || !engine.steps.length) throw new Error('Engine returned invalid settlement values.');
            const balanceBefore = current.balanceUnits;
            const balanceAfter = balanceBefore - betUnits + engine.totalWin;
            if (!Number.isSafeInteger(balanceAfter)) throw new Error('Settlement exceeds safe integer bounds.');
            const round: TigerDemoRound = {
              id: randomUUID(), requestId, epoch: current.epoch, bet, win: engine.totalWin / TIGER_UNITS_PER_COIN,
              balanceBefore: balanceBefore / TIGER_UNITS_PER_COIN, balanceAfter: balanceAfter / TIGER_UNITS_PER_COIN,
              createdAt: new Date().toISOString(), engine,
            };
            current.balanceUnits = balanceAfter; current.stateVersion++; current.pendingRequestId = requestId;
            current.rounds[requestId] = round; current.history.push(requestId); changed = true;
            payload = { session: publicSession(current), round };
          }
        } else if (pathname === '/api/tiger/ack') {
          const roundId = validateId(body.roundId, 'roundId');
          const pending = current.pendingRequestId ? current.rounds[current.pendingRequestId] : null;
          if (pending?.id === roundId) { current.pendingRequestId = null; changed = true; }
          else if (!Object.values(current.rounds).some(round => round.id === roundId)) throw new TigerHttpError(404, 'ROUND_NOT_FOUND', 'Round not found in this session.');
          payload = { session: publicSession(current) };
        } else if (pathname === '/api/tiger/reset') {
          const requestId = validateId(body.requestId);
          if (!current.resetRequests.includes(requestId)) {
            current.epoch++; current.stateVersion++; current.balanceUnits = INITIAL_BALANCE;
            current.pendingRequestId = null; current.history = []; current.resetRequests.push(requestId); changed = true;
          }
          payload = { session: publicSession(current) };
        }
        return { value: { payload, sessionId: current.id, isNew }, changed };
      });
      if (result.isNew) res.setHeader('set-cookie', `${COOKIE_NAME}=${result.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      sendJson(res, 200, result.payload);
    } catch (error) {
      if (res.headersSent || res.destroyed) return true;
      if (error instanceof TigerHttpError) sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      else {
        console.error('[tiger-server] Request failed:', error instanceof Error ? error.message : 'Unknown error');
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'The demo could not save this operation. Reload to recover the last saved state.' } });
      }
    }
    return true;
  };
}
