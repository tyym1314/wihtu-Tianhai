/** Local-only render cadence fixture; no server or wallet calls. */
import React, {Profiler, useState} from 'react';
import {createRoot} from 'react-dom/client';
import DominoGame from './DominoGame.jsx';
import {createState, view, TILES} from './engine.mjs';

const state = createState('1'.repeat(64), Date.now(), {
  players: [
    {key: 'p0', name: 'YOU', seatIndex: 0},
    {key: 'p1', name: 'BOT', seatIndex: 1, isBot: true},
  ],
});
state.turnIndex = 0;
state.turnKey = 'p0';
state.turnDeadlineAt = Date.now() + 20000;
state.busyUntil = Date.now() - 1;

// Keep a long, connected chain visible throughout the idle sample.
const unused = new Set(TILES.map(tile => tile.id));
const stack = [0];
const edges = [];
const circuit = [];
while (stack.length) {
  const at = stack.at(-1);
  const tile = TILES.find(item => unused.has(item.id) && (item.a === at || item.b === at));
  if (tile) {
    unused.delete(tile.id);
    const next = tile.a === at ? tile.b : tile.a;
    stack.push(next);
    edges.push({tileId: tile.id, left: at, right: next, playedBy: 'p1', at: Date.now()});
  } else {
    stack.pop();
    if (edges.length) circuit.push(edges.pop());
  }
}
state.chain = circuit.reverse().slice(0, 20);
state.left = state.chain[0].left;
state.right = state.chain.at(-1).right;

const metrics = {commits: [], frames: [], active: false};
let rerender = () => {};
function sampleFrame(at) {
  if (metrics.active) metrics.frames.push(at);
  requestAnimationFrame(sampleFrame);
}
requestAnimationFrame(sampleFrame);
function App() {
  const [room, setRoom] = useState(snapshot());
  rerender = () => setRoom(snapshot());
  return <Profiler id="domino" onRender={(_id, phase, actualDuration) => {
    if (metrics.active) metrics.commits.push({at: performance.now(), phase, actualDuration});
  }}><DominoGame room={room} me="p0" locale="zh" audio={{enabled: false, play() {}, unlock() {}, setEnabled() {}}} onAction={async () => {}} onExit={() => {}} /></Profiler>;
}
function snapshot() {
  state.serverNow = Date.now();
  return {id: 'DOMINO-PERFORMANCE-FIXTURE', status: state.status, practice: true,
    entry_minor: '0', prize_minor: '0', server_now: state.serverNow, game: view(state, 'p0')};
}
window.dominoPerformance = {
  start() { metrics.commits = []; metrics.frames = []; metrics.active = true; },
  stop() { metrics.active = false; return {commits: metrics.commits, frames: metrics.frames}; },
  setBusy(delayMs) { state.busyUntil = Date.now() + delayMs; rerender(); return performance.now(); },
};
createRoot(document.querySelector('#root')).render(<App />);
