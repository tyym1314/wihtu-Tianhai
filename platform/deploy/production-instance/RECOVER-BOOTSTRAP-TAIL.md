# Finish the exact 03 bootstrap tail

This controller continues only the recorded address-format validation failure.
It preserves immutable source 03, its production symlink and marker, the repaired
network, original container and initialized database. It never executes network
commands, role DDL, general provisioning, either earlier recovery, database/volume
deletion, source replacement or admission activation.

Actual `app-address-probe-v2.json` proves that the App connection is to database
OID `16384`, with the expected nonprivileged, login-enabled role, App-owned public
schema and zero public relations. PostgreSQL returned `172.18.0.2/32`; Docker
returned `172.18.0.2`. The previous validator compared these strings directly.
PostgreSQL documents that [an explicit inet-to-text cast includes the mask,
while host(inet) returns the IP address](https://www.postgresql.org/docs/16/functions-net.html).
The new query preserves both forms and requires exact Docker IPv4 equality,
raw `/32`, family 4, mask length 32 and server port 5432. It also repeats the
database OID, role flags, login, schema ownership and zero-relation checks in a
read-only snapshot before official bootstrap.

## Standalone deployment and provenance

Upload only the frozen, committed controller to:

```text
/opt/oasis/private/production-bootstrap-tail-20261010/recover-bootstrap-tail.py
```

Its parent must be root:root `0700`; the controller must be a root:root,
single-link, regular `0600` file. Verify its raw SHA independently against the
tool bytes in the supplied master commit. The server has no Git checkout; the
master commit is externally supplied provenance, recorded together with the
verified raw tool SHA, opened-file inode/device/owner/mode and parent metadata in
the check. Same-byte replacement changes the bound inode and invalidates apply.
The executing tool must be at this exact path. Local fixture imports never
authorize a real check.

Imports are fixed to existing `/opt/oasis/releases/20261010-03` helpers, verified
against the known SHA values and immutable manifest:

```text
901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d
```

Helper file descriptors are read and hashed before executing those verified
bytes; a changed file is rejected before its module body can run. The old
`recover-created.py` is bound to its unchanged SHA and contributes only
private-file readers. Its recovery methods are never called. No full release
copy or 03 manifest change is needed. The existing official normal network,
actual loopback port, UID/GID, private configuration and sole-consumer guards
remain mandatory.

## Exact starting evidence

The following root-private raw records are read and rechecked:

- Network failure SHA
  `97e3e151a4e0ae8cba948d76cc92631c084fdb57136dfb7995a5a30c3b3bda8e`,
  from the existing network recovery's `receipt.json`. It has exactly the ten
  known phases, ends `failed_closed` at `source_and_network_advanced`, and has no
  cleanup error, bootstrap, unit, backup or restore success.
- Original network check SHA
  `7afd327835daa66e62b0ab40503c0cf23b1d01b40a12671abba874cafea6c2a1`,
  from that recovery's saved raw `check.json`. It binds source 03, all five
  official helper SHAs, the original marker, both earlier failed receipts,
  retired-source receipt and all eleven preserved historical files.
- Fixed container
  `2ee98b7bb89bb14a0772f5bed1b6783024241664c367531ee6b52fc22fd86af6`,
  owner `f35571b2005dbe05ee68a41e72d11b75`, UID 997 / GID 999, stopped with exit 0.
- Repaired network
  `e50c45372afb7783737e5b64d32355d0d7702ac3fa9335da4d7c99e08da1d2fc`,
  ordinary dedicated bridge, exact loopback binding option and original label.
- Current marker must equal the old recorded marker with only source 03,
  manifest 03 and repaired network ID advanced. Current production symlink must
  retain its recorded device/inode `64515/1025182`, root identity and exact 03
  target. Original volume device/inode `64515/378617`, monitor identity, fixed
  operations lock and all four private pins remain unchanged.
- No bootstrap file, owned units, active UID process, API/PG host listener,
  backup, extra state file or prior tail recovery directory is allowed.

The reviewed 20 public pins are sampled twice, along with the normal resources,
controller identity, marker, history and inactive loaded unit state. Preserve the
existing capacity budget and reserve requirements.

## Check and apply

Save a check to a new root-owned single-link `0600` file, then obtain its raw SHA
from an independent reader. Argument shape (replace only the three provenance
and inventory/budget values with independently reviewed values):

```text
/usr/bin/python3 -I -B /opt/oasis/private/production-bootstrap-tail-20261010/recover-bootstrap-tail.py check
  --controller-sha256 <raw uploaded controller SHA>
  --source-commit <40-character master commit containing the tool>
  --protected-inventory <original reviewed root-private inventory>
  --origin https://oasis-player.43.98.202.236.sslip.io
  --pg-image sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb
  --capacity-budget-bytes <original reviewed budget, at least 1073741824>
```

Release and manifest defaults are the exact 03 identities above. Any different
value is rejected. Apply uses the same arguments, `apply` mode and:

```text
--check <root-private raw check file>
--check-sha256 <independent raw check SHA>
--recover-exact-bootstrap-tail-closed
```

The check expires after 600 seconds. Apply acquires both existing release and
operations locks. Opened-FD/path identity guards run before and after flock,
and the complete check is repeated under both locks. A new exclusive directory
at `/opt/oasis/production-instance-private/recovery-bootstrap-tail-20261010`
preserves the raw old check, failed receipt, current marker and new check.

Then start only the stopped original CID, verify internal readiness with
`pg_isready -h 127.0.0.1`, run the official normal guard, require actual loopback
publication and host TCP, and prove the App read-only row above. Only then run
the official existing empty-database bootstrap, real backup and restore drill.
Both restore cleanup results must pass before official unit installation,
effective loaded-command verification, enable, closed health and monitoring.
Success is `complete_closed`, zero players/credits, closed admission and pending
ingress activation.

## Diagnostics and refusal

All Node calls use absolute `/usr/bin/node`, explicit private environment plus
fixed PATH/locale, without ambient proxy, preload or Node options. Raw stdout
and stderr are written exclusively as root-private `0600` files under the new
`diagnostics/` directory, including partial output from timeout. Receipts expose
only paths, SHA/byte counts, exit status and a bounded structured error code.
No password, private URL, stderr content or master key is printed. Generated
probe JavaScript writes JSON directly and has a local syntax check.

Representative refusals include `TAIL_CONTROLLER_LOCATION_INVALID`,
`TAIL_IMMUTABLE_IMPORT_CHANGED`, `TAIL_ORIGINAL_FAILURE_INVALID`,
`TAIL_ORIGINAL_PHASE_CHANGED`, `TAIL_DATABASE_NOT_EXACT_EMPTY`,
`TAIL_APP_CONNECTION_NOT_OWN_CONTAINER`, `CHECK_NOT_FRESH`,
`SHARED_DEPLOY_LOCK_REPLACED`, `NODE_RESPONSE_UTF8_INVALID` and
`COMMAND_FAILED_NODE`. Node output is captured as raw bytes before decoding;
the latter failures keep the
private raw diagnostic evidence and sanitized structured code. A primary error
always sets `passed=false`; a refused cleanup records a separate error.

Failure stops only the original CID after the strict official normal ownership,
sole-consumer, network, volume, private pins and source symlink proof. Installed
services additionally require the official effective-command guard. Unknown
ownership prevents stop. There is no automatic retry or destructive cleanup;
an existing tail directory blocks another application of this tool. Preserve
all old receipts and any partial bootstrap/database changes for diagnosis.

Local verification uses only synthetic/temp-FS fixtures and Node syntax parsing:

```sh
python3 -B -m unittest discover -s platform/deploy/production-instance -p test_recover_bootstrap_tail.py -v
```

Remote fresh check, execution, real backup/restore and independent closed-state
readback remain separate evidence. Local passing fixtures do not establish them.
