# Capacity release archive batch

`archive-capacity-releases.py` handles exactly `20261004-01` and `20261008-01`.
Its separate archive root is `/opt/oasis/release-archives-capacity-20261008`.
Each completed release keeps `release.tar.gz`, `identity.json`, `snapshot.json`,
and `receipt.json`. **The tar is permanently retained.** There is no retirement,
Restic migration, pruning, or archive deletion mode. An unexpected `storage.json`
refuses recovery, including a symlink, instead of redirecting to another tool.

The entry point subclasses the adjacent `archive-releases.py` `Archiver` without
changing its original nine-release allowlist or the separate October 7 batch.
Both Python files must be preserved and hash-verified together for recovery.
Loading the dependency does not create bytecode, including for help and checks.
Existing original-batch archives, Restic evidence, October 7 archives, private
state, database files, backups, and the damaged September 22 transfer tar are
outside this batch's write scope.

## Verification and protection

The inherited protocol holds the existing `private/release.lock` and this batch's
own `.lock` for every mutation. It rechecks current, Mock, previous, the latest
three unpinned releases, and process references through cwd, exe, command line,
maps, and file descriptors. A failed read of required process state refuses the
operation. A read-only check is an observation; it is repeated under the locks
before any archive operation.

Every fingerprinted resource in the complete source snapshot, including files
outside its release manifest, must physically exist in current with the same
SHA-256. This batch does not add a stable-store fallback. Stable-store coverage
alone is insufficient for this check.

The tool verifies the release manifest, compresses the complete source tree, and
really extracts the resulting tar into a separate verification directory. It
compares paths, types, bytes, sizes, ownership, modes, nanosecond mtime and internal
symlinks. ctime detects source mutation but cannot be preserved on restoration.
External links, special files, extended attributes, and private paths are refused.
Source identity, contents, protection, and static coverage are checked again
before and after the source is renamed into quarantine.

Tar and metadata are fsynced before that rename. The inherited directory fsync,
quarantine rollback, and interruption recovery steps remain unchanged. The source
tree is reclaimed only after complete extraction verification and durable archive
publication. Recovery fsyncs the restored tree before publishing it. An existing
release is never overwritten; interrupted restore cleanup resumes only after the
already-published source matches the archive snapshot.

Archive and releases must share a filesystem. The tool retains at least **3 GiB**
of `statvfs.f_bavail` beyond conservative tar, extraction, and metadata bounds.
Recovery checks its separate extraction budget. A completed archive must save
space. `reclaimed_bytes` is original allocated bytes minus retained archive
allocation; it is not the size of the original directory or a compression estimate.

These are same-host reversible archives. No independent host or disaster-recovery
copy is established by this tool. Existing Mac/Restic proofs for other batches
do not certify this batch.

## Commands

Run as root on the authorized Linux host, with both Python files adjacent. The
CLI cannot override the base path, reserve, or allowlist. Do not take an outer
deployment flock: the tool acquires the shared and batch locks itself.

```sh
python3 archive-capacity-releases.py --check-only
python3 archive-capacity-releases.py 20261004-01 --check-only
python3 archive-capacity-releases.py 20261004-01 --archive
```

No option means check-only. Checks create no archive directory, lock file, or
transaction. Mutations require one exact release; there is no automatic batch
mutation. Inspect the measured net saving, filesystem availability, pins and
service health before the next release. Results provide this entry point's exact
recovery and restoration commands.

```sh
python3 archive-capacity-releases.py 20261004-01 --recover
python3 archive-capacity-releases.py 20261004-01 --restore
```

`--recover` resolves interrupted work, including a quarantined source or a
partially completed restore. An uninterrupted completed archive returns
`already_archived`. `--restore` restores a completed archive into its absent
original release path and retains its tar. Neither command changes traffic pins.
On failure, preserve the archive and transaction evidence; do not remove work
directories by hand.

## Capacity decision before release 06

The read-only preflight on 2026-10-07 UTC found both candidates outside current,
Mock, previous, recent-release and process protection. Their complete manifests
passed. Current physical files covered 346 fingerprints from `20261004-01` and
453 from `20261008-01`, with no missing or mismatched hashes. The respective
temporary upper bounds were 827,087,555 and 838,967,226 bytes, in addition to the
3 GiB reserve. These observations do not replace a fresh locked check.

The root task's readback after the separate October 7 archive had total
41,882,943,488 bytes and available 6,490,832,896 bytes. The monitor uses
`100 * (1 - available / total)`, yielding 84.5024%. Its strict below-85% boundary
requires more than 6,282,441,523.2 available bytes. An independent copy equal to
the then-current release's 377,634,816 allocated bytes would require at least
**169,243,444 additional net bytes reclaimed**, before new transfer, stable-store,
backup, metadata, or other concurrent growth. This is a baseline estimate, not a
measured release-06 footprint. Activation takes a fresh backup, which also needs
space and must be included.

Do not declare deployment capacity from the two source directory sizes or past
compression ratios. After each archive, use its actual receipt and a fresh
filesystem readback. Then measure the actual candidate, delta, new store assets,
and backup allowance before staging and activation. Preserve the 3 GiB reserve
and the unchanged monitor threshold. If the resulting budget is insufficient,
stop rather than widening this allowlist or deleting other evidence.

## Validation

From `platform`:

```sh
python3 -B -m unittest discover -s deploy -p 'test_archive_capacity_releases.py'
python3 -B -m unittest discover -s deploy -p 'test_archive_releases.py'
python3 -B -m unittest discover -s deploy -p 'test_archive_oct07_releases.py'
```

The dedicated fixtures cover both exact candidates, real compression and
extraction, metadata and internal-link restoration, unchanged original and
October 7 evidence, all inherited protection channels, both locks, source and
coverage changes, failed verification, reserve boundaries, interrupted recovery,
permanent tar retention, and retirement-state refusal. Local fixture results
alone do not authorize or prove a real archive operation. Independent source
review and Linux fixture validation precede execution on real releases.

## Execution record: 2026-10-08

The capacity, original, and October 7 fixture suites passed **43/43** locally and
on Linux. Uploaded sources matched the local hashes. Independent source review
confirmed that the new wrapper changes only the exact allowlist, separate archive
directory, and entry-point names; the archive protocol is unchanged.

Both candidates then passed fresh checks and were archived individually, with
real unpacking and full verification before each source was reclaimed:

| Release | Permanently retained tar bytes | Net allocation reclaimed |
|---|---:|---:|
| `20261004-01` | 228,828,453 | 135,839,744 |
| `20261008-01` | 230,641,627 | 139,235,328 |

Total net reclamation was **275,075,072 bytes**. Final available space was
6,754,164,736 bytes, or 83.8737% used, before staging release 06. Both health
checks returned 200. Current `20261008-05`, Mock `20261007-04`, private
release/static-head hashes, all 47 original JSON evidence files and all three
October 7 archives remained unchanged. The first capacity archive also remained
unchanged through the second operation.

Ignored local receipts and readbacks are in
`review/release/capacity-{before,check}-20261008.json`,
`capacity-{archived,after}-20261004-01.json`, and
`capacity-{archived,after}-20261008-01.json`. This is a pre-deployment capacity
measurement and same-host recovery evidence; it does not prove offsite recovery
or the capacity remaining after another release and backup.
