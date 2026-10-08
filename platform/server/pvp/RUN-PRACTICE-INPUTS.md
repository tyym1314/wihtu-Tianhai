# Run practice input protocol (V2.3)

This is an explicit, free one-human/BOT protocol. The browser opts in only when
the authenticated session advertises `run_practice_input_protocol`. Older
servers and clients continue creating V2.2 rooms. The browser now integrates the
controller and transport; local tests do not establish mobile performance acceptance.
Paid rooms, human multiplayer and historical pinned rooms retain their rules.

## Admission and clocks

Create a free Run practice room with `run_input_protocol: "run-practice-inputs-v1"`.
The usual `ready` then rendered `scene-ready` acknowledgement arms the race.
The server creates private history at tick zero; clients cannot supply history,
stakes, a roster, a pause, or an authoritative clock. The `/action` endpoint is
disabled for these rooms. Send `/inputs` with:

```json
{
  "request_id": "unique_immutable_batch_id",
  "roomId": "room_id",
  "playerKey": "authenticated_player",
  "clockEpoch": 1,
  "baseRevision": 3,
  "commands": [{"commandSeq": 1, "type": "jump", "executeTick": 19}]
}
```

Sequences are consecutive across accepted and rejected commands. Only accepted
commands increment `acceptedInputNo`. A batch has at most eight commands and
may include an exact previously decided prefix. Retries preserve the entire
original body and request ID. A new body requires a new ID.

The server retains 120 ticks of mutable history. Inputs must be later than the
committed watermark, no later than the next server tick, and later than the last
accepted input. Physics, BOT decisions and event order are shared deterministic
rules. A speculative finish cannot fix a room result until its tick is committed.
Shared pauses rotate the clock epoch and rebuild history; command/input counters
do not reset. Clients must discard pending old-epoch presentation and resync.

## Persistence and execution

The existing room advisory lock serializes room mutations. A PostgreSQL
transaction inserts every new decision (including business rejections), stores
the room history, and stores the exact HTTP response. Only then can that same
transaction compact its private decision prefix. Rollback reverts all three.
Old duplicates are checked against the durable decision table, never silently
readmitted when their in-memory history expires. JSONB key reordering is covered
by canonical integrity hashing; this is corruption detection, not authentication.

The bounded engine worker pool executes input replay and background advances.
One core operation permits at most 240 simulated ticks, eight admission
checkpoints and twelve temporary complete states. Worker queue pressure remains
an infrastructure error, not a gameplay forfeit. An adversarial batch that
exceeds its work budget returns `422 WORK_BUDGET_EXCEEDED` with no decisions;
the client must form a smaller new batch instead of blindly retrying that body.

Responses expose only `run_inputs` scope, epoch, revision, time/sequence cursors,
exact batch decisions, correction range and committed result authorization.
It also carries `selfReplay` with the authenticated runner's integer physics
state at `anchorTick` and accepted input tail, so an unacknowledged command issued
before the new head can be reconciled at its actual tick. This proof never
includes BOT anchors, room-private state or integrity hashes.
GET provides a snapshot and cursors; it is not a substitute for a batch receipt.

## Client presentation and transport

One controller belongs to the authenticated owner, room and clock epoch. It
replays only the local runner with the shared physics, retains at most 241
frames, and performs at most 360 steps per authority update (120 to verify the
accepted history plus 240 for the own trajectory). RAF alone advances its
presentation clock; the HUD reads the last immutable `peek()` result.

The original 650 ms authority diagnostic remains visible. Longer simulation is
provisional, with a separate hard 120-tick / 2-second monotonic budget. Only a
strictly advancing validated head renews it. Visibility recovery requires a new
head; same-tick snapshots, ACKs and retries cannot renew the budget. Individual
finish feedback waits for its committed tick, and winners require final result
authorization. Revised events use physical identities, not mutable event IDs.

At most two physical input requests can coexist. They bypass the old global
action lock. Lost replies retry the immutable original batch, up to eight total
attempts. Successful exact receipts are resolved before their room snapshot is
published. A GET cannot acknowledge the outbox. A verified same-owner login
renewal resumes the original request; changing owner/room/epoch disposes it.
Explicit work-budget errors shrink new batches down to one command without
changing their sequence, type or execution tick. Other structural errors stop
and expose a retry control; they do not silently discard inputs.

The browser fixture uses the built Arena, actual WebGL/resources, room routes,
engine workers and an isolated PostgreSQL database. It covers scene-ready
startup, overlapping gestures before a delayed ACK, lost-ACK idempotency, login
renewal and input blocking under the exit dialog. Its host authentication is a
fixture and its GPU is software: it is not public or physical-phone acceptance.

```sh
npm run build:arena
env -u NODE_TLS_REJECT_UNAUTHORIZED node_modules/.bin/tsx tests/run-practice-browser.mjs
```

## Remaining acceptance

Verify six complete courses, long runs, slow networks and actual Android/iOS
devices against the deployed candidate before declaring launch readiness.
Existing failed real-device evidence remains failed. The new profile does not
change the paid multiplayer rules or prove their performance acceptance.
