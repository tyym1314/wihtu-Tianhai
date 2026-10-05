# Run v4 motion QA

This pass modifies only files under `arena/run/qa/`. It bundles the current production renderer, characters and engine into an isolated local HTTP server on a random loopback port. It does not contact the platform API, PostgreSQL or a wallet.

## Complete motion check: passed

Run from `platform/`:

```sh
node arena/run/qa/motion-v4-review.mjs
```

[Machine-readable report](report.json) records:

- All four characters load their individual v4 WebP sheets. Each character samples all **8 actual SpriteMaterial UV offsets**, with the expected 4 × 2 layout and half-texel inset.
- Each character advances through multiple actual texture frames within one unchanged HTTP `snapshotTick` and authoritative distance. Its projected display distance continues moving. The harness polls every 150 ms.
- A real Chrome touch swipe produces an HTTP `input_accepted` response, an engine `jump` event with the same input number, and actual `jump → land → run` render samples. A downward touch swipe similarly produces an accepted slide, its real action texture, then running.
- During 37 airborne samples, the actual shadow mesh stays at world y = **0.012** and the selection ring at y = **0.018**. The shadow shrinks and fades as the character rises. The userData value is cross-checked against the actual mesh world transform.
- In the explicit near-finish fixture, the engine makes p1 finish first and p0 second. The second-place player samples front frame 0 during the finish and frame 3 afterwards, never trophy frames 1 or 2.
- 390, 360 and 430 px mobile layouts, plus Arabic at 360 px, render without horizontal overflow. After the compact HUD and circular controls update, all five main control hit boxes are at least 44 px, pairwise non-overlapping, and their centers resolve to the intended button. The three directional/slide controls are exactly 44 × 44 px. No page errors occurred.

The esbuild QA hook observes actual Three objects and materials. It does not modify the renderer's elapsed time, movement, animation sampling, physics, action durations or results. Initial positions are explicitly configured fixtures; the jumps, slides and final crossing then execute through the unchanged engine. This is not a complete unassisted 480 m race or a platform wallet test.

## Media actually reviewed

- [390 px run](run-390.png), [360 px run](run-360.png), [430 px run](run-430.png), [Arabic 360 px](run-ar-360.png)
- [Jump](jump-390.png), [landing](land-390.png), [slide](slide-390.png)
- [Finish camera turn](finish-turn-390.png), [second place without trophy](finish-second-390.png)
- [Current action video](run-v4-actions-finish.webm)
- [Fixed 390 × 844 gallery video](run-v4-gallery-390.webm) — fresh Metal recording, 10.32 s at 25 fps, no viewport switches and no resizing/cropping of the original 430 px QA video. Includes real running and touch jump/slide, then an explicitly configured legal near-finish state whose second-place crossing is resolved by the engine. [Capture metadata](gallery-390.json), [sampled frames](gallery-390-filmstrip.png).
- [Eight consecutive video samples](run-filmstrip.png)

The inspected running samples show alternating steps and the feet remain within their own sprite cells. No obvious adjacent-frame bleed or frame-edge clipping was seen. The motion remains an eight-frame illustrated cycle; it is not continuous high-detail skeletal fur animation. Opponents can overlap in depth because the actual game allows players to share a lane without colliding. The video includes deliberate position-fixture changes and viewport changes, which should not be presented as uninterrupted gameplay.

## Renderer and limits

The latest complete check, including the compact HUD, ran in installed Chrome with `--use-angle=metal`. WebGL reports **ANGLE Metal Renderer: Apple M4 Pro**. A 90-frame running observation yielded median **16.7 ms**, P95 **16.7 ms** and maximum **16.8 ms** between observed animation frames. This short desktop observation is not a mobile performance benchmark. A captured renderer.info sample contains 126 calls and 150,886 triangles; it is not the peak for an entire race. Raw running observations are in [running-samples.json](running-samples.json).

The optional fallback command is:

```sh
node arena/run/qa/motion-software-smoke.mjs
```

[SwiftShader smoke](software-smoke.json) passes asset loading, actual material-frame advancement for all four characters, real touch HTTP acceptance and an airborne authoritative response, with no page errors. Its WebGL renderer is explicitly recorded as SwiftShader. This retained compatibility result predates the compact HUD update; only the complete Metal check was rerun for that layout change. The rule suite was not repeated for the CSS/markup update.

The [first software-rendered full attempt](first-swiftshader-attempt.json) is retained: the HTTP jump succeeded and eight-frame sampling passed, but the QA wait did not observe the short landing pose under slow software rendering and screenshot capture. That timeout was a transient-frame observation failure in that renderer; the same production implementation passed the complete Metal check. The production landing duration was not extended to make a test pass.

Physical Android/iOS WebView devices, mobile GPU performance, network disruption, production concurrency and real wallets are outside this QA scope.
