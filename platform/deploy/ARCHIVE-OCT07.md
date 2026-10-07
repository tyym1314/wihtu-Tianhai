# October 7 release archive batch

`archive-oct07-releases.py` handles exactly `20261007-01`, `20261007-02`, and
`20261007-03`. Its archive root is `/opt/oasis/release-archives-oct07`; each completed
version has its own `release.tar.gz`, `identity.json`, `snapshot.json`, and
`receipt.json`. **This batch permanently retains its tar files.** It has no Restic
migration or tar deletion operation. An unexpected `storage.json` refuses recovery
instead of redirecting to the original nine-release tools.

The entry point subclasses the adjacent `archive-releases.py` `Archiver`. Both
files are required recovery material and must be delivered and hash-verified
together. The original tool, its nine-entry `ALLOW`, `/opt/oasis/release-archives`,
and `/opt/oasis/release-dedup-pilot` metadata and proofs remain unchanged. The new
entry point compiles its dependency without writing Python bytecode, including
for help and read-only checks.

## Protocol and limits

The inherited protocol takes the existing `private/release.lock` and this batch's
separate `.lock`. It excludes current, Mock, previous, the latest three unpinned
releases, and process references through cwd, exe, command line, maps, and file
descriptors. Every fingerprinted resource found in the source tree, including
files omitted by the release manifest, must still exist with identical bytes in
the current release. The archive stays on the same filesystem as the release.

Before moving the source, the tool records the complete tree, verifies its release
manifest, compresses it, and **really extracts the tar** into its own verification
directory. It compares paths, types, bytes, sizes, UID/GID, modes, nanosecond mtime,
and internal symlinks. ctime is checked for source mutation but cannot be preserved
by restoration. External links, extended attributes, special files, and private
paths are refused. It rechecks source identity/content, static coverage and
protection before and after the source is quarantined. Tar and metadata are
fsynced before moving the source; the existing rename and recovery durability
steps are unchanged. The original directory is reclaimed only after these checks.

Available space uses `statvfs.f_bavail`, retaining at least **3 GiB** beyond the
conservative tar, extraction and metadata bounds. A separate extraction budget is
checked during recovery. A batch is refused if its measured archive would not
save space. `reclaimed_bytes` is net of retained archive allocation, not merely
the old directory's size. Re-read filesystem availability after every operation;
other services can change free space during the measurement.

This is a same-host reversible archive, **not offsite disaster recovery**. A second
copy is not required by this existing same-host protocol, but loss of the host or
its filesystem can destroy both current releases and archives. Existing Mac and
Restic proofs for the separate nine-release batch do not certify this batch.

## Commands

Run on the authorized Linux host as root from a directory containing both tools.
Do not wrap these commands in another deployment flock: mutations acquire their
own locks. The CLI cannot override the base path, reserve, or release allowlist.

```sh
python3 archive-oct07-releases.py --check-only
python3 archive-oct07-releases.py 20261007-01 --check-only
python3 archive-oct07-releases.py 20261007-01 --archive
```

No option means check-only. Checks do not create the archive root, lock files or
transactions. Mutations require one exact version. Inspect its measured result,
the current protection state and free space before executing the next version;
this per-operation check adds no new user approval requirement to already
authorized maintenance. The CLI never archives all three automatically. Results include this
tool's precise `recover_command` and `restore_command`.

```sh
python3 archive-oct07-releases.py 20261007-01 --recover
python3 archive-oct07-releases.py 20261007-01 --restore
```

`--recover` resolves an interrupted `.work-<release>` or final-directory
transaction. It may restore a quarantined source, roll back incomplete preparation,
or finish a previously verified restore's cleanup. A complete archive without an
interruption returns `already_archived`. `--restore` explicitly restores the
complete version into its absent original release directory and retains the tar.
Neither command overwrites an existing release or switches live traffic. If
restore fails or available space is insufficient, keep the archive and transaction
evidence and inspect the fixed error; do not delete transaction directories by hand.

## Validation

The local regression suite is `python3 -m unittest discover -s deploy -p
'test_archive_oct07_releases.py'`. It covers the exact scope and independent paths,
unchanged original nine-release metadata/proofs, real compression and extraction,
all inherited protection channels, both locks, source/coverage/pin changes,
verification failure before source removal, the exact 3 GiB space boundaries,
interrupted quarantine/restore, permanent tar retention and invalid retirement
state refusal. The original archive suite should also pass unchanged.

Local fixtures are not a real-host execution record. Independent review and a
Linux fixture with Linux ownership/symlink timestamp behavior must complete before
the first real archive operation. No real archive or space-saving
claim is implied by the presence of this tool.

## Execution record: 2026-10-08

The new 12-test suite and unchanged 19-test suite passed locally and on the Linux
host; independent source review passed. Releases `20261007-01` and `20261007-02`
were then archived individually with real extraction verification. Net reclaimed
allocation was **276,107,264 bytes**, with both tar files permanently retained.
`20261007-03` remains in place. Post-operation available space was 6,742,315,008
bytes (83.902% used); this is the pre-candidate measurement, not the next release's
post-deployment capacity result.

Both service health checks passed after each archive. Current `20261008-04`, Mock
`20261007-04`, private release/static-head hashes and all 47 original nine-release
JSON evidence files were unchanged. Local ignored evidence is in
`review/release/oct07-{before,after01,after02}-20261008.json` and the two
`oct07-archived-*-20261008.json` receipts. These same-host archives do not establish
offsite recovery.
