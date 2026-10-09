# 2D / board / probability scheduling changes

The server still owns all game rules, accepted inputs and results. These changes
reduce presentation work. They do not claim physical iPhone Safari acceptance.

* Darts, Ludo, Jackaroo, Pool and Carrom keep checking clocks at 50 ms intervals,
  but commit React state only when a displayed second, control expiry/busy gate,
  dice-roll gate or event visibility boundary changes. Gesture submission still
  reads its live clock, and background intervals still stop.
* Ludo's board is memoized with stable legal actions and callbacks. Equal small
  player snapshots keep their existing display reference; every JSON field is
  compared so protection, forfeit and metadata changes remain visible. Match
  gems and Domino tiles are memoized; equal Match boards do not submit a copied
  board, and equal Domino chains retain their cached layout. Jackaroo's legal
  split-seven plans remain complete.
* Darts records every gesture sample as before. Only the visual aim is coalesced
  to one React update per RAF. Its drag rect is reused until resize/scroll/blur,
  which cancel that drag. Release, capture loss, second finger and new-turn
  checks remain intact.
* Pool and Carrom cap unchanged waiting canvas draws at 20 Hz, preserving their
  slow environment/aim effects. Input changes, active drag, motion and recent
  collision effects draw on the next RAF. Authority trajectories are indexed
  once per shot; positions and trail ranges reuse objects. Pool delta rows stay
  expanded, while Carrom's full rows stay full. Physics inputs and pocket/scoring
  rules are unchanged.
* Tiger requests no animation frame while its particle canvas is empty. Bursts
  and coin rain share a 240-particle limit, compact live particles in place,
  wake one loop, and stop after expiry, hide or disposal. Reel timing, blur,
  win/respin artwork and result presentation remain present.
* Match's entrance waits for four critical images. The optional cheer atlas is
  requested with low priority after two RAF turns let the board paint, then
  fully decoded before use. A wave captures its ready status; a pending or failed preparation keeps
  the already-decoded idle mascot. Failed optional art can retry on a later
  accepted swap, without blocking it. Disposal cancels owned pending frame jobs
  and prevents a late decode from updating that component. The shared image URL
  cache, failure eviction and download/decode deadline are retained.

Relevant Node checks: `ui-clock-snapshot.test.mjs`,
`trajectory-view.test.mjs`, `canvas-wait-cadence.test.mjs`,
`image-preloader.test.mjs`, `match-art-preparation.test.mjs`, and root
`tests/tiger-effects.test.ts`. The canvas check runs actual engine-authored
shots with controlled clocks: waiting draws are bounded, aim wakes within the
idle interval, all sampled rolling RAFs draw, rows remain immutable, and
hide/resume/dispose leave one or zero loops as appropriate. Mocked canvas checks
are scheduling/semantic evidence, not GPU throughput.

Short browser checks use the real isolated HTTP engines with native Chrome
touch and desktop WebKit pointer/taps. `precision-touch-ui.mjs` covers exact
one-request legal Darts throws, moving dart tips independent of the HUD clock,
zero-request gesture cancellation, Pool free-ball placement/pocket calls,
Carrom aim recovery and help gates. `ludo-v1.1-ui.mjs` covers reveal, legal move,
early movement/timeout cancellation and legacy auto-pass. `match-art-browser.mjs`
deliberately holds/fails optional art, verifies first-swap idle fallback and
later prepared cheer, and binds component source hashes. Raw runs are under
the ignored `platform/review/ui-optimization-20261009/` tree.

Final short acceptance completed on 2026-10-09:

* `match-art-v1/report.json`: both held-art and failed-first-request cases pass.
  Each performs two accepted real-engine swaps with trusted native touch. The
  first successful wave uses the idle mascot; after decode or a later retry,
  the next swap uses cheer. The 15 bound executable/CSS dependencies are
  unchanged during the run, with zero page errors. Both browser and server close.
* `board-final/run.json`: all 12 Ludo/Jackaroo/Domino cases pass across desktop
  Chrome/WebKit at 390 and 360 CSS px. The original gesture and HTTP assertions
  remain intact; an ignored adapter binds the relevant board/shared/public
  source trees and fixture scripts, avoiding unrelated simultaneous Golf edits.
  All 249 declared inputs remain unchanged. Both engines retain all 916 legal
  Jackaroo actions while an 1150 ms clock-only sample adds zero board renders
  or effect derivations. Stacked Ludo choices, atomic 3+4 split captures, hand
  scrolling without selection, and accepted end placement pass. There are zero
  page/resource errors; the request ledger retains one explicitly drained
  WebKit polling cancellation. All contexts/browsers close and the fixture
  listener refuses connections after shutdown.
* The earlier `precision-check/run.json` passes all six Darts/Pool/Carrom
  Chrome/WebKit groups, with exact request counts and gesture cancel/recovery
  checks. `ludo-v11/ui.json` passes 14 reveal/early-event/cancellation cases
  before the final stable-action callback refinement, which the final board
  run exercises. Targeted platform Node checks pass 14/14; the existing dice
  presentation checks pass 3/3 and the Tiger lifecycle check passes 1/1.

Match's critical image list changes from 1,659,100 to 1,254,228 source-file bytes
(24.4% fewer bytes to prepare before entry); the 404,872-byte cheer file remains
available after the first board. This is a list/file-size comparison, not a
measurement of total encoded entry transfer. The final Match, Ludo, Jackaroo,
and Domino screenshots were inspected for preserved art and usable controls.

Remaining work: same-device complex-board/first-effect/sustained comparisons,
cool-down and warm-up conditions, iPhone long-play acceptance, and broader
runtime resource lifetime tests. No broad engine migration, shortened legal
option list, altered payout, shortened reel strip or removed win effect is
part of this change.
