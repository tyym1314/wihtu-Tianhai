# Ludo Quick — playable V1

Owned implementation: `engine.mjs`, `topology.mjs`, `LudoGame.jsx`, `ludo.css`, `index.jsx`. Shared SVG pieces, HUD, event interpolation and server-only entropy helpers are in `../boardkit/`. No server, wallet or public shell is implemented here.

## Engine and action contract

Rule version: `pvp-ludo-v1.0.0`. Two or four players, two pawns each, individual competition. Two players occupy opposite colors, while the supplied randomized seat indices remain unchanged. The render topology exports exactly 52 distinct ring cells and four separate six-cell home lanes.

- `createState(seedHex, now, {players, durationMs?})` accepts a 16–64 byte hex seed, server milliseconds and players `{key,seatIndex,name,isBot}`. `durationMs`, when supplied, must be `480000` for this version.
- `act(state,key,action,now)` mutates the provided JSON-compatible state and returns `{state,event}`. The room transaction should pass a cloned state and commit it only when the action succeeds.
- `tick` and `forfeit(state,keys,now)` return `{state,event?}`. Forfeits and a currently due third turn timeout are applied as one batch before survivor ranking. An elapsed first/second timeout still consumes its die but does not forfeit the player. A finished result is immutable. All-player forfeiture has `outcome:'void'`.
- `shiftTime(state,ms)` returns the state with all absolute start, turn, global and animation deadlines moved by 0–60000 ms. `rank` returns public rank records. `view` returns only the current public game, current revealed die and this caller's legal actions; no seed or future dice. `botAction` returns a normal legal action; only the room may decide to use it in explicitly free practice.

Actions:

```js
{type:'roll'}          // reveal the current server-fixed die; never generates a new die
{type:'move',piece:0}  // piece is 0 or 1, owned by the caller
```

`view.legalActions` drives all controls. A valid move requires the die to have been revealed. The 20-second deadline begins when the server fixes the die, includes its display time and does not reset on reveal. A roll is a display operation; the consecutive timeout counter resets only after an accepted pawn movement. Forced no-move passes do not count as timeouts and preserve an existing timeout streak. Three sixes are handled before movement; the first two accepted moves are not undone.

No-move/third-six states expose the fixed die and automatically advance after a 650 ms announcement. Accepted moves occupy 450 ms for their visible route; the subsequent turn begins through `tick`. The cap finishes the currently fixed die before ranking. Timing constants are exported by `RULES`; root room polling must keep calling `tick`.

## UI contract

`LudoGame({room,me,onAction,audio,onExit,locale='zh'})` consumes `room.game = engine.view(...)`, lower/uppercase `room.status`, `room.server_now`, fee/prize context and the supplied audio service. `onAction` resolves `{room,event}`. Current events must remain available as `room.game.lastEvent` so remote/bot moves can also animate. Effects are presentation-only; the client never generates dice, captures or awards.

The component supplies its full mobile header/HUD. The shared room shell owns lobby, exit confirmation and settlement. It supports Chinese, English and Arabic (`dir=rtl`; board coordinates remain fixed). All four colors, stars, paths, pawns and highlights are interactive SVG, not a design screenshot.

Stable review selectors: `[data-action=ludo-roll]`, `[data-pawn="<key>:0"]`, `[data-action=ludo-move]`. Select a highlighted pawn to reveal its route, then use the arrow/flag confirmation button. The actual route endpoint is also clickable. Help remains available without pausing the server clock.

## Verification

- `node --test tests/ludo-engine.test.mjs`: 19 cases, including deterministic hidden die, exact finish, all eight safe cells, stacked captures, third-six behavior, timeout/forfeit, cap ties, pause and complete JSON-replayed bot games.
- `node tests/ludo-ui.mjs`: independent in-memory esbuild + random-port HTTP + actual authoritative engine; no Vite cache or wallet dependency. Browser proof covers die reveal, legal base exit, route selection, live polling, 360/390 widths, three languages and exit callback. No page errors.
- Screenshots: `review/ludo-390.png`, `review/ludo-route-390.png`, `review/ludo-route-360.png`, `review/ludo-played-390.png`.

These are game-engine/UI proofs. Real room admission, team-free individual settlement, wallet capture and payout are exercised by the root integration suite, not claimed by the isolated harness. Screens shorter than the designed viewport can scroll; there is no horizontal overflow.


Latest active-game visual restoration, generated asset provenance and isolated viewport evidence: [RESTORATION.md](RESTORATION.md).

## Fixed-view restoration V3

See [RESTORATION-V3.md](RESTORATION-V3.md) for independent asset layers, exact geometry boundaries, original source/prompts, screenshots and actual local-engine UI validation.
