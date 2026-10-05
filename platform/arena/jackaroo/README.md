# Arena Jackaroo V1 — playable 2v2

Owned implementation: `engine.mjs`, `topology.mjs`, `JackarooGame.jsx`, `jackaroo.css`, `index.jsx`. Shared HUD, SVG marbles, motion and server-only entropy utilities live in `../boardkit/`. The component does not implement funding or payouts.

## Rules and authoritative state

Version `pvp-jackaroo-v1.0.0`: four fixed players, opposite frozen teammates, four marbles each; a 64-cell outer ring and four independent four-hole home lanes. Supplied `teamId` values are preserved and validated against opposite seats. `team_a` is visually emerald, `team_b` ivory, independent of which team receives seats 0/2. A player forfeiting forfeits both teammates. An elapsed third play timeout is merged with explicitly departing teams before deciding a winner; its smallest-card discard is still applied. One batch containing both teams yields `outcome:'void'`; a saved final result cannot be erased.

The API matches the other arena engines: `createState(seedHex,now,{players,durationMs?})`, `act`, `tick`, `forfeit`, `shiftTime`, `rank`, `view`, `botAction`. Time values are server milliseconds. Optional duration must be `720000` for this rule version. All functions are synchronous and replayable over JSON state; mutating actions return `{state,event}`. The room should apply them to a transaction-local cloned state and commit only on success.

The 52 unique cards use IDs such as `C1`, `D7`, `H12`, `S13` (`C,D,H,S`; ranks 1–13). HMAC-separated shuffle generations run only in the server engine. Four cards per player are dealt for each hand; fewer than 16 undealt cards triggers a reshuffle of the undealt and discarded cards only, after all hands empty. Private hands and pending pass choices never appear in another player's view. Public events contain only already-played cards and public marble paths.

## Actions

```js
{type:'pass',cardId:'C1'}
{type:'play',cardId:'C1',effect:'enter',pieceId:'alice:0'}
{type:'play',cardId:'C1',effect:'move',pieceId:'alice:0',steps:11}
{type:'play',cardId:'C4',effect:'move',pieceId:'alice:0',steps:-4}
{type:'play',cardId:'C11',effect:'swap',pieceId:'alice:0',targetId:'bob:2'}
{type:'play',cardId:'D7',effect:'split',segments:[
  {pieceId:'alice:0',steps:3}, {pieceId:'alice:1',steps:4}
]}
{type:'discard',cardId:'C2'}
```

The server checks the held card and its exact allowed effect. A/K may enter; A may move 1/11; J may move 11 or swap unprotected opposing ring marbles; four moves exactly −4 on the ring; seven requires complete ordered positive segments totaling seven, without reusing a marble. Other ranks move their value. Five cannot move an opponent; ten has no extra discard effect.

Every seven segment is simulated against a cloned state in sequence, including path captures and an immediate switch to helping the teammate once the actor's fourth marble reaches home. No partial segment is committed. A split cannot truncate to win early. Normal moves may cross unprotected friendly marbles but not end on them; home lanes and protected marbles block passage. A/K entry protection expires only when that marble moves. A backward shortcut to relative 60 is retained. Jack swaps recompute positions relative to each marble's actual owner.

During `phase:'exchange'`, everyone chooses one card secretly within 10 seconds. All four transfers complete simultaneously; missing choices use ascending rank then C/D/H/S. Exchange timeout adds no strike. During `phase:'play'`, a turn lasts 20 seconds. A timeout discards the lowest held card even if a legal move existed; three consecutive timeouts forfeit the team. A legal play or legal one-card discard resets that player's timeout streak. Voluntary discard is allowed only when every held card is blocked.

Accepted card effects occupy 500 ms before `tick` advances. The 12-minute/240-card cap finishes the current four-seat round, then compares team home count and progress; tied teams remain tied. The room must continue ticking. A recovery pause shifts exchange, turn, global and animation deadlines together, bounded to 60 seconds.

## Interface

`JackarooGame({room,me,onAction,audio,onExit,locale='zh'})` is a complete mobile active-game view. `room.game` must be `engine.view`; its `lastEvent` should be shared for remote moves. The shared shell retains readiness, exit confirmation and real settlement. The client consumes legal actions and never invents hands, movement or rewards.

Flow: choose a hand card → choose an available effect → select a glowing controlled marble → select an opposing swap target when needed → confirm. Seven uses a compact ordered composer: select a marble, select one of its currently legal step counts, repeat until seven, then confirm. All intermediate branches come from the server's complete legal plans; no giant action list is rendered. The confirmation button remains disabled for partial seven. Undo is local planning only. Before all own marbles are home, teammate marbles cannot be selected.

Stable selectors: `[data-card="C11"]`, `[data-effect="swap"]` (also `enter`, `move:11`, `split`, `discard`), `[data-marble="<key>:0"]`, `[data-split-step="3"]`, `[data-action=jack-confirm]`. Chinese/English/Arabic are supported. SVG wood grain, recessed holes, marbles, protection rings, route highlights and movement are live rendering, not the concept image.

## Evidence and limits

- `node --test tests/jackaroo-engine.test.mjs`: 23 cases covering all card effects, private passes, protection, back-four shortcut, Jack ownership, ordered seven capture/rollback/assistance, single-card discard, timeout, cap/ties, atomic forfeits and complete bot games. Every simulated step conserves 52 unique cards through reshuffles.
- `node tests/jackaroo-ui.mjs`: actual engine over isolated HTTP, with real UI clicks for secret pass, Jack swap and ordered 3+4 split with two path captures. The latter two use explicitly prepared mid-game fixtures. These fixtures do not claim natural dealing or live-wallet proof.
- Browser checks include partial-seven disabled, no errors, 360/390 widths and three languages. Screenshots: `review/jackaroo-pass-390.png`, `jackaroo-swap-390.png`, `jackaroo-split-390.png`, `jackaroo-split-360.png`, `jackaroo-played-390.png`.
- Tests use in-memory esbuild and random ports, close all servers/browsers, and never touch shared Vite optimized-dependency caches. The parent integration suite owns real admission, freezes, team payouts and wallet reconciliation.

### Touch interception regression

The render layer (marbles, protection rings, glow and shadows) has no pointer events. A final interaction layer gives each legal marble its own centered transparent target. Nonlegal targets never receive input. Target radius is bounded by half the nearest legal target distance, so adjacent legal choices do not mask each other. `data-marble` and button accessibility now belong to those exact targets.

`node tests/jackaroo-hit-ui.mjs` reproduces the platform failure: seat 0 has marble 0 at progress 8, the other three marbles are in base, and every opponent remains in base. Normal Playwright clicks select and move the ring marble despite the nearby decorative base marble at SVG coordinates `(105.5,105.5)`. It also selects all four base marbles independently and both adjacent Jack swap targets at 390/360 widths, without `force`. Results are in `review/hit-regression.json`; screenshots are `review/jackaroo-base-hit-390.png` and `jackaroo-base-hit-360.png`.


Latest active-game visual restoration, generated asset provenance and isolated viewport evidence: [RESTORATION.md](RESTORATION.md).

## Fixed-view restoration V3

See [RESTORATION-V3.md](RESTORATION-V3.md) for independent asset layers, exact geometry boundaries, original source/prompts, screenshots and actual local-engine UI validation.
