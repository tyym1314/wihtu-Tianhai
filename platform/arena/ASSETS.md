# Arena artwork and motion

Generated in this task with the built-in `image_gen` tool, not the CLI. These are original OASIS artwork assets, not extracted commercial game assets.

## Final assets

- `public/assets/fox-mascot.png`: original transparent RGBA baby fennec character, 1024×1536. Verified real alpha; 781543 fully transparent pixels. Rendered with layered CSS motion, not a skeletal 3D character.
- `public/assets/match-palace.png`: original purple palace environment, 1024×1536.
- Match jewels: code-native SVG facets and gradients in `match/Gem.jsx`, actual 36 interactive cells and server event animation.
- Golf: procedural Three.js geometry, lighting, water, palms, flag, ball and effects; renderer and authoritative engine share `golf/levels.mjs`.
- Sound: gesture-unlocked procedural WebAudio music and bounded event voices in `shared/audio.mjs`; no external media/CDN.

## Image generation prompt record

1. Original baby fennec fox, beige and cream fur, giant soft ears, purple velvet waistcoat with tasteful gold embroidery, full body front three-quarter view, standing with small paws held out, joyful expressive face, premium stylized cinematic 3D mobile game character, coherent luxury purple-and-gold oasis palette. Transparent PNG cutout, no text, no UI, no environment.
2. Edit the generated fox while preserving the exact character: remove ALL background and atmosphere, transparent RGBA around the silhouette, clean fur cutout edges. Final source: `/Users/tyym/.codex/generated_images/01a0afe3-5361-7781-9edd-5a548a4a4fa0/exec-239fcd54-a379-4312-bb9f-214934ae01bd.png`.
3. Original luxury violet and indigo oasis palace environment, ornate pointed arches and gold lanterns, distant domes and palms in purple twilight, cinematic soft light; quiet dark lower two thirds for a real interactive game board. No characters, UI, words or logos. Final source: `/Users/tyym/.codex/generated_images/01a0afe3-5361-7781-9edd-5a548a4a4fa0/exec-e164eb99-9327-4c7d-8c7c-44044c24d889.png`.

The approved concept sheets remain visual references. Gameplay is rendered and interactive; the concept sheet is not used as a flattened game interface. True device performance and art-direction acceptance remain separate checks.

## Phase D table games (2026-09-19)

Carrom adds the original emerald palace illustration documented in `carrom/README.md`; the delivered WebP is a format-only conversion of its preserved PNG. Carrom board/coins are interactive Canvas geometry, and the other four games use code-native layered SVG/CSS boards, darts, tiles, dice and cards. Lobbies use `shared/LobbyArt.jsx`; original concept sheets remain comparison references. Each game has a README with rule, asset and independent QA details. Actual platform screenshots and motion clips are in `../review/phase-d/`, with reviewed media copied to `../public/previews/` for the management gallery. Playwright videos do not contain audio; WebAudio signal/mute is verified separately in the platform UI report.

## Phase E sports and racing (2026-09-19)

- Pool: original Canvas geometry for the six-pocket table, cushions, balls, cue, aiming guide and particles. The scene is a 2.5D presentation of authoritative planar physics, not a Three.js scene.
- Bowling: original procedural Three.js lane, ball and pins. The server uses cannon-es rigid bodies at 60 Hz with a 20 Hz sparse replay; the client interpolates server trajectories for ball and pin motion. No prerendered strike animation decides scores.
- Run: original procedural Three.js desert track, palms, scenery and four articulated cartoon characters. Running, jumping, sliding, lane changes, pickups and finish effects are rendered from server state. The course is shared with the 60 Hz engine.
- New lobby illustrations are original code-native SVG in `shared/LobbyArt.jsx`. Each game uses its own WebAudio music phrase and event sounds; no commercial soundtrack or remote asset host is required.

Three.js and cannon-es are MIT licensed. Preserved notices are served as `/licenses/three.txt` and `/licenses/cannon-es.txt` from `platform/public/licenses/`. Per-game READMEs document implementation details and independent QA. Platform captures live in `../review/phase-e/`; approved concept sheets are retained separately for comparison. Browser-sized mobile validation does not establish physical-device performance or final art-direction acceptance.
