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
`0755` according to the source executable bits. Directories use `0755`; all output
mtime values are fixed. Source file identities and full bytes are checked again
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
| Forward | `2788db4eeb6d81b4c9940b5f8ac14d584d8a4cac01eb689c65af5bb3918ea6d8` | 1,073 | 711 |
| Rollback | `5b5cf7a837fec7024fedc38c63571e1c62e46401bacda5cc945e7bc829133e33` | 995 | 711 |

The builder passed 27 local tests. The explicit
`node --test tests/mock-view-assets.mjs` fixture verified complete view manifests
and made 988 loopback HTTP requests against each view's actual game-asset module:
86 new API-served assets, GET/HEAD/ETag revalidation across rollback→forward→rollback,
and all 13 HTML entry routes. Three new platform assets were checked by hash
only. This did not run Nginx/TLS or a game session.

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

Remaining work is a view-specific, schema-aware pin/marker transaction with
verified backup and interruption recovery, actual deployed HTTP checks and APK
phone acceptance. No view was uploaded, installed or activated by these tests.
Existing human download buttons still use the historical URLs and old content;
new copies are available only at the explicit versioned paths in the receipt.
The copied public Android metadata describes its original public artifact, not
the Mock APK. No compiled UI was rewritten to imply otherwise.

Raw local evidence is retained under `platform/review/mock-release-views-20261008/`
and `platform/review/mock-view-migration-20261008/20261008T053154Z-67d879/`.
