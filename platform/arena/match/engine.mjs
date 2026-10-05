import * as legacy from './engine-v1.mjs';
import {MATCH_CONTENT_VERSION,selectMatchObjective,objectiveValue,objectiveWaveProgress} from './objectives.mjs';
import { createHmac } from 'node:crypto';

export const RULE_VERSION = 'pvp-match-v2.0.0';
export const supportsRuleVersion=version=>version===RULE_VERSION||version===legacy.RULE_VERSION;
export const RULES = Object.freeze({ size: 6, colors: 5, durationMs: 90000, swapMs: 150, clearMs: 250, fallMs: 200, shuffleMs: 300, maxWaves: 20, shuffleAttempts: 32, passiveRainbow: 'most-common-color-lowest-index-tie', fallback: 'five-color-latin-guaranteed-swap-v1' });
const N = 6, CELLS = 36;
const clone = value => JSON.parse(JSON.stringify(value));
const copyBoard = board => board.map(tile => tile && { ...tile });
function fail(code, message, status = 409) { const e = new Error(message); e.code = code; e.status = status; throw e; }
function validNow(now) { if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_TIME', 'A nonnegative server timestamp is required', 400); }
function randomInt(seed, domain, counter, limit) {
  let attempt = 0; const ceiling = Math.floor(0x100000000 / limit) * limit;
  for (;;) { const word = createHmac('sha256', Buffer.from(seed, 'hex')).update(`${RULE_VERSION}|${domain}|${counter}|${attempt++}`).digest().readUInt32BE(0); if (word < ceiling) return word % limit; }
}
const isSpecial = tile => Boolean(tile?.special);
const same = (a, b) => a && b && a.color !== null && a.color === b.color;
const adjacent = (a, b) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < CELLS && b < CELLS && ((Math.abs(a - b) === N) || (Math.floor(a / N) === Math.floor(b / N) && Math.abs(a - b) === 1));

export function matches(board) {
  const runs = [];
  for (const direction of ['row', 'column']) for (let outer = 0; outer < N; outer++) {
    let start = 0;
    while (start < N) {
      const at = i => direction === 'row' ? outer * N + i : i * N + outer;
      let end = start + 1;
      while (end < N && same(board[at(start)], board[at(end)])) end++;
      if (end - start >= 3 && board[at(start)]?.color !== null) runs.push({ direction, color: board[at(start)].color, cells: Array.from({ length: end - start }, (_, i) => at(start + i)) });
      start = end;
    }
  }
  const remaining = new Set(runs.flatMap(run => run.cells)); const clusters = [];
  while (remaining.size) {
    const first = Math.min(...remaining), cells = [], queue = [first], color = board[first].color;
    remaining.delete(first);
    for (let q = 0; q < queue.length; q++) {
      const index = queue[q]; cells.push(index);
      for (const next of [index - N, index + N, index - 1, index + 1]) if (adjacent(index, next) && remaining.has(next) && board[next].color === color) { remaining.delete(next); queue.push(next); }
    }
    cells.sort((a, b) => a - b); const member = new Set(cells);
    const ownRuns = runs.filter(run => run.cells.some(index => member.has(index)));
    const longest = Math.max(...ownRuns.map(run => run.cells.length));
    let special = null;
    if (longest >= 5) special = 'rainbow';
    else if (ownRuns.some(run => run.direction === 'row') && ownRuns.some(run => run.direction === 'column')) special = 'bomb';
    else if (longest >= 4) special = ownRuns.find(run => run.cells.length >= 4).direction;
    clusters.push({ cells, color, special, runs: ownRuns });
  }
  return clusters;
}
export function legalMoves(board) {
  const moves = [];
  for (let from = 0; from < CELLS; from++) for (const to of [from + 1, from + N]) {
    if (!adjacent(from, to)) continue;
    if (isSpecial(board[from]) || isSpecial(board[to])) { moves.push({ type: 'swap', from, to }); continue; }
    const swapped = board.slice(); [swapped[from], swapped[to]] = [swapped[to], swapped[from]];
    if (matches(swapped).some(cluster => cluster.cells.includes(from) || cluster.cells.includes(to))) moves.push({ type: 'swap', from, to });
  }
  return moves;
}
function makeInitial(seed) {
  let counter = 0; const board = [];
  for (let index = 0; index < CELLS; index++) {
    let color;
    do { color = randomInt(seed, 'initial', counter++, 5); }
    while ((index % N >= 2 && board[index - 1].color === color && board[index - 2].color === color) || (index >= N * 2 && board[index - N].color === color && board[index - N * 2].color === color));
    board.push({ id: index, color, special: null });
  }
  return board;
}
function fallbackBoard(seed, board, serial) {
  const palette = [0, 1, 2, 3, 4];
  for (let i = 4; i > 0; i--) { const j = randomInt(seed, 'fallback-palette', serial * 8 + i, i + 1); [palette[i], palette[j]] = [palette[j], palette[i]]; }
  const pattern = Array.from({ length: CELLS }, (_, i) => (Math.floor(i / N) + 2 * (i % N)) % 5);
  pattern[0] = 0; pattern[1] = 1; pattern[2] = 0; pattern[7] = 0;
  return board.map((tile, i) => ({ ...tile, color: tile.special === 'rainbow' ? null : palette[pattern[i]] }));
}
function reshuffle(state, player, reason) {
  const before = copyBoard(player.board), serial = player.shuffleCounter++;
  for (let attempt = 0; attempt < RULES.shuffleAttempts; attempt++) {
    const next = copyBoard(before);
    for (let i = CELLS - 1; i > 0; i--) { const j = randomInt(state.seed, 'shuffle', serial * RULES.shuffleAttempts * CELLS + attempt * CELLS + i, i + 1); [next[i], next[j]] = [next[j], next[i]]; }
    if (!matches(next).length && legalMoves(next).length) { player.board = next; return { reason, before, after: copyBoard(next), fallback: false, attempts: attempt + 1, durationMs: RULES.shuffleMs }; }
  }
  player.board = fallbackBoard(state.seed, before, serial);
  return { reason, before, after: copyBoard(player.board), fallback: true, attempts: RULES.shuffleAttempts, durationMs: RULES.shuffleMs };
}
function commonColor(board) {
  const counts = [0, 0, 0, 0, 0]; for (const tile of board) if (tile && tile.color !== null) counts[tile.color]++;
  return counts.indexOf(Math.max(...counts));
}
function effectCells(board, index, explicitColor) {
  const tile = board[index], row = Math.floor(index / N), col = index % N;
  if (tile.special === 'row') return Array.from({ length: N }, (_, c) => row * N + c);
  if (tile.special === 'column') return Array.from({ length: N }, (_, r) => r * N + col);
  if (tile.special === 'bomb') { const cells = []; for (let r = Math.max(0, row - 1); r <= Math.min(N - 1, row + 1); r++) for (let c = Math.max(0, col - 1); c <= Math.min(N - 1, col + 1); c++) cells.push(r * N + c); return cells; }
  if (tile.special === 'rainbow') { const color = explicitColor ?? commonColor(board); return board.flatMap((item, i) => item.color === color ? [i] : []); }
  return [];
}
function settleWave(state, player, clusters, forced, swap, waveIndex, refill) {
  const before = copyBoard(player.board), created = [], hit = new Set(forced?.cells || []), effects = [];
  for (const cluster of clusters) {
    cluster.cells.forEach(index => hit.add(index));
    if (cluster.special) {
      const index = swap && cluster.cells.includes(swap.to) ? swap.to : swap && cluster.cells.includes(swap.from) ? swap.from : cluster.cells[0];
      created.push({ index, tile: { id: player.nextTileId++, color: cluster.special === 'rainbow' ? null : cluster.color, special: cluster.special } });
    }
  }
  const queue = [...hit].sort((a, b) => a - b), triggered = new Set();
  for (let q = 0; q < queue.length; q++) {
    const index = queue[q]; if (!isSpecial(before[index]) || triggered.has(index)) continue; triggered.add(index);
    const cells = effectCells(before, index, forced?.colors?.[index]); effects.push({ index, special: before[index].special, cells });
    for (const cell of cells) if (!hit.has(cell)) { hit.add(cell); queue.push(cell); }
  }
  const removed = [...hit].sort((a, b) => a - b), multiplier = Math.min(waveIndex + 1, 5), score = removed.length * 10 * multiplier;
  const cleared = copyBoard(before); removed.forEach(index => { cleared[index] = null; }); created.forEach(({ index, tile }) => { cleared[index] = { ...tile }; });
  const after = Array(CELLS).fill(null), falls = [];
  for (let col = 0; col < N; col++) {
    let row = N - 1;
    for (let r = N - 1; r >= 0; r--) { const from = r * N + col; if (!cleared[from]) continue; const to = row-- * N + col; after[to] = { ...cleared[from] }; if (to !== from) falls.push({ id: after[to].id, from, to, spawned: false }); }
    const missing = row + 1;
    for (let r = row; r >= 0; r--) { const to = r * N + col, counter = player.refillCounters[col]++, color = refill ? refill(col, counter) : randomInt(state.seed, `refill-column-${col}`, counter, 5); after[to] = { id: player.nextTileId++, color, special: null }; falls.push({ id: after[to].id, from: (r - missing) * N + col, to, spawned: true }); }
  }
  player.board = after; player.score += score; player.maxCombo = Math.max(player.maxCombo, multiplier);
  return { index: waveIndex + 1, before, removed, created, cleared, after: copyBoard(after), falls, effects, multiplier, score, totalScore: player.score, clearMs: RULES.clearMs, fallMs: RULES.fallMs };
}
function firstForced(board, from, to) {
  const a = board[from], b = board[to], cells = new Set(), colors = {};
  if (a.special === 'rainbow' && b.special === 'rainbow') for (let i = 0; i < CELLS; i++) cells.add(i);
  else if (a.special === 'rainbow' || b.special === 'rainbow') {
    const rainbow = a.special === 'rainbow' ? from : to, other = rainbow === from ? to : from, color = board[other].color;
    cells.add(rainbow); colors[rainbow] = color;
    board.forEach((tile, i) => { if (tile.color === color) cells.add(i); });
    if (isSpecial(board[other])) cells.add(other);
  } else { if (isSpecial(a)) cells.add(from); if (isSpecial(b)) cells.add(to); }
  return { cells: [...cells], colors };
}
function resolve(state, player, clusters, forced, from, to, event, refill) {
  for (let wave = 0; wave < RULES.maxWaves; wave++) {
    const triggers = wave === 0 ? forced : null;
    if (!clusters.length && !triggers?.cells.length) break;
    event.waves.push(settleWave(state, player, clusters, triggers, wave === 0 ? { from, to } : null, wave, refill));
    clusters = matches(player.board);
    if (wave === RULES.maxWaves - 1 && clusters.length) event.reshuffle = reshuffle(state, player, 'cascade-cap');
  }
  if (!event.reshuffle && !legalMoves(player.board).length) event.reshuffle = reshuffle(state, player, 'no-moves');
}
export function createState(seedHex, now, options = {}) {
  if(options.ruleVersion===legacy.RULE_VERSION)return legacy.createState(seedHex,now,options);
  if(options.ruleVersion!==undefined&&!supportsRuleVersion(options.ruleVersion))fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');
  validNow(now);
  if (typeof seedHex !== 'string' || !/^(?:[0-9a-f]{2}){16,64}$/i.test(seedHex)) fail('INVALID_SEED', 'Seed must contain 16–64 bytes of hexadecimal entropy', 400);
  const roster = options.players || [{ key: 'player_1', seatIndex: 0 }, { key: 'player_2', seatIndex: 1 }];
  if (!Array.isArray(roster) || roster.length < 2 || roster.length > 4 || new Set(roster.map(p => typeof p === 'string' ? p : p.key)).size !== roster.length) fail('INVALID_PLAYERS', 'Match Arena supports 2–4 unique players', 400);
  if (options.durationMs !== undefined && options.durationMs !== RULES.durationMs) fail('INVALID_DURATION', 'The V1 rule has a fixed 90-second duration', 400);
  const state = { ruleVersion: RULE_VERSION, contentVersion:MATCH_CONTENT_VERSION,objective:selectMatchObjective(seedHex),seed: seedHex.toLowerCase(), status: 'active', startedAt: now, deadlineAt: now + RULES.durationMs, durationMs: RULES.durationMs, now, version: 0, players: {} };
  const proto = { board: makeInitial(state.seed), shuffleCounter: 0 };
  if (!legalMoves(proto.board).length) reshuffle(state, proto, 'initial');
  roster.forEach((item, index) => { const person = typeof item === 'string' ? { key: item, seatIndex: index } : item; if (typeof person.key !== 'string' || !person.key || person.key.length > 128 || ['__proto__','constructor','prototype'].includes(person.key)) fail('INVALID_PLAYER', 'Invalid player key', 400); state.players[person.key] = { key: person.key, seatIndex: person.seatIndex ?? index, name: person.name || person.key, isBot: Boolean(person.isBot), board: copyBoard(proto.board), score: 0, objectiveProgress:0, busyUntil: now, refillCounters: [0,0,0,0,0,0], shuffleCounter: proto.shuffleCounter, nextTileId: CELLS, moves: 0, validMoves: 0, maxCombo: 0, forfeited: false, lastEventId: null }; });
  return state;
}
export function act(state, playerKey, action, now) {
  if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.act(state, playerKey, action, now);
  validNow(now); const player = Object.hasOwn(state.players, playerKey) ? state.players[playerKey] : null;
  if (!player || player.forfeited) fail('NOT_A_PLAYER', 'This player cannot act');
  if (state.status !== 'active') fail('NOT_ACTIVE', 'The game is complete');
  if (now < state.startedAt) fail('NOT_STARTED', 'The game has not started');
  if (now >= state.deadlineAt) fail('DEADLINE_PASSED', 'No new swaps are accepted after the deadline');
  if (now < player.busyUntil) fail('BUSY', 'The previous swap is still resolving');
  if (!action || action.type !== 'swap' || !adjacent(action.from, action.to)) fail('INVALID_ACTION', 'Choose two orthogonally adjacent board cells', 400);
  const before = copyBoard(player.board), { from, to } = action; [player.board[from], player.board[to]] = [player.board[to], player.board[from]];
  const swappedBoard = copyBoard(player.board); let clusters = matches(player.board); const forced = firstForced(player.board, from, to);
  const valid = forced.cells.length > 0 || clusters.some(cluster => cluster.cells.includes(from) || cluster.cells.includes(to));
  player.moves++; state.version++; state.now = now;
  const event = { id: `${playerKey}:${player.moves}`, type: 'swap', playerKey, from, to, acceptedAt: now, before, swappedBoard, valid, waves: [], reshuffle: null, scoreBefore: player.score, scoreDelta: 0, swapMs: RULES.swapMs };
  if (!valid) player.board = before;
  else {
    player.validMoves++;
    resolve(state, player, clusters, forced, from, to, event);
  }
  event.scoreDelta = player.score - event.scoreBefore;
  player.busyUntil = now + RULES.swapMs + event.waves.length * (RULES.clearMs + RULES.fallMs) + (event.reshuffle ? RULES.shuffleMs : 0);
  player.objectiveProgress += event.waves.reduce((sum,wave)=>sum+objectiveWaveProgress(wave,state.objective),0);
  event.objectiveProgress=objectiveValue(player,state.objective);
  player.lastEventId = event.id; event.busyUntil = player.busyUntil; event.finalBoard = copyBoard(player.board); event.totalScore = player.score;
  return { state, event };
}
export function tick(state, now) {
  if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.tick(state, now);
  validNow(now); state.now = Math.max(state.now, now);
  if (state.status !== 'active') return { state };
  const active = Object.values(state.players).filter(p => !p.forfeited);
  if (!active.length) { state.status = 'finished'; state.finishReason = 'all-forfeited'; state.finishedAt = now; return { state, event: { type: 'finished', reason: state.finishReason } }; }
  if ((now >= state.deadlineAt || active.length === 1) && active.every(p => p.busyUntil <= now)) { state.status = 'finished'; state.finishReason = active.length === 1 ? 'last-player' : 'deadline'; state.finishedAt = now; return { state, event: { type: 'finished', reason: state.finishReason } }; }
  return { state };
}
function compareObjective(state,a,b){return objectiveValue(b,state.objective)-objectiveValue(a,state.objective)||b.score-a.score;}
export function rank(state) {
 if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.rank(state);
 const active=Object.values(state.players).filter(p=>!p.forfeited).sort((a,b)=>compareObjective(state,a,b)||a.seatIndex-b.seatIndex);
 return [...active.map(p=>({playerKey:p.key,rank:1+active.filter(other=>compareObjective(state,other,p)<0).length,score:objectiveValue(p,state.objective),rawScore:p.score,objectiveId:state.objective.id,objectiveComplete:objectiveValue(p,state.objective)>=state.objective.target,forfeited:false})),...Object.values(state.players).filter(p=>p.forfeited).map(p=>({playerKey:p.key,rank:null,score:objectiveValue(p,state.objective),rawScore:p.score,objectiveId:state.objective.id,objectiveComplete:false,forfeited:true}))];
}
export function view(state, playerKey) {
  if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.view(state, playerKey);
  const p = Object.hasOwn(state.players, playerKey) ? state.players[playerKey] : null; if (!p) fail('NOT_A_PLAYER', 'Private board is unavailable', 403);
  return { status: state.status, ruleVersion: state.ruleVersion, contentVersion:state.contentVersion,objective:clone(state.objective),objectiveProgress:objectiveValue(p,state.objective),objectiveComplete:objectiveValue(p,state.objective)>=state.objective.target,standings:rank(state),board: copyBoard(p.board), score: p.score, busyUntil: p.busyUntil, deadlineAt: state.deadlineAt, durationMs: state.durationMs, version: state.version, maxCombo: p.maxCombo, moves: p.moves, lastEventId: p.lastEventId, forfeited: p.forfeited };
}
// Narrow deterministic helpers for executable rule cases, not a client game API.
export const testing = { reshuffle, settleWave, fallbackBoard, firstForced, resolve };

export function forfeit(state, keys, now) {
  if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.forfeit(state, keys, now);
  validNow(now); if (state.status !== 'active') return { state };
  if (!Array.isArray(keys) || keys.some(key => !Object.hasOwn(state.players, key))) fail('INVALID_PLAYER', 'Unknown forfeit roster', 400);
  for (const key of new Set(keys)) state.players[key].forfeited = true;
  state.version++; return tick(state, now);
}
export function shiftTime(state, deltaMs) {
  if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.shiftTime(state, deltaMs);
  if (!Number.isSafeInteger(deltaMs) || deltaMs < 0 || deltaMs > 60000) fail('INVALID_PAUSE', 'A shared recovery pause is limited to 60 seconds', 400);
  if (state.status !== 'active') return state;
  state.startedAt += deltaMs; state.deadlineAt += deltaMs; state.now += deltaMs;
  for (const player of Object.values(state.players)) player.busyUntil += deltaMs;
  return state;
}
export function botAction(state, key, now) {
  if(state.ruleVersion!==RULE_VERSION&&state.ruleVersion!==legacy.RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Unsupported pinned rules');if(state.ruleVersion===legacy.RULE_VERSION)return legacy.botAction(state, key, now);
  const player = Object.hasOwn(state.players, key) ? state.players[key] : null;
  if (!player || player.forfeited || state.status !== 'active' || now < state.startedAt || now >= state.deadlineAt || now < player.busyUntil) return null;
  const moves=legalMoves(player.board);let best=null,bestValue=-Infinity;
  for(const move of moves){const board=copyBoard(player.board);[board[move.from],board[move.to]]=[board[move.to],board[move.from]];const clusters=matches(board),forced=firstForced(board,move.from,move.to),hit=new Set(forced.cells);for(const c of clusters)for(const index of c.cells)hit.add(index);
   const specials=[...hit].filter(i=>board[i]?.special).length,created=clusters.filter(c=>c.special).length;
   const value=state.objective.id==='special'?specials*100+created*40+hit.size:state.objective.id==='collect'?[...hit].filter(i=>board[i]?.color===state.objective.color).length*30+specials*8+created*10+hit.size:hit.size+specials*4+created*5;
   if(value>bestValue){best=move;bestValue=value;}}
  return best;
}
