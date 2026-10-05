# Tower Link v2 production art

Created on 2026-09-27 against the approved `design/towerlink-v4` visual direction. The built-in ImageGen tool produced independent terrain, sky, barracks, citadel and soldier assets. Original PNGs and generation prompts are retained here as editable source material; runtime imports only the five WebP files listed in `manifest.json`.

The scene uses pre-rendered 3D art in a Canvas 2D scene, with DOM text and touch targets. It does not load Blender or a real-time 3D engine on the player's device. Buildings change sprite with their server-authoritative owner and completed level; soldiers follow authoritative route packets with continuous position interpolation and a four-pose walk cycle. Roads are drawn from the actual map edges, rather than painted into the island.

| Asset | Runtime bytes | Purpose |
| --- | ---: | --- |
| `sky-backdrop.webp` | 147760 | Portrait sky and distant scenery |
| `battlefield.webp` | 568568 | Transparent empty floating island |
| `barracks-atlas.webp` | 515886 | Neutral + four teams, three levels |
| `citadel.webp` | 269392 | Distinct central fortress |
| `soldiers-atlas.webp` | 410542 | Four teams, four walk poses |
| **Total** | **1912148** | About 1.82 MiB compressed core art |

Barracks rows are not uniformly spaced: use the measured `rowRects` in the manifest. The soldier atlas uses a regular 4 × 4 grid. Alpha channels were inspected; source art was compressed with `cwebp` without compositing the images into a single screenshot.

Core textures must all load and decode before room creation or ready is enabled. A failed load exposes a retry action. Terrain and roads are cached on a separate canvas; device pixel ratio is capped at 2, soldiers are grouped into labelled logical packets, and hidden pages skip painting. Reduced motion keeps state transitions and limits decorative animation. These controls bound rendering cost; they are not a claim of measured physical-phone frame rate.

The approved images are composition targets, not navigation meshes. Runtime layout uses fair map geometry and live server numbers, so it must not be described as a pixel-identical copy of one static battle snapshot. Visual and interaction evidence belongs in `review/towerlink-v2-ui`; phone and production acceptance remain separate gates.
