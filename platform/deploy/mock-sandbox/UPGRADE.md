# Running Mock upgrade: exact 20261007-04 → 20261008-05

`upgrade.py` is a separate, root-operated controller for this one transition. It does not extend `install.py` or the unstarted-stack repair. Adding this tool does not upgrade the running Mock. The public platform release and the Mock release remain independent.

The target manifest is pinned to `b5ae243cf9860cd8323783422459811ff3efb13ff41ba3342084f9ae50ca78db`; its reviewed source commit is `12e453a67236a0539c23c68eac1b057e7cec808a`. The old release must be `/opt/oasis/releases/20261007-04`, with its entire manifest matching the existing root-owned installation marker. The target must be `/opt/oasis/releases/20261008-05`. Neither path can be replaced by `current`, a user-supplied release, or a symlink.

## Commands and trust boundary

An operator must first verify this controller's published SHA and its adjacent, unchanged `install.py`. Keep both in a root-controlled directory outside the two immutable releases. Do not insert the new controller into the already published `20261008-05` tree. The controller checks the adjacent installer's bytes against the old manifest; the same installer is required in the new manifest. Recovery requires the same controller and dependency bytes that created its journal.

```sh
# Example operator-controlled tool directory, not a new application release.
python3 /root/verified-mock-upgrade/upgrade.py
python3 /root/verified-mock-upgrade/upgrade.py check-only
# Only after every check passes and a quiet Mock acceptance window is reserved:
python3 /root/verified-mock-upgrade/upgrade.py apply
# Reconcile an interrupted apply to its original release, retaining all evidence:
python3 /root/verified-mock-upgrade/upgrade.py recover
```

No mode takes an alternate host, origin, database, release, command, or credential. There is no SSH implementation. Default `check-only` takes existing advisory locks but creates no file, starts/stops no service, settles no obligation, and modifies no database row. It executes the existing isolation preflight (including its rolled-back advisory-lock challenge) and read-only queries against the **Mock** database. The preflight is the only component that reads the live runtime for the established isolation comparison. Reports never print credentials, key bytes, SQL rows, tokens, configuration contents or database URLs.

`apply` and `recover` hold the existing `/opt/oasis/private/release.lock` and `/run/lock/oasis-android-mock-install.lock`, using nonblocking exclusive `flock`. They do not create replacement lock files. The existing Mock network lock additionally guards the pin/marker change. It is released before systemd startup, whose existing network dependency may acquire that lock. Root ownership, regular-file identity and no hard links/symlinks are required. All privileged writers must respect the same lock protocol; this is not a defense against a concurrent hostile root process.

## Preflight and cache gate

Both manifests are fully verified against actual regular files. Runtime/schema/authority sources, package manifests/locks, the Mock tooling, and demo-host source must be identical, except two exact reviewed source hashes: the Run POST receipt addition in `server/pvp/index.mjs` and new `shared/run-action-receipt.mjs`. Explicit frontend-only Run modules can differ. The tool compares the entire installed `platform/node_modules` tree by file bytes, executable modes and internal symlink targets, rather than trusting `package-lock.json` alone. External dependency symlinks are rejected. This controller does not approve general additive migrations.

The existing marker and Mock pin must agree. The existing isolated container/volume/image, UID, private container address, nftables fingerprint, proxy files and active infrastructure must match. Installed API/demo unit bytes, selected systemd unit fragments/drop-ins and the dedicated Mock Nginx configuration must match the existing templates. No Nginx configuration or global static store is changed. Existing isolation preflight runs before stopping and before each new/old startup.

Static compatibility is checked in **both directions** against actual release directories, including unmanifested files. It compares all non-HTML files in the platform, Arena, legacy output trees, public assets and partner-host public assets. This includes hashed chunks and unhashed textures, GLB dependencies, fonts and media. HTML is the entry document; it can change. Missing or changed dependency bytes appear under `forward_assets` / `rollback_assets`, set `apply_allowed: false`, and make `check-only` exit 2. `apply` rejects before creating a journal or stopping anything. Comparing all dependencies conservatively can reject harmless media changes; the tool never assumes those changes are compatible.

**Known unresolved gate:** the independent Mock route serves its own pinned release, with no public platform static-store fallback. New 05 chunks are absent from 04, so cached 05 pages cannot be promised a safe rollback to 04. The tool intentionally rejects this condition. The real read-only check recorded below confirmed the blocker; no upgrade has been performed. The comparison also cannot establish that every dependency referenced by an old already-broken bundle exists; full browser/device acceptance remains necessary.

The smallest follow-up is a separately reviewed **Mock-specific** immutable asset namespace containing the verified union of both releases, with conflict refusal, exact body/receipt hashes and safe read-only fallbacks for both pin values. Its routing must remain inside the Mock origin, preserve API routing and isolation, and prove both directions by actual HTTP reads before a revised controller accepts that configuration. The current controller rejects a changed Mock Nginx template; it contains no bypass flag. Another option is a new, explicitly identified rollback release containing a verified union, which requires a separately reviewed transition and new pins. Do not mutate immutable 04/05 directories, silently use the live global store, or equate clearing one test device's cache with compatibility for all cached clients.

## Business state, backup and transition

The Mock must already be running. The read-only database snapshot checks the existing eleven ledger/integrity/settlement audit counts, pending probability presentations (including remaining free rounds), integration jobs, reservations, unsettled wallet matches/probability authorizations and reserved/pending balances. Any nonzero obligation refuses apply; the tool does not auto-complete, expire, acknowledge or cancel it. Operators arrange a quiet Mock window without concurrent APK/browser testers. There is no new network maintenance gate in this controller.

After the checks, only `oasis-android-mock-demo` and `oasis-android-mock-api` are stopped. The database, socket proxy, network rules, certificate timer, live services and Nginx are not stopped/reconfigured. A second read-only, repeatable-read snapshot establishes the stopped baseline: selected application, room and wallet tables by row count and deterministic row digest, plus actual public column/index definitions and the complete audit. The six existing configuration/key files and live pin/runtime fingerprint are bound privately. Any obligation discovered in the stop race restarts the original application without clearing it.

The private journal and backups live at:

```
/opt/oasis/android-mock-private/upgrade-20261007-04-to-20261008-05/
  journal.json
  backup/database.dump
  backup/private-config.tar
  backup/receipt.json
```

The new work/backup directories are mode 0700 and their files are 0600. The existing private root retains the installer's actual `root:oasis-mock` 0750 layout; the group is checked against the account's GID, not its UID. The marker remains root-only 0600 and `state`/keys retain their existing owners. `pg_dump -Fc` runs **inside only** `oasis-android-mock-postgres` against `oasis_android_mock`, without a password in arguments. It has a 180-second output deadline and size/space bounds. The dump is checked using `pg_restore --list`, and its bytes/TOC digest are recorded. This is **not** a real database restore drill or an off-host backup. The full Mock private directory (including the original marker and private static cache) is archived, excluding only this controller's own work directory. The resulting tar is reread to check file contents, types, owner/group and modes. The original secret/key/config files are neither regenerated nor restored/overwritten.

The initial space budget includes twice the database size, private backup sizes/header overhead and a 64 MiB allowance; at least **3 GiB remains reserved**. Space is checked again during dump writes and before private archiving. Exhaustion stops the transition and retains partial backup evidence. The backup and receipt are fsynced before the durable `backed_up` journal. Backup digests are revalidated before switching and during recovery. There is no automated backup deletion or retention pruning.

The atomic Mock symlink and atomic marker replacement are individually journaled and parent directories fsynced. Both are validated before the two application units start using their unchanged isolation guards. Successful startup requires local API readiness, wallet health, demo HTML and certificate-verified public Mock health. These are read-only requests and do not create a new guest. The actual schema must still match the stopped baseline, all six integrity/ledger counts must be zero, and private hashes, infrastructure identity and live boundary must match. Business row/pending changes after startup are recorded as `business_changed_after_start`, not labeled proven legal or grounds for destructive rollback. A healthy, structurally consistent new runtime continues running, even when a player has opened a new pending game. The tool does not overwrite the database to reproduce a quiescent snapshot.

## Interruptions and recovery

The durable phases are `prepared`, `stopping`, `stopped`, `backing_up`, `backed_up`, `switching`, `pin_switched`, `marker_switched`, `starting`, `healthy`, and `complete`. Recovery records `rolling_back`, `rollback_healthy` and `rolled_back`. A crash between the symlink and marker replacements is explicitly supported: each must independently be the journal's exact old or new value. Foreign values, changed manifest/dependencies/configuration, changed private keys, corrupt completed backups or a different container identity refuse automated recovery.

For an incomplete transition with no new business changes, recovery stops only the two Mock application units, verifies the recorded business baseline if one exists, restores the old pin and **the original marker bytes**, repeats isolation checks, and starts/readbacks the old applications. It never restores/drops/recreates the database, changes a wallet balance, or replaces private configuration.

Before stopping anything, recovery checks for business changes and the exact current marker/pin pair. If the matching new runtime already has changed business state, or a durable `healthy` observation, it checks/starts that same version and commits completion only after health, schema, integrity and fixed-boundary checks. It does not stop a running new runtime merely because those verification checks fail; it leaves the runtime/data/journal for inspection and subsequent recovery. If a new operation commits during the observation-to-stop race, recovery restarts and verifies the exact currently matching version, whether new or already restored old, rather than leaving that previously healthy service stopped. Startup failure without changed business data can still restore the old version. After the old version is restored, fresh activity is likewise allowed once health/schema/integrity pass; interruptions around `rollback_healthy` preserve the restored healthy service rather than repeatedly stopping it. Verification failure is not a successful upgrade or proof that new business changes were valid.

Repeating `apply` after any journal exists is refused. Repeating `recover` after `complete` or `rolled_back` only verifies the corresponding pin/marker, retained backup, fixed boundaries, infrastructure and health; it does not reverse a successful upgrade or require ordinary later user activity to match the old baseline. A failure before a valid first journal is durable leaves the private work directory for manual inspection; the tool will not guess its origin or delete it. There is no automatic retry of an upgrade and no general-purpose downgrade command.

## Evidence and remaining acceptance

Local protocol tests:

```sh
python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p 'test_upgrade.py' -v
python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p 'test_*.py' -v
```

The new suite has 26 test methods, including nine durable interruption phases, before/after healthy-phase crashes with new activity on both versions, the stop race, actual 0750 private permissions/group checks, exact pin/marker recovery, real temporary private tar readback, advisory-lock contention, conservative bidirectional media coverage, installed dependency drift, pending obligations, space exhaustion, backup corruption, preservation of live/private/APK bytes, fixed Mock commands and sanitized errors. Systemd, Docker and business data are adapters in these local fixtures. Passing them does not prove real PostgreSQL SQL execution, backup restorability, installed Linux behavior or public/device acceptance. Run the same filesystem suite on Linux and review the controller before any real check/apply; a real isolated database dump/restore validation is still separate.

After a permitted real upgrade, preserve controller/manifests/journal/receipt hashes privately and read back Mock origin, pin, marker, services, isolation and data/backup checks. Then run fresh 13-game Mock browser action/settlement/cleanup tests and the APK 1.3 physical-device matrix against the unchanged Mock origin/package. Existing public-platform or old Mock device reports cannot stand in for that acceptance. This controller never rebuilds, resigns, reinstalls or changes the APK, and does not claim that gameplay quality or production admission has passed.

## Verified results on 2026-10-08 (Asia/Shanghai)

The final controller SHA-256 is `aac818df5a64a09ba2ef35a05a045814248b3c07bdcfb626d159cb9991ff1f56`; its test file is `edbb8efbd0a6edac1ac8d9820474cabcb28b528694e979425ed5cb4399eda873`. Independent review reproduced and closed the old-version observation-to-stop recovery race as well as the new-version race and actual 0750 directory-layout issue.

The final files and six unchanged dependencies/templates were uploaded to the new private `/tmp/oasis-mock-upgrade-tests-20261008/platform/deploy/mock-sandbox/` directory. All eight SHA-256 values were verified before and after execution. Linux / Python 3.10.12 passed **52/52 tests** (26 new controller tests plus the existing 26 installer/repair tests), exit 0, in 2.066 seconds. Test temporary files remained inside that directory, and the test process's command search path contained only a Python executable. These were **fake-runtime filesystem/protocol fixtures**: no real controller CLI, systemd/DB/Nginx mutation, real dump or restore was executed. Evidence is retained in the local, ignored `review/release/mock-upgrade-linux-aac818df-20261007T202416Z.log` and matching `.json`; the remote raw test log SHA-256 is `2772e942a1837f76d81dfaa4044c5544701612b904c086d433ff96ed0db054c9`.

One subsequent **real `check-only`** ran from that verified nested tool path with `/usr/bin/python3 -B`, normal command search path and no fixture TMPDIR. The controller returned **exit 2**, `apply_allowed: false`, with only `forward_assets` and `rollback_assets` listed as blockers. It verified both full release manifests, 185 unchanged critical files and 8,338 identical installed-dependency entries; its real resource/isolation/permissions, read-only business-state and backup-budget checks also passed. This does not imply those conditions remain valid for a later apply; they must be checked again.

The forward comparison inspected 618 files, found no missing file and four changed paths. The rollback comparison inspected 706 files, found **88 missing files** and the same four changed paths:

- `platform/dist/downloads/android-smoke-build.json`
- `platform/dist/downloads/oasis-partner-sandbox-kit.zip`
- `platform/dist/specs/android-webview-integration.md`
- `platform/dist/specs/third-party-launch-readiness-2026-10-07.md`

Those four paths remain rejected by the frozen conservative byte-equality gate. They are download metadata, a partner integration ZIP and documentation, rather than evidence of four broken gameplay assets. Their eventual treatment requires an explicit reviewed classification; this result did not exempt or delete them.

A separate read-only 05 manifest/file-stat check measured the 88 missing files, all declared by the pinned 05 manifest and all named with an eight-character hash: **3,692,973 bytes (3.52 MiB)** total file content, **3,919,872 bytes** of allocated file blocks, excluding directory/receipt overhead. They comprise 76 Arena JS files (2,603,169 bytes), one Arena CSS file (56,832 bytes), nine legacy JS files (269,573 bytes) and two platform JS files (763,399 bytes). Thus a future Mock-specific retained-resource design could copy only this difference; copying the complete asset set is not necessary. No such fallback or configuration transition was implemented or activated by this work, and it is deferred beyond the current 06 release work.

Before and after the real check, `current` remained `/opt/oasis/releases/20261008-05` and `android-mock-current` remained `/opt/oasis/releases/20261007-04`. Both loopback `/health/ready` endpoints (18881 and 18981) returned HTTP 200, `status: ok`, `environment: sandbox`; controller/dependency bytes were unchanged. The original stdout, empty stderr and exit 2 are retained in local ignored `review/release/mock-upgrade-check-only-aac818df-20261007T202802Z.log` and matching `.json`. This was not a new public-browser or physical-device acceptance run. **No real apply, real rollback/recovery or database restore drill has been run; no pending business was cleared and no service was started/stopped by the check.**
