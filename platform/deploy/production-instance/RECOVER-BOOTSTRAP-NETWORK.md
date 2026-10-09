# Exact 02 bootstrap network recovery

This controller is solely for the recorded `20261010-02` bootstrap failure. It
does not resume general provisioning or the earlier Created-container recovery.
The initialized database, existing App role, original container, data volume,
private credentials and master key remain in place. Production admission stays
closed, with no players, balance credits, partner integration or public switch.

The actual diagnosis records a healthy PostgreSQL listener and internal TCP
connection, but Docker's actual `NetworkSettings.Ports` was `5432/tcp: null` on
the old internal bridge. The desired HostConfig binding alone did not prove a
host listener. A separate owned, disposable Docker fixture proved that running
disconnect/reconnect to an ordinary bridge publishes the requested loopback
port without restarting or replacing the container.

## Required historical and current identities

- Retired source: `/opt/oasis/releases/20261010-02`, manifest
  `6621d3955184a6bef0e0391f7976af9c81385362967435c2e4f9022b1d4fe339`.
- Fixed retirement receipt:
  `/opt/oasis/private/production-stage-20261010-v3/retired-source/retired-source.json`,
  SHA `7e74772fdeea0b712bd252a96555287b7871eba615c9bfd7c51120378300fc90`.
  Its exact actual schema binds the 1,161-member source archive, six preserved
  helper/controller files, raw manifest, original marker, both original failure
  receipts, original production symlink metadata and all four private pins.
  All 11 saved file fingerprints are rechecked; saved source is never executed.
- Recovery failure: `COMMAND_FAILED_NODE`, `database_resources_created`, no
  bootstrap, unit, backup or restore success; failed receipt SHA
  `5f61173d76a4c44e840de855f9ff376f1f2c086bc8586a430348d15c06953f95`.
- Exact existing container:
  `2ee98b7bb89bb14a0772f5bed1b6783024241664c367531ee6b52fc22fd86af6`;
  owner `f35571b2005dbe05ee68a41e72d11b75`, UID 997 / GID 999.
- Original volume device/inode `64515/378617`, PostgreSQL owner 70/70, mode
  `0700`; monitor device/inode `64515/1030226`, root/GID 999, mode `0750`.
- Database OID `16384`, existing nonprivileged, login-enabled App role and
  App-owned public schema, zero public relations.
- Original production symlink has been safely retired. It must now be absent,
  including no dangling foreign symlink. Its old inode exists only in evidence.
- New immutable source must be `/opt/oasis/releases/20261010-03`; the manifest
  binds this executing controller, the unchanged previous controller, all five
  latest official production helpers and all imported backend/schema sources.
  The reviewed 20 public pins and current/previous public releases must match.

## CLI and locking

Run `check` as root using the manifest SHA and reviewed inventory; save its raw
JSON to a new root-owned, single-link `0600` file. Obtain the raw file SHA from an
independent reader. Example argument shape:

```text
/usr/bin/python3 -I -B /opt/oasis/releases/20261010-03/platform/deploy/production-instance/recover-bootstrap-network.py check
  --release /opt/oasis/releases/20261010-03
  --manifest-sha256 <independently verified 03 manifest SHA>
  --protected-inventory <reviewed root-private inventory path>
  --retired-source /opt/oasis/private/production-stage-20261010-v3/retired-source/retired-source.json
  --retired-source-sha256 7e74772fdeea0b712bd252a96555287b7871eba615c9bfd7c51120378300fc90
  --origin https://oasis-player.43.98.202.236.sslip.io
  --pg-image sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb
  --capacity-budget-bytes <reviewed bytes, at least 1073741824>
```

`apply` uses the same arguments plus `--check <root-private raw check file>`,
`--check-sha256 <independent raw SHA>` and
`--recover-exact-bootstrap-network-closed`. The check expires after 600 seconds.
Both the shared release lock and the fixed operations lock are held across the
entire recovery. Their opened FDs and current path device/inode/owner/mode are
compared before and after flock; all current checks are repeated while locked.

## Single authorized flow

1. Preserve the raw check, retirement receipt, original marker, both failure
   receipts and old symlink metadata in a new exclusive `0700` directory:
   `/opt/oasis/production-instance-private/recovery-bootstrap-network-20261010`.
   The original receipts and marker evidence are never overwritten.
2. Start only the original stopped container. Use its internal
   `pg_isready -h 127.0.0.1`; run a read-only snapshot through `docker exec psql`
   to prove the fixed database OID, App flags/schema owner and zero relations.
3. While that same container runs, disconnect the old exact network ID without
   `--force`. Prove it has no consumers, remove that exact ID, then create the
   same dedicated name as `bridge`, `Internal=false`, with only
   `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` and the original owner
   label. Record and validate the returned immutable new network ID before
   connecting the still-running original container.
4. Change only marker `release`, `manifest_sha256`, `network_id`. Exclusively
   create the absent production symlink to 03; bind its new metadata. Retain all
   old private pins, container/volume identity, UID/GID and origins.
5. Return to the strict official normal guard. Require actual Docker loopback
   port publication and host TCP connectivity. Run a read-only Node App query
   against the original private URL and verify the expected container IP/port,
   database OID, App role, flags/schema owner and zero relations. Private
   passwords are passed only in process environment, never argv or receipts.
6. Run the official empty-database bootstrap once. Do not create or alter the
   already-existing role. Require closed admission, zero players/credits and no
   development credentials. Run a real official backup and restore drill; both
   drill database and temporary key directory cleanup must pass before units.
7. Install official bound units, verify effective loaded commands before enable,
   verify closed health and monitoring, then write `complete_closed` in the new
   recovery receipt. Public ingress/admission activation remains a later gate.

## Failure behavior and verification

Every step appends history and the fixed network IDs to the independent recovery
receipt. On failure, preserve the primary error. Stop only after proving original
CID/name/image/owner, sole volume consumer, volume inode and all private pins.
Allowed network attachments depend on the authored phase: old only, old/empty
after authorized disconnect, empty only, empty/new after authorized connect,
or new only. An unknown attachment/consumer prevents stop and records a separate
cleanup error. Installed services require the official loaded-command guard
before stop. No failure deletes a volume, database, key, source history, old
receipt or network with unknown ownership. The recovery directory makes a
second invocation refuse; diagnosis and a separately reviewed next-phase tool
are required after a partial execution.

Local contracts use synthetic identities and temporary files only:

```sh
python3 -B -m unittest discover -s platform/deploy/production-instance -p test_recover_bootstrap_network.py -v
```

These tests include actual saved retirement/failure metadata when available;
they do not claim PostgreSQL, Docker, public or device acceptance. Remote fresh
check, apply and independent readback must be preserved separately.
