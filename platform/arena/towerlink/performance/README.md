# Tower Link rendering diagnostic — 2026-09-28

This is a bounded local diagnostic of the production Canvas renderer and WebP textures. It is **not** mobile-device, public-network, React UI, or production capacity acceptance. No public room or wallet was created.

## Confirmed visual-clock defect and fix

A stable RAF rate was hiding stopped game time. The old UI applied each clock correction by jumping its offset 16% toward the latest server timestamp. The renderer then clamped its time to the previous frame and the new authoritative `simulationAt`. A negative clock jump made the renderer wait for time to catch up; a newer snapshot ahead of the smoothed clock likewise advanced once and then held the same soldier position.

- An actual Canvas probe with a controlled 240 ms improvement in response time reproduced six identical soldier positions across consecutive requested frames: 100 ms of stopped motion. The new clock has zero held frames in the same probe. [Before](clock-before.json), [after](clock-after.json), [probe script](clock-probe.mjs).
- Replaying 49 real public WebKit response timestamps over approximately 33.3 seconds after the countdown produced eight inferred held frames (133 ms combined) and seven forward jumps greater than a normal frame plus 5 ms with the original algorithm. The fixed algorithm produced zero in both categories across four 60 Hz frame phases. This is a timing-model replay of measured network data, not a recording of the user phone. [Replay report](public-clock-replay.json), [script](replay-clocks.mjs).
- `presentation-clock.mjs` now absorbs offset error by running at 0.9–1.1× speed; it never rewinds game time. A snapshot ahead of the clock rebases once to its confirmed simulation time, then continues moving. A future `simulationAt` during countdown cannot advance past the actual server timestamp. Older timestamp responses cannot refresh the last receipt or reset the correction target.
- The production renderer still stops extrapolating at `serverAt + 1400 ms`; no server rules, outcomes, or authoritative packet counts changed. New authoritative snapshots can still reposition troops as required, so this removes clock-induced pauses rather than inventing unconfirmed motion.

## Projection allocation fix

`createTroopProjection().at()` previously cloned every troop and rebuilt its ID lookup on every render frame, although troop counts and visibility only change at departures, encounters, and arrivals. It now caches the last interval between these boundaries. The renderer still computes positions from its exact current clock every frame; art, frame rate, game rules, collision times, server authority and the 1,400 ms disconnection extrapolation limit are unchanged. Cache results are not mutated when seeking into another interval.

The fixture is the highest troop-count snapshot from a deterministic four-player engine/bot run: 13 towers, 42 troop packets, 15 routes. Desktop Chromium used a 390 × 844 viewport, DPR 3 (Canvas caps 2), and CDP 6× CPU slowdown. These settings do not emulate a real phone GPU, thermal behavior, or network.

| Measurement | Before | After |
| --- | ---: | ---: |
| Distinct returned troop objects in 30 frames / 500 ms | 1,119 | 186 |
| Distinct returned troop arrays in the same interval | 30 | 5 |
| Projection time for 30 frames, mean of 1,000 samples | 0.312 ms | 0.072 ms |
| Projection time for 30 frames, p95 | 1.40 ms | 0.60 ms |
| Actual Canvas callback p95 over 10 s | 2.30 ms | 2.10 ms |
| RAF interval p95 over 10 s | 33.4 ms | 16.8 ms |

Returned object churn fell by 83.4%. The exact total visible troop count across all samples is unchanged (1,119,000). The short before/after frame timing runs are noisy and are not evidence that the reported phone hitch is resolved. In particular, the after run contains a 24.8 ms maximum Canvas callback; browser/OS scheduling and full-page behavior still need investigation.

Raw results (including source hashes): [before.json](before.json), [after.json](after.json).

## Verification

- `node --test tests/towerlink.presentation.test.mjs arena/towerlink/performance/*.test.mjs`: 18 passed. Includes 60 seeded differential scenarios against authoritative road battles, exact contacts and arrivals, retained result immutability, backward projection seeking, monotonic clock correction, countdown, stale timestamps, and bounded disconnection recovery.
- `measure.mjs` imports the actual production renderer and all five decoded WebP assets. Both runs reported zero page errors.

Reproduce from `platform/` with a local Vite root serving this directory at `http://127.0.0.1:18126`, then run `node arena/towerlink/performance/measure.mjs measurement`. Set `TOWER_PERF_ORIGIN` to override the port. The script uses Playwright Chromium, a bounded 10-second renderer sample, and only its isolated local fixture. Compare the baseline source hash/diff to recreate the before version; the script does not rewrite application source.

## WebKit cross-check

Desktop Playwright WebKit 2359 at native CPU speed rendered the same production Canvas fixture at 600 frames per 10 seconds, both before and after the allocation fix. Callback p95 and max were 1 ms (timer resolution is coarse); RAF p95 was 18 ms, max 20 ms before / 19 ms after. Neither run had a frame above 33 ms or a page error. This does not reproduce a large-image `drawImage` CPU bottleneck on desktop WebKit, and does not substitute for iPhone 15 Pro Safari GPU/thermal testing. No speculative art downscaling was introduced. [Before](webkit-before.json), [after](webkit-after.json).

Use `TOWER_PERF_BROWSER=webkit` for the same fixture in WebKit. `TOWER_PERF_BASELINE_SOURCE=/absolute/path/to/original/troop-presentation.mjs` overrides only that module through a local test route to reproduce the original implementation without rewriting app files.

## Remaining leads for the full-page/public profiler

1. `tower-scene.js` clamps visual extrapolation to `serverAt + 1400 ms`. Production polling waits for each response and then another 500 ms. A sufficiently delayed response therefore deliberately freezes troops until a new snapshot arrives. This boundary must remain bounded; confirm request timing and clock plateaus before changing it. The measured public response sample did not establish that the disconnection limit was reached; the separately confirmed clock-correction defect above occurs without reaching it.
2. `TowerLinkGame.jsx` updates React state every 100 ms for clocks whose visible labels mostly change once a second, in addition to snapshot updates. Measure complete-page React commit/style/paint costs and synchronize visible clock transitions if material.
3. The five core WebP assets total approximately 1.8 MiB, and readiness waits for all five to decode. Measure real transfer, cache, connection and decode timing separately from play-loop frame timing.
4. Full-page CSS contains animated glow shadows and blur filters. Profile raster/compositor cost on a real phone before changing any visuals.
