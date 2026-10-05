# Fixed-view restoration V3

Reference: `05-ludo.png` (PLAY and MOMENT).

Carved gold/jade board and jeweled bases sit beneath52 exact SVG path cells. Lower art is mirrored to preserve the existing engine color assignment (green southeast/gold southwest). Original Blender lacquer pawns keep legal selection/hit targets separate from alpha. Named LudoBoard export provides read-only final-state reuse. Dice is actual CSS3D geometry; captured sprites fly to actual player bases.

Assets are independent material/body layers. All gameplay remains interactive. Original generated PNGs, exact structure guides, full imagegen prompts and original Blender meshes/scripts are preserved in `assets/v3/`; runtime uses the WebP delivery encodings. `assets/v3/provenance.json` records each original source and byte size.

Validation: Chrome mobile viewport emulation at360×800,390×844 and430×932; actual local engine actions, no platform API or wallet requests. Screenshots are under `review-v3/`. This is fixed-view raster/Canvas/SVG rendering, not free-camera realtime3D or native-device acceptance. Exact legal board topology takes priority over the concept's illustrative placements.

`node platform/arena/ludo/review-restoration.mjs`: roll→legal pawn→move. `review-restoration-events.mjs`: two actual captured pieces return to bases with2 trails.

Test-harness fix: bundled SSR previews resolve source-relative asset URLs before CommonJS output. The amount/immutability assertions remain unchanged. Large background PNG data URIs exceeded browser CSS-variable size limits in an isolated preview; shipped WebP assets decode normally.

Short motion evidence: [`ludo-motion-390.webm`](review-v3/ludo-motion-390.webm). Captured from actual local-engine UI actions at390×844; known scenario fixtures are declared in `video-validation.json`, no platform wallet/settlement is represented.
