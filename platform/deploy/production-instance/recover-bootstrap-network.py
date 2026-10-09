#!/usr/bin/python3
"""Repair only the witnessed 02 bootstrap TCP failure, preserving its database."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

HERE = Path(__file__).resolve().parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

p = load('oasis_network_provision', 'provision.py')
r = load('oasis_previous_created', 'recover-created.py')
r.p = p  # Reuse its private-FD reader; never call the previous recovery flow.
OLD_RELEASE = '/opt/oasis/releases/20261010-02'
NEW_RELEASE = '/opt/oasis/releases/20261010-03'
OLD_MANIFEST = '6621d3955184a6bef0e0391f7976af9c81385362967435c2e4f9022b1d4fe339'
OLD_MARKER = 'cf658ba98f2e86a947f26d6c9b99ee9955c5303b9701e76fd62d188a26f0e493'
FAILED2 = '5f61173d76a4c44e840de855f9ff376f1f2c086bc8586a430348d15c06953f95'
PREVIOUS_TOOL = '7b4a37d681122d7d4fc50e812b16d4d44a69aedaf3ec056a7bba15d1a0335239'
PUBLIC_MANIFEST = '1f95900328ab75a13054ade0d5f50d76b43e083c0bb8a70ac469153d34d14888'
OLD_HELPERS = {**r.OLD_HELPERS,
    'provision.py': '7ecf8cf8a245fa8344c8c98d82ae604cd37579a1d6b96d253b7d98a366bb1ed2',
    'operations.py': 'bb9658e58dea62959bb493bc7444ed6ecfc01babed1cac5ddfcc3d0f4c226c0c',
    'recover-created.py': PREVIOUS_TOOL}
RECOVERY = p.PRIVATE / 'recovery-bootstrap-network-20261010'
HISTORY = Path('/opt/oasis/private/production-stage-20261010-v3/retired-source/retired-source.json')
HISTORY_SHA = '7e74772fdeea0b712bd252a96555287b7871eba615c9bfd7c51120378300fc90'
ARCHIVE_SHA = '43dd412f314232c0c43188a6895624cb920fe31a0530c30f1d4cb799a7d2c341'
FAILED2_PATH = p.PRIVATE / 'recovery-created-20261010/receipt.json'
VOLUME_META = {**r.VOLUME_META, 'mode': 0o700}
PIN_META = {'uid': 0, 'gid': 0, 'mode': 0o777, 'device': 64515, 'inode': 1025153,
            'kind': 'symlink', 'target': OLD_RELEASE}
OPS_PIN = {'uid': 0, 'gid': 0, 'mode': 0o600, 'device': 64515, 'inode': 929009,
           'kind': 'file', 'bytes': 0, 'sha256': p.digest(b'')}
MONITOR_META = {'uid': 0, 'gid': 999, 'mode': 0o750, 'device': 64515, 'inode': 1030226,
                'kind': 'directory'}
PRIVATE_MEMBERS = {'installation.json', 'monitor', 'operations.lock', 'operator-credentials.json',
                   'postgres.env', 'receipt.json', 'recovery-created-20261010', 'runtime.env', 'state'}


def pin_metadata(path):
    s = path.lstat()
    p.require(stat.S_ISLNK(s.st_mode), 'NETWORK_RECOVERY_PIN_NOT_SYMLINK')
    return {'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode),
            'device': s.st_dev, 'inode': s.st_ino, 'kind': 'symlink', 'target': os.readlink(path)}


def current_pin_metadata():
    return pin_metadata(p.PIN) if os.path.lexists(p.PIN) else None


def origin_guard(marker, failure):
    p.require(marker.get('kind') == 'isolated-production-instance' and marker.get('schema') == 1
              and marker.get('release') == OLD_RELEASE and marker.get('manifest_sha256') == OLD_MANIFEST
              and marker.get('container_id') == r.CID and marker.get('owner') == r.OWNER
              and type(marker.get('uid')) is int and marker['uid'] == 997
              and type(marker.get('gid')) is int and marker['gid'] == 999
              and marker.get('network_id') == r.NETWORK_ID and marker.get('pg_image') == r.IMAGE
              and marker.get('origins') == ['https://oasis-player.43.98.202.236.sslip.io', 'https://game.tianyahuyu.com'],
              'NETWORK_RECOVERY_ORIGINAL_MARKER_INVALID')
    p.require(failure.get('kind') == 'isolated-production-created-recovery' and failure.get('schema') == 1
              and failure.get('phase') == 'failed_closed' and failure.get('passed') is False
              and failure.get('failed_at_phase') == 'database_resources_created'
              and failure.get('error_code') == 'COMMAND_FAILED_NODE' and not failure.get('cleanup_error_code')
              and failure.get('container_id') == r.CID and failure.get('recovery_tool_sha256') == PREVIOUS_TOOL
              and failure.get('original_failed_receipt_sha256') == r.OLD_RECEIPT
              and failure.get('source') == {k: v for k, v in OLD_HELPERS.items() if k != 'recover-created.py'}
              and not any(k in failure for k in ('bootstrap', 'unit_pins', 'units_installed', 'backup', 'restore')),
              'NETWORK_RECOVERY_ORIGINAL_FAILURE_INVALID')


def history_guard(path, sha):
    p.require(Path(path) == HISTORY and sha == HISTORY_SHA, 'NETWORK_RECOVERY_HISTORY_INPUT_INVALID')
    body, receipt_pin = r.read_bound(path, sha)
    value = json.loads(body)
    p.require(value.get('kind') == 'retired-unactivated-bootstrap-failed-candidate'
              and value.get('schema') == 1 and value.get('passed') is True and value.get('retired') is True
              and value.get('activated') is False and value.get('release') == OLD_RELEASE
              and value.get('manifest_sha256') == OLD_MANIFEST and value.get('members') == 1161
              and value.get('marker_sha256') == OLD_MARKER and value.get('failed_receipt_sha256') == r.OLD_RECEIPT
              and value.get('recovery_failed_receipt_sha256') == FAILED2
              and value.get('original_recovery_sha256') == PREVIOUS_TOOL and value.get('database_oid') == '16384'
              and value.get('created_container_id') == r.CID
              and value.get('original_helpers') == {k: v for k, v in OLD_HELPERS.items() if k != 'recover-created.py'}
              and value.get('production_pin') == PIN_META and value.get('volume_metadata') == VOLUME_META
              and value.get('production_pin_removed') is True
              and set(value.get('original_private_pins', {})) == {'runtime.env', 'postgres.env', 'operator-credentials.json', 'state/master.key'}
              and value.get('public_manifest_sha256') == PUBLIC_MANIFEST
              and value.get('protected_inventory_sha256') == r.PROTECTED_SHA
              and value.get('protected_before_sha256') == value.get('protected_after_sha256') == r.PUBLIC_SNAPSHOT_SHA
              and value.get('runtime_dependencies') == r.DEPENDENCIES
              and value.get('dependencies_match') == '/opt/oasis/releases/20261009-03'
              and value.get('archive_sha256') == ARCHIVE_SHA and value.get('archive_bytes') == 195388678,
              'NETWORK_RECOVERY_RETIRED_SOURCE_INVALID')
    proof = value.get('source_archive_provenance', {})
    p.require(proof.get('bytes') == 195388678 and proof.get('passed') is True
              and proof.get('verified_source_members') == 1161 and proof.get('contains_node_modules') is False
              and proof.get('manifest_sha256') == OLD_MANIFEST and proof.get('archive_sha256') == ARCHIVE_SHA,
              'NETWORK_RECOVERY_ARCHIVE_PROOF_INVALID')
    root = Path(path).parent
    directories = {name: p.fingerprint(root / name) for name in ('.', 'helpers')}
    p.require(all(s['kind'] == 'directory' and s['uid'] == s['gid'] == 0 and s['mode'] == 0o700
                  for s in directories.values()), 'NETWORK_RECOVERY_HISTORY_DIRECTORY_UNSAFE')
    p.no_mount(root)
    preserved = {}
    expected = {'RELEASE-MANIFEST.json': OLD_MANIFEST, 'marker-original.json': OLD_MARKER,
                'receipt-original.json': r.OLD_RECEIPT, 'recovery-created-receipt-original.json': FAILED2,
                **{'helpers/' + name: old for name, old in OLD_HELPERS.items()}}
    manifest = None
    for name, old in expected.items():
        raw, preserved[name] = r.read_bound(root / name, old)
        if name == 'RELEASE-MANIFEST.json':
            manifest = json.loads(raw)
    pin_raw, preserved['production-pin.json'] = r.read_bound(root / 'production-pin.json')
    p.require(json.loads(pin_raw) == PIN_META, 'NETWORK_RECOVERY_HISTORICAL_PIN_INVALID')
    p.require(value.get('preservation') == preserved, 'NETWORK_RECOVERY_PRESERVATION_CHANGED')
    p.require(isinstance(manifest, dict) and len(manifest) == 1161
              and all(isinstance(name, str) and not Path(name).is_absolute() and '..' not in Path(name).parts
                      and isinstance(old, str) and re.fullmatch('[a-f0-9]{64}', old)
                      for name, old in manifest.items())
              and all(manifest.get('platform/deploy/production-instance/' + name) == old
                      for name, old in OLD_HELPERS.items()), 'NETWORK_RECOVERY_OLD_MANIFEST_INVALID')
    return {'receipt': value, 'receipt_pin': receipt_pin, 'directories': directories, 'files': preserved}


def validate_database_evidence(value, expected_addr=None):
    p.require(value.get('database') == p.DATABASE and value.get('database_oid') == '16384'
              and value.get('role') == p.DB_APP and value.get('privileged') is False and value.get('login') is True
              and value.get('schema_owner') == p.DB_APP and type(value.get('relations')) is int
              and value['relations'] == 0, 'NETWORK_RECOVERY_DATABASE_NOT_EXACT_EMPTY')
    if expected_addr is not None:
        p.require(value.get('server_addr') == expected_addr and value.get('server_port') == 5432,
                  'NETWORK_RECOVERY_APP_CONNECTION_NOT_OWN_CONTAINER')
    return value


INITIAL_SELECT = """SELECT current_database() AS database,
(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
current_user AS role,(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged,
(SELECT rolcanlogin FROM pg_roles WHERE rolname=current_user) AS login,
(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') AS schema_owner,
(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AS relations,
inet_server_addr()::text AS server_addr,inet_server_port() AS server_port"""


class Recovery(p.Provisioner):
    def historical_guard(self):
        p.require(history_guard(self.args.retired_source, self.args.retired_source_sha256) == self.capsule['history'],
                  'NETWORK_RECOVERY_HISTORY_CHANGED')
        for path, pin in self.capsule['incident']['immutable_files'].items():
            p.require(p.fingerprint(Path(path)) == pin, 'NETWORK_RECOVERY_OLD_FAILURE_CHANGED')
        if self.receipt:
            p.require(p.fingerprint(RECOVERY) == self.directory_pin, 'NETWORK_RECOVERY_DIRECTORY_CHANGED')
            for name, pin in self.saved_pins.items():
                p.require(p.fingerprint(RECOVERY / name) == pin, 'NETWORK_RECOVERY_SAVED_EVIDENCE_CHANGED')
            if hasattr(self, 'marker_pin'):
                p.require(p.fingerprint(p.PRIVATE / 'installation.json') == self.marker_pin,
                          'NETWORK_RECOVERY_ADVANCED_MARKER_CHANGED')
            p.require(current_pin_metadata() == self.current_pin, 'NETWORK_RECOVERY_PRODUCTION_PIN_CHANGED')
        if hasattr(self, 'ops_fd'):
            p.lock_descriptor_guard(self.ops_fd, p.PRIVATE / 'operations.lock', OPS_PIN)

    def guard_current(self):
        self.historical_guard()
        self.guard(self.capsule['protected'])
        p.verify_release(self.release, self.args.manifest_sha256)

    def core_scope(self, allowed):
        """Incident-only stop/network scope. Does not authorize general legacy use."""
        p.account_guard(self.marker)
        c = self.runtime.inspect('container', r.CID)
        v = self.runtime.inspect('volume', p.VOLUME)
        p.require(c.get('Id') == r.CID and c.get('Name') == '/' + p.CONTAINER
                  and c.get('Image') == r.IMAGE and c.get('Config', {}).get('Labels', {}).get(p.LABEL) == r.OWNER
                  and v.get('Labels', {}).get(p.LABEL) == r.OWNER
                  and {key: v.get(key) for key in ('Name', 'CreatedAt', 'Driver', 'Options', 'Mountpoint')}
                      == self.marker['volume_identity'], 'NETWORK_RECOVERY_CORE_RESOURCE_CHANGED')
        mounts = c.get('Mounts', [])
        p.require(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('Name') == p.VOLUME
                  and mounts[0].get('Source') == str(r.VOLUME_PATH) and mounts[0].get('Destination') == '/var/lib/postgresql/data'
                  and mounts[0].get('RW') is True and c.get('HostConfig', {}).get('PortBindings') == p.PG_PORT_BINDINGS
                  and c['HostConfig'].get('NetworkMode') == p.NETWORK, 'NETWORK_RECOVERY_CORE_SCOPE_CHANGED')
        p.require(p.fingerprint(r.VOLUME_PATH) == VOLUME_META, 'NETWORK_RECOVERY_VOLUME_INODE_CHANGED')
        p.no_mount(r.VOLUME_PATH)
        p.no_mount(p.PRIVATE)
        p.no_mount(p.BACKUPS)
        private = p.fingerprint(p.PRIVATE)
        p.require(private['kind'] == 'directory' and private['uid'] == 0 and private['gid'] == 999
                  and private['mode'] == 0o750, 'NETWORK_RECOVERY_PRIVATE_DIRECTORY_CHANGED')
        state = p.fingerprint(p.PRIVATE / 'state')
        p.require(state['kind'] == 'directory' and state['uid'] == 997 and state['gid'] == 999
                  and state['mode'] == 0o700, 'NETWORK_RECOVERY_STATE_DIRECTORY_CHANGED')
        p.require(set(self.marker['private_pins']) == {'runtime.env', 'postgres.env', 'operator-credentials.json', 'state/master.key'}
                  and all(p.fingerprint(p.PRIVATE / name) == pin for name, pin in self.marker['private_pins'].items()),
                  'NETWORK_RECOVERY_PRIVATE_CONFIG_CHANGED')
        networks = c.get('NetworkSettings', {}).get('Networks')
        identity = 'empty' if networks == {} else None
        if isinstance(networks, dict) and set(networks) == {p.NETWORK}:
            nid = networks[p.NETWORK].get('NetworkID')
            if nid == r.NETWORK_ID:
                identity = 'old'
            elif nid == getattr(self, 'new_network_id', None):
                identity = 'new'
        p.require(identity in allowed, 'NETWORK_RECOVERY_UNAUTHORED_NETWORK_CHANGED')
        if identity != 'empty':
            self.network_guard(identity)
        for item in self.runtime.command(['docker', 'container', 'ls', '-aq']).splitlines():
            other = self.runtime.inspect('container', item)
            if other['Id'] != r.CID:
                p.require(not any(m.get('Name') == p.VOLUME for m in other.get('Mounts', []))
                          and p.NETWORK not in other.get('NetworkSettings', {}).get('Networks', {}),
                          'NETWORK_RECOVERY_FOREIGN_CONSUMER')
        return c

    def network_guard(self, identity):
        nid = r.NETWORK_ID if identity == 'old' else self.new_network_id
        n = self.runtime.inspect('network', nid)
        p.require(n.get('Id') == nid and n.get('Name') == p.NETWORK and n.get('Driver') == 'bridge'
                  and n.get('Internal') is (identity == 'old')
                  and n.get('Options') == ({} if identity == 'old' else p.NETWORK_OPTIONS)
                  and n.get('Labels', {}).get(p.LABEL) == r.OWNER
                  and set(n.get('Containers', {})) <= {r.CID}, 'NETWORK_RECOVERY_NETWORK_IDENTITY_CHANGED')
        return n

    def incident_snapshot(self):
        marker_raw, marker_pin = r.read_bound(p.PRIVATE / 'installation.json', OLD_MARKER)
        failure_raw, failure_pin = r.read_bound(FAILED2_PATH, FAILED2)
        self.marker = json.loads(marker_raw)
        origin_guard(self.marker, json.loads(failure_raw))
        _, original_pin = r.read_bound(p.PRIVATE / 'receipt.json', r.OLD_RECEIPT)
        c = self.core_scope({'old'})
        s = c['State']
        p.require(s.get('Status') == 'exited' and all(s.get(k) is False for k in ('Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead'))
                  and type(s.get('Pid')) is int and s['Pid'] == 0 and type(s.get('ExitCode')) is int and s['ExitCode'] == 0
                  and s.get('Error') == '' and s.get('StartedAt') != '0001-01-01T00:00:00Z',
                  'NETWORK_RECOVERY_ORIGINAL_PG_NOT_STOPPED')
        p.require(not os.path.lexists(p.PIN) and not os.path.lexists(RECOVERY)
                  and not os.path.lexists(p.PRIVATE / 'bootstrap.json') and not list(p.BACKUPS.iterdir())
                  and {x.name for x in p.PRIVATE.iterdir()} == PRIVATE_MEMBERS
                  and {x.name for x in (p.PRIVATE / 'state').iterdir()} == {'master.key'}
                  and not list((p.PRIVATE / 'monitor').iterdir())
                  and p.fingerprint(p.PRIVATE / 'monitor') == MONITOR_META
                  and p.fingerprint(p.PRIVATE / 'operations.lock') == OPS_PIN,
                  'NETWORK_RECOVERY_INCIDENT_PHASE_CHANGED')
        p.unit_namespace_guard()
        states = {name: self.runtime.service(name) for name in p.UNITS}
        p.require(all(not x.get('FragmentPath') and not x.get('DropInPaths') and not int(x.get('MainPID') or 0)
                      and x.get('ActiveState') == 'inactive' and x.get('NeedDaemonReload') == 'no' for x in states.values()),
                  'NETWORK_RECOVERY_OWNED_UNIT_ALREADY_EXISTS')
        ports = self.runtime.command(['ss', '-H', '-ltn'])
        p.require(not any(re.search(r':(?:18891|18893)\s', line) for line in ports.splitlines()),
                  'NETWORK_RECOVERY_OWN_PORT_IN_USE')
        p.require('997' not in self.runtime.command(['ps', '-eo', 'uid=']).split(), 'NETWORK_RECOVERY_OWN_UID_ACTIVE')
        return {'marker': self.marker, 'marker_pin': marker_pin, 'failure2': json.loads(failure_raw),
                'production_pin': None, 'volume_metadata': VOLUME_META,
                'immutable_files': {str(p.PRIVATE / 'receipt.json'): original_pin, str(FAILED2_PATH): failure_pin},
                'state': s, 'network': self.network_guard('old'), 'unit_states': states}

    def check(self):
        p.require(str(self.release) == NEW_RELEASE and self.args.pg_image == r.IMAGE
                  and self.args.origin == 'https://oasis-player.43.98.202.236.sslip.io'
                  and p.digest(Path(self.args.protected_inventory).read_bytes()) == r.PROTECTED_SHA,
                  'NETWORK_RECOVERY_EXACT_INPUTS_REQUIRED')
        release = p.verify_release(self.release, self.args.manifest_sha256)
        manifest = json.loads((self.release / 'RELEASE-MANIFEST.json').read_text())
        own_sha = p.digest(Path(__file__).read_bytes())
        p.require(manifest.get('platform/deploy/production-instance/recover-bootstrap-network.py') == own_sha
                  and manifest.get('platform/deploy/production-instance/recover-created.py') == PREVIOUS_TOOL
                  and p.digest(Path(r.__file__).read_bytes()) == PREVIOUS_TOOL,
                  'NETWORK_RECOVERY_CONTROLLERS_NOT_BOUND')
        history = history_guard(self.args.retired_source, self.args.retired_source_sha256)
        protected = self.guard()
        incident = self.incident_snapshot()
        p.require(incident['marker']['private_pins'] == history['receipt']['original_private_pins'],
                  'NETWORK_RECOVERY_HISTORY_PRIVATE_PINS_CHANGED')
        p.require(incident == self.incident_snapshot() and protected == self.guard(protected),
                  'NETWORK_RECOVERY_INCIDENT_CHANGED')
        disk = os.statvfs(p.BASE)
        p.require(self.args.capacity_budget_bytes >= 1 << 30 and disk.f_bavail * disk.f_frsize - self.args.capacity_budget_bytes
                  >= max(3 << 30, disk.f_blocks * disk.f_frsize * 0.15), 'PRODUCTION_CAPACITY_RESERVE_FAILED')
        return {'schema': 1, 'kind': 'isolated-production-bootstrap-network-check', 'passed': True, 'at': p.now(),
                'tool_sha256': own_sha, 'release': str(self.release), **release, 'incident': incident, 'history': history,
                'retired_source_sha256': self.args.retired_source_sha256, 'protected': protected,
                'protected_inventory_sha256': r.PROTECTED_SHA, 'admission_enabled': False,
                'capacity_budget_bytes': self.args.capacity_budget_bytes}

    def event(self, phase, **fields):
        self.receipt['phase'] = phase
        self.receipt['network_state'] = self.network_state
        self.receipt['history'].append({'at': p.now(), 'phase': phase, **fields})
        path = RECOVERY / 'receipt.json'
        if os.path.lexists(path):
            p.require(p.fingerprint(path) == self.receipt_pin, 'NETWORK_RECOVERY_RECEIPT_CHANGED')
        tmp = RECOVERY / ('receipt-' + p.secrets.token_hex(8) + '.tmp')
        p.exclusive(tmp, p.canonical(self.receipt))
        os.replace(tmp, path)
        self.receipt_pin = p.fingerprint(path)

    def preserve(self, raw):
        RECOVERY.mkdir(mode=0o700)
        os.chmod(RECOVERY, 0o700)
        self.directory_pin = p.fingerprint(RECOVERY)
        self.saved_pins = {}
        for name, source, sha in (
            ('marker-original.json', p.PRIVATE / 'installation.json', OLD_MARKER),
            ('receipt-original.json', p.PRIVATE / 'receipt.json', r.OLD_RECEIPT),
            ('recovery-created-receipt-original.json', FAILED2_PATH, FAILED2),
            ('retired-source.json', Path(self.args.retired_source), self.args.retired_source_sha256)):
            body, _ = r.read_bound(source, sha)
            p.exclusive(RECOVERY / name, body)
            self.saved_pins[name] = p.fingerprint(RECOVERY / name)
        for name, body in (('check.json', raw), ('production-pin.json', p.canonical(PIN_META))):
            p.exclusive(RECOVERY / name, body)
            self.saved_pins[name] = p.fingerprint(RECOVERY / name)
        self.network_state = 'old'
        self.current_pin = None
        self.marker_pin = self.capsule['incident']['marker_pin']
        self.receipt = {'schema': 1, 'kind': 'isolated-production-bootstrap-network-recovery', 'at': p.now(),
                        'passed': False, 'history': [], 'container_id': r.CID, 'check_sha256': self.args.check_sha256,
                        'source': self.capsule['helpers'], 'tool_sha256': self.capsule['tool_sha256'],
                        'original_failed_receipt_sha256': r.OLD_RECEIPT, 'recovery_failed_receipt_sha256': FAILED2,
                        'old_network_id': r.NETWORK_ID, 'old_manifest_sha256': OLD_MANIFEST}
        self.event('original_evidence_preserved')

    def fresh(self, **kwargs):
        p.require(not kwargs, 'NETWORK_RECOVERY_CREATED_EXCEPTION_FORBIDDEN')
        self.guard_current()
        super().fresh()

    def legacy_database_probe(self):
        body = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='15s'; "
        body += "SELECT json_build_object('database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role','oasis_prod_app','privileged',(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='oasis_prod_app'),'login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='oasis_prod_app'),'schema_owner',(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'),'relations',(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')); COMMIT;"
        raw = self.runtime.command(['docker', 'exec', '-i', r.CID, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                                    '-U', p.DB_OWNER, '-d', p.DATABASE], input=body)
        rows = [json.loads(line) for line in raw.splitlines() if line.startswith('{')]
        p.require(len(rows) == 1, 'NETWORK_RECOVERY_LEGACY_READONLY_RESPONSE_INVALID')
        return validate_database_evidence(rows[0])

    def replace_network(self):
        self.guard_current()
        c = self.core_scope({'old'})
        p.require(c['State']['Running'] is False and c['State']['Status'] == 'exited', 'NETWORK_RECOVERY_PRESTART_CHANGED')
        self.runtime.command(['docker', 'start', r.CID])
        for _ in range(30):
            try:
                self.runtime.command(['docker', 'exec', r.CID, 'pg_isready', '-h', '127.0.0.1', '-U', p.DB_OWNER, '-d', p.DATABASE])
                break
            except p.Refusal:
                time.sleep(1)
        else:
            raise p.Refusal('PRODUCTION_DATABASE_NOT_READY')
        self.guard_current()
        p.require(self.core_scope({'old'})['State']['Running'] is True, 'NETWORK_RECOVERY_LEGACY_NOT_RUNNING')
        evidence = self.legacy_database_probe()
        self.event('legacy_database_readonly_proved', evidence=evidence)
        self.guard_current()
        self.core_scope({'old'})
        self.network_state = 'disconnecting'
        self.event('old_network_disconnect_authorized')
        self.runtime.command(['docker', 'network', 'disconnect', r.NETWORK_ID, r.CID])
        self.network_state = 'empty'
        self.event('old_network_disconnected')
        self.guard_current()
        self.core_scope({'empty'})
        p.require(not self.network_guard('old').get('Containers'), 'NETWORK_RECOVERY_OLD_NETWORK_NOT_EMPTY')
        self.runtime.command(['docker', 'network', 'rm', r.NETWORK_ID])
        self.event('old_network_removed')
        self.guard_current()
        self.core_scope({'empty'})
        p.require(p.NETWORK not in self.runtime.names('network'), 'NETWORK_RECOVERY_NAME_REUSED')
        nid = self.runtime.command(['docker', 'network', 'create', '--driver', 'bridge', '--opt',
                                    'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', '--label',
                                    p.LABEL + '=' + r.OWNER, p.NETWORK]).strip()
        p.require(re.fullmatch('[a-f0-9]{64}', nid) and nid != r.NETWORK_ID, 'NETWORK_RECOVERY_NEW_NETWORK_ID_INVALID')
        self.new_network_id = nid
        self.receipt['new_network_id'] = nid
        self.event('new_network_created', new_network_id=nid)
        self.network_guard('new')
        self.guard_current()
        self.core_scope({'empty'})
        self.network_state = 'connecting'
        self.event('new_network_connect_authorized', new_network_id=nid)
        self.runtime.command(['docker', 'network', 'connect', nid, r.CID])
        self.network_state = 'new'
        self.event('new_network_connected', new_network_id=nid)
        self.core_scope({'new'})

    def advance_source(self):
        self.guard_current()
        self.core_scope({'new'})
        old = copy.deepcopy(self.capsule['incident']['marker'])
        old.update(release=str(self.release), manifest_sha256=self.args.manifest_sha256, network_id=self.new_network_id)
        path = p.PRIVATE / 'installation.json'
        p.require(p.fingerprint(path) == self.marker_pin and not os.path.lexists(p.PIN),
                  'NETWORK_RECOVERY_OLD_SOURCE_PIN_CHANGED')
        tmp = RECOVERY / 'marker-advanced.tmp'
        p.exclusive(tmp, p.canonical(old))
        p.require(p.fingerprint(path) == self.marker_pin, 'NETWORK_RECOVERY_OLD_MARKER_CHANGED')
        os.replace(tmp, path)
        self.marker = old
        self.marker_pin = p.fingerprint(path)
        # symlink creation refuses every pre-existing name, including a dangling
        # foreign symlink. The retired 02 link exists only in saved metadata.
        p.require(not os.path.lexists(p.PIN), 'NETWORK_RECOVERY_OLD_PIN_CHANGED')
        os.symlink(str(self.release), p.PIN)
        self.current_pin = pin_metadata(p.PIN)
        self.event('source_and_network_advanced', new_network_id=self.new_network_id, production_pin=self.current_pin)

    def app_database_probe(self, env):
        c = self.core_scope({'new'})
        addr = c['NetworkSettings']['Networks'][p.NETWORK]['IPAddress']
        code = 'const {pool,closePools}=await import(' + json.dumps((self.release / 'platform/server/db.mjs').as_uri()) + ');\n'
        code += 'let c;try{c=await pool.connect();await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await c.query("SET LOCAL statement_timeout=15000");'
        code += 'const value=(await c.query(' + json.dumps(INITIAL_SELECT) + ')).rows[0];await c.query("COMMIT");process.stdout.write(JSON.stringify(value)+"\\n");}'
        code += 'finally{c?.release();await closePools();}'
        raw = self.runtime.command(['/usr/bin/node', '--input-type=module', '-e', code], env=env, timeout=30)
        return validate_database_evidence(json.loads(raw), addr)

    def bootstrap_only(self):
        self.fresh()
        p.require_pg_host_tcp()
        raw, _ = r.read_bound(p.PRIVATE / 'runtime.env', self.marker['private_pins']['runtime.env']['sha256'])
        env = r.parse_private_env(raw)
        try:
            evidence = self.app_database_probe(env)
            self.event('app_empty_database_readonly_proved', evidence=evidence)
            self.fresh()
            env['OASIS_BOOTSTRAP_ALLOWED_ORIGINS'] = json.dumps(self.marker['origins'], separators=(',', ':'))
            self.runtime.command(['/usr/bin/node', '--import', str(self.release / 'platform/node_modules/tsx/dist/loader.mjs'),
                                  str(self.release / 'platform/deploy/production-instance/bootstrap.mjs'),
                                  str(p.PRIVATE / 'operator-credentials.json'), str(p.PRIVATE / 'bootstrap.json')], env=env, timeout=180)
        finally:
            env.clear()
        result = json.loads((p.PRIVATE / 'bootstrap.json').read_text())
        p.require(result.get('passed') is True and result.get('admission_enabled') is False
                  and result.get('players_created') == 0 and result.get('coins_funded') == '0', 'BOOTSTRAP_RECEIPT_INVALID')
        p.require(not any(os.path.lexists(p.PRIVATE / 'state' / name) for name in ('development-credentials.json', 'sandbox-app-credentials.json')),
                  'PRODUCTION_DEVELOPMENT_SEED_PRESENT')
        self.receipt['bootstrap'] = result
        self.event('production_bootstrap_proved')

    def finish_closed(self):
        self.fresh()
        ops = self.load_operations()
        # The existing operations FD lock remains held across the whole recovery.
        backup = ops.backup(self.marker, self.runtime)
        self.event('backup_created', backup=backup)
        drill = ops.restore(self.marker, Path(backup['path']), self.runtime)
        p.require(drill['passed'] and drill['cleanup']['database_removed'] and drill['cleanup']['temporary_removed'],
                  'PRODUCTION_RESTORE_DRILL_FAILED')
        self.event('restore_proved', drill=drill)
        self.fresh()
        self.install_units()
        self.fresh()
        self.runtime.command(['systemctl', 'enable', '--now', 'oasis-production-db.service', 'oasis-production-api.service',
                              'oasis-production-instance-backup.timer', 'oasis-production-instance-monitor.timer'])
        for _ in range(20):
            try:
                self.runtime.http('http://127.0.0.1:18891/health/ready', 200, 'production')
                break
            except p.Refusal:
                time.sleep(1)
        else:
            raise p.Refusal('PRODUCTION_API_NOT_READY')
        self.fresh()
        self.runtime.command(['systemctl', 'start', 'oasis-production-instance-monitor.service'])
        self.receipt.update(passed=True, admission_enabled=False, players_created=0, coins_funded='0',
                            backup=backup, restore=drill, staged_ingress_pending=True)
        self.event('complete_closed')
        return self.receipt

    def fail_closed(self, error):
        self.receipt['passed'] = False
        self.receipt['error_code'] = str(error) if isinstance(error, p.Refusal) else 'NETWORK_RECOVERY_FAILED'
        self.receipt['failed_at_phase'] = self.receipt['phase']
        self.event('failed_closed')
        try:
            if self.receipt.get('units_installed'):
                self.loaded_unit_guard()
                self.runtime.command(['systemctl', 'stop', 'oasis-production-api.service', 'oasis-production-instance-monitor.timer', 'oasis-production-instance-backup.timer'])
            allowed = {'old'} if self.network_state == 'old' else {'old', 'empty'} if self.network_state == 'disconnecting' else {'empty', 'new'} if self.network_state == 'connecting' else {self.network_state}
            c = self.core_scope(allowed)
            if c['State']['Running'] is True:
                self.runtime.command(['docker', 'stop', '--time', '30', r.CID])
        except Exception as stop_error:
            self.receipt['cleanup_error_code'] = str(stop_error) if isinstance(stop_error, p.Refusal) else 'NETWORK_RECOVERY_STOP_FAILED'
            self.event('failed_closed', stop_refused=True)

    def apply(self):
        raw, _ = r.read_bound(Path(self.args.check), self.args.check_sha256)
        cap = json.loads(raw)
        p.fresh_time(cap.get('at'))
        p.require(cap.get('kind') == 'isolated-production-bootstrap-network-check' and cap.get('passed') is True
                  and cap.get('tool_sha256') == p.digest(Path(__file__).read_bytes())
                  and self.args.recover_exact_bootstrap_network_closed is True, 'NETWORK_RECOVERY_EXPLICIT_FRESH_CHECK_REQUIRED')
        actual = self.check()
        p.require({k: v for k, v in actual.items() if k != 'at'} == {k: v for k, v in cap.items() if k != 'at'},
                  'NETWORK_RECOVERY_CHECK_CHANGED')
        self.capsule = cap
        global_path = p.BASE / 'private/release.lock'
        global_fd = os.open(global_path, os.O_RDONLY | os.O_NOFOLLOW)
        ops_fd = None
        try:
            global_pin = cap['protected']['files'][str(global_path)]
            p.require(global_pin['uid'] == global_pin['gid'] == 0 and global_pin['mode'] == 0o644, 'NETWORK_RECOVERY_SHARED_LOCK_UNSAFE')
            p.lock_descriptor_guard(global_fd, global_path, global_pin)
            p.fcntl.flock(global_fd, p.fcntl.LOCK_EX | p.fcntl.LOCK_NB)
            p.lock_descriptor_guard(global_fd, global_path, global_pin)
            ops_path = p.PRIVATE / 'operations.lock'
            ops_fd = os.open(ops_path, os.O_RDONLY | os.O_NOFOLLOW)
            p.lock_descriptor_guard(ops_fd, ops_path, OPS_PIN)
            p.fcntl.flock(ops_fd, p.fcntl.LOCK_EX | p.fcntl.LOCK_NB)
            p.lock_descriptor_guard(ops_fd, ops_path, OPS_PIN)
            self.ops_fd = ops_fd
            locked = self.check()
            p.require({k: v for k, v in locked.items() if k != 'at'} == {k: v for k, v in cap.items() if k != 'at'},
                      'NETWORK_RECOVERY_LOCKED_CHECK_CHANGED')
            try:
                self.preserve(raw)
                self.replace_network()
                self.advance_source()
                self.bootstrap_only()
                result = self.finish_closed()
                p.lock_descriptor_guard(global_fd, global_path, global_pin)
                p.lock_descriptor_guard(ops_fd, ops_path, OPS_PIN)
                return result
            except Exception as error:
                if self.receipt:
                    self.fail_closed(error)
                raise
        finally:
            if ops_fd is not None:
                if hasattr(self, 'ops_fd'):
                    del self.ops_fd
                os.close(ops_fd)
            os.close(global_fd)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('mode', choices=('check', 'apply'))
    for name in ('release', 'manifest-sha256', 'protected-inventory', 'retired-source', 'retired-source-sha256', 'origin', 'pg-image'):
        result.add_argument('--' + name, required=True)
    result.add_argument('--capacity-budget-bytes', type=int, default=1 << 30)
    result.add_argument('--check')
    result.add_argument('--check-sha256')
    result.add_argument('--recover-exact-bootstrap-network-closed', action='store_true')
    return result


def main():
    args = parser().parse_args()
    os.umask(0o077)
    try:
        p.require(os.getuid() == 0, 'ROOT_REQUIRED')
        tool = Recovery(args)
        print(json.dumps(tool.apply() if args.mode == 'apply' else tool.check(), sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'passed': False, 'error_code': str(error) if isinstance(error, p.Refusal) else 'NETWORK_RECOVERY_INTERNAL_ERROR'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
