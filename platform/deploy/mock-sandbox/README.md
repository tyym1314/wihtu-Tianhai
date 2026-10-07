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
2. Create a fresh PostgreSQL database and dedicated login with permissions only on that database. Do not copy live tables or data. Keep the database URL in `/opt/oasis/android-mock-private/runtime.env`, based on `mock.env.example`, mode `0600`.
3. Create `/opt/oasis/android-mock-private/state` owned by `oasis-mock`, mode `0700`. Generate **new**, independently random `master.key` and `hosted-demo-guest.key` files, each exactly 32 bytes and mode `0600`. Never copy either key from the live state directory.
4. Run `node deploy/mock-sandbox/preflight.mjs --mock-env /opt/oasis/android-mock-private/runtime.env --live-env /opt/oasis/private/runtime.env` from `platform/` as an operator able to read both files. Only `MOCK_SANDBOX_PREFLIGHT_OK` permits startup. The check prints no database password or key material.
5. Install the two example systemd units under the names `oasis-android-mock-api.service` and `oasis-android-mock-demo.service`. The root-only `ExecStartPre` reads the live runtime, and the long-running `oasis-mock` processes can write only their mock private directory. Validate the Nginx config before reloading it.
6. Independently verify HTTPS certificate, `/health`, `/demo/native/<id>` for all 13 IDs, guest cookie isolation, game action/settlement, resume, and response headers. Then build an APK bound to this exact mock HTTPS origin and run the entire physical Android acceptance matrix. An APK still bound to the live public demo is an interim artifact, not the isolated mock deliverable.

The mock stack must not share a database even when the live instance is itself named “sandbox.” The word “sandbox” in `OASIS_ENVIRONMENT=sandbox` controls test-credit behavior, not deployment isolation. Production admission remains disabled (`OASIS_PRODUCTION_ADMISSION_ENABLED=0`), and the local reference wallet is mandatory (`OASIS_START_WALLET=1`).

The files in this directory are templates and checks; **no mock service, DNS, TLS certificate, or APK was deployed by adding them**. Copy only sanitized templates into review. The actual runtime files, keys, and database credentials stay outside Git and the release tree.

## Same-host installer

`install.py` implements the above contract for the currently authorized host, `43.98.202.236`, using the exact new origin `https://oasis-mock.43.98.202.236.sslip.io`. It does not operate over SSH or modify the existing live vhost, Unix user, data volume, release link, private directory, or wallet. A root operator runs the following commands **on that server**, after packaging this tooling in a fully verified immutable release. Replace `YYYYMMDD-NN` with that actual release directory, never `current`:

```sh
python3 /opt/oasis/releases/YYYYMMDD-NN/platform/deploy/mock-sandbox/install.py check --release /opt/oasis/releases/YYYYMMDD-NN
python3 /opt/oasis/releases/YYYYMMDD-NN/platform/deploy/mock-sandbox/install.py provision --release /opt/oasis/releases/YYYYMMDD-NN
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py acme
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py certificate
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py start
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py status
```

`check` is read-only. It verifies every file in the release manifest, local dependencies, DNS, free ports, the existing local PostgreSQL image, Nginx configurations and includes, command availability, and absence of unrelated resources using any reserved name. It requires at least 3 GiB free disk, 3 GiB available memory and four host CPUs. These are installation reserves, not a performance guarantee. It refuses a symlink or mutable release alias. Subsequent stages are resumable for the exact same release; an existing differing file or a resource without the installation's random ownership label aborts rather than being overwritten or deleted.

`provision` creates a root-owned installation marker and secrets under `/opt/oasis/android-mock-private`, plus the independently pinned `/opt/oasis/android-mock-current` link. The mock user cannot traverse or read the live private directory. It creates `oasis-android-mock-postgres` with its own empty volume `oasis-android-mock-postgres-data` and Docker `--internal` network `oasis-android-mock-internal`, using the exact image ID already present for the live PostgreSQL container without pulling a new image. The database is exposed on `127.0.0.1:18983` through the dedicated `oasis-android-mock-db-proxy.socket` and `.service`, using `/usr/lib/systemd/systemd-socket-proxyd` as the confined `oasis-mock` UID to reach the exact recorded private container address on port 5432. Docker does not publish a port for new containers: an internal network can retain a `PortBindings` declaration without creating a working host listener. The runtime keeps its loopback URL. The runtime uses a dedicated, nonsuperuser `oasis_mock_app` role; credentials are generated on the server, kept in mode-0600 files and never echoed in process arguments or installer errors. Other databases reject connections by that role. The PostgreSQL bootstrap administrator credential is separate from the API credential. Provisioning starts only the mock database; it leaves the proxy, API and public HTTPS route inactive.

The dedicated nftables `inet oasis_android_mock` table applies only to the `oasis-mock` UID: existing connections and the mock loopback ports are allowed, as is the exact private mock PostgreSQL address used by the proxy; all other outbound traffic from that UID is rejected. The live API, wallet and database ports and external wallets are unreachable by the mock processes. The policy does not flush or edit any existing firewall table. A new database address or a changed policy fails closed. The proxy itself verifies release, UID, Docker ownership, fixed database address, network fingerprint and exact proxy unit contents before running. An API systemd drop-in requires the proxy service and socket to finish startup first. API and demo startup then repeat the isolation checks and run the key/database challenge preflight. Direct service starts receive the same checks; restarting the host starts the database, network boundary and loopback proxy before either mock process.

`acme` adds only two exact-host challenge configurations: `/etc/nginx/conf.d/oasis-android-mock-acme.conf` on the host and the same dedicated filename in the existing `proxy-nginx` container. It uses the existing host bridge listener `172.17.0.1:18884` with a new named vhost and its own `/opt/oasis/android-mock-acme-webroot`. Both Nginx configurations must pass before reload. A random HTTP challenge is fetched through the public hostname before certificate issuance. The challenge and post-reload public HTTPS checks retry only read-only GETs during a short 12-second readiness window, require the exact challenge bytes or healthy sandbox JSON, reject redirects and return a fixed failure code. Certificate issuance is not retried. `certificate` creates only the `oasis-android-mock` certificate under the existing certbot directories. `start` publishes its independent HTTPS vhost only after isolation and local health pass, and requires public HTTPS health with certificate validation before enabling boot startup. A failed startup stops only the mock API and demo.

`oasis-android-mock-certificate.timer` runs twice daily with jitter, restores only its own ACME proxy file if the proxy container was recreated, validates the route, and renews only its own certificate. Inspect restricted service logs without publishing credentials or cookies. The certbot account currently has no email contact; an operator must monitor timer failures and expiry.

Limits are API 1 CPU / 2 GiB maximum (1 GiB memory-high), guest host 0.25 CPU / 512 MiB maximum, and mock PostgreSQL 0.5 CPU / 1 GiB. The API uses one engine worker and a queue of 16. Docker logs are bounded to two 10 MiB files. This same-host constrained instance is **for single-user internal Android QA**, not independent production capacity or latency acceptance; synthetic database growth still requires disk monitoring. Do not run a 100-user load test against it or use its constrained timings as commercial launch evidence.

Read back the public origin, pinned release, service states, startup enablement, loopback endpoints and isolation guards with `status`. It reports `stopped` without opening a database connection when the stack is inactive. It reports `running` and `healthy: true` only when the API, demo, database unit, network unit, proxy service, proxy socket and database container are active, the isolation guard passes, the local database readiness and demo checks pass, and public HTTPS health identifies the sandbox environment. Partial starts or failed health checks report `degraded`; an isolation guard failure aborts the command. Then run the 13-game public smoke and physical Android full-game matrix against this new origin. Verify that the mock database begins empty, creates only mock identities and test-credit ledgers, can resume/settle, and that the live platform records do not change. The APK must be rebuilt with the exact new mock origin only after this validation.

To take this new stack out of service without touching live traffic:

```sh
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py stop
```

This disables and stops only the installed mock API/demo/database, proxy socket/service, network unit and certificate timer. Disabling the network unit and proxy socket prevents their database dependency from restarting the stopped mock database at the next boot. The loaded nftables rules remain in place until reboot; stopping the unit never deletes or flushes them. The mock vhost then returns an upstream-unavailable response; its configs, certificate, release pin, firewall policy file, volume and keys are intentionally retained for diagnosis and resumable restart. Run `status` afterward to verify the stopped state and disabled startup. There is no automated uninstall, forced resource replacement, data deletion or migration path. To choose a different immutable release after deployment requires a separately reviewed compatibility upgrade; changing the release argument cannot silently move this mock instance with the live release.

### One-time repair for the unstarted 20261007-03 stack

The narrowly scoped `repair_unstarted.py` can move only the mock pin from `/opt/oasis/releases/20261007-03` to `/opt/oasis/releases/20261007-04`. Run it from the verified new release, never from the old pin:

```sh
python3 /opt/oasis/releases/20261007-04/platform/deploy/mock-sandbox/repair_unstarted.py check
python3 /opt/oasis/releases/20261007-04/platform/deploy/mock-sandbox/repair_unstarted.py apply
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py start
python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py status
```

The repair verifies both complete release manifests and rejects changes outside the installer, its fixtures, this README and repair tools. It requires the original marker and pin, API/demo inactive and disabled with no main-process start history, all mock ports unused, no published mock HTTPS configuration, the owned database running with its recorded IP and nftables fingerprint, and zero application tables, views or sequences in every non-system schema. It queries that database inside its owned container and does not need the broken loopback listener. An existing running or populated stack is rejected.

`apply` writes a private repair journal, installs only the new mock proxy units and API dependency drop-in, changes only the mock release pin and marker, and reloads systemd unit definitions. It starts no service, issues no certificate, reloads no Nginx configuration and does not recreate a container, volume, database role or key. The runtime configuration, database credentials, both 32-byte keys and firewall policy are hashed before and after and must remain identical. The journal allows the same exact transition to resume after interruption; after completion, repeating it performs readback only. The ordinary installer still rejects arbitrary release upgrades, and this repair must not be used after the API has started or created business data.

Local fixture checks (no host mutation):

```sh
python3 -m unittest discover -s platform/deploy/mock-sandbox -p 'test_*.py' -v
```
