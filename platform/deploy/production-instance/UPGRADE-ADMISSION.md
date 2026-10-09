# Source upgrade and first-party free BOT admission

This controller has one witnessed source transition: the running independent
production instance at `/opt/oasis/releases/20261010-03` to the separately
verified `/opt/oasis/releases/20261010-04`. It does not provision a container,
network, volume, role, App, wallet, key, or bootstrap seed. It does not grant
financial, paid, probability, third-party, performance, or device admission.

Deploy the controller separately at
`/opt/oasis/private/production-admission-20261010/upgrade-admission.py`, with
root ownership, mode 0600 and a root-owned 0700 parent. Invoke it with the
absolute `/usr/bin/python3 -I -B`. Its bytes must also be present in the 04
manifest; provide the external controller SHA and the independently recorded
master source commit. Neither a local fixture nor an arbitrary file location
can pass an actual controller check.

## Four independent actions

1. `upgrade`: first inspect the closed, empty 03 database; create an actual
   backup and restore drill through the original, SHA-bound 03 helpers. Require
   both drill cleanup proofs. Stop only the owned API and three owned timers.
   Preserve the runtime file byte for byte outside the four admission fields;
   04 initially receives `OASIS_ADMISSION_PROFILE=closed`, with the other three
   scoped fields absent. Run official migrations with no seed or listening
   server. Advance the owned production symlink and installation marker,
   retaining the 03 source, original four private pins and historical restore
   contract. Load the six owned unit templates and two certificate unit
   templates from 04. Start the API and timers only after typed loaded-command,
   database, profile and source checks. The App remains paused and there is no
   policy row.
2. `approve`: separately review the actual 04 source and App metadata, all 11
   arena games, platform binding, currency scale, exact HTTPS origins, and zero
   financial state. Stop the owned writers before committing a closed policy at
   revision 1. Add the four explicit free-profile environment fields while
   keeping generic admission exactly `0`. Save the complete original closed-04
   configuration in independently approved `configuration_history`; preserve
   the other three secret fingerprints. Record the real policy snapshot, then
   verify the database and restart the owned runtime. The App remains paused.
3. `open`: lock App → policy → binding → wallet scope, check the exact previous
   metadata and revision, then atomically activate the App and change the
   policy to open at the next revision. Keep its source, original approval
   proof and environment unchanged. Append the actual committed snapshot to
   the marker. Only zero-entry BOT training is admitted by the backend.
4. `close`: use the same transaction and next revision to pause the App and
   close the policy. Keep the environment and all source/proof fields unchanged.
   Existing accepted games, recovery and exit remain the backend's authority;
   this action does not clear rooms, sessions, identities or wallets and does
   not stop the API on success.

For every action, use a new read-only `audit`, a new root approval for exactly
that action, a fresh `check`, an independent external SHA readback, and one
`apply`. Audit and approval must still be within 600 seconds when accepted.
Both the global release lock and the production operations lock bind path,
opened FD, inode, device, owner, mode and bytes before and after flock and again
at completion. An already attempted check hash has its own exclusive receipt
directory and cannot be retried automatically.

## Root approval document

The root-owned 0600 JSON has exactly these fields. `passed` describes only this
action's declared `scope_kind`, not formal launch acceptance:

```json
{
  "schema": 1,
  "kind": "production-firstparty-admission-approval",
  "passed": true,
  "action": "upgrade",
  "scope_kind": "source-upgrade",
  "audit_sha256": "<actual independently read audit SHA>",
  "release": "/opt/oasis/releases/20261010-04",
  "manifest_sha256": "<actual 04 manifest SHA>",
  "source_commit": "<actual master commit>",
  "app_id": "<existing bootstrap App ID>",
  "scope": {
    "partner_id": "partner_oasis_platform",
    "app_id": "<same actual App ID>",
    "environment": "production",
    "wallet_scope_id": "<actual wallet scope ID>",
    "currency_id": "COIN"
  },
  "currency_scale": 2,
  "allowed_origins": ["<sorted actual HTTPS origins>"],
  "game_ids": ["<sorted exact 11 arena IDs>"],
  "profile": "firstparty-free-v1",
  "financial_admission_enabled": false,
  "probability_admission_enabled": false,
  "thirdparty_financial_admission_enabled": false,
  "approved_by": "<actual root operator identifier>",
  "approved_at": "<actual timezone-qualified approval time>"
}
```

Use `firstparty-free-only` for `approve`, `open`, and `close`; use their own
actual audit SHA, state, source, and approval time. The angle-bracket values
above explain the contract and are invalid inputs. The controller does not
create or infer an approval document. Public policy approval fields and
source declarations are not credentials and must describe the actual instance.

## CLI protocol

Common arguments to all three modes:

```text
--action upgrade|approve|open|close
--release /opt/oasis/releases/20261010-04
--manifest-sha256 ACTUAL_04_MANIFEST_SHA
--controller-sha256 ACTUAL_CONTROLLER_SHA
--source-commit ACTUAL_MASTER_COMMIT
--app-id ACTUAL_EXISTING_BOOTSTRAP_APP_ID
--origin ACTUAL_PRODUCTION_HTTPS_ORIGIN
--protected-inventory ROOT_REVIEWED_PROTECTED_INVENTORY_JSON
--protected-inventory-sha256 ACTUAL_INVENTORY_SHA
--capacity-budget-bytes 1073741824
```

If the inventory is the explicitly reviewed Mock23/24 retirement inventory,
also supply each root-owned 0600 historical document and its independently
recorded raw SHA:

```text
--source-audit ACTUAL_SOURCE_AUDIT --source-audit-sha256 ACTUAL_RAW_SHA
--archive-proof ACTUAL_COMPLETE_ARCHIVE_PROOF --archive-proof-sha256 ACTUAL_RAW_SHA
--archive-review ACTUAL_ROOT_ARCHIVE_REVIEW --archive-review-sha256 ACTUAL_RAW_SHA
--retirement-check ACTUAL_RETIREMENT_CHECK --retirement-check-sha256 ACTUAL_RAW_SHA
--retirement-receipt ACTUAL_COMPLETED_RETIREMENT --retirement-receipt-sha256 ACTUAL_RAW_SHA
```

The original inventory's raw SHA is retained, and its original validator must
still approve all 20 historical references. Only the exact two
`20261008-23/RELEASE-MANIFEST.json` and `20261008-24/RELEASE-MANIFEST.json`
references may have been retired. The complete 9,571-entry recovery tree per
source, root inode, manifest, archive bytes/SHA, complete body/typed metadata and
gzip EOF review remain bound through the actual successful retirement receipt
and its original external check. Missing or partial retirement cannot authorize
missing source. The current 04 manifest binds the pure retirement validator's
raw source, which is executed without loaders or bytecode. All six historical
documents and the retained original inventory are checked on every phase.

The public guard retains its original code and protects the other 18 paths,
original inventory, public current/previous, shared PostgreSQL/proxy, public
secrets, Nginx/TLS/static state and Mock 410. Only the exact eight owned unit
files, production symlink, installation marker and private runtime file are
separate explicitly authorized transitions; their initial bytes, source and
loaded command identity remain independently audited. The shared private parent
exception is limited to its witnessed UID/GID 998, mode 0700, device 64515 and
inode 934465. No generic parent, missing-reference or shared-file exception is
introduced. Static publication must finish under its own reviewed receipt
before capturing the retirement baseline.

Run `audit` with those arguments and save stdout exclusively as a root-owned
0600 file. Read it back independently, review its scope, then prepare the actual
root approval. Run `check` with the common arguments plus:

```text
--audit ACTUAL_AUDIT_FILE --audit-sha256 ACTUAL_AUDIT_SHA
--approval ACTUAL_ROOT_APPROVAL_FILE --approval-sha256 ACTUAL_APPROVAL_SHA
```

Save and independently hash the check. Run `apply` with those same arguments
plus `--check ACTUAL_CHECK_FILE --check-sha256 ACTUAL_CHECK_SHA`. Never reuse a
fixture proof, another action's capsule, a stale check, or a failed receipt as
an approval. Local test reports remain explicitly isolated evidence.

## Source, backup and failure evidence

The controller FD-verifies and executes source bytes directly. It strips only
the exact known nested import blocks in the old/new operations helpers and
injects the already verified provision/admission modules. It does not reread
helpers through a loader or cached bytecode. All manifest members and the
node_modules dependency tree are checked; 04 dependencies must match the
retained independent 03 copy, with safe internal symlinks. The source, CID,
network, original volume inode, owner, UID/GID, three unchanged secrets, current
runtime pin, original bootstrap App, effective eight units, public sandbox,
shared Nginx, retired Mock 410, and protected historical inventory remain
bound. Capacity retains a minimum 1 GiB action budget plus the established
3 GiB / 15% reserve.

`release_history` has exactly one entry per source/manifest. Each entry binds
helpers, all four private pins, inspection contract, public runtime profile and
all real policy approval snapshots. `approve` adds the prior three-field
configuration snapshot to optional `configuration_history` before changing
the current configuration. Schema-2 restore selects only a unique configuration
already authorized by that marker, using the receipt's runtime-env SHA and
exact profile. A backup does not grant itself approval. Original 03 backups
remain tied to original 03 helpers, archived private bytes, actual AES
decryption and owned restore-database cleanup.

Each apply preserves the original audit, root approval, check, marker, private
runtime bytes and all eight unit files beneath
`/opt/oasis/production-instance-private/admission-upgrades/ACTION-CHECKSHA/`.
Its root-owned 0600 `receipt.json` records individual committed phases,
history, backup/drill evidence and final readback. Node command errors keep
bounded raw stdout/stderr only inside that private directory; public output
contains a sanitized code. Primary and cleanup failures remain separate.

Failure always invalidates `passed`, including a final lock failure after a
nominal completion. When normal physical ownership, original secrets, authored
pins and effective units can still be proved, stop only the owned API. Do not
stop or recreate the database container, remove data, restore a live database,
reverse a committed policy revision, or pretend schema/source rolled back.
The receipt explicitly states that a database policy may already be committed.
If scope cannot be proved, record the refused cleanup; do not stop an unknown
service. Recovery requires a separately reviewed exact phase and fresh evidence.

## Local verification

```text
python3 -B -m unittest discover -s platform/deploy/production-instance -p test_upgrade_admission.py -v
```

The suite exercises real temporary FD replacement, symlink/hardlink rejection,
umask-safe writes, lock-name replacement, actual old/new helper import chains,
strict root-proof scope, closed/open/closed metadata, transaction ordering,
source/proof preservation, no environment rewrite on close, cleanup failure
separation, failure-after-completion, exact retired-source evidence, a third
public pin omission, a false/partial retirement receipt, missing raw recovery
pins, public/owned scope mixing and unknown cached `ExecStartPre`. An independent
owned-loopback PG run checks official schema snapshots, approve/open/close
revisions and source/proof preservation, stale-revision rollback, and an actual
accepted Golf BOT room: closing rejects new launch/room, preserves original
GET/leave authority and leaves zero financial rows and balances. Its explicit
local database name/OID substitutions are isolated test preconditions; no test
is a real root approval or a public/device acceptance claim.
