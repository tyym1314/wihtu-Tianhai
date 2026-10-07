# Mock 04/05 route profile candidates

`route_profile.py` constructs and verifies exactly two complete vhost byte
sequences: the existing historical profile and one proposed overlay. It has no
CLI, installer, writer, network client, subprocess or Nginx invocation. It does
not change `install.py`, `upgrade.py`, the releases or the 88-file store.

## Interfaces and evidence levels

`build_profiles(old_manifest=bytes, new_manifest=bytes, old_files=dict,
new_files=dict, asset_bundle=bytes)` is pure. Both manifests have fixed historical
SHA-256 pins. Each selected map contains exactly the four mutable files, the
historical APK and the Nginx template, using their release-relative paths. Every
selected body must match its manifest and explicit reviewed pair. The template
and APK are identical across both versions. The 88-file bundle is fully
revalidated and its internal source manifest must equal the supplied 05 manifest.
Caller-supplied plans, receipts and configuration text are not authoritative.

The output dictionary contains `original.conf`, `overlay.conf`,
`android-smoke-build-schema2.json`, `policy.json` and `receipt.json`. This receipt
describes **candidate materials**, not a completed installation. Its fields keep
`installed`, `store_checked`, `release_trees_verified`, `http_verified` and
`apply_allowed` false. The function verifies selected source bodies, not the
current contents of either complete release tree.

`classify_config_bytes(raw, **inputs)` recomputes both candidates. Exact equality
is required; extra whitespace, an include, an altered port or any third profile
is rejected. It does not inspect the filesystem or claim activation.

`read_release_inputs(root, version)` is the separate read-only source adapter.
It verifies the pinned manifest and **all manifest-declared regular-file bodies**,
including non-selected files, rejecting symlinks/hardlinks and unsafe names. It
returns `(manifest_bytes, selected_bodies)`. It does not verify unmanifested
static files, installed dependencies, current symlinks, schema or runtime
identity; the existing upgrade checks for those remain required.

`verify_profile_files(inputs, config_path, bundle_path, *, store_parent=...,
material_root=..., owner=0)` is a read-only filesystem check. It validates config
ownership/mode and recomputes the profile. The original profile needs no overlay
store. The overlay requires the same bundle bytes, the existing store's shared
lock and complete body/metadata/receipt validation, plus every candidate material
at the exact expected bytes, owner and mode. Missing/incomplete receipts, extra
members, links or drift are rejected without installation or repair.

The intended material directory is
`/opt/oasis/android-mock-route-profiles/04-to-05-v1` (root-owned 0755, five regular
files 0444). The actual vhost file remains root-owned 0644 at
`/etc/nginx/conf.d/oasis-android-mock.conf`. No material is added to the sealed
88-file store. A future reviewed installer must create these files; this module
does not. Test-only relocated paths/owners are labelled `relocated_fixture: true`.
Even the fixed production paths only establish a filesystem observation:
`active_config_verified`, `pin_verified`, `http_verified` and `apply_allowed`
remain false. The module does not inspect the active Nginx process or loaded
configuration.

## Four exact mutable policies

The eight original file hashes/sizes are frozen in `MUTABLE`; this is not a
general exception for `/downloads` or `/specs`.

- `/downloads/android-smoke-build.json` always serves the exact 05 schema-2
  material in either pin state. Its six legacy fields and historical-live APK
  identity remain unchanged. The APK is 33,171 bytes, SHA-256
  `4531f672c89869d52d45c2c809d8667359d9026916cda19b1f6f5a35090a976c`.
  This metadata does **not** describe or promote the separate Mock APK 1.3.
- The partner ZIP and two Markdown documents follow the validated Mock current
  pin and return their exact historical bytes. The ZIP is `application/zip` with
  attachment disposition. Documents are `text/plain` with UTF-8; they are
  historical documents, not live health or admission declarations.

All four aliases have exact raw-URI, origin and GET/HEAD guards; error methods
return 405, unknown/noncanonical forms return 404, and errors cannot use the SPA
fallback. They use `no-store`, no gzip transformation, `open_file_cache off`,
native ETags and `if_modified_since off`. `max_ranges 0` asks Nginx to return the
whole representation instead of supporting cross-pin byte-range assembly.
Other native conditional-request semantics are retained. An isolated Linux
Nginx fixture now verifies these semantics with the actual generated overlay;
this does not establish that production has loaded that overlay.
The existing 88 routes retain their independently reviewed immutable contract.

Only the known `android-mock-current` symlink is exempted from `disable_symlinks`
for the three pin-following aliases. The activation/upgrade controller must
validate that pin and both release inventories. The canonical JSON has no such
symlink exception. The overlay must remain installed after a rollback to 04.

## Validation and remaining gates

Run the local protocol tests with:

```sh
python3 -B platform/deploy/mock-sandbox/test_route_profile.py -v
python3 -B platform/deploy/mock-sandbox/test_route_profile_http.py -v
```

The pure tests use synthetic pins and temporary directories, including real relocated
store transactions. They cover exact profiles, source/body identity, metadata
semantics, config/material links and permissions, incomplete receipts, store
drift and read-only checks. They do not invoke Nginx or contact a server.

An actual historical-input candidate and read-only check against the existing
relocated 88-file store are retained in ignored
`review/release/mock-route-profile-04-to-05-20261008-v1/`. This verifies the pinned
real inputs and local material/store bytes, not a production installation. The
original vhost is 1,840 bytes; the overlay is 89,491 bytes.

The separate HTTP suite completed **5/5 tests without skips** on Linux using
both synthetic inputs and the authenticated historical source capsule. Each
HTTP case made 427 loopback HTTPS requests across 04→05→04. It checked the four
mutable routes, GET/HEAD, exact bodies/MIME/cache headers, conditional requests,
whole-body Range responses, query/noncanonical paths and 404/405 isolation from
the SPA fallback. All five Nginx temporary paths, logs, pid and lock paths were
confined to the fixture; upstream ports were isolated. Both owned Nginx
processes exited and ports closed, temporary fixture/upload directories were
removed, and public/Mock pins plus shared Nginx directory metadata were
unchanged. Evidence is retained in ignored
`review/release/mock-route-profile-http-final-20261008-223131Z-3663d2a9/`.

On hosts without Nginx/OpenSSL, HTTP cases explicitly skip. Historical cases
also require `OASIS_MOCK_ROUTE_HTTP_INPUTS`, pointing to a capsule containing
`bundle.tar` and the selected 04/05 manifest-authenticated inputs. The suite
does not install dependencies, reload production Nginx or activate the profile.

Still required: fresh full server release/static/dependency checks; the profile
aware startup and upgrade identity adapter; an atomic activation/recovery
transaction; validation of the enclosing Nginx configuration and worker access;
production 04→05→04 acceptance for all 88 assets and the four aliases, including
downloads during live pin changes and worker permissions; fresh Mock
13-game and APK acceptance. `no-store` does not invalidate an old cached schema-1
JSON response. The reviewed historical documentation bad links and ZIP download
wording also remain unchanged. This module does not waive any of those gates.
