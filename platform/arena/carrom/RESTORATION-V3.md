# Fixed-view restoration V3

Reference: `01-carrom.png` (PLAY and MOMENT).

Walnut frame and maple bed use nine-slice mapping to exact ±4.5 playing boundaries; four pockets and baselines remain code. Four original Blender lathed discs preserve physical radii, contact shadows, server collision paths and particle events.

Assets are independent material/body layers. All gameplay remains interactive. Original generated PNGs, exact structure guides, full imagegen prompts and original Blender meshes/scripts are preserved in `assets/v3/`; runtime uses the WebP delivery encodings. `assets/v3/provenance.json` records each original source and byte size.

Validation: Chrome mobile viewport emulation at360×800,390×844 and430×932; actual local engine actions, no platform API or wallet requests. Screenshots are under `review-v3/`. This is fixed-view raster/Canvas/SVG rendering, not free-camera realtime3D or native-device acceptance. Exact legal board topology takes priority over the concept's illustrative placements.

`node platform/arena/carrom/qa/visual-restoration.mjs`: touch aim, position/power, shot128 trajectory frames and collisions. `node platform/arena/carrom/qa/money-display.mjs`:38000→380 and10000→100, source room unchanged.

Test-harness fix: bundled SSR previews resolve source-relative asset URLs before CommonJS output. The amount/immutability assertions remain unchanged. Large background PNG data URIs exceeded browser CSS-variable size limits in an isolated preview; shipped WebP assets decode normally.

Short motion evidence: [`carrom-motion-390.webm`](review-v3/carrom-motion-390.webm). Captured from actual local-engine UI actions at390×844; known scenario fixtures are declared in `video-validation.json`, no platform wallet/settlement is represented.
