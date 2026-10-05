# Run bridge-depth visual review

This bounded pass changes only `arena/run/scene.mjs` in production. The reference is `output/design/pvp-arena-concepts-v1/10-run.png`: its bridge has readable stone thickness at missing sections, whereas the previous playable bridge exposed a thin slab edge.

## Change

- Existing authoritative `GAPS` now receive recessed sandstone end faces and side faces, assembled with rounded, instanced masonry blocks. The visible courses extend approximately 0.8 m downwards; the walkable surface and gap bounds remain unchanged.
- Existing original sandstone albedo and normal textures are reused. Backing faces are recessed so they do not clip through individual blocks.
- The character renderer receives `visualDistance` and `visualHeight` from the interpolated display pose. These are copied display fields; authoritative player state is unchanged. The atlas renderer and atlas assets are owned by the concurrent parent task and were not edited here.

## Before and after

| View | Before | After |
| --- | --- | --- |
| Full-width gap, 390 × 844 | [before](before-full-390.png) | [after](after-full-390.png) |
| Full-width gap, 360 × 844 | [before](before-full-360.png) | [after](after-full-360.png) |
| Partial-lane gap, 390 × 844 | [before](before-partial-390.png) | [after](after-partial-390.png) |
| Actual engine jump pose, 390 × 844 | [before](before-jump-390.png) | [after](after-jump-390.png) |

The jump view now exposes the far stone cut face and the partial-lane view exposes the surviving lane's side face. At the low, distant approach angle, the cut face still occludes much of the water. This pass improves bridge depth, but does not establish complete reference fidelity or optimal long-range hazard readability.

## Verification

- `node platform/arena/run/qa/bridge-review.mjs after`: all four character assets and the scene load, no page errors, and no horizontal overflow at 390/360 px. [Machine-readable result](after.json).
- The jump fixture is produced by the real engine's accepted jump action and tick: distance 84.8 m, height 1.1666667 m, inside the authoritative 84–87 m opening. This is a deterministic visual fixture, not a completed live race.
- `node --test tests/run-engine.test.mjs`: **27/27 pass**. [TAP](engine.tap).
- `npx vite build --config arena/vite.config.mjs --outDir /tmp/oasis-run-bridge-review`: **pass**. [Build log](build.txt).
- Engine and level file hashes still match `restoration-preserved-source.json`.

The screenshot harness deliberately freezes renderer extrapolation through an esbuild-only transform to compare the same engine snapshot. It does not poll, so the existing connection-delay notice in the screenshots is expected. These screenshots are not live-network, wallet, production, or device-WebView acceptance. No wallet, server, engine, level, shared component, or main platform file was modified.
