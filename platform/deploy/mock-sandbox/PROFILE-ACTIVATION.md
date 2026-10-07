# Exact Mock route activation and runtime adapter

`profile_activation.py` is a candidate operational controller for the fixed
**20261007-04 → 20261008-05** pair. Its default command is read-only. It can
prepare the existing verified store/materials, activate the one approved overlay,
recover interrupted activation, start existing Mock applications, and invoke the
existing backed-up upgrade/recovery protocol with that exact profile. It cannot
select another origin, release, database, APK, Nginx path or external plan.

This first migration does **not** put the current Run performance changes into
the APK. Historical 05 lacks subsequent runtime improvements. A later reviewed
pair needs the new complete manifest and runtime/schema/dependency comparison,
the precise immutable URL difference, explicit mutable policies, real HTTP
verification and fresh Mock thirteen-game / physical APK acceptance.

## Source identity and unchanged defaults

Both immutable releases still contain installer
`8b631520883f039e07c53b191360e359b8df4cebb7a247713aba5929291a19df`.
The adjacent reviewed installer is explicitly pinned to
`9ccd1b7b1f751ebb2d0d5e5dc52699de4ad1daff4f7a1423108059dbc4f52639`:
it moved unknown TLS-profile rejection before service startup. That is an
audited source transition, not an exemption allowing arbitrary installers.
All six adjacent Python dependencies are SHA-pinned **before import**. The
operator must independently verify this entrypoint's own published SHA, preserve
the complete capsule and use root-controlled, non-writable paths.

The only changes to `upgrade.py` extract three overridable checks:
`Runtime.route_identity`, `Upgrade.installer_identity`, and
`Upgrade.asset_coverage`. Their defaults retain the original exact-template,
historical-installer equality and conservative bidirectional static policy.
The standalone default upgrade remains unable to approve the overlay or the
changed adjacent installer. Its historical `aac818df…` journals require their
original frozen tool capsule; this edited source cannot claim those journal
identities. Neither sealed release directory is edited.

The adapter retains full manifests, actual installed dependencies, unmanifested
static-file coverage, critical runtime/schema compatibility, private identity,
resource isolation, ledger checks and pending-business gates. Only the exact
88 bundle entries / hashes and four reviewed mutable pairs can resolve static
differences. An extra missing file, changed same-URL body or foreign dependency
remains a failure. The canonical JSON is the exact historical 05 schema-2 body
on both pins; it describes the historical live APK, not Mock APK 1.3. The ZIP
and Markdown bodies follow the validated Mock pin. No-store cannot invalidate
an already cached schema-1 response.

## Commands and persistent objects

The following are **review targets, not a record of commands already run on the
server**. No real activation, upgrade, HUP, database backup/restore or service
mutation was executed in this implementation slice.

```sh
python3 -B /root/verified-mock-profile/profile_activation.py check --bundle /root/verified-bundle.tar
python3 -B /root/verified-mock-profile/profile_activation.py prepare --bundle /root/verified-bundle.tar
python3 -B /root/verified-mock-profile/profile_activation.py check
python3 -B /root/verified-mock-profile/profile_activation.py activate
python3 -B /root/verified-mock-profile/profile_activation.py recover
python3 -B /root/verified-mock-profile/profile_activation.py start
python3 -B /root/verified-mock-profile/profile_activation.py upgrade-check
python3 -B /root/verified-mock-profile/profile_activation.py upgrade
python3 -B /root/verified-mock-profile/profile_activation.py upgrade-recover
```

`check` never invokes Nginx, creates locks or writes a journal. Its observation
does not claim that a future syntax check or reload has passed. `prepare` makes
only the independent root-owned asset store and profile materials; it does not
stop a service or alter the effective vhost. Repeating preparation can complete
owned partial deterministic files and the existing asset-store transaction;
published drift is refused rather than repaired. The original source bundle is
copied and reverified for recovery, so a transient operator input path is not a
restart dependency.

Fixed objects:

- Store: `/opt/oasis/android-mock-static-assets/20261007-04-to-20261008-05`.
- Public materials: `/opt/oasis/android-mock-route-profiles/04-to-05-v1`, five
  exact 0444 files in a root-owned 0755 directory.
- Private activation state:
  `/opt/oasis/android-mock-route-profiles/.activation-04-to-05-v1`, 0700,
  containing the source bundle, material identity, original config, activation
  journal, and retained namespace-check evidence. Private files are 0600.
- Effective vhost: `/etc/nginx/conf.d/oasis-android-mock.conf`, root-owned 0644.
- Separate upgrade journal/backup:
  `/opt/oasis/android-mock-private/upgrade-profile-04-to-05-v1`.

Activation/upgrade take the existing release lock and Mock installer lock in
that order. Activation and upgrade keep the asset-store shared lock while using
its completed immutable contents. The inherited upgrade additionally takes the
network lock only around its atomic pin/marker change. All cooperating privileged
writers must honor these locks. This does not defend against malicious root.

## Activation and recovery protocol

Activation requires the exact running 04 pin/marker, both release trees, complete
prepared materials, current runtime isolation and at least 3 GiB plus 32 MiB
available. It binds the private/live/resource identities and Nginx master PID.
It inventories the actual Nginx include closure; unknown write destinations,
duplicate includes, foreign bytes, unsupported master arguments and ambiguous
configuration fail closed. Full syntax preflight must pass before the effective
config changes.

The original config backup and `prepared` journal are fsynced. The one effective
file is replaced atomically with 0644 bytes and its parent fsynced. Durable phases
are `prepared`, `switching`, `configured`, `reloading`, `verified`, `complete`;
restoration uses `restoring`, `restored`, `rolled_back`. A crash between replacement
and journal update is handled by exact original/overlay byte classification.
No third config is overwritten.

The controller targets only the verified Nginx unit's master with
`systemctl kill --kill-who=main --signal=HUP nginx`. This avoids a second host
Nginx parser in an `ExecReload` command; **it does not prove the master itself
cannot run `create_paths` during reload**. The required isolated Linux HUP test
must prove directory ownership/permissions and unrelated content remain intact
before a production activation is approved. Signal delivery is not acceptance:
bounded GET observations first wait for the exact canonical metadata, then a
single full GET/HEAD pass checks all 88 assets and four mutable paths, body bytes,
length/MIME/cache/ETag, plus Mock health. TLS verification and normal DNS remain
enabled; no proxy, HTTP redirect or insecure TLS override is accepted.

Failure after replacement attempts to restore the saved exact original and
freshly preflight/reload/read it back. API/demo are never stopped by configuration
activation or restoration. Failure to restore leaves the journal and both
materials for explicit `recover`; no unknown global configuration is overwritten.
Recovery reloads the exact disk profile after a fresh preflight when necessary.
A complete activation stays overlay permanently during the subsequent runtime
upgrade and rollback to 04. Repeated recovery of a complete activation only
verifies it. It never silently removes resources cached by a 05 page.

An interrupted preparation is resumed by the same `prepare --bundle` operation.
An activation that finished `rolled_back` is not automatically retried: retain
its journal and inspect the failure before authorizing a separately recorded
attempt. The tool provides no force/remove-history switch.

## Full Nginx preflight isolation

The parent never invokes production `nginx -t` or `-T`. It launches the fixed
child through a new private mount namespace. The child verifies it is in a
different namespace, changes propagation to private, and uses Linux
`mount_setattr` recursively to make **every existing mount read-only**. It checks
the entire `/proc/self/mountinfo` before allowing any Nginx invocation. Unsupported
kernel/capabilities fail before the effective config is touched.

Only the private nonce work mount becomes writable again. All five compiled
temporary paths and all compiled/configured log, pid, lock and cache destinations
must resolve within the reviewed `/var/lib/nginx`, `/var/log/nginx` or `/run`
namespaces, then are shadowed by private directories. No configuration input or
controller path may be hidden. Missing, linked or unreviewed paths refuse the
check. The candidate vhost is bind-mounted over its exact pathname **only inside
the namespace**, then Nginx tests the real enclosing configuration and modules.
Unknown write paths remain read-only. Namespace exit releases all mounts; there
is no host mount command or broad cleanup.

This source is Linux-specific and currently has only local controller fixtures,
not a real kernel isolation proof. Before real use, a separately authorized
isolated Linux fixture must exercise the mount syscall/capabilities, complete
enclosure, all five temp/log/pid/lock/cache paths, syntax failure, then direct HUP,
and verify original host file/permission identities before and after. A mock
return value or string assertion is not that proof.

## Startup, upgrade and limitations

The dedicated `start` verifies one exact original/overlay profile before service
mutation, requires existing active isolated infrastructure, runs the old guards
and preflight, and starts only API/demo when needed. It does not provision,
regenerate secrets, run Nginx or stop already-running applications after a failed
readback. Original-profile `start` is allowed only on 04; 05 requires a committed
overlay. The existing installer CLI still rejects overlay before its startup
mutations. Operators must use this dedicated entrypoint after activation.

**Automatic systemd Restart and boot retain the historical ExecStartPre guard.**
No new systemd drop-in is installed here. Therefore these automatic starts retain
release/isolation checks but do not independently repeat the new overlay/store
verification. Adding such a guard needs a separately reviewed durable tool path,
exact drop-in and its own installation/recovery/resource-identity transaction.

The profile-aware upgrade uses the unchanged backup/business state machine:
quiescent pending gates before stopping, real Mock-specific dump/private backup,
precise pin/marker rollback, no database restoration or automatic settlement,
and preservation of new business after a healthy start. Both 04 rollback and
05 startup keep the overlay and perform its HTTP readback. Its journal also binds
this adapter and all reviewed dependency bytes, and cannot be recovered by the
default old controller. Keep the tools, bundle, store/materials and journals.

Local validation:

```sh
python3 -B platform/deploy/mock-sandbox/test_profile_activation.py -v
python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p test_upgrade.py -v
python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p test_install.py -v
```

The new fixtures use synthetic pinned releases, real temporary files/flocks,
store preparation, manifests and deterministic backups; service/database/Nginx
are explicit fake adapters. They cover interrupted durable phases, disk-before-
journal crashes, exact-source refusal, static extras, foreign config, namespace
unavailability, recovery after accepted new business, and overlay retention on
rollback. They do not prove actual `pg_dump` restoration, kernel namespace
isolation, installed permissions, production config loading, or APK quality.
The earlier real 427-request HTTP route fixtures remain separate routing evidence,
not evidence of this controller's execution.
