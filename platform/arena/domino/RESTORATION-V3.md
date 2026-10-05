# Fixed-view restoration V3

Reference: `09-domino.png` (PLAY and MOMENT).

Brushed gold perimeter and woven blue felt are an empty material layer; tile chain, endpoints and pips remain actual SVG data. Original Blender ivory tile body is shared by hand, chain and flights. New independent night palace background replaces the previous flat environment. No domino/pips/UI are baked in any backdrop.

Assets are independent material/body layers. All gameplay remains interactive. Original generated PNGs, exact structure guides, full imagegen prompts and original Blender meshes/scripts are preserved in `assets/v3/`; runtime uses the WebP delivery encodings. `assets/v3/provenance.json` records each original source and byte size.

Validation: Chrome mobile viewport emulation at360×800,390×844 and430×932; actual local engine actions, no platform API or wallet requests. Screenshots are under `review-v3/`. This is fixed-view raster/Canvas/SVG rendering, not free-camera realtime3D or native-device acceptance. Exact legal board topology takes priority over the concept's illustrative placements.

`node platform/arena/ludo/review-restoration.mjs`: select legal tile→join endpoint→hand-to-chain flight. `review-restoration-events.mjs`: two-tile draw ends at first playable, hidden faces during flight,4-player Arabic layout360px. Original `platform/tests/darts-domino-ui.mjs` also checks all28 connected unique tiles and peer-event animation.

Test-harness fix: bundled SSR previews resolve source-relative asset URLs before CommonJS output. The amount/immutability assertions remain unchanged. Large background PNG data URIs exceeded browser CSS-variable size limits in an isolated preview; shipped WebP assets decode normally.

Short motion evidence: [`domino-motion-390.webm`](review-v3/domino-motion-390.webm). Captured from actual local-engine UI actions at390×844; known scenario fixtures are declared in `video-validation.json`, no platform wallet/settlement is represented.
