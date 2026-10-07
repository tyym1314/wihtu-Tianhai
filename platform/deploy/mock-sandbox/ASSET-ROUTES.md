# Offline Mock asset route candidate: 04 → 05

`asset_routes.py` generates a candidate Nginx include for the 88 retained files in
the verified [asset bundle](ASSET-BUNDLE.md). It does not extract or install any
asset, change a release or pin, edit an existing template, call a network/service,
start Nginx, or make `upgrade.py` pass. The four mutable conflicts remain blocked.

The only CLI modes are `generate` and `check`. Both read `bundle.tar` with the
existing regular-file/no-links guard, validate its complete contents with
`asset_bundle.check_bytes`, then obtain **the internal** `BUNDLE-PLAN.json` from
those same bytes. Adjacent `plan.json` and `receipt.json` are never trusted inputs.
There is no CLI override for origin, store, paths, hashes or validators.

The fixed deployment candidate is:

- Origin: `https://oasis-mock.43.98.202.236.sslip.io`
- Independent store: `/opt/oasis/android-mock-static-assets/20261007-04-to-20261008-05`
- Store members: exactly the verified bundle's `files/…` paths.

The generator writes three new mode-0600 files inside a new mode-0700 directory:
`locations.conf`, `adapter.json`, and `receipt.json`. It refuses existing output,
symlink components, linked input/candidate files, missing parents and installation
roots. Use a trusted local parent without concurrent filesystem writers; this is
not a hostile-local-user isolation tool. Failed writes leave the exclusive
directory for inspection, not overwrite-on-retry. `check` recomputes all three
files from the bundle and rejects changes or extra directory members.

## Explicit HTTP contract revision

The bundle contained a proposed SHA-based ETag. This candidate **revises that
uninstalled proposal** to native Nginx ETag and Last-Modified. It does not claim
to preserve the original validator contract. Body SHA-256 remains bound by the
verified bundle and must be verified again when the dedicated store is installed.
Native ETag is derived from file metadata, not a cryptographic content hash.

| Request | Candidate behavior |
| --- | --- |
| Exact GET | Native static body, correct Content-Length, JS/CSS MIME, identity encoding |
| Exact HEAD | Same representation length and validators, no body |
| Conditional If-* | Native Nginx behavior, including 304 or 412 where appropriate |
| Range / If-Range | `max_ranges 0` disables byte ranges; otherwise successful requests return the full 200 representation |
| Query, percent-encoded or normalized alias of a retained path | 404, no immutable success cache |
| Other method at an exact retained path | 405, `Allow: GET, HEAD`, `Cache-Control: no-store` |
| Retained store file missing or symlink-denied | 404 without SPA fallback, `Cache-Control: no-store` |
| Path outside the exact allowlist | Existing vhost behavior, no overlay match |

Each exact location separately checks HTTPS, the fixed Host (optional `:443`),
and `$request_uri` equality before serving. Nginx normalizes locations; `$uri`
equality alone would not reject encoded slashes/characters, duplicate separators,
dot segments or queries. Method guards only use `if … return`, with no rewrite.
Two internal named error handlers cannot intercept public URL paths. No wildcard,
API proxy, private route, root override or live-global-store fallback is emitted.

Successful representations use `public,max-age=31536000,immutable`, `nosniff`, and
`no-referrer`. `gzip off` and `charset off` prevent the current template's inherited
compression/charset behavior; Content-Length comes from the real static file,
not an added duplicate header. Conditional responses use native validators,
not blanket rejection of normal revalidation requests.

Official references: [original and normalized URI variables](https://nginx.org/en/docs/http/ngx_http_core_module.html#variables),
[ETag](https://nginx.org/en/docs/http/ngx_http_core_module.html#etag),
[If-Modified-Since](https://nginx.org/en/docs/http/ngx_http_core_module.html#if_modified_since),
[max_ranges](https://nginx.org/en/docs/http/ngx_http_core_module.html#max_ranges),
and [response-header inheritance](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header).
These document intended native behavior; they are not a runtime acceptance result.

## Local commands

Run from repository root with a fresh output directory:

```sh
python3 -B platform/deploy/mock-sandbox/asset_routes.py generate \
  --bundle platform/review/release/mock-asset-bundle-04-to-05-20261008-v1/bundle.tar \
  --output platform/review/release/mock-asset-routes-04-to-05-20261008-v1

python3 -B platform/deploy/mock-sandbox/asset_routes.py check \
  --bundle platform/review/release/mock-asset-bundle-04-to-05-20261008-v1/bundle.tar \
  --candidate platform/review/release/mock-asset-routes-04-to-05-20261008-v1

python3 -B -m unittest discover -s platform/deploy/mock-sandbox -p test_asset_routes.py -v
```

The optional HTTP test runs only if local `nginx` and `openssl` binaries exist.
It creates a temporary trusted TLS certificate and an owned loopback-only Nginx
process, tests the generated locations with only their store path relocated to
the fixture directory, then terminates that exact process and removes its own
fixture. It tests JS/CSS GET/HEAD, native conditional requests, disabled Range,
gzip/charset isolation, raw path negatives, wrong Host, method rejection, missing
files, inherited SPA errors, and unchanged API/private/unknown-path behavior.
It never downloads dependencies or invokes Docker, SSH, a public endpoint or an
existing Nginx service. These tests are not production deployment commands.

## Validation boundary and remaining work

This Mac has no local Nginx executable. The Mac run therefore explicitly
skipped the HTTP test; it did not verify Nginx syntax or HTTP behavior. A local
Docker image inventory did not complete, and no image was pulled or container
started. Pure configuration tests do not close the HTTP gate. Candidate receipts
always state `http_verified: false`, `installed: false`, `apply_allowed: false`.

The actual local candidate is retained under ignored
`review/release/mock-asset-routes-04-to-05-20261008-v1/`. It contains 88 exact URL
locations plus two internal error handlers. Generation and byte-exact readback
both passed. `locations.conf` SHA-256 is
`b98d9b0bb814eddf5a919eb122386a1e7b6be7ed0893c35e789cce650dc99929`;
`adapter.json` SHA-256 is
`708c1a9917bcb4dce609043f8698183a56100f0b5a7ab613fc307be72ca460ae`.
The local suite has 10 passing offline tests and one explicitly skipped HTTP
test. An initial platform-specific test expectation was corrected because macOS
`/etc` is rejected as a symlink before the deployment-directory guard; the
generator's refusal behavior was unchanged.

On 2026-10-08 (Asia/Shanghai), the same frozen sources passed **11/11 tests,
zero skips**, in a new private Linux fixture directory with the existing
Nginx 1.18.0 (Ubuntu) and OpenSSL 3.0.2. The real HTTP test passed `nginx -t` and
all of the synthetic JS/CSS TLS cases described above. It started only its own
loopback process with `daemon off; master_process off;`; a read-only runner
recorded that process as PID 1191980 on port 60113. The process was reaped with
exit code 0, and the port had no listener afterward. The public release remained
`20261008-06`, Mock remained `20261007-04`, and the existing Nginx service
remained `active` with main PID 1689488 before and after. No service reload,
template/pin/DB change, package installation or public/Mock business request was
performed. Uploaded source hashes were identical before and after the test.

Raw stdout/stderr, original exit code, input hashes and the before/after report
are retained under ignored
`review/release/mock-asset-routes-linux-20261008-211130Z-4da0889f/`.
The independent fixture sources/report remain in
`/tmp/oasis-mock-asset-routes-fixture-20261008-4da0889f/` on the Linux host.
This closes the synthetic Linux HTTP fixture gate only: it does **not** verify
the 88 actual bytes in an installed store, either real release pin's effective
configuration, controller compatibility, or browser/APK upgrade behavior.
Candidate receipts stay unchanged and are not installation approvals.

Before deployment, a separately reviewed installer must verify the full current
04/05 manifests again, resolve the four mutable conflicts explicitly, and install
the 88 verified bytes atomically in the dedicated store with stable metadata,
no links, no writable files and no `.gz`/other sidecars. Nginx cannot validate a
body SHA at request time; a corrupt or replaced store file must be rejected by
the installer and later integrity checks before serving under an immutable URL.

The enclosing dedicated HTTPS vhost must retain its origin/TLS isolation, contain
no inherited body transformation filters or `add_header_inherit merge`, and have
its effective configuration reviewed and `nginx -t` checked. This include is not
a patcher for the existing template. The frozen installer/controller still reject
changed template identities; installation, service-start compatibility, atomic
activation and recovery require another implementation and review.

Run real HTTP tests for the exact 88 bytes on both release pins, verify cache and
negative paths, then repeat 13-game Mock browser and APK acceptance. This module
alone satisfies none of those deployment or device gates.
