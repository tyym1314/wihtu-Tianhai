# Run bounded loading and scene lifecycle — 2026-09-28

This narrow follow-up leaves engines, course data, obstacle rules and collision unchanged. Final artwork imports use the root-approved files in `../../assets/mobile-atlases.json` and `../../../../review/deep-mobile-20260928/texture-round2/adopted-assets.json`. The six atlases retain their exact dimensions, alpha and frame grid; the distant backdrop uses the approved 768×1152 image, and sandstone uses the approved 768×768 q76 image. UVs, map ratios, normal maps and scene geometry are unchanged. Visual comparisons and encoding provenance are recorded by the artwork reviewer in the texture-round2 report.

## Code boundaries

`preloadRunAssets(kinds, {signal})` remains roster-selective. Each texture/kit has a 20,000 ms source-generation deadline covering native fetch and decode. Failed generations are evicted; the last cancelled consumer aborts its source after a microtask handoff check, while other consumers remain valid. A same-turn 2→4 roster change reuses common pending sources; the cancelled caller still rejects immediately. Aggregate failure cancels only its own consumers. Late returned source objects are disposed and cannot clear a newer cache.

Texture fetching uses `mode: 'no-cors', credentials: 'include'` for same-origin assets. Fetch cancellation owns the download; a unique Blob URL owns image decoding and is revoked after success/abort. Real WebKit proved that matching request mode alone does **not** merge native fetch and CSS/image cache entries: the direct-image control transferred front twice (390,330 B each with final art). Production portraits now share one DOM Blob URL lease from the same downloaded front source; existing CSS crop, display size and source pixels are unchanged. This lease stays valid while mounted and is revoked on retry/unmount. Only the front source retains its compressed Blob (one fixed cache entry); other temporary decode URLs are immediately revoked. Cached CPU artwork is intentionally retained, but scenes clone GPU objects and never attach renderer listeners to cached source objects.

The scenery GLB embeds geometry only: no Draco, image or external-buffer requests. Native abortable fetch feeds `GLTFLoader.parseAsync`; aborts before/after parse and failed map dependencies release partial model geometry/materials. Shared sandstone maps remain CPU-source cache objects and each scene clones its GPU resources. A schema test rejects future GLB changes that violate this assumption. The optional historical rig-review renderer is not used by the production Run preload or scene.

The scene registers resource cleanup as construction advances. Synchronous initialization throws unwind partial resources and rethrow the original error; asset, compile, render and context-loss errors stop rendering and dispose before notifying the component. Exit cancels the scene's pending consumers. The failure overlay has a same-page scene retry button; it does not recreate a room or alter authoritative state, and input still waits for the new rendered scene and a later authoritative snapshot. Document visibility stops RAF while hidden and resumes from the actual snapshot clock; authoritative game time and the 650 ms projection bound remain unchanged.

## Commands and evidence

```sh
node --test arena/run/qa/asset-loading.test.mjs arena/run/qa/asset-selection.test.mjs tests/run-static-batches.test.mjs tests/run-scene-resources.test.mjs tests/run-presentation.test.mjs tests/run-input-readiness.test.mjs
node arena/run/qa/asset-lifecycle-review.mjs
node arena/run/qa/atlas-transfer-review.mjs
node arena/run/qa/compilation-lifecycle-review.mjs
node tests/run-lifecycle-ui.mjs
node arena/run/qa/scene-retry-review.mjs
node arena/run/qa/lobby-roster-review.mjs
```

Offline: 21 tests pass, including pending 2→4 handoff, bounded-generation/cancellation/late cleanup, request-mode/decode cleanup, selected roster, GLB schema, clone ownership, snapshot and input gates pass. Product bundle compiles.

Completed desktop WebKit checks (all page-error lists empty; all browser/server instances closed):

- `assets-webkit.json`: 8 cases. Direct fetch/image control transfers front twice; the production portrait lease transfers it once. Pending 2→4 API handoff transfers each of 6 atlas entities once. Model, backdrop, atlas and exit cases hold an actual native HTTP response before headers/body: the old request closes aborted, and retry succeeds **before** the old response is released. Hung image decode also times out and late completion leaves zero decode URLs. Tests shorten the production 20 s timer to 700 ms only in the fixture.
- `../performance-20260928/compilation-lifecycle.json`: 7 cases. Injected PMREM, observer setup, compile and render throws each retain the original error and finish with RAF 0, observer 0, live contexts 0, Blob URLs 0 and canvas 0. Exit while loading and exit immediately after compile also clean up. Normal readiness fires only after the first real render.
- `../content-20260928/lifecycle-webkit.json`: 10 mount/unmount cycles each return to baseline RAF 0 / Vite interval 1 / observers 0 / workers 0 / canvases 0 / live contexts 0. Cached source dispose listeners remain 0. All 10 contexts report `isContextLost()`. Synthetic hidden/visible transitions stop RAF (0) and resume (1); this is a visibility-event logic test, not OS backgrounding.
- `scene-retry-webkit.json`: actual RunGame first-render failure removes its context and keeps controls disabled. The 144×44 retry button receives a touch tap; a second scene renders, a later engine snapshot re-enables input, and a jump is accepted exactly once (`inputNo: 1`) in the same fixture room. After unmount, canvas / live contexts / Blob URLs are 0; front is transferred exactly once across both attempts. Failure/recovery screenshots were inspected.
- `../performance-20260928/atlas-transfer.json`: controlled historical all-four/anonymous-CORS loader compared with selected-roster/Blob-lease loader. With the then-current image bytes, two-player image traffic is 2,723,410→1,626,738 B. A completed 2→4 expansion adds only bear/rabbit. This does not substitute for final production compressed-resource budgets.

`lobby-roster-webkit.json` also covers the actual main entry after the root's resolved-module cache fix. The temporary production build differs only by exposing a test-only React root-unmount hook; host exchange/session use the real isolated API. While the native Response delivery is suspended after headers, tapping the actual 4-player lobby choice keeps the original 4 sources alive, adds only bear/rabbit, and keeps the practice button disabled. Each of the 6 native fetches occurs once; release enables preparation. True React root unmount cancels all 4 pending sources in a fresh context. This async-delivery boundary is explicitly distinguished from the separate real held-server-response tests above. `lobby-harness.json` confirms API/process/HTTP cleanup, dropped isolated database, removed private directory and completed session audit. No room or wager was created.

The 8-case asset suite and actual component retry screenshot/transfer check were rerun after the final artwork URL switch. The earlier scene fault/ten-remount evidence uses the same final lifecycle implementation before that import-only artwork change. Final public 2/4-player loading budgets remain the root's separate acceptance step.

These checks do not measure JS heap collection, physical iPhone behavior, controlled 60-second FPS, or full public acceptance. Undeleted Three.js internal handles at context loss are recorded separately (Buffer 1 / Texture 4 / Framebuffer 3 / Shader 4); they are not mislabeled as explicit delete calls. The actual GL contexts are lost after cleanup.
