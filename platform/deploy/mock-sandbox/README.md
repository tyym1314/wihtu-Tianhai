# Android full-play mock stack: isolation contract

The Android test APK needs all 13 released games to remain playable, including authoritative rooms, rules, reference-wallet settlement, and resume. A local Java-only response stub cannot supply those engines. This stack therefore runs the **same game code** behind a **separate HTTPS origin**, with synthetic guest identities and test credits. It is an online staging/mock integration environment. It is not an offline APK, a production wallet, or evidence that 13 games have passed physical-device acceptance.

The APK's native lobby has its own deterministic `MockPartnerApi` for profile, display balance, and game selection. Once a game opens, the WebView's `/demo/native/<game>` host creates a distinct cookie guest and launches through the isolated platform sandbox. The native display balance does not claim to be the game wallet balance. All 13 game engines remain server-authoritative.

## Mandatory boundaries

| Resource | Live platform | Android mock stack |
| --- | --- | --- |
| HTTPS host | Existing platform host | New exact host with a valid certificate |
| PostgreSQL | Existing live database | Newly created `oasis_android_mock` database and dedicated login |
| Master and guest HMAC keys | Existing private state | Two new random 32-byte files in an independent private directory |
| API / reference wallet / demo host | Existing loopback ports | Dedicated 18981 / 18982 / 18985 ports (or another disjoint set) |
| User and wallet data | Existing platform records | Synthetic cookie guests and reference test credits only |

`preflight.mjs` rejects missing or shared public origin, database name, loopback ports, private directory, or key bytes. The mock reference wallet must be `http://127.0.0.1:<mock-wallet-port>`. `OASIS_WALLET_ALLOWED_ORIGINS` may be missing or empty because the runtime implicitly permits that reference wallet; if present, every nonempty comma-separated entry must name only that same loopback origin. An inherited live wallet origin or any additional target aborts startup. The preflight then connects to both configured databases and holds a transaction-scoped advisory-lock challenge. That catches two different connection strings that actually point at the **same physical PostgreSQL database**. If either database is unreachable or the challenge cannot run, the service must not start. This preflight reads live credentials only in a short-lived root process; the mock API and guest host receive only the mock runtime file. No live credential or key is copied into the mock runtime file.

The two example systemd units run the preflight **before every start**. Do not start `server/index.mjs` or `deploy/demo-host.mjs` directly with the mock runtime file in staging; that bypasses the isolation gate. Use the dedicated unit files or an equivalent supervisor that executes this preflight and aborts on failure.

## Staging setup

1. Allocate a new HTTPS hostname and certificate. Install `mock.nginx.conf.example` only after replacing its hostname and certificate paths and checking that every upstream points to the mock ports. Do not edit the existing live vhost. The root must serve the same verified `platform/dist` build as the API code version.
2. Create a fresh PostgreSQL database and dedicated login with permissions only on that database. Do not copy live tables or data. Keep the database URL in `/opt/oasis/private/android-mock/runtime.env`, based on `mock.env.example`, mode `0600`.
3. Create `/opt/oasis/private/android-mock/state` owned by `oasis-mock`, mode `0700`. Generate **new**, independently random `master.key` and `hosted-demo-guest.key` files, each exactly 32 bytes and mode `0600`. Never copy either key from the live state directory.
4. Run `node deploy/mock-sandbox/preflight.mjs --mock-env /opt/oasis/private/android-mock/runtime.env --live-env /opt/oasis/private/runtime.env` from `platform/` as an operator able to read both files. Only `MOCK_SANDBOX_PREFLIGHT_OK` permits startup. The check prints no database password or key material.
5. Install the two example systemd units under the names `oasis-android-mock-api.service` and `oasis-android-mock-demo.service`. The root-only `ExecStartPre` reads the live runtime, and the long-running `oasis-mock` processes can write only their mock private directory. Validate the Nginx config before reloading it.
6. Independently verify HTTPS certificate, `/health`, `/demo/native/<id>` for all 13 IDs, guest cookie isolation, game action/settlement, resume, and response headers. Then build an APK bound to this exact mock HTTPS origin and run the entire physical Android acceptance matrix. An APK still bound to the live public demo is an interim artifact, not the isolated mock deliverable.

The mock stack must not share a database even when the live instance is itself named “sandbox.” The word “sandbox” in `OASIS_ENVIRONMENT=sandbox` controls test-credit behavior, not deployment isolation. Production admission remains disabled (`OASIS_PRODUCTION_ADMISSION_ENABLED=0`), and the local reference wallet is mandatory (`OASIS_START_WALLET=1`).

The files in this directory are templates and checks; **no mock service, DNS, TLS certificate, or APK was deployed by adding them**. Copy only sanitized templates into review. The actual runtime files, keys, and database credentials stay outside Git and the release tree.
