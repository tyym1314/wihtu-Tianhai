#!/usr/bin/python3
"""Finish only the witnessed 03 address-format guard failure, with admission closed."""
import argparse
import copy
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

RELEASE = Path('/opt/oasis/releases/20261010-03')
TOOL = Path('/opt/oasis/private/production-bootstrap-tail-20261010/recover-bootstrap-tail.py')
MANIFEST = '901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d'
PREVIOUS_TOOL = '7b4a37d681122d7d4fc50e812b16d4d44a69aedaf3ec056a7bba15d1a0335239'
NETWORK_TOOL = '6aa9fe8e4911513fbde403bd5332a51fc64520978c477649338b663b7661dcb4'
FAILED3 = '97e3e151a4e0ae8cba948d76cc92631c084fdb57136dfb7995a5a30c3b3bda8e'
NETWORK_CHECK = '7afd327835daa66e62b0ab40503c0cf23b1d01b40a12671abba874cafea6c2a1'
NEW_ID = 'e50c45372afb7783737e5b64d32355d0d7702ac3fa9335da4d7c99e08da1d2fc'
HELPERS = {'bootstrap.mjs': '754397b8b4604a66bbcaf5010e1a13ae21675dd024f00b729289019e301abe5a',
           'inspect-backup.mjs': '07adc794f4fdceb393ca9c59f0a70235a34bb444ba3f4e16a2559e1211350c23',
           'monitor.mjs': 'a846a8958d1e29ad8ee4785512642ffc52ce709816a685166c4d95685005afa5',
           'operations.py': '9631ba7693914ec08a11d8bb1c42c6a6b001cf9b2985b5a4ba2c3ac51ba2da76',
           'provision.py': '00203af2bf2c727fcbcee2b5288da91af584f5fb4dd252de56e18e7c3be1e5cd'}
# Imported locally solely for fixture tests. A real check rejects this mode and
# requires the root-private controller and every import at its exact 03 path.
HELPER_ROOT = RELEASE / 'platform/deploy/production-instance' if Path(__file__).absolute() == TOOL else Path(__file__).resolve().parent


def load(name, filename):
    path = HELPER_ROOT / filename
    expected = HELPERS.get(filename, PREVIOUS_TOOL if filename == 'recover-created.py' else None)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 2 << 20:
            raise ValueError('TAIL_IMPORT_FILE_INVALID')
        body = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            body.extend(block)
            if len(body) > 2 << 20:
                raise ValueError('TAIL_IMPORT_FILE_INVALID')
        after = os.fstat(fd)
        current = path.lstat()
        if (before.st_mtime_ns, before.st_ctime_ns, before.st_size) != (after.st_mtime_ns, after.st_ctime_ns, after.st_size) or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino) or hashlib.sha256(body).hexdigest() != expected:
            raise ValueError('TAIL_IMPORT_BYTES_CHANGED')
    finally:
        os.close(fd)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Execute the verified FD bytes, rather than rereading a replaceable name.
    exec(compile(body, str(path), 'exec'), module.__dict__)
    return module


p = load('oasis_tail_provision', 'provision.py')
r = load('oasis_tail_private_reader', 'recover-created.py')
r.p = p  # Only read_bound and parse_private_env are reused, never its recovery.
PRIOR = p.PRIVATE / 'recovery-bootstrap-network-20261010'
RECOVERY = p.PRIVATE / 'recovery-bootstrap-tail-20261010'
PIN_META = {'uid': 0, 'gid': 0, 'mode': 0o777, 'device': 64515, 'inode': 1025182,
            'kind': 'symlink', 'target': str(RELEASE)}
VOLUME_META = {**r.VOLUME_META, 'mode': 0o700}
MONITOR_META = {'uid': 0, 'gid': 999, 'mode': 0o750, 'device': 64515, 'inode': 1030226, 'kind': 'directory'}
OPS_PIN = {'uid': 0, 'gid': 0, 'mode': 0o600, 'device': 64515, 'inode': 929009,
           'kind': 'file', 'bytes': 0, 'sha256': p.digest(b'')}
PRIVATE_MEMBERS = {'installation.json', 'receipt.json', 'operations.lock', 'postgres.env', 'runtime.env',
                   'operator-credentials.json', 'state', 'monitor', 'recovery-created-20261010', 'recovery-bootstrap-network-20261010'}


def pin_metadata():
    s = p.PIN.lstat()
    p.require(stat.S_ISLNK(s.st_mode), 'TAIL_PRODUCTION_PIN_NOT_SYMLINK')
    return {'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode),
            'device': s.st_dev, 'inode': s.st_ino, 'kind': 'symlink', 'target': os.readlink(p.PIN)}


def controller_guard(args):
    p.require(re.fullmatch('[a-f0-9]{64}', args.controller_sha256 or ''), 'TAIL_EXTERNAL_CONTROLLER_SHA_REQUIRED')
    p.require(Path(__file__).absolute() == TOOL and HELPER_ROOT == RELEASE / 'platform/deploy/production-instance'
              and not any(parent.is_symlink() for parent in TOOL.parents), 'TAIL_CONTROLLER_LOCATION_INVALID')
    body, meta = r.read_bound(TOOL, args.controller_sha256)
    directory = p.fingerprint(TOOL.parent)
    p.require(directory['kind'] == 'directory' and directory['uid'] == directory['gid'] == 0 and directory['mode'] == 0o700
              and re.fullmatch('[a-f0-9]{40}', args.source_commit or ''), 'TAIL_CONTROLLER_PROVENANCE_INVALID')
    p.no_mount(TOOL.parent)
    p.require(all(p.digest((HELPER_ROOT / name).read_bytes()) == sha for name, sha in HELPERS.items())
              and Path(p.__file__).absolute() == HELPER_ROOT / 'provision.py'
              and Path(r.__file__).absolute() == HELPER_ROOT / 'recover-created.py'
              and p.digest((HELPER_ROOT / 'recover-created.py').read_bytes()) == PREVIOUS_TOOL,
              'TAIL_IMMUTABLE_IMPORT_CHANGED')
    return {'source_commit': args.source_commit, 'tool_pin': meta, 'directory_pin': directory,
            'tool_sha256': p.digest(body), 'helper_root': str(HELPER_ROOT), 'helpers': HELPERS}


def evidence_guard(check, failure):
    p.require(check.get('kind') == 'isolated-production-bootstrap-network-check' and check.get('passed') is True
              and check.get('tool_sha256') == NETWORK_TOOL and check.get('release') == str(RELEASE)
              and check.get('manifest_sha256') == MANIFEST and check.get('helpers') == HELPERS
              and check.get('protected_inventory_sha256') == r.PROTECTED_SHA, 'TAIL_ORIGINAL_CHECK_INVALID')
    phases = ['original_evidence_preserved', 'legacy_database_readonly_proved', 'old_network_disconnect_authorized',
              'old_network_disconnected', 'old_network_removed', 'new_network_created', 'new_network_connect_authorized',
              'new_network_connected', 'source_and_network_advanced', 'failed_closed']
    history = failure.get('history', [])
    p.require(failure.get('kind') == 'isolated-production-bootstrap-network-recovery' and failure.get('schema') == 1
              and failure.get('passed') is False and failure.get('phase') == 'failed_closed'
              and failure.get('failed_at_phase') == 'source_and_network_advanced'
              and failure.get('error_code') == 'NETWORK_RECOVERY_APP_CONNECTION_NOT_OWN_CONTAINER'
              and not failure.get('cleanup_error_code') and failure.get('container_id') == r.CID
              and failure.get('check_sha256') == NETWORK_CHECK and failure.get('tool_sha256') == NETWORK_TOOL
              and failure.get('source') == HELPERS and failure.get('network_state') == 'new'
              and failure.get('new_network_id') == NEW_ID and failure.get('old_network_id') == r.NETWORK_ID
              and failure.get('original_failed_receipt_sha256') == r.OLD_RECEIPT
              and failure.get('recovery_failed_receipt_sha256') == '5f61173d76a4c44e840de855f9ff376f1f2c086bc8586a430348d15c06953f95'
              and [x.get('phase') for x in history] == phases and history[8].get('production_pin') == PIN_META
              and all(history[i].get('new_network_id') == NEW_ID for i in (5, 6, 7, 8))
              and not any(name in failure for name in ('bootstrap', 'units_installed', 'unit_pins', 'backup', 'restore')),
              'TAIL_ORIGINAL_FAILURE_INVALID')
    marker = copy.deepcopy(check['incident']['marker'])
    p.require(marker.get('schema') == 1 and marker.get('kind') == 'isolated-production-instance'
              and marker.get('container_id') == r.CID and marker.get('owner') == r.OWNER
              and type(marker.get('uid')) is int and marker['uid'] == 997
              and type(marker.get('gid')) is int and marker['gid'] == 999
              and marker.get('pg_image') == r.IMAGE and marker.get('network_id') == r.NETWORK_ID
              and marker.get('release') == '/opt/oasis/releases/20261010-02'
              and marker.get('manifest_sha256') == '6621d3955184a6bef0e0391f7976af9c81385362967435c2e4f9022b1d4fe339',
              'TAIL_ORIGINAL_MARKER_INVALID')
    marker.update(release=str(RELEASE), manifest_sha256=MANIFEST, network_id=NEW_ID)
    return marker


def validate_row(row, addr):
    p.require(row.get('database') == p.DATABASE and row.get('database_oid') == '16384'
              and row.get('role') == p.DB_APP and row.get('privileged') is False and row.get('login') is True
              and row.get('schema_owner') == p.DB_APP and type(row.get('relations')) is int and row['relations'] == 0,
              'TAIL_DATABASE_NOT_EXACT_EMPTY')
    try:
        expected = str(ipaddress.IPv4Address(addr))
    except (ValueError, TypeError):
        raise p.Refusal('TAIL_DOCKER_ADDRESS_INVALID')
    p.require(expected == addr and row.get('server_host') == addr and row.get('server_addr') == addr + '/32'
              and type(row.get('server_family')) is int and row['server_family'] == 4
              and type(row.get('server_masklen')) is int and row['server_masklen'] == 32
              and type(row.get('server_port')) is int and row['server_port'] == 5432,
              'TAIL_APP_CONNECTION_NOT_OWN_CONTAINER')
    return row


SELECT = """SELECT current_database() AS database,
(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
current_user AS role,(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged,
(SELECT rolcanlogin FROM pg_roles WHERE rolname=current_user) AS login,
(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') AS schema_owner,
(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AS relations,
inet_server_addr()::text AS server_addr,host(inet_server_addr()) AS server_host,
family(inet_server_addr()) AS server_family,masklen(inet_server_addr()) AS server_masklen,inet_server_port() AS server_port"""


class NodeFailure(p.Refusal):
    def __init__(self, code, metadata):
        super().__init__(code)
        self.diagnostics = metadata


class DiagnosticRuntime(p.Runtime):
    def command(self, args, *, input=None, env=None, timeout=60, binary=False):
        if args[0] != '/usr/bin/node':
            return super().command(args, input=input, env=env, timeout=timeout, binary=binary)
        p.require(hasattr(self, 'diagnostic_root'), 'TAIL_NODE_DIAGNOSTICS_NOT_READY')
        self.diagnostic_guard()
        clean = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', **(env or {})}
        try:
            stdin = input.encode() if isinstance(input, str) else input
            result = p.subprocess.run(args, input=stdin, capture_output=True, text=False, timeout=timeout, env=clean, check=False)
            out, err, status = result.stdout, result.stderr, result.returncode
            code = 'COMMAND_FAILED_NODE'
        except (OSError, p.subprocess.TimeoutExpired) as error:
            out, err, status = getattr(error, 'stdout', None) or b'', getattr(error, 'stderr', None) or b'', None
            code = 'NODE_COMMAND_UNAVAILABLE_OR_TIMEOUT'
        metadata = self.save_diagnostics(out, err, status)
        self.last_diagnostics = metadata
        self.diagnostic_records.append(metadata)
        if status != 0:
            raise NodeFailure(code, metadata)
        if binary or isinstance(out, str):
            return out
        try:
            return out.decode('utf-8')
        except UnicodeDecodeError:
            raise NodeFailure('NODE_RESPONSE_UTF8_INVALID', metadata)

    def diagnostic_guard(self):
        p.require(p.fingerprint(self.diagnostic_root) == self.diagnostic_directory_pin, 'TAIL_DIAGNOSTIC_DIRECTORY_CHANGED')
        p.no_mount(self.diagnostic_root)
        for name, pin in self.diagnostic_pins.items():
            p.require(p.fingerprint(self.diagnostic_root / name) == pin, 'TAIL_DIAGNOSTIC_FILE_CHANGED')

    def save_diagnostics(self, stdout, stderr, status):
        self.diagnostic_guard()
        token = p.secrets.token_hex(8)
        names = {}
        for label, body in (('stdout', stdout), ('stderr', stderr)):
            name = token + '-' + label + '.bin'
            raw = body.encode() if isinstance(body, str) else body
            p.exclusive(self.diagnostic_root / name, raw)
            self.diagnostic_pins[name] = p.fingerprint(self.diagnostic_root / name)
            names[label] = {'path': str(self.diagnostic_root / name), 'sha256': p.digest(raw), 'bytes': len(raw)}
        code = None
        try:
            obj = json.loads(stderr)
            code = obj.get('code') if isinstance(obj, dict) else None
        except (ValueError, TypeError):
            pass
        if not isinstance(code, str) or not re.fullmatch('[A-Z0-9_]{1,48}', code):
            code = None
        return {'exit_code': status, 'structured_error_code': code, **names}


class Recovery(p.Provisioner):
    def __init__(self, args, runtime=None):
        super().__init__(args, runtime or DiagnosticRuntime())

    def origin(self):
        check_raw, check_pin = r.read_bound(PRIOR / 'check.json', NETWORK_CHECK)
        failure_raw, failure_pin = r.read_bound(PRIOR / 'receipt.json', FAILED3)
        original = json.loads(check_raw)
        expected = evidence_guard(original, json.loads(failure_raw))
        marker_raw, marker_pin = r.read_bound(p.PRIVATE / 'installation.json')
        self.marker = json.loads(marker_raw)
        p.require(self.marker == expected and pin_metadata() == PIN_META, 'TAIL_ADVANCED_OWNERSHIP_CHANGED')
        pins = {str(PRIOR / 'check.json'): check_pin, str(PRIOR / 'receipt.json'): failure_pin,
                str(p.PRIVATE / 'installation.json'): marker_pin}
        for path, meta in original['incident']['immutable_files'].items():
            p.require(p.fingerprint(Path(path)) == meta, 'TAIL_EARLIER_FAILURE_CHANGED')
            pins[path] = meta
        history = original['history']
        history_root = Path('/opt/oasis/private/production-stage-20261010-v3/retired-source')
        for name, meta in history['files'].items():
            p.require(p.fingerprint(history_root / name) == meta, 'TAIL_RETIRED_EVIDENCE_CHANGED')
            pins[str(history_root / name)] = meta
        history_file = history_root / 'retired-source.json'
        p.require(p.fingerprint(history_file) == history['receipt_pin'], 'TAIL_RETIRED_RECEIPT_CHANGED')
        pins[str(history_file)] = history['receipt_pin']
        for name, meta in history['directories'].items():
            p.require(p.fingerprint(history_root / name) == meta, 'TAIL_RETIRED_DIRECTORY_CHANGED')
        return {'original': original, 'immutable_files': pins, 'retired_directories': history['directories'],
                'marker': self.marker, 'marker_pin': marker_pin, 'production_pin': PIN_META}

    def scope(self):
        p.require(p.fingerprint(r.VOLUME_PATH) == VOLUME_META and not any(parent.is_symlink() for parent in r.VOLUME_PATH.parents),
                  'TAIL_VOLUME_IDENTITY_CHANGED')
        p.no_mount(r.VOLUME_PATH)
        p.require(p.fingerprint(p.PRIVATE / 'operations.lock') == OPS_PIN and pin_metadata() == PIN_META,
                  'TAIL_FIXED_OPERATIONS_OR_SOURCE_PIN_CHANGED')
        result = self.load_operations().owned_resources(self.marker, self.runtime)
        p.require(result['container_id'] == r.CID and result['network_id'] == NEW_ID, 'TAIL_NORMAL_RESOURCE_ID_CHANGED')
        return result

    def check(self):
        p.require(self.release == RELEASE and self.args.manifest_sha256 == MANIFEST
                  and self.args.origin == 'https://oasis-player.43.98.202.236.sslip.io' and self.args.pg_image == r.IMAGE
                  and p.digest(Path(self.args.protected_inventory).read_bytes()) == r.PROTECTED_SHA,
                  'TAIL_EXACT_INPUTS_REQUIRED')
        controller = controller_guard(self.args)
        release = p.verify_release(self.release, MANIFEST)
        p.require(release['helpers'] == HELPERS, 'TAIL_HELPERS_CHANGED')
        protected = self.guard()
        origin = self.origin()
        resources = self.scope()
        c = self.runtime.inspect('container', r.CID)
        state = c['State']
        p.require(resources['running'] is False and state.get('Status') == 'exited'
                  and all(state.get(key) is False for key in ('Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead'))
                  and type(state.get('Pid')) is int and state['Pid'] == 0 and type(state.get('ExitCode')) is int and state['ExitCode'] == 0
                  and state.get('Error') == '', 'TAIL_ORIGINAL_PG_NOT_STOPPED')
        p.require(not os.path.lexists(RECOVERY) and not os.path.lexists(p.PRIVATE / 'bootstrap.json')
                  and {x.name for x in p.PRIVATE.iterdir()} == PRIVATE_MEMBERS and not list(p.BACKUPS.iterdir())
                  and {x.name for x in (p.PRIVATE / 'state').iterdir()} == {'master.key'}
                  and not list((p.PRIVATE / 'monitor').iterdir()) and p.fingerprint(p.PRIVATE / 'monitor') == MONITOR_META,
                  'TAIL_ORIGINAL_PHASE_CHANGED')
        p.unit_namespace_guard()
        units = {name: self.runtime.service(name) for name in p.UNITS}
        p.require(all(not s.get('FragmentPath') and not s.get('DropInPaths') and not int(s.get('MainPID') or 0)
                      and s.get('ActiveState') == 'inactive' and s.get('NeedDaemonReload') == 'no' for s in units.values()),
                  'TAIL_OWNED_UNIT_ALREADY_EXISTS')
        p.require('997' not in self.runtime.command(['ps', '-eo', 'uid=']).split()
                  and not any(re.search(r':(?:18891|18893)\s', line) for line in self.runtime.command(['ss', '-H', '-ltn']).splitlines()),
                  'TAIL_OWNED_PROCESS_OR_PORT_ACTIVE')
        disk = os.statvfs(p.BASE)
        p.require(self.args.capacity_budget_bytes >= 1 << 30 and disk.f_bavail * disk.f_frsize - self.args.capacity_budget_bytes
                  >= max(3 << 30, disk.f_blocks * disk.f_frsize * 0.15), 'PRODUCTION_CAPACITY_RESERVE_FAILED')
        p.require(origin == self.origin() and resources == self.scope()
                  and state == self.runtime.inspect('container', r.CID)['State']
                  and units == {name: self.runtime.service(name) for name in p.UNITS}
                  and controller == controller_guard(self.args) and protected == self.guard(protected),
                  'TAIL_CHECK_STATE_CHANGED')
        return {'schema': 1, 'kind': 'isolated-production-bootstrap-tail-check', 'passed': True, 'at': p.now(),
                'release': str(RELEASE), **release, 'controller': controller, 'origin': origin, 'resources': resources,
                'container_state': state, 'unit_states': units, 'protected': protected, 'protected_inventory_sha256': r.PROTECTED_SHA,
                'admission_enabled': False, 'capacity_budget_bytes': self.args.capacity_budget_bytes}

    def evidence_fresh(self):
        p.require(controller_guard(self.args) == self.capsule['controller'], 'TAIL_CONTROLLER_CHANGED')
        for path, meta in self.capsule['origin']['immutable_files'].items():
            p.require(p.fingerprint(Path(path)) == meta, 'TAIL_ORIGINAL_EVIDENCE_CHANGED')
        history_root = Path('/opt/oasis/private/production-stage-20261010-v3/retired-source')
        for name, meta in self.capsule['origin']['retired_directories'].items():
            p.require(p.fingerprint(history_root / name) == meta, 'TAIL_RETIRED_DIRECTORY_CHANGED')
        if self.receipt:
            p.require(p.fingerprint(RECOVERY) == self.directory_pin, 'TAIL_RECOVERY_DIRECTORY_CHANGED')
            for name, meta in self.saved_pins.items():
                p.require(p.fingerprint(RECOVERY / name) == meta, 'TAIL_SAVED_EVIDENCE_CHANGED')
            self.runtime.diagnostic_guard()
        if hasattr(self, 'ops_fd'):
            p.lock_descriptor_guard(self.ops_fd, p.PRIVATE / 'operations.lock', OPS_PIN)

    def fresh(self, **kwargs):
        p.require(not kwargs, 'TAIL_PRESTART_EXCEPTION_FORBIDDEN')
        self.evidence_fresh()
        super().fresh()
        self.scope()

    def event(self, phase, **fields):
        self.receipt['phase'] = phase
        self.receipt['history'].append({'at': p.now(), 'phase': phase, **fields})
        path = RECOVERY / 'receipt.json'
        if os.path.lexists(path):
            p.require(p.fingerprint(path) == self.receipt_pin, 'TAIL_RECEIPT_CHANGED')
        tmp = RECOVERY / ('receipt-' + p.secrets.token_hex(8) + '.tmp')
        p.exclusive(tmp, p.canonical(self.receipt))
        os.replace(tmp, path)
        self.receipt_pin = p.fingerprint(path)

    def preserve(self, raw):
        RECOVERY.mkdir(mode=0o700)
        os.chmod(RECOVERY, 0o700)
        self.directory_pin = p.fingerprint(RECOVERY)
        self.saved_pins = {}
        for name, path, sha in (('network-check-original.json', PRIOR / 'check.json', NETWORK_CHECK),
                                ('network-failure-original.json', PRIOR / 'receipt.json', FAILED3),
                                ('marker-original.json', p.PRIVATE / 'installation.json', self.capsule['origin']['marker_pin']['sha256'])):
            body, _ = r.read_bound(path, sha)
            p.exclusive(RECOVERY / name, body)
            self.saved_pins[name] = p.fingerprint(RECOVERY / name)
        p.exclusive(RECOVERY / 'check.json', raw)
        self.saved_pins['check.json'] = p.fingerprint(RECOVERY / 'check.json')
        directory = RECOVERY / 'diagnostics'
        directory.mkdir(mode=0o700)
        os.chmod(directory, 0o700)
        self.runtime.diagnostic_root = directory
        self.runtime.diagnostic_directory_pin = p.fingerprint(directory)
        self.runtime.diagnostic_pins = {}
        self.runtime.diagnostic_records = []
        self.receipt = {'schema': 1, 'kind': 'isolated-production-bootstrap-tail-recovery', 'passed': False,
                        'at': p.now(), 'history': [], 'container_id': r.CID, 'network_id': NEW_ID,
                        'source': HELPERS, 'manifest_sha256': MANIFEST, 'controller': self.capsule['controller'],
                        'check_sha256': self.args.check_sha256, 'original_network_failure_sha256': FAILED3,
                        'original_network_check_sha256': NETWORK_CHECK}
        self.event('original_tail_evidence_preserved')

    def app_probe(self, env):
        self.fresh()
        c = self.runtime.inspect('container', r.CID)
        addr = c['NetworkSettings']['Networks'][p.NETWORK]['IPAddress']
        code = 'const {pool,closePools}=await import(' + json.dumps((RELEASE / 'platform/server/db.mjs').as_uri()) + ');'
        code += 'let c;try{c=await pool.connect();await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await c.query("SET LOCAL statement_timeout=15000");'
        code += 'const row=(await c.query(' + json.dumps(SELECT) + ')).rows[0];await c.query("COMMIT");process.stdout.write(JSON.stringify(row));}'
        code += 'catch(e){process.stderr.write(JSON.stringify({code:e.code||e.name}));process.exitCode=1;}finally{c?.release();await closePools();}'
        body = self.runtime.command(['/usr/bin/node', '--input-type=module', '-e', code], env=env, timeout=30)
        return validate_row(json.loads(body), addr)

    def bootstrap_only(self):
        self.fresh()
        p.require(self.scope()['running'] is False, 'TAIL_PG_ALREADY_STARTED')
        self.runtime.command(['docker', 'start', r.CID])
        for _ in range(30):
            try:
                self.runtime.command(['docker', 'exec', r.CID, 'pg_isready', '-h', '127.0.0.1', '-U', p.DB_OWNER, '-d', p.DATABASE])
                break
            except p.Refusal:
                time.sleep(1)
        else:
            raise p.Refusal('PRODUCTION_DATABASE_NOT_READY')
        self.fresh()
        p.require(self.scope()['running'] is True, 'TAIL_PG_NOT_RUNNING')
        p.require_pg_host_tcp()
        self.event('normal_database_started')
        raw, _ = r.read_bound(p.PRIVATE / 'runtime.env', self.marker['private_pins']['runtime.env']['sha256'])
        env = r.parse_private_env(raw)
        try:
            row = self.app_probe(env)
            self.event('app_empty_database_readonly_proved', evidence=row)
            self.fresh()
            env['OASIS_BOOTSTRAP_ALLOWED_ORIGINS'] = json.dumps(self.marker['origins'], separators=(',', ':'))
            self.runtime.command(['/usr/bin/node', '--import', str(RELEASE / 'platform/node_modules/tsx/dist/loader.mjs'),
                                  str(RELEASE / 'platform/deploy/production-instance/bootstrap.mjs'),
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
        backup = ops.backup(self.marker, self.runtime)
        self.event('backup_created', backup=backup)
        drill = ops.restore(self.marker, Path(backup['path']), self.runtime)
        p.require(drill['passed'] and drill['cleanup']['database_removed'] and drill['cleanup']['temporary_removed'], 'PRODUCTION_RESTORE_DRILL_FAILED')
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
                            backup=backup, restore=drill, staged_ingress_pending=True,
                            node_diagnostics=self.runtime.diagnostic_records)
        self.event('complete_closed')
        return self.receipt

    def fail_closed(self, error):
        self.receipt['passed'] = False
        self.receipt['error_code'] = str(error) if isinstance(error, p.Refusal) else 'TAIL_RECOVERY_FAILED'
        self.receipt['failed_at_phase'] = self.receipt['phase']
        if isinstance(error, NodeFailure):
            self.receipt['diagnostics'] = error.diagnostics
        self.receipt['node_diagnostics'] = self.runtime.diagnostic_records
        self.event('failed_closed')
        try:
            if self.receipt.get('units_installed'):
                self.loaded_unit_guard()
                self.runtime.command(['systemctl', 'stop', 'oasis-production-api.service', 'oasis-production-instance-monitor.timer', 'oasis-production-instance-backup.timer'])
            if self.scope()['running']:
                self.runtime.command(['docker', 'stop', '--time', '30', r.CID])
        except Exception as error:
            self.receipt['cleanup_error_code'] = str(error) if isinstance(error, p.Refusal) else 'TAIL_STOP_FAILED'
            self.event('failed_closed', stop_refused=True)

    def apply(self):
        p.require(self.args.check and re.fullmatch('[a-f0-9]{64}', self.args.check_sha256 or ''), 'TAIL_EXTERNAL_CHECK_SHA_REQUIRED')
        raw, _ = r.read_bound(Path(self.args.check), self.args.check_sha256)
        cap = json.loads(raw)
        p.fresh_time(cap.get('at'))
        p.require(cap.get('kind') == 'isolated-production-bootstrap-tail-check' and cap.get('passed') is True
                  and cap.get('controller') == controller_guard(self.args) and self.args.recover_exact_bootstrap_tail_closed is True,
                  'TAIL_EXPLICIT_FRESH_CHECK_REQUIRED')
        def same(value):
            return {k: v for k, v in value.items() if k != 'at'} == {k: v for k, v in cap.items() if k != 'at'}
        p.require(same(self.check()), 'TAIL_CHECK_CHANGED')
        self.capsule = cap
        global_path = p.BASE / 'private/release.lock'
        global_fd = os.open(global_path, os.O_RDONLY | os.O_NOFOLLOW)
        ops_fd = None
        try:
            global_pin = cap['protected']['files'][str(global_path)]
            p.require(global_pin['uid'] == global_pin['gid'] == 0 and global_pin['mode'] == 0o644, 'TAIL_SHARED_LOCK_UNSAFE')
            p.lock_descriptor_guard(global_fd, global_path, global_pin)
            p.fcntl.flock(global_fd, p.fcntl.LOCK_EX | p.fcntl.LOCK_NB)
            p.lock_descriptor_guard(global_fd, global_path, global_pin)
            ops_path = p.PRIVATE / 'operations.lock'
            ops_fd = os.open(ops_path, os.O_RDONLY | os.O_NOFOLLOW)
            p.lock_descriptor_guard(ops_fd, ops_path, OPS_PIN)
            p.fcntl.flock(ops_fd, p.fcntl.LOCK_EX | p.fcntl.LOCK_NB)
            p.lock_descriptor_guard(ops_fd, ops_path, OPS_PIN)
            self.ops_fd = ops_fd
            p.require(same(self.check()), 'TAIL_LOCKED_CHECK_CHANGED')
            try:
                self.preserve(raw)
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
    for name in ('controller-sha256', 'source-commit', 'protected-inventory', 'origin', 'pg-image'):
        result.add_argument('--' + name, required=True)
    result.add_argument('--release', default=str(RELEASE))
    result.add_argument('--manifest-sha256', default=MANIFEST)
    result.add_argument('--capacity-budget-bytes', type=int, default=1 << 30)
    result.add_argument('--check')
    result.add_argument('--check-sha256')
    result.add_argument('--recover-exact-bootstrap-tail-closed', action='store_true')
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
        value = {'passed': False, 'error_code': str(error) if isinstance(error, p.Refusal) else 'TAIL_INTERNAL_ERROR'}
        if isinstance(error, NodeFailure):
            value['diagnostics'] = error.diagnostics
        print(json.dumps(value, sort_keys=True))
        return 2


if __name__ == '__main__':
    sys.exit(main())
