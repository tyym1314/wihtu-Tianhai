#!/usr/bin/python3
"""Retire the witnessed public sandbox only. audit/check are read-only.

No SSH, SQL mutation, filesystem-tree removal, image/network pruning, or restore.
The externally pinned production proof remains historical evidence. A successful
receipt records the exact protection handoff instead of rewriting old guards.
"""
import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import socket
import stat
import subprocess
import urllib.error
import urllib.request
from contextlib import contextmanager

BASE = Path('/opt/oasis')
TASK = BASE / 'public-sandbox-retirement-20261010'
NGINX = Path('/etc/nginx/conf.d/oasis.conf')
PUBLIC = 'https://game.tianyahuyu.com'
PLAYER = 'https://oasis-player.43.98.202.236.sslip.io'
CONTAINER = '1d7cad712140e91f99d8ade7fde39c17702cab1045ca4cde4ee7ef8109d56136'
NAME = 'oasis-postgres'
VOLUME = 'oasis-postgres-data'
DATABASE = 'oasis_platform'
UNITS = ('oasis-demo.service', 'oasis-api.service', 'oasis-backup.timer',
         'oasis-monitor.timer', 'oasis-backup.service', 'oasis-monitor.service')
LOCKS = (BASE / 'private/release.lock', BASE / 'production-instance-private/operations.lock')
PORTS = (18881, 18882, 18883, 18885)
CLIENT_ACTIVITY_FIELDS = ('postgres_clients', 'target_connections', 'target_server_connections',
                          'loopback_connections', 'proxy_inbound_connections')
CLIENT_SCOPE_FIELDS = ('api_pids', 'proxy_pids', 'target_namespace', 'target_ip')
PRODUCTION_REQUIRES_UNITS = ('oasis-production-api.service', 'oasis-production-db.service',
    'oasis-production-instance-backup.service', 'oasis-production-instance-backup.timer',
    'oasis-production-instance-monitor.service', 'oasis-production-instance-monitor.timer',
    'oasis-production-player-certificate.service', 'oasis-production-player-certificate.timer')
REQUIRES_PATHS = ('/certificate_timer/Requires',) + tuple('/production_units/' + unit + '/Requires'
                                                       for unit in PRODUCTION_REQUIRES_UNITS)
EXPECTED_START = {
    'oasis-api.service': ('/usr/bin/node', '--import', 'tsx', 'server/index.mjs'),
    'oasis-demo.service': ('/usr/bin/node', '--import', 'tsx', 'deploy/demo-host.mjs'),
    'oasis-backup.service': ('/opt/oasis/current/platform/deploy/backup.sh',),
    'oasis-monitor.service': ('/usr/bin/node', 'deploy/monitor.mjs'),
}
PENDING = ('pending_rooms', 'pending_cycles', 'pending_gp_operations', 'pending_pvp_operations',
           'pending_presentations', 'pending_integration_checks', 'pending_reservations',
           'pending_wallet_matches', 'pending_wallet_probability', 'pending_reserved_balances',
           'pending_wallet_operations', 'pending_active_users', 'pending_transfers',
           'pending_inbound_minor', 'pending_outbound_minor', 'stray_transfer_ledger')
LIMIT = 32 << 20
# Root's read-only diagnostic found these three already SETTLED sandbox visual
# replays. User authorized deletion of their mock data, not a fabricated ACK.
SETTLED_PRESENTATION_SCOPE = {
    '87c121144ac33404135e38b34c1d2b94bab77692fda5286cf2ebfb53460ba8a6':
        ('app_0f127e3fd6df12b921a363b7335fabbd', 'thunder', 1, 1, True),
    'c2636d2835633e5642f0629fc006c1f4465eba726451974c18dc48121d46806a':
        ('app_a8b7d85dd2e878ccbbcdeb83801e0739', 'tiger', 1, 1, True),
    '99263b2efa38accccd5604e4bb592622652d35f369384557b817e8fe716a5259':
        ('app_a8b7d85dd2e878ccbbcdeb83801e0739', 'thunder', 1, 21, False),
}
# Fresh read-only evidence: root-public-retirement-a3/presentation-proof-diagnostic-a1.json.
# Pin the observed bodies as well as their scope. Legacy pendingPlay is a JSON
# string in the two one-round states; another string/body is not an exception.
SETTLED_PRESENTATION_PROOFS = {
    '87c121144ac33404135e38b34c1d2b94bab77692fda5286cf2ebfb53460ba8a6': {
        'cycle_sha256': '1aa549d2fd0e4358d137998891f18b984c2c4b6c70741a78a804f3432ce9a202',
        'state_sha256': '7b15e12183737c712d2bc49a273eea5842a94aee6729eaf1a024fdf6b552ae52',
        'result_sha256': 'b8c48d08ffa7a6ff806b9687334509c989fa6ceecf3b93110f376001bd59b205',
        'pending_play_type': 'string', 'cycle_settled_at': '2026-09-20T01:21:51.519598+00:00'},
    'c2636d2835633e5642f0629fc006c1f4465eba726451974c18dc48121d46806a': {
        'cycle_sha256': 'c2c648bd3ea4c54466857f036ec1ade9a0f12af22ae6c7358bf9c466009b59bc',
        'state_sha256': '5ecbdce2625e5f96af3df0986db4121dc2f591f501be385e3a31f086adf48857',
        'result_sha256': '50723d2c6e71a8b3aadcc230b51b40a10e170772ae602422401808340525d208',
        'pending_play_type': 'string', 'cycle_settled_at': '2026-09-20T07:08:09.632703+00:00'},
    '99263b2efa38accccd5604e4bb592622652d35f369384557b817e8fe716a5259': {
        'cycle_sha256': '9129d4458c384d3b753b8cd64a6a47975458023befdcd8331999a981a9e5e864',
        'state_sha256': '5167121a242fb0bab91f77ab6250fecb76161645904b0d732efbc95c6edcb883',
        'result_sha256': 'a5610ef5d4d8098fae935bec298468eb7b505f3d9b8b4e678c65444d53debd8b',
        'pending_play_type': 'null', 'cycle_settled_at': '2026-10-07T16:22:08.023739+00:00'},
}


class Refusal(Exception): pass


class InventoryChanged(Refusal):
    def __init__(self, comparison):
        super().__init__('LIVE_INVENTORY_CHANGED')
        self.comparison = comparison


def require(value, code):
    if not value: raise Refusal(code)


def digest(value): return hashlib.sha256(value).hexdigest()
def canonical(value): return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def sha(value): return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def exact_differences(expected, actual, path=''):
    """Diagnostic only; the inventory acceptance comparison remains unchanged."""
    if type(expected) is not type(actual): return [{'path': path, 'expected': expected, 'actual': actual}]
    if isinstance(expected, dict):
        result = []
        for key in sorted(set(expected) | set(actual)):
            member = path + '/' + key.replace('~', '~0').replace('/', '~1')
            if key not in expected or key not in actual:
                result.append({'path': member, 'expected_exists': key in expected, 'actual_exists': key in actual,
                               'expected': expected.get(key), 'actual': actual.get(key)})
            else: result.extend(exact_differences(expected[key], actual[key], member))
        return result
    if isinstance(expected, list):
        if len(expected) != len(actual): return [{'path': path, 'expected': expected, 'actual': actual}]
        return [item for index, (before, after) in enumerate(zip(expected, actual))
                for item in exact_differences(before, after, path + '/' + str(index))]
    return [] if expected == actual else [{'path': path, 'expected': expected, 'actual': actual}]


def normalized_protections(value):
    """Only the nine witnessed systemd Requires lists have unordered semantics."""
    result = copy.deepcopy(value)
    require(type(result) is dict and type(result.get('certificate_timer')) is dict
            and type(result.get('production_units')) is dict
            and set(result['production_units']) == set(PRODUCTION_REQUIRES_UNITS), 'PROTECTION_REQUIRES_SCOPE_UNKNOWN')
    rows = [result['certificate_timer']] + [result['production_units'][unit] for unit in PRODUCTION_REQUIRES_UNITS]
    for row in rows:
        require(type(row) is dict and type(row.get('Requires')) is str, 'PROTECTION_REQUIRES_TYPE_UNKNOWN')
        tokens = row['Requires'].split(' ')
        require(all(token and not any(character.isspace() for character in token) for token in tokens)
                and len(tokens) == len(set(tokens)), 'PROTECTION_REQUIRES_TOKENS_UNKNOWN')
        row['Requires'] = sorted(tokens)
    return result


def protection_comparison(expected, actual):
    before = normalized_protections(expected); after = normalized_protections(actual)
    differences = exact_differences(expected, actual)
    # Record only membership-equal Requires reordering, even if another pin fails.
    allowed = []
    for row in differences:
        if row['path'] not in REQUIRES_PATHS: continue
        if sorted(row['expected'].split(' ')) == sorted(row['actual'].split(' ')): allowed.append(row)
    stable = exact_differences(before, after)
    return {'expected_protections': copy.deepcopy(expected), 'actual_protections': copy.deepcopy(actual),
            'differences': differences, 'allowed_observed_differences': allowed,
            'verified_requires_paths': list(REQUIRES_PATHS), 'stable_differences': stable, 'passed': not stable}


def fresh(value):
    try:
        age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(value)).total_seconds()
    except (TypeError, ValueError): raise Refusal('EVIDENCE_TIME_INVALID') from None
    require(0 <= age <= 600, 'EVIDENCE_NOT_FRESH')


def unique_pairs(rows):
    value = {}
    for key, item in rows:
        require(key not in value, 'DUPLICATE_JSON_KEY'); value[key] = item
    return value


def decode(value): return json.loads(value, object_pairs_hook=unique_pairs)


def metadata(path):
    """No-follow entry plus, for an existing symlink, its separately pinned leaf."""
    path = Path(path); before = path.lstat()
    require(stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode),
            'SPECIAL_FILE_REFUSED')
    value = {'uid': before.st_uid, 'gid': before.st_gid, 'mode': stat.S_IMODE(before.st_mode),
             'device': before.st_dev, 'inode': before.st_ino,
             'kind': 'file' if path.is_file() and not path.is_symlink() else 'symlink' if path.is_symlink() else 'directory'}
    if value['kind'] == 'file':
        require(before.st_nlink == 1, 'HARDLINK_REFUSED')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        h = hashlib.sha256()
        with os.fdopen(fd, 'rb') as stream:
            require(os.fstat(stream.fileno()) == before, 'ENTRY_CHANGED')
            for chunk in iter(lambda: stream.read(1 << 20), b''): h.update(chunk)
            after_fd = os.fstat(stream.fileno())
        # atime may change when read; compare the fields relevant to identity/body.
        keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(all(getattr(before, key) == getattr(after_fd, key) == getattr(path.lstat(), key) for key in keys), 'ENTRY_CHANGED')
        value.update(bytes=before.st_size, sha256=h.hexdigest())
    elif value['kind'] == 'symlink':
        value.update(target=os.readlink(path), leaf=str(path.resolve(strict=True)))
        require(Path(value['leaf']) != path, 'SYMLINK_CYCLE')
        value['leaf_metadata'] = metadata(value['leaf'])
    return value


def read_pinned(path, expected):
    path = Path(path); require(path.is_absolute() and '..' not in path.parts and sha(expected), 'PIN_REQUIRED')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022
                and (info.st_uid == 0 or parent == BASE / 'private' and info.st_uid == 998), 'INPUT_PARENT_UNSAFE')
    before = metadata(path)
    require(before['kind'] == 'file' and before['uid'] == 0 and not before['mode'] & 0o022
            and before['bytes'] <= LIMIT and before['sha256'] == expected, 'INPUT_PIN_MISMATCH')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream: body = stream.read(LIMIT + 1)
    require(digest(body) == expected and metadata(path) == before, 'INPUT_CHANGED')
    return decode(body), before


def output_guard(path):
    path = Path(path)
    require(path.parent == TASK and re.fullmatch('[A-Za-z0-9_.-]+', path.name) and not path.exists(), 'OUTPUT_SCOPE_OR_EXISTS')
    parent = TASK.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == parent.st_gid == 0
            and stat.S_IMODE(parent.st_mode) == 0o700, 'OUTPUT_PARENT_UNSAFE')


def write_new(path, value):
    path = Path(path); output_guard(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream: stream.write(canonical(value)); stream.flush(); os.fsync(stream.fileno())


def pending_free(value):
    require(value.get('environment') == 'sandbox' and value.get('database') == DATABASE
            and value.get('non_sandbox_apps') == value.get('non_sandbox_wallet_scopes') == 0,
            'DATABASE_NOT_EXCLUSIVE_SANDBOX')
    require(set(PENDING) <= set(value) and all(type(value[key]) is int and value[key] >= 0 for key in PENDING),
            'PENDING_COUNTS_INCOMPLETE')
    require(all(value[key] == 0 for key in PENDING if key != 'pending_presentations'), 'PENDING_BUSINESS_REFUSED')
    apps = value.get('apps')
    require(isinstance(apps, list) and len(apps) == 4 and len({app['id'] for app in apps}) == 4
            and all(app.get('environment') == 'sandbox' for app in apps), 'APP_SCOPE_UNKNOWN')
    require(all(type(value.get(key)) is int and value[key] >= 0 for key in ('sessions', 'rooms', 'wallet_users')),
            'DATA_COUNTS_INCOMPLETE')
    presentations = value.get('settled_presentations')
    require(isinstance(presentations, list) and len(presentations) == value['pending_presentations']
            and len({row.get('session_sha256') for row in presentations}) == len(presentations), 'PENDING_PRESENTATION_PROOF_REQUIRED')
    app_scopes = {app['id']: app for app in apps}
    for row in presentations:
        require(set(row) == {'session_sha256', 'cycle_sha256', 'state_sha256', 'result_sha256', 'app_scope', 'game_id',
                            'next_index', 'round_count', 'has_pending_play', 'pending_play_type', 'state_type', 'cycle_status',
                            'cycle_session_sha256', 'cycle_app_id', 'cycle_game_id', 'cycle_environment', 'cycle_settled_at'},
                'PENDING_PRESENTATION_PROOF_INCOMPLETE')
        require(all(sha(row[key]) for key in ('session_sha256', 'cycle_sha256', 'state_sha256', 'result_sha256', 'cycle_session_sha256'))
                and row['session_sha256'] in SETTLED_PRESENTATION_SCOPE, 'PENDING_PRESENTATION_NOT_WITNESSED')
        app_id, game, next_index, rounds, has_pending_play = SETTLED_PRESENTATION_SCOPE[row['session_sha256']]
        scope = row['app_scope']
        require(isinstance(scope, dict) and set(scope) == {'app_id', 'partner_id', 'environment', 'wallet_scope_id', 'currency_id'}
                and scope['app_id'] == app_id and scope['environment'] == row['cycle_environment'] == 'sandbox'
                and all(scope[name] == app_scopes.get(app_id, {}).get(name) for name in ('partner_id', 'environment', 'wallet_scope_id')),
                'PENDING_PRESENTATION_SCOPE_INVALID')
        require(row['cycle_status'] == 'SETTLED' and row['cycle_session_sha256'] == row['session_sha256']
                and row['cycle_app_id'] == app_id and row['game_id'] == row['cycle_game_id'] == game
                and type(row['next_index']) is int and type(row['round_count']) is int
                and row['next_index'] == next_index and row['round_count'] == rounds
                and row['has_pending_play'] is has_pending_play
                and row['pending_play_type'] == SETTLED_PRESENTATION_PROOFS[row['session_sha256']]['pending_play_type']
                and row['state_type'] == 'object' and isinstance(row['cycle_settled_at'], str) and row['cycle_settled_at'],
                'PENDING_PRESENTATION_NOT_COMPLETE_SETTLED_PROOF')
        require(all(row[key] == expected for key, expected in SETTLED_PRESENTATION_PROOFS[row['session_sha256']].items()),
                'PENDING_PRESENTATION_OBSERVED_BODY_CHANGED')


def retirement_nginx(original):
    """Only reviewed inner routing locations change; TLS/ACME/static bytes survive."""
    require(isinstance(original, bytes) and original.endswith(b'\n') and b'\x00' not in original, 'NGINX_BODY_INVALID')
    edits = {
        b'    location = /demo { return 302 /demo/; }\n':
        ('    location = /player { return 302 ' + PLAYER + '/player$is_args$args; }\n'
         '    location = /player/ { return 302 ' + PLAYER + '/player$is_args$args; }\n'
         '    location = /demo { return 410; }\n'
         '    location = /api/demo { return 410; }\n'
         '    location ^~ /downloads/ { return 410; }\n').encode(),
        b'    location ^~ /demo/ { proxy_pass http://127.0.0.1:18885; }\n': b'    location ^~ /demo/ { return 410; }\n',
        b'    location ^~ /api/demo/ { proxy_pass http://127.0.0.1:18885; }\n': b'    location ^~ /api/demo/ { return 410; }\n',
        b'    location ~ ^/api/(admin|partner)/login$ {\n        limit_req zone=oasis_login burst=6 nodelay;\n        limit_req_status 429;\n        proxy_pass http://127.0.0.1:18881;\n    }\n':
        b'    location ~ ^/api/(admin|partner)/login$ { return 410; }\n',
        b'    location = /health { proxy_pass http://127.0.0.1:18881; }\n': b'    location = /health { return 410; }\n',
        b'    location = /index.html {\n': b'    location = /index.html {\n        return 410;\n',
        b'    location = /downloads/android-smoke-build.json {\n': b'    location = /downloads/android-smoke-build.json {\n        return 410;\n',
        b'    location @oasis_api_static { proxy_pass http://127.0.0.1:18881; }\n': b'    location @oasis_api_static { return 410; }\n',
        b'    location ~ ^/(api|v1|play|arena|legacy)/ { proxy_pass http://127.0.0.1:18881; }\n':
        b'    location ~ ^/(api|v1|play|arena|legacy)/ { return 410; }\n',
        b'    location / { try_files $uri $uri/ /index.html; }\n': b'    location / { return 410; }\n',
    }
    require(b'location = /player' not in original and original.count(b'server_name game.tianyahuyu.com;') == 2,
            'NGINX_SITE_SHAPE_UNKNOWN')
    result = original
    for old, new in edits.items():
        require(result.count(old) == 1, 'NGINX_EXACT_LOCATION_MISSING'); result = result.replace(old, new, 1)
    require(b'127.0.0.1:18881' not in result and b'127.0.0.1:18885' not in result, 'SANDBOX_PROXY_REMAINS')
    return result


def loaded_commands_guard(unit, commands):
    required = ('ExecStartPre', 'ExecStart', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload')
    require(set(commands) == set(required), 'EFFECTIVE_COMMANDS_INCOMPLETE')
    for name in required:
        rows = commands[name]
        require(isinstance(rows, list), 'EFFECTIVE_COMMANDS_INVALID')
        expected = [{'path': EXPECTED_START[unit][0], 'argv': list(EXPECTED_START[unit]), 'ignore_errors': False}] if name == 'ExecStart' else []
        require(rows == expected, 'EFFECTIVE_COMMAND_UNKNOWN_' + name.upper())
    return commands


def pin_matches(actual, expected):
    """Compare only documented pin fields, accepting both historical formats."""
    aliases = {'st_uid': 'uid', 'st_gid': 'gid', 'st_dev': 'device', 'st_ino': 'inode', 'st_size': 'bytes'}
    for key, value in expected.items():
        if key in ('st_atime', 'st_atime_ns', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink'): continue
        if key == 'st_mode':
            if actual.get('mode') != stat.S_IMODE(value): return False
        elif key in aliases:
            if aliases[key] in actual and actual[aliases[key]] != value: return False
        elif key == 'leaf_metadata':
            if not pin_matches(actual.get('leaf_metadata', {}), value): return False
        elif key in actual and actual[key] != value: return False
    return 'sha256' not in expected or actual.get('sha256') == expected['sha256']


def tcp_address(value):
    address, port = value.rsplit(':', 1); raw = bytes.fromhex(address)
    require(len(raw) in (4, 16), 'PROC_TCP_ADDRESS_UNKNOWN')
    raw = b''.join(raw[index:index + 4][::-1] for index in range(0, len(raw), 4))
    parsed = ipaddress.ip_address(socket.inet_ntop(socket.AF_INET if len(raw) == 4 else socket.AF_INET6, raw))
    if parsed.version == 6 and parsed.ipv4_mapped: parsed = parsed.ipv4_mapped
    return str(parsed), int(port, 16)


def proxy_command_matches(argv, target_ip):
    expected = ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-ip', '127.0.0.1', '-host-port', '18883',
                '-container-ip', target_ip, '-container-port', '5432']
    # Fresh read-only evidence identified this exact Docker-owned proxy PID;
    # recent Docker passes its inherited listener with this trailing boolean.
    return argv == expected or argv == expected + ['-use-listen-fd']


def database_connections_guard(pg, connections, *, target_ip, target_namespace, allowed_pids, proxy_pids):
    """Join every PG backend to the target namespace and an owned TCP client.

    A known Docker proxy is allowed only with equally many owned API connections
    to its loopback port. Every direct target:5432 client in every visible network
    namespace must belong to the reviewed API; Unix/other-database clients refuse.
    """
    require(set(pg) == {'audit_backend_pid', 'clients'} and type(pg['audit_backend_pid']) is int
            and isinstance(pg['clients'], list), 'PG_CLIENT_SNAPSHOT_UNKNOWN')
    require(isinstance(connections, list) and all(isinstance(row, dict)
            and set(row) == {'namespace', 'inode', 'local', 'remote', 'owners'}
            and isinstance(row['namespace'], str) and row['namespace']
            and isinstance(row['inode'], str) and row['inode'].isdigit() and int(row['inode']) > 0
            and all(isinstance(row[key], list) and len(row[key]) == 2 and isinstance(row[key][0], str)
                    and type(row[key][1]) is int and 0 < row[key][1] <= 65535 for key in ('local', 'remote'))
            and isinstance(row['owners'], list) and all(type(pid) is int and pid > 0 for pid in row['owners'])
            and row['owners'] == sorted(set(row['owners'])) for row in connections), 'DATABASE_SOCKET_SNAPSHOT_UNKNOWN')
    clients = pg['clients']; allowed = set(allowed_pids); proxies = set(proxy_pids)
    target = [row for row in connections if row['remote'] == [target_ip, 5432]]
    loopback = [row for row in connections if row['remote'] == ['127.0.0.1', 18883]]
    server = [row for row in connections if row['namespace'] == target_namespace and row['local'] == [target_ip, 5432]]
    inbound = [row for row in connections if row['local'] == ['127.0.0.1', 18883]]
    require(all(set(row['owners']) and set(row['owners']) <= allowed for row in loopback), 'UNKNOWN_DATABASE_TCP_CONSUMER')
    require(all(set(row['owners']) and set(row['owners']) <= allowed | proxies for row in target), 'UNKNOWN_DATABASE_BRIDGE_CONSUMER')
    require(all(set(row['owners']) and set(row['owners']) <= proxies for row in inbound), 'UNKNOWN_DATABASE_PROXY_CONSUMER')
    proxy_out = [row for row in target if set(row['owners']) <= proxies]
    require(len(loopback) == len(inbound) == len(proxy_out), 'DATABASE_PROXY_CONNECTION_COUNT_CHANGED')
    require({tuple(row['local']) for row in loopback} == {tuple(row['remote']) for row in inbound}, 'DATABASE_PROXY_INPUT_NOT_OWNED')
    require(len({(row['namespace'], row['inode']) for row in target}) == len(target), 'DATABASE_TARGET_CONNECTION_DUPLICATE')
    client_endpoints = []
    for row in clients:
        require(set(row) == {'pid', 'database', 'user', 'client_addr', 'client_port'}
                and type(row['pid']) is int and row['pid'] != pg['audit_backend_pid']
                and row['database'] == DATABASE and row['user'] == 'oasis'
                and isinstance(row['client_addr'], str) and type(row['client_port']) is int and row['client_port'] > 0,
                'UNKNOWN_POSTGRES_CLIENT')
        try:
            address = ipaddress.ip_interface(row['client_addr'])
            require(address.network.prefixlen == address.max_prefixlen, 'POSTGRES_CLIENT_ADDRESS_MASK_UNKNOWN')
        except ValueError: raise Refusal('POSTGRES_CLIENT_ADDRESS_UNKNOWN') from None
        client_endpoints.append((str(address.ip), row['client_port']))
    require(len(set(client_endpoints)) == len(client_endpoints)
            and sorted(client_endpoints) == sorted(tuple(row['local']) for row in target)
            and sorted(client_endpoints) == sorted(tuple(row['remote']) for row in server), 'POSTGRES_CONNECTION_ATTRIBUTION_MISMATCH')
    require(all(row['owners'] for row in server), 'POSTGRES_TARGET_SOCKET_UNOWNED')
    return {'postgres_clients': clients, 'api_pids': sorted(allowed),
            'proxy_pids': sorted(proxies), 'target_namespace': target_namespace, 'target_ip': target_ip,
            'target_connections': target, 'target_server_connections': server, 'loopback_connections': loopback, 'proxy_inbound_connections': inbound}


def verified_client_scope(value):
    """Revalidate all saved joins, then compare only the stable authorized scope.

    Runtime.database_clients already verifies the live network/PG consumers. No
    row is discarded before this second pure verification of both raw snapshots.
    """
    require(isinstance(value, dict) and set(value) == set(CLIENT_ACTIVITY_FIELDS + CLIENT_SCOPE_FIELDS)
            and all(isinstance(value[key], list) for key in CLIENT_ACTIVITY_FIELDS), 'DATABASE_CLIENT_ACTIVITY_SCOPE_UNKNOWN')
    require(all(isinstance(value[key], list) and value[key] == sorted(set(value[key]))
                and all(type(pid) is int and pid > 0 for pid in value[key]) for key in ('api_pids', 'proxy_pids')),
            'DATABASE_CLIENT_PID_SCOPE_UNKNOWN')
    connections = [row for key in CLIENT_ACTIVITY_FIELDS if key != 'postgres_clients' for row in value[key]]
    verified = database_connections_guard({'audit_backend_pid': 0, 'clients': value['postgres_clients']}, connections,
                                         target_ip=value['target_ip'], target_namespace=value['target_namespace'],
                                         allowed_pids=value['api_pids'], proxy_pids=value['proxy_pids'])
    require(verified == value, 'DATABASE_CLIENT_ACTIVITY_NOT_COMPLETE_VERIFIED_SCOPE')
    return {key: copy.deepcopy(value[key]) for key in CLIENT_SCOPE_FIELDS}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class Runtime:
    def run(self, argv, *, input=None, check=True, timeout=60):
        env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
        result = subprocess.run(argv, input=input, capture_output=True, text=True, env=env, timeout=timeout)
        require(not check or result.returncode == 0, 'COMMAND_FAILED_' + Path(argv[0]).name.upper())
        return result

    def output(self, argv, **kwargs): return self.run(argv, **kwargs).stdout.strip()

    def inspect(self, kind, name):
        # Selected fields avoid Docker's secret Env values in receipts.
        fields = {'container': {'id': 'Id', 'name': 'Name', 'image': 'Image', 'running': 'State.Running',
                  'pid': 'State.Pid', 'mounts': 'Mounts', 'networks': 'NetworkSettings.Networks',
                  'ports': 'HostConfig.PortBindings', 'restart': 'HostConfig.RestartPolicy'},
                  'volume': {'name': 'Name', 'driver': 'Driver', 'options': 'Options', 'scope': 'Scope', 'mountpoint': 'Mountpoint'},
                  'network': {'id': 'Id', 'name': 'Name', 'driver': 'Driver', 'internal': 'Internal', 'containers': 'Containers'}}[kind]
        template = '{' + ','.join(json.dumps(k) + ':{{json .' + v + '}}' for k, v in fields.items()) + '}'
        return decode(self.output(['docker', kind, 'inspect', '--format', template, name]))

    def container_names(self):
        return self.output(['docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}']).splitlines()

    def service(self, unit):
        keys = 'ActiveState,SubState,MainPID,ControlPID,UnitFileState,FragmentPath,DropInPaths,NeedDaemonReload,ControlGroup,Triggers,TriggeredBy,Requires,Wants,PartOf,BoundBy,RequiredBy,WantedBy,WorkingDirectory,User,Group'
        return dict(line.split('=', 1) for line in self.output(['systemctl', 'show', unit, '--property=' + keys]).splitlines() if '=' in line)

    def loaded_commands(self, unit):
        # Keep one private D-Bus sender alive so inactive units cannot disappear
        # between RefUnit/GetUnit/property reads. Never parse systemctl argv text.
        import dbus
        saved = {key: os.environ.pop(key) for key in ('DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_SESSION_BUS_ADDRESS') if key in os.environ}
        bus = manager = None; referenced = False
        try:
            bus = dbus.SystemBus(private=True)
            manager = dbus.Interface(bus.get_object('org.freedesktop.systemd1', '/org/freedesktop/systemd1'), 'org.freedesktop.systemd1.Manager')
            manager.RefUnit(unit, timeout=30); referenced = True
            path = manager.GetUnit(unit, timeout=30)
            expected = '/org/freedesktop/systemd1/unit/' + ''.join(c if c.isascii() and c.isalnum() else '_' + format(ord(c), '02x') for c in unit)
            require(isinstance(path, dbus.ObjectPath) and str(path) == expected, 'DBUS_UNIT_IDENTITY_UNKNOWN')
            props = dbus.Interface(bus.get_object('org.freedesktop.systemd1', path), 'org.freedesktop.DBus.Properties')
            reload = props.Get('org.freedesktop.systemd1.Unit', 'NeedDaemonReload', timeout=30)
            require(isinstance(reload, dbus.Boolean) and not bool(reload), 'MANAGER_RELOAD_REQUIRED')
            environment_files = props.Get('org.freedesktop.systemd1.Service', 'EnvironmentFiles', timeout=30)
            expected_env = [] if unit == 'oasis-backup.service' else [('/opt/oasis/private/runtime.env', False)]
            if unit == 'oasis-monitor.service': expected_env.append(('/opt/oasis/private/monitor.env', True))
            require(isinstance(environment_files, dbus.Array) and str(environment_files.signature) == '(sb)'
                    and [(str(row[0]), bool(row[1])) for row in environment_files] == expected_env, 'PUBLIC_EFFECTIVE_ENVIRONMENT_UNKNOWN')
            result = {}
            for key in ('ExecStartPre', 'ExecStart', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload'):
                rows = props.Get('org.freedesktop.systemd1.Service', key, timeout=30)
                require(isinstance(rows, dbus.Array) and str(rows.signature) == '(sasbttttuii)', 'DBUS_COMMAND_SHAPE_UNKNOWN')
                result[key] = []
                for row in rows:
                    require(isinstance(row, dbus.Struct) and len(row) == 10 and isinstance(row[0], dbus.String)
                            and isinstance(row[1], dbus.Array) and str(row[1].signature) == 's'
                            and all(isinstance(item, dbus.String) for item in row[1])
                            and isinstance(row[2], dbus.Boolean), 'DBUS_COMMAND_ROW_UNKNOWN')
                    result[key].append({'path': str(row[0]), 'argv': list(map(str, row[1])), 'ignore_errors': bool(row[2])})
            return loaded_commands_guard(unit, result)
        finally:
            try:
                if referenced: manager.UnrefUnit(unit, timeout=30)
            finally:
                if bus is not None: bus.close()
                os.environ.update(saved)

    def processes(self, current):
        result = []
        for folder in Path('/proc').iterdir():
            if not folder.name.isdigit() or int(folder.name) == os.getpid(): continue
            try:
                argv = [v.decode() for v in (folder / 'cmdline').read_bytes().split(b'\0') if v]
                environment = (folder / 'environ').read_bytes()
                cwd = os.readlink(folder / 'cwd'); exe = os.readlink(folder / 'exe')
                cgroup = (folder / 'cgroup').read_text()
                involved = (cwd.startswith(current) or any('/opt/oasis/private' in item or NAME in item or VOLUME in item for item in argv)
                            or b':18883/oasis_platform' in environment
                            or any('/system.slice/' + unit in cgroup for unit in EXPECTED_START))
                if not involved: continue
                units = [unit for unit in EXPECTED_START if '/system.slice/' + unit + '\n' in cgroup]
                require(len(units) == 1, 'UNKNOWN_PUBLIC_PROCESS_CONSUMER')
                unit = units[0]
                require(unit in ('oasis-api.service', 'oasis-demo.service'), 'PUBLIC_JOB_RUNNING')
                expected = list(EXPECTED_START[unit])
                esbuild = exe == current + '/platform/node_modules/@esbuild/linux-x64/bin/esbuild' and argv == [exe, '--service=0.28.2', '--ping']
                require(cwd == current + '/platform' and (argv == expected and exe == '/usr/bin/node' or esbuild), 'PUBLIC_PROCESS_SHAPE_UNKNOWN')
                status = (folder / 'status').read_text().splitlines()
                uids = next(row.split()[1:] for row in status if row.startswith('Uid:'))
                require(uids == ['998'] * 4, 'PUBLIC_PROCESS_UID_UNKNOWN')
                raw = (folder / 'stat').read_text(); ticks = raw[raw.rindex(')') + 2:].split()[19]
                result.append({'pid': int(folder.name), 'start_ticks': ticks, 'exe': exe, 'argv': argv, 'cwd': cwd, 'cgroup': cgroup, 'uids': list(map(int, uids))})
            except (FileNotFoundError, ProcessLookupError): continue
        return sorted(result, key=lambda item: item['pid'])

    def listeners(self, ports=PORTS):
        rows = self.output(['ss', '-Hlnpt']).splitlines()
        return [row for row in rows if any(re.search(r':' + str(port) + r'\s', row) for port in ports)]

    def pg_clients(self):
        sql = "BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('audit_backend_pid',pg_backend_pid(),'clients',(SELECT coalesce(json_agg(json_build_object('pid',pid,'database',datname,'user',usename,'client_addr',host(client_addr),'client_port',client_port) ORDER BY pid),'[]'::json) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid())); COMMIT;"
        return decode(self.output(['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'oasis', '-d', DATABASE], input=sql))

    def network_connections(self, container):
        target_ip = container['networks']['bridge']['IPAddress']
        require(ipaddress.ip_address(target_ip).version == 4 and type(container['pid']) is int and container['pid'] > 0,
                'DATABASE_NETWORK_IDENTITY_UNKNOWN')
        target_namespace = os.readlink('/proc/' + str(container['pid']) + '/ns/net')
        folders = [path for path in Path('/proc').iterdir() if path.name.isdigit()]
        namespaces = {}; proxies = set()
        for folder in folders:
            try:
                namespace = os.readlink(folder / 'ns/net'); namespaces.setdefault(namespace, folder)
                exe = os.readlink(folder / 'exe')
                if exe != '/usr/bin/docker-proxy': continue
                argv = [value.decode() for value in (folder / 'cmdline').read_bytes().split(b'\0') if value]
                if proxy_command_matches(argv, target_ip):
                    executable = metadata(exe)
                    require(executable['uid'] == 0 and not executable['mode'] & 0o022, 'DATABASE_PROXY_EXECUTABLE_UNSAFE')
                    proxies.add(int(folder.name))
            except (FileNotFoundError, ProcessLookupError): continue
        require(target_namespace in namespaces, 'DATABASE_TARGET_NAMESPACE_MISSING')
        records = []
        for namespace, folder in namespaces.items():
            for protocol in ('tcp', 'tcp6'):
                try: rows = (folder / 'net' / protocol).read_text().splitlines()[1:]
                except (FileNotFoundError, ProcessLookupError): raise Refusal('DATABASE_NETWORK_SNAPSHOT_CHANGED') from None
                for row in rows:
                    fields = row.split()
                    if fields[3] != '01': continue
                    local, remote = tcp_address(fields[1]), tcp_address(fields[2])
                    involved = remote == (target_ip, 5432) or remote == ('127.0.0.1', 18883) or local == ('127.0.0.1', 18883)
                    involved |= namespace == target_namespace and local == (target_ip, 5432)
                    if involved: records.append({'namespace': namespace, 'inode': fields[9], 'local': list(local), 'remote': list(remote), 'owners': []})
        wanted = {row['inode'] for row in records}; owners = {}
        for folder in folders:
            try:
                for fd in (folder / 'fd').iterdir():
                    target = os.readlink(fd)
                    if target.startswith('socket:[') and target[8:-1] in wanted: owners.setdefault(target[8:-1], set()).add(int(folder.name))
            except (FileNotFoundError, ProcessLookupError): continue
        for row in records: row['owners'] = sorted(owners.get(row['inode'], ()))
        records.sort(key=lambda row: (row['namespace'], row['inode']))
        return target_ip, target_namespace, records, proxies

    def database_clients(self, allowed_pids, container, *, stopped=False):
        target_ip, namespace, rows, proxies = self.network_connections(container)
        value = database_connections_guard(self.pg_clients(), rows, target_ip=target_ip, target_namespace=namespace,
                                           allowed_pids=allowed_pids, proxy_pids=proxies)
        require(not stopped or not value['postgres_clients'], 'POST_STOP_DATABASE_CLIENT_REMAINS')
        return value

    def proxy_nginx_files(self, container_id):
        require(sha(container_id), 'PROXY_CONTAINER_IDENTITY_REQUIRED')
        raw = self.output(['docker', 'exec', container_id, 'sh', '-c', 'find /etc/nginx -type f -exec sha256sum {} + | LC_ALL=C sort'])
        rows = raw.splitlines()
        require(rows and all(re.fullmatch('[a-f0-9]{64}  /etc/nginx/[^\n]+', row) for row in rows)
                and len({row.split('  ', 1)[1] for row in rows}) == len(rows), 'PROXY_NGINX_FILES_INVALID')
        return rows

    def database(self):
        fields = "'database',current_database(),'database_oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),'apps',(SELECT coalesce(json_agg(json_build_object('id',id,'partner_id',partner_id,'environment',environment,'wallet_scope_id',wallet_scope_id,'wallet_url',wallet_url,'status',status) ORDER BY id),'[]'::json) FROM gp_apps),'sessions',(SELECT count(*) FROM gp_sessions),'rooms',(SELECT count(*) FROM pvp_rooms),'wallet_users',(SELECT count(*) FROM wallet_users),'non_sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment<>'sandbox'),'non_sandbox_wallet_scopes',(SELECT count(*) FROM wallet_scopes WHERE environment<>'sandbox'),'pending_rooms',(SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')),'pending_cycles',(SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')),'pending_gp_operations',(SELECT count(*) FROM gp_operations WHERE state='PENDING'),'pending_pvp_operations',(SELECT count(*) FROM pvp_operations WHERE state='PENDING'),'pending_presentations',(SELECT count(*) FROM gp_sessions s LEFT JOIN gp_cycles c ON c.id=s.state->>'cycleId' WHERE s.state->>'pendingPlay' IS NOT NULL OR coalesce((s.state->>'nextIndex')::int,0)<coalesce(jsonb_array_length(c.result->'rounds'),0)),'pending_integration_checks',(SELECT count(*) FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING')),'pending_reservations',(SELECT count(*) FROM wallet_reservations WHERE state='RESERVED'),'pending_wallet_matches',(SELECT count(*) FROM wallet_matches WHERE state NOT IN ('SETTLED','VOIDED','CANCELLED')),'pending_wallet_probability',(SELECT count(*) FROM wallet_probability WHERE state NOT IN ('SETTLED','CANCELLED','EXPIRED')),'pending_reserved_balances',(SELECT count(*) FROM wallet_users WHERE reserved<>0 OR credit_pending<>0),'pending_wallet_operations',(SELECT count(*) FROM wallet_operations WHERE state='PENDING'),'pending_active_users',(SELECT count(*) FROM pvp_active_users)"
        presentation_fields = "'session_sha256',encode(sha256(convert_to(s.id,'UTF8')),'hex'),'cycle_sha256',encode(sha256(convert_to(c.id,'UTF8')),'hex'),'state_sha256',encode(sha256(convert_to(s.state::text,'UTF8')),'hex'),'result_sha256',encode(sha256(convert_to(c.result::text,'UTF8')),'hex'),'app_scope',json_build_object('app_id',a.id,'partner_id',a.partner_id,'environment',a.environment,'wallet_scope_id',a.wallet_scope_id,'currency_id',a.currency_id),'game_id',s.game_id,'next_index',coalesce((s.state->>'nextIndex')::int,0),'round_count',coalesce(jsonb_array_length(c.result->'rounds'),0),'has_pending_play',s.state->>'pendingPlay' IS NOT NULL,'pending_play_type',jsonb_typeof(s.state->'pendingPlay'),'state_type',jsonb_typeof(s.state),'cycle_status',c.status,'cycle_session_sha256',encode(sha256(convert_to(c.session_id,'UTF8')),'hex'),'cycle_app_id',c.app_id,'cycle_game_id',c.game_id,'cycle_environment',ca.environment,'cycle_settled_at',c.updated_at"
        fields += ",'settled_presentations',(SELECT coalesce(json_agg(json_build_object(" + presentation_fields + ") ORDER BY s.id),'[]'::json) FROM gp_sessions s LEFT JOIN gp_apps a ON a.id=s.app_id LEFT JOIN gp_cycles c ON c.id=s.state->>'cycleId' LEFT JOIN gp_apps ca ON ca.id=c.app_id WHERE s.state->>'pendingPlay' IS NOT NULL OR coalesce((s.state->>'nextIndex')::int,0)<coalesce(jsonb_array_length(c.result->'rounds'),0))"
        absent = "'transfer_schema','absent','pending_transfers',0,'pending_inbound_minor',0,'pending_outbound_minor',0,'stray_transfer_ledger',(SELECT count(*) FROM wallet_ledger WHERE account LIKE 'transfer:%' OR meta->>'kind' LIKE 'transfer_%')"
        present = "'transfer_schema','present','pending_transfers',(SELECT count(*) FROM gp_transfers WHERE state='PENDING'),'pending_inbound_minor',(SELECT coalesce(sum(amount_minor),0) FROM gp_transfers WHERE state='PENDING' AND direction='IN'),'pending_outbound_minor',(SELECT coalesce(sum(amount_minor),0) FROM gp_transfers WHERE state='PENDING' AND direction='OUT'),'stray_transfer_ledger',0"
        query = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='20s';\nSELECT count(*)=0 AS absent,count(*)=5 AS present FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('gp_transfer_bindings','gp_transfer_accounts','gp_transfers','gp_transfer_outbox','wallet_transfer_clearing')\n\\gset\n\\if :absent\nSELECT json_build_object(" + fields + ',' + absent + ");\n\\else\n\\if :present\nSELECT json_build_object(" + fields + ',' + present + ");\n\\else\nDO $guard$ BEGIN RAISE EXCEPTION 'TRANSFER_SCHEMA_INCOMPLETE'; END $guard$;\n\\endif\n\\endif\nCOMMIT;\n"
        value = decode(self.output(['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'oasis', '-d', DATABASE], input=query))
        pending_free(value); return value

    def http(self, url, status, *, location=None, environment=None):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        try: response = opener.open(urllib.request.Request(url), timeout=15)
        except urllib.error.HTTPError as error: response = error
        except (urllib.error.URLError, OSError, TimeoutError): raise Refusal('HTTPS_UNAVAILABLE') from None
        with response:
            require(response.status == status and response.geturl() == url, 'HTTPS_STATUS_OR_URL_CHANGED')
            require(location is None or response.headers.get('Location') == location, 'PLAYER_REDIRECT_CHANGED')
            body = response.read(1 << 20)
            if environment: require(decode(body).get('environment') == environment, 'PRODUCTION_HEALTH_CHANGED')
            return {'url': url, 'status': response.status, 'location': response.headers.get('Location'), 'strict_tls': True}


def proof_state(proof):
    require(proof.get('passed') is True and proof.get('phase') == 'complete_free_open'
            and proof.get('target_release') == '/opt/oasis/releases/20261010-06', 'PRODUCTION_OPEN06_PROOF_REQUIRED')
    state = proof.get('final', {}).get('state', {})
    require(state.get('runtime_profile', {}).get('public_origin') == PLAYER
            and proof.get('committed_policy', {}).get('state') == 'open'
            and state.get('resources', {}).get('container_id') != CONTAINER
            and state.get('resources', {}).get('volume', {}).get('name') != VOLUME, 'PRODUCTION_IDENTITY_REQUIRED')
    return state


class Retirer:
    def __init__(self, proof, proof_pin, runtime=None):
        self.proof, self.proof_pin = proof, proof_pin; self.state = proof_state(proof)
        self.runtime = runtime or Runtime()

    def protections(self, *, changed_nginx=None):
        state = self.state; paths = set(state['protected']['files']) | set(state['protected']['nginx'])
        paths |= {str(BASE / 'production-current'), str(BASE / 'production-instance-private/installation.json'),
                  str(BASE / 'production-instance-private/runtime.env'), str(BASE / 'production-instance-private/postgres.env'),
                  str(BASE / 'production-instance-private/state/master.key'), str(BASE / 'production-instance-private/bootstrap.json')}
        paths |= {str(Path('/etc/systemd/system') / unit) for unit in state['units']['files']}
        paths.add(state['runtime_profile']['release'] + '/RELEASE-MANIFEST.json')
        # Preserve both old and new official recovery/controller evidence paths.
        def gather(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key.startswith('/opt/oasis/') and isinstance(item, dict) and 'sha256' in item: paths.add(key)
                    gather(item)
            elif isinstance(value, list):
                for item in value: gather(item)
        gather(state['source'])
        paths |= {str(BASE / 'backups/20261009T155133Z' / name) for name in state['protected']['preserved_backup']}
        paths |= {str(Path('/etc/systemd/system') / unit) for unit in ('oasis-certificate.service', 'oasis-certificate.timer')}
        paths |= {str(BASE / 'acme/config/live/oasis-game' / name) for name in ('fullchain.pem', 'privkey.pem')}
        paths |= {str(BASE / 'acme/config/renewal/oasis-game.conf'), str(BASE / 'current/platform/deploy/renew-certificate.sh'),
                  str(BASE / 'current/platform/deploy/oasis-acme-proxy.nginx.conf')}
        paths.add(self.proof_pin['path'])
        paths |= {str(Path('/etc/systemd/system') / unit) for unit in UNITS}
        current = state['protected']['files'][str(BASE / 'current')]['leaf']
        for member in ('platform/deploy/backup.sh', 'platform/deploy/monitor.mjs', 'platform/server/index.mjs'):
            paths.add(current + '/' + member)
        files = {path: metadata(path) for path in sorted(paths)}
        if changed_nginx is not None:
            require(files[str(NGINX)]['sha256'] == changed_nginx, 'NEW_NGINX_HASH_CHANGED')
            files.pop(str(NGINX))
        prod = self.runtime.inspect('container', state['resources']['container_id'])
        require(prod['id'] == state['resources']['container_id'] and prod['running'] is True
                and prod['image'] == state['resources']['image']
                and any(m.get('Name') == state['resources']['volume']['name'] for m in prod['mounts']), 'PRODUCTION_RESOURCES_CHANGED')
        units = {unit: self.runtime.service(unit) for unit in state['units']['files']}
        for unit, value in units.items():
            require(value.get('NeedDaemonReload') == 'no', 'PRODUCTION_RELOAD_REQUIRED')
            if unit == 'oasis-production-api.service': require(value.get('ActiveState') == 'active', 'PRODUCTION_API_DOWN')
        proxy = self.runtime.inspect('container', state['protected']['containers']['proxy-nginx']['Id'])
        require(proxy['running'] is True, 'PROXY_NGINX_DOWN')
        proxy_files = self.runtime.proxy_nginx_files(proxy['id'])
        require(proxy_files == state['protected']['proxy_nginx_files'], 'HISTORICAL_PROXY_NGINX_BYTES_CHANGED')
        bridge = self.runtime.inspect('network', 'bridge')
        all_other = {cid: self.runtime.inspect('container', cid) for cid in self.runtime.container_names() if cid != CONTAINER}
        return {'files': files, 'production_container': prod, 'production_units': units,
                'proxy_container': proxy, 'proxy_nginx_files': proxy_files, 'shared_bridge_identity': {k: bridge[k] for k in ('id', 'name', 'driver', 'internal')},
                'shared_bridge_other_endpoints': {cid: item for cid, item in bridge['containers'].items() if cid != CONTAINER},
                'other_containers': all_other, 'other_business_listeners': self.runtime.listeners((5433, *range(8850, 8860))),
                'nginx_paths': sorted(str(path) for path in Path('/etc/nginx').rglob('*') if path.is_file() or path.is_symlink()),
                'certificate_timer': self.runtime.service('oasis-certificate.timer')}

    def historical_pins(self, actual):
        expected = {**self.state['protected']['files'], **self.state['protected']['nginx']}
        for path, pin in expected.items(): require(pin_matches(actual['files'][path], pin), 'HISTORICAL_PROTECTED_PIN_CHANGED')
        require(actual['nginx_paths'] == sorted(self.state['protected']['nginx']), 'UNKNOWN_NGINX_FILE')
        private = self.state['marker']['private_pins']
        for member, pin in private.items():
            require(pin_matches(metadata(BASE / 'production-instance-private' / member), pin), 'PRODUCTION_PRIVATE_PIN_CHANGED')
        require(pin_matches(actual['files'][str(BASE / 'production-current')], self.state['production_pin'])
                and pin_matches(actual['files'][str(BASE / 'production-instance-private/installation.json')], self.state['marker_pin']), 'PRODUCTION_SOURCE_OR_MARKER_CHANGED')
        require(actual['files'][self.state['runtime_profile']['release'] + '/RELEASE-MANIFEST.json']['sha256']
                == self.state['runtime_profile']['manifest_sha256'], 'PRODUCTION_MANIFEST_CHANGED')
        for unit, pin in self.state['units']['files'].items():
            require(pin_matches(actual['files']['/etc/systemd/system/' + unit], pin), 'PRODUCTION_UNIT_FILE_CHANGED')
        current = self.state['protected']['files'][str(BASE / 'current')]['leaf']
        manifest = decode(Path(current, 'RELEASE-MANIFEST.json').read_bytes())
        members = manifest
        for member in ('platform/deploy/backup.sh', 'platform/deploy/monitor.mjs', 'platform/server/index.mjs'):
            require(metadata(current + '/' + member)['sha256'] == members[member], 'PUBLIC_EXECUTABLE_SOURCE_CHANGED')

    def resources(self, *, running=True):
        container = self.runtime.inspect('container', CONTAINER)
        require(container['id'] == CONTAINER and container['name'] == '/' + NAME
                and container['running'] is running and len(container['mounts']) == 1
                and container['mounts'][0].get('Name') == VOLUME
                and container['mounts'][0].get('Type') == 'volume'
                and container['mounts'][0].get('Destination') == '/var/lib/postgresql/data'
                and set(container['networks']) == {'bridge'}, 'PUBLIC_CONTAINER_IDENTITY_UNKNOWN')
        require(container['ports'] == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18883'}]}, 'PUBLIC_DATABASE_PORT_UNKNOWN')
        volume = self.runtime.inspect('volume', VOLUME)
        require(volume['name'] == VOLUME and volume['driver'] == 'local' and volume['options'] is None
                and volume['scope'] == 'local' and volume['mountpoint'] == '/var/lib/docker/volumes/' + VOLUME + '/_data', 'PUBLIC_VOLUME_IDENTITY_UNKNOWN')
        consumers = []
        for cid in self.runtime.container_names():
            c = self.runtime.inspect('container', cid)
            if any(m.get('Name') == VOLUME for m in c['mounts']): consumers.append(cid)
        require(consumers == [CONTAINER], 'FOREIGN_PUBLIC_VOLUME_CONSUMER')
        return {'container': container, 'volume': volume, 'volume_consumers': consumers}

    def services(self):
        result = {}
        for unit in UNITS:
            value = self.runtime.service(unit)
            require(value.get('FragmentPath') == '/etc/systemd/system/' + unit and value.get('DropInPaths') == ''
                    and value.get('NeedDaemonReload') == 'no', 'PUBLIC_UNIT_SCOPE_UNKNOWN')
            require(not value.get('BoundBy'), 'PUBLIC_UNIT_FOREIGN_DEPENDENT')
            dependents = set((value.get('RequiredBy', '') + ' ' + value.get('WantedBy', '') + ' ' + value.get('TriggeredBy', '')).split())
            require(dependents <= {*UNITS, 'multi-user.target', 'timers.target'}, 'PUBLIC_UNIT_FOREIGN_DEPENDENT')
            if unit.endswith('.service'):
                require(value.get('WorkingDirectory', '') == ('/opt/oasis/current/platform' if unit != 'oasis-backup.service' else ''), 'PUBLIC_WORKING_DIRECTORY_UNKNOWN')
                value['commands'] = self.runtime.loaded_commands(unit)
            else: require(value.get('Triggers') == unit.replace('.timer', '.service'), 'PUBLIC_TIMER_TARGET_UNKNOWN')
            result[unit] = value
        return result

    def retired_services(self, original):
        result = self.services()
        static_jobs = {'oasis-backup.service': 'oasis-backup.timer', 'oasis-monitor.service': 'oasis-monitor.timer'}
        for unit, value in result.items():
            expected_state = 'static' if unit in static_jobs and original[unit].get('UnitFileState') == 'static' else 'disabled'
            require(value.get('ActiveState') == 'inactive' and value.get('MainPID', '0') == '0'
                    and value.get('ControlPID', '0') == '0' and value.get('UnitFileState') == expected_state,
                    'PUBLIC_UNIT_NOT_RETIRED')
            if expected_state == 'static':
                timer = result[static_jobs[unit]]
                require(timer.get('ActiveState') == 'inactive' and timer.get('UnitFileState') == 'disabled'
                        and timer.get('MainPID', '0') == timer.get('ControlPID', '0') == '0'
                        and not any(value.get(key) for key in ('BoundBy', 'RequiredBy', 'WantedBy', 'PartOf'))
                        and set(value.get('TriggeredBy', '').split()) <= {static_jobs[unit]}, 'STATIC_JOB_NOT_RETIRED')
        return result

    def audit(self):
        original = NGINX.read_bytes(); require(metadata(NGINX)['sha256'] == digest(original), 'NGINX_CHANGED')
        require(digest(original) == self.state['protected']['nginx'][str(NGINX)]['sha256'], 'ORIGINAL_NGINX_BYTES_CHANGED')
        candidate = retirement_nginx(original)
        resources = self.resources(); services = self.services()
        current = self.state['protected']['files'][str(BASE / 'current')]['leaf']
        processes = self.runtime.processes(current)
        main_pids = {int(services[unit]['MainPID']) for unit in ('oasis-api.service', 'oasis-demo.service')}
        require(main_pids <= {row['pid'] for row in processes} and 0 not in main_pids, 'PUBLIC_MAIN_PROCESS_MISSING')
        clients = self.runtime.database_clients([int(services['oasis-api.service']['MainPID'])], resources['container'])
        self.runtime.run(['nginx', '-t'])
        database = self.runtime.database(); protections = self.protections(); self.historical_pins(protections)
        self.runtime.http(PLAYER + '/health', 200, environment='production')
        return {'schema': 1, 'kind': 'public-sandbox-retirement-inventory', 'passed': True, 'read_only': True, 'at': now(),
                'tool_sha256': digest(Path(__file__).read_bytes()), 'production_proof_pin': self.proof_pin,
                'scope': {'container_id': CONTAINER, 'volume': VOLUME, 'database': DATABASE, 'units': list(UNITS), 'ports': list(PORTS), 'nginx': str(NGINX)},
                'database': database, 'resources': resources, 'services': services, 'processes': processes,
                'nginx_before_sha256': digest(original), 'nginx_after_sha256': digest(candidate),
                'protections': protections, 'database_clients': clients, 'listeners_before': self.runtime.listeners()}

    def check(self, inventory):
        require(inventory.get('kind') == 'public-sandbox-retirement-inventory' and inventory.get('passed') is True
                and inventory.get('read_only') is True, 'INVENTORY_REQUIRED'); fresh(inventory['at'])
        actual = self.audit()
        actual_fields = {k: v for k, v in actual.items() if k != 'at'}
        expected_fields = {k: v for k, v in inventory.items() if k != 'at'}
        raw_differences = exact_differences(expected_fields, actual_fields)
        actual_fields = copy.deepcopy(actual_fields); expected_fields = copy.deepcopy(expected_fields)
        actual_fields['database_clients'] = verified_client_scope(actual_fields['database_clients'])
        expected_fields['database_clients'] = verified_client_scope(expected_fields['database_clients'])
        activity_paths = tuple('/database_clients/' + key for key in CLIENT_ACTIVITY_FIELDS)
        allowed_differences = [row for row in raw_differences if any(row['path'] == path or row['path'].startswith(path + '/')
                                                                   for path in activity_paths)]
        if actual_fields['database_clients'] != expected_fields['database_clients']: allowed_differences = []
        protection = None
        if 'protections' in actual_fields and 'protections' in expected_fields:
            protection = protection_comparison(expected_fields['protections'], actual_fields['protections'])
            actual_fields['protections'] = normalized_protections(actual_fields['protections'])
            expected_fields['protections'] = normalized_protections(expected_fields['protections'])
            allowed_differences += [{**row, 'path': '/protections' + row['path']}
                                    for row in protection['allowed_observed_differences']]
        comparison = {'ignored_fields': ['at'], 'expected_inventory': copy.deepcopy(inventory),
                      'actual_inventory': copy.deepcopy(actual), 'differences': raw_differences,
                      'verified_activity_fields': list(CLIENT_ACTIVITY_FIELDS), 'allowed_observed_differences': allowed_differences,
                      'stable_differences': exact_differences(expected_fields, actual_fields)}
        if protection is not None: comparison['protection_comparison'] = protection
        if actual_fields != expected_fields: raise InventoryChanged(comparison)
        return {'schema': 1, 'kind': 'public-sandbox-retirement-check', 'at': now(), 'passed': True, 'read_only': True,
                'inventory_sha256': digest(canonical(inventory)), 'tool_sha256': actual['tool_sha256'], 'comparison': comparison}

    def apply(self, inventory, check, check_sha, output):
        require(check.get('kind') == 'public-sandbox-retirement-check' and check.get('passed') is True
                and check.get('read_only') is True and check.get('inventory_sha256') == digest(canonical(inventory))
                and check.get('tool_sha256') == digest(Path(__file__).read_bytes()), 'APPLY_CHECK_PIN_MISMATCH')
        fresh(check['at']); output_guard(output)
        receipt = {'schema': 1, 'kind': 'public-sandbox-retirement-receipt', 'at': now(), 'passed': False,
                   'production_proof_pin': self.proof_pin, 'inventory_sha256': digest(canonical(inventory)),
                   'check_sha256': check_sha, 'tool_sha256': check['tool_sha256'], 'history': [], 'protection_comparisons': []}
        original = NGINX.read_bytes(); candidate = retirement_nginx(original)
        expected = copy.deepcopy(inventory['protections']); expected['files'].pop(str(NGINX))
        def preserved():
            lock_guard()
            comparison = protection_comparison(expected, self.protections(changed_nginx=digest(candidate)))
            receipt['protection_comparisons'].append(comparison)
            require(comparison['passed'], 'PRESERVED_PRODUCTION_OR_SHARED_SCOPE_CHANGED')
        def mutate(argv):
            lock_guard(); return self.runtime.run(argv)
        with held_locks() as lock_guard:
            try:
                receipt['pre_mutation_check'] = self.check(inventory)
            except Refusal as error:
                receipt.update(phase='before_mutation_refused', at=now(), no_business_mutation=True,
                               refusal=type(error).__name__ + ':' + str(error),
                               comparison=getattr(error, 'comparison', {'expected_inventory': copy.deepcopy(inventory),
                                                                       'actual_inventory': None, 'audit_incomplete': True}))
                write_new(output, receipt)
                raise
            try:
                started_path = Path(output).with_name(Path(output).name + '.started.json')
                started = {**receipt, 'phase': 'before_mutation', 'nginx_before': {
                    'path': str(NGINX), 'sha256': digest(original), 'body_utf8': original.decode('utf-8')}}
                write_new(started_path, started)
                receipt['started_record'] = {'path': str(started_path), 'sha256': digest(canonical(started))}
                self.runtime.run(['nginx', '-t'])
                lock_guard()
                replace_nginx(original, candidate)
                try: self.runtime.run(['nginx', '-t'])
                except Exception:
                    replace_nginx(candidate, original); self.runtime.run(['nginx', '-t']); raise
                mutate(['systemctl', 'reload', 'nginx']); receipt['history'].append('public_routes_closed')
                preserved()
                for unit in UNITS:
                    self.services()  # Revalidate effective stop hooks and target before each action.
                    mutate(['systemctl', 'stop', unit]); mutate(['systemctl', 'disable', unit])
                receipt['history'].append('public_units_stopped_disabled')
                require(not self.runtime.processes(self.state['protected']['files'][str(BASE / 'current')]['leaf']), 'PUBLIC_PROCESS_REMAINS')
                self.retired_services(inventory['services'])
                settled = self.runtime.database(); pending_free(settled)
                require(settled == inventory['database'], 'POST_STOP_DATABASE_CHANGED')
                resources = self.resources(); preserved()
                clients_after_stop = self.runtime.database_clients([], resources['container'], stopped=True)
                mutate(['docker', 'stop', '--time', '30', CONTAINER]); receipt['history'].append('public_database_stopped')
                self.resources(running=False); preserved()
                mutate(['docker', 'rm', CONTAINER]); receipt['history'].append('public_container_removed')
                require(CONTAINER not in self.runtime.container_names(), 'PUBLIC_CONTAINER_REMAINS')
                require(not self.runtime.output(['docker', 'ps', '-aq', '--filter', 'volume=' + VOLUME]), 'VOLUME_CONSUMER_AFTER_REMOVE')
                require(self.runtime.inspect('volume', VOLUME) == inventory['resources']['volume'], 'VOLUME_CHANGED_BEFORE_DELETE')
                preserved(); mutate(['docker', 'volume', 'rm', VOLUME]); receipt['history'].append('public_data_volume_removed')
                require(VOLUME not in self.runtime.output(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines(), 'PUBLIC_DATA_VOLUME_REMAINS')
                require(not self.runtime.listeners(), 'PUBLIC_PORT_REMAINS')
                preserved(); self.runtime.run(['nginx', '-t'])
                app = self.proof['committed_policy']['app_id']; query = '?app_id=' + app + '&handoff=retirement'
                routes = [self.runtime.http(PUBLIC + route, 410) for route in ('/', '/demo', '/demo/', '/api/demo', '/api/demo/config', '/api/admin/games', '/health', '/downloads/android-smoke-build.json', '/downloads/oasis-partner-sandbox-kit.zip')]
                routes += [self.runtime.http(PUBLIC + '/player' + query, 302, location=PLAYER + '/player' + query),
                           self.runtime.http(PLAYER + '/health', 200, environment='production'), self.runtime.http(PLAYER + '/player?app_id=' + app, 200)]
                receipt.update(passed=True, phase='complete', at=now(), database_before_delete=settled, database_clients_after_stop=clients_after_stop,
                               purged_settled_presentations={'count': settled['pending_presentations'], 'proofs': settled['settled_presentations'],
                                    'action': 'deleted_with_exclusive_sandbox_volume', 'acknowledgement_performed': False},
                               public_units_after=self.retired_services(inventory['services']), https=routes,
                               protections_after=receipt['protection_comparisons'][-1]['actual_protections'], protection_handoff={
                                   'historical_inputs_preserved': True, 'previous_public_snapshot_sha256': digest(canonical(self.state['protected'])),
                                   'revoked': {'container_id': CONTAINER, 'volume': VOLUME, 'public_units': list(UNITS), 'sandbox_health_demo_200': True,
                                               'nginx_before_sha256': digest(original), 'public_processes': inventory.get('processes', []),
                                               'former_service_pins': {unit: value for unit, value in self.state['protected'].get('services', {}).items() if unit in UNITS}},
                                   'replacement': {'nginx_sha256': digest(candidate), 'public_routes': '410', 'player_redirect': PLAYER + '/player$is_args$args'},
                                   'future_controller_rule': 'Verify this exact receipt and its unchanged retained protections; keep historical guards immutable.'})
            except Exception as error:
                receipt.update(phase='partial_refusal', at=now(), refusal=type(error).__name__ + ':' + str(error))
                write_new(output, receipt); raise
            write_new(output, receipt)
        return receipt


def replace_nginx(expected, replacement):
    require(NGINX.read_bytes() == expected, 'NGINX_BYTES_CHANGED_BEFORE_REPLACE')
    before = metadata(NGINX); require(before['uid'] == before['gid'] == 0 and before['mode'] == 0o644, 'NGINX_METADATA_UNSAFE')
    pending = NGINX.with_name('oasis.conf.public-retirement-pending')
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, 'wb') as stream: stream.write(replacement); stream.flush(); os.fsync(stream.fileno())
        require(metadata(NGINX) == before, 'NGINX_CHANGED_DURING_REPLACE'); os.replace(pending, NGINX)
    finally:
        if pending.exists(): pending.unlink()


@contextmanager
def held_locks():
    values = []
    try:
        for path in LOCKS:
            pin = metadata(path); require(pin['kind'] == 'file' and pin['uid'] == pin['gid'] == 0, 'SHARED_LOCK_UNSAFE')
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW); values.append((fd, path, pin))
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require((os.fstat(fd).st_dev, os.fstat(fd).st_ino) == (pin['device'], pin['inode']) and metadata(path) == pin, 'SHARED_LOCK_REPLACED')
        def guard():
            require(all(metadata(path) == pin and (os.fstat(fd).st_dev, os.fstat(fd).st_ino) == (pin['device'], pin['inode'])
                        for fd, path, pin in values), 'SHARED_LOCK_CHANGED')
        yield guard
        guard()
    finally:
        for fd, _, _ in reversed(values): os.close(fd)


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument('mode', choices=('audit', 'check', 'apply'), nargs='?', default='audit')
    value.add_argument('--production-proof', type=Path, required=True)
    value.add_argument('--production-proof-sha256', required=True)
    value.add_argument('--inventory', type=Path); value.add_argument('--inventory-sha256')
    value.add_argument('--check', type=Path); value.add_argument('--check-sha256')
    value.add_argument('--apply', action='store_true', help='Explicit deletion of only the fixed public sandbox container/data volume')
    value.add_argument('--output', type=Path, required=True)
    return value


def main():
    args = parser().parse_args(); require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(args.apply is (args.mode == 'apply'), 'EXPLICIT_APPLY_REQUIRED')
    output_guard(args.output)
    proof, pin = read_pinned(args.production_proof, args.production_proof_sha256)
    retire = Retirer(proof, {'path': str(args.production_proof), **pin})
    if args.mode == 'audit': write_new(args.output, retire.audit())
    else:
        inventory, _ = read_pinned(args.inventory, args.inventory_sha256)
        if args.mode == 'check':
            try: result = retire.check(inventory)
            except InventoryChanged as error:
                write_new(args.output, {'schema': 1, 'kind': 'public-sandbox-retirement-check', 'at': now(),
                          'passed': False, 'read_only': True, 'no_business_mutation': True,
                          'inventory_sha256': digest(canonical(inventory)), 'tool_sha256': digest(Path(__file__).read_bytes()),
                          'refusal': type(error).__name__ + ':' + str(error), 'comparison': error.comparison})
                raise
            write_new(args.output, result)
        else:
            check, _ = read_pinned(args.check, args.check_sha256)
            retire.apply(inventory, check, args.check_sha256, args.output)


if __name__ == '__main__':
    try: main()
    except (Refusal, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'passed': False, 'refusal': type(error).__name__ + ':' + str(error)})); raise SystemExit(1)
