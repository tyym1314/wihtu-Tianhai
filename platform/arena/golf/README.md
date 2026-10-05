# Oasis Golf — Phase C quality sample

`GolfGame.jsx` is the complete mobile game view. Import it as the default export and pass `{room, me, onAction, audio, onExit, locale}`. `room.game` is the engine view; `me` is the room-scoped external user key. Locales are `en`, `zh`, and `ar`. The parent handles room creation, invitation, ready/funding, genuine wallet settlement and the final result screen. The game provides its own full-height header, player HUD, live clocks, aim/power controls, sound switch and help. `onAction({type:'shot',angle,power})` returns a promise for `{room,event}`; only authoritative responses update scores and trajectories.

## Current nine-hole content

The current rule version is `pvp-golf-v1.1.0`, with `oasis-golf-islands-v2` / `oasis-golf-nine-holes-v1`. Each match pins three of nine physical layouts, one easy, one medium and one hard, on three distinct authored islands. See [content and compatibility](CONTENT-V1.1.md). Existing `pvp-golf-v1.0.0` rooms continue through the frozen legacy engine and geometry below.

## Frozen v1 rules reference

This implementation makes the approved `pvp-golf-v1.0.0` rules executable. Geometry is `oasis-golf-islands-v1`; physics is `oasis-golf-fixed120-v1`. These first-release constants are now the versioned boundary. A future layout, collision, friction, capture or timing change needs a new corresponding version and new replay fixtures.

- Three fixed continuous island courses, all shared by every player. V1 has no wind, moving collision obstacles or hidden random shot variance. The 256-bit server seed is validated; fixed V1 layouts do not consume randomness.
- Independent balls for 2–4 players. Their positions, strokes and trails are public; balls are ghosts and never affect another player's path, hole, score or collision outcome.
- The server accepts only `{type:'shot',angle,power}`. Angle is in radians, −π through +π, where zero points toward decreasing world Z. Power is a finite number from 0.02 through 1. Positions, scores and unknown action fields are rejected.
- Physics runs at exactly 120 Hz, rounds position/velocity to nine decimal places and samples a trajectory at 30 Hz. Maximum initial speed is 11.6 world units/second, friction deceleration is 1.8 and wall restitution is 0.68. There is no energy-adding force; a maximum-speed uncollided ball naturally stops in approximately 6.45 seconds, below the published eight-second simulation guard.
- Ball radius is 0.20 and wall half-width is 0.09 world units. The visible Three.js geometry uses these same exported dimensions. Curved course boundaries, wall openings, circular bumpers and cups are generated from the same `levels.mjs` data on client and server. Water hazards are actual openings, not arbitrary invisible hit regions.
- Cup capture requires center distance below 0.29 and speed no greater than 3.1. A too-fast ball can pass the cup. Low-power presentation has a minimum 160 ms busy interval; no second shot is accepted before the persisted `busyUntil`.
- An accepted shot adds one stroke immediately. Water/boundary exit adds one more at the simulated completion and returns the ball to that shot's starting point. A tenth shot that holes is ten; reaching ten strokes while unholed, including a water penalty, completes the hole as twelve.
- Each actionable shot gets 20 seconds, starting after the previous simulated motion ends. A timeout adds one stroke without moving the ball. A valid shot resets the consecutive timeout counter; three consecutive timeouts forfeit. Rendering, muted sound and faster devices cannot shorten the server busy interval.
- Each hole has a hard 90-second wall-clock cutoff. A shot accepted before the cutoff but not holed by it scores twelve; clients cannot finish an already-expired hole by completing an animation. All remaining players advance together after five seconds. There are exactly three holes.
- Total strokes rank ascending. Equal totals retain the same rank and winner eligibility. No user ID, arrival time or seat breaks a tie. Any payout rounding is the platform's frozen-seat rule, not part of game ranking.
- `forfeit(state, keys, now)` resolves already-completed physical results first, defers the terminal decision, then applies all same-tick forfeits before deciding once. A third shot timeout plus another player's simultaneous disconnect therefore voids if everybody forfeits. A third-hole score already fixed on that same tick stays eligible. A previously finished match is immutable.
- `phase:'fault'` / `fault.code:'PHYSICS_TIMEOUT'` means a shared platform fault, never a player loss. The wrapper owns the approved recovery/void process. `shiftTime(state,deltaMs)` shifts absolute clocks for a confirmed shared pause; it does not fabricate a recovered physics outcome.

Exports are `createState`, `act`, `tick`, `view`, `rank`, `forfeit`, `shiftTime`, and `botAction`. State is JSON-serializable and does not rely on a process cache. `act` and `tick` return `{state,event?}`; errors carry a `code` and HTTP-compatible `status`. Practice bots submit the same legal angle/power actions using only public geometry and their own current ball. They are marked BOT and are prohibited from paid rooms by the shared room wrapper.

## Current art build

The latest stone, foliage, water and lighting pass is [Natural light v2](ART-LIGHTING-V2-2026-09-20.md), including equal-camera before/after screenshots at 360 / 390 / 430 and real hole-in-one recordings.

The September 20 Blender, imagegen material, contact-AO and real-interaction update is documented in [ART-RESTORATION-2026-09-20.md](ART-RESTORATION-2026-09-20.md). It supersedes the earlier procedural-art description below. Editable `.blend`, compressed GLB, source PNG, runtime WebP and exact prompts are included.

## Reference and artwork

The reference is `output/design/pvp-arena-concepts-v1/03-golf.png`. This implementation uses the reference's turquoise water, gold sandstone islands, green raised fairways, palm/flower planting, gold ball, teal HUD and gold controls. The concept image is not used as a playable background or collision surface.

`scene.mjs` generates true Three.js geometry: bevelled raised islands, jointed stone facades, playable greens and rails, arched sandstone gateways with turquoise inlay, palm trunks/crowns, flower clusters, gold cup rims, flags and dimples on the golf balls. It uses procedural canvas material textures, real lights/shadows, a PMREM environment and animated water shaders. Flags and palm leaves move continuously; balls roll along server trajectories; the camera subtly follows the player's ball; hole capture creates a gold light column and particles. Other players use translucent ghost balls. The local player's ball is always gold regardless of randomized seat, matching the input hint and HUD.

This is an original executable 3D interpretation. Screenshots demonstrate its current appearance; they do not establish pixel equality to the painted concept or physical-device performance acceptance.

## Verification and private fixture

`node --test platform/tests/golf-engine.test.mjs` passes fourteen rule tests, including bounded deterministic physics, rejected inputs, busy guards, water penalty/reset, tenth-shot boundaries, 90-second cutoff, timeout batches, complete three-hole progression, tied ranks, JSON recovery, ghost independence and simultaneous disconnect/timeout priority. One test plays all three courses from the actual tees into the cups using only ordinary legal bot actions, with no position or score edits.

`qa/browser-report.json` records desktop Chrome mobile-viewport checks at 390×844 English, 360×800 Chinese, and 390×844 Arabic. All three courses rendered without page/asset errors, four ghost players and aim controls worked, and the first hole was played through the actual Shoot button to a one-stroke capture. The checked screenshots are in `qa/`. This browser fixture has no wallet and is not partner/payment acceptance. It does not claim physical iPhone/Android FPS, device thermals, accessible audio acceptance or native WebView checks.

For isolated visual review only, run from `platform/`:

```sh
node_modules/.bin/vite --config arena/golf/preview.vite.mjs
```

Open `http://127.0.0.1:18096/arena/golf/preview.html`. Optional `?hole=1&lang=zh` and `?hole=2&lang=ar` select **fixture** starting states for visual inspection; the production game does not accept these selectors. The review server uses `node_modules/.vite-golf-review` to avoid sharing dependency caches with the platform or arena server. Run `node platform/arena/golf/qa/smoke.mjs` from the repository root while that isolated review server is running. Shut the review server down after use.

## 2026-09-19 visual restoration

See [RESTORATION.md](RESTORATION.md) for the updated real geometry, camera, materials, exact local evidence and remaining reference gaps. Rules and authoritative physics were preserved.
