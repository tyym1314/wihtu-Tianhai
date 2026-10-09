# Isolated production instance

This creates a new production database and API while Public03 remains sandbox. It never promotes the sandbox database, copies its identities/balances/master key, writes Nginx, requests certificates, changes the public release pin, or restores the retired Mock service. It does not claim production admission, a wallet partner, mobile acceptance, performance capacity, or launch approval.

## Fixed ownership and prerequisites

| Resource | New isolated owner |
| --- | --- |
| API | `oasis-production-api.service`, loopback `18891`, UID/GID `oasis-prod` |
| Database | `oasis-production-postgres`, dedicated labeled volume `oasis-production-pgdata`, dedicated internal network `oasis-production-internal`, loopback `18893` |
| Roles/database | `oasis_prod_owner` for root operations; non-superuser/non-createdb/non-createrole/non-replication `oasis_prod_app`; database `oasis_production` |
| Runtime | `/opt/oasis/production-current` points to the root-provided immutable release |
| Private tree | `/opt/oasis/production-instance-private`, root:`oasis-prod` 0750; state UID-owned 0700/master 0600; runtime/Postgres/operator credentials root 0600 |
| Backup/restore | `/opt/oasis/production-backups`, root 0700; separate real drill database with confirmed OID; private restore evidence in `restore-drills` |
| Monitoring | own backup and monitor services/timers; dedicated stage TLS leaf `.../live/oasis-production-player/fullchain.pem` and `oasis-production-player-certificate.service/timer` |

The tool requires Linux root, cached PostgreSQL **16** immutable image ID, `/usr/bin/node`, release `node_modules` installed from its bound lockfile, Python `dbus` (the existing system package), Docker/systemd, and the existing `/opt/oasis/private/release.lock`. It never installs packages/pulls images or creates a replacement shared lock.

After a 1 GiB minimum declared initial DB/backup budget, free storage must retain at least **3 GiB and 15%**. This checks the isolated seed footprint reserve; root must separately account for release clones, growth, concurrency and retention before wider admission. Daily backups do not automatically delete earlier backups. The current first-party boot is tiny; a long-running funded platform needs a root-reviewed retention/capacity policy before expansion.

## Read-only capture and review

Create a root-owned 0600 JSON input with this shape. No password, token, environment contents or certificate key bytes belong in it:

```json
{
  "kind": "production-protected-inventory",
  "current": "/opt/oasis/releases/20261009-03",
  "previous": "/opt/oasis/releases/20261009-02",
  "retirement_receipt_sha256": "931dfadda3577244b434ee86c74f95cf3e66053362ff61ac10f207d69737c920",
  "paths": ["all entries in provision.REQUIRED_PINS, plus any independently identified public pins"]
}
```

`paths` must contain **each literal `REQUIRED_PINS` entry**, not the explanatory placeholder above. These include the actual public master `/opt/oasis/private/state/master.key`, Postgres env `/opt/oasis/private/postgres.env`, current/last-release/static head, Public02/03 and Mock23/24 immutable manifests, the preserved public backup, all three completed/historical retirement receipts, public and Mock vhosts, and Mock leaf certificate symlink plus its resolved regular leaf. Public master/Postgres hashes and final Mock receipt are also independently fixed to the root's recorded live metadata. The parent `/opt/oasis/private` must remain UID/GID 998 mode 0700; the provisioner never changes it.

```sh
/usr/bin/python3 -I -B /secure/staging/provision.py capture \
  --protected-inventory /secure/staging/protected-input.json > /secure/staging/capture.json
```

Capture performs read-only filesystem fingerprints (including the preserved backup members), loaded public service/process identities, exact shared Docker IDs/images/mounts/networks, host/proxy Nginx hashes, a read-only public pending-obligations snapshot, strict HTTPS Public03 health/demo and four retired Mock410 routes. It creates no guest/session/room or secret. Review this output independently, save it as the new **protected inventory** (it contains `snapshot`), pin its SHA externally, and keep the initial input/capture evidence. Check refuses an unreviewed inventory without a snapshot; an inventory observation is not apply authorization.

## Final-release check and guarded apply

These parameters come from root's actual final release/package and local cached image inspection, never from an invented future source version:

```sh
/usr/bin/python3 -I -B /secure/staging/provision.py check \
  --protected-inventory /secure/staging/protected-reviewed.json \
  --release /opt/oasis/releases/ACTUAL_FINAL_RELEASE \
  --manifest-sha256 ACTUAL_FINAL_MANIFEST_SHA256 \
  --pg-image sha256:ACTUAL_CACHED_POSTGRES_16_IMAGE_ID \
  --origin https://oasis-player.43.98.202.236.sslip.io \
  --capacity-budget-bytes 1073741824 > /secure/staging/check.json
```

Only after root has reviewed that exact `passed:true` check (fresh **0–600 seconds**, external file SHA), run the **same inputs** with mode `apply` and these extra flags:

```sh
  --check /secure/staging/check.json \
  --check-sha256 ACTUAL_EXTERNAL_CHECK_SHA256 \
  --create-isolated-production-closed
```

The source controller and five helpers must match the **actual final release manifest**. All runtime-importable source/schema/config members are verified; root's release tooling owns the complete media/build output verification. Existing new-namespace paths/UID/units/containers/volume/network/ports cause refusal; the tool never adopts an unknown partial installation. It holds the shared release lock, repeats protected guards at phase boundaries, validates fixed IDs/labels and sole consumers, pins secrets by hash/inode/mode, and pins complete unit disk/effective command metadata on one persistent systemd D-Bus sender. Unknown loaded commands, drop-ins, transient/control consumers, bind mounts or symlinks are refused before unit start/stop.

Apply sequence: exclusive namespace → fresh random secrets and dedicated role → empty-database bootstrap → real dump → real restore/ledger/AES-GCM/production identity verification → confirmed own drill cleanup → exclusively authored units → loopback production readiness → actual monitor report → `complete_closed` receipt. It creates exactly one real operational `operator` administrator (fresh credential only in root 0600 file) and one actual platform-owned paused App. It does **not** import the listening API/seed during bootstrap. The administrator is inserted before the first API boot so the existing default seed cannot write development credentials. The App uses the official `createApp`/platform-wallet path, enables only the 11 arena games, allows the explicit stage and stable HTTPS origins, and has zero treasury/ledger/player/session/transfer records. No reference wallet, fake player, funding, external partner credential, or admission bypass is created.

## Evidence and failure behavior

Root must independently read back `receipt.json`, `bootstrap.json`, actual unit/PID/UID/Docker identities, loopback readiness, unchanged Public03/02/Mock410/shared dependencies, the real backup `SHA256SUMS`/`runtime-identity.json`, and successful restore evidence with `database_removed:true` and `temporary_removed:true`. A local fixture pass or receipt alone is not actual remote success. A missing stage cert/producer/HTTPS ingress remains an explicit failed monitor probe until root provisions the actual stage ingress; no borrowed sandbox status is substituted.

On an error, receipt history is retained and only proven authored units and the fixed owned PG container are stopped. The tool does **not** delete the volume, reset the DB, overwrite failures, touch shared images/data, or rerun bootstrap. If ownership/effective stop commands have drifted it refuses that unsafe stop; root must independently inspect the concrete phase/resources. There is no general resume/adoption mode. Actual failed evidence and partial owned resources must be reviewed for a narrowly bound recovery.

Manual root operations (all scope-bound to the installation marker, source manifest, immutable container/network and volume creation identity; never live DB drop):

```sh
/usr/bin/python3 -I -B /opt/oasis/production-current/platform/deploy/production-instance/operations.py backup
/usr/bin/python3 -I -B /opt/oasis/production-current/platform/deploy/production-instance/operations.py restore \
  --backup /opt/oasis/production-backups/ACTUAL_TIMESTAMP
```

Operations serialize on a private root-only lock. Restore checks every backup checksum, the exact three-member non-link private archive, production runtime/database/owner/container/source identity, schema/ledger scope invariants and actual backup-key decryption. Only the exact new root-owned drill DB/OID with zero consumers may be dropped; no `FORCE`, session termination, live-DB rename/drop or pre-existing drill adoption is used. The tool assumes host root/DB superuser is the trusted authority; it cannot promise protection against a malicious root changing resources between instructions.

Runtime/master/operator pins intentionally remain frozen to this **closed** phase. Root's later controlled admission/origin/credential change must use independently reviewed fresh identity and acceptance evidence and update the associated pins through a separate scoped phase; editing the env alone makes future backup checks refuse. It is not safe to silently accept a new secret or point at a different database. Root owns staged HTTPS, real first-party account creation, zero-balance free-practice validation, stable-origin migration, physical Android/APK and actual funding/partner integration. Legacy probability games remain blocked by existing production math admission.

## Local checks

```sh
python3 -B platform/deploy/production-instance/test_production_instance.py
node --test platform/deploy/production-instance/production-instance.test.mjs
```

These are only local adversarial temp-FS/synthetic protocol/real encryption tests. They cover bind mounts, links/hardlinks, umask, foreign containers/volumes/networks, image/port/pin drift, wrong runtime scope, restore interruption/unknown CREATE/foreign DB/active consumers/OID replacement, private archive rejection/cleanup, fresh checks, effective systemd commands/reference lifecycle, dedicated monitor dependencies, no seeded money and strict production master decryption. They do not run Docker, SSH, systemd, a browser, an API, or a production database.
