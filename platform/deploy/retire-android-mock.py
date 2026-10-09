#!/usr/bin/env python3
"""Retire only the inventoried Android Mock namespace; default is read-only.

check emits a metadata/hash capsule. apply requires its external SHA, a fresh
capsule, and an explicit dedicated-data deletion flag. It never restores data,
prunes Docker, removes images/releases/shared assets, or prints command output.
"""
import argparse
import ast
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import ipaddress
import os
from pathlib import Path
import pwd
import grp
import re
import ssl
import stat
import subprocess
import time
import urllib.error
import urllib.request

BASE = Path('/opt/oasis')
PRIVATE = BASE / 'android-mock-private'
HOST = 'oasis-mock.43.98.202.236.sslip.io'
PUBLIC = 'https://game.tianyahuyu.com'
LABEL = 'com.oasis.android-mock'
USER = 'oasis-mock'
CONTAINER = 'oasis-android-mock-postgres'
VOLUME = 'oasis-android-mock-postgres-data'
NETWORK = 'oasis-android-mock-internal'
CURRENT = '/opt/oasis/releases/20261009-03'
PREVIOUS = '/opt/oasis/releases/20261009-02'
MOCK = '/opt/oasis/releases/20261008-23'
INVENTORY_SHA = 'b7fbaa0b88463bcf7ae174adf0e730f7c27fde176b71e180dbe18d8ada6d6e8c'
# This is the sole authorized interruption. It stopped all owned units but did
# not change routing or delete a container, volume, network, file or account.
FAILED_V5_TOOL_SHA = 'd5639a84bf25c639ebf1fcdf17b6bd4c0327ef97ae66e319a144aa6b7a8b4127'
FAILED_V5_CHECK_SHA = '3681ad386363bf9e342e0a7b6e35aa8a0512c61864426905b3f827e6c56adb48'
FAILED_V5_RECEIPT_SHA = '10ba5961cdcd827339446b5ab8926c4d0fca873f3f625d70f5afe36c5705bed6'
FAILED_V6_TOOL_SHA = '4e03815325bab0d0bf348f2e03f3d3d515f3f1da1fc02e006f05c428ff9955ee'
FAILED_V6_CHECK_SHA = '9026476071f374d995ecb5ea76857ebd597e0ca7ed44128972a0a618cba3c6a9'
FAILED_V6_RECEIPT_SHA = '6b6da3f60e8a0511c98ea55a80c417b22b69516d93b3cf153e749f5ccdaf2075'
V6_TLS_SHA = '6915323fd6c70812bdf68b24507e28a707ac5e02d357643c1963a48bc4b7faa8'
V6_PROXY_SHA = '378ed660d71fe1ece2aaf09f855b5f15e5eb83be301935925726c1b6ee909559'
V6_PROXY_RAW_SHA = '655126480b2735772457bdac10a977d56aa53f9030cce66420a001c527e62f2c'
TLS = Path('/etc/nginx/conf.d/oasis-android-mock.conf')
BRIDGE = Path('/etc/nginx/conf.d/oasis-android-mock-acme.conf')
PROXY_CONF = str(BRIDGE)
CERT = BASE / 'acme/config/live/oasis-android-mock'
RENEWAL = BASE / 'acme/config/renewal/oasis-android-mock.conf'
WEBROOT = BASE / 'android-mock-acme-webroot'
RECEIPT = BASE / 'private/mock-retirement-20261010'
SYSTEMD = Path('/etc/systemd/system')
UNITS = tuple('oasis-android-mock-' + value for value in
              ('api.service', 'demo.service', 'db.service', 'network.service',
               'certificate.service', 'certificate.timer', 'db-proxy.service', 'db-proxy.socket'))
PUBLIC_UNITS = ('oasis-api.service', 'oasis-demo.service', 'nginx.service', 'oasis-production.service')
PROPERTIES = 'ActiveState,SubState,MainPID,UnitFileState,Requires,Wants,FragmentPath'
SQL = """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),
'apps',(SELECT count(*) FROM gp_apps),'sessions',(SELECT count(*) FROM gp_sessions),
'pending_rooms',(SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')),
'pending_cycles',(SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')),
'non_sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment<>'sandbox'),
'pending_gp_operations',(SELECT count(*) FROM gp_operations WHERE state='PENDING'),
'pending_pvp_operations',(SELECT count(*) FROM pvp_operations WHERE state='PENDING'),
'pending_presentations',(SELECT count(*) FROM gp_sessions s LEFT JOIN gp_cycles c ON c.id=s.state->>'cycleId'
 WHERE s.state->>'pendingPlay' IS NOT NULL OR COALESCE((s.state->>'nextIndex')::int,0)<COALESCE(jsonb_array_length(c.result->'rounds'),0)),
'pending_integration_checks',(SELECT count(*) FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING')),
'pending_reservations',(SELECT count(*) FROM wallet_reservations WHERE state='RESERVED'),
'pending_wallet_matches',(SELECT count(*) FROM wallet_matches WHERE state NOT IN ('SETTLED','VOIDED','CANCELLED')),
'pending_wallet_probability',(SELECT count(*) FROM wallet_probability WHERE state NOT IN ('SETTLED','CANCELLED','EXPIRED')),
'pending_reserved_balances',(SELECT count(*) FROM wallet_users WHERE reserved<>0 OR credit_pending<>0),
__TRANSFER_FIELDS__);
COMMIT;"""
MAX_INPUT = 16 * 1024**2


def require(value, code):
    if not value:
        raise RuntimeError(code)


class PendingBusiness(RuntimeError):
    def __init__(self, code, document):
        super().__init__(code)
        self.pending_counts = {key: value for key, value in document.items()
                               if key.startswith('pending_') or key == 'non_sandbox_apps'}


def pending_free(document, code):
    counts = {key: value for key, value in document.items()
              if key.startswith('pending_') or key == 'non_sandbox_apps'}
    require(len(counts) >= 14 and all(type(value) is int and value >= 0 for value in counts.values()),
            'BUSINESS_COUNTS_INCOMPLETE')
    if any(counts.values()):
        raise PendingBusiness(code, document)


def loaded_stop_guard(unit, values):
    require(values.get('NeedDaemonReload') == 'no', 'OWNED_UNIT_MANAGER_NEEDS_RELOAD')
    required = ('ExecStop', 'ExecStopPost') if unit.endswith('.service') else \
               ('ExecStopPre', 'ExecStopPost') if unit.endswith('.socket') else ()
    require(set(values) == {'NeedDaemonReload', *required}, 'LOADED_EXEC_STOP_PROPERTY_MISSING')
    result = {'need_daemon_reload': False, 'typed_commands': {}}
    for name in required:
        document = values[name]
        require(isinstance(document, dict) and set(document) == {'type', 'data'}
                and document['type'] == 'a(sasbttttuii)' and isinstance(document['data'], list),
                'LOADED_COMMAND_DBUS_SHAPE_UNKNOWN')
        commands = document['data']
        normalized = []
        for row in commands:
            require(isinstance(row, list) and len(row) == 10 and isinstance(row[0], str)
                    and isinstance(row[1], list) and all(isinstance(arg, str) for arg in row[1])
                    and type(row[2]) is bool and all(type(item) is int for item in row[3:]),
                    'LOADED_COMMAND_DBUS_ROW_UNKNOWN')
            normalized.append({'path': row[0], 'argv': row[1], 'ignore_errors': row[2]})
        if unit == 'oasis-android-mock-db.service' and name == 'ExecStop':
            expected = {'path': '/usr/bin/docker', 'argv': ['/usr/bin/docker', 'stop', '--time', '30', CONTAINER],
                        'ignore_errors': False}
            require(normalized == [expected], 'UNKNOWN_LOADED_DATABASE_STOP')
        else:
            require(not normalized, 'UNKNOWN_LOADED_' + name.upper())
        # Never retain raw argv for an unknown command or changing timestamps,
        # process IDs and exit history. Only validated configuration is evidence.
        result['typed_commands'][name] = {'type': document['type'], 'count': len(normalized), 'commands': normalized}
    return result


def dbus_unit_path(unit):
    require(unit in UNITS, 'DBUS_UNIT_OUTSIDE_OWNED_SCOPE')
    label = ''.join(character if character.isascii() and character.isalnum() else '_' + format(ord(character), '02x')
                    for character in unit)
    return '/org/freedesktop/systemd1/unit/' + label


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def pairs(rows):
    result = {}
    for key, value in rows:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def decode(value):
    return json.loads(value, object_pairs_hook=pairs)


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def regular(path, *, owner=0, limit=None):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == owner
            and not stat.S_IMODE(info.st_mode) & 0o022, 'UNSAFE_REGULAR_FILE')
    require(limit is None or info.st_size <= limit, 'INPUT_TOO_LARGE')
    return info


def stable(info):
    return tuple(getattr(info, 'st_' + key) for key in
                 ('dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtime_ns', 'ctime_ns'))


def body(path, *, owner=0):
    before = regular(path, owner=owner, limit=MAX_INPUT)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        require(os.fstat(stream.fileno()).st_ino == before.st_ino, 'FILE_REPLACED')
        value = stream.read(MAX_INPUT + 1)
        require(stable(os.fstat(stream.fileno())) == stable(before) and stable(path.lstat()) == stable(before), 'FILE_CHANGED')
    require(len(value) <= MAX_INPUT, 'INPUT_TOO_LARGE')
    return value


def fingerprint(path, owners=(0,)):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid in owners,
            'UNSAFE_HASH_INPUT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest = hashlib.sha256()
    with os.fdopen(fd, 'rb') as stream:
        require(stable(os.fstat(stream.fileno())) == stable(before), 'FILE_REPLACED')
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        require(stable(os.fstat(stream.fileno())) == stable(before) and stable(path.lstat()) == stable(before), 'FILE_CHANGED')
    return {'bytes': before.st_size, 'uid': before.st_uid, 'gid': before.st_gid,
            'mode': stat.S_IMODE(before.st_mode), 'device': before.st_dev,
            'inode': before.st_ino, 'sha256': digest.hexdigest()}


def mount_points():
    def unescape(value):
        return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)
    return tuple(Path(unescape(line.split()[4])) for line in Path('/proc/self/mountinfo').read_text().splitlines())


def no_nested_mount(path, mounts=None):
    mounts = mount_points() if mounts is None else mounts
    require(not any(point == path or path in point.parents for point in mounts), 'NESTED_MOUNT_REJECTED')


def tree(path, uid, mounts=None):
    """No secret contents, links, special files or mount traversal in a deletion tree."""
    root = path.lstat()
    no_nested_mount(path, mounts)
    require(stat.S_ISDIR(root.st_mode) and root.st_uid == 0 and not root.st_mode & 0o002,
            'UNSAFE_OWNED_TREE_ROOT')
    result = {}
    for folder, directories, files in os.walk(path, followlinks=False):
        for item in [Path(folder), *[Path(folder) / name for name in directories + files]]:
            info = item.lstat()
            require(info.st_dev == root.st_dev, 'NESTED_MOUNT_REJECTED')
            require(info.st_uid in (0, uid), 'FOREIGN_TREE_OWNER')
            require(not stat.S_ISLNK(info.st_mode), 'TREE_SYMLINK_REJECTED')
            relative = item.relative_to(path).as_posix()
            if stat.S_ISDIR(info.st_mode):
                result[relative] = {'kind': 'directory', 'uid': info.st_uid, 'gid': info.st_gid,
                                    'mode': stat.S_IMODE(info.st_mode), 'device': info.st_dev, 'inode': info.st_ino}
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'TREE_SPECIAL_OR_HARDLINK')
                result[relative] = {'kind': 'file', **fingerprint(item, (0, uid))}
    return result


def validate_inventory(value):
    require(value.get('read_only') is True and value.get('marker_kind') == 'isolated-13-game-mock'
            and value.get('mock_release') == MOCK and value.get('public_current') == CURRENT,
            'INVENTORY_NAMESPACE_MISMATCH')
    require(value['public_last_release'].get('current') == CURRENT
            and value['public_last_release'].get('previous') == PREVIOUS
            and value['public_last_release'].get('health') == 'passed', 'INVENTORY_PUBLIC_STATE_MISMATCH')
    require(type(value.get('uid')) is int and 0 < value['uid'] < 65534, 'INVALID_MOCK_UID')
    require(value['mock_database'].get('environment') == 'sandbox'
            and value['mock_database'].get('pending_rooms') == value['mock_database'].get('pending_cycles') == 0,
            'INVENTORY_UNRESOLVED_OBLIGATIONS')
    for kind, name in (('container', CONTAINER), ('volume', VOLUME), ('network', NETWORK)):
        require(value['docker'][kind]['name'] == name and value['docker'][kind]['owned_label_matches'] is True,
                'INVENTORY_RESOURCE_IDENTITY_MISMATCH')
    require(value['docker']['volume']['consumers'] == [CONTAINER]
            and value['docker']['network']['container_names'] == [CONTAINER]
            and value['docker']['network']['internal'] is True, 'INVENTORY_RESOURCE_NOT_EXCLUSIVE')
    require(value['services']['oasis-production.service']['ActiveState'] == 'inactive',
            'INVENTORY_PRODUCTION_SERVICE_PRESENT')


def validate_capsule(value, inventory_sha, tool_sha, clock=None, *, historical=False):
    require(value.get('schema') == 'android-mock-retirement-check-v1'
            and value.get('read_only') is True and value.get('passed') is True
            and value.get('inventory_sha256') == inventory_sha
            and value.get('tool_sha256') == tool_sha, 'SAFE_CHECK_BINDING_MISMATCH')
    observed = dt.datetime.fromisoformat(value['at']).timestamp()
    age = (time.time() if clock is None else clock) - observed
    require(0 <= age and (historical or age <= 600), 'SAFE_CHECK_EXPIRED_OR_FUTURE')
    require(value.get('database', {}).get('environment') == 'sandbox', 'SAFE_CHECK_DATABASE_ENVIRONMENT')
    pending_free(value['database'], 'SAFE_CHECK_PENDING_BUSINESS')


def resume_origin(check_raw, receipt_raw, inventory_sha):
    """Only these exact, independently read-back v5 bytes authorize recovery.
    The old SQL is historical evidence, never a new post-stop SQL proof.
    """
    require(sha(check_raw) == FAILED_V5_CHECK_SHA and sha(receipt_raw) == FAILED_V5_RECEIPT_SHA,
            'RESUME_ORIGINAL_EXTERNAL_HASH_MISMATCH')
    capsule, receipt = decode(check_raw), decode(receipt_raw)
    require(sha(canonical(capsule)) == FAILED_V5_CHECK_SHA, 'RESUME_ORIGINAL_CHECK_NOT_CANONICAL')
    validate_capsule(capsule, inventory_sha, FAILED_V5_TOOL_SHA, historical=True)
    require(receipt.get('schema') == 'android-mock-retirement-receipt-v1'
            and receipt.get('inventory_sha256') == inventory_sha
            and receipt.get('tool_sha256') == FAILED_V5_TOOL_SHA
            and receipt.get('check_sha256') == FAILED_V5_CHECK_SHA
            and receipt.get('permanent_dedicated_data_deletion_authorized') is True
            and receipt.get('phase') == 'failed_closed' and receipt.get('passed') is False
            and receipt.get('failed_at_phase') == 'before_old_installer_stop'
            and receipt.get('error_code') == 'COMMAND_FAILED_BUSCTL'
            and 'routing' not in receipt, 'RESUME_ORIGINAL_RECEIPT_NOT_SUPPORTED')
    history = receipt.get('history')
    require(isinstance(history, list) and len(history) == 2
            and set(history[0]) == {'phase', 'at'} and history[0]['phase'] == 'before_old_installer_stop'
            and set(history[1]) == {'phase', 'at', 'error_code', 'failed_at_phase', 'passed'}
            and history[1]['phase'] == 'failed_closed' and history[1]['passed'] is False
            and history[1]['failed_at_phase'] == 'before_old_installer_stop'
            and history[1]['error_code'] == 'COMMAND_FAILED_BUSCTL', 'RESUME_ORIGINAL_HISTORY_NOT_SUPPORTED')
    return capsule, receipt


def validate_resume_check(value, inventory_sha, tool_sha, clock=None, *, historical=False):
    require(value.get('schema') == 'android-mock-retirement-resume-check-v1'
            and value.get('read_only') is True and value.get('passed') is True
            and value.get('inventory_sha256') == inventory_sha and value.get('tool_sha256') == tool_sha
            and value.get('original_check_sha256') == FAILED_V5_CHECK_SHA
            and value.get('original_receipt_sha256') == FAILED_V5_RECEIPT_SHA
            and value.get('original_tool_sha256') == FAILED_V5_TOOL_SHA
            and value.get('mock_database_readback') == 'historical-only; fresh SQL required in resume-apply',
            'RESUME_CHECK_BINDING_MISMATCH')
    age = (time.time() if clock is None else clock) - dt.datetime.fromisoformat(value['at']).timestamp()
    require(0 <= age and (historical or age <= 600), 'RESUME_CHECK_EXPIRED_OR_FUTURE')


def v6_origin(check_raw, resume_raw, receipt_raw, v5_receipt_raw, inventory_sha):
    original, old_receipt = resume_origin(check_raw, v5_receipt_raw, inventory_sha)
    require(sha(resume_raw) == FAILED_V6_CHECK_SHA and sha(receipt_raw) == FAILED_V6_RECEIPT_SHA,
            'V6_RECOVERY_ORIGINAL_EXTERNAL_HASH_MISMATCH')
    resume, receipt = decode(resume_raw), decode(receipt_raw)
    require(sha(canonical(resume)) == FAILED_V6_CHECK_SHA, 'V6_RECOVERY_CHECK_NOT_CANONICAL')
    validate_resume_check(resume, inventory_sha, FAILED_V6_TOOL_SHA, historical=True)
    require(receipt.get('tool_sha256') == FAILED_V5_TOOL_SHA and receipt.get('check_sha256') == FAILED_V5_CHECK_SHA
            and receipt.get('schema') == old_receipt['schema'] and receipt.get('inventory_sha256') == inventory_sha
            and receipt.get('permanent_dedicated_data_deletion_authorized') is True
            and receipt.get('phase') == 'failed_closed' and receipt.get('passed') is False
            and receipt.get('failed_at_phase') == 'tombstone_verified_before_data_deletion'
            and receipt.get('error_code') == 'MOCK_PROXY_CONFIG_UNSAFE'
            and receipt.get('routing') == {'tls_sha256': V6_TLS_SHA, 'proxy_sha256': V6_PROXY_SHA},
            'V6_RECOVERY_RECEIPT_NOT_SUPPORTED')
    history = receipt.get('history')
    phases = ['before_old_installer_stop', 'failed_closed', 'v6_resume_after_verified_old_installer_stop',
              'post_stop_business_readback', 'tombstone_verified_before_data_deletion', 'failed_closed']
    require(isinstance(history, list) and len(history) == 6
            and [row.get('phase') for row in history] == phases and history[:2] == old_receipt['history'],
            'V6_RECOVERY_HISTORY_NOT_SUPPORTED')
    proof = {'tool_sha256': FAILED_V6_TOOL_SHA, 'check_sha256': FAILED_V6_CHECK_SHA,
             'original_receipt_sha256': FAILED_V5_RECEIPT_SHA, 'original_check_sha256': FAILED_V5_CHECK_SHA,
             'original_tool_sha256': FAILED_V5_TOOL_SHA, 'old_installer_stop_repeated': False}
    require(receipt.get('resume') == proof and history[2].get('resume') == proof
            and history[4].get('routing') == receipt['routing']
            and history[5].get('error_code') == 'MOCK_PROXY_CONFIG_UNSAFE'
            and history[5].get('failed_at_phase') == 'tombstone_verified_before_data_deletion'
            and history[5].get('passed') is False, 'V6_RECOVERY_CHAIN_NOT_SUPPORTED')
    database = history[3].get('database', {})
    require(database == receipt.get('database') and database.get('environment') == 'sandbox'
            and database.get('apps') == original['database']['apps']
            and database.get('sessions') == original['database']['sessions'], 'V6_RECOVERY_SQL_HISTORY_MISMATCH')
    pending_free(database, 'V6_RECOVERY_HISTORICAL_PENDING_BUSINESS')
    return original, resume, receipt


def validate_v6_recovery_check(value, inventory_sha, tool_sha, clock=None):
    require(value.get('schema') == 'android-mock-retirement-v6-recovery-check-v1'
            and value.get('read_only') is True and value.get('passed') is True
            and value.get('inventory_sha256') == inventory_sha and value.get('tool_sha256') == tool_sha
            and value.get('original_v5_check_sha256') == FAILED_V5_CHECK_SHA
            and value.get('original_v5_receipt_sha256') == FAILED_V5_RECEIPT_SHA
            and value.get('original_v6_check_sha256') == FAILED_V6_CHECK_SHA
            and value.get('original_v6_receipt_sha256') == FAILED_V6_RECEIPT_SHA
            and value.get('original_v6_tool_sha256') == FAILED_V6_TOOL_SHA
            and value.get('mock_database_readback') == 'historical-only; fresh SQL required in recover-v6-apply',
            'V6_RECOVERY_CHECK_BINDING_MISMATCH')
    age = (time.time() if clock is None else clock) - dt.datetime.fromisoformat(value['at']).timestamp()
    require(0 <= age <= 600, 'V6_RECOVERY_CHECK_EXPIRED_OR_FUTURE')


class Runtime:
    def __init__(self, mock_container_id=None):
        self.mock_container_id = mock_container_id
        self.public_container_id = None
        self.proxy_container_id = None

    def run(self, args, *, check=True, input=None, timeout=60):
        args = list(args)
        if args[:2] == ['docker', 'exec'] and args[2] == 'proxy-nginx':
            require(self.proxy_container_id and re.fullmatch(r'[a-f0-9]{64}', self.proxy_container_id), 'PROXY_CONTAINER_ID_NOT_BOUND')
            args[2] = self.proxy_container_id
        if args[:2] == ['docker', 'cp'] and args[3].startswith('proxy-nginx:'):
            require(self.proxy_container_id and re.fullmatch(r'[a-f0-9]{64}', self.proxy_container_id), 'PROXY_CONTAINER_ID_NOT_BOUND')
            args[3] = self.proxy_container_id + ':' + args[3].split(':', 1)[1]
        # Child commands never inherit proxy/TLS bypass/Node injection variables.
        environment = {key: value for key, value in os.environ.items()
                       if key.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')
                       and key not in ('NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PYTHONPATH', 'PYTHONHOME',
                                       'DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_SESSION_BUS_ADDRESS')}
        environment['PATH'] = '/usr/sbin:/usr/bin:/sbin:/bin'
        environment['LC_ALL'] = 'C'
        result = subprocess.run(args, capture_output=True, text=True, input=input, timeout=timeout, env=environment)
        require(not check or result.returncode == 0, 'COMMAND_FAILED_' + Path(args[0]).name.upper())
        return result

    def output(self, args, **kwargs):
        return self.run(args, **kwargs).stdout.strip()

    def inspect(self, kind, name, fields, absent=False):
        expression = '{' + ','.join(json.dumps(key) + ':{{json .' + path + '}}' for key, path in fields.items()) + '}'
        result = self.run(['docker', kind, 'inspect', '--format', expression, name], check=False)
        if result.returncode:
            # Distinguish an absent exact name from a Docker/permission failure.
            listing = self.output(['docker', kind, 'ls', '-q' if kind != 'container' else '-aq',
                                   '--filter', 'name=^' + name + '$'])
            require(absent and not listing, 'OWNED_RESOURCE_UNAVAILABLE')
            return None
        return decode(result.stdout)

    def service(self, unit):
        result = dict(row.split('=', 1) for row in self.output(
            ['systemctl', 'show', unit, '--property=' + PROPERTIES]).splitlines() if '=' in row)
        for key in ('Requires', 'Wants'):
            if key in result:
                result[key] = ' '.join(sorted(result[key].split()))
        return result

    def loaded_stop(self, unit):
        # RefUnit loads metadata without starting a job and holds it for this
        # sender. Separate busctl processes lose the reference when they exit,
        # so an inactive disabled unit can vanish between GetUnit and Get.
        import dbus
        expected_path = dbus_unit_path(unit)
        interface = 'Service' if unit.endswith('.service') else 'Socket' if unit.endswith('.socket') else None
        commands = ('ExecStop', 'ExecStopPost') if interface == 'Service' else \
                   ('ExecStopPre', 'ExecStopPost') if interface == 'Socket' else ()
        # SystemBus consults these environment variables. Never connect a
        # privileged controller to a caller-supplied replacement system bus.
        saved = {name: os.environ.pop(name) for name in ('DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_SESSION_BUS_ADDRESS')
                 if name in os.environ}
        bus, manager, referenced = None, None, False
        try:
            bus = dbus.SystemBus(private=True)
            manager = dbus.Interface(bus.get_object('org.freedesktop.systemd1', '/org/freedesktop/systemd1'),
                                     'org.freedesktop.systemd1.Manager')
            manager.RefUnit(unit, timeout=30)
            referenced = True
            found = manager.GetUnit(unit, timeout=30)
            require(isinstance(found, dbus.ObjectPath) and str(found) == expected_path, 'DBUS_UNIT_IDENTITY_MISMATCH')
            properties = dbus.Interface(bus.get_object('org.freedesktop.systemd1', found),
                                        'org.freedesktop.DBus.Properties')
            reload = properties.Get('org.freedesktop.systemd1.Unit', 'NeedDaemonReload', timeout=30)
            require(isinstance(reload, dbus.Boolean), 'DBUS_RELOAD_PROPERTY_TYPE_UNKNOWN')
            values = {'NeedDaemonReload': 'yes' if bool(reload) else 'no'}
            for name in commands:
                array = properties.Get('org.freedesktop.systemd1.' + interface, name, timeout=30)
                require(isinstance(array, dbus.Array) and str(array.signature) == '(sasbttttuii)',
                        'LOADED_COMMAND_DBUS_SHAPE_UNKNOWN')
                rows = []
                expected_types = (dbus.String, dbus.Array, dbus.Boolean, dbus.UInt64, dbus.UInt64,
                                  dbus.UInt64, dbus.UInt64, dbus.UInt32, dbus.Int32, dbus.Int32)
                for row in array:
                    require(isinstance(row, dbus.Struct) and len(row) == 10
                            and all(isinstance(value, kind) for value, kind in zip(row, expected_types))
                            and str(row[1].signature) == 's' and all(isinstance(arg, dbus.String) for arg in row[1]),
                            'LOADED_COMMAND_DBUS_ROW_UNKNOWN')
                    rows.append([str(row[0]), [str(arg) for arg in row[1]], bool(row[2]), *[int(item) for item in row[3:]]])
                values[name] = {'type': 'a(sasbttttuii)', 'data': rows}
            return loaded_stop_guard(unit, values)
        finally:
            try:
                if referenced:
                    manager.UnrefUnit(unit, timeout=30)
            finally:
                try:
                    if bus is not None:
                        bus.close()
                finally:
                    os.environ.update(saved)

    def process(self, pid):
        root = Path('/proc') / str(pid)
        require(root.is_dir(), 'PINNED_PROCESS_MISSING')
        return {'pid': pid, 'uid': root.stat().st_uid, 'cwd': os.readlink(root / 'cwd'),
                'exe': os.readlink(root / 'exe'), 'cmdline_sha256': sha((root / 'cmdline').read_bytes()),
                'start_ticks': (root / 'stat').read_text().rsplit(')', 1)[1].split()[19]}

    def uid_processes(self, uid):
        return sorted(int(path.name) for path in Path('/proc').iterdir()
                      if path.name.isdecimal() and path.stat().st_uid == uid)

    def nginx_fingerprints(self, proxy=False):
        command = ['docker', 'exec', 'proxy-nginx', 'nginx', '-T'] if proxy else ['nginx', '-T']
        dump = self.output(command)
        found = re.findall(r'^# configuration file (.+?):\n(.*?)(?=^# configuration file |\Z)', dump, re.M | re.S)
        require(found, 'NGINX_CONFIG_INVENTORY_EMPTY')
        rows = {}
        for name, content in found:
            if name in (str(TLS), str(BRIDGE)) or name.startswith(str(PRIVATE) + '/'):
                continue
            require(str(PRIVATE) not in content and HOST not in content
                    and 'oasis-android-mock' not in content, 'MOCK_REFERENCED_BY_SHARED_NGINX_CONFIG')
            rows[name] = sha(content.strip().encode())
        return rows

    def http(self, url, expected, *, health=False):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                            urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        try:
            response = opener.open(url, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            require(response.status == expected and response.geturl() == url, 'HTTP_STATUS_OR_REDIRECT_MISMATCH')
            data = response.read(8193)
            require(len(data) <= 8192, 'PROBE_TOO_LARGE')
            if health:
                document = decode(data)
                require(document.get('status') == 'ok' and document.get('environment') == 'sandbox', 'PUBLIC_HEALTH_FAILED')
            return {'status': response.status, 'strict_tls': url.startswith('https://'), 'sha256': sha(data)}

    def database(self, *, public=False):
        container, user, database = (self.public_container_id, 'oasis', 'oasis_platform') if public else (self.mock_container_id, 'postgres', 'oasis_android_mock')
        require(container and re.fullmatch(r'[a-f0-9]{64}', container), 'DATABASE_CONTAINER_ID_NOT_BOUND')
        command = ['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-At']
        schema_query = "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('gp_transfer_bindings','gp_transfer_accounts','gp_transfers','gp_transfer_outbox','wallet_transfer_clearing');"
        schema = self.output(command, input=schema_query)
        require(schema in ('0', '5'), 'TRANSFER_SCHEMA_INCOMPLETE')
        fields = "'pending_transfers',(SELECT count(*) FROM gp_transfers WHERE state='PENDING'),'pending_transfer_inbound_minor',(SELECT coalesce(sum(amount_minor),0) FROM gp_transfers WHERE state='PENDING' AND direction='IN'),'pending_transfer_outbound_minor',(SELECT coalesce(sum(amount_minor),0) FROM gp_transfers WHERE state='PENDING' AND direction='OUT'),'transfer_schema','present'" if schema == '5' else "'pending_transfers',0,'pending_transfer_inbound_minor',0,'pending_transfer_outbound_minor',0,'pending_transfer_schema_stray',(SELECT count(*) FROM wallet_ledger WHERE account LIKE 'transfer:%' OR meta->>'kind' LIKE 'transfer_%'),'transfer_schema','absent'"
        result = self.output(command, input=SQL.replace('__TRANSFER_FIELDS__', fields))
        document = decode(result)
        require(document.get('environment') == 'sandbox', 'MOCK_DATABASE_NOT_SANDBOX')
        return document


class Retirer:
    def __init__(self, inventory, inventory_sha, tool_sha, runtime=None):
        validate_inventory(inventory)
        self.inventory, self.inventory_sha, self.tool_sha = inventory, inventory_sha, tool_sha
        self.runtime = runtime or Runtime(inventory['docker']['container']['id'])
        self.uid = inventory['uid']
        self.state = None
        self.capsule = None
        self.receipt = None

    def marker(self):
        require(fingerprint(PRIVATE / 'installation.json')['sha256'] == self.inventory['marker_sha256'],
                'MOCK_MARKER_HASH_CHANGED')
        state = decode(body(PRIVATE / 'installation.json'))
        require(state.get('kind') == 'isolated-13-game-mock' and state.get('host') == HOST
                and state.get('release') == MOCK and state.get('uid') == self.uid
                and sha(state.get('id', '').encode()) == self.inventory['ownership_id_sha256'],
                'MOCK_OWNERSHIP_CHANGED')
        account = pwd.getpwnam(USER)
        require(account.pw_uid == self.uid and account.pw_dir == '/nonexistent'
                and account.pw_shell == '/usr/sbin/nologin', 'MOCK_ACCOUNT_CHANGED')
        require([item.pw_name for item in pwd.getpwall() if item.pw_uid == self.uid] == [USER],
                'MOCK_UID_SHARED_WITH_FOREIGN_ACCOUNT')
        group = grp.getgrnam(USER)
        require(group.gr_gid == account.pw_gid and not group.gr_mem
                and not any(item.pw_gid == group.gr_gid and item.pw_name != USER for item in pwd.getpwall()),
                'MOCK_GROUP_SHARED_WITH_FOREIGN_ACCOUNT')
        self.state = state
        return state

    def resources(self, *, container_present=True, volume_present=True, network_present=True):
        r = self.runtime
        container = r.inspect('container', CONTAINER, {'id': 'Id', 'labels': 'Config.Labels', 'running': 'State.Running',
                              'image': 'Image', 'mounts': 'Mounts', 'networks': 'NetworkSettings.Networks'}, absent=not container_present)
        volume = r.inspect('volume', VOLUME, {'name': 'Name', 'labels': 'Labels', 'mountpoint': 'Mountpoint',
                                            'created_at': 'CreatedAt', 'driver': 'Driver', 'options': 'Options', 'scope': 'Scope'}, absent=not volume_present)
        network = r.inspect('network', NETWORK, {'id': 'Id', 'labels': 'Labels', 'internal': 'Internal', 'containers': 'Containers'}, absent=not network_present)
        found = {'container': container, 'volume': volume, 'network': network}
        for kind, resource, present in (('container', container, container_present), ('volume', volume, volume_present), ('network', network, network_present)):
            require(bool(resource) == present, 'RESOURCE_PRESENCE_MISMATCH')
            if resource:
                require(resource['labels'].get(LABEL) == self.state['id']
                        and sha(json.dumps(resource['labels'], sort_keys=True).encode()) == self.inventory['docker'][kind]['labels_sha256'],
                        'RESOURCE_OWNERSHIP_CHANGED')
        if container:
            require(container['id'] == self.inventory['docker']['container']['id']
                    and container['image'] == self.inventory['docker']['container']['image'] == self.state['postgres_image'],
                    'CONTAINER_ID_OR_IMAGE_CHANGED')
            selected = [{k: row[k] for k in ('Type', 'Name', 'Source', 'Destination') if k in row} for row in container['mounts']]
            require(selected == self.inventory['docker']['container']['mounts'] and set(container['networks']) == {NETWORK},
                    'CONTAINER_MOUNT_OR_NETWORK_CHANGED')
        if volume:
            require(volume['name'] == VOLUME and volume['mountpoint'] == self.inventory['docker']['volume']['mountpoint'],
                    'VOLUME_ID_CHANGED')
            require(volume['driver'] == 'local' and not volume['options'] and volume['scope'] == 'local'
                    and isinstance(volume['created_at'], str), 'VOLUME_DRIVER_OR_OPTIONS_UNEXPECTED')
            location = Path(volume['mountpoint']).lstat()
            require(stat.S_ISDIR(location.st_mode), 'VOLUME_MOUNTPOINT_UNSAFE')
            volume['directory_device'], volume['directory_inode'] = location.st_dev, location.st_ino
            consumers = r.output(['docker', 'ps', '-a', '--filter', 'volume=' + VOLUME, '--format', '{{.Names}}']).splitlines()
            require(consumers == ([CONTAINER] if container else []), 'FOREIGN_VOLUME_CONSUMER')
        if network:
            require(network['id'] == self.inventory['docker']['network']['id'] and network['internal'] is True,
                    'NETWORK_ID_OR_ISOLATION_CHANGED')
            names = sorted(row['Name'] for row in (network['containers'] or {}).values())
            require(names == ([CONTAINER] if container and container['running'] else []), 'FOREIGN_NETWORK_CONSUMER')
        # Never put unredacted ownership labels in evidence.
        for resource in found.values():
            if resource:
                resource['labels_sha256'] = sha(json.dumps(resource.pop('labels'), sort_keys=True).encode())
        return found

    def public_guard(self, expected=None, *, probe=True):
        require((BASE / 'current').is_symlink() and str((BASE / 'current').resolve(strict=True)) == CURRENT,
                'PUBLIC_CURRENT_CHANGED')
        last = decode(body(BASE / 'private/last-release.json'))
        require(all(last.get(key) == self.inventory['public_last_release'][key]
                    for key in ('current', 'previous', 'health', 'activated_at')), 'PUBLIC_LAST_RELEASE_CHANGED')
        pins = {name: fingerprint(BASE / name)['sha256'] for name in self.inventory['public_pins']}
        require(pins == self.inventory['public_pins'], 'PUBLIC_CONFIG_OR_MANIFEST_CHANGED')
        require(fingerprint(Path('/etc/nginx/conf.d/oasis.conf'))['sha256'] ==
                self.inventory['mock_files']['/etc/nginx/conf.d/oasis.conf']['sha256'], 'PUBLIC_VHOST_CHANGED')
        services = {unit: self.runtime.service(unit) for unit in PUBLIC_UNITS}
        for unit in PUBLIC_UNITS:
            for key in ('MainPID', 'ActiveState', 'FragmentPath'):
                require(services[unit].get(key) == self.inventory['services'][unit].get(key), 'PUBLIC_SERVICE_CHANGED')
        processes = {unit: self.runtime.process(int(services[unit]['MainPID']))
                     for unit in PUBLIC_UNITS if int(services[unit].get('MainPID') or 0)}
        for unit in ('oasis-api.service', 'oasis-demo.service'):
            require(processes[unit]['cwd'] == CURRENT + '/platform' and processes[unit]['uid'] != self.uid,
                    'PUBLIC_PROCESS_IDENTITY_MISMATCH')
        shared = {}
        for name in ('oasis-postgres', 'proxy-nginx'):
            item = self.runtime.inspect('container', name, {'id': 'Id', 'image': 'Image', 'running': 'State.Running',
                                       'mounts': 'Mounts', 'networks': 'NetworkSettings.Networks'})
            require(item['running'] is True and all(row.get('Name') != VOLUME for row in item['mounts'])
                    and NETWORK not in item['networks'], 'SHARED_CONTAINER_TOUCHES_MOCK')
            shared[name] = item
        if self.runtime.public_container_id:
            require(self.runtime.public_container_id == shared['oasis-postgres']['id'], 'SHARED_PUBLIC_DATABASE_ID_CHANGED')
        if self.runtime.proxy_container_id:
            require(self.runtime.proxy_container_id == shared['proxy-nginx']['id'], 'SHARED_PROXY_ID_CHANGED')
        self.runtime.proxy_container_id = shared['proxy-nginx']['id']
        result = {'pins': pins, 'services': services, 'processes': processes,
                  'nginx_host': self.runtime.nginx_fingerprints(),
                  'nginx_proxy': self.runtime.nginx_fingerprints(proxy=True)}
        result['shared_containers'] = shared
        self.runtime.public_container_id = shared['oasis-postgres']['id']
        business = self.runtime.database(public=True)
        result['public_pending_obligations'] = {key: value for key, value in business.items()
                                               if key.startswith('pending_') or key in ('non_sandbox_apps', 'transfer_schema')}
        if expected:
            require(result == expected, 'PUBLIC_FRESH_GUARD_CHANGED')
        if probe:
            self.runtime.http(PUBLIC + '/health', 200, health=True)
            self.runtime.http('http://127.0.0.1:18881/health/ready', 200, health=True)
        return result

    def files(self, *, include_routing=True, _exact_v6_mode_recovery=False):
        result = {'private': tree(PRIVATE, self.uid), 'webroot': tree(WEBROOT, self.uid)}
        require(result['private']['.']['mode'] == 0o750, 'PRIVATE_ROOT_MODE_CHANGED')
        for name, pinned in self.inventory['mock_files'].items():
            if name in (str(TLS), str(BRIDGE), '/etc/nginx/conf.d/oasis.conf', 'installation.json'):
                continue
            require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'INVENTORY_PRIVATE_PATH_ESCAPE')
            require(result['private'][name]['sha256'] == pinned['sha256'], 'MOCK_SECRET_HASH_CHANGED')
        unit_paths = [SYSTEMD / name for name in UNITS]
        unit_paths.append(SYSTEMD / 'oasis-android-mock-api.service.d/10-database-proxy.conf')
        result['units'] = {str(path): fingerprint(path) for path in unit_paths}
        expected_units = self.unit_templates()
        require(set(expected_units) == set(result['units']), 'OWNED_UNIT_TEMPLATE_SET_MISMATCH')
        for path_text, content in expected_units.items():
            require(body(Path(path_text)) == content, 'OWNED_UNIT_NOT_TRUSTED_TEMPLATE')
        result['loaded_unit_stop'] = {}
        for unit in UNITS:
            info = self.runtime.service(unit)
            require(info['FragmentPath'] == str(SYSTEMD / unit), 'MOCK_UNIT_FRAGMENT_CHANGED')
            actual_dropins = self.runtime.output(['systemctl', 'show', unit, '--property=DropInPaths', '--value']).split()
            expected_dropins = [str(unit_paths[-1])] if unit == 'oasis-android-mock-api.service' else []
            require(actual_dropins == expected_dropins, 'UNKNOWN_MOCK_UNIT_DROPIN')
            result['loaded_unit_stop'][unit] = self.runtime.loaded_stop(unit)
        dropin = unit_paths[-1].parent
        require(dropin.is_dir() and not dropin.is_symlink() and sorted(p.name for p in dropin.iterdir()) == ['10-database-proxy.conf'],
                'UNKNOWN_MOCK_DROPIN')
        if include_routing:
            result['routing'] = {str(path): fingerprint(path) for path in (TLS, BRIDGE)}
            for name, pinned in result['routing'].items():
                require(pinned['sha256'] == self.inventory['mock_files'][name]['sha256'], 'MOCK_ROUTING_DRIFTED_FROM_INVENTORY')
            result['proxy_routing_sha256'] = sha(self.runtime.output(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF]).encode())
            expected_proxy = f'''server {{
 listen 80;
 server_name {HOST};
 location ^~ /.well-known/acme-challenge/ {{
  proxy_pass http://172.17.0.1:18884;
  proxy_set_header Host $host;
 }}
 location / {{ return 301 https://{HOST}$request_uri; }}
}}
'''
            require(result['proxy_routing_sha256'] == sha(expected_proxy.strip().encode()), 'MOCK_PROXY_ROUTING_NOT_ORIGINAL_TEMPLATE')
        if _exact_v6_mode_recovery:
            require(include_routing is False, 'V6_RECOVERY_CANNOT_ADOPT_ORIGINAL_ROUTING')
            self.v6_mode_guard()
        else:
            self.proxy_file_guard()
        result['renewal'] = fingerprint(RENEWAL)
        # Leaf symlinks are the installer's explicit Certbot contract; never walk
        # their directory recursively or remove the shared ACME tree.
        leaves = {}
        for name in ('fullchain.pem', 'privkey.pem'):
            link = CERT / name
            require(link.is_symlink(), 'CERTIFICATE_LINK_NOT_BOUND')
            target = link.resolve(strict=True)
            require(target.parent == BASE / 'acme/config/archive/oasis-android-mock'
                    and re.fullmatch(r'(fullchain|privkey)[1-9][0-9]*\.pem', target.name), 'CERTIFICATE_TARGET_OUTSIDE_MOCK')
            leaves[name] = {'link': os.readlink(link), 'target': str(target), **fingerprint(target)}
        result['tls_leaf'] = leaves
        self.runtime.run(['openssl', 'x509', '-in', str(CERT / 'fullchain.pem'), '-noout', '-checkend', '3600'])
        # No other local service or Nginx configuration may own this namespace.
        for path in SYSTEMD.rglob('*'):
            if path.is_symlink() or not path.is_file() or path.suffix not in ('.service', '.socket', '.timer', '.conf'):
                continue
            text = body(path).decode()
            if any(value in text for value in (str(PRIVATE), 'User=' + USER, CONTAINER,
                                               str(BASE / 'android-mock-current'), 'oasis-android-mock-')):
                require(str(path) in result['units'], 'FOREIGN_UNIT_NAMESPACE_CONSUMER')
        return result

    def unit_templates(self):
        """Replay only two hash-verified generator definitions, with writes
        replaced by in-memory collectors. No installer main/provision/guard or
        top-level module code executes; no env or database secret is read.
        """
        release = Path(MOCK)
        manifest_raw = body(release / 'RELEASE-MANIFEST.json')
        require(sha(manifest_raw) == self.state['manifest_sha256'], 'MOCK_MANIFEST_CHANGED')
        manifest = decode(manifest_raw); entries = manifest.get('files', manifest)
        source = release / 'platform/deploy/mock-sandbox/install.py'
        for name in ('install.py', 'mock-api.service.example', 'mock-demo.service.example'):
            relative = 'platform/deploy/mock-sandbox/' + name
            require(fingerprint(release / relative)['sha256'] == entries.get(relative), 'UNIT_GENERATOR_SOURCE_NOT_MANIFEST_BOUND')
        parsed = ast.parse(body(source), filename=str(source))
        definitions = [node for node in parsed.body if isinstance(node, ast.FunctionDef)
                       and node.name in ('install_units', 'proxy_unit_files')]
        require({node.name for node in definitions} == {'install_units', 'proxy_unit_files'} and len(definitions) == 2,
                'TRUSTED_UNIT_GENERATORS_MISSING')
        captured = {}
        def capture(path, text, mode=0o644):
            require(mode == 0o644 and path.is_relative_to('/etc/systemd/system'), 'UNIT_GENERATOR_SCOPE_ESCAPE')
            local = SYSTEMD / path.relative_to('/etc/systemd/system')
            require(str(local) not in captured, 'DUPLICATE_GENERATED_UNIT')
            captured[str(local)] = text.encode()
        namespace = {'Path': Path, 'ipaddress': ipaddress, 'require': require,
                     'CONTAINER': CONTAINER,
                     'USER': USER, 'PROXY_UNIT': 'oasis-android-mock-db-proxy',
                     'PROXY_BINARY': Path('/usr/lib/systemd/systemd-socket-proxyd'), 'exact_file': capture,
                     'proxy_unit_paths': lambda: (Path('/etc/systemd/system/oasis-android-mock-db-proxy.socket'),
                         Path('/etc/systemd/system/oasis-android-mock-db-proxy.service'),
                         Path('/etc/systemd/system/oasis-android-mock-api.service.d'))}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source), 'exec'), namespace)
        def proxy_capture(state):
            for path, text in namespace['proxy_unit_files'](state).items():
                capture(path, text)
        namespace['install_proxy_units'] = proxy_capture
        namespace['install_units'](release, self.state)
        return captured

    def proxy_file_guard(self):
        metadata = self.runtime.output(['docker', 'exec', 'proxy-nginx', 'stat', '-c', '%u:%a:%h:%F', PROXY_CONF])
        require(metadata == '0:644:1:regular file', 'MOCK_PROXY_CONFIG_UNSAFE')

    def nft_guard(self):
        network = self.runtime.output(['nft', '-j', 'list', 'table', 'inet', 'oasis_android_mock'])
        normalized = []
        for item in decode(network)['nftables']:
            if 'metainfo' not in item:
                normalized.append({kind: {key: val for key, val in value.items() if key != 'handle'} for kind, value in item.items()})
        require(sha(json.dumps(normalized, sort_keys=True).encode()) == self.state.get('network_fingerprint'),
                'OWNED_NFT_TABLE_CHANGED')

    def routing_guard(self):
        require(fingerprint(TLS)['sha256'] == self.receipt['routing']['tls_sha256']
                and not BRIDGE.exists() and not BRIDGE.is_symlink(), 'TOMBSTONE_ROUTING_CHANGED')
        self.proxy_file_guard()
        require(sha(self.runtime.output(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF]).encode()) ==
                self.receipt['routing']['proxy_sha256'], 'TOMBSTONE_PROXY_CHANGED')
        for path in ('/demo/', '/health', '/api/pvp/rooms', '/v1/session'):
            self.runtime.http('https://' + HOST + path, 410)

    def stopped_guard(self):
        for unit in UNITS:
            state = self.runtime.service(unit)
            require(state.get('ActiveState') == 'inactive' and state.get('MainPID', '0') == '0'
                    and state.get('UnitFileState') not in ('enabled', 'enabled-runtime'), 'MOCK_UNIT_NOT_STOPPED_DISABLED')
        require(not self.runtime.uid_processes(self.uid), 'MOCK_UID_HAS_LIVE_PROCESS')
        for port in (18981, 18982, 18983, 18985):
            require(not self.runtime.output(['ss', '-H', '-ltn', 'sport = :' + str(port)]), 'MOCK_LISTENER_REMAINS')

    def check(self):
        require(not RECEIPT.exists() and not RECEIPT.is_symlink(), 'RETIREMENT_ALREADY_STARTED_INSPECT_RECEIPT')
        self.marker()
        self.nft_guard()
        require((BASE / 'android-mock-current').is_symlink()
                and str((BASE / 'android-mock-current').resolve(strict=True)) == MOCK, 'MOCK_RELEASE_PIN_CHANGED')
        manifest = decode(body(Path(MOCK) / 'RELEASE-MANIFEST.json'))
        entries = manifest.get('files', manifest)
        install = Path(MOCK) / 'platform/deploy/mock-sandbox/install.py'
        require(fingerprint(Path(MOCK) / 'RELEASE-MANIFEST.json')['sha256'] == self.state['manifest_sha256']
                and fingerprint(install)['sha256'] == entries.get('platform/deploy/mock-sandbox/install.py'), 'OLD_STOP_TOOL_NOT_VERIFIED')
        resources = self.resources()
        require(resources['container']['running'] is True, 'PRECHECK_DATABASE_NOT_RUNNING')
        database = self.runtime.database()
        pending_free(database, 'FRESH_PENDING_BUSINESS')
        result = {'schema': 'android-mock-retirement-check-v1', 'at': now(), 'read_only': True, 'passed': True,
                  'inventory_sha256': self.inventory_sha, 'tool_sha256': self.tool_sha,
                  'public': self.public_guard(), 'files': self.files(), 'database': database,
                  'resources': resources, 'install_sha256': fingerprint(install)['sha256']}
        # Catch changes during the full check instead of declaring a stale pass.
        self.marker()
        self.nft_guard()
        require(self.files() == result['files'] and self.resources() == result['resources'], 'PRECHECK_SNAPSHOT_CHANGED')
        self.public_guard(result['public'])
        return result

    def fresh(self, *, routing_changed=False, container_present=True, volume_present=True, network_present=True, files=True):
        self.public_guard(self.capsule['public'])
        self.marker()
        self.nft_guard()
        require(str((BASE / 'android-mock-current').resolve(strict=True)) == MOCK, 'MOCK_RELEASE_PIN_CHANGED')
        resources = self.resources(container_present=container_present, volume_present=volume_present, network_present=network_present)
        for kind in ('volume', 'network'):
            if resources[kind]:
                expected = dict(self.capsule['resources'][kind])
                if kind == 'network':
                    expected['containers'] = resources[kind]['containers']
                require(resources[kind] == expected, 'FRESH_RESOURCE_IDENTITY_CHANGED')
        if container_present:
            require(resources['container']['running'] is False, 'MOCK_DATABASE_RUNNING_DURING_DELETION')
        self.stopped_guard()
        if routing_changed:
            self.routing_guard()
        if files:
            current = self.files(include_routing=not routing_changed)
            expected = dict(self.capsule['files'])
            if routing_changed:
                expected.pop('routing'); expected.pop('proxy_routing_sha256')
            require(current == expected, 'OWNED_FILES_CHANGED')
        return resources

    def resume_check(self, original_check_raw, original_receipt_sha):
        require(original_receipt_sha == FAILED_V5_RECEIPT_SHA, 'EXACT_FAILED_V5_RECEIPT_PIN_REQUIRED')
        directory = RECEIPT.lstat()
        require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0
                and stat.S_IMODE(directory.st_mode) == 0o700, 'RESUME_RECEIPT_DIRECTORY_UNSAFE')
        no_nested_mount(RECEIPT)
        require(sorted(path.name for path in RECEIPT.iterdir()) == ['receipt.json'], 'RESUME_RECEIPT_DIRECTORY_NOT_PRISTINE')
        receipt_path = RECEIPT / 'receipt.json'
        receipt_raw = body(receipt_path)
        original, _ = resume_origin(original_check_raw, receipt_raw, self.inventory_sha)
        self.capsule = original
        resources = self.fresh()
        # Old v5 SQL proves the historical pre-stop state only. No Mock database
        # is started or queried here; resume-apply must query it afresh.
        result = {'schema': 'android-mock-retirement-resume-check-v1', 'at': now(), 'read_only': True, 'passed': True,
                  'inventory_sha256': self.inventory_sha, 'tool_sha256': self.tool_sha,
                  'original_tool_sha256': FAILED_V5_TOOL_SHA, 'original_check_sha256': FAILED_V5_CHECK_SHA,
                  'original_receipt_sha256': FAILED_V5_RECEIPT_SHA,
                  'mock_database_readback': 'historical-only; fresh SQL required in resume-apply',
                  'public': self.public_guard(original['public']), 'files': self.files(), 'resources': resources,
                  'stopped_units': {unit: self.runtime.service(unit) for unit in UNITS},
                  'receipt_file': fingerprint(receipt_path),
                  'receipt_directory': {'device': directory.st_dev, 'inode': directory.st_ino,
                                        'uid': directory.st_uid, 'mode': stat.S_IMODE(directory.st_mode)},
                  'install_sha256': original['install_sha256']}
        self.fresh()
        require(self.resources() == result['resources'] and self.files() == result['files']
                and {unit: self.runtime.service(unit) for unit in UNITS} == result['stopped_units']
                and fingerprint(receipt_path) == result['receipt_file']
                and stable(RECEIPT.lstat()) == stable(directory), 'RESUME_CHECK_SNAPSHOT_CHANGED')
        require(body(receipt_path) == receipt_raw, 'RESUME_ORIGINAL_RECEIPT_CHANGED')
        return result

    def resume_apply(self, reviewed, original_check_raw, original_receipt_sha):
        validate_resume_check(reviewed, self.inventory_sha, self.tool_sha)
        # Regenerate every fresh proof from the original pinned evidence. Never
        # turn stopped live state into a new baseline or call normal check().
        current = self.resume_check(original_check_raw, original_receipt_sha)
        require({key: value for key, value in current.items() if key != 'at'} ==
                {key: value for key, value in reviewed.items() if key != 'at'}, 'RESUME_APPLY_FRESH_CHECK_CHANGED')
        receipt_raw = body(RECEIPT / 'receipt.json')
        original, receipt = resume_origin(original_check_raw, receipt_raw, self.inventory_sha)
        self.capsule = original
        # Exclusive immutable metadata-only preservation happens before the
        # original receipt is extended. A second resume cannot pass this gate.
        self.exclusive(RECEIPT / 'failed-v5-receipt.json', receipt_raw)
        require(sha(body(RECEIPT / 'failed-v5-receipt.json')) == FAILED_V5_RECEIPT_SHA,
                'RESUME_ORIGINAL_RECEIPT_BACKUP_CHANGED')
        self.receipt = receipt
        self.event('v6_resume_after_verified_old_installer_stop',
                   resume={'tool_sha256': self.tool_sha, 'check_sha256': sha(canonical(reviewed)),
                           'original_receipt_sha256': FAILED_V5_RECEIPT_SHA,
                           'original_check_sha256': FAILED_V5_CHECK_SHA,
                           'original_tool_sha256': FAILED_V5_TOOL_SHA,
                           'old_installer_stop_repeated': False})
        return self.after_stopped(original)

    def v6_mode_guard(self):
        """The sole read-only exception for the independently pinned v6 defect.
        Normal proxy_file_guard/routing_guard still require 0644. This proves
        the exact authored 410 body and fixed receipt before accepting 0600.
        """
        require(sha(body(RECEIPT / 'receipt.json')) == FAILED_V6_RECEIPT_SHA,
                'V6_MODE_EXCEPTION_REQUIRES_EXACT_FAILED_RECEIPT')
        require(not BRIDGE.exists() and not BRIDGE.is_symlink(), 'V6_RECOVERY_BRIDGE_REAPPEARED')
        host = fingerprint(TLS)
        require(host['sha256'] == V6_TLS_SHA and host['mode'] == 0o600 and host['uid'] == host['gid'] == 0,
                'V6_RECOVERY_HOST_BODY_OR_MODE_CHANGED')
        parent = TLS.parent.lstat()
        no_nested_mount(TLS.parent)
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == parent.st_gid == 0
                and not stat.S_IMODE(parent.st_mode) & 0o022, 'V6_RECOVERY_HOST_PARENT_UNSAFE')
        host_parent = {'uid': parent.st_uid, 'gid': parent.st_gid, 'mode': stat.S_IMODE(parent.st_mode),
                       'device': parent.st_dev, 'inode': parent.st_ino}
        r = self.runtime
        proxy = r.output(['docker', 'exec', 'proxy-nginx', 'stat', '-c', '%u:%g:%a:%h:%F:%d:%i:%s', PROXY_CONF])
        fields = proxy.split(':')
        require(len(fields) == 8 and fields[:5] == ['0', '0', '600', '1', 'regular file']
                and all(value.isdecimal() for value in fields[5:]), 'V6_RECOVERY_PROXY_METADATA_CHANGED')
        proxy_parent = r.output(['docker', 'exec', 'proxy-nginx', 'stat', '-c', '%u:%g:%a:%F:%d:%i', str(Path(PROXY_CONF).parent)])
        fields = proxy_parent.split(':')
        require(len(fields) == 6 and fields[:2] == ['0', '0'] and fields[3] == 'directory'
                and re.fullmatch(r'[0-7]{3,4}', fields[2]) and not int(fields[2], 8) & 0o022
                and all(value.isdecimal() for value in fields[4:]), 'V6_RECOVERY_PROXY_PARENT_UNSAFE')
        digest = r.output(['docker', 'exec', 'proxy-nginx', 'sha256sum', PROXY_CONF]).split()
        require(len(digest) == 2 and digest == [V6_PROXY_RAW_SHA, PROXY_CONF], 'V6_RECOVERY_PROXY_RAW_BODY_CHANGED')
        require(sha(r.output(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF]).encode()) == V6_PROXY_SHA,
                'V6_RECOVERY_PROXY_BODY_CHANGED')
        return {'host': host, 'host_parent': host_parent, 'proxy_metadata': proxy,
                'proxy_parent_metadata': proxy_parent, 'proxy_raw_sha256': V6_PROXY_RAW_SHA}

    def v6_recovery_snapshot(self, original):
        resources = self.fresh(files=False)
        modes = self.v6_mode_guard()
        current = self.files(include_routing=False, _exact_v6_mode_recovery=True)
        expected = dict(original['files']); expected.pop('routing'); expected.pop('proxy_routing_sha256')
        require(current == expected, 'V6_RECOVERY_REMAINING_ORIGINAL_FILES_CHANGED')
        directory = RECEIPT.lstat()
        no_nested_mount(RECEIPT)
        require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and stat.S_IMODE(directory.st_mode) == 0o700,
                'V6_RECOVERY_RECEIPT_DIRECTORY_UNSAFE')
        pins = {'receipt.json': FAILED_V6_RECEIPT_SHA, 'failed-v5-receipt.json': FAILED_V5_RECEIPT_SHA,
                'tls.conf': original['files']['routing'][str(TLS)]['sha256'],
                'bridge.conf': original['files']['routing'][str(BRIDGE)]['sha256'],
                'proxy.conf': original['files']['proxy_routing_sha256'], 'proxy-tombstone.conf': V6_PROXY_RAW_SHA}
        require(sorted(path.name for path in RECEIPT.iterdir()) == sorted(pins), 'V6_RECOVERY_RECEIPT_FILE_SET_CHANGED')
        receipt_files = {name: fingerprint(RECEIPT / name) for name in pins}
        require(all(row['sha256'] == pins[name] and row['mode'] == 0o600 and row['uid'] == row['gid'] == 0
                    for name, row in receipt_files.items()), 'V6_RECOVERY_RECEIPT_FILE_CHANGED')
        for path in ('/demo/', '/health', '/api/pvp/rooms', '/v1/session'):
            self.runtime.http('https://' + HOST + path, 410)
        self.runtime.http('http://' + HOST + '/', 410)
        require(self.v6_mode_guard() == modes, 'V6_RECOVERY_ROUTING_CHANGED_DURING_CHECK')
        return {'public': self.public_guard(original['public']), 'files': current, 'resources': resources,
                'stopped_units': {unit: self.runtime.service(unit) for unit in UNITS},
                'routing_modes': modes, 'receipt_files': receipt_files,
                'receipt_directory': {'device': directory.st_dev, 'inode': directory.st_ino,
                                      'uid': directory.st_uid, 'mode': stat.S_IMODE(directory.st_mode)}}

    def recover_v6_check(self, check_raw, resume_raw, failed_receipt_sha):
        require(failed_receipt_sha == FAILED_V6_RECEIPT_SHA, 'EXACT_FAILED_V6_RECEIPT_PIN_REQUIRED')
        original, _, _ = v6_origin(check_raw, resume_raw, body(RECEIPT / 'receipt.json'),
                                   body(RECEIPT / 'failed-v5-receipt.json'), self.inventory_sha)
        self.capsule = original
        observed = self.v6_recovery_snapshot(original)
        require(self.v6_recovery_snapshot(original) == observed, 'V6_RECOVERY_SNAPSHOT_CHANGED')
        return {'schema': 'android-mock-retirement-v6-recovery-check-v1', 'at': now(), 'read_only': True, 'passed': True,
                'inventory_sha256': self.inventory_sha, 'tool_sha256': self.tool_sha,
                'original_v5_check_sha256': FAILED_V5_CHECK_SHA, 'original_v5_receipt_sha256': FAILED_V5_RECEIPT_SHA,
                'original_v6_check_sha256': FAILED_V6_CHECK_SHA, 'original_v6_receipt_sha256': FAILED_V6_RECEIPT_SHA,
                'original_v6_tool_sha256': FAILED_V6_TOOL_SHA,
                'mock_database_readback': 'historical-only; fresh SQL required in recover-v6-apply', **observed}

    def repair_v6_modes(self, pinned):
        # A host FD binds the actual file, not a possibly substituted pathname.
        require(self.v6_mode_guard() == pinned, 'V6_RECOVERY_MODES_CHANGED_BEFORE_REPAIR')
        before = regular(TLS)
        fd = os.open(TLS, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(stable(os.fstat(fd)) == stable(before) and fingerprint(TLS) == pinned['host'],
                    'V6_RECOVERY_HOST_IDENTITY_CHANGED_BEFORE_REPAIR')
            os.fchmod(fd, 0o644)
            require(fingerprint(TLS) == {**pinned['host'], 'mode': 0o644}, 'V6_RECOVERY_HOST_PERMISSION_READBACK_FAILED')
        finally:
            os.close(fd)
        # The proxy has no host bind mount. Its single inherited FD is checked
        # against path/parent/device/inode/owner/link/body both before and after
        # chmod; no unknown file or symlink can receive the permission repair.
        after = pinned['proxy_metadata'].split(':'); after[2] = '644'
        script = '''set -eu
test "$(stat -c '%u:%g:%a:%F:%d:%i' "$3")" = "$4"
test "$(stat -c '%u:%g:%a:%h:%F:%d:%i:%s' "$1")" = "$5"
exec 3< "$1"
test "$(stat -Lc '%u:%g:%a:%h:%F:%d:%i:%s' /proc/self/fd/3)" = "$5"
digest=$(sha256sum /proc/self/fd/3)
test "${digest%% *}" = "$2"
chmod 644 /proc/self/fd/3
test "$(stat -Lc '%u:%g:%a:%h:%F:%d:%i:%s' /proc/self/fd/3)" = "$6"
test "$(stat -c '%u:%g:%a:%h:%F:%d:%i:%s' "$1")" = "$6"
digest=$(sha256sum /proc/self/fd/3)
test "${digest%% *}" = "$2"
test "$(stat -c '%u:%g:%a:%F:%d:%i' "$3")" = "$4"
'''
        self.runtime.run(['docker', 'exec', 'proxy-nginx', '/bin/sh', '-c', script, 'mock-retirement-fd-mode-repair',
                          PROXY_CONF, V6_PROXY_RAW_SHA, str(Path(PROXY_CONF).parent),
                          pinned['proxy_parent_metadata'], pinned['proxy_metadata'], ':'.join(after)])
        self.proxy_file_guard()
        self.routing_guard()

    def recover_v6_apply(self, reviewed, check_raw, resume_raw, failed_receipt_sha):
        validate_v6_recovery_check(reviewed, self.inventory_sha, self.tool_sha)
        actual = self.recover_v6_check(check_raw, resume_raw, failed_receipt_sha)
        require({key: value for key, value in actual.items() if key != 'at'} ==
                {key: value for key, value in reviewed.items() if key != 'at'}, 'V6_RECOVERY_APPLY_FRESH_CHECK_CHANGED')
        receipt_raw = body(RECEIPT / 'receipt.json')
        original, _, receipt = v6_origin(check_raw, resume_raw, receipt_raw,
                                         body(RECEIPT / 'failed-v5-receipt.json'), self.inventory_sha)
        self.exclusive(RECEIPT / 'failed-v6-receipt.json', receipt_raw)
        require(sha(body(RECEIPT / 'failed-v6-receipt.json')) == FAILED_V6_RECEIPT_SHA, 'V6_RECOVERY_RECEIPT_BACKUP_CHANGED')
        self.capsule, self.receipt = original, receipt
        # Keep the original failed receipt until the 0600 exception no longer
        # applies. Then append our recovery without altering any old history.
        self.repair_v6_modes(reviewed['routing_modes'])
        self.event('v7_authored_410_permissions_repaired',
                   recovery={'tool_sha256': self.tool_sha, 'check_sha256': sha(canonical(reviewed)),
                             'original_v6_tool_sha256': FAILED_V6_TOOL_SHA,
                             'original_v6_check_sha256': FAILED_V6_CHECK_SHA,
                             'original_v6_receipt_sha256': FAILED_V6_RECEIPT_SHA,
                             'old_installer_stop_repeated': False, 'tombstone_repeated': False})
        self.fresh(routing_changed=True)
        self.post_stop_business_readback()
        self.fresh(routing_changed=True)
        return self.after_tombstone(original)

    def event(self, phase, **values):
        self.receipt.setdefault('history', []).append({'phase': phase, 'at': now(), **values})
        self.receipt.update(phase=phase, at=now(), **values)
        temporary = RECEIPT / '.receipt.next'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(self.receipt)); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, RECEIPT / 'receipt.json')

    def exclusive(self, path, value, mode=0o600):
        require(mode in (0o600, 0o644), 'EXCLUSIVE_FILE_MODE_OUTSIDE_SCOPE')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value); stream.flush()
            # os.open's creation mode is filtered by the controller's umask
            # 077. Apply the explicitly authorized mode to this exclusive FD,
            # never chmod a path that could have been substituted by a link.
            os.fchmod(stream.fileno(), mode)
            require(stat.S_IMODE(os.fstat(stream.fileno()).st_mode) == mode, 'EXCLUSIVE_FILE_MODE_NOT_APPLIED')
            os.fsync(stream.fileno())

    def replace(self, path, value, expected_sha):
        require(fingerprint(path)['sha256'] == expected_sha, 'ROUTING_CHANGED_BEFORE_REPLACE')
        temporary = path.with_name('.' + path.name + '.retirement-next')
        self.exclusive(temporary, value, 0o644)
        os.replace(temporary, path)

    def tombstone(self):
        host = f'''# Dedicated retired Mock endpoint: no files, API, DB or upstream.
server {{
 listen 443 ssl http2;
 server_name {HOST};
 ssl_certificate {CERT}/fullchain.pem;
 ssl_certificate_key {CERT}/privkey.pem;
 ssl_protocols TLSv1.2 TLSv1.3;
 server_tokens off;
 default_type text/plain;
 add_header Cache-Control "no-store" always;
 add_header X-Content-Type-Options nosniff always;
 return 410 "Android Mock retired\\n";
}}
'''.encode()
        proxy = f'''# Dedicated retired Mock HTTP endpoint: no ACME/upstream.
server {{
 listen 80;
 server_name {HOST};
 default_type text/plain;
 add_header Cache-Control "no-store" always;
 return 410 "Android Mock retired\\n";
}}
'''.encode()
        originals = {'tls.conf': body(TLS), 'bridge.conf': body(BRIDGE),
                     'proxy.conf': self.runtime.output(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF]).encode()}
        for name, value in originals.items():
            self.exclusive(RECEIPT / name, value)
        self.exclusive(RECEIPT / 'proxy-tombstone.conf', proxy, 0o644)
        written_tls, removed_bridge, written_proxy = False, False, False
        try:
            self.replace(TLS, host, self.capsule['files']['routing'][str(TLS)]['sha256'])
            written_tls = True
            require(fingerprint(BRIDGE) == self.capsule['files']['routing'][str(BRIDGE)], 'BRIDGE_CHANGED')
            BRIDGE.unlink()
            removed_bridge = True
            self.proxy_file_guard()
            require(sha(self.runtime.output(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF]).encode()) ==
                    self.capsule['files']['proxy_routing_sha256'], 'MOCK_PROXY_CHANGED_BEFORE_REPLACE')
            self.runtime.run(['docker', 'cp', str(RECEIPT / 'proxy-tombstone.conf'), 'proxy-nginx:' + PROXY_CONF])
            written_proxy = True
            self.runtime.run(['nginx', '-t'])
            self.runtime.run(['docker', 'exec', 'proxy-nginx', 'nginx', '-t'])
            self.runtime.run(['systemctl', 'reload', 'nginx'])
            self.runtime.run(['docker', 'exec', 'proxy-nginx', 'nginx', '-s', 'reload'])
            self.public_guard(self.capsule['public'])
            proof = {path: self.runtime.http('https://' + HOST + path, 410)
                     for path in ('/demo/', '/health', '/api/pvp/rooms', '/v1/session')}
            self.runtime.http('http://' + HOST + '/', 410)
            self.event('tombstone_verified_before_data_deletion', retired_mock=proof,
                       routing={'tls_sha256': sha(host), 'proxy_sha256': sha(proxy.strip())})
        except Exception:
            # Configuration-only rollback; no restart, database recreation or
            # permission to advance to destructive data deletion on failure.
            # Never overwrite the unknown configuration that triggered refusal.
            if written_tls:
                self.replace(TLS, originals['tls.conf'], sha(host))
            if removed_bridge:
                require(not BRIDGE.exists() and not BRIDGE.is_symlink(), 'UNKNOWN_BRIDGE_BLOCKS_ROLLBACK')
                self.exclusive(BRIDGE, originals['bridge.conf'], 0o644)
            if written_proxy:
                self.proxy_file_guard()
                require(sha(self.runtime.output(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF]).encode()) == sha(proxy.strip()),
                        'UNKNOWN_PROXY_BLOCKS_ROLLBACK')
                self.runtime.run(['docker', 'cp', str(RECEIPT / 'proxy.conf'), 'proxy-nginx:' + PROXY_CONF])
                self.runtime.run(['docker', 'exec', 'proxy-nginx', 'chmod', '644', PROXY_CONF])
            if written_tls or removed_bridge or written_proxy:
                self.runtime.run(['nginx', '-t'])
                self.runtime.run(['docker', 'exec', 'proxy-nginx', 'nginx', '-t'])
                self.runtime.run(['systemctl', 'reload', 'nginx'])
                self.runtime.run(['docker', 'exec', 'proxy-nginx', 'nginx', '-s', 'reload'])
            self.event('failed_routing_restored_data_retained')
            raise

    def delete_tree(self, path, pinned):
        require(path in (PRIVATE, WEBROOT) and tree(path, self.uid) == pinned, 'DELETE_TREE_NOT_EXACTLY_BOUND')
        # The full namespace was checked first; no recursive rm and no following
        # links. Mount/special-file/hash identity is checked again per entry.
        for name in sorted(pinned, key=lambda value: (value.count('/'), value), reverse=True):
            if name == '.':
                continue
            target = path / name
            no_nested_mount(path)
            row = pinned[name]
            info = target.lstat()
            require(info.st_dev == row['device'] and info.st_ino == row['inode'], 'TREE_IDENTITY_CHANGED_BEFORE_UNLINK')
            if row['kind'] == 'directory':
                require(stat.S_ISDIR(info.st_mode), 'TREE_TYPE_CHANGED'); target.rmdir()
            else:
                require({'kind': 'file', **fingerprint(target, (0, self.uid))} == row, 'TREE_FILE_CHANGED_BEFORE_UNLINK')
                target.unlink()
        path.rmdir()

    def apply(self, capsule):
        validate_capsule(capsule, self.inventory_sha, self.tool_sha)
        self.capsule = capsule
        # No mutation until the complete fresh live check equals the externally
        # reviewed capsule. Database counts may grow; all other identities may not.
        current = self.check()
        for key in ('public', 'files', 'resources', 'install_sha256'):
            require(current[key] == capsule[key], 'APPLY_CHECK_CHANGED_' + key.upper())
        pending_free(self.runtime.database(), 'FRESH_PRE_STOP_PENDING_BUSINESS')
        RECEIPT.mkdir(mode=0o700)
        self.receipt = {'schema': 'android-mock-retirement-receipt-v1', 'inventory_sha256': self.inventory_sha,
                        'check_sha256': sha(canonical(capsule)), 'tool_sha256': self.tool_sha,
                        'permanent_dedicated_data_deletion_authorized': True,
                        'immutable_mock_releases_retained': ['20261008-23', '20261008-24'],
                        'retained_immutable_artifacts_and_shared_dependencies': {
                            'mock_release_snapshots': ['20261008-23', '20261008-24'],
                            'shared_static_namespace': 'all 612 assets also referenced by historical public manifests; unchanged',
                            'static_registry_and_head': 'unchanged',
                            'public_historical_apk_downloads': '1.1.1 and 1.2.0 plus pinned metadata; unchanged; not new production APK'},
                        'shared_images_assets_backups_public_data_untouched': True}
        self.event('before_old_installer_stop')
        self.runtime.run(['/usr/bin/python3', MOCK + '/platform/deploy/mock-sandbox/install.py', 'stop'], timeout=150)
        # The old tool owns its existing installer lock. Reacquire it afterwards
        # and hold it through all remaining phases; never bypass a lock failure.
        with locked(Path('/run/lock/oasis-android-mock-install.lock')):
            self.fresh()
            self.event('old_installer_stopped')
            return self.after_stopped(capsule)

    def post_stop_business_readback(self):
        # Closing the stop race: apps/proxy/listeners remain disabled. Only
        # the same isolated PG container is temporarily started READ ONLY.
        try:
            container_id = self.inventory['docker']['container']['id']
            self.runtime.run(['docker', 'start', container_id])
            for attempt in range(30):
                ready = self.runtime.run(['docker', 'exec', container_id, 'pg_isready', '-U', 'postgres', '-d', 'oasis_android_mock'], check=False)
                if ready.returncode == 0:
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError('POST_STOP_DATABASE_CHECK_NOT_READY')
            self.stopped_guard()
            database = self.runtime.database()
            self.event('post_stop_business_readback', database=database)
            pending_free(database, 'POST_STOP_PENDING_BUSINESS_DATA_RETAINED')
        finally:
            self.runtime.run(['docker', 'stop', '--time', '30', self.inventory['docker']['container']['id']], timeout=60)

    def after_stopped(self, capsule):
        self.post_stop_business_readback()
        self.fresh()
        self.tombstone()
        self.fresh(routing_changed=True)
        return self.after_tombstone(capsule)

    def after_tombstone(self, capsule):
        self.event('before_container_removal')
        self.runtime.run(['docker', 'container', 'rm', self.inventory['docker']['container']['id']])
        self.fresh(routing_changed=True, container_present=False)
        self.event('before_irreversible_volume_deletion')
        self.runtime.run(['docker', 'volume', 'rm', VOLUME])
        self.fresh(routing_changed=True, container_present=False, volume_present=False)
        self.event('dedicated_database_volume_deleted')
        self.runtime.run(['docker', 'network', 'rm', self.inventory['docker']['network']['id']])
        self.fresh(routing_changed=True, container_present=False, volume_present=False, network_present=False)
        self.event('before_owned_runtime_deletion')
        for path_text, pinned in capsule['files']['units'].items():
            path = Path(path_text)
            require(fingerprint(path) == pinned, 'UNIT_CHANGED_BEFORE_UNLINK'); path.unlink()
        (SYSTEMD / 'oasis-android-mock-api.service.d').rmdir()
        self.runtime.run(['systemctl', 'daemon-reload'])
        # Retain the dedicated leaf certificate/key for HTTPS 410, disable
        # its renewal configuration. Never touch shared ACME state/accounts.
        require(fingerprint(RENEWAL) == capsule['files']['renewal'], 'RENEWAL_CHANGED_BEFORE_UNLINK'); RENEWAL.unlink()
        # The UID firewall survives installer stop by design. Validate its
        # marker fingerprint before deleting only that exact named table.
        self.nft_guard()
        self.runtime.run(['nft', 'delete', 'table', 'inet', 'oasis_android_mock'])
        self.public_guard(capsule['public'])
        self.stopped_guard()
        self.delete_tree(WEBROOT, capsule['files']['webroot'])
        self.delete_tree(PRIVATE, capsule['files']['private'])
        pin = BASE / 'android-mock-current'
        require(pin.is_symlink() and str(pin.resolve(strict=True)) == MOCK, 'MOCK_PIN_CHANGED_BEFORE_UNLINK'); pin.unlink()
        require(not self.runtime.uid_processes(self.uid), 'MOCK_UID_HAS_LIVE_PROCESS')
        require(pwd.getpwnam(USER).pw_uid == self.uid, 'MOCK_UID_CHANGED_BEFORE_USERDEL')
        self.runtime.run(['userdel', USER])  # no -r; never delete a home directory
        # userdel removes the same-name user-private group only when unused.
        group = self.runtime.run(['getent', 'group', USER], check=False)
        if group.returncode == 0:
            fields = group.stdout.strip().split(':')
            require(len(fields) == 4 and fields[3] == '', 'MOCK_GROUP_HAS_FOREIGN_MEMBER')
            self.runtime.run(['groupdel', USER])
        self.public_guard(capsule['public'])
        self.resources(container_present=False, volume_present=False, network_present=False)
        for path in (PRIVATE, WEBROOT, pin, RENEWAL, BRIDGE):
            require(not path.exists() and not path.is_symlink(), 'DELETED_MOCK_PATH_REMAINS')
        self.stopped_guard()
        require(self.runtime.run(['getent', 'passwd', USER], check=False).returncode != 0, 'MOCK_ACCOUNT_REMAINS')
        require(fingerprint(TLS)['sha256'] == self.receipt['routing']['tls_sha256'], 'TOMBSTONE_CHANGED')
        final = {path: self.runtime.http('https://' + HOST + path, 410)
                 for path in ('/demo/', '/health', '/api/pvp/rooms', '/v1/session')}
        self.event('complete', passed=True, retired_mock=final, dedicated_database_volume_deleted=True,
                   dedicated_runtime_and_test_backups_deleted=True, dedicated_uid_deleted=True,
                   tls_leaf_retained_for_410=True)
        return self.receipt


@contextmanager
def locked(path):
    before = regular(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stable(os.fstat(fd)) == stable(before), 'LOCK_REPLACED')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(path.lstat().st_ino == before.st_ino, 'LOCK_REPLACED')
        yield
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('check', 'apply', 'resume-check', 'resume-apply',
                                       'recover-v6-check', 'recover-v6-apply'), nargs='?', default='check')
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--inventory-sha256', required=True)
    parser.add_argument('--safecheck', type=Path)
    parser.add_argument('--safecheck-sha256')
    parser.add_argument('--original-v5-safecheck', type=Path)
    parser.add_argument('--original-v5-safecheck-sha256')
    parser.add_argument('--failed-v5-receipt-sha256')
    parser.add_argument('--original-v6-safecheck', type=Path)
    parser.add_argument('--original-v6-safecheck-sha256')
    parser.add_argument('--failed-v6-receipt-sha256')
    parser.add_argument('--delete-dedicated-mock-data', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    raw = body(args.inventory)
    require(sha(raw) == args.inventory_sha256 == INVENTORY_SHA, 'EXTERNALLY_PINNED_INVENTORY_REQUIRED')
    tool_sha = fingerprint(Path(__file__).resolve())['sha256']
    retirer = Retirer(decode(raw), sha(raw), tool_sha)
    resuming = args.mode.startswith('resume-')
    recovering_v6 = args.mode.startswith('recover-v6-')
    original_check_raw = None
    original_resume_raw = None
    if resuming or recovering_v6:
        require(args.original_v5_safecheck and args.original_v5_safecheck_sha256 == FAILED_V5_CHECK_SHA
                and args.failed_v5_receipt_sha256 == FAILED_V5_RECEIPT_SHA, 'EXACT_V5_RESUME_ORIGIN_REQUIRED')
        original_check_raw = body(args.original_v5_safecheck)
        require(sha(original_check_raw) == args.original_v5_safecheck_sha256, 'RESUME_ORIGINAL_CHECK_EXTERNAL_HASH_MISMATCH')
    else:
        require(not args.original_v5_safecheck and not args.original_v5_safecheck_sha256
                and not args.failed_v5_receipt_sha256, 'NORMAL_MODE_CANNOT_RESUME')
    if recovering_v6:
        require(args.original_v6_safecheck and args.original_v6_safecheck_sha256 == FAILED_V6_CHECK_SHA
                and args.failed_v6_receipt_sha256 == FAILED_V6_RECEIPT_SHA, 'EXACT_V6_RECOVERY_ORIGIN_REQUIRED')
        original_resume_raw = body(args.original_v6_safecheck)
        require(sha(original_resume_raw) == FAILED_V6_CHECK_SHA, 'V6_RECOVERY_CHECK_EXTERNAL_HASH_MISMATCH')
    else:
        require(not args.original_v6_safecheck and not args.original_v6_safecheck_sha256
                and not args.failed_v6_receipt_sha256, 'OTHER_MODES_CANNOT_RECOVER_V6')
    if args.mode == 'check':
        require(not args.safecheck and not args.safecheck_sha256 and not args.delete_dedicated_mock_data, 'CHECK_CANNOT_BE_ARMED')
        print(canonical(retirer.check()).decode(), end='')
        return
    if args.mode == 'resume-check':
        require(not args.safecheck and not args.safecheck_sha256 and not args.delete_dedicated_mock_data,
                'CHECK_CANNOT_BE_ARMED')
        print(canonical(retirer.resume_check(original_check_raw, args.failed_v5_receipt_sha256)).decode(), end='')
        return
    if args.mode == 'recover-v6-check':
        require(not args.safecheck and not args.safecheck_sha256 and not args.delete_dedicated_mock_data, 'CHECK_CANNOT_BE_ARMED')
        print(canonical(retirer.recover_v6_check(original_check_raw, original_resume_raw, args.failed_v6_receipt_sha256)).decode(), end='')
        return
    require(args.delete_dedicated_mock_data and args.safecheck and args.safecheck_sha256, 'EXPLICIT_DELETE_AND_REVIEWED_SAFE_CHECK_REQUIRED')
    check_raw = body(args.safecheck)
    require(sha(check_raw) == args.safecheck_sha256, 'SAFE_CHECK_EXTERNAL_HASH_MISMATCH')
    capsule = decode(check_raw)
    validator = validate_v6_recovery_check if recovering_v6 else validate_resume_check if resuming else validate_capsule
    validator(capsule, sha(raw), tool_sha)
    # No new lock inode can masquerade as the deployment/network authority.
    with locked(BASE / 'private/release.lock'), locked(Path('/run/lock/oasis-android-mock-network.lock')):
        try:
            if recovering_v6:
                with locked(Path('/run/lock/oasis-android-mock-install.lock')):
                    result = retirer.recover_v6_apply(capsule, original_check_raw, original_resume_raw, args.failed_v6_receipt_sha256)
            elif resuming:
                with locked(Path('/run/lock/oasis-android-mock-install.lock')):
                    result = retirer.resume_apply(capsule, original_check_raw, args.failed_v5_receipt_sha256)
            else:
                result = retirer.apply(capsule)
        except Exception as error:
            if retirer.receipt is not None:
                retirer.event('failed_closed', passed=False, failed_at_phase=retirer.receipt.get('phase'), error_code=safe_error(error))
            raise
    print(canonical(result).decode(), end='')


def safe_error(error):
    text = str(error)
    return text if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', text) else type(error).__name__


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'passed': False, 'error_code': safe_error(error),
                          'scope': 'dedicated-android-mock-only',
                          **({'pending_counts': error.pending_counts} if isinstance(error, PendingBusiness) else {})}))
        raise SystemExit(2)
