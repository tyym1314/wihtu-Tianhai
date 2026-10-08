# Run causal rendering candidate

This is a rendering change awaiting release and device acceptance. It does not
change server physics, accepted input ticks, receipts, winners or settlement.
The integer `stateAtTick()` oracle and the legacy projection sampler retain
their existing meanings. Public09's recorded forward spike remains a failed
observation; changing the renderer does not retroactively pass that recording.

## One fixed interval of visual history

The timeline uses `sampleCausal()` to display the preceding computed interval.
`controlTick` is the existing raw display clock; `tick`, `causalTick` and
`eventTick` follow the causal visual clock. All transforms and visible player
metadata use that clock. A newly created base without proven history anchors
for at most one fixed step. At tick zero this anchor is included in the existing
100 ms total startup buffer, rather than added to it. Snapshot replacement can
inherit exactly two immutable frames only after canonical endpoint agreement.
It cannot retain an unbounded chain or invent a missing predecessor.

This makes a stun recovery continuous without moving before stun expires.
Only the stun-expiry predicate in input presentation and animation uses
`controlTick`. Jump, slide, shield, pickup and physical-event presentation still
use causal time. Animation speed is the permitted interval's forward derivative;
an anchor, hard hold or exhausted projection has zero visual speed. Latest
server speed cannot leave a moving recovered character in the idle animation.

Hit, shield-hit, fall, respawn and collision boundaries remain hard. A finish
approach can interpolate only a finish-only interval; victory and the camera
sequence require received authority and the causal endpoint. Unproved terminal
state retains the explicit `authoritative-terminal` authority boundary. It is
not a continuity guarantee. The future lease remains 39 ticks / 650 ms;
duplicate snapshots do not renew it. Accepted boost retiming keeps its existing
100 ms bound and physical/animation exclusions.

## Opt-in diagnostic journal

The existing session opt-in `oasis:run:frame-trace:v1 = 1` also enables
`run-timeline-journal-v1` on that scene's `__oasisRunFrameTrace.read()` result.
Ordinary sessions preserve the original controller identity and allocate no
journal buffers. No automatic upload, disk write or console export is added.

The journal captures ordered receive/input/receipt/lifecycle calls, exact sample
times, selected poses and causal interval endpoints. Post-render bindings record
the corresponding sample number and actual character/camera transforms. These
are JavaScript render-return observations, not GPU completion or screen FPS.
Unlike the separate numeric frame trace, journal payloads include room/player
identifiers and received game state: keep exports in the ignored review area.

Default storage is three fixed numeric buffers (8192 rows each) and an 8 MiB
UTF-16 payload budget. Payloads are copied only at controller calls, not each
frame. Bounds or unsupported/lossy data stop recording and set `complete:false`
with the first reason; controller calls continue. A truncated prefix must never
be described as a complete replay. Readers use the exported field/method tables,
not hard-coded column positions. NaN/missing optional numeric fields export as
null; payloads reject non-JSON values, getters, shared/cyclic objects and sparse
or extended arrays without evaluating getters.

Resetting the numeric frame window intentionally retains the journal's complete
controller prefix. Disposing the scene clears both stores and removes its
access property. Replay needs the exact recorded source revision, all commands,
and a complete journal; inferred sample phases are a different evidence class.

## Verification boundary

Directed engine/timeline tests check integer equivalence, recovery phases,
input admission, canonical snapshot handoffs, physical boundaries and lease
exhaustion. The WebGL harness compares the production journal with a separate
read-only command observer, replays every sample, and matches actual renderer
bindings. These checks cannot establish physical-device smoothness, iPhone
Safari acceptance, complete games or launch readiness by themselves.
