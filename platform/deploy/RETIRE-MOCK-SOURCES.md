# Retire the two already retired Mock source trees

`retire-mock-sources.py` removes only `/opt/oasis/releases/20261008-23` and
`20261008-24`. It preserves Public09-03/previous09-02, the actual immutable
Production10-03 source, live databases, keys, volumes/networks, ingress/TLS,
effective units and the existing Mock retirement receipts/tombstone. It neither
starts a Mock application nor runs a bootstrap, migration, restore or new game.

The source audit and complete local recovery proof are fixed in the controller,
in addition to the operator's external SHA arguments. The original protected
inventory remains an immutable protected file. A new independently reviewed
inventory explicitly replaces only its references inside the two obsolete
directories. Other original paths cannot be silently omitted.

## Recovery material

Local ignored directory: `platform/review/mock-source-retirement-20261010/`.

| Recovery file | Bytes | SHA256 |
| --- | ---: | --- |
| `20261008-23-complete-reconstructed-v1.tar.gz` | 225837967 | `137a3d0debc4758a1c3ea0f87dd91b28c1769ce91a1cc6de128bf89c32acca1b` |
| `20261008-24-complete-reconstructed-v1.tar.gz` | 225832864 | `f4cd576adf0a4fd2b1c0d53c798decd4d26790a09b078e74588660b596e21a4f` |

Each contains all **9571** remote directory/file/link entries, including the
complete source and `node_modules`; file bytes total 357074806 / 357055737.
These archives were reconstructed from local donors whose actual bytes matched
the root-reviewed remote SHA for each file, plus 71 unique missing bodies
(20075157 bytes) obtained by read-only SSH. They are **not whole-tree network
streams**. No donor archive approves a source. Every final archive was reread to
verify every body SHA/size, uid/gid/mode, nanosecond mtime, typed internal symlink,
full gzip CRC/EOF and exact tar tail. The two actual remote full trees matched
before and after byte-for-byte metadata/SHA snapshots.

`complete-local-archive-proof-v1.json` has SHA
`6fe2c6b0e4092a779653a6c895f3011b03dd54c9e46f16e6757ce2a4149e03bf`;
`source-audit-v1.json` has SHA
`4f49ee228ee1e753f3cf744bdd98e8d9ca53de8f56ed4a2aefe2d100b889b9bf`.
Both remain local 0600 recovery evidence. Partial interrupted network streams
are retained separately and never count as complete recovery material.

Root independently repeated the complete read of both archives. Its
`root-independent-complete-archive-review-v1.json` has raw SHA
`ffde3575ca87dc950bdb1a696f365993491117203a79c0f31d67059107edbd5e`.
This review proves recovery material; it does not approve production deletion.

The operator must independently read back and retain these actual local
recovery archives before approving deletion. The server receives only the
reviewed JSON evidence; uploading both archives would consume the disk being
freed. This does not claim offsite backup. Recovery is a separately authorized
operation: authenticate the complete local archive and actual member proof,
recreate only its original inactive directory, restore POSIX types/uid/gid/mode
and nsmtime, then independently verify every body/link and original manifest.
Never execute archive files or replace an active pin while recovering.

## Inventory and operations

The root-controlled directory is `/opt/oasis/private/mock-source-retirement-20261010`
(root 0700). The externally pinned controller and JSON inputs/checks/reports are
root 0600 regular single-link files directly inside that directory. Every parent
must be an actual root-owned directory with no group/other write access and no
symlink, subject to the one exact existing public-runtime ancestor below. Use
isolated Python without bytecode writes: `/usr/bin/python3 -I -B`.
The controller holds every input/tool/helper's original no-follow FD, checks its
original inode and parent-directory identity, and hashes its original bytes at
each check/apply checkpoint. Same-byte file replacements are refused. Original03
Python helpers are compiled from those authenticated raw FD bytes; the old
operations loader is removed by its exact AST shape and injected with the bound
original provision module. No helper loader or cached bytecode is used.

The sole non-root ancestor exception is `/opt/oasis/private`, an existing
protected public-runtime directory: UID/GID **998/998**, mode **0700**, device
**64515**, inode **934465**. Its ownership or mode must never be changed for this
operation. Every property and the exact path must match; another non-root parent
or even the same directory with different metadata is rejected. This fixed
identity permits only the initial held-file reads. Before loading any helper or
doing a check/action, the controller immediately authenticates the original20
inventory through its original raw FD at
`/opt/oasis/private/production-stage-20261010-v2/protected-reviewed.json`, raw SHA
`ac5c5769946b8ea08695c56d0106bb6c8d1f562b9e7ec152f3e83fb05375eeac`.
All original paths and the inventory's exact protected ancestor metadata must
match. The new inventory retains the ancestor, every original non-obsolete path
and the original inventory itself. Held parent identities are rechecked through
apply. TASK and every other ancestor remain root-owned and strictly checked.

The inventory is a root-approved JSON with these fields:

```text
kind: mock-source-retirement-reviewed-inventory-v1
obsolete_sources: [the exact two absolute allowlisted paths, in fixed order]
explicit_obsolete_archive_review: true
source_commit: actual 40-hex source commit
source_audit_sha256: exact fixed raw file SHA above
archive_proof_sha256: exact fixed raw file SHA above
root_independent_archive_review:
  path: actual root 0600 direct-child independent review JSON
  sha256: exact fixed ffde3575...07edbd5e raw file SHA above
production_release: /opt/oasis/releases/20261010-03
production_manifest_sha256: actual immutable Production03 manifest SHA
helpers: actual Production03's exact five immutable helper SHAs
historical_inventory:
  path: exact original20 path above
  sha256: exact ac5c5769...375eeac raw file SHA above
  obsolete_paths: exactly original paths inside Mock23/24
protected_paths: all other original paths plus original inventory itself
additional_paths: actual production TLS symlinks AND resolved leaf files;
                  other immutable production ingress/source/receipt paths
production_units: exact six Production DB/API/backup/monitor services/timers,
                  plus player certificate service/timer
snapshot: independently reviewed result of capture
```

`capture` is read-only and returns `passed:false` / exit 2: an observation is not
approval. Review its entire snapshot independently, insert it into a new
inventory, and externally pin the resulting inventory SHA. The frozen actual
Production03 helper closure validates the original 20-path inventory, current
owned DB/volume/network and four private pins. No new04 helper or self-declared
backup metadata can replace this authority.

For each mode, supply the actual root-reviewed paths and raw SHA values:

```sh
/usr/bin/python3 -I -B /opt/oasis/private/mock-source-retirement-20261010/retire-mock-sources.py check \
  --inventory /ACTUAL_ROOT_TASK/reviewed-inventory.json \
  --inventory-sha256 ACTUAL_REVIEWED_INVENTORY_SHA \
  --source-audit /ACTUAL_ROOT_TASK/source-audit-v1.json \
  --source-audit-sha256 4f49ee228ee1e753f3cf744bdd98e8d9ca53de8f56ed4a2aefe2d100b889b9bf \
  --archive-proof /ACTUAL_ROOT_TASK/complete-local-archive-proof-v1.json \
  --archive-proof-sha256 6fe2c6b0e4092a779653a6c895f3011b03dd54c9e46f16e6757ce2a4149e03bf \
  --tool-sha256 ACTUAL_FROZEN_CONTROLLER_SHA
```

`apply` adds `--check ACTUAL_CHECK --check-sha256 ACTUAL_RAW_CHECK_SHA --report
/opt/oasis/private/mock-source-retirement-20261010/retirement-ACTUAL_ID.json`.
The report must not exist. Check approval expires after **10 minutes**, including
the deletion checkpoints. Apply holds the original release lock FD (fixed
root644/device64515/inode956423/empty SHA) and the actual root600 operations lock
FD simultaneously, refuses replacement/contention, and repeats every complete
tree, consumer and protected-state check under both locks.

Consumers include process cwd/exe/fd/maps/command references, all Docker binds,
all loaded unit commands, host/shared-proxy configurations, and other release
dependency/pin symlinks. Bind mounts, private source paths, hardlinks, external
symlinks, xattrs or special files refuse retirement. Only exact observed source
inodes are unlinked through no-follow directory FDs; there is no shell deletion
or general recursive-delete API. Active services/DB sessions are never stopped.
A mid-delete failure retains an honest `passed:false` report and the exact list
of fully removed roots; recovery materials remain complete. Successful apply
also verifies protected state and reports actual free bytes before/after.

Later source upgrades must explicitly use this reviewed retirement receipt and
complete archive proof to replace the two obsolete manifest references in a new
protected inventory. The old historical inventory must not be edited or silently
passed to a guard that still expects deleted sources to exist.

`check.external_bindings` records actual raw file SHAs for the tool, reviewed
inventory, original inventory, source audit, complete archive proof and root
independent review. The result receipt adds the separately pinned raw check SHA.
Parsed/canonical JSON digests are separately named `*_canonical_json_sha256` and
must never replace a raw SHA. A successful receipt also binds source commit,
exact two removed names/absolute roots/manifests, both tree/archive SHAs and
sizes, original inventory identity, reviewed snapshot SHA and the observed
absence of both obsolete roots. Root retains all actual inputs and check files.

The pure `validate_retirement_replacement(prior, inventory, receipt, capsule,
proof, review, *, external_sha256)` is reusable by the upgrade controller. It
performs no filesystem/database/network changes and returns `retained_paths`,
the exact two `obsolete_manifest_paths`, `approved_document_sha256` and source
commit. The caller must independently approve, hold/hash and validate root
ownership of all files first; the pure function cannot confer approval. Its
external SHA dictionary has exactly eight keys:

```text
historical_inventory_sha256, inventory_sha256, retirement_receipt_sha256,
check_sha256, archive_proof_sha256, root_independent_archive_review_sha256,
tool_sha256, source_audit_sha256
```

The caller still runs the original20 inventory guard on the unchanged original
document, verifies live retained state, verifies both roots are actually absent,
and explicitly records the authenticated receipt/check/proofs as replacements.
It cannot reuse this function to omit another original path or bypass a live
backend/key/app/DB/source check.

After apply, perform a fresh read-only verification: both exact roots absent;
all other source/public/production links unchanged; original20 inventory and
retirement/tombstone bytes unchanged; all four private pins, actual DB state,
container/network/volume identities and effective services unchanged; ingress,
shared proxy and TLS renewal configuration unchanged; report/input files root
0600 with actual raw SHAs; actual available bytes read back and adequate for the
next release's reserve. The receipt is only source retirement success, never a
new04 deployment or gameplay acceptance result.

## Local checks

```sh
python3 -B deploy/test_retire_mock_sources.py
```

These 23 tests use real temporary tar/gzip bodies, dependency links, checksums,
directory/raw file FDs, same-byte replacements and contending original locks.
They verify poisoned bytecode is ignored, exact raw AST loader closure, private
parent identity, root independent archive review and the pure replacement chain.
They also reject any wrong public ancestor path/UID/GID/mode/device/inode and
missing/tampered original20 authority or retained protection.
Root ownership, consumer/host services, Linux xattrs and external approval pins
are explicitly modeled for macOS; remote snapshots used actual Linux inspection.
They do not execute server deletion or prove production apply succeeded.
