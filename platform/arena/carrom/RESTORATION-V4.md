# Carrom controls restoration V4

The reference is `output/design/pvp-arena-concepts-v1/01-carrom.png` (PLAY/MOMENT). This pass changes the lower control composition only: one deep emerald and gold AIM strip, a carved ivory striker on the position rail, a slim power rail, and a compact green strike button. The striker thumbnail reuses the original isolated `assets/v3/disc-striker.webp`; no new generated image or fake gameplay layer was added.

`CarromGame.jsx` and `controls-v4.css` preserve the original native range labels, bounds, steps, values and handlers. Canvas drag-to-place, tap-to-aim, aim nudges and the real shoot handler remain active. Range keyboard control and visible focus are retained. Engine, physics, geometry, rules and money handling are unchanged.

## Verification

Run the two isolated preview configurations in `carrom/preview.config.mjs` (18107) and `darts/preview.config.mjs` (18111), then:

```sh
node platform/arena/carrom/qa/visual-v4.mjs
node platform/arena/carrom/qa/money-display.mjs
```

The actual-engine Chrome test passes at 360×800, 390×844 and 430×932, with no document overflow, page errors or failed asset responses. It uses CDP touch events to drag the canvas striker, checks the native position slider's keyboard step and both aim-nudge buttons, then aims and shoots through the actual UI. Inputs are disabled while the real trajectory plays and reenabled afterward.

For reproducible pocket verification, the **local zero-value preview only** exposes `pocketFixture()`: it moves white coin `w0` to a clear legal corner-pocket line and keeps all nineteen original coins. No score or result is injected. A user shot with offset 1 and power 0.4 produces 46 real trajectory frames; the engine pockets `w0` into pocket 1 at 1167 ms, awards one retained coin, reports no foul and retains the player's turn. No platform or wallet requests are made.

`review-v4/ui-validation.json` records all three widths. Before/after screenshots are `carrom-before-{360,390,430}.png` and `carrom-after-{360,390,430}.png`; actual aim, movement, pocket and scored frames are alongside them. `review-v4/carrom-motion-390.webm` records the 390 px interaction.

The money SSR check still verifies 38000→380 and 10000→100, with the input room unchanged. This is desktop Chrome mobile emulation, not physical Android/iOS/WebView or production-wallet acceptance. It does not claim the entire design is pixel-identical.
