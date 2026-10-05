/** Real product Game components, isolated authoritative snapshots, persistent React root. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import Match from '../arena/match/MatchGame.jsx';
import TowerLink from '../arena/towerlink/TowerLinkGame.jsx';
import Carrom from '../arena/carrom/CarromGame.jsx';
import Darts from '../arena/darts/DartsGame.jsx';
import Ludo from '../arena/ludo/LudoGame.jsx';
import Jackaroo from '../arena/jackaroo/JackarooGame.jsx';
import Domino from '../arena/domino/DominoGame.jsx';
import Pool from '../arena/pool/PoolGame.jsx';
import {preloadMatchAssets} from '../arena/match/assets.mjs';
import {preloadTowerAssets} from '../arena/towerlink/tower-assets.mjs';
import {preloadBoardAssets} from '../arena/shared/board-assets.mjs';

const components = {match: Match, towerlink: TowerLink, carrom: Carrom, darts: Darts, ludo: Ludo, jackaroo: Jackaroo, domino: Domino, pool: Pool};
const host = document.querySelector('#life-root');
const root = createRoot(host);
const subscribers = new Set();
// Deliberately silent: this run audits Game ownership, not the separate production audio owner.
const audio = {enabled: false, play() {}, unlock() {}, silence() {}, startMusic() {}, setEnabled() {}, toggle() {}, subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); }};
let live = null, generation = 0;
const prepared = new Map(), renderErrors = [], attempts = [];
class Boundary extends React.Component {
  state = {error: null};
  static getDerivedStateFromError(error) { return {error}; }
  componentDidCatch(error) { renderErrors.push(error.stack || error.message); }
  render() { return this.state.error ? <pre data-life-error>{this.state.error.message}</pre> : this.props.children; }
}
async function request(path, body, signal) {
  const response = await fetch('/arena/__life/' + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Fixture request failed'), {code: result.code});
  return result;
}
async function prepare(game) {
  if (!components[game]) throw Error('Unknown fixture game ' + game);
  if (!prepared.has(game)) {
    window.__lifeLabel = 'cache:' + game;
    const value = await (game === 'match' ? preloadMatchAssets() : game === 'towerlink' ? preloadTowerAssets() : preloadBoardAssets(game));
    const images = value?.images instanceof Map ? [...value.images.values()] : value;
    if (!Array.isArray(images) || !images.length || images.some(image => !image.complete || !image.naturalWidth)) throw Error('Incomplete authored artwork: ' + game);
    prepared.set(game, images.map(image => ({url: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight})));
  }
  return prepared.get(game);
}
function paint() {
  if (!live) { flushSync(() => root.render(null)); return; }
  const current = live, Game = components[current.game];
  const onAction = async action => {
    attempts.push({game: current.game, generation: current.generation, action, at: Date.now()});
    const result = await request('action', {game: current.game, generation: current.serverGeneration, action}, current.controller.signal);
    if (live === current) { current.room = result.room; paint(); }
    return result;
  };
  flushSync(() => root.render(<Boundary key={current.generation}><Game room={current.room} me="p0" audio={audio} locale="zh" onAction={onAction} onExit={() => window.mobileLifecycle.unmount()}/></Boundary>));
}
flushSync(() => root.render(null));
window.mobileLifecycle = {
  games: Object.keys(components), renderErrors, attempts,
  audioSubscriberCount: () => subscribers.size,
  async prepare(game) { return prepare(game); },
  async mount(game, mode = 'normal') {
    if (live) throw Error('Unmount the preceding Game before mounting');
    await prepare(game);
    const controller = new AbortController(), clientGeneration = ++generation;
    const result = await request('reset', {game, mode}, controller.signal);
    if (clientGeneration !== generation) { controller.abort(); throw Error('Mount superseded'); }
    live = {game, generation: clientGeneration, serverGeneration: result.generation, controller, room: result.room, legalMove: result.legalMove};
    window.__lifeLabel = game + ':mount-' + clientGeneration;
    paint();
    await window.__mobileLife.nextPaint();
    return {game, generation: clientGeneration, roomId: result.room.id, ruleVersion: result.room.game.ruleVersion, legalMove: result.legalMove};
  },
  unmount() {
    generation++;
    const previous = live; live = null;
    paint(); previous?.controller.abort();
    window.__lifeLabel = 'unmounted';
  },
  async authorityAnimation() {
    const current = live;
    if (current?.game !== 'darts') throw Error('Only the Darts accepted-flight fixture is implemented');
    const result = await request('darts-flight', {generation: current.serverGeneration}, current.controller.signal);
    if (live === current) { current.room = result.room; paint(); }
    return result.event;
  },
  current: () => live ? {game: live.game, generation: live.generation, roomId: live.room.id, legalMove: live.legalMove} : null,
  retainedCache: () => Object.fromEntries(prepared),
};
window.__lifeLabel = 'framework';
window.__lifeReady = true;
