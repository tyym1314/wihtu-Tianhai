# Inactive Mock retained-asset store: 04 → 05

`asset_store.py` adds the filesystem installation and interrupted-install recovery
step for the verified [asset bundle](ASSET-BUNDLE.md) and
[route candidate](ASSET-ROUTES.md). It does not activate those routes, write Nginx
configuration, invoke a service, change either release/pin, access a database, or
change the existing `install.py` / `upgrade.py` identity and compatibility gates.

This is a bounded component, **not a working Mock upgrade**. All four mutable
conflicts remain individually recorded and blocked. No HTTP or device acceptance
is implied by successful filesystem installation.

## Fixed input and destination

The CLI only accepts `check`, `install`, or `recover` plus `--bundle`. It requires
root and always addresses:

```
/opt/oasis/android-mock-static-assets/20261007-04-to-20261008-05
```

There is no CLI option to override the store, owner, origin, release, pins,
routes, validators, asset list, or conflict policy. The Python `Store` class
allows relocation for isolated local tests; its result explicitly records the
actual `installation_path`, `relocated_fixture`, and
`production_store_installed`. A relocated test cannot report that `/opt` was
installed. `nginx_state: not-inspected` is intentional: this component knows
that it performed no activation, but does not claim to observe Nginx state.

The same opened bundle bytes go through the complete pinned bundle verifier and
the route generator. Bodies come only from the verified **internal** plan. An
adjacent editable `plan.json`, candidate configuration, or `receipt.json` is not
an input. The canonical intent binds the bundle SHA, internal plan SHA, exact
generated location SHA, complete filesystem layout SHA, scope/pins, and all four
unresolved conflict records. The production pins still require exactly 88
hashed JS/CSS bodies totaling 3,692,973 bytes. Only the plan's `files/…` members
are installed; source manifests, evidence, and metadata are never put in the
servable tree. There are no API routes, sidecars, wildcard imports, or references
to the live shared static store.

## Filesystem contract and recovery

The dedicated parent and published root are root-owned 0755. Nested directories
are root-owned 0555; every body is a root-owned, single-link regular file with
mode 0444 and fixed mtime `2026-10-07T00:00:00Z`. Exact bytes, length, owner, mode,
mtime, no-links, and full directory membership are checked before publication
and every later check/recovery. Stable file metadata preserves the candidate's
native Nginx ETag and Last-Modified across restart/recovery; those validators are
not SHA hashes. The root's 0755 mode also permits directory rename on macOS;
the Nginx worker does not own or have write access to it.

The implementation checks every ancestor for links, unexpected owners, and
group/other write access. It assumes a trusted administrator-owned parent and
cooperating root writers. It is not protection against another malicious root
process. Read-only mode bits do not prevent root from changing files, so a
future activation/start guard must run the complete integrity check.

The only lock is `.asset-store.lock` in the dedicated parent. It is a regular,
single-link, root-owned 0600 empty file; identity is checked after a nonblocking
flock. This component takes no service, release, network, or upgrade lock and
executes no subprocess. An activation adapter must design its own common lock
order before calling it inside another transaction.

Installation first persists a canonical intent, then writes into a private
stage under the same parent. Each body is fsynced, assigned its final mode and
mtime, and renamed from a private temporary file. Existing staged bodies must
already match exactly; they are never overwritten. After a complete readback,
directories are sealed and the whole stage is atomically renamed to the final
name. The parent is fsynced before writing a canonical completion receipt.

Recovery validates all existing transaction objects before any mutation:

- A partial metadata write must be a prefix of the exact expected canonical
  document. It can then be rewritten from the verified bundle.
- An interrupted private body temporary file can be removed and reconstructed.
  Links, foreign owners, unsafe modes, or oversized temporary bodies are refused.
- Missing staged bodies can be added from the same bundle; valid existing bodies
  retain their inode, bytes, mode and mtime.
- A fully published tree without its receipt is revalidated and gets its receipt.
  Repeated recovery of a completed store makes no file-content/mtime changes.
- A corrupt, missing or extra published body, contradictory final/stage trees,
  unclaimed final tree, unexpected parent member, or altered intent/receipt is
  refused and left for inspection. Recovery never deletes a published store or
  repairs its bytes behind an immutable URL.

`install` refuses any prior transaction and directs the operator to `recover`.
There is no uninstall, force, overwrite, bypass, activation, or conflict-waiver
mode. Failed attempts preserve the staged evidence. All user-visible error
responses are sanitized and return 2. Successful checks still report
`apply_allowed: false`, `upgrade_allowed: false`, and `http_verified: false`.

`check` opens the existing lock read-only and takes a shared nonblocking flock.
It creates no file/directory, cleans no partial write, and invokes no recovery.
An absent or incomplete installation fails read-only. Ordinary access-time
bookkeeping and advisory locks are outside the no-persistent-write guarantee.

## Local verification

Run the relocated tests from the repository root:

```sh
python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p test_asset_store.py -v
```

The tests use their own workspace temporary directories and synthetic pinned
bundles; no `/opt`, Nginx, service or remote operation is performed. They cover
ten interruption boundaries, partial writes, receipt loss, inode preservation,
lock contention, exact metadata/body/membership checks, symlinks/hardlinks,
read-only checks, wrong owners, same-size corruption, sidecars, ambiguous trees,
explicit conflict retention and sanitized CLI rejection.

The final local run passed all 25 new tests. The complete Mock Python suite
reported 115 tests: 114 passed, one skipped because this Mac has no Nginx binary.
That skip is the existing loopback HTTP route test; no Linux/root or real-vhost
validation is claimed for this new filesystem component.

An actual-bundle relocated fixture is retained in ignored
`review/release/mock-asset-store-local-20261008-v3/`. It installs, checks and
recovers the exact 88 files / 3,692,973 bytes, records each member's digest/mode/
mtime, and confirms idempotent recovery. Its report distinguishes the relocated
path from the fixed production destination. The earlier `v1` evidence preserves
the prior report schema; `v2` used the next UTC midnight as fixed mtime. `v3`
uses a fixed timestamp before the pinned build, avoiding a future Last-Modified
value at the current test time. Use `v3` for the final source. These fixtures
install no real overlay and change no Nginx configuration.

For a separately reviewed operational handoff, the fixed-destination commands
are the following; they have **not** been run against the real Mock host:

```sh
python3 -B asset_store.py install --bundle /operator-owned/path/bundle.tar
python3 -B asset_store.py check --bundle /operator-owned/path/bundle.tar
python3 -B asset_store.py recover --bundle /operator-owned/path/bundle.tar
```

## Remaining upgrade blockers

1. **Fresh release evidence:** the bundle pins the historical check and complete
   05 source package, not today's full 04/05 filesystem. The activation adapter
   must revalidate both complete manifests, installed dependencies and current
   static inventories before installing any effective route.
2. **Four mutable conflicts:** `downloads/android-smoke-build.json`,
   `downloads/oasis-partner-sandbox-kit.zip`, `specs/android-webview-integration.md`,
   and `specs/third-party-launch-readiness-2026-10-07.md` need verified old and new
   bytes, an explicit per-path update/rollback policy, and HTTP/cache checks.
   Their old hashes are absent from the historical evidence. This component
   cannot supply that missing evidence and does not turn classification into an
   exemption. None of these files enters the immutable store.
3. **Identity and restart adapter:** `upgrade.py` currently requires the exact
   original Nginx template and pins the installer hash to the old manifest.
   `install.py start()` also calls `exact_file` with the original template after
   starting API/demo; an overlay conflict would enter its exception handler and
   stop those two services. Merely relaxing the controller's config comparison
   is therefore unsafe. A separately pinned adapter must accept the original
   profile and exactly one verified overlay profile consistently across start,
   upgrade and recovery, with no broad template or installer-hash exemption.
4. **Activation transaction:** generate the effective config from the verified
   internal plan, verify the enclosing vhost, preserve its other bytes, run
   Nginx syntax/HTTP checks, and implement atomic activation and interrupted
   config/reload recovery with an agreed lock order. This component generates
   no config file and calls no reload.
5. **Acceptance:** read back all 88 actual GET/HEAD bodies, MIME/length/cache and
   validators on both real pins; test encoded/query/method/missing/API/private
   negatives and mutable-path rollback behavior; then repeat all 13 Mock games
   and the Android APK acceptance. Synthetic Linux route tests alone do not
   satisfy these gates.

The original templates, `install.py`, `upgrade.py`, business data, and release
pins remain unchanged by this work.
