# Offline derived Mock release views

`release_views.py` is a local filesystem builder. It does not connect to a host,
run an installer, install dependencies, change a current pin, operate a database,
modify Nginx or start a service. Original 04 and 15 trees remain unchanged.

`forward/` and `rollback/` are **staging names**, not installer-ready releases.
They require separately reviewed final release names, externally verified and
installed dependencies, source/receipt validation, budget and deployment gates.
The existing installer only accepts its own exact release naming/layout contract.
A successful build alone does not establish that either view is ready to activate.

## Input contract

```python
build_views(
    old_root=Path(...),
    new_root=Path(...),
    old_manifest_sha256='...',
    new_manifest_sha256='...',
    old_inventory=b'... canonical inventory JSON ...',
    old_inventory_sha256='...',
    publication_epoch=1791438422,  # independently checked, after every source mtime
    output=Path(...),
)
```

Both source roots must contain the original `RELEASE-MANIFEST.json` and every
body it declares. Manifests are plain `relative/path -> sha256` maps. All files
are read and checked; source manifests themselves must match caller-supplied
expected digests. Links, hardlinks, devices, FIFOs, traversal, special permission
bits, duplicate JSON keys and reserved generated receipts are rejected.

The old tree must also match a separately obtained, fresh installed inventory.
This program can authenticate the supplied bytes and their match to local
material; it **cannot establish that a caller's inventory came from a server**.
Do not derive a replacement inventory from incomplete local material.

The exact inventory schema is:

```json
{
  "schema": "mock-installed-nondependency-inventory-v1",
  "manifest_sha256": "<original 04 manifest SHA-256>",
  "files": {
    "RELEASE-MANIFEST.json": {"sha256": "...", "bytes": 123, "mode": 420}
  },
  "directories": ["platform", "platform/dist"],
  "excluded_caches": {
    "platform/deploy/mock-sandbox/__pycache__/install.cpython-310.pyc": {
      "sha256": "...", "bytes": 123, "mode": 420
    }
  }
}
```

`files` includes the source manifest, all ordinary source files, installed static
extras and explicitly excluded cache bodies. Modes are integer permission bits.
`directories` is a sorted unique list of all nondependency relative directory
paths, excluding the root itself. No undeclared extra is silently accepted.

Only the exact `platform/node_modules` directory is skipped. Its contents are
not inspected or copied, and the receipt explicitly requires external dependency
validation/installation. Other directories named `node_modules` are refused.

Every other `.pyc` is rejected, including manifest-declared bytecode outside a
cache directory. Only inventoried, unmanifested `__pycache__/*.pyc` bodies may appear in
`excluded_caches`. Every exclusion must exactly match the main inventory and is
read again before success. The only permitted source-manifest metadata exclusion
is old `src/.DS_Store`; it is still authenticated against its original source
manifest and recorded with path, digest, size, mode and reason. No other declared
body is silently removed. Empty source directories do not become output bodies;
only parents required by the output file set are generated.

New input trees must have exactly their manifest-declared body set plus the
manifest itself and necessary parent directories. Installed 15 Python cache
files are not inputs; use its complete verified package material instead.

## Deterministic transformation

1. Forward business files and HTML come from the new source.
2. All old non-HTML static paths absent from the new tree are copied forward.
   Scope exactly matches the existing conservative `upgrade.static_assets`:
   `platform/dist/`, `platform/arena/dist/`, `platform/legacy/dist/`,
   `platform/public/`, `platform/specs/examples/partner-host/public/`.
3. These four paths retain the old bytes in **both** views:
   - `platform/dist/downloads/android-smoke-build.json`
   - `platform/dist/downloads/oasis-partner-sandbox-kit.zip`
   - `platform/dist/specs/android-webview-integration.md`
   - `platform/dist/specs/third-party-launch-readiness-2026-10-07.md`
4. Each new body is also copied to
   `platform/dist/mock-releases/<new-source-manifest-sha>/<downloads-or-specs>/<name>`.
   Existing paths at these derived names are refused, even if their hash matches.
5. Rollback starts with all authenticated old ordinary bodies, including retained
   extras, except the explicit cache/metadata exclusions. Missing forward static
   files are copied to it. Business code and HTML remain old.
6. Every same-path non-HTML static body is identical in both views. Any other
   static conflict is a hard failure; no guessed classification or routing rule
   is introduced.

The fresh 04/public15 input preflight observed 904 old ordinary files and 1069 new
ordinary files (each includes its source manifest). The resulting plan has 1072
forward body files and 994 rollback body files before adding generated receipts.
Both static sets contain 711 bodies; rollback adds 93 paths (89 existing static
paths plus four versioned downloads/docs). These counts describe that specific
pair, not an acceptance bypass for a future pair.

Each output contains a newly generated `MOCK-VIEW-RECEIPT.json` and
`RELEASE-MANIFEST.json`. The receipt maps each ordinary output body to source and
source path, records original source manifest hashes and installed inventory
hash, and marks the tree as a derived view. Existing build receipts are retained
as original-source evidence only, not claimed as attestations of the new view.
The new manifest includes every output body and the new receipt, excluding only
itself to avoid recursive hashing. It does not reuse either original identity.

Files are copied independently (no hardlinks), with deterministic `0644` or
`0755` according to the source executable bits. Directories use `0755`. The required integer `publication_epoch` must be later
than every authenticated source file's modification time. All forward file and
directory mtimes use that second; rollback uses the following second. Both values
are bound into the receipt, and activation additionally rejects future timestamps.
This prevents same-size changed HTML from inheriting the same Nginx ETag or an
older Last-Modified value during either switch. Identical inputs and the same
explicit epoch remain reproducible. Source file identities and full bytes are checked again
before success. The builder creates a unique sibling
`.OUTPUT.mock-view-staging-*` directory, private `0700` while incomplete. Both
views and complete manifests are verified there before one rename publishes the
output directory. It rejects a destination that exists initially or appears
during the build. A caught failure removes only its owned staging directory; a
killed process can leave an identifiable staging directory, never a half-built
final output. The parent must be trusted and have no other same-UID writer; the
existence check does not defend against malicious concurrent directory renames.
This local directory publication is not a live release-pin transaction.

## CLI

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B platform/deploy/mock-sandbox/release_views.py build \
  --old-root /absolute/verified/sources/mock04 \
  --new-root /absolute/verified/sources/public15 \
  --old-manifest-sha256 <original04manifest> \
  --new-manifest-sha256 <original15manifest> \
  --old-inventory /absolute/old-installed-inventory.json \
  --old-inventory-sha256 <exactInventoryDigest> \
  --publication-epoch <verifiedSecondAfterAllSourceMtimes> \
  --output /absolute/new-owned-staging-directory
```

For a complete new package, optional `unpack` verifies its independently supplied
archive digest, accepts only unique regular file members, rejects path/metadata
abuse, checks all body hashes against the original manifest and rejects nonzero
trailing archive content. It never uses `extractall` or installs dependencies:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B platform/deploy/mock-sandbox/release_views.py unpack \
  --archive /absolute/full.tar.gz \
  --expected-archive-sha256 <fullArchiveDigest> \
  --expected-manifest-sha256 <sourceManifestDigest> \
  --output /absolute/new-owned-source-directory
```

The caller authenticates both expected hashes independently. Local digest
agreement alone is not an artifact signature or provenance proof.

Tests are local temporary-tree/package tests:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s platform/deploy/mock-sandbox -p 'test_release_views.py' -v
```

No system route substitution, shared Nginx change or historical report rewrite is
part of this builder. HTTPS behavior, APK operation and upgrade/rollback runtime
compatibility remain separate acceptance steps.

## Exact 04/public15 verification, 2026-10-08

Fresh read-only host inventory verified the original 04 and 15 manifest bodies,
269 retained 04 static extras and equal installed dependency digests (8,339
entries, including the dependency root directory). One old unmanifested Python
cache and the manifest-declared `src/.DS_Store` were authenticated but excluded.
Public15 and Mock04 stayed active, and their pins/marker/Nginx fingerprints did
not change during the inventory. The observed Mock database had zero unfinished
games or pending wallet/presentation obligations; activation must check again.

The locally built views are bound to these new manifests:

| View | Manifest SHA-256 | Manifest bodies | Static bodies |
| --- | --- | ---: | ---: |
| Forward | `91e8796604c13db1d676ec51a9deb3f6095d6bd9793e5bb754b4d738a23367a4` | 1,073 | 711 |
| Rollback | `a08f03687efa36a16454513e31d72de6bd4e0d35eb8d929c91c72703cfa8c61b` | 995 | 711 |

These corrected views use publication epoch `1791438422`; rollback uses
`1791438423`. Earlier equal-mtime artifacts were superseded before installation,
with their manifests, receipts and test records retained as historical evidence.

The builder passed 29 local tests. The explicit
`node --test tests/mock-view-assets.mjs` fixture verified complete view manifests
and made 988 loopback HTTP requests against each view's actual game-asset module:
86 new API-served assets, GET/HEAD/ETag revalidation across rollback→forward→rollback,
and all 13 HTML entry routes. Three new platform assets were checked by hash
only. This did not run Nginx/TLS or a game session.

An isolated Docker fixture copied the host's Nginx 1.18.0 ELF and required
libraries, with no network, UID 2345, no capabilities and a read-only filesystem.
It reproduced incorrect 304 responses for the real same-size (483-byte) changed
HTML with equal timestamps, then passed forward and rollback checks using ordered
epochs. ETag-only, If-Modified-Since-only and combined revalidation returned the
correct new body; four historical URLs retained their bytes. The 36 recorded
cases also include a synthetic same-size example. Both owned container and image
were removed; public/Mock pins, marker, Nginx configuration and service states
were unchanged. This validates static HTTP behavior, not phone gameplay.

The separate explicit command
`node --import tsx --test tests/mock-view-migration.mjs` passed 10 checks with
local PostgreSQL 14, two owned temporary databases and the complete authenticated
04/15 source material. The additive schema migration preserved all old-column
row digests. A real custom-format dump/restore preserved every table/sequence,
private Run history, accepted/rejected decisions and HTTP idempotency receipt;
replaying the original request did not mutate any table. Both databases were
removed afterward. These fixtures require the ignored frozen release material
and deliberately stay outside the ordinary `*.test.mjs` checkout test suite.

The negative test is an upgrade requirement: the old04 runtime cannot advance
an active V2.3 Run room and changes it to a fault. It can read a committed result,
but has no V2.3 game view (`game: null`). **Do not automatically roll back after
new business has been accepted**, including rejected-command receipts or newly
completed rooms. Static URL coverage does not make runtime protocols compatible.

The view-specific transaction is implemented in `view_upgrade.py`, with a frozen
host adapter and database helper. Local fault-injection and real PostgreSQL tests
cover interrupted journal writes, schema commits, identity switches and newly
accepted business. The two DDL statements run under the existing restricted table
owner; the administrative session identity is restored before post-validation.
The initial schema must be old; recovery separately permits a verified empty
additive schema with the original runtime. A successful local test is not host
activation evidence. Actual staged-host checks, deployed HTTP checks and APK
phone acceptance remain required. No view was uploaded, installed or activated by these tests.
Existing human download buttons still use the historical URLs and old content;
new copies are available only at the explicit versioned paths in the receipt.
The copied public Android metadata describes its original public artifact, not
the Mock APK. No compiled UI was rewritten to imply otherwise.

Raw local evidence is retained under `platform/review/mock-release-views-20261008/`
and `platform/review/mock-view-migration-20261008/20261008T053154Z-67d879/`.
Native HTTP evidence is in
`platform/review/mock-view-http-validators-20261008/native-result.json`.

## Fixed-host activation contract

The reviewed adapter binds original04, forward16 and rollback17 to exact manifest
and receipt hashes. It authenticates every body, provenance, publication mtime,
installed dependency and the unchanged service/route templates. Its helper source
hashes are fixed before import. Only the two Mock application units may stop or
start; existing database/network infrastructure and shared Nginx stay in place.

Use an independently verified, root-owned operator capsule containing
`view_upgrade.py`, `view_runtime.py`, `view_database.py`, the pinned `upgrade.py`,
`install.py`, `release_views.py`, and `view-origin-inventory.json`. Staging also
requires the exact two manifest/receipt pairs under `forward/` and `rollback/`.
The capsule belongs outside immutable release trees. Existing legacy installer
and upgrade entry points are not substitutes for this controller.

Run `python3 -B stage_views.py` in that capsule to check source bodies,
dependencies and disk budget. `--apply` copies the frozen recipes into independent
16/17 directories, fsyncs the files and directories, verifies both complete views,
and publishes their names. It retains at least 15% of filesystem capacity (and
at least 3 GiB), plus the estimated pending backup and growth budget. It performs
no activation; an interrupted partial publication is preserved for inspection,
never removed or silently overwritten by a retry.

Run `python3 -B view_upgrade.py check-only` in that capsule after both views and
dependencies are staged. It obtains existing release/Mock locks and validates
capacity, current owner/schema, unfinished obligations, original pin/marker,
resources, process identity and HTTPS response bodies. It does not create an
upgrade journal or stop services. A successful check is a point-in-time result;
`apply` repeats the checks.

`python3 -B view_upgrade.py apply` records a durable private journal, stops only
Mock API/demo, captures a quiet old-schema baseline and a verified custom database
backup, then performs the additive migration in one locked transaction. Both
runtime pin and installation marker must identify the same view before startup.
Process cwd/UID/argv/cgroup and actual served bodies establish which version is
running; a healthy status alone is insufficient.

After interruption, use the same frozen capsule's
`python3 -B view_upgrade.py recover`. Recovery inspects the durable journal,
backup, fixed resources, both identities and current database before deciding.
It never restores the database automatically. An unchanged quiet database can
use rollback17; newly accepted business keeps its matching compatible runtime.
Mixed identity with new business, unknown schema, damaged evidence or V2.3 data
under an old runtime is refused. A terminal journal is read back without service
or state mutations.

Once forward16 accepts a Run V2.3 session, old04 and rollback17 are no longer an
automatic recovery option, even when that session is terminal. Fix forward and
preserve its records. Browser smoke tests themselves cross this boundary.

## Observed activation and bounded forward retry

On 2026-10-08 the full server staging and initial activation checks passed. The
first activation completed its backup and additive migration, then failed a
process-directory observation immediately after starting a service. Its recovery
reached rollback17 with both services running correctly; their real cwd/inode,
UID, argv, cgroup and HTTPS bodies were subsequently verified. The frozen
controller finished that already-running rollback without another stop or any
database restoration. The failing instant was not captured, so the later healthy
processes do not establish the exact original cause.

`view_retry.py` adds one explicitly recorded forward retry to this exact existing
journal. It leaves the original frozen controller, runtime and tool bindings
unchanged. Default `check-only` requires a completed rollback17, the original
verified backup and a quiet database still equal to the additive empty baseline.
Any new business refuses this retry. `apply` records its own source hash and uses
the original durable phases and recovery policy; it never runs DDL, creates a
replacement backup or restores the database. `recover` resumes only a journal
bound to the same retry tool; a terminal journal is read back without mutations.

Its startup adapter calls the original start method once. Only a recognized
process-observation failure at the exact pinned post-start call can trigger up to
10 seconds of read-only readiness checks. Existing wrong-role processes,
preflight/guard failures and unknown errors still fail immediately. Every accepted
process must pass the original complete identity checks. Original error codes and
later observations are retained separately; later observations are not claimed as
a reconstruction of the lost failing sample. Fourteen local tests cover this
boundary, signal deadlines, interruption phases and concurrent new business.

The isolated real-Nginx fixture additionally passed 12 recorded cases for
rollback17 to forward16 revalidation. The host has no `if_modified_since` override;
Nginx's [documented default comparison](https://nginx.org/en/docs/http/ngx_http_core_module.html#if_modified_since)
is exact. A different deployment using `before` requires a new publication epoch
before retrying a lower-timestamp view. External HTTPS validators captured from
rollback17 must also be checked after activation; this fixture does not replace
that deployed check or phone acceptance.

Detailed activation/recovery evidence is retained under
`platform/review/mock-view-transaction-20261008/`; retry cache evidence is
`platform/review/mock-view-http-validators-20261008/native-retry-result.json`.
