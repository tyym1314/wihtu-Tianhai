# Production03 own-route reload wait

`production-ingress-wait.py` is a root-private operator for the exact immutable
production03 ingress. It addresses two observed graceful-reload transitions:
an own HTTP challenge temporarily returned 404 after Nginx reload; an own HTTPS
request temporarily received the previous default certificate. The original
failed operation reports and successful closed-backend receipt remain unchanged.

The operator does not issue or renew certificates, create identities, fund
balances, change admission, move either current release, or operate databases.
It supports only `check`, `acme` and `start`. Here `acme` means the original
challenge-route preparation and exact challenge GET; it never runs Certbot.

## Fixed source and existing prerequisites

The server execution path must be
`/opt/oasis/private/production-ingress-wait-20261010/production-ingress-wait.py`,
with a root/root 0700 parent and a root-owned regular, single-link 0600 source.
The operator refuses unexpected loader, proxy, alternate CA, key-logging and
D-Bus environment variables. The caller supplies the exact external tool SHA256
and the 40-character repository master commit that contains those bytes. That
commit is provenance supplied by the reviewed deployment executor; this tool
does not contact Git or resolve a server repository.

The only release is `/opt/oasis/releases/20261010-03`, whose manifest SHA256 is
`901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d`.
The exact ingress and its three helper SHA256 values are in `MEMBERS` in the
operator. Each source is read through a no-follow FD, with complete identity,
metadata and SHA checks before executing those same verified bytes. No cached
bytecode or second loader read is used. The in-memory helper resolver only
returns the three already verified modules at their exact immutable paths.
Current source for a future release cannot substitute for production03.

The historical closed-backend receipt is fixed at
`/opt/oasis/production-instance-private/recovery-bootstrap-tail-20261010/receipt.json`,
SHA256 `186ce1c8f9ccdd8c9d002f2cb22b31f74dd9caee39cd1388ce61bc6dcf93de4e`.
It must prove passed `complete_closed`, production03, admission disabled, no
players or funding, successful bootstrap and successful restore with cleanup.
This is historical provenance, not fresh database evidence. Before invoking the
operator, the root executor independently verifies the current production03
resource ownership, four private pins, production PIN and effective units. An
already issued `oasis-production-player` lineage with the exact sole stage-domain
SAN is required; the existing certificate helper checks its renewal scope,
public leaf and symlink identities without reading private-key bytes. Its proof
must remain identical throughout the operation.

## Bounded requests and unchanged protection

Only these original ingress GETs receive a wait window:

- `https://oasis-player.43.98.202.236.sslip.io/health/ready`, with no query or hash;
- the same host's HTTP challenge URL with the original exact `player-` plus
  32-lowercase-hex token and its matching expected body.

Each own request has a 15-second monotonic window, at most 64 attempts, and a
250-millisecond interval capped by the remaining time. A fixed source-bound
child process makes each single GET using absolute `/usr/bin/python3 -I -B`, a
minimal environment, no proxies and the standard strict TLS context. A bounded
subprocess timeout also covers DNS and response-read stalls, and kills and
reaps a stuck child. Filesystem/proof guards run between attempts and before
accepting the response. This is a request-window bound, not a 15-second limit
on the entire original deployment procedure.

Only 404, 502, 503, typed `ECONNREFUSED`, and an HTTPS validation error whose
code is 62 and whose verification message is the exact own-host hostname
mismatch may be retried. The hostname mismatch never counts as success: a
later GET must complete with normal certificate-chain and hostname validation.
Certificate expiry, trust-chain errors, foreign-host errors, redirects, changed
URLs, unknown transport errors, excessive bodies, and successful HTTP responses
with unexpected content fail immediately. A successful ready response must be
a JSON object with `status=ok` and `environment=production`; the challenge body
must exactly match its own token. Response bodies and headers are not printed.

Every unrelated request, including public sandbox health and loopback readiness,
uses the unchanged original single-request function. The wrapper calls the
original ingress `main` for mutations. Its fresh full check, exclusive operation
namespace, shared release-lock FD and inode checks, protected host/proxy
configuration checks, effective certificate units, and exact authored-config
rollback remain active. TLS rollback does not overwrite externally replaced
files. The wait adapter changes only the own GET function and the verified
helper resolver in memory.

## Invocation and evidence

Upload the source into a newly and exclusively owned root/root 0700 parent,
verify its external SHA, and retain all older failure evidence. Use a minimal
environment. Replace `TOOL_SHA`, `MASTER_COMMIT` and `CHECK_SHA` below with exact
reviewed values; they are not defaults.

```sh
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/python3 -I -B \
  /opt/oasis/private/production-ingress-wait-20261010/production-ingress-wait.py check \
  --controller-sha256 TOOL_SHA --source-commit MASTER_COMMIT \
  --manifest-sha256 901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d \
  --output /opt/oasis/private/production-ingress-wait-20261010/check-v1.json

env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/python3 -I -B \
  /opt/oasis/private/production-ingress-wait-20261010/production-ingress-wait.py start \
  --controller-sha256 TOOL_SHA --source-commit MASTER_COMMIT \
  --manifest-sha256 901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d \
  --check-file /opt/oasis/private/production-ingress-wait-20261010/check-v1.json \
  --check-sha256 CHECK_SHA \
  --output /opt/oasis/private/production-ingress-wait-20261010/start-v1.json
```

For challenge preparation use `acme` instead of `start`, with its own exclusive
output name and a new successful check if the previous check has become stale
or the intended own configuration changed. Each supplied check is externally
SHA-bound, root600, fresh within 15 minutes and bound to the exact tool, source
provenance, closed receipt and immutable release. The unchanged original ingress
rechecks the embedded original check under its global lock before any mutation.

Successful check schema is `production-ingress-wait-check-v1`; it contains
`read_only=true`, `passed=true`, `controller`, `binding`, `checked_at_ms`, and the
unchanged `ingress_check`. Operation schema is
`production-ingress-wait-operation-v1`; it records original/check hashes,
exclusive evidence directory, timestamps, wait attempts and body hashes, and
`certificate_issued_by_this_tool=false`. Files are exclusively created root600.
Both successful and failed operations preserve the materialized original check
in an exclusive root700 operation subdirectory. Preflight failures print only a
safe error code; the root executor preserves that output independently. An
operation failure retains the original rollback behavior and produces a failed
operation report. No existing check, output or historical receipt is overwritten.

The root executor must independently read back strict own HTTPS production
readiness and exact challenge behavior, effective certificate renewal units,
unchanged public health/configuration/process pins and unchanged retired Mock
410 routes. A local passing test suite is not proof of real server activation,
Android performance or production admission.

## Local regression checks

```sh
python3 -I -B -m unittest discover -s platform/deploy \
  -p test_production_ingress_wait.py -v
```

The tests use no network, SSH, ADB, Certbot, services or databases. They include
typed TLS/transport classification, real strict TLS context construction,
remaining-deadline checks, real stuck-child kill/reap, exclusive file modes,
filesystem identity replacement, all four actual production03 source imports
with bytecode/second-loader reads prohibited, complete-closed proof rejection,
and the actual original ingress TLS rollback function. The historical provision
fixture is `production-instance/fixtures/bootstrap-tail-20261010-03/provision.py`,
with its original SHA; later provisioning changes do not change this binding.

References: [Python SSL verification errors](https://docs.python.org/3.10/library/ssl.html#ssl.SSLCertVerificationError),
[Python subprocess timeouts](https://docs.python.org/3.10/library/subprocess.html#subprocess.run),
and [OpenSSL certificate validation errors](https://docs.openssl.org/3.0/man3/X509_STORE_CTX_get_error/).
