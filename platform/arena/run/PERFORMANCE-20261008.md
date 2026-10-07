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
**It is not yet connected to the renderer.** Switching the scene to this helper
alone would not resolve publication-phase jumps and could incorrectly predict
a collision while a new input is awaiting its response.

`readRoomResponseTiming(room)` supplies four local `performance.now()`
observations: request start, headers observed, body parsed and restoration
completed. A private WeakMap binds them to each successfully restored room,
including action responses. They are absent from JSON and transfer hashes.
Authorization changes clear them; a GET recovery uses its final request's own
times, while mutations are never replayed. These observations include real
browser parsing/restoration work; they do not measure server generation time,
one-way latency or a valid RTT/2 correction. Chromium and WebKit exercised 18
real HTTP/WebCrypto cases, including a controlled asynchronous digest wait.

The candidate still needs renderer integration with accepted-input handling,
deadline-preserving clock reconciliation, complete race regression and fresh
public physical-device verification. Neither this contract work nor the
browser checks constitutes a smoothness or launch-readiness pass.

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
