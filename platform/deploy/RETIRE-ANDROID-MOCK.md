# Android Mock retirement

`retire-android-mock.py` is a one-namespace retirement controller for the explicitly authorized permanent deletion of the dedicated Android Mock application and test data. It is not a general uninstaller. The actual bounded retirement is now complete, with an independent server readback; local fixture tests alone were not accepted as proof of server deletion.

## Actual execution record

The root executor completed v7 at `2026-10-09T17:23:56.338037+00:00` (2026-10-10 01:23:56 Asia/Shanghai). The final receipt reports `phase=complete`, `passed=true`; its SHA-256 is `931dfadda3577244b434ee86c74f95cf3e66053362ff61ac10f207d69737c920`. The independent readback at `2026-10-09T17:24:36.844550+00:00` passed and observed the same receipt hash.

The completed deletion was verified beyond stopping services: all eight dedicated units have no remaining fragments; the dedicated UID/GID, listeners, nftables table, PostgreSQL container, exclusive volume and its physical data directory, and exclusive network are absent. The complete dedicated private tree, including all inventoried test database/configuration backups and cached state, ACME webroot, renewal configuration and Mock release pin are absent. No new test-database backup was created or retained as part of this retirement.

The independent reader verified public current `20261009-03` and previous `20261009-02`, public configuration/manifests, shared PostgreSQL/proxy identities, public processes/PIDs and the shared static head unchanged. Public `/health` and `/demo/` returned 200. All four retired Mock HTTPS routes (`/demo/`, `/health`, `/api/pvp/rooms`, `/v1/session`) and the Mock HTTP root returned 410 with normal TLS verification. Immutable Mock23/24 snapshots, shared assets/images, historical public APK downloads, public backups/data and the dedicated TLS leaf for 410 remain protected. Reported free space after retirement was `7,848,300,544` of `41,882,943,488` bytes.

The completed execution used frozen controller SHA `fa9664fe4b081804e77fe92fecb21d008dce27ca49a6338a85a68de79ed3150c` and the fresh v7 recovery-check SHA `4954677e51717fbe1aebad706495dffcdada09d4341cf5b3459516adeacf9dc8` observed at `2026-10-09T17:22:52.418794+00:00`. The 50 local tests and independent review used test-file SHA `a6f2e241263c93f958134c05511c7e8c209c72b5092ac06af97a2b4c62de1061`. This execution-record update changes only this document; those controller/test bytes remain frozen.

Evidence remains in the operator's ignored `platform/review/mock-retirement-20261010/` directory: `recover-v6-check-v7.json`, `recover-v6-apply-v7.json` and `independent-final-v7.json`, with their stderr files. The earlier v5/v6 failed outputs and independent failure readbacks are preserved. Server receipt backups `failed-v5-receipt.json` and `failed-v6-receipt.json` preserve the original hashes `10ba5961cdcd827339446b5ab8926c4d0fca873f3f625d70f5afe36c5705bed6` and `6b6da3f60e8a0511c98ea55a80c417b22b69516d93b3cf153e749f5ccdaf2075`. Only metadata/hashes and non-secret routing configurations remain in the receipt directory.

The final receipt deliberately retains the historical top-level `error_code=MOCK_PROXY_CONFIG_UNSAFE` and `failed_at_phase=tombstone_verified_before_data_deletion` from the interrupted v6 attempt. These are preserved history, not a current failure: the current `phase`/`passed` fields and the last history event are `complete`/`true`, with deletion proofs; the independent readback separately confirms completion. The original v5 top-level tool/check pins, v6 `resume` pins and original history remain intact, and the v7 `recovery` field records the final controller/check and no repeated installer stop or tombstone creation.

The commands below document the reviewed procedure and its two exact historical recoveries. The namespace is already retired; do not rerun them or reinterpret a retained failure record as new authorization. Normal check/apply and the pinned recovery modes refuse the completed receipt/state.

The externally pinned read-only inventory is SHA-256 `b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c`. Its namespace is Mock `20261008-23`, public current `20261009-03`, previous `20261009-02`. Any different marker, ownership label, container/network identity, public manifest/runtime/vhost, process, service or consumer fails closed. The old release's `install.py` is verified against that release manifest, then its SHA is recorded and rechecked before use.

Every owned service/socket/timer/drop-in must also match the trusted immutable installer's generated content exactly. Two manifest-bound generator function definitions are replayed with file writes replaced by in-memory collectors; no installer module top-level code, main, provisioning, environment parser or privileged command is executed by this replay. In particular an unknown `ExecStop` on the dedicated DB unit refuses before the old installer may stop it. Shared proxy inspection precedes Nginx reads; all proxy exec/copy/reload commands bind its exact container ID and refuse an unbound or replaced ID.

The effective systemd manager state must also report `NeedDaemonReload=no`. Systemd 249 omits empty command properties even with `systemctl show --all`; absence is never treated as proof of emptiness. A single private Python `dbus.SystemBus` connection calls `RefUnit` for the exact owned unit before `GetUnit`, holds that sender reference through typed Service/Socket property reads, and always calls `UnrefUnit` and closes the connection. RefUnit loads unit metadata and tracks the sender; it does not start a service or enqueue a job. This prevents inactive/disabled unit garbage collection between separate inspection clients. The binding is already installed on the target; no new dependency is installed. Caller-supplied D-Bus addresses are cleared during connection creation and restored afterwards. Only an explicit typed zero-length command array proves no command. Loaded stop commands are inspected without printing their raw content: only the dedicated DB service may contain the exact Docker stop command for the fixed Mock container; all other loaded stop/pre/post commands must be absent. Changing execution timestamps/PIDs/exit history are excluded from configuration identity. The resulting canonical configuration evidence remains identical to v5. Unknown object paths, signatures, row types, missing properties or failed reads refuse; none become empty. Check does not run a global daemon reload to adopt unreviewed configuration.

The reference behavior is defined in the [systemd v249 manager implementation](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/dbus-manager.c) and [unit sender tracking implementation](https://raw.githubusercontent.com/systemd/systemd/v249/src/core/dbus-unit.c). The root executor separately confirmed this read-only persistent-binding sequence on the actual systemd 249 target before the controller was changed.

## Check and review

Run the uploaded, SHA-verified script as root from an independently created root-only transfer directory. `check` creates no files or locks and executes only inspection, read-only SQL and health GET requests. Redirect its stdout to a new, root-only local/operator-owned evidence file; never overwrite an earlier check or result.

```sh
python3 -B retire-android-mock.py check \
  --inventory inventory.json \
  --inventory-sha256 b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c
```

Review the entire check capsule: it includes only file metadata/hashes, dedicated volume ownership/consumers, public process/config/manifest pins, shared PostgreSQL/proxy identities, public pending counts, and Mock business counts. It inventories all files under `/opt/oasis/android-mock-private`, including the state cache, the old upgrade backup and both refresh backups. No secret file content, credential, session, player or room identifier is emitted. Unknown symlinks, hard links, special files and every nested mount, including same-filesystem bind mounts parsed from `/proc/self/mountinfo`, are rejected. The only allowed symlinks are the exact existing Mock release pin and the two explicitly bound Certbot leaf links.

Mock obligations cover rooms, cycles, game and PvP operations, unfinished probability presentations, integration checks, reservations, competitive/probability wallet records, reserved/credit-pending balances and transfers. Transfer schema is accepted only as fully present or wholly absent without stray transfer ledger entries. The dedicated database and every app must remain sandbox. A partial schema, unknown count, nonzero obligation or non-sandbox app refuses retirement. Public obligations are read in their own read-only snapshot and must remain unchanged through the guarded phases.

## Apply

Only root's authorized executor runs apply after reviewing a fresh successful check. SHA-256 the exact check stdout bytes and pass the pin. The check must be no older than 600 seconds and must match the uploaded controller SHA. No interactive confirmation is added: the human already authorized permanent removal of this dedicated namespace.

```sh
python3 -B retire-android-mock.py apply \
  --inventory inventory.json \
  --inventory-sha256 b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c \
  --safecheck safecheck.json \
  --safecheck-sha256 REVIEWED_EXACT_CHECK_SHA256 \
  --delete-dedicated-mock-data
```

Apply holds the existing public release and dedicated network locks. The old, verified installer acquires its original install lock while stopping/disabling the dedicated units; the controller then reacquires that same lock for the remaining phases. Lock identity/replacement and contention are fatal. All privileged writers must honor those lock conventions; the tool does not defend against a concurrent hostile root actor.

The application/proxy/listeners and the dedicated UID must be stopped before a short restart of only the exact pinned PostgreSQL container. A repeatable-read, read-only query closes the application-stop race. `finally` stops the same pinned container even when startup, readiness or query fails. No API, demo, proxy or other application is restarted. Any newly discovered obligation is recorded as counts, and the database volume is retained.

The dedicated HTTPS vhost becomes a no-upstream, no-file-serving HTTP 410 endpoint using its existing leaf TLS chain/key. The host's old ACME bridge is removed; the exact dedicated HTTP proxy vhost becomes 410. Both Nginx syntax checks must pass before either reload. Public health, exact public configuration/process/shared-container pins and four strict-TLS Mock 410 routes are verified before any container/volume removal, and reverified between destructive phases. HTTP clients clear proxies and use normal certificate verification. Every later phase binds the exact 410 configuration hashes and bridge absence.

Only then does the controller remove the exact container ID, the exclusive local volume by its externally checked metadata/inode/consumer identity, and the exact network ID. Commands use no force/prune/image deletion. It removes the dedicated units/drop-in, renewal configuration, exact owned nftables table, ACME webroot, complete dedicated private tree (including all old test database/configuration backups), release pin, and finally the uniquely owned UID/GID after rechecking no processes or other account/group consumers. There is no `userdel -r` or shared home deletion.

## Evidence and recovery limits

The exclusive receipt directory is `/opt/oasis/private/mock-retirement-20261010` (0700). It contains a hash/metadata receipt and the three original non-secret routing configurations (0600), plus the new proxy tombstone configuration. It never contains a database backup, runtime env, application keys or test state. A routing failure before data deletion attempts only configuration restoration, only for steps actually written by this invocation and only while the exact authored tombstone still matches. Unknown configuration is preserved and fails closed. No data is recreated and no application is restarted.

An existing receipt still makes normal check/apply refuse. Recovery has only two separately pinned, independently diagnosed cases: the v5 interruption after the old installer stopped all dedicated units, and the v6 permission defect after the authored 410 routing was verified but before container removal. Neither is a generic retry or selectable stage. Root's readbacks confirm no Mock application restarted and the dedicated database container exited with its volume/network/private tree retained. A failed/partial run must not be reported as complete. Volume and dedicated test-backup deletion are permanent and cannot be undone by the configuration-only receipt.

## Exact v5 interruption recovery

Recovery accepts only the original canonical check SHA `3681ad386363bf9e342e0a7b6e35aa8a0512c61864426905b3f827e6c56adb48`, original tool SHA `d5639a84bf25c639ebf1fcdf17b6bd4c0327ef97ae66e319a144aa6b7a8b4127`, and actual failed receipt SHA `10ba5961cdcd827339446b5ab8926c4d0fca873f3f625d70f5afe36c5705bed6`. It also requires the exact two-event history, `failed_closed`/`before_old_installer_stop` phase and error, original inventory and explicit deletion authorization. It refuses another failure/phase, modified receipt, extra receipt-directory files or a prior resume. There is no arbitrary stage selection or automatic retry.

The original check is a fixed historical baseline; its original SQL is not fresh authorization. `resume-check` samples all original file/ownership/public/process/config/consumer/mount pins and stopped state afresh, without starting or querying the stopped Mock database. Public SQL and health remain fresh and must match the protected baseline. The reviewed new resume capsule binds the v6 controller, original chain, receipt inode/hash, stopped units and current remaining identities, and expires after 600 seconds.

```sh
python3 -I -B retire-android-mock-v6.py resume-check \
  --inventory inventory.json \
  --inventory-sha256 b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c \
  --original-v5-safecheck safecheck-v5.json \
  --original-v5-safecheck-sha256 3681ad386363bf9e342e0a7b6e35aa8a0512c61864426905b3f827e6c56adb48 \
  --failed-v5-receipt-sha256 10ba5961cdcd827339446b5ab8926c4d0fca873f3f625d70f5afe36c5705bed6
```

Save output exclusively as `resume-check-v6.json`; review it and pin its actual SHA. Only then run:

```sh
python3 -I -B retire-android-mock-v6.py resume-apply \
  --inventory inventory.json \
  --inventory-sha256 b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c \
  --original-v5-safecheck safecheck-v5.json \
  --original-v5-safecheck-sha256 3681ad386363bf9e342e0a7b6e35aa8a0512c61864426905b3f827e6c56adb48 \
  --failed-v5-receipt-sha256 10ba5961cdcd827339446b5ab8926c4d0fca873f3f625d70f5afe36c5705bed6 \
  --safecheck resume-check-v6.json \
  --safecheck-sha256 REVIEWED_EXACT_RESUME_CHECK_SHA256 \
  --delete-dedicated-mock-data
```

Resume apply holds the original release/network/install locks and regenerates the complete resume check before any mutation. It creates an exclusive byte-for-byte `failed-v5-receipt.json` (0600, metadata only), preserves the original tool/check hashes and history in the extended receipt, and adds the v6 controller and reviewed resume capsule hashes. It does not invoke the old installer again or restart API/demo/proxy. It continues through the same short fixed-ID PostgreSQL read-only obligation check with unconditional `finally` stop, then the same strict 410/public verification and guarded deletion pipeline. Another failure preserves that extended history and refuses further automatic recovery.

## Exact v6 permission-defect recovery

Root's actual v6 readback pins controller SHA `4e03815325bab0d0bf348f2e03f3d3d515f3f1da1fc02e006f05c428ff9955ee`, successful resume-check SHA `9026476071f374d995ecb5ea76857ebd597e0ca7ed44128972a0a618cba3c6a9`, and failed receipt SHA `6b6da3f60e8a0511c98ea55a80c417b22b69516d93b3cf153e749f5ccdaf2075`. Its exact six-event history ends with `MOCK_PROXY_CONFIG_UNSAFE` at `tombstone_verified_before_data_deletion`; there is no container-removal event. All four strict-TLS 410 probes passed, the host bridge is absent, all Mock pending counts were zero, and PG/volume/network/private data remain intact.

The defect was `os.open(..., 0644)` under the controller's umask 077: the new host/proxy configuration files were actually 0600. The permanent creation fix uses `fchmod` on the exclusively created descriptor and verifies its exact requested mode with `fstat`; configuration backups remain 0600. An existing file or symlink cannot be chmodded through that creation path.

`recover-v6-check` additionally requires the exact original v5 chain, v6 check/receipt chain, six existing metadata/config files and known authored 410 raw/body hashes. It rechecks all public, resource, file, mount, consumer and stopped-state guards. The original v5/v6 capsules are historical baselines, not fresh SQL or fresh authorization. Only this exact failed receipt and authored content admit a read-only inspection of the known 0600 defect. Normal `files`, `fresh`, `proxy_file_guard` and `routing_guard` continue to require 0644. The new recovery capsule expires after 600 seconds and no Mock SQL/start/mutation occurs during check.

```sh
python3 -I -B retire-android-mock-v7.py recover-v6-check \
  --inventory inventory.json \
  --inventory-sha256 b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c \
  --original-v5-safecheck safecheck-v5.json \
  --original-v5-safecheck-sha256 3681ad386363bf9e342e0a7b6e35aa8a0512c61864426905b3f827e6c56adb48 \
  --failed-v5-receipt-sha256 10ba5961cdcd827339446b5ab8926c4d0fca873f3f625d70f5afe36c5705bed6 \
  --original-v6-safecheck resume-check-v6.json \
  --original-v6-safecheck-sha256 9026476071f374d995ecb5ea76857ebd597e0ca7ed44128972a0a618cba3c6a9 \
  --failed-v6-receipt-sha256 6b6da3f60e8a0511c98ea55a80c417b22b69516d93b3cf153e749f5ccdaf2075
```

After exclusively saving and reviewing `recover-v6-check-v7.json`, use the same arguments with mode `recover-v6-apply` and append:

```sh
  --safecheck recover-v6-check-v7.json \
  --safecheck-sha256 REVIEWED_EXACT_V7_RECOVERY_CHECK_SHA256 \
  --delete-dedicated-mock-data
```

Apply holds all three original locks and regenerates the complete fresh recovery proof before creating an exclusive byte-identical `failed-v6-receipt.json`. It preserves the six original history entries, top-level original v5 tool/check pins and original `resume` v6 pins. The new `recovery` field binds the v7 tool/fresh capsule, original v6 tool/check/receipt, `old_installer_stop_repeated=false` and `tombstone_repeated=false`.

Only the exact authored host TLS and proxy 410 files change from 0600 to 0644. The host permission repair uses its verified descriptor. The proxy has no host bind mount, so a fixed-container shell retains one descriptor and verifies owner/group/mode/link count, parent, device/inode, size and raw body hash against the reviewed proof before and after chmodding that descriptor. Unknown content, substituted path, symlink or metadata refuses; no configuration body or other file is written. The 0600 routing backups and original receipts remain unchanged. No tombstone/config backup is re-created, no installer stop or application restart is repeated, and no Nginx reload is needed for a permission-only repair.

The normal 0644 routing guard and public/strict-410 proofs must then pass. Only the same dedicated PG container is temporarily started for a fresh read-only full-obligation query, with unconditional `finally` stop. New pending obligations retain the data. After that proof passes, recovery continues at the original `before_container_removal` sequence, preserving every original between-phase/volume-deletion guard. A further failure is preserved and is not automatically resumable.

Retained resources include immutable Mock23/24 snapshots, all 612 shared static assets also referenced by historical public manifests, the shared static registry/head, public historical APK downloads 1.1.1/1.2.0 and their pinned metadata, shared Docker images, shared backups, public02/03, public runtime/data and other services. The dedicated current TLS leaf/key remains solely to serve the retired endpoint; its renewal is disabled, so the endpoint's certificate validity remains bounded by the retained leaf expiration. It is not a newly accepted production APK/backend.

## Local verification

```sh
python3 -B -m unittest discover -s platform/deploy -p test_retire_android_mock.py -v
```

The temporary-filesystem and fake-command tests exercise consumer/label/ID drift, private-path and symlink/hardlink/mount boundaries, full obligation refusal, fresh external pins, strict routing test/reload ordering, exact 410 binding, configuration-only rollback with unknown-file preservation, and PostgreSQL `finally` stop. One fixture uses the real `files()` and `fresh()` methods with an actual BRIDGE unlink; it also proves a remaining runtime-file drift still refuses the next destructive phase. Persistent-sender fixtures reject the former GC window and prove unref/close on success and failures, with typed canonical command evidence preserved. Recovery fixtures cover exact original chains, historical versus fresh authorization, expired or changed new capsules, stopped-state/public/file/consumer/UID drift, receipt preservation, no repeated installer/app/tombstone creation, and PostgreSQL query/start/pending failures retaining data. Real umask-077 file creation and a copy that inherits source mode verify the creation fix. The exact proxy repair script is exercised with a real local shell and inherited descriptor, using temporary metadata helpers; a pathname swap to a foreign symlink refuses before chmod. No browser, real Docker/systemd/Nginx, SSH or deletion outside the fixtures is run by the tests.
