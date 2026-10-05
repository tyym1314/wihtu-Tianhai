# Fixed-view restoration V3

Reference: `06-pool.png` (PLAY and MOMENT).

Walnut/cloth/cushion material uses nine-slice mapping to exact ±3.25×±6.5 boundaries. Six pockets, balls, cue, aiming and collision animation remain real Canvas primitives driven by unchanged physics.

Assets are independent material/body layers. All gameplay remains interactive. Original generated PNGs, exact structure guides, full imagegen prompts and original Blender meshes/scripts are preserved in `assets/v3/`; runtime uses the WebP delivery encodings. `assets/v3/provenance.json` records each original source and byte size.

Validation: Chrome mobile viewport emulation at360×800,390×844 and430×932; actual local engine actions, no platform API or wallet requests. Screenshots are under `review-v3/`. This is fixed-view raster/Canvas/SVG rendering, not free-camera realtime3D or native-device acceptance. Exact legal board topology takes priority over the concept's illustrative placements.

`node platform/arena/carrom/qa/visual-restoration.mjs`: touch called-pocket selection, actual eight-ball shot40 frames, pocket event at975ms and called-eight winner. `node --test platform/tests/pool-money-ui.test.mjs`:3 unchanged amount/practice assertions pass.

Test-harness fix: bundled SSR previews resolve source-relative asset URLs before CommonJS output. The amount/immutability assertions remain unchanged. Large background PNG data URIs exceeded browser CSS-variable size limits in an isolated preview; shipped WebP assets decode normally.

Short motion evidence: [`pool-motion-390.webm`](review-v3/pool-motion-390.webm). Captured from actual local-engine UI actions at390×844; known scenario fixtures are declared in `video-validation.json`, no platform wallet/settlement is represented.
