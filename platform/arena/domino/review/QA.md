# Darts / Domino independent UI QA

Run: 2026-09-19, desktop Google Chrome headless, 390×844 and 360×844 mobile viewport/touch emulation, isolated ephemeral loopback HTTP and esbuild bundle. This is local game-module evidence. The separate platform API/wallet integration is owned and reported by the root task.

## Observed checks

- Darts: actual down/move/up pointer sequences reach the real engine; eight samples per throw in the recorded run. A bull reduces 301 to 251. A second real pointer throw hits T20, reduces to 191, and displays `TRIPLE 20`, not `BULL`. Flight is visible before impact; impact marker and correct score appear after flight. Audio shot hook is called.
- Domino: 2-player and 4-player actual hand selection and legal endpoint buttons reduce the caller's hand by one and extend the public chain. A running CSS landing animation is observed during the transition. A subsequent other-player engine action updates the same UI via public `view.lastEvent`, without passing through the caller's `onAction` response.
- Domino draw fixture: draws two tiles, stops at the first matching tile, preserves one stock tile, and retains the same turn. The hand shows the newly drawn tiles.
- Long-chain fixture: all 28 distinct double-six tiles are rendered in an Eulerian chain; every adjacent pair matches. It is an explicit terminal visual stress fixture, not evidence that a normal first-empty-hand match reaches 28 placements.
- Both widths: no horizontal page overflow and no uncaught browser errors. 390 and 360 screenshots were inspected for clipped boards, controls, hand readability, score labels and chain fit. The long hand is intentionally horizontally scrollable.

Machine assertions and runtime details: [ui-validation.json](ui-validation.json). Darts frames are in `../../darts/review/`: `darts-{390,360}-{before,hit,flight,triple20}.png`. Domino frames are in this directory, including opening, moving tile, played tile, draw and full chain.

The audio object is a recording stub in this independent harness: the check verifies sound event calls, not playback quality. Platform audio wiring is separate. This work does not prove physical-device gesture latency, WebView lifecycle/audio policy, weak/mobile/cross-region networks, malicious-client resistance beyond the enumerated input checks, production scaling, translation quality or final art approval. Code-native SVG/CSS art is the implementation; no claim of external commercial-game visual parity is made.
