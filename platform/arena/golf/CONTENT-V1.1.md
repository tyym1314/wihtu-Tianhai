# Golf nine-hole content and compatibility

Current rules: `pvp-golf-v1.1.0`. Geometry/content versions: `oasis-golf-islands-v2` and `oasis-golf-nine-holes-v1`. Physics remains `oasis-golf-fixed120-v1`; the fixed-step simulation, walls, cups, capture speed, scoring, deadlines, tie handling and wallet contract are unchanged.

The server seed selects a permutation of the three authored islands. A match takes one easy hole, one medium hole and one hard hole, each on a different island. The three `holeIds` and content version are persisted at creation and exposed in the view. All players share them. Refreshes, recovery and subsequent actions never select a new layout. The UI shows the names/difficulties of all three holes and marks the active hole. There is no client override of course selection.

The nine holes have different physical tee positions and bumper layouts, not just names/colors. The original GLBs contain coastline/curbs/arches/decorative islands; they do not contain the tee, cup or cylindrical gameplay bumpers. `content.mjs` keeps the exact v1 polygon, wall openings, cup and bridge position of each base island. It changes the actual tee and the same bumper array used by both physics and `scene.mjs`. The matching art model/AO uses `artIndex`; round position no longer determines which mesh is displayed.

| ID | Name | Difficulty | Bumpers | Guide strokes | Repeated default strokes |
| --- | --- | --- | ---: | ---: | ---: |
| palm-golden-putt | 金杯短推 / Golden Putt | Easy | 1 | 1 | 12 |
| moon-last-bend | 月泉末弯 / Last Moon Bend | Easy | 1 | 2 | 8 |
| royal-approach | 王冠切入 / Royal Approach | Easy | 1 | 2 | 4 |
| palm-switchback | 棕榈折线 / Palm Switchback | Medium | 2 | 2 | 12 |
| moon-water-guard | 月泉护岸 / Moonwater Guard | Medium | 2 | 2 | 3 |
| royal-double-turn | 王冠双折 / Royal Double Turn | Medium | 2 | 2 | 9 |
| palm-slalom | 棕榈回旋 / Palm Slalom | Hard | 4 | 3 | 12 |
| moon-coast-route | 月泉险岸 / Moon Coast Route | Hard | 4 | 3 | 12 |
| royal-four-gates | 王冠四门 / Royal Four Gates | Hard | 4 | 3 | 6 |

These are deterministic examples, not claims of optimal scores or a statistical difficulty study. Guides aim with 0.01 radian and power 0.01 increments and use the ordinary authoritative `act` API. The comparison holds the initial cup-directed aim and power 0.58 unchanged for repeated shots, with ordinary water penalties and the ten-stroke limit. A twelve is the existing unholed limit score. Nothing changes the result after simulation, and there is no random punishment or assistance. The chosen guide actions and per-shot outcomes are in `qa/ordinary-shot-guides.json` and `review/deep-mobile-20260928/golf-content/solutions.json`.

## Historical state

`engine-v1.mjs` and `levels-v1.mjs` preserve the complete old implementation/data. `engine.mjs` dispatches all public state operations (`act`, `tick`, `view`, `rank`, `forfeit`, `shiftTime`, `botAction`) by the pinned rule version; `createState` honors an explicit old rule version. Unknown rules/content fail closed. The old accepted `pending` result/trajectory is never recomputed under new content. New states also retain accepted trajectories across JSON persistence. The content view resolver selects v1 geometry for historical snapshots, and art/preview fixtures explicitly pin v1 when they are testing the old artwork.

## Evidence and scope

`tests/golf-engine.test.mjs` retains all fourteen v1 regressions. `tests/golf-content.test.mjs` adds physical clearance/authored-geometry alignment, deterministic selection covering nine holes, complete accepted-action guide rounds, default-input contrast, practice-bot rounds, v1 operation parity, JSON recovery and unsupported-version rejection. Guides never edit ball positions or scores. The isolated `qa/content.jsx` browser fixture can start at a selected hole for visual review only; it does not establish full-round progression or expose a production selector.

New layouts reuse the same three GLBs/textures, preserving the complete-art loading gate and avoiding additional downloads at a timed hole transition. Current performance/visual evidence is desktop browser evidence. Physical iPhone acceptance and the complete mobile-quality-v1 cold/warm/weak-network/frame gate remain separately required.

Root integration fields: update the shared/catalog rule version to `pvp-golf-v1.1.0`, content version to `oasis-golf-nine-holes-v1`, level version to `oasis-golf-islands-v2`, retain physics version `oasis-golf-fixed120-v1`, and describe “9-hole pool; three seeded holes per match, one per difficulty; shared course plan; lower total strokes wins.” Existing rooms stay pinned to v1.
