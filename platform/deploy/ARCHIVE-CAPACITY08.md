# Capacity08 reversible release archives

This batch allows exactly `20261008-03`, `20260922-05`, and `20260922-06`.
All produced `release.tar.gz` files are permanently retained beneath
`/opt/oasis/release-archives-capacity08-20261008`. Existing archive batches and
Restic retirement proofs are outside this tool's scope. This is a reversible
same-host archive, not an offsite disaster-recovery claim.

## Frozen recovery tools

The repository wrapper and test are byte-identical to the reviewed and Linux-tested
files. SHA256:

- `archive-capacity08-releases.py`: `8c2efaa7451be1db518332e40ea9bf52d12c7c148ddd3a7a2c316529e353c58e`
- `test_archive_capacity08_releases.py`: `a5dbcf8c969785f1708226d40a6f3d7163df68d3f314130d761164852e555226`
- `archive-releases.py`: `f5f10f2eb95c921419f82259ebe539e3596744cd9eb79bc3701a47771dfaffde`
- `publish-static-assets.py`: `1cb4e709f4a0df001e45ad8f74ab9a57b5f23d385462fef4b53515b538fa5031`
- `release_build.py`: `9b4916b1af64f5dbbf6319c90ddb4d896589dbdf7edafd26c0c3fd5eb8759a23`

An independent persistent copy, its exact adjacent dependencies, test, historical
plan, file hashes and Linux verification evidence were exclusively staged, fsynced,
and atomically installed at:

```text
/opt/oasis/recovery-tools/capacity08-20261008/8c2efaa7451be1db518332e40ea9bf52d12c7c148ddd3a7a2c316529e353c58e/
```

Directories are root-owned mode 0700; files are mode 0444. The verified
`materials.json` SHA256 is
`b70d772327df2f51728f968beb9b36e11ab6b7389fa5da5f99ee833edba81932`.
Recovery does not depend on a surviving temporary fixture or the current release.
The temporary Linux fixture directory was removed only after evidence retrieval,
marker/hash/ownership checks and durable recovery-material verification.

Local and isolated Linux suites each passed all 28 tests with no skips. The same
28 tests passed again after copying the unchanged wrapper/test into `deploy/`.
No production Nginx command, configuration change or service restart was performed.

## Executed archives

Recorded UTC times and allocated bytes, independently read back after each action:

| Release | Action time UTC | Original allocated B | Tar bytes | Archive allocated B | Actual net reclaimed B |
|---|---|---:|---:|---:|---:|
| 20261008-03 | 2026-10-07 22:46:39.541675–22:47:08.661465* | 377495552 | 231932439 | 235020288 | 142475264 |
| 20260922-05 | 2026-10-07 22:49:17.421995–22:49:39.053942 | 346476544 | 214621477 | 217567232 | 128909312 |
| 20260922-06 | 2026-10-07 22:51:47.201460–22:52:09.230945 | 346890240 | 214760499 | 217710592 | 129179648 |

*The first interval includes its fresh check-only; no separate command-start
timestamp was recorded. Raw evidence retains the precise observed bounds.

Total measured directory-allocation savings from the three completed archives:
`400564224 B`. This is the original-tree allocation minus permanent archive
allocation; concurrent filesystem growth means it is not identical to a statvfs
before/after difference.

| Release | Tar SHA256 | Snapshot SHA256 |
|---|---|---|
| 20261008-03 | `1b475bcb4abc37f7016f04218535b1bc80d8eb4c644adfaed46e096692490412` | `d057ef2dda96a304a7b9ff5f08c8e10c04976192ef21f01297731a95ecea9902` |
| 20260922-05 | `f3f1e7c3f95abdb17c66933082976cadebf9fd6c02123ec3840860861549515c` | `7e12e41f8e9f319d9f761fb695db8be7dc3a7bfb26098bcaacfee058f648a5b0` |
| 20260922-06 | `c3c0a3e146472bfb71f34665f995024f48427145e3dbd27908a986a3b0efce11` | `44b6f631214ce14c052ed4de1d5428c1a79964e0b390a40f26ba8247d413d8ec` |

All three source directories and transaction work directories are absent; each final
archive retains exactly identity, receipt, snapshot and tar. Before retirement,
the tool fully read gzip/CRC, checked tar termination, actually extracted the tree,
and compared file paths/types/content/size/ownership/modes/nanosecond mtimes/links
against the source snapshot. It rechecked source hashes, protections and static
coverage before committing retirement.

Independent post-action reads additionally checked all 9,413 / 8,874 / 8,878 tar members and
8,859 / 8,327 / 8,330 file bodies respectively, compressed-file hashes and gzip EOF/CRC. PAX float
mtime was not incorrectly compared with snapshot integer nanoseconds; exact
nanoseconds had already been verified by the actual extraction protocol.

The first archive had 502 fingerprints present in current plus 19 covered by the
fully verified stable store. The second and third had all 126 and 128 respectively
in current. The independent
registry checks covered 636 assets and six anchored receipts; head SHA256:
`60e54969fa40136ae928baf0ea1622afff33030a26e774fd4423f595a0b53837`.
Current `20261008-07`, Mock `20261007-04`, previous `20261008-06`, hot `06/05/04`,
process references and the five observed Nginx/API/demo live/Mock service PIDs and
active states were unchanged throughout all three operations. `20260926-02`
was not archived and remains outside this batch allowlist.

Evidence retained locally:

- `review/release/capacity08-linux-check-20261007T224337Z-7974dacd/`
- `review/release/capacity08-first-archive-20261008-224557Z-3619c8b1/`
- `review/release/capacity08-second-archive-20261008-224914Z-251073a1/`
- `review/release/capacity08-third-archive-20261008-225144Z-0ef09620/`

## Operation and recovery contract

Default operation is read-only `--check-only`; archive/recover/restore requires
exactly one allowlisted release. Never batch-loop retirement. Use the persistent
tool copy with its frozen adjacent dependencies, and perform a fresh check before
any newly authorized archive.

New archives require the frozen current07/Mock04/previous06/hot06,05,04 baseline.
The existing deployment flock and independent batch flock remain mandatory.
Unknown/protected releases, altered sources, corrupted or pending static-store
state, unsafe paths, insufficient space, or failed actual restoration refuse
retirement. The original nine-release allowlist and all older metadata stay intact.

Use `--recover` for an interrupted transaction and `--restore` to reconstruct a
completed archive's missing source. Both retain the tar and refuse to overwrite
an existing release. A later deployment need not revert to current07 for recovery:
recovery uses fresh current/Mock/previous/hot/process protections and permanently
protects the batch's five original baseline versions. It still requires sufficient
space and validated static coverage. Do not bypass a blocked recovery or manually
remove transaction directories.

Archive preparation failures leave the source intact or rename a quarantined
original back. If an interruption occurs after the final verified archive has been
committed, the verified tar remains the recovery material; original-directory
cleanup may be incomplete. The durable restoration marker and exact snapshot
comparison govern resumed cleanup. No command activates the restored release.

## Separate capacity gates

Archive scratch uses the existing 3 GiB reserve; it may cross the 85% warning
while compressing and really restoring. The later release-deployment **85% limit
is unchanged and remains mandatory**, together with its own 3 GiB floor.

At the final independent readback (2026-10-07 22:52:30 UTC), available space was
`6722572288 B` of `41882943488 B`. A hypothetical 410 MiB additional publication
peak leaves `6292656128 B` free, about 84.975612% used. The point-in-time margin
below 85% is only `10214604.8 B` (about 9.74 MiB). This is **not a next-deployment
PASS**: concurrent filesystem growth already differed from measured directory
savings. The actual package/clone/backup/static-publication/transfer budget and
fresh free space must pass the unchanged 85% and 3 GiB gates immediately before
staging and publication. All three authorized source directories have now been
archived; there is no further candidate in this batch. `20260926-02` remains a
read-only assessed fallback, not part of this allowlist or execution authority.
