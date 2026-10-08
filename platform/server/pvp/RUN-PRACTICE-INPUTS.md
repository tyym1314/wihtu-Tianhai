# Run practice input protocol (V2.3)

This is an explicit, free one-human/BOT protocol. Existing clients still create
V2.2 rooms. The browser has not yet integrated the new presentation controller;
these server and queue tests do not establish mobile performance acceptance.
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

## Remaining acceptance

Integrate the immutable outbox with a causal client controller, revision-aware
events and committed-result presentation. Preserve the original 650 ms authority
freshness diagnostic; any longer local simulation is explicitly provisional,
with a separate hard 120-tick / 2-second monotonic budget. Same-tick snapshots,
ACKs and retries must not renew that budget. Validate delayed/reordered/lost
responses, six complete courses and actual phones before enabling this profile
in the public UI. Existing failed real-device evidence remains failed.
