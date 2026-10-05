# Darts ready-pose restoration V4

The reference is `output/design/pvp-arena-concepts-v1/04-darts.png` (PLAY/MOMENT). The former small side-view ready dart has been replaced with a larger first-person perspective: the three-fold blue-and-gold flight is near the camera, with the metal grip and tip receding toward the target. A separate curved cyan gesture guide sits behind it. The ready pose breathes gently and disappears during the actual throw and impact.

## Asset provenance and anchor boundary

`assets/v4/render-held-dart.py` opens the existing authored `assets/v3/metal-dart-source.blend`, adjusts the perspective camera and lights, and frames the complete mesh without cropping. The output is a transparent 720×640 image, `held-dart.png`, with the reproducible scene in `held-dart-source.blend` and camera metadata in `provenance.json`. Blender renders the original geometry; this pass uses no image-generation prompt. Delivery is the 24 KB `held-dart.webp`, encoded at original size with `cwebp -q 94 -alpha_q 100`.

The new image is **ready-only**. `DartsGame.jsx` and `ready-v4.css` never use its visual origin as a hit coordinate. Existing `DartVisuals.jsx`, authoritative `event.hit.x/y`, the tip-anchored flight sprite, the 650 ms event duration and embedded darts remain unchanged. The input gesture, scoring engine and money handling are unchanged.

To rebake:

```sh
.tools/Blender.app/Contents/MacOS/Blender --background --python platform/arena/darts/assets/v4/render-held-dart.py
cwebp -q 94 -alpha_q 100 platform/arena/darts/assets/v4/held-dart.png -o platform/arena/darts/assets/v4/held-dart.webp
```

## Verification

With the Carrom and Darts isolated preview Vites on 18107 and 18111, run `node platform/arena/carrom/qa/visual-v4.mjs`. All three sizes (360×800, 390×844, 430×932) pass without overflow, page errors or failed assets.

The test uses CDP touchStart/move/end on the real board. All sizes register a real off-center 18-point hit, update 301→283, and verify that flight targets and landed tip coordinates exactly equal the engine's hit. Flight lasts 650 ms; the ready image hides during flight and returns after impact. Tests also check that the full 720 px source decodes and the near-camera pose stays larger than 140×130 CSS pixels.

See `review-v4/ui-validation.json`, the paired `darts-before-{360,390,430}.png` / `darts-after-{360,390,430}.png`, the actual flight/hit screenshots and `review-v4/darts-motion-390.webm`. These are isolated local-engine Chrome mobile-emulation recordings, with no platform or wallet requests. They are not native-device or production acceptance and do not claim complete pixel-identical restoration.
