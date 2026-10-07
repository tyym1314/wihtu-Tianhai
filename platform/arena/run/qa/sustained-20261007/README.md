# Run atlas upload long-frame investigation (2026-10-07)

This is isolated `reviewServer` + real RunGame/WebGL + authoritative Run engine, Chrome mobile emulation 390×844/DPR 3, Metal, CPU ×4. It is not physical iPhone Safari, public-host, wallet, or third-party launch acceptance.

## Cause and bounded change

The active 166.7 ms frame near 8 m and the first-hit 70–80 ms frame were inside `renderer.render`, not projection or React preparation. The [cold before GL trace](gl-dims-profile-raw.json) recorded three 1774×887 `texSubImage2D` uploads at about 56.6/59.1/53.9 ms when three ghost runners first entered the view, and a 1254×1254 action-atlas upload at about 74.5 ms on the first hit. The renderer's prior `compile` did not upload textures that had not yet been drawn.

The scene now calls Three's `renderer.initTexture` for scene-owned runner atlases one per loading frame, before scene-ready ACK and input unlock. This moves GPU upload work into visible loading while preserving independent runner UV offsets and the existing 100 ms HUD/input cadence. The [after 62-second GL trace](after-prewarm-memory-full-profile-raw.json) records no `texSubImage2D` calls after input was ready.

## Same-load results

| Probe | Active duration | Max RAF gap | Gaps >50 ms | Long Tasks | Real play |
| --- | ---: | ---: | ---: | ---: | --- |
| [Before, uninstrumented](baseline.json) | 62.1 s | 166.7 ms | 3 | 3 (max 166 ms) | 480 m, 1 hit, 18 actions |
| [After, uninstrumented](after-texture-prewarm.json) | 62.1 s | 16.8 ms | 0 | 0 | 474.1 m, 4 hits, 18 actions, finish window |
| [After, instrumented](after-prewarm-memory-full-profile.json) | 62.4 s | no >50 ms gap | 0 | 0 | 480 m finished, 2 hits, 18 actions |

The before first-hit action atlas upload was about 74.5 ms. The after profile saw real `hit` events at about 7.7 s and 57.9 s without active long tasks. The after instrumented first render took about 117 ms **during loading, before scene-ready and the 1.5 s countdown**; it is not an active-race frame. Loading work remains separately measured.

## Loading and GPU-resource boundary

For six cold **loopback** route entries, first rendered scene was observed at 1.43–1.80 s and first legal input at 3.085–3.312 s from browser navigation. The same baseline cold profile observed input at about 2.787 s, versus 3.117 s in the after 62-second profile, an approximately 330 ms loading tradeoff in those individual runs. This loopback measurement remains below the project's 5 s cold-entry gate but is not the controlled-network LOAD-01 result.

At the project's controlled 20 Mbps down / 5 Mbps up / 50 ms RTT and CPU ×4, two cold runs of the **unminified QA bundle** reached first input at [5.732 s](after-prewarm-wifi-profile.json) and [5.826 s](after-prewarm-wifi-waterfall-profile.json). The [resource waterfall](after-prewarm-wifi-waterfall-profile-raw.json) shows its 2.65 MB `/review.js` ending at 1.214 s and the 1.34 MB oasis-kit GLB ending at 3.032 s; local scene ACK was sent at 3.756 s and the shared 1.5 s countdown remains inside LOAD-01. Rebuilding the same isolated QA harness with minified JS reduced `/review.js` to 892 KB and [first input to 5.051 s](after-prewarm-wifi-minified-profile.json), still 51 ms above the 5 s gate in that single run. The actual Vite release splits and may compress JS differently; no public release or P95 claim follows from the harness. At least five independent cold starts are still needed to assess the P95 gate. **LOAD-01 remains unpassed.** Moving a required atlas upload into the active race merely to improve this number would reintroduce the proven stutter.

`renderer.info.memory.textures` stayed at **10** in every sample across the [after 62-second profile](after-prewarm-memory-full-profile.json); geometries increased from 21 to a bounded observed peak of 60 as course segments entered view. This is renderer object count, not byte-accurate iPhone GPU memory. Six separate route profiles reported 10 textures throughout their 12-second samples and no active >50 ms gap or Long Task. Route 3's initial autopilot avoided a beam; the [delayed-input rerun](route-3-first-hit-profile.json) produced a real hit without a long frame. The other routes produced a hit or fall in their own report: [0](route-0-after-prewarm-profile.json), [1](route-1-after-prewarm-profile.json), [2](route-2-after-prewarm-profile.json), [4](route-4-after-prewarm-profile.json), [5](route-5-after-prewarm-profile.json).

## Validation and limit

29 Run content/input/recovery/resource/atlas tests passed. The WebKit scene fault/cleanup test and Chrome WebGL atlas blend test passed. These results resolve the reproduced local atlas-upload stutters. The user's iPhone 15 Pro Safari report remains an open physical-device acceptance item, as do public-network LOAD-01 and production-host performance gates.
