# Bowling mobile rendering revision

Implemented on 2026-10-09, following `ENGINE_AUDIT.md`. This is a visual/runtime
optimization. `constants.mjs`, `physics.mjs`, `engine.mjs`, scoring and input
validation are unchanged.

## Runtime resources

Blender 4.5.14 LTS derived new GLBs from the unchanged editable `.blend` files.
Original GLBs remain in the repository and retained public URLs must remain
available when building/releasing. `assets/source/build-mobile-lod.py` reproduces
the outputs; two executions produced identical GLB hashes. The manifest and
`assets/mobile-lod-report.json` record sizes, hashes and material counts.

| Asset | Original | New mobile | Change |
| --- | ---: | ---: | --- |
| Single pin triangles | 8,960 | 2,692 | -70.0% |
| Ball triangles | 9,626 | 3,656 | -62.0% |
| Ten pins + ball triangles | 99,226 | 30,576 | -69.2% |
| Pin GLB bytes | 17,856 | 10,520 | -41.1% |
| Ball GLB bytes | 204,732 | 22,196 | -89.2% |
| Venue + pin + ball GLB bytes | 433,848 | 243,976 | -43.8% |

The two red pin bands retain their original 256 triangles. Finger sockets remain
real recesses with a separate charcoal material. Two-way vertex-to-surface
sampling found maximum deviations of 0.463 mm for the pin and 0.345 mm for the
ball; this sampling is not a complete Hausdorff guarantee. The first browser
visual check covers the real approach and collision cameras.

The unused 161,036-byte original PNG is absent from both new ball models. The
desktop model retains all 9,626 triangles at 43,512 bytes. Both use the existing
external pearl-resin WebP, which was already replacing the embedded map before
rendering. Coarse-pointer/small-viewport clients load only mobile pin/ball models;
desktop clients retain the full pin and full-detail ball geometry.

## Secondary visual captures

The main scene, trajectory interpolation, input and camera continue at RAF
cadence. On mobile, planar reflection and the complete five-mip HDR Bloom
texture are refreshed at a nominal 30 Hz during motion/particles and 8 Hz when
idle. The current scene still receives the cached additive Bloom each display
frame. Reflection size, Bloom size/strength/radius/threshold, exposure and tone
mapping remain unchanged. Large camera changes bypass the interval; first
render, shot/input changes, resize and foreground resume invalidate it.

`cached-bloom.mjs` keeps Three r180's final additive stage. Resize clears the
cache. Screen or masked configurations use the upstream full pass. A future
Three upgrade must verify that this internal stage still matches upstream.
Desktop rendering uses full capture every frame.

## Verification and remaining acceptance

- 33/33 targeted Node checks passed: loader cancellation, secondary cadence,
  additive-cache behavior, derived GLB/source hashes/materials and existing
  authoritative Bowling engine/skill cases.
- Chrome/Metal at 390×844, DPR 3 loaded the real GLBs in two isolated contexts.
  The baseline context explicitly served original model bytes at candidate
  URLs; both contexts otherwise used the same current scene and materials.
  Each accepted exactly one legal pocket shot; mobile passed three remounts.
  Approach/rolling/collision screenshots retained the lane, neon, pin bands and
  ball holes without an obvious silhouette regression. These are short visual
  observations, not a blinded quality study or a full original-scene A/B.
- The existing desktop WebKit lifecycle fixture passed ten exits/remounts,
  hidden/foreground gates, partial-load failure, three construction failures,
  four loading/decode timeout cases and retry. After each exit, there were no
  remaining game RAFs, decoder workers, observers, blob URLs, live-context GL
  handles or cached-source listeners. The one remaining interval was the Vite
  baseline interval. The harness explicitly lost retired WebGL contexts.

Raw current artifacts are ignored under
`platform/review/bowling-mobile-20261009/`: `unit-tests.tap`, `visual-report.json`,
six A/B screenshots and `lifecycle/report.json`. The first execution of the
existing lifetime harness reused its former dated output directory; those
current outputs were copied into this current evidence directory and its
default output now points here. Do not treat that reused directory as fresh
evidence for the older release.

Root will run the coordinated longer paired benchmark separately. Public
network/cache acceptance, physical iPhone Safari GPU/temperature, repeated
complete games and motion quality remain separate release gates. Local RAF or
geometry savings alone do not establish that user-reported phone lag is fixed.
