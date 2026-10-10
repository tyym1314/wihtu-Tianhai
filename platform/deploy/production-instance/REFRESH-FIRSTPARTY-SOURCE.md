# Preserve free-player state while refreshing 04 to 05

`refresh-firstparty-source.py` is a root operator controller for the witnessed
`/opt/oasis/releases/20261010-04` → `20261010-05` transition. It does not provision,
migrate, register players, fund wallets, delete QA data, approve probability games,
or establish performance acceptance. The predecessor release and its six private
controller files remain immutable. The public `current`/`previous` demo stays intact.

Stage 05 with the official delta/staging mechanism against the complete immutable
04 source, retaining dependencies and all release/build manifest checks. Commit and
build once the controller and scene fix are reviewed. The new manifest and commit
are explicit actual build parameters; examples below intentionally contain no fake
candidate hash. Capacity still requires the original ≥1 GiB budget and reserve.

Run the controller from **the immutable 05 release file** (root-owned, mode 0644),
using `/usr/bin/python3 -I -B`, an isolated PATH/LC_ALL environment, and its exact
manifest member SHA as `--controller-sha256`. A separately copied root-private
0600 script is also supported only when its raw bytes equal that same manifest
member; the running script FD, path/inode and complete candidate source are pinned.
No T6 file is replaced and no source03/04 file is modified.

Required common arguments for all actions:

```
--legacy-controller /opt/oasis/private/production-admission-20261010/upgrade-admission.py
--legacy-controller-sha256 <actual frozen 03af… full SHA>
--legacy-common-argv <root-private JSON argv copied from the actual T6 close invocation>
--legacy-common-argv-sha256 <external raw SHA>
--operator-inventory <root-private exact {files,directory_pin} T6 inventory>
--operator-inventory-sha256 <external raw SHA>
--release /opt/oasis/releases/20261010-05
--manifest-sha256 <actual 05 RELEASE-MANIFEST.json raw SHA>
--source-commit <actual candidate source commit>
--controller-sha256 <actual candidate manifest member SHA>
--capacity-budget-bytes 1073741824
--source-receipt <passed predecessor operation receipt>
--source-receipt-sha256 <external raw SHA>
```

For `--action refresh`, the predecessor is the genuine passed T6 `close` receipt
(04, App paused, policy closed, current revision 3 in this rollout). Root's common
argv still declares the original source04/source63/controller03af/origin c1 and all
original retirement/static review inputs. The controller validates all six exact
inventory file names/FD pins and every original 13 source binding. The external
inventory is not reconstructed from freshly observed files.

For `--action open|close`, the predecessor is a passed receipt of this new
controller with source05 and matching manifest/controller/source commit. It binds
the original source history, official static append, the witnessed source-pointer
change and final live source pointer. Reuse the genuine refresh receipt for open;
never rewrite the old close/refresh time or relabel a failed operation.

For each action perform **audit → root review → check → apply**:

1. `--mode audit` emits the actual full JSON audit. Save stdout in a new root-private
   exclusive 0600 file. Source/DB/retained-row hashes are acquired while the three
   exact owned timers are paused. All timer files and loaded commands remain checked.
   After original locks release, the three timers are restored and typed own jobs
   must become idle within the original 60-second limit. No running job is killed.
2. Root independently reviews the audit and creates the exact 20-field approval
   below in an exclusive 0600 file. No controller-generated approval is accepted.
3. `--mode check --audit PATH --audit-sha256 SHA --approval PATH
   --approval-sha256 SHA` rechecks the same source, complete retained rows, full
   closed/free policy, static plan, units, private pins and resources. Save the check
   as a new exclusive 0600 file and record its raw SHA.
4. `--mode apply` adds the same audit/approval arguments plus `--check PATH
   --check-sha256 SHA`. All external inputs remain held by FD; the original global
   release lock and operations lock are acquired from the exact check. Audit,
   approval and check must be fresh within 600 seconds; do not alter timestamps.

Approval fields are exactly:

```
schema, kind, passed, action, scope_kind, audit_sha256, release,
manifest_sha256, source_commit, app_id, scope, currency_scale,
allowed_origins, game_ids, profile, financial_admission_enabled,
probability_admission_enabled, thirdparty_financial_admission_enabled,
approved_by, approved_at
```

Values: schema 1; kind `production-firstparty-admission-approval`; passed true;
action matches the requested action; scope_kind `source-refresh` for refresh and
`firstparty-free-only` for open/close; profile `firstparty-free-v1`. All three
financial flags must be literal false. SHA/commit/release/App and scope metadata
must exactly equal the actual audit. `approved_by` is the root reviewer identity;
`approved_at` is the actual timezone-aware review time. This is solely free-player
source/policy authority, never financial or product-quality approval.

Refresh backs up the actual 04 users/zero financial state and performs the actual
isolated restore drill using the corresponding immutable 04 helpers. It requires
all rooms terminal, all pending authority/financial obligations zero. It stops only
the owned API and three timers, preserving the DB and every foreign service. Under
the original locks it uses the frozen official publisher to append precisely the
manifest-selected missing immutable assets and one receipt, preserving every old
body, receipt and ownership pin. The exact computed head replaces only the head
protection pin; all other original 20→18 retirement protections remain intact.

The existing policy advances one revision while remaining closed, changing only
its source/manifest/proof/reviewer metadata. Runtime edits are limited to the two
source declaration fields; App/profile and the three secret file pins are unchanged.
The marker appends source05, retains the complete independently approved 03+04
history/configurations, and leaves all old room terms untouched. Only the owned
production source pointer and the eight declared unit templates advance to 05.
The API starts from exact 05 source while timers are deferred until locks release.

History supports old sessions and terminal rooms through preceding marker-approved
policies. Current DB admission still matches only the current source approval.
Historical backup inspection rechecks each actual historical helper/source closure,
including after inspection, and records a canonical approved-history hash. It cannot
approve a policy from backup rows or silently admit an active old-source room.

Success requires actual final DB/retained full-row hashes (excluding only explicitly
changed App status and policy), unchanged financial state, complete source/helper/
dependency/private/resource/foreign protection checks, eight actual loaded units,
three active timers and typed idle jobs. It also verifies strict HTTPS ready health,
full new immutable body SHA/MIME/cache, HEAD/304/range responses and source05 mutable
index bytes/no-store. The receipt phase is `complete_closed` for refresh/close and
`complete_free_open` for open. The private operation directory is
`/opt/oasis/production-instance-private/source-refreshes/<action>-<check-raw-SHA>`.
An attempted path is never reused. Main prints the actual receipt path/raw SHA.

Any attempted mutation failure remains a failed receipt and stops only the
independently verified owned API/timers. There is no blind rollback or automatic
second mutation attempt. The live DB, old sources, original evidence and public
demo remain preserved; root diagnoses the journal before any recovery. A failed
read-only phase independently reports timer-restoration errors. Neither timer
restoration nor a passed free source transition means device/FPS acceptance.

Focused local checks (no DB/server/device actions):

```
python3 -B -m unittest -v test_refresh_firstparty_source test_admission_history
```
