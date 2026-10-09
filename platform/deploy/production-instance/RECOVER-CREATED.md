# Recover the witnessed Created instance

This controller is restricted to the failed creation of 20261010-01. It accepts
only container `2ee98b7bb89bb14a0772f5bed1b6783024241664c367531ee6b52fc22fd86af6`,
owner `f35571b2005dbe05ee68a41e72d11b75`, UID 997 / GID 999, the exact original
failed receipt, marker, empty volume inode and network identity. The container
must still be Created, never started, with restart count zero. No production
API, service, bootstrap, release pin, backup or process using UID 997 may exist.
The public current03, previous02, PostgreSQL, master key, static assets, backup,
retired Mock 410 routes and all 20 reviewed public pins must remain unchanged.

20261010-01 has been retired. Its source provenance comes from the separately
verified local full archive, the retained root-private original manifest and
five helper files, and the immutable retirement receipt. Recovery never tries
to execute or resolve the retired release. The only destination is immutable
20261010-02; its manifest must contain the executing recovery controller and
the official provision/operations/bootstrap/backup verification/monitor helpers.

The fixed historical receipt is:

```
/opt/oasis/private/production-stage-20261010-v2/retired-source/retired-source.json
SHA256 38ca2031bde2841e4986d23990c5a1991e6aed80f1def613393b8b319cd8d073
```

Its sibling `RELEASE-MANIFEST.json`, `marker-original.json`,
`receipt-original.json`, and `helpers/{provision.py,operations.py,bootstrap.mjs,
inspect-backup.mjs,monitor.mjs}` must retain the receipt's inode and hash pins.
All evidence files are single-link root:root 0600 regular files in root:root
0700 directories. Secret contents are never printed or passed through argv.

Run `check` with explicit `--release`, `--manifest-sha256`,
`--protected-inventory`, `--retired-source`, `--retired-source-sha256`,
`--origin`, and `--pg-image`; save stdout into a new root:root 0600 file.
`apply` requires the same arguments plus `--check`, its independently computed
`--check-sha256`, and `--recover-exact-created-closed`. The check expires after
600 seconds. An existing global deployment lock is verified by pathname and
opened FD identity before and after its nonblocking flock, and again before
success. Check state is recomputed while holding that lock.

Apply creates the exclusive directory
`/opt/oasis/production-instance-private/recovery-created-20261010`. It preserves
raw original marker and failed receipt bytes, the source-retirement receipt and
the check. The original `production-instance-private/receipt.json` remains
unchanged. New progress and any failure go to the recovery directory's own
`receipt.json`; it cannot be overwritten by another invocation.

Only the installation marker's release and manifest fields advance. The
original owner, resource IDs, private file inode/hash pins and master key remain
unchanged. The witnessed empty monitor directory is repaired from 0700 to 0750
through its verified original FD, with before/after identity recorded. Recovery
directly starts the existing exact container once, without retrying that action.
After bounded readiness probes it requires normal assigned-network ownership
before creating the unprivileged application role using the original runtime
password through private stdin. The official empty-production bootstrap then
creates one paused application and operator, zero players and zero funded coins.

Official backup and actual isolated restore must pass, including removal of the
owned restore database and temporary key files, before units are installed.
Effective loaded unit commands and dependencies are checked before enabling
the production API and timers. The official database oneshot's `ExecStart`
idempotently adopts the already running exact container. Local production
readiness and monitor execution must succeed. Admission stays closed; ingress
activation, partner credentials, real credit and device acceptance are separate
steps. No general provision apply, account creation, new secrets, Docker
resource creation or volume deletion occurs.

Failure records the primary error and performs only the official guarded stop
of owned API/timers and the exact database container. It does not delete data,
restore the old marker, rewrite original failed history, adopt another instance
or automatically retry a partially completed recovery. Another failure needs
new independent readback and a separately reviewed recovery decision.

Local validation:

```
python3 -B -m unittest discover -s platform/deploy/production-instance -p test_recover_created.py -v
python3 -B -m unittest discover -s platform/deploy/production-instance -p test_production_instance.py -v
```

These tests use synthetic contracts and temporary files. Optional saved actual
server-evidence fixtures validate the original and retirement schemas without
contacting the server. They do not prove an actual recovery, backup, restore,
production API or public ingress success.
