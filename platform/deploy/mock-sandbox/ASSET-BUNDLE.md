# Offline Mock retained-asset bundle: 20261007-04 → 20261008-05

`asset_bundle.py` prepares the exact missing immutable assets identified by the
real Mock upgrade check. It only compiles or checks local files. It contains no
network, subprocess, extraction, Nginx, systemd, database, installer or upgrade
operation. Adding or running this helper does not change either release or make
the existing `upgrade.py` gate pass.

The check identified 88 missing hashed JS/CSS files, totaling **3,692,973 bytes**.
The forward comparison had no missing files. Four changed mutable paths still
block both directions. The full operational context remains in [UPGRADE.md](UPGRADE.md).

## Fixed trust inputs

No CLI flag can replace the release, origin, pins, expected count or total size.

| Input | SHA-256 |
| --- | --- |
| Old 20261007-04 manifest, as observed by the real check | `47e5cab2ff8c910e7821e6c1edbd92a26135944241fc5b0c1610a44952d883bc` |
| Complete 20261008-05 manifest | `b5ae243cf9860cd8323783422459811ff3efb13ff41ba3342084f9ae50ca78db` |
| Complete 20261008-05 `.tar.gz` | `3bb2170363c9f1e00cc9c2d37e2ebd83060838e873c24dbb6647455bc8076990` |
| Real check-only log | `a5a99b16379e03a725f66f14c0302e119966c97c7067616f5a1f5aa6f4fddd4b` |
| Real check-only metadata JSON | `08b07f8c79d212487d2db4ff3a2b99c76e8c896d0f121a4d95aaca84fdd371f2` |

The manifest is associated with reviewed source commit
`12e453a67236a0539c23c68eac1b057e7cec808a`. The fixed Mock origin is
`https://oasis-mock.43.98.202.236.sslip.io`. These are pinned operator evidence,
not a new signature system or a fresh inspection of the remote filesystem.

Compile verifies the entire compressed archive before and after its streaming
read, the embedded and adjacent manifest bytes, all 1,013 declared source files,
and exact archive membership. It never extracts the source archive. It rejects
unmanifested files, omitted files, duplicate entries even if identical, links,
special files, unsafe paths and PAX path/size/sparse extensions. The known source
uses only PAX `mtime`. Resource bounds limit compressed/expanded bytes, individual
file size, JSON size and entry count. The 88 selected bodies must match manifest
SHA-256 values and the independently observed total size.

Check revalidates the resulting self-contained bundle's pinned manifest and
check evidence, every selected body, the complete derived route plan, and the
exact canonical tar byte stream. It need not read the large source archive.
Canonical roundtrip rejects hidden trailing data or concatenated tar streams.
The bundle does not prove that today's old release still has its earlier bytes;
that remains a required fresh deployment precondition.

## Local commands

Run from the repository root. Use a new output directory each time; the helper
never overwrites a previous artifact and never creates parent directories.

```sh
python3 -B platform/deploy/mock-sandbox/asset_bundle.py compile \
  --archive platform/review/release/oasis-20261008-05.tar.gz \
  --manifest platform/review/release/oasis-20261008-05.tar.gz.manifest.json \
  --evidence platform/review/release/mock-upgrade-check-only-aac818df-20261007T202802Z.json \
  --evidence-log platform/review/release/mock-upgrade-check-only-aac818df-20261007T202802Z.log \
  --output platform/review/release/mock-asset-bundle-04-to-05-20261008-v1

python3 -B platform/deploy/mock-sandbox/asset_bundle.py check \
  --bundle platform/review/release/mock-asset-bundle-04-to-05-20261008-v1/bundle.tar

python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p 'test_asset_bundle.py' -v
```

The output contains `bundle.tar`, an external copy of `plan.json`, and
`receipt.json`. The tar contains `BUNDLE-PLAN.json`, three pinned evidence files
under `source/`, and 88 bodies under `files/`. Only listed `files/` members are
eligible for future HTTP routing; **never expose the bundle, receipt, manifest
or evidence directory as a web root**. The original metadata records a local
operator path and is not a public asset.

Compile uses a fresh mode-0700 directory and mode-0600 files. Immutability here
means deterministic, hash-bound bytes with conflict refusal; no filesystem
immutable flag or live read-only mount is installed. Input files must be regular
single-link files with no symlink component. Use a trusted local parent without
concurrent filesystem writers; this is not a hostile-local-user isolation tool.
Installation roots such as `/opt`, `/etc` and `/run` are forbidden outputs. A
failed output write leaves an incomplete directory for inspection, which cannot
be overwritten by retry. A later check must succeed before any handoff.

Check creates no file or directory, extracts nothing, and only reads its bundle.
As with ordinary reads, OS access-time bookkeeping is outside this guarantee.
Use `-B` to avoid Python bytecode cache writes when running local test discovery.
CLI errors are sanitized and return 2; success returns 0. A successful artifact
check always reports `apply_allowed: false`, `installed: false`, and
`network_checked: false`.

## Exact route contract, not a generated server configuration

The JSON plan lists each source path, exact URL path, tar member, SHA-256, byte
length and response headers. Only eight-character hashed filenames under these
three namespaces are allowed:

- `/assets/<name>-<hash>.js` or `.css`
- `/arena/assets/<name>-<hash>.js` or `.css`
- `/legacy/bundles/<name>-<hash>.js` or `.css`

Only exact raw paths on the pinned Mock origin may match; queries, percent
encoding, traversal, duplicate separators, extra suffixes and subdirectories
must not be normalized into additional matches. The plan requires GET/HEAD only,
identity encoding, no body transformation, `text/javascript` or `text/css`,
exact representation `Content-Length`, `nosniff`, a SHA-based ETag and
`public,max-age=31536000,immutable`. GET has the exact body and HEAD has no body
with the same length and validators. Other methods at a listed path require
405. An unknown path has no overlay match; its existing application behavior is
not redefined by this helper. Conditional/range behavior is not implemented;
a future adapter must preserve this explicit identity/full-response contract
or undergo additional review before adding transformations or range responses.

Future exact locations must take precedence over existing Mock static/game
proxy routing on both pin values without replacing `/api`, `/api/demo`, `/v1`,
`/play`, `/demo`, `/health`, or any private route. No wildcard fallback into the
live global static store is permitted. The plan deliberately contains no
executable Nginx config, install target, reload command or template exemption.

The four conflicts remain explicitly classified in every plan:

| Path | Classification |
| --- | --- |
| `platform/dist/downloads/android-smoke-build.json` | Mutable download metadata |
| `platform/dist/downloads/oasis-partner-sandbox-kit.zip` | Mutable partner kit |
| `platform/dist/specs/android-webview-integration.md` | Mutable integration document |
| `platform/dist/specs/third-party-launch-readiness-2026-10-07.md` | Mutable readiness document |

Each record retains both comparison directions, its pinned new hash, a null old
hash explicitly labeled unavailable in the historical check evidence, and a
blocked resolution. No conflict body is added to the overlay. Classification
does not exempt it from the frozen upgrade controller.

## Actual local result and remaining gates

The actual artifact is under ignored
`review/release/mock-asset-bundle-04-to-05-20261008-v1/`:

- `bundle.tar`: **3,973,120 bytes**,
  SHA-256 `451de257618ca94446087e966e64ce90ec0fb58e8754f637a1c5af88f2854e47`.
- `plan.json`: SHA-256
  `a2250397d92e1295025c3c5f009280270d8693560176a7ddf5d8049aac5b6798`.
- Bodies: **88 files / 3,692,973 bytes**; the overhead is canonical tar headers,
  padding, complete source manifest, plan and retained check-only evidence.

The 27 local tests cover hostile tar types/paths, duplicate and missing entries,
non-selected source drift, pinned input mutation, read-only checks, deterministic
output, payload corruption, API/route/MIME/cache/hash forgery, conflict erasure,
foreign origins/stores, trailing archives, resource bounds and sanitized errors.
They test filesystem/protocol behavior, not HTTP, Linux service integration or
browser acceptance.

Before any remote use, independently review these files and pins. The next
adapter must freshly verify both complete manifests and all actual static files,
review the four mutable conflicts with old/new bytes, publish only these exact
files into a dedicated Mock store atomically, prove conflict refusal and retained
files across restart/rollback, and read back every GET/HEAD contract on both
pins. It must also prove API/private-route isolation and negative encoded/unknown
path behavior. `upgrade.py` currently rejects changed Nginx/template identities;
that integration and interrupted-install/start recovery need separate review.
Fresh 13-game browser and APK acceptance is still required. This work performs
no remote apply, no Mock upgrade, and no release or service change.
