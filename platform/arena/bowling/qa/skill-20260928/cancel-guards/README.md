# Bowling pointer cancellation regression — 2026-09-28

Production change: `arena/bowling/scene.mjs` accepts only the primary captured pointer. A second pointer anywhere in the document, native pointer cancellation, lost capture, blur, hidden document, pagehide, disabled input, or a changed authoritative shot/deadline permanently discards the held gesture. Pointerup rechecks capture and current eligibility before submitting. Disposal removes all listeners. The help modal disables aiming and rolling.

`BOWLING_CASE=cancel-guards node tests/bowling-ui.mjs` runs the actual Three.js UI and authoritative local HTTP engine in Chrome Metal at 390 × 844. All nine cancellation/invalid-state cases sent **zero HTTP action attempts**. A fresh legal gesture after them sent exactly one accepted action. Opening help disabled an otherwise-ready roll and closing restored it. No page errors. Request counts include rejected requests, not just successful engine actions.

`touch-ui.json` includes browser-trusted touch/capture events, counts and outcomes. `cancel-guards.webm` and PNGs retain the visual run. Native CDP touch drives pointerdown/move/up/cancel and a second finger outside the canvas. Blur, visibilitychange and pagehide are explicitly injected lifecycle signals, not a claim of physical iPhone background testing.

A separate WebKit native mouse-drag check uses the same phone viewport and current scene through the real engine:

```sh
BOWLING_BROWSER=webkit BOWLING_CASE=straight-swipe BOWLING_OUTPUT=arena/bowling/qa/skill-20260928/cancel-guards/webkit-legal node tests/bowling-ui.mjs
```

Its result is retained under `webkit-legal/`. This is desktop WebKit compatibility evidence, not iPhone acceptance. No physics, scoring, layout or signed-zero canonicalization changes are included in this input patch. Each test closes its own browser and temporary HTTP server and removes its temporary bundle directory; the pre-existing port 18112 preview was not touched.
