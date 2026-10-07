# Run: October 8 performance evidence and transfer contract

## Current acceptance boundary

The sealed public `20261008-07` physical Android run lasted 60.169 seconds and
accepted all 13 attempted inputs. Their dispatch-to-rendered-feedback times
were 6.6–18.7 ms. The trace nevertheless contains **10 ordinary forward
discontinuities**. It contains no ordinary backwards discontinuity or ordinary
hold of 100 ms or more. Authority collisions still change motion. These are
separate measures: prompt input feedback does not establish smooth scrolling.
The original iPhone 15 Pro / Safari / Wi-Fi complaint remains unverified.

The new candidate extracts the existing per-runner simulation into
`runner-physics.mjs`; the server still owns accepted inputs, events, ranks,
deadlines, winners and settlement. Tests compare every state against a frozen
pre-extraction engine, including complete races and collision boundaries.
V1 and V2.0 views retain their original shape. V2.1/V2.2 views add only the
requesting player's `selfPrediction` contract: schema, resolved obstacle IDs,
accepted pending input and last input tick. No other player's pending input
or hidden seed is exposed. The existing whole-game transfer hash covers it.

`createRunSelfProjection()` reconstructs this contract and precomputes at most
39 simulation steps per accepted snapshot; `sample(elapsedMs)` samples those
steps without advancing or mutating authority. Invalid or unsupported state
returns no projection. Collision/respawn boundaries, the 480 m finish and the
server deadline are explicit limits. The helper does not guess an unacknowledged
input's acceptance tick and does not own or extend the 650 ms clock budget.

The renderer candidate now connects this helper through `createRunTimeline()`.
It retains and reconciles successive authority bases rather than jumping the
display to each newly published snapshot. Exact accepted input history is
replayed with the shared runner physics. The local character and camera use
one selected pose per frame; other players keep the existing projection.
Unsupported old views fall back to the old renderer. Conflicting history,
physical divergence and background recovery remain explicit resynchronizations.

The display starts with a fixed **100 ms buffer only at the first tick-zero
start**. This is additional display latency, not an RTT estimate or a renewed
650 ms projection allowance. A subsequently unknown boost outcome keeps the
already confirmed movement speed. Once exact accepted history proves the
boost, the candidate can find the same visible distance on that new trajectory,
retreating display time by at most **100 ms once per accepted input**. It does
not accelerate beyond the actual boost speed to catch up. This is a bounded
adjustment to presentation time, not to server time, input success or results.
Unsafe physical/animation boundaries and larger discrepancies cannot use that
adjustment. Unknown inputs near a possible collision can still hold; a lost
connection stops projection at its original limit.

Client movement prediction using shared movement code and correction from
server updates is described in Valve's
[network protocol paper](https://developer.valvesoftware.com/w/index.php?title=Latency_Compensating_Methods_in_Client%2FServer_In-game_Protocol_Design_and_Optimization&uselang=en).
Our choice to replay only accepted boost history and limit display-time
adjustment is a project-specific tradeoff, not a guarantee from that reference.

`readRoomResponseTiming(room)` supplies four local `performance.now()`
observations: request start, headers observed, body parsed and restoration
completed. A private WeakMap binds them to each successfully restored room,
including action responses. They are absent from JSON and transfer hashes.
Authorization changes clear them; a GET recovery uses its final request's own
times, while mutations are never replayed. These observations include real
browser parsing/restoration work; they do not measure server generation time,
one-way latency or a valid RTT/2 correction. Chromium and WebKit exercised 18
real HTTP/WebCrypto cases, including a controlled asynchronous digest wait.

HTTP 408 and server/network failures retain the original unresolved request;
they do not count as definite input rejection. Chromium and WebKit each passed
24 UI shell cases, including retrying the original 408/503 request without
replaying local feedback. These shell cases replace WebGL with a fixture.

The candidate still needs fresh public physical-device verification. The initial
timeline passed 12 complete
course/input combinations but exposed a 150 ms mid-race boost hold; that failure
is retained as the regression motivating the bounded adjustment above. Neither
contract tests nor browser compatibility checks constitute a smoothness or
launch-readiness pass. Public remains `20261008-07` until a new deployment and
independent public readback establish otherwise.

The earlier timeline `51fa0f8e08e186971d2b928f1937e278ca4038ce171c22eeeba5407b1f7b4b9f`
had the following local evidence (before the animation/event fixes below):

- Isolated backend suite: **1,896 passed, no skips**, owned database removed.
- Controller boundaries: 24 passed. Independent complete-race and mid-race
  regression: 23 passed with source hashes unchanged. All six routes completed
  both idle and assisted races; ordinary forward/backward discontinuities,
  100 ms holds and resyncs were zero in those scenarios. Maximum display lag
  was 240–440 ms; the startup buffer remains an explicit tradeoff.
- Actual Chrome/WebGL/Metal, real assets and HTTP engine: **9/9 passed**,
  387 rendered frames matched complete controller-command replay. Seven
  jump/lane cases had local feedback in 13.9–14.9 ms. The added grounded boost
  acceptance/rejection cases had measured ACKs of 258.5/254 ms, zero ordinary
  hold and maximum speeds of 9.6/8 m/s. Configured delay is not measured RTT.
- A remaining legal combination—lane change or jump followed by boost—can
  require explicit `accepted-boost-unsafe-boundary` resync because preserving
  distance alone would rewind lateral/vertical animation. The measured
  correction is **0.053333 m**. This was retained as a flow defect,
  not counted among the smooth scenarios above. In that version item visibility
  and event audio also followed newest authority rather than the visual tick.

Evidence is retained under ignored `review/release/run-timeline-boost-retime-20261008-v2/`,
`review/deployment/run-input-webgl-1791413470595-72f21f/` and
`review/run-timeline-release-suite-20261008.tap`. These desktop/engine results
do not replace Android, iPhone, GPU presentation or full launch acceptance.

## Animation and event synchronization candidate

Accepted boost reconciliation now preserves the phase of an already accepted
lane change, jump or slide until it naturally ends. The runner's animation clip
uses that retained phase; distance, collisions, timers, results and the original
650 ms authority lease keep their own simulation tick. Physical state changes
clear the retained phase at actual impact, including shield contacts. A
projection's look-ahead boundary marker alone must not end an animation before
contact. A rejected linear X/Y correction experiment is retained: it overshot
a lane and briefly sank a landing below the track.

Item visibility uses the selected visual player's immutable claimed-item IDs.
Received event effects wait for their displayed tick and play once per event ID.
A phase retreat or a shared-pause wall-clock shift must not replay an event.
Background/resynchronization discards old movement sounds while preserving a
newly authoritative finish exactly once. Loading drains obsolete effects without
playing them; particles start at the rendered local runner position.

The actual WebGL regression now exercises a legal jump followed by a naturally
collected boost, with a controlled stale GET window and delayed item ACK. It
observes the real animation method's tick, effects, item visibility, local root
and camera, and independently replays all controller commands. The test also
bounds ordinary frame displacement to actual boost speed; message arrival must
not pull presentation time ahead of the animation-frame clock. Reports preserve
failed attempts as well as subsequent passes. These are local fixture and
renderer checks; the production server and physical-phone gate remain separate.

The final local candidate timeline
`b32f05a9f8f6dc03fc5b4cd3ecef4d8b47676e42c3948e7db45c99baa71e08fc`
passed **1,917 isolated backend tests, no skips**, with its database removed.
Its actual WebGL suite passed **10/10**, including the legal jump/boost sequence
with measured 460.1 ms item ACK. Source hashes before and after the complete
rendering run matched. The reported measurements remain local; no public or
physical-device acceptance is inferred. Raw evidence is retained in
`review/run-animation-fx-release-suite-20261008-v3.tap` and
`review/deployment/run-input-webgl-1791415006118-c03768/webgl-input.json`.

## Historical 05 transfer evidence

The public `20261008-05` Android trace contained two ordinary presentation
holds (233 ms and 199.7 ms) and eight ordinary position discontinuities. Its
approximately 59.52 Hz requestAnimationFrame rate does not prove smooth visible
motion. Neither this transfer change nor local tests certify the original
iPhone 15 Pro / Safari / Wi-Fi complaint as resolved.

## Repeated game transfer

Only authenticated `GET /api/pvp/rooms/:id` callers explicitly sending
`X-Oasis-Known-Run-Game: full` or a 64-character lowercase SHA-256 key opt in.
Unmodified clients receive the same complete response. POSTs, saved receipts,
action replay, rules and settlement are unchanged.

The server hashes the entire personalized `game` together with the protocol
version, authenticated application/player scope, room, player and room version.
It removes `game` only when that exact digest matches the client's hint. Fresh
outer fields, including server time and presence, are still sent. A changed
game with the same room version therefore produces a complete response.

The browser checks full-body hashes with WebCrypto and keeps at most two
immutable games per authorization. An in-flight request keeps its own cache
entry. A new token invalidates pending old-identity responses, including a
digest that finishes after authorization changes. Lower-version responses do
not replace a newer cache. Invalid omissions trigger one complete GET; POSTs
are never retried by this mechanism. Unavailable or rejected WebCrypto falls
back to ordinary complete GETs.

In one isolated two-player racing HTTP fixture, legacy JSON was 3,889 bytes,
negotiated full JSON 4,104 bytes, and the exact-repeat response 1,285 bytes.
Local gzip re-encoding was 1,237 / 1,365 / 646 bytes respectively. Full responses
have metadata overhead. These are fixture sizes, not measured mobile wire
bytes or proof of improved latency.

## Request attribution

Exact room GET responses include a server-generated `X-Oasis-Request-Id` and
`Server-Timing: app;dur=...`. The duration begins at the Node request handler
and ends after JSON serialization. It includes awaited work in that interval;
it is not CPU time and excludes pre-handler queueing, proxies, transfer and
browser parsing. IDs contain no room, player, token or caller-provided text.
Other endpoints and mutations receive neither diagnostic header.

The 05 trace had one 604.46 ms request-to-headers interval and one 482.73 ms
headers-to-body interval near the two holds. It did not capture these new
headers or transfer sizes, so it cannot distinguish server, proxy, network and
client delays. The new timing must be correlated with a new captured request;
it cannot retrospectively explain those two outliers.

## Validation and limits

- Isolated backend suite: 1,688 passed, no skips; owned database removed.
- Real API/PostgreSQL HTTP fixture verifies authentication, exact restoration,
  same-version changed content, raw POST receipt/replay, no-store, unique
  request IDs and timing on successful and rejected room GETs.
- Chromium and WebKit: 14 real fetch/WebCrypto cases, including overlapping
  responses, identity change, bounded retry, unavailable crypto, unchanged POST
  and interrupted response body. This is local browser compatibility evidence,
  not a physical iPhone test.

Reproduce from `platform/`:

```sh
npm run test:release
node --test tests/request-timing.test.mjs tests/run-snapshot-transfer-http.test.mjs
node tests/run-snapshot-transfer-browser.mjs
```

No distance smoothing is included. An offline 100 ms correction experiment
made all eight transition points continuous but increased forward burst frames
from eight to fourteen, with a peak correction speed of 25.472 m/s. A more
conservative experiment handled only five points and left both holds intact.
The 650 ms projection limit, authority events, ranks and input contract remain
unchanged. Reduced transfer is a candidate improvement; smoothness needs a new
public mobile measurement before acceptance.
