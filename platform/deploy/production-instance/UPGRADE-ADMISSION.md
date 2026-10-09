# Source upgrade and first-party free BOT admission

This controller has one witnessed source transition: the running independent
production instance at `/opt/oasis/releases/20261010-03` to the separately
verified `/opt/oasis/releases/20261010-04`. It does not provision a container,
network, volume, role, App, wallet, key, or bootstrap seed. It does not grant
financial, paid, probability, third-party, performance, or device admission.

Deploy the controller separately at
`/opt/oasis/private/production-admission-20261010/upgrade-admission.py`, with
root ownership, mode 0600 and a root-owned 0700 parent. Invoke it with the
absolute `/usr/bin/python3 -I -B`. This privately deployed controller revision
is separate from the immutable runtime package. The witnessed 04 manifest is
`4b8c3b2820c271198563180983c72f25d088c63c872463704af632929adf3c0f`,
its runtime source commit is
`63e44d330cf09c60eab0a08c03150b5f38d26ea7`, and its original packaged
controller remains byte for byte at SHA
`9149342b52872518ff1372f398afa8d25526369820bc4fe6f4befa47281848c5`.
The packaged controller is FD-pinned as historical runtime provenance, never
rewritten to match this private correction. Supply the new private controller's
external SHA and actual `--controller-origin-commit` separately; `--source-commit`
continues to name the runtime commit. Audit, check and operation receipts record
both identities. Neither a fixture nor an arbitrary file location passes an
actual controller check. Preserve the old private controller, provenance and
failed audit before replacing only the witnessed private tool and provenance;
create fresh audit/proof/check evidence for the new version.

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
   templates from 04. Start only the API under the two shared locks, prove actual
   ready/HTTPS, and write a verified pending receipt with `passed=false`. Release
   both shared locks before activating the three exact timers and completing
   the bounded lifecycle described below. The App remains paused and there is
   no policy row.
2. `approve`: separately review the actual 04 source and App metadata, all 11
   arena games, platform binding, currency scale, exact HTTPS origins, and zero
   financial state. Stop the owned writers before committing a closed policy at
   revision 1. Add the four explicit free-profile environment fields while
   keeping generic admission exactly `0`. Save the complete original closed-04
   configuration in independently approved `configuration_history`; preserve
   the other three secret fingerprints. Record the real policy snapshot, then
   verify the database and restart only the owned API under shared locks. The
   same post-lock timer tail must finish before success. The App remains paused.
3. `open`: lock App → policy → binding → wallet scope, check the exact previous
   metadata and revision, then atomically activate the App and change the
   policy to open at the next revision. Keep its source, original approval
   proof and environment unchanged. Append the actual committed snapshot to
   the marker. Temporarily stop only the three owned timers, preserving the API
   and accepted games; reactivate them through the same post-lock tail. Only
   zero-entry BOT training is admitted by the backend.
4. `close`: use the same transaction and next revision to pause the App and
   close the policy. Keep the environment and all source/proof fields unchanged.
   Existing accepted games, recovery and exit remain the backend's authority;
   this action does not clear rooms, sessions, identities or wallets and does
   not stop the API on success. The three owned timers follow the same temporary
   stop and post-lock activation, without rewriting runtime bytes.

For every action, use a new read-only `audit`, a new root approval for exactly
that action, a fresh `check`, an independent external SHA readback, and one
`apply`. Audit and approval must still be within 600 seconds when accepted.
Both the global release lock and the production operations lock bind path,
opened FD, inode, device, owner, mode and bytes before and after flock and again
at completion. An already attempted check hash has its own exclusive receipt
directory and cannot be retried automatically.

An additional nonblocking flock on the existing root-owned 0700 controller
parent directory FD serializes private admission operations across both
phases. It creates no lock file and changes no directory metadata. The FD and
path must retain their exact device/inode/owner/mode/fingerprint until exit.
Audit and check take these read-only locks without changing timers or services.
Deployment of another private controller version must respect this same
directory lock.

## Completion after shared locks are released

The backup job takes the production operations lock and certificate renewal
takes the global release lock, both nonblocking. Starting their timers while
holding those same locks can fail normal scheduled work. The controller never
starts any of the three timers inside its shared-lock scope.

After the source/policy change and API readiness are verified, the receipt stays
pending and false. On releasing both shared locks, recheck the controller,
helpers, source, evidence, all private/resource/namespace/unit identities,
retained lock-file fingerprints, database, profile and strict HTTPS. The parent
directory lease remains held. Only then start exactly the backup, monitor and
certificate timers. For no more than 60 seconds, resample their immediate
oneshot work. Each sample still verifies source, evidence, authored files,
public protection, physical resource ownership, the directory lease and eight
disk/loaded unit contracts. Busy work must match its exact witnessed command,
root UID fields, systemd PID/start ticks, dedicated cgroup, cwd and FD-pinned
mapped executable. The system Node and Python executable fingerprints are
included in the audit/check bindings. Only an exact metadata transition may be
resampled; failed/nonzero results, unknown status, foreign process identity,
changed templates/commands/executables or timeout refuse completion.

A busy sample grants no consumer exemption and performs no further mutation.
Full consumer acceptance is deferred until all exact jobs are idle, at which
point the original two-sample foreign-consumer gate must pass. Final timers
must be active; jobs must be inactive/PID 0 with successful status; database,
policy, HTTPS and full scope are checked again, including scope equality across
the final readback. Only this post-lock success sets the original receipt to
`passed=true` and `complete_*`. `timer_tail` separates observed running
invocations from idle default `ExecMainCode=0`: a calendar job that never fired
is not fresh backup or certificate execution evidence.

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
  "source_commit": "<actual immutable runtime source commit>",
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
--source-commit ACTUAL_IMMUTABLE_RUNTIME_COMMIT
--controller-origin-commit ACTUAL_PRIVATE_CONTROLLER_ORIGIN_COMMIT
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

Every effective-unit check also samples all processes consuming either source
or UID 997 twice. The main API must match the systemd MainPID/start ticks,
four UID fields, exact Node command, source working directory and dedicated
API cgroup. Only direct esbuild children of that same witnessed main identity
are allowed: start ticks cannot precede the parent; all UIDs, cwd and cgroup
must match; the exact source-local executable must be root-owned, single-link,
mode 0755 with the witnessed SHA and mapped inode; arguments must be exactly
`--service=0.28.2 --ping`. The system Node executable is likewise SHA/inode
checked. Process identity and executable fingerprints must remain unchanged
across both samples, including before any owned-unit stop/start. CPU counters
are not process identity. An inactive API admits no remaining UID/source
consumers. EnginePool uses `node:worker_threads` with `execArgv: []`; its workers
share the API PID. No standalone Node child, arbitrary descendant, foreign
source/cgroup or unknown executable is authorized. This gate does not kill
normal esbuild processes to manufacture an empty consumer inventory.

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
pins and effective units can still be proved, stop only the three exact timers
and owned API. Idle failed jobs may permit this verified cleanup, but cannot
make the operation successful. A still-busy or foreign job refuses unsafe
cleanup; `closed_runtime_confirmed=false` and the separate cleanup error make
clear that an API stop was not proved. Do not
stop or recreate the database container, remove data, restore a live database,
reverse a committed policy revision, or pretend schema/source rolled back.
The receipt explicitly states that a database policy may already be committed.
If scope cannot be proved, record the refused cleanup; do not stop an unknown
service. Recovery requires a separately reviewed exact phase and fresh evidence.

## Optional reviewed static04 retention

Omitting both new arguments preserves the original behavior: any change to the
reviewed static HEAD refuses admission. Both arguments must be supplied together:

```text
--static-retention-review /opt/oasis/private/REVIEW-DIRECTORY/static-retention-review.json
--static-retention-review-sha256 ROOT_INDEPENDENT_RAW_REVIEW_SHA256
```

The root-owned review and referenced BEFORE document must be single-link 0600
regular files in root-owned 0700 directories, compact JSON of at most 16 MiB.
Their file descriptors and all ancestor directory identities stay bound until
controller exit. The shared `/opt/oasis/private` ancestor retains its original
exact UID/GID 998, mode 0700, device 64515 and inode 934465; this option neither
changes nor generally relaxes that parent. Leaf or parent replacement, including
same-byte inode replacement, refuses the operation. Only the already-validated
retirement-derived inventory can use this option; the eight original raw
retirement documents and twenty original references remain required.

The completed review has exactly these root fields:

```text
schema: 1
kind: root-reviewed-static04-maintenance-v1
phase: complete
passed: true
source: {release, runtime_source_commit, manifest_raw_sha256,
         full_archive_raw_sha256, publisher_raw_sha256, selector_raw_sha256}
retirement_raw_bindings: {historical_inventory_sha256, inventory_sha256,
  source_audit_sha256, archive_proof_sha256,
  root_independent_archive_review_sha256, check_sha256,
  retirement_receipt_sha256, tool_sha256}
before_capture: {path, raw_sha256}
before: FULL_INDEPENDENT_BEFORE_DOCUMENT
after: FULL_INDEPENDENT_AFTER_DOCUMENT
official_expected: {required_assets, added_assets, receipt_raw_sha256,
  receipt_bytes, head_raw_sha256, head_bytes, required_count, added_count,
  added_bytes, before_assets, before_receipts, after_assets, after_receipts}
publisher_result: ACTUAL_OFFICIAL_PUBLISHED_REPORT
https_verification: {origin, assets: {URL: {status, bytes, sha256, content_type,
  cache_control, head_status, not_modified_status, range_status, no_redirect}}}
```

`before` must equal the externally hash-bound raw independent capture, whose
kind is `independent-static04-preappend-baseline-v1`, with `passed=true` and
`read_only=true`. The AFTER kind is `independent-static04-postappend-observation-v1`.
Both full documents retain `source`, `protected`, `upgrade04`
and `retirement`. They add `guardian_protected` (the exact seven original
Runtime.protect keys and 25 file pins), `static`, `static_directories` and
`static_ancestors`. `static` has exactly `head`, `head_pin`, `receipts`,
`registered`, `entries`, `receipts_count`, `registered_count` and `head_raw`
(strict base64 of the complete canonical raw HEAD). Full file pins include
UID/GID/mode/device/inode/kind/bytes/SHA/nlink/mtime_ns/ctime_ns. Full directory
pins have the same fields except SHA. Directories are relative to the static
store, including `.` and `.registry`; the exact ancestors are `/`, `/opt`,
`/opt/oasis` and `/opt/oasis/private`. Existing directory identity, owner and
permissions and nlink cannot change. Only the exact added-file parent
directories (`.registry`, `arena/assets`, `assets`) and the HEAD parent
`/opt/oasis/private` may have child-entry size/mtime/ctime changes; these remain
recorded and do not authorize a directory replacement or a new directory.
Every other directory pin stays completely equal.

The historical before/after source, private, API, database and service facts
must remain identical across publication, except the explicitly approved HEAD.
Only `protected.units.*.observed_command_struct_sha256` and
`protected.public_units.*.observed_command_struct_sha256` are observation-time
hash projections: raw values remain in the evidence and report. Actual files,
commands, command hashes, state and every other field remain exact. This
historical publication proof does not freeze the old private operator or closed
business state forever. Later approved operator uploads and free admission use
the normal current Controller guards; this option freshly guards only approved
immutable evidence and static retention, and does not authorize business changes.

The source declaration remains runtime commit `63e44d330cf09c60eab0a08c03150b5f38d26ea7`,
manifest `4b8c3b2820c271198563180983c72f25d088c63c872463704af632929adf3c0f`,
full archive `240ca8d47f18be1f6f141a978a496bd017d015352fbbdac1de348c45fa9df0b6`.
The actual immutable publisher and release selector are loaded from verified
FD bytes; their one known import is replaced with the same verified definitions,
without a path/pyc loader. Only their pure selection and registry functions run.
The controller does not publish, write HEAD or copy a resource.

Official selection must reproduce all 583 required URL/hash/byte pairs, exactly
22 missing source-backed additions totaling 1,257,968 bytes, and the full
583-resource receipt `f2050db36551c7e92146be235fda5d228e6bdcc70b08a73b69e5256675f6749b`
(92,362 bytes). The original 936 resources and 22 raw receipt identities stay
exact. The resulting 958-resource/23-receipt union must have HEAD
`36ac71b64cb9de81e0765775043d982062315b3c5ad1b14981cbd8f9b195bed8`
(1,741 bytes), on the original device and with a new approved inode. No special
file, symlink, hardlink, nested mount, temporary/orphan file or new directory is
accepted. Added source/store files and the new receipt cannot alias old inodes.
Each added URL needs real strict HTTPS GET/hash/bytes, HEAD 200, validator 304,
range 206, JavaScript media type, immutable cache and no-redirect evidence. The
`content_type` field is the response media type before any optional charset;
`cache_control` is exactly `public, max-age=31536000, immutable`.

Only `derived.snapshot.files[/opt/oasis/private/static-assets-head.json]` is
replaced. The other 24 pins and six protection groups stay exact, and the
original guardian runs unchanged. Review/BEFORE pins are additive to
`protection_files`; full static coverage is recorded under
`source.static_maintenance`, outside the seven-key protected snapshot. Every
normal fresh/final check rehashes all 958 bodies and 23 receipts, checks their
full metadata and namespace enumeration, verifies HEAD/ancestor identities and
rejects same-filesystem bind mounts. A second metadata/enumeration sample
rejects replacement during hashing. This does not reopen finance, approve free
play, alter any policy, or imply game/performance/device acceptance.

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
pins, public/owned scope mixing and unknown cached `ExecStartPre`. It also tests
the exact main/esbuild contract in real temporary proc files and executable
inodes for both sources, PID/start-tick reuse, wrong ancestor/UID/cwd/cgroup,
changed argv/version, executable mutation/link/mapped-inode mismatch, inactive
or extra consumers, legitimate CPU-stat changes, and refusal before systemctl
stop. Private controller-origin evidence remains separate and cannot change
the frozen runtime manifest, packaged-controller SHA or runtime commit.
The optional retention tests exercise all 936 old identities and 583-resource
receipt semantics in explicit synthetic isolated fixtures, 22 additions,
source/raw-before/other-public-pin rejection, actual body and receipt tampering,
unregistered files, same-byte held FD and parent replacement, HEAD mounts,
paired arguments, default missing-proof refusal and verified pure helper loading
without secondary path or cached-bytecode reads. They do not constitute a real
production review. The lifecycle tests additionally exercise real directory-FD flock contention
and replacement, shared-lock release before timer start, read-only audit/check,
API-only startup, preserved API during open/close timer stops, observed vs never
fired jobs, exact transient job identity, failed/nonzero/foreign/source/template
rejection, bounded timeout, final verification before success and honest
refused cleanup when a task remains busy. An independent
owned-loopback PG run checks official schema snapshots, approve/open/close
revisions and source/proof preservation, stale-revision rollback, and an actual
accepted Golf BOT room: closing rejects new launch/room, preserves original
GET/leave authority and leaves zero financial rows and balances. Its explicit
local database name/OID substitutions are isolated test preconditions; no test
is a real root approval or a public/device acceptance claim.
