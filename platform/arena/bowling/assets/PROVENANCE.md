# Neon Bowl · original art production, 2026-09-20

Reference: `output/design/pvp-arena-concepts-v1/07-bowling.png`. No reference image covers the playable lane. The lane, ball trajectory and pin poses are live Three.js meshes, following the existing authoritative engine and physics without changes.

Blender **4.5.14 LTS** was actually executed via the project `.tools` executable. `source/build_neon.py` generates the editable private venue, smooth closed-facing competition pins with visible red enamel neck bands, and a pearl-resin sphere with three actual boolean-cut finger sockets. Native sources are `neon-private-venue.blend`, `neon-competition-pin.blend`, `neon-pearl-ball.blend`; optimized GLBs are in `models/`. The venue is merged by material only for delivery. `source/render_result.py` uses actual Cycles lighting for the scene-only 768×1152 result plate `textures/neon-result-environment.webp`, retaining `neon-result-scene.blend`. Logs are in `source/`.

Draco decoder files came from the installed `three@0.180.0` package; its upstream Apache 2.0 license is included. Original imagegen outputs are copied into this workspace, with their source PNGs retained and optimized WebP delivery variants. These are original generated surfaces/artwork, not PG or another game's assets.

## Built-in imagegen prompts and provenance

Generated-image session folder: `/Users/tyym/.codex/generated_images/01a0b48c-a11d-7cc0-8767-b1b8a14320e0`.

- `exec-bb970771-4946-40b8-ae20-c6bd755f5e9d.png` → `textures/crown-wall-imagegen.png`.
  Prompt: “Use case: stylized-concept. Asset type: standalone emissive back-wall artwork for a luxury neon bowling lounge, not an entire room or game screen. Wide rectangular dark midnight-navy polished glass sign panel, beautiful thin electric-blue and royal-violet neon line art of a stylized 10-pin crown and one orb at center, elegant symmetrical art-deco stepped flourishes, luminous cobalt halos softly blooming onto the glass, tiny restrained gold highlights. Expensive cinematic nightclub art, realistic light spill and reflections, refined restrained composition. No words, no letters, no numbers, no interface, no actual physical lane, no people, no trophy, no frame outside image. Landscape 3:1. Dark outer edges for seamless blending onto a real 3D wall.”
- `exec-27b1d17a-e603-4621-ad15-18e413e187f5.png` → `textures/pearl-resin-imagegen.png`.
  Prompt: “Use case: stylized-concept. Asset type: seamless PBR albedo texture to wrap a real 3D bowling ball sphere. Fill square completely with luxurious deep royal-violet translucent pearl resin, glowing violet-blue marbled mineral swirls, fine hairline electric-lavender veins like a subtle constellation of connected light points. Rich dimensional iridescent resin microtexture, expensive sports ball finish. Pattern only, flat evenly lit square, no sphere pictured, no ball holes, no shadows, no specular highlights baked in, no objects, no text, no logo, no border. Dark purple base, luminous but restrained fine details. Seamless tileable 1024 square.”

Rebuild with Blender `--background --python platform/arena/bowling/assets/source/build_neon.py`, then `render_result.py`, then `node platform/arena/bowling/assets/source/optimize-textures.mjs`. `manifest.json` records artifact sizes and hashes.

## Venue revision 3 — real rebuild and localized glow

The project Blender executable was run again on 2026-09-20 with `build_neon.py`; `build-venue-v3.log` records the native build and three GLB exports. The venue now has a 2.92 m wall section, a modeled roof slab, repeating cross beams, continuous double coves and an inset rear sign recess. Ball radius (.215) and pin profile are unchanged; no authority geometry or simulation was edited. Exporting all objects regenerated ball bytes, so only dimensions/modeling code—not binary identity—are claimed preserved.

`scene.mjs` creates original GOOD PLAYERS / BRIGHTER TOMORROW small side-wall canvas signs; they are 3D-mounted local surfaces, not raster replacement rooms. It also creates narrow Gaussian alpha fixtures with instanced meshes. Final localized glow uses the existing bloom/output pipeline at strength .10, compared with rejected .30 over-blue trial. Native material tuning is applied in `art.mjs`. No new external artwork or image generation was used for this revision. `review/venue-v3` includes original before captures, final Metal screenshots/video, A/B/E inspection and genuine click-to-strike records.

## Mobile runtime derivation — 2026-10-09

`source/build-mobile-lod.py` was run with Blender 4.5.14 LTS from
`/Users/tyym/Applications/Blender.app/Contents/MacOS/Blender`, using
`--background --factory-startup --disable-autoexec`. It opens the original pin
and ball `.blend` files without saving over them. The source and original GLB
hashes remain unchanged. `mobile-lod-report.json` records the source/output
hashes, material triangle counts and exporter version.

The mobile pin has 2,692 triangles instead of 8,960; its two red neck bands retain
all 256 original triangles. The mobile ball has 3,656 triangles instead of 9,626,
with material boundaries preserving the charcoal recessed finger bores. Mobile
models are separate `*-mobile-v1.glb` URLs. The desktop ball retains its full
geometry in `neon-pearl-ball-runtime-v1.glb`. Both new ball variants omit the
embedded original 161,036-byte PNG because `art.mjs` replaces that map with the
unchanged pearl-resin WebP before presentation. Original models remain available
for rollback and editable art work. These visual exports do not change Cannon
colliders, scoring, trajectories, input limits or authoritative versions.

Run the derivation script using the same Blender version to reproduce the LODs.
The short A/B fixture is `qa/mobile-lod-review.mjs`; the full lifetime fixture is
`qa/lifecycle.mjs`. Raw current screenshots and resource observations are saved
under ignored `platform/review/bowling-mobile-20261009/` and are separate from
physical-phone acceptance.
