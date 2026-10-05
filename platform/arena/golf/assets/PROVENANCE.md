# Oasis Golf · original art production, 2026-09-20

The visual reference is `output/design/pvp-arena-concepts-v1/03-golf.png`. It is not used as the playable surface. The three authoritative fairways, cup locations, walls and hazards still come from `levels.mjs`; no engine/level/physics file was changed by this art pass.

## Native source and shipped assets

Blender **4.5.14 LTS**, executable `.tools/Blender.app/Contents/MacOS/Blender`, was actually run. `source/build.log` and `source/render.log` record execution. `source/build_oasis.py` builds three editable sandstone courses, recessed turquoise arch inlays, irregular garden banks, an eighteen-frond two-level palm crown, trunks/coconuts, ferns and pink/ivory flowers. `oasis-course-*-editable.blend` retains separate authored stones; the export `.blend` and GLB merge masonry by material. `oasis-botanical-library.blend` is the editable vegetation library. Runtime flower/fern instances share geometry. Draco compression is decoded locally; `draco/` was copied from pinned `three@0.180.0` and its Apache 2.0 license is included.

`source/render_result.py` runs actual Cycles rendering and contact-AO baking for all three fairways. `textures/course-*-contact-ao.*` uses a documented global world-coordinate UV atlas. `oasis-lighting-hole-*.blend` retains each bake setup. The text-free portrait result plate is `textures/oasis-result-environment.webp`; it has no UI, trophy or false interactive surface.

Procedural normal maps are numerical Blender material assets, not scanned measurements. Fine albedo textures below were made with the **built-in imagegen tool**, then copied into this workspace. Original PNGs are preserved; WebP files are optimized delivery copies. No image is an external publisher's game asset.

## Imagegen prompts and exact source artifacts

Generated-image session folder: `/Users/tyym/.codex/generated_images/01a0b48c-a11d-7cc0-8767-b1b8a14320e0`.

- `exec-282266d2-be12-4eb5-be4f-76c92fab6974.png` → `textures/putting-grass-imagegen.png`.
  Prompt: “Use case: photorealistic-natural. Asset type: seamless tileable PBR albedo texture for a premium mobile miniature golf green. Orthographic perfectly top-down flat square surface filling all edges: extremely dense finely cut natural putting turf, rich muted emerald and olive grass blades 2–4 mm, subtle mottled growth and tiny visible natural fibers, luxurious velvety grass, believable micro color variation at several scales. Soft uniform diffuse overcast lighting, NO directional shadows, no highlights, no horizon, no objects, no border, no lettering, no mowing stripes, no big clumps, no seams, no obvious repeating pattern. This is a MATERIAL TEXTURE, not a scene or game screenshot. Square 1024.”
- `exec-88e0ddc7-c759-4d31-a674-43686e2d886c.png` → `textures/aged-sandstone-imagegen.png`.
  Prompt: “Use case: photorealistic-natural. Asset type: seamless tileable PBR albedo material texture. Perfectly front-facing flat square filling all edges with sun-warm pale cream and honey sandstone, natural fine sand grains, fossil mineral flecks, slight eroded pores, delicate warm ochre veins and patches, realistic carved architectural limestone suitable for luxurious oasis island stonework. Seamless on all 4 edges. Flat diffuse light without directional shadows or highlights. No brick joints, no large cracks, no surrounding scene, no perspective, no text, no border. Fine detailed material, square 1024.”

## Reproduction

From repository root run Blender with `--background --python platform/arena/golf/assets/source/build_oasis.py`. Then run `render_result.py` with `OASIS_ART_HOLE=0`, `1`, `2`. Optimize textures with `node platform/arena/golf/assets/source/optimize-textures.mjs`. All resulting editable source, full-resolution PNGs, runtime WebP/GLB, and content hashes are under this owned directory.

## Shared original distant environment

`textures/oasis-distant-palace.webp` is a byte-for-byte copy of the root-created original `arena/run/assets/atlases/oasis-environment.webp` on 2026-09-20. The generating prompt/source record belongs to that shared Run atlas delivery. It is used only on a far scene plane at Z=-20, behind the full playable fairway and decorative garden islands. It supplies distant architecture and atmosphere, not balls, rails, greens, collision surfaces or UI. The water-edge alpha fade blends into the live reflecting water. All foreground planting and the entire playable course remain actual 3D meshes.

Exact shared source: `exec-c3736bc2-e237-43dc-88e9-90eb5382d3f5.png`, built-in image_gen. Prompt: “Portrait1024x1536 high detail distant environment only. Golden sunlight sandstone fantasy oasis palaces, carved arches, layered rocky islands, date palms, flowers, white waterfalls, distant golden domes. Camera3m over river slightly downward. Central lower half open turquoise water to receive realtime3D course. Buildings frame left/right and upperthird. Warm peach highlights, teal shadows, atmospheric depth. No game UI, no animals, no text, no central path or interactive bridge.”

## Natural light v2 continuation

The 2026-09-20 second pass reran `build_oasis.py` and all three Cycles AO bakes. Native stone meshes now use continuous weathered strata and rounded, subtly displaced individual facing blocks; the plant library uses nineteen cambered palm fronds (superseding the first pass eighteen-frond library). Runtime trailing ivy is original instanced geometry. `materials.mjs` supplies rotated dual texture sampling, macro variation, wet stone tint and approximate thin-leaf backlighting. No new imagegen image or third-party texture was introduced. Logs are `source/build-lighting-v2.log` and `source/ao-lighting-v2-hole1.log` through `hole3.log`; exact updated hashes are in `manifest.json`.
