/** Explicitly started by the runner, never starts a server at module import. No DB or production API. */
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import * as match from '../arena/match/engine.mjs';
import * as towerlink from '../arena/towerlink/engine.mjs';
import * as carrom from '../arena/carrom/engine.mjs';
import * as darts from '../arena/darts/engine.mjs';
import * as ludo from '../arena/ludo/engine.mjs';
import * as jackaroo from '../arena/jackaroo/engine.mjs';
import * as domino from '../arena/domino/engine.mjs';
import * as pool from '../arena/pool/engine.mjs';
import {gestureToward} from '../arena/darts/geometry.mjs';

export const games = ['match', 'towerlink', 'carrom', 'darts', 'ludo', 'jackaroo', 'domino', 'pool'];
export async function startMobileLifecycleServer() {
  const platform = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const engines = {match, towerlink, carrom, darts, ludo, jackaroo, domino, pool};
  const players = Array.from({length: 4}, (_, index) => ({key: 'p' + index, name: index ? 'BOT ' + index : 'You', seatIndex: index, isBot: index > 0, teamId: index % 2 ? 'team_b' : 'team_a'}));
  const states = new Map(), generations = new Map(), actions = [];
  const temporary = await mkdtemp(resolve(tmpdir(), 'oasis-mobile-lifecycle-'));
  let server;
  const snapshot = game => {
    const state = states.get(game), now = Date.now(), engine = engines[game];
    const ticked = engine.tick(state, now); if (ticked?.state) states.set(game, ticked.state);
    const current = states.get(game), roster = game === 'jackaroo' ? players : players.slice(0, 2);
    return {id: `lifecycle-${game}-${generations.get(game)}`, game_id: game, status: 'active', practice: true, capacity: roster.length, server_now: now,
      players: roster.map(person => ({...person, external_user_id: person.key, name: person.name, seat_index: person.seatIndex, bot: person.isBot, score: current.players?.[person.key]?.score || 0})), game: engine.view(current, 'p0')};
  };
  const reset = (game, mode) => {
    if (!engines[game]) throw Error('Unknown game');
    const now = Date.now(), roster = game === 'jackaroo' ? players : players.slice(0, 2);
    const state = engines[game].createState('12'.repeat(32), now, {players: roster, startAt: now});
    // Same deterministic input-ready fixtures used by existing precision/board tests.
    if (['darts', 'carrom', 'pool'].includes(game)) state.turnKey = 'p0';
    if (game === 'pool' && mode === 'free') { state.breakPending = false; state.ballInHand = true; state.cuePlaced = false; }
    if (game === 'ludo') { state.turnKey = 'p0'; state.pendingNext = null; state.dice = 6; state.revealed = true; state.sixes = 1; state.thirdSix = false; state.busyUntil = now; state.lastEvent = null; }
    states.set(game, state); generations.set(game, (generations.get(game) || 0) + 1);
    return {generation: generations.get(game), room: snapshot(game), legalMove: game === 'match' ? match.legalMoves(state.players.p0.board)[0] : null};
  };
  const assertGeneration = (game, value) => { if (generations.get(game) !== value) throw Error('Stale isolated fixture generation'); };
  const plugin = {
    name: 'isolated-eight-game-lifecycle',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, 'http://fixture').pathname.replace(/^\/arena(?=\/)/, '');
        if (!pathname.startsWith('/__life')) return next();
        try {
          if (pathname === '/__life' || pathname === '/__life/') {
            const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Isolated lifecycle fixture</title><style>html,body{margin:0;min-height:100%;background:#071824}#life-root{width:100%;max-width:460px;margin:auto}button{touch-action:manipulation}</style></head><body><div id="life-root"></div><script type="module" src="/@fs' + resolve(platform, 'tests/mobile-lifecycle-fixture.jsx') + '"></script></body></html>';
            res.setHeader('content-type', 'text/html'); res.end(await vite.transformIndexHtml('/arena/__life/', html)); return;
          }
          let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw Error('Fixture request too large'); }
          const body = JSON.parse(raw || '{}'); let result;
          if (pathname === '/__life/reset') result = reset(body.game, body.mode);
          else if (pathname === '/__life/action') {
            const {game, generation, action} = body; assertGeneration(game, generation);
            const entry = {game, generation, action, at: Date.now()}; actions.push(entry);
            const accepted = engines[game].act(states.get(game), 'p0', action, entry.at);
            if (accepted?.state) states.set(game, accepted.state);
            entry.accepted = true; result = {room: snapshot(game), event: accepted?.event};
          } else if (pathname === '/__life/darts-flight') {
            assertGeneration('darts', body.generation);
            const state = states.get('darts'), now = Date.now(), gesture = gestureToward(0, -.62);
            const accepted = darts.act(state, 'p0', {type: 'throw', gesture}, now);
            actions.push({game: 'darts', generation: body.generation, action: {type: 'throw', gesture}, at: now, accepted: true, fixtureAnimation: true});
            result = {room: snapshot('darts'), event: accepted.event};
          } else { res.statusCode = 404; result = {error: 'Unknown isolated fixture route'}; }
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = error.status || 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({error: error.message, code: error.code}));
        }
      });
    },
  };
  try {
    server = await createServer({configFile: resolve(platform, 'arena/vite.config.mjs'), cacheDir: resolve(temporary, 'vite-cache'), plugins: [plugin],
      optimizeDeps: {noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom', 'lucide-react']},
      server: {host: '127.0.0.1', port: 0, fs: {allow: [platform]}}});
    await server.listen();
    return {url: server.resolvedUrls.local[0] + '__life/', actions, state: game => states.get(game), temporary,
      async close() { await server.close(); await rm(temporary, {recursive: true, force: true}); }};
  } catch (error) { await server?.close(); await rm(temporary, {recursive: true, force: true}); throw error; }
}
