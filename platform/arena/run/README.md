# Dune Dash · versioned mobile race

A Three.js desert race for 2, 3 or 4 players. Current rendering uses illustrated atlas characters on authoritative 3D trajectories, actual bridge gaps and Blender-authored environment prefabs. New matches use six authored courses in three challenge paces. See [2026-09-28 content evidence](qa/content-20260928/README.md) for current validation and its limits.

## Entry points

- `RunGame.jsx` — default `RunGame({room, me, onAction, audio, onExit, locale='zh'})`.
- `engine.mjs` — authoritative JSON-persistable rules, new-room version `pvp-run-v2.1.0` with server-armed scene readiness; pinned `pvp-run-v2.0.0` and complete `engine-v1.mjs` dispatch preserve old rooms.
- `courses.mjs` — immutable six-course catalogue, seed selection and pinned shared geometry resolver.
- `level.mjs` — preserved legacy public course `dune-oasis-480-v1.0.0`; physics `run-60hz-v1.0.0`.
- `scene.mjs` — Three scene, bounded snapshot extrapolation and effects.
- `characters.mjs` — default illustrated character factory, plus `createRigRunner` using GLTFLoader, cloned skins and AnimationMixer.
- `atlas-characters.mjs` — 4×4 RGBA sprite sheets driven by authoritative race action times; this is explicitly 2.5D art, not real-time strand fur.
- `RunPodium.jsx` — actual ranked animals with animated hand-attached trophies; root supplies result title and amounts.
- `assets/source/` — reproducible Blender authoring scripts; editable `.blend`, rigged `.glb`, packed albedo and manifests are in `assets/characters/` and `assets/environment/`.

The server owns 60 Hz simulation. Input is applied on the next server tick, never at a timestamp chosen by the browser. Physics has no `Date.now`, `Math.random`, process cache or browser dependency. All player positions and finishers for one tick are processed before deciding the winner. Saved finishers survive later exits. `forfeit(state, keys, now)` advances due physics before applying the entire exit roster, then judges once; no finish plus all forfeits is `outcome:'void'`.

V2 selects one of six authored 480 m courses from the server seed, then persists courseId/contentVersion/levelVersion. All players share that geometry and per-player item checkpoints. Rendering, collisions, bots and visible snapshots resolve that pinned definition. V1 remains on the original fixed course and ignores seed for geometry. The geometry is public; the raw room seed is never exposed.

## Action / engine contract

```js
{type: 'left' | 'right' | 'jump' | 'slide' | 'item', observed_tick?: 123}
```

`boost` and `shield` are optional strict aliases that require that exact held item. No client position, score, speed, execution time, item award, or result field is accepted. `observed_tick` can reject an observation older than two seconds or a future tick; it cannot rewind or choose execution time. At most one pending input and one input per 100 ms. All elapsed time comes from the caller's authoritative `now`.

Exports: `RULE_VERSION`, `supportsRuleVersion`, `createState(seedHex, now, {players, durationMs?, ruleVersion?})`, `act`, `tick`, `forfeit`, `shiftTime`, `rank`, `view`, `botAction`. Mutating methods return `{state,event?}`, except `shiftTime` returns state. Players have `{key,seatIndex,name,isBot,character?}`; 2–4 unique contiguous seats. Cosmetic selection never changes collision. The only accepted duration override is the unchanged 100000 ms cap. Explicit v1 construction and persisted v1 state always dispatch to the original engine; unknown versions fail.

`view` provides public player poses and current action timing, `snapshotTick`, `serverNow`, `startedAt`, `deadlineAt`, `ranks`, `events`, `visible` course section and physics/version identifiers. It excludes internal pending inputs. `rank.score` is **metres**; comparison uses integer centimetres. A falling player's ranked distance is the checkpoint to which they will recover.

## Rules implemented

- Three lanes x = −1.5 / 0 / +1.5 m. Speed 8 m/s, adjacent lane changes 200 ms; no lane re-entry during a transition. Lane change is allowed in flight.
- Jump 800 ms, fixed parabola with 1.2 m apex; no double jump.
- Approved V1 clarification: slide 600 ms while grounded; mutually exclusive with jump. Fixed red overhead beams require slide or lane change. Beam collision begins at 0.8 m and standing capsule is 1.45 m, slide capsule 0.55 m.
- A low obstacle collision stops movement 800 ms followed by 1 s collision immunity. Shield blocks one slowdown, expires after 8 s, and never prevents water falls.
- Water fall returns to the latest 30 m checkpoint after 1.5 s. Checkpoints lie on safe ground. No new input while falling or stunned.
- Each player independently encounters shield at 60 m, boost at 180 m, shield at 300 m. One inventory slot. A full slot skips the new item, permanently. Returning to a checkpoint cannot farm previously claimed items.
- Boost lasts 3 s at 1.2× speed, without stacking or altering collision/jump dimensions.
- Finish at 480 m; all first same-tick finishers share first. Later finishers never replace that winning set. At most 15 s followthrough, also bounded by the global 100 s maximum. Finished players rank by finish tick; others by net distance to centimetres, equal distances tie.
- Ghost racing: no player collisions. Opponents are rendered at their exact public positions; an opponent almost exactly overlapping the local character is hidden for readability, with their authoritative position still visible in the leaderboard. No artificial lane offset.
- Shared room backend, not this component, owns funding, fees, entry eligibility, human presence timeout, request id/sequence replay and settlement. The engine does not grant paid buffs or create bots. `botAction` returns ordinary legal actions for explicit free practice only.

## UI / synchronization

The component uses only the supplied `onAction`. Buttons, swipes and keyboard share one synchronous pending ref, so rapid events cannot create multiple in-flight commands. Duplicate taps during a request are ignored; the shell owns retrying an unconfirmed request with the same sequence. Hidden documents never send inputs. A state older than 1.8 s disables new actions rather than pretending to accept them.

The current integration uses serial HTTP polling at 150 ms for active run rooms, with GET/action advancing authoritative time. The visual renderer extrapolates the latest public movement and poses by at most 650 ms, and corrects toward the next snapshot. This is visual interpolation, not collision prediction or rollback. There is **no WebSocket implementation** in this module. The older runner spike remains untouched.

Stable QA selectors: `run-scene`, `run-track`, `run-left`, `run-right`, `run-jump`, `run-slide`, `run-item`, `run-clock`. Header first button exits, last toggles audio. Buttons are at least 44 px. Controls support actual touch swipes, pointer buttons and keyboard arrows/WASD-compatible A/D/S + space/up + E. English, Chinese and Arabic copy are present; physical left/right remain consistent under RTL.

Audio events use the shared `audio.play`: click, move, jump, slide, hit, water, shield, boost, ready, win. Mute calls the shared audio setter. The root audio module is responsible for actual audio playback/unlock.

## Verification

Run from `platform/`:

```sh
node --test tests/run-engine.test.mjs
node tests/run-ui.mjs
```

The engine suite covers fixed-step/poll-frequency equivalence, JSON replay, input tampering, delayed/stale inputs, exact action durations, swept obstacle collision, water recovery, checkpoint ranking, one-slot item behavior, all cosmetic trajectories, four same-tick finishes, saved results with batch exits, all-void and score units. A full legal bot drive completes the course.

The isolated UI test bundles on an ephemeral HTTP port using esbuild. It neither starts Vite nor touches shared ports, wallets, databases or their caches. It sends real HTTP actions into this engine and operates real mobile touch buttons plus a CDP touch swipe. It validates pending input serialization, four Three character instances, shield and boost activation, 390/360 viewport bounds, minimum hit targets, Arabic, mute, exit and zero JS errors.

Evidence: `review/ui-validation.json`; `review/run-390.png`, `run-360.png`, `run-jump-390.png`, `run-boost-390.png`, `run-ar-360.png`. Item and mid-course screenshots use explicitly positioned test fixtures; normal directional/jump/slide actions run against a real advancing engine. These are not wallet acceptance screenshots.

## Honest delivery boundary

This is a local, playable sample with actual original Blender source files, GLB armatures and ten authored animation clips per animal. The solid mesh characters still have a smooth toy-like surface, not the strand-fur cinematic finish of the concept. This is not a claim of pixel-identical design restoration or device-performance certification. Review runs use desktop Chrome software WebGL (SwiftShader) at mobile sizes. Real iOS/Android WebView GPU, thermal/FPS budgets, packet-loss behavior and scale/load acceptance remain platform-level follow-up gates. Parent integration supplies paid room/settlement evidence separately. Production remains governed by the platform's server-side lock.

## 2026-09-19 visual restoration

See [RESTORATION.md](RESTORATION.md) for the updated real geometry, camera, materials, exact local evidence and remaining reference gaps. Rules and authoritative physics were preserved.

## 2026-09-20 actual Blender pipeline

Official Blender 4.5.14 LTS was downloaded from the [Blender release directory](https://download.blender.org/release/Blender4.5/) into workspace `.tools/Blender.app`; its official SHA-256 was verified. No system installation/settings were changed. The asset manifest records the hash, file inventory and remaining visual gaps.

From the repository root:

```sh
.tools/Blender.app/Contents/MacOS/Blender -b --python platform/arena/run/assets/source/build_characters.py
.tools/Blender.app/Contents/MacOS/Blender -b --python platform/arena/run/assets/source/build_environment.py
```

Each of fox / black cat / bear / white rabbit has a 27-bone armature, UV albedo, PBR material, ten named clips and editable studio portrait lighting. The bridge support arches, pinnate date palms, rocky bank, palace and finish gate are a separate cosmetic GLB library. The real deck/gaps/obstacle positions still come exclusively from `level.mjs`. Animation does not change the collision capsule, race speed or score.

`RunPodium({players,meId})` uses actual `rank`, `seat_index` / `seatIndex`, and optional valid `character`. Rank-one ties each receive a cup. In the optional rig path, the rig is cloned per actor and a geometric cup can follow the actual hand bone. The default high-detail result uses the correct animal’s illustrated cup pose; its trophy is part of that cutout. `prefers-reduced-motion` fixes a composed pose and static confetti. The active scene uses a 1.2-second orbit after the authoritative finish and holds the front view; the root shell uses a separate presentation tail.

From `platform/`:

```sh
node arena/run/qa/rig-review.mjs
node arena/run/qa/root-podium-review.mjs # root visual preview must already be on 18112; no wallets
```

Evidence: [rig validation](qa/rig-validation.json), [root podium validation](qa/root-podium-validation.json), [10-clip/podium video](qa/video/blender-clips-podium.webm), [engine touch/finish video](qa/video/engine-actions-finish.webm). Clip review samples actual bone matrices at 0.11 and 0.26 seconds using a controlled presentation clock. The advancing-engine test uses real touch events, then explicitly injected near-finish positions to avoid recording a full minute. These are disclosed fixtures, not external gameplay or wallet acceptance.

Remaining differences: no strand fur or cinematic facial blendshapes; four animals still use a stylized solid sculpt. The environment has modeled modules and shader water, but cliff composition, foliage density and waterfall shading differ from the illustration. Fixed-angle high-detail character art can improve likeness while these GLBs remain an editable 3D foundation. Mobile texture/mesh budget, actual WebView performance, GPU memory and thermal behavior have not been certified.

## Current default: high-detail character art + actual 3D course

The visual review found that the new solid Blender rigs still looked like smooth toys beside the concept. The delivered default therefore uses three original image-generated transparent sheets supplied by the parent production task: `assets/atlases/run-back.png`, `action-back.png`, and `front-win.png`. Their 1254×1254 RGBA originals are retained. Corresponding WebP files are encoding-only derivatives, quality 94, no repainting or geometry image substitution. Each sheet has four rows (fox, black cat, bear, rabbit) and four columns.

- Rear run: four running key poses, with small presentation-only bob/roll between frames.
- Rear action: jump, slide, hit, fall; land/recover transition back to rear running.
- Front: finish, raised cup, held cup, neutral pose. The winner’s cup alternates between two authored views.

Sprites occupy the authoritative world coordinates, use perspective and depth testing against the actual course, and retain the same collision/score rules. The character itself is fixed-angle art; it is **not** a freely rotatable high-detail 3D animal. The original 27-bone GLBs and ten actual clips remain available through `createRigRunner()` or `createRunner(kind, ghost, {renderer:'rig'})`. Both paths are tested separately.

This choice closes much of the fur/face likeness gap, but four-frame rear running and two-pose celebration are not equivalent to a fully authored high-frame-count character animation set. Additional in-between frames, custom facial animation, stronger water/vegetation treatment and real-device performance review are still required before claiming complete visual parity.

The distant `oasis-environment.webp` plate contains only palace / foliage / water scenery; no characters, UI, race deck, collision gaps or obstacles are painted into it. It uses small cosmetic parallax. The world-positioned deck, bridges, finish architecture, near palms/banks, obstacles and item geometry remain real meshes. A translucent animated water layer retains the geometric gap boundary. Near stone uses the shared original `../golf/assets/textures/aged-sandstone-imagegen.webp` and its procedural normal map; provenance is recorded in Golf `assets/PROVENANCE.md`.

The latest default-render evidence is [atlas-validation.json](qa/atlas-validation.json), [390 active scene](qa/atlas-race-390.png), [360 active scene](qa/atlas-race-360.png), [front finish](qa/atlas-finish-360.png), and [recorded live actions](qa/video/atlas-race-actions-finish.webm). This review samples the real sprite material UV offsets, checks their changes during a running authoritative engine, sends a real jump touch and observes the action-sheet switch, then verifies the accepted finish switches to the front sheet.

The shield UI regression test was hardened against a genuine wall-clock race: in slow software WebGL, a player could already have reached the next crate and correctly consumed the shield before the old assertion read it. It now proves activation from the actual HTTP action response in a safe lane, then positions the isolated fixture at two real colliders: exactly one shield block on the first, ordinary hit on the second. The unmodified rules remain the authority. Diagnostic evidence is `qa/control-timing-diagnostic.json`.

Both the finishing presentation and podium use the server’s actual ranking for trophy eligibility: only rank-one animals show the cup. Other finished animals show the neutral front pose. Presentation adds no result/score fields to server state.
