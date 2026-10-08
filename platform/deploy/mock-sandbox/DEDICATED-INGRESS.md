# Dedicated Mock ingress migration

**Status: experimental alternative, not the selected upgrade path.** The
current 04-to-15 plan uses [derived release views](RELEASE-VIEWS.md) to retain
historical download bytes and publish new files at versioned paths. APK 1.3
opens `/demo/native/<game>` directly; it does not depend on updating those four
historical download URLs. This removes the need to change the existing Nginx
entry point for that upgrade. No dedicated ingress has been installed.

The native isolation results below remain valid within their stated fixture
scope. They do not qualify this unit for the host: its installed Nginx 1.18.0
does not support the example unit's `-e` option
([introduced in 1.19.5](https://nginx.org/en/docs/switches.html)). Do not install
the example as-is.

The current public Web release is separate from this candidate. The installed
Mock remains `20261007-04`. None of these new files changes an installed service,
APK origin, release pin or database. The failed shared-master Linux attempt3
remains a failure: HUP changed a drifted `/var/lib/nginx/body` owner's metadata.

The replacement architecture runs a separate, unprivileged Nginx master and
workers as `oasis-mock-ingress`, on **127.0.0.1:18986 with TLS**. Its complete
configuration has no shared includes. All five temporary destinations, PID and
lock live in `/run/oasis-android-mock-ingress`; errors go to stderr and access
logging is disabled. The service grants no capabilities and no new privileges,
uses a read-only system namespace, and makes the shared Nginx configuration,
temporary paths and application secrets inaccessible. RuntimeDirectory is the
only persistent-named writable service directory (PrivateTmp remains private).

`dedicated_ingress.py` only renders candidate bytes. `build_config` accepts the
byte-exact original Mock server template. `build_profile_configs` first verifies
all transitive Python dependencies and the existing manifest/body/bundle checks,
then transforms freshly generated original/overlay profiles. It does not accept
an arbitrary Nginx body or caller-authored approval receipt. The old profile,
store and upgrade modules and their exact pins are unchanged.

The existing historical **04→05** asset contracts remain useful compatibility
evidence, not permission to upgrade the Mock to current public15. A current
release pair still needs complete manifest, dependency, database, engine and
static-difference verification. Installing historical05 would not deliver the
current Run input improvements and is not the intended final state.

## TLS, proxy and credential boundary

A stable outer shared443 vhost forwards the original URI, Host and sanitized
client IP to the dedicated TLS listener. The example pins SNI to the existing
Mock host and enables upstream certificate and hostname verification. The inner
profile therefore still observes `$scheme=https` and its original public Host,
so its strict immutable/mutable routes need no insecure forwarded-scheme bypass.
The inner configuration disables port_in_redirect so `/demo` and directory slash
redirects cannot expose the private 18986 listener.
Only a loopback transport is trusted for `X-Real-IP`; the outer proxy replaces
that value with its actual client address and discards caller-supplied XFF.
A local unprivileged process can still reach a loopback port; deployment must
verify existing host user/network isolation and must not expose 18986 publicly.

The dedicated service reads the Mock certificate using systemd LoadCredential.
It receives its own read-only credential copy, rather than access to the ACME
private directory. A normal HUP does **not** refresh that copy. Certificate
rotation must restart only this dedicated service after a verified credential
update, with health checks and recovery; that lifecycle has not yet been
implemented or verified. Existing shared certificate renewal is not sufficient.

The outer candidate disables gzip/gunzip, charset conversion, inherited expires,
cache and error interception and adds no rewrite
or URI suffix. Its actual two-hop GET/HEAD, validators, raw URI, Range, forwarding
and certificate-failure behavior still require Linux integration tests. The
single-process native fixture must not be reported as proof of that chain.
Other shared enclosure response filters/header policies still require an exact
include-closure review before first migration; these directives do not sanitize
an arbitrary parent configuration.

References: [Nginx command switches](https://nginx.org/en/docs/switches.html),
[Nginx TLS upstream verification and URI forwarding](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[Nginx trusted real-IP sources](https://nginx.org/en/docs/http/ngx_http_realip_module.html),
[systemd execution sandbox and credentials](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

## Remaining activation work

1. Verify actual rootless Linux start, syntax check, good and rejected HUP,
   shutdown, TLS and unchanged shared path content/metadata. Preserve attempt3.
2. Verify the exact systemd unit, runtime ownership, credential lifecycle,
   restart/boot and wrong-identity refusal on the target systemd version.
3. Implement a durable dedicated activation/upgrade adapter with source/pair
   identities, preparation, atomic configuration switch, health and recovery.
   Preserve the existing financial/pending-business gates and backup protocol.
4. Resolve the **first shared443 migration** as a separate, reviewed operation.
   A stable forwarder removes subsequent shared reloads; it does not make the
   first one safe by assumption. A read-only preflight alone cannot eliminate
   the demonstrated time-of-check/time-of-use gap. Do not install the outer
   example or invoke the existing failed shared-HUP controller as a shortcut.
5. Bind current assets/runtime to the Mock, then perform all13 game flows and
   physical APK acceptance. Only then can the APK update barrier be closed.

The native fixture uses an isolated container, synthetic credentials/upstreams,
and real non-root Nginx processes. It requires no mount capability, no host
mount, no external network and no production paths. It tests process isolation,
not actual installed systemd restrictions or the first shared443 migration.

## Verified native process result, 2026-10-08

The first dedicated-rootless Linux run passed **9/9** cases using Debian Nginx
1.22.1 and Python3.11, under default Docker AppArmor and seccomp. Both normal and
rejected syntax/start operations, TLS startup, public redirects, normal/rejected/
recovery HUP and graceful shutdown preserved the protected shared snapshots.
The same master remained alive on HUP; successful reloads replaced its worker,
and invalid configuration retained the old worker and a healthy TLS response.
Both Host forms (plain and `:443`) redirected `/demo` to the public HTTPS origin
without the private port. The synthetic trusted-hop client address reached the
upstream unchanged.

Nginx master/worker used UID/GID2345, no supplementary groups, zero effective,
permitted, inheritable and ambient capabilities, and NoNewPrivs=1. Their bounding
set was still `0xeb`; the evidence does not claim it was zero. Container setup
retained only six ordinary Docker capabilities for synthetic permissions and
child cleanup; it had no SYS_ADMIN, no bind mounts and no external test network.
No shared production Nginx parser, reload, mount or service change was performed.

Evidence: `review/mock-dedicated-ingress-native-20261008-481739a6/`, native report
SHA256 `792dc7e455cbf308396882c182d49be475c42874d94161f5796a76c5dd837c37`.
Renderer `c1bb95dba43775e52a19bc9dabc944aa2c0657ae4c0a01cc2deea80bfd311a00`;
fixture `c0135900363f12aa442e1ce061957f6cbc1f876465b7f7ba5c49ba4a03afbfe5`.
The original failed shared-master attempt3 remains unchanged. This result closes
the synthetic dedicated-process isolation proof, not the migration, systemd,
credential, double-proxy, current-runtime or mobile gameplay gates listed above.

Local checks: 35/35 dedicated builder/fixture tests and 15/15 unchanged historical
route-profile tests passed. These support the native run; they are not counted
as extra native cases.
