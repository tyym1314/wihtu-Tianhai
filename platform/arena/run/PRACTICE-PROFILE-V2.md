# Negotiated free BOT practice window

The new client selects `pvp-run-v2.4.0 / run-practice-inputs-v2 /
free-bot-360-v1` only when the session advertises that exact tuple. The server
confirms the tuple on the room before Ready. Restored rooms select their own
pinned tuple, independently of current session preferences. Old v1 servers and
rooms retain their 120-tick, 2-second window; other Run versions retain their
existing presentation path. Paid rooms and multi-human rooms cannot use v2.

All numeric limits come from the immutable shared profile registry. V2 permits
360 ticks of own prediction, a 6,000 ms wall-clock lease, 1,080 replay steps per
controller rebuild, 721 retained frame/state pairs and 64 unconfirmed commands.
The 650 ms authority-freshness diagnostic, eight-command immutable batches and
two physical send slots retain their previous meanings. Only a strictly newer
head renews the prediction lease. Same-head revisions, GET command cursors,
receipts, exact duplicate receipts and retries cannot renew it.

Every receive still replays the complete server-supplied own proof and compares
the canonical endpoint. Cached frames never replace this validation. A v2
trajectory can reuse a prefix only when its normalized first own state,
mapping, authorization and command plan match. Captured states include the
next tick's admitted input; a changed command invalidates the prefix starting
one full interval before that admission. Physics receives a separate mutable
copy. Retained records are immutable and share unchanged owned arrays.
Sampling does not copy the trajectory or advance simulation work.

The client retains causal collision, fall and checkpoint boundaries rather
than replacing them with linear motion. Exact own events from the committed
server journal are combined with the unchanged 48-entry global presentation
tail and deduplicated by physical identity. The journal's 720-tick lower bound
uses the actual stopped anchor; a later commit watermark cannot discard valid
events after an early terminal. Provisional own finish cannot authorize room
results. Visibility recovery still requires a new head, and disposed tokens
cannot affect a new controller.

## Local evidence, October 10, 2026

`node --test tests/run-practice-controller.test.mjs
tests/run-practice-input-outbox.test.mjs tests/run-practice-input-transport.test.mjs
tests/run-practice-presentation-events.test.mjs tests/run-practice-onboarding.test.mjs
tests/run-practice-scene-contract.test.mjs tests/run-practice-horizon-regression.test.mjs
tests/run-practice-client-v2.test.mjs` passed 112 tests with no skips.
The new client file contributes 14 tests, including old/new hard boundaries,
64-command and server-tick bounds, GET-before-ACK, immutable reuse, dense input,
visibility/disposal, early terminal authority and the natural tick-3396 fall
with tick-3486 checkpoint respawn. Product behavior was not changed to make
these scenarios pass.

`RUN_V2_QA_LABEL=<unique-label> node tests/run-practice-client-v2-ui.mjs`
builds an isolated real-core HTTP fixture and the actual RunGame/Three/WebGL
component. It preserves an ignored counterfactual baseline using the same v2
tuple, physics, queue and proof validation, with full trajectory rebuilds and
the original per-record clones/deep freeze. Exact baseline transformations and
both source hashes are saved. This is a controlled implementation comparison,
not a historical v1 device comparison.

The `scene-cpu4-v1` run used desktop Chrome mobile emulation (390 × 844, DPR 3,
CPU slowdown 4) and desktop WebKit serially. Four ABBA-ordered repetitions per
fixture returned identical canonical physical samples. The four-player,
six-second fixture contains 61 receives and 35 actually admitted commands:

| Measure | Full rebuild baseline | Optimized v2 |
| --- | ---: | ---: |
| Chrome CPU4 receive mean / p95 / max, ms | 52.315 / 68.2 / 115.9 | 1.102 / 1.7 / 10.4 |
| Chrome CPU4 ACK mean / max, ms | 50.816 / 167.6 | 5.110 / 6.5 |
| WebKit receive mean / max, ms | 11.541 / 45 | 0.410 / 2 |
| New frame records, and independently new state records | 69,695 each | 25,991 each |
| Reused frame/state pairs | 0 | 43,704 |
| Replay steps | 80,544 | 36,968 |
| Sampling history copies | 0 | 0 |

The separate complete revision-rebuild fixture still performed the real
1,080-step worst case and retained 721 frame/state pairs. Chrome CPU4 maximum
receive cost was 70.5 ms for the baseline and 11 ms for optimized v2; WebKit
maximum was 15 ms and 2 ms. Allocation counters count retained record creation,
not engine-wide allocation bytes or garbage collector heap size.

Both actual scenes continued physical motion through a three-second head gap,
stopped honestly at tick 360 after the six-second lease, and displayed the
natural fall and checkpoint respawn. Screenshots, controller samples and real
scene frame traces are saved. The 15 relevant product source hashes matched
before and after this run. All owned browser contexts, browsers and the HTTP
fixture were closed in `finally`.

Raw evidence is intentionally ignored under
`review/run-practice-client-v2/scene-cpu4-v1/`; the reproducible scripts are
tracked. Final pure compatibility evidence is
`review/run-practice-client-v2-final-compat-v2.log`. Earlier failed drafts are
retained, including a test that incorrectly used an expired request revision
and one that confused the two courses' actual terminal ticks. These were
fixture corrections, with no product or threshold change.

This establishes local controller cost and actual scene behavior. It does not
establish physical Android/iPhone smoothness, public-host latency, every game,
network failure recovery or full race/settlement acceptance. Those gates need
their own recordings and authoritative readbacks.
