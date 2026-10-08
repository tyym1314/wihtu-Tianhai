# Isolated Linux profile activation proof

Status on 2026-10-08: **prepared, not run on Linux**. Do not treat the Python
syntax check or a platform refusal as acceptance. The local Mac has Docker
29.3.1 and a `desktop-linux` context, but its daemon requests and Unix socket
health check time out. A single normal `docker desktop start --timeout 30`
returned `Docker Desktop is already running`; subsequent probes still timed
out. No daemon restart/reset, container creation, image download or production
operation was performed. Raw probes are in the ignored directory
`platform/review/mock-linux-profile-20261008/`.

A fresh check at **2026-10-08 01:09–01:10 UTC** still could not reach the
engine: the Unix-socket `/_ping` returned no bytes before its 5-second deadline,
and `docker info` / `docker desktop status` timed out. One normal start returned
`Docker Desktop is already running` in 0.14 seconds; the subsequent engine and
socket checks still failed. The CLI response is not evidence that the Linux VM
is usable. The backend was not restarted, reset or terminated. No other installed
local Linux runtime was found in PATH, Applications or the standard Colima,
Lima, Podman, OrbStack, Multipass, Tart, UTM and VM storage locations checked.
Docker's bundled `qemu-img` and virtualization helper were not used to bypass
the unavailable backend or open its existing shared disk. Fresh raw probes,
runtime inventory and the precise remaining gate are preserved separately in
`platform/review/mock-linux-profile-20261008-v2/`; the first evidence remains
unchanged. No image build, container, Linux fixture or Nginx operation occurred.

`linux_profile_fixture.py` and `linux_profile_fixture.Dockerfile` provide a
separate opt-in native test. They do not modify `profile_activation.py`. The
fixture refuses macOS, non-root execution, execution outside the dedicated
image, a process other than container PID 1, a mounted Docker socket, any
network interface besides loopback, or a reused output directory. It must not
be run directly on a Linux workstation or server. It is not part of ordinary
unittest discovery and cannot silently turn a missing capability into a skip.

## Execution boundary

Use only a new local disposable container. Do not pass host directories, host
network/PID namespaces, the Docker socket, devices, or production files. The
build context below contains only the controller capsule and test inputs.
There is no service/database/release activation or 04→05 switch. Installation
of Debian packages happens only inside the image and suppresses package service
startup. The image tag is not an immutable package pin: capture the resulting
image ID and package/binary identities with the evidence before drawing any
conclusion about a particular kernel/Nginx combination.

Example commands, **not executed on the current blocked host**:

```sh
docker build --label oasis.fixture=private-linux-profile-v1 \
  -f platform/deploy/mock-sandbox/linux_profile_fixture.Dockerfile \
  -t oasis-profile-linux-fixture:20261008 platform/deploy/mock-sandbox

docker image inspect oasis-profile-linux-fixture:20261008

# Choose a fresh name and retain it until all evidence has been copied.
docker create --name oasis-profile-linux-fixture-20261008 \
  --label oasis.fixture=private-linux-profile-v1 \
  --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
  --memory 256m --cpus 1 --pids-limit 128 \
  oasis-profile-linux-fixture:20261008
docker start --attach oasis-profile-linux-fixture-20261008

# Preserve a failing exit/result as well as a passing one. No automatic retry.
docker inspect oasis-profile-linux-fixture-20261008
docker logs oasis-profile-linux-fixture-20261008
docker cp oasis-profile-linux-fixture-20261008:/evidence ./FRESH-OWNED-EVIDENCE
docker cp oasis-profile-linux-fixture-20261008:/opt/oasis/android-mock-route-profiles/.activation-04-to-05-v1 ./FRESH-OWNED-NAMESPACE-JOBS
```

These capabilities allow native mount namespaces and `mount_setattr` inside
the disposable Docker VM/container. If the Docker security policy or kernel
still rejects the syscalls, retain the native refusal; do not silently add
`--privileged`, change Desktop security, or reuse a production namespace.
`--cap-add SYS_ADMIN` is confined to this container, without host mounts or
host networking. The image copies the reviewed capsule rather than mounting
the Mac working tree into a privileged process.

After collecting stdout/stderr, inspect results and metadata, stop/remove only
that exact owned container. Remove the exact created image only after confirming
that no other container uses it. Do not use `docker prune`, delete unrelated
containers/images, reset Docker, or discard failed evidence. The fixture tries
to quit its own Nginx master and unmount its own nested tmpfs, and records process
and port closure. Container removal supplies final namespace cleanup; any
cleanup failure must remain visible in the report.

## Native checks and limits

The fixture invokes the unchanged `ActivationRuntime.syntax` and namespace
child, including its dependency SHA checks, private propagation, recursive
`mount_setattr`, all-mount readonly check, compiled path discovery, write-path
shadows, exact vhost bind and real full-config `nginx -t`. A thin runtime logger
executes each real subprocess once and preserves its stdout/stderr; it does not
replace syscall/service results. Test inputs are synthetic enclosed Nginx
configuration at the fixed path inside the container, not the historical
production overlay.

The fixture covers:

1. A successful real full-enclosure syntax check with all five temp paths,
   log/pid/lock paths, both cache paths, unrelated vhost/include files, unusual
   original temp-directory ownership, protected sentinel files and a separate
   nested mount. Original bytes, inode, owner, group and mode must remain equal.
2. A native candidate syntax failure, preserving all original identities.
3. A native syntax failure in a different included vhost. This checks that a
   target-only parser cannot masquerade as full-enclosure verification.
4. A real owned Nginx master startup and direct `SIGHUP`; loopback responses
   must switch from `before` to `after`, the unrelated vhost must still respond,
   and protected file/owner/mode identities must remain equal.
5. A deliberately drifted compiled temp directory followed by another valid
   HUP. If Nginx `create_paths` changes its owner/mode, the fixture records a
   **failure**, not an expected green mutation. This distinguishes successful
   namespace syntax isolation from a stronger claim that a host master reload
   cannot mutate shared paths. Such a finding requires an explicit production
   design review; never weaken the assertion to obtain a pass.

No evidence exists yet for any of these Linux checks on this host. Even if they
later pass, they do not prove the production enclosing configuration, systemd
unit/master dispatch checks, post-reload TLS routing, 88-file historical overlay,
startup/recovery transactions, database/ledger behavior, 13-game Mock quality,
APK acceptance or suitability of the obsolete historical 05 for current public
09 code. Those remain separate gates described in `PROFILE-ACTIVATION.md`.
