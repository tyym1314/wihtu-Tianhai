# Bowling loading and partial initialization repair — 2026-09-28

Ownership: `art.mjs`, `scene.mjs`, `BowlingGame.jsx`, `qa/lifecycle*`. No rules, collision, artwork dimensions, texture quality, view framing or controls were changed.

## Final behavior

- `preloadBowlingAssets({signal})` / `preloadNeonArt({signal})` and `loadNeonArt({signal})` accept an AbortSignal. Pending callers share one source generation. Cancelling one caller keeps the others alive; cancelling the last retires the generation. A failed old generation cannot clear a newer generation's cache.
- Each generation has a **20,000 ms** deadline covering model fetch, Draco library fetch/decode, image fetch and image decode. Timeout/failure aborts owned fetches, rejects pending Draco callbacks, terminates workers, cancels Image handlers and revokes object URLs. Late scenes are disposed. A guarded decoder completion cannot create a worker after retirement.
- Images use abortable fetch → Blob → a unique object URL → Image.decode. `image.src=''` alone can allow WebKit to join a prior hanging request; this implementation owns the fetch and releases the temporary URL after success/abort.
- The Three r180 decoder adapter intentionally touches `_loadLibrary`, `decoderPending` and pending worker callbacks because Three has no public pending-decode cancellation API. Version upgrades must run the late-decoder tests. It bypasses FileLoader's global pending-URL sharing for decoder libraries.
- Scene initialization registers cleanup immediately after each allocation. PMREM, postprocessing, observer and later construction errors use the same idempotent reverse cleanup, then rethrow the original error. Renderer cleanup always attempts `dispose`, `forceContextLoss` and canvas removal, even if another cleanup throws. First-frame/render errors also stop rendering and report failure.
- The component exposes a Retry loading button, keeps input disabled until the complete scene has rendered, and aborts its consumer when unmounted. Obsolete effect rejection cannot dispose a newer mounted scene. Existing hidden-page RAF and presentation timer behavior is retained.

## Verification

```sh
node --test arena/bowling/qa/lifecycle-loader.test.mjs
node arena/bowling/qa/lifecycle.mjs
```

Three deterministic loader tests pass: deadline aborts owned model/decoder requests and a hanging image decode; retry uses a new generation; one consumer cannot cancel another; final cancellation aborts; pre-aborted callers issue no requests.

Desktop WebKit evidence: `review/deep-mobile-20260928/bowling-lifecycle/report.json` has `passed: true`, `errors: []`, `serviceClosed: true`.

- Partial model failure disables input, leaves no canvas or decoder, and the same-page Retry button successfully prepares/render-enables the authored lane.
- Ten complete exit/remount cycles return RAF, worker, ResizeObserver, object-URL, live-context GL-handle and cached-source-listener counts to zero. One interval is Vite's pre-existing baseline. All retired scene contexts are actually lost.
- Injected failures in PMREM generation, composer setup and ResizeObserver observation each leave zero scene resources and a lost context; each subsequent same-page Retry succeeds.
- Model, decoder, image-fetch and image-decode fault cases use independent source factories with a **600 ms test deadline**. Fetch fault injection holds delivery of a completed fetch result; image-decode injection holds its completion. The next generation succeeds **before** old completion is released, and releasing it adds no worker. This is adversarial asynchronous-completion testing, not a measurement of server socket cancellation latency. Native abort-signal ownership is additionally checked by deterministic tests.
- Synthetic `document.hidden`/visibilitychange checks show RAF 0 and only baseline interval 1 while hidden; visible resumes RAF 1 and the one component interval. This verifies the visibility gate, not physical iOS background scheduling.

`complete-lane.png` was inspected after the Blob image path change; the complete venue, lane, ball and pins render. Individual WebGL handles not explicitly deleted before context loss remain recorded (e.g. buffer 1, texture 4, program 1, framebuffer 3). Context loss releases the retired context; this report does **not** claim every handle was individually deleted or prove JS heap collection. No physical iPhone, long-run frame, server capacity or user-experience acceptance is inferred.
