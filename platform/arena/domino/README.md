# Domino Duel · local integration

This module provides a double-six 2/4-player individual game and a mobile ivory-on-blue-felt table. The platform owns authenticated users, paid room admission, wallets, persistence, heartbeat and settlement; the module does not handle money.

```jsx
import DominoGame from './domino/DominoGame.jsx';
<DominoGame room={room} me={externalUserId} onAction={sendAction}
  audio={sharedAudio} onExit={leaveRoom} locale="zh" />
```

The props follow the other arena games: `room.game=engine.view(state, me)`, Unix-ms `room.server_now`, lowercase room status, `practice/entry_minor/prize_minor`, and an `onAction` promise resolving `{room,event}`. Shared audio uses click/hit/swap hooks. `view.lastEvent` must remain the latest game event: replacing it with the caller's last request would suppress opponent/BOT placement animations.

## Actions and private views

```json
{"type":"play","tileId":"d_4_5","end":"left"}
{"type":"draw"}
{"type":"pass"}
```

Only the current player may act. The server verifies ownership and a matching end, chooses the orientation and updates the chain. Clients cannot send scores or another player's tile. `draw` draws until the first playable tile or empty stock; it does not restart the current deadline. Drawing or passing with a playable tile is rejected. Passing also requires an empty stock.

`view` exposes only the caller's hand and legal moves. Other players have hand counts, not tile identities or remaining pip totals. Stock order and seed are never included. Draw event identities are private to the drawing player. During an active game `rank` returns `score:0,rank:null` to prevent the platform's public ranking wrapper from leaking hidden pip totals. Finished results expose pip totals.

28 unique double-six tiles, seven tiles each; two players leave 14 in the stock, four leave none. The highest held double opens automatically, otherwise the highest sum/high end. First empty hand wins. Consecutive legal passes by all eligible players produce a blocked game. Timeouts reset the pass sequence and cannot fabricate a block. Three consecutive personal timeouts forfeit; legal actions reset that streak. Forfeited hands enter a removed collection and never recycle into stock. On a true block, five-minute limit or 100 completed actions, minimum remaining pips wins with ties. The limit finishes the current action. Simultaneous forfeits are resolved as a batch.

The server seed is mixed into a deterministic shuffle stream, so persisted state/replay are reproducible. This is a reference game implementation, not an independently certified random-number system.

Exports: `RULE_VERSION`, `TILES`, `legalMoves`, `createState`, `act`, `tick`, `forfeit`, `shiftTime`, `rank`, `view`, `botAction`; the functions mutate JSON-serializable state. The BOT uses its own legal hand choices only and must be confined to explicitly free practice by the platform.

## UI and checks

The hand is selectable; matching chain endpoints glow and larger left/right buttons complete the play. The table uses an adaptive serpentine layout through all 28 tiles, with exact pips, reversed orientation on return rows and rotated doubles. Deal, draw, tile landing and public event toasts animate; a long hand can scroll horizontally without overflowing the page. The table is max 460 px and respects reduced motion.

Stable test selectors are `domino-tile-d_a_b`, `domino-left`, `domino-right`, `domino-draw` and `domino-pass` (all `data-testid`). Buttons still obey engine-derived availability.

From `platform/`:

```sh
npx tsx --test tests/darts-engine.test.mjs tests/domino-engine.test.mjs
node tests/darts-domino-ui.mjs
```

- [Rule TAP](rules-validation.tap): 15 domino and 15 darts tests.
- [Browser report](review/ui-validation.json), [QA notes](review/QA.md).
- [390 px table](review/domino-390-2p-before.png), [360 px four-player play](review/domino-360-4p-play.png), [28-tile chain](review/domino-390-long-chain.png).

The independent browser check uses actual engine inputs and a temporary loopback HTTP harness. It does not involve production funds or a partner wallet. It is desktop Chrome at mobile viewports, not physical Android/iOS or final WebView acceptance. Chinese is the complete rules/help locale; non-Chinese HUD strings and RTL direction support do not represent a reviewed Arabic translation.


Latest active-game visual restoration, generated asset provenance and isolated viewport evidence: [RESTORATION.md](RESTORATION.md).

## Fixed-view restoration V3

See [RESTORATION-V3.md](RESTORATION-V3.md) for independent asset layers, exact geometry boundaries, original source/prompts, screenshots and actual local-engine UI validation.
