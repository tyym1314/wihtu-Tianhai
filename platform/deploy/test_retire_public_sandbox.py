"""Local temporary-filesystem/fake-runtime checks; never SSH, Docker or Android."""
from contextlib import nullcontext
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import types

SPEC = importlib.util.spec_from_file_location('retire_public_sandbox', Path(__file__).with_name('retire-public-sandbox.py'))
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)


def database(**changes):
    value = {'environment': 'sandbox', 'database': m.DATABASE, 'database_oid': 16384,
             'apps': [{'id': 'test-app-' + str(n), 'environment': 'sandbox', 'partner_id': 'test-partner',
                       'wallet_scope_id': 'test-wallet-' + str(n), 'wallet_url': '', 'status': 'active'} for n in range(4)],
             'sessions': 1191, 'rooms': 812, 'wallet_users': 306, 'non_sandbox_apps': 0,
             'non_sandbox_wallet_scopes': 0, 'transfer_schema': 'present', 'settled_presentations': [], **{key: 0 for key in m.PENDING}}
    value.update(changes); return value


def proof():
    return {'passed': True, 'phase': 'complete_free_open', 'target_release': '/opt/oasis/releases/20261010-06',
            'committed_policy': {'state': 'open', 'app_id': 'real-app'}, 'final': {'state': {
                'runtime_profile': {'public_origin': m.PLAYER}, 'resources': {'container_id': 'b' * 64,
                    'volume': {'name': 'oasis-production-pgdata'}},
                'protected': {'files': {str(m.BASE / 'current'): {'leaf': '/opt/oasis/releases/20261009-03'}},
                              'proxy_nginx_files': ['a' * 64 + '  /etc/nginx/nginx.conf']}}}}


def presentation_database(session=None):
    value = database(); session = session or next(iter(m.SETTLED_PRESENTATION_SCOPE))
    app, game, index, rounds, has_play = m.SETTLED_PRESENTATION_SCOPE[session]
    value['apps'][0].update(id=app)
    scope = {'app_id': app, 'partner_id': 'test-partner', 'environment': 'sandbox', 'wallet_scope_id': 'test-wallet-0', 'currency_id': 'COIN'}
    row = {'session_sha256': session,
           'app_scope': scope, 'game_id': game, 'next_index': index, 'round_count': rounds, 'has_pending_play': has_play,
           'state_type': 'object', 'cycle_status': 'SETTLED', 'cycle_session_sha256': session,
           'cycle_app_id': app, 'cycle_game_id': game, 'cycle_environment': 'sandbox', **m.SETTLED_PRESENTATION_PROOFS[session]}
    value.update(pending_presentations=1, settled_presentations=[row]); return value


def connection(namespace, inode, local, remote, owner):
    return {'namespace': namespace, 'inode': str(inode), 'local': list(local), 'remote': list(remote), 'owners': [owner]}


def pg_client(addr='172.17.0.1', port=40000):
    return {'pid': 660, 'database': m.DATABASE, 'user': 'oasis', 'client_addr': addr, 'client_port': port}


def verified_clients(count=1, *, allowed_pids=None):
    rows = []; clients = []
    for index in range(count):
        rows.extend([connection('host', index * 4 + 1, ('127.0.0.1', 45000 + index), ('127.0.0.1', 18883), 41),
                     connection('host', index * 4 + 2, ('127.0.0.1', 18883), ('127.0.0.1', 45000 + index), 50),
                     connection('host', index * 4 + 3, ('172.17.0.1', 40000 + index), ('172.17.0.2', 5432), 50),
                     connection('postgres', index * 4 + 4, ('172.17.0.2', 5432), ('172.17.0.1', 40000 + index), 100 + index)])
        clients.append({**pg_client(port=40000 + index), 'pid': 660 + index})
    return m.database_connections_guard({'audit_backend_pid': 900, 'clients': clients}, rows,
                target_ip='172.17.0.2', target_namespace='postgres', allowed_pids=[41] if allowed_pids is None else allowed_pids, proxy_pids=[50])


class FakeRuntime:
    def __init__(self):
        self.commands = []; self.database_value = database(); self.live = True; self.container_exists = True
        self.volume_exists = True; self.foreign_volume = False; self.protected_changed = False
        self.stopped = set(); self.disabled = set(); self.fail_nginx = False; self.nginx_tests = 0
        self.changed_after_stop = False; self.pending_after_stop = False
        self.extra_volume_after_stop = False
        self.post_stop_client = False; self.proxy_files_changed_after_stop = False
        self.static_jobs = {'oasis-backup.service', 'oasis-monitor.service'}
        self.client_count = 0
        self.proxy_files = ['a' * 64 + '  /etc/nginx/nginx.conf']
        self.container = {'id': m.CONTAINER, 'name': '/' + m.NAME, 'image': 'sha256:' + 'a' * 64,
                          'running': True, 'pid': 12, 'mounts': [{'Type': 'volume', 'Name': m.VOLUME,
                              'Destination': '/var/lib/postgresql/data'}], 'networks': {'bridge': {}},
                          'ports': {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18883'}]}, 'restart': {'Name': 'unless-stopped'}}
        self.volume = {'name': m.VOLUME, 'driver': 'local', 'options': None, 'scope': 'local',
                       'mountpoint': '/var/lib/docker/volumes/' + m.VOLUME + '/_data'}

    def inspect(self, kind, name):
        if kind == 'volume': return copy.deepcopy(self.volume)
        value = copy.deepcopy(self.container)
        if name != m.CONTAINER: value['id'] = name
        value['running'] = self.live
        return value

    def container_names(self):
        return ([m.CONTAINER] if self.container_exists else []) + (['c' * 64] if self.foreign_volume else [])

    def service(self, unit):
        return {'ActiveState': 'inactive' if unit in self.stopped else 'active',
                'MainPID': '0' if unit in self.stopped or unit.endswith('.timer') else '41', 'ControlPID': '0',
                'UnitFileState': 'static' if unit in self.static_jobs else 'disabled' if unit in self.disabled else 'enabled',
                'FragmentPath': '/etc/systemd/system/' + unit, 'DropInPaths': '', 'NeedDaemonReload': 'no',
                'BoundBy': '', 'RequiredBy': '', 'WantedBy': '', 'TriggeredBy': '',
                'Triggers': unit.replace('.timer', '.service') if unit.endswith('.timer') else '',
                'WorkingDirectory': '' if unit == 'oasis-backup.service' or unit.endswith('.timer') else '/opt/oasis/current/platform'}

    def loaded_commands(self, unit):
        return m.loaded_commands_guard(unit, {key: [{'path': m.EXPECTED_START[unit][0],
               'argv': list(m.EXPECTED_START[unit]), 'ignore_errors': False}] if key == 'ExecStart' else []
               for key in ('ExecStartPre', 'ExecStart', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload')})

    def processes(self, current): return [] if set(m.UNITS) <= self.stopped else [{'pid': 41}]
    def listeners(self): return [] if not self.live else ['127.0.0.1:18883']
    def proxy_nginx_files(self, container_id): return list(self.proxy_files)
    def database_clients(self, allowed_pids, container, *, stopped=False):
        if stopped and self.post_stop_client: raise m.Refusal('UNKNOWN_POSTGRES_CLIENT')
        return verified_clients(0 if stopped else self.client_count, allowed_pids=allowed_pids)

    def database(self):
        value = copy.deepcopy(self.database_value)
        if self.pending_after_stop and set(m.UNITS) <= self.stopped: value['pending_rooms'] = 1
        m.pending_free(value); return value

    def run(self, argv, **kwargs):
        self.commands.append(tuple(argv))
        if argv == ['nginx', '-t']:
            self.nginx_tests += 1
            if self.fail_nginx and self.nginx_tests == 2: raise m.Refusal('NGINX_TEST_FAILED')
        elif argv[:2] == ['systemctl', 'stop']:
            self.stopped.add(argv[2])
            if self.changed_after_stop: self.protected_changed = True
            if self.proxy_files_changed_after_stop: self.proxy_files[0] = 'b' * 64 + '  /etc/nginx/nginx.conf'
        elif argv[:2] == ['systemctl', 'disable']: self.disabled.add(argv[2])
        elif argv[:2] == ['docker', 'stop']:
            self.live = False
            if self.extra_volume_after_stop: self.foreign_volume = True
        elif argv[:2] == ['docker', 'rm']: self.container_exists = False
        elif argv[:3] == ['docker', 'volume', 'rm']: self.volume_exists = False
        return types.SimpleNamespace(stdout='', stderr='', returncode=0)

    def output(self, argv, **kwargs):
        if argv[:3] == ['docker', 'volume', 'ls']: return m.VOLUME if self.volume_exists else ''
        if argv[:3] == ['docker', 'ps', '-aq']: return 'c' * 64 if self.foreign_volume else ''
        return self.run(argv, **kwargs).stdout

    def http(self, url, status, **kwargs): return {'url': url, 'status': status, 'location': kwargs.get('location'), 'strict_tls': True}


class FakeRetirer(m.Retirer):
    def protections(self, *, changed_nginx=None):
        proxy_files = self.runtime.proxy_nginx_files('d' * 64)
        m.require(proxy_files == self.state['protected']['proxy_nginx_files'], 'HISTORICAL_PROXY_NGINX_BYTES_CHANGED')
        value = {'files': {str(m.NGINX): {'sha256': m.digest(m.NGINX.read_bytes())}},
                 'production_container': {'id': 'b' * 64, 'running': True}, 'certificate_timer': {'active': True, 'Requires': '-.mount sysinit.target'},
                 'production_units': {unit: {'Requires': 'sysinit.target system.slice'} for unit in m.PRODUCTION_REQUIRES_UNITS},
                 'shared_bridge_identity': {'id': 'bridge-kept'}, 'other_site_sha256': 'd' * 64, 'proxy_nginx_files': proxy_files}
        if self.runtime.protected_changed: value['other_site_sha256'] = 'e' * 64
        if changed_nginx:
            m.require(value['files'][str(m.NGINX)]['sha256'] == changed_nginx, 'NEW_NGINX_HASH_CHANGED')
            value['files'].pop(str(m.NGINX))
        return value

    def audit(self):
        return {'schema': 1, 'kind': 'public-sandbox-retirement-inventory', 'passed': True,
                'read_only': True, 'at': m.now(), 'tool_sha256': m.digest(Path(m.__file__).read_bytes()),
                'production_proof_pin': self.proof_pin, 'database': self.runtime.database(),
                'resources': self.resources(), 'services': self.services(),
                'database_clients': self.runtime.database_clients([41], self.resources()['container']),
                'protections': self.protections()}


class ContractTests(unittest.TestCase):
    def protection_fixture(self):
        return {'certificate_timer': {'Requires': '-.mount sysinit.target'},
                'production_units': {unit: {'Requires': 'sysinit.target system.slice'} for unit in m.PRODUCTION_REQUIRES_UNITS},
                'files': {'/preserved': {'sha256': 'a' * 64}}, 'pid': 42}

    def test_only_nine_requires_orders_are_semantic_and_raw_evidence_is_retained(self):
        expected = self.protection_fixture(); actual = copy.deepcopy(expected)
        actual['certificate_timer']['Requires'] = 'sysinit.target -.mount'
        for row in actual['production_units'].values(): row['Requires'] = 'system.slice sysinit.target'
        comparison = m.protection_comparison(expected, actual)
        self.assertTrue(comparison['passed']); self.assertEqual(len(comparison['differences']), 9)
        self.assertEqual(comparison['differences'], comparison['allowed_observed_differences'])
        self.assertEqual(comparison['stable_differences'], [])
        self.assertEqual(comparison['expected_protections'], expected); self.assertEqual(comparison['actual_protections'], actual)
        actual['pid'] = 43
        comparison = m.protection_comparison(expected, actual)
        self.assertFalse(comparison['passed']); self.assertEqual(comparison['stable_differences'][0]['path'], '/pid')
        self.assertEqual(len(comparison['allowed_observed_differences']), 9)

    def test_requires_members_duplicates_types_and_empty_tokens_refuse(self):
        expected = self.protection_fixture()
        for value in ('sysinit.target', 'sysinit.target unknown.service'):
            actual = copy.deepcopy(expected); actual['certificate_timer']['Requires'] = value
            self.assertFalse(m.protection_comparison(expected, actual)['passed'])
        for value in ('', 'sysinit.target  -.mount', ' sysinit.target', 'sysinit.target ', 'sysinit.target\t-.mount',
                      'sysinit.target sysinit.target', ['sysinit.target'], None, 1):
            with self.subTest(value=value):
                actual = copy.deepcopy(expected); actual['certificate_timer']['Requires'] = value
                with self.assertRaises(m.Refusal): m.protection_comparison(expected, actual)
        actual = copy.deepcopy(expected); actual['certificate_timer'].pop('Requires')
        with self.assertRaises(m.Refusal): m.protection_comparison(expected, actual)
        actual = copy.deepcopy(expected); actual['production_units']['unknown.service'] = {'Requires': 'sysinit.target'}
        with self.assertRaises(m.Refusal): m.protection_comparison(expected, actual)

    def test_check_records_requires_reorder_but_keeps_all_other_pins_exact(self):
        expected = {'kind': 'public-sandbox-retirement-inventory', 'passed': True, 'read_only': True,
                    'at': m.now(), 'tool_sha256': 'a' * 64, 'database_clients': verified_clients(), 'protections': self.protection_fixture()}
        actual = copy.deepcopy(expected); actual['protections']['certificate_timer']['Requires'] = 'sysinit.target -.mount'
        retire = object.__new__(m.Retirer); retire.audit = lambda: actual
        checked = retire.check(expected)
        self.assertEqual(checked['comparison']['allowed_observed_differences'][0]['path'], '/protections/certificate_timer/Requires')
        actual['protections']['pid'] += 1
        with self.assertRaises(m.InventoryChanged): retire.check(expected)

    def test_strict_check_retains_raw_snapshots_and_exact_differences(self):
        expected = {'kind': 'public-sandbox-retirement-inventory', 'passed': True, 'read_only': True,
                    'at': m.now(), 'tool_sha256': 'a' * 64, 'database_clients': verified_clients(), 'database': {'database_oid': 16384}}
        actual = copy.deepcopy(expected); actual['at'] = m.now()
        retire = object.__new__(m.Retirer); retire.audit = lambda: actual
        checked = retire.check(expected)
        self.assertEqual(checked['comparison']['expected_inventory'], expected)
        self.assertEqual(checked['comparison']['actual_inventory'], actual)
        self.assertEqual(checked['comparison']['differences'], [])
        actual['database']['database_oid'] = 16385
        with self.assertRaises(m.InventoryChanged) as caught: retire.check(expected)
        diagnostic = caught.exception.comparison
        self.assertEqual(diagnostic['differences'], [{'path': '/database/database_oid', 'expected': 16384, 'actual': 16385}])
        self.assertEqual(diagnostic['actual_inventory'], actual)
        self.assertEqual(diagnostic['expected_inventory'], expected)
        actual['database']['database_oid'] = 16386
        self.assertEqual(diagnostic['actual_inventory']['database']['database_oid'], 16385)

    def test_main_check_refusal_writes_diagnostic_through_scoped_writer(self):
        expected = {'kind': 'public-sandbox-retirement-inventory', 'passed': True, 'read_only': True,
                    'at': m.now(), 'tool_sha256': 'a' * 64, 'database_clients': verified_clients()}
        actual = {**expected, 'tool_sha256': 'b' * 64}
        retire = object.__new__(m.Retirer); retire.audit = lambda: actual
        output = m.TASK / 'new-check-refusal.json'
        args = types.SimpleNamespace(mode='check', apply=False, output=output,
               production_proof=Path('/proof'), production_proof_sha256='a' * 64,
               inventory=Path('/inventory'), inventory_sha256='b' * 64)
        with patch.object(m, 'parser') as parse, patch.object(m.os, 'geteuid', return_value=0), \
             patch.object(m, 'output_guard') as scoped, patch.object(m, 'read_pinned', side_effect=[({}, {}), (expected, {})]), \
             patch.object(m, 'Retirer', return_value=retire), patch.object(m, 'write_new') as write:
            parse.return_value.parse_args.return_value = args
            with self.assertRaises(m.InventoryChanged): m.main()
            scoped.assert_called_once_with(output)
            path, value = write.call_args.args
            self.assertEqual(path, output); self.assertFalse(value['passed'])
            self.assertTrue(value['read_only']); self.assertTrue(value['no_business_mutation'])
            self.assertEqual(value['comparison']['actual_inventory'], actual)
            self.assertEqual(value['comparison']['expected_inventory'], expected)

    def test_known_verified_pool_growth_shrink_and_idle_keep_full_raw_differences(self):
        for before, after in ((1, 2), (2, 1), (1, 0), (0, 1)):
            with self.subTest(before=before, after=after):
                expected = {'kind': 'public-sandbox-retirement-inventory', 'passed': True, 'read_only': True,
                            'at': m.now(), 'tool_sha256': 'a' * 64, 'database_clients': verified_clients(before)}
                actual = {**expected, 'database_clients': verified_clients(after)}
                retire = object.__new__(m.Retirer); retire.audit = lambda: actual
                checked = retire.check(expected); comparison = checked['comparison']
                self.assertTrue(checked['passed']); self.assertEqual(comparison['stable_differences'], [])
                self.assertEqual(comparison['allowed_observed_differences'], comparison['differences'])
                self.assertEqual(len(comparison['differences']), 5)
                self.assertEqual(comparison['actual_inventory']['database_clients'], actual['database_clients'])
                self.assertEqual(comparison['expected_inventory']['database_clients'], expected['database_clients'])

    def test_changed_client_identity_scope_or_foreign_rows_cannot_bypass_check(self):
        expected = {'kind': 'public-sandbox-retirement-inventory', 'passed': True, 'read_only': True,
                    'at': m.now(), 'tool_sha256': 'a' * 64, 'database_clients': verified_clients()}
        actual = copy.deepcopy(expected); retire = object.__new__(m.Retirer); retire.audit = lambda: actual
        actual['database_clients']['target_connections'][0]['owners'] = [42]
        with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_DATABASE_BRIDGE'): retire.check(expected)
        for key in m.CLIENT_SCOPE_FIELDS:
            with self.subTest(scope=key):
                actual = copy.deepcopy(expected); value = actual['database_clients']
                if key == 'api_pids':
                    value[key] = [42]; value['loopback_connections'][0]['owners'] = [42]
                elif key == 'proxy_pids':
                    value[key] = [51]
                    for field in ('target_connections', 'proxy_inbound_connections'): value[field][0]['owners'] = [51]
                elif key == 'target_ip':
                    value[key] = '172.17.0.3'; value['target_connections'][0]['remote'][0] = value[key]
                    value['target_server_connections'][0]['local'][0] = value[key]
                else:
                    value[key] = 'different'; value['target_server_connections'][0]['namespace'] = value[key]
                with self.assertRaisesRegex(m.InventoryChanged, 'LIVE_INVENTORY') as caught: retire.check(expected)
                self.assertEqual(caught.exception.comparison['allowed_observed_differences'], [])
        actual = copy.deepcopy(expected); actual['database_clients']['target_namespace'] = 'different'
        with self.assertRaisesRegex(m.Refusal, 'ATTRIBUTION_MISMATCH'): retire.check(expected)
        actual = copy.deepcopy(expected); actual['database_clients']['unknown_key'] = []
        with self.assertRaisesRegex(m.Refusal, 'ACTIVITY_SCOPE_UNKNOWN'): retire.check(expected)
        actual = copy.deepcopy(expected); actual['database_clients']['target_connections'][0]['unknown_key'] = 'unexpected'
        with self.assertRaisesRegex(m.Refusal, 'SOCKET_SNAPSHOT_UNKNOWN'): retire.check(expected)
        actual = copy.deepcopy(expected); actual['database_clients']['postgres_clients'][0]['client_port'] += 10
        with self.assertRaisesRegex(m.Refusal, 'ATTRIBUTION_MISMATCH'): retire.check(expected)

    def test_post_stop_guard_requires_no_pg_clients_even_for_previous_known_api(self):
        runtime = m.Runtime(); value = verified_clients()
        rows = [row for key in m.CLIENT_ACTIVITY_FIELDS if key != 'postgres_clients' for row in value[key]]
        runtime.network_connections = lambda container: ('172.17.0.2', 'postgres', rows, {50})
        runtime.pg_clients = lambda: {'audit_backend_pid': 900, 'clients': value['postgres_clients']}
        with self.assertRaises(m.Refusal): runtime.database_clients([], {}, stopped=True)
        rows.clear(); value['postgres_clients'].clear()
        after = runtime.database_clients([], {}, stopped=True)
        self.assertEqual(after['postgres_clients'], []); self.assertEqual(after['api_pids'], [])

    def test_all_pending_dimensions_and_missing_counts_refuse(self):
        for key in m.PENDING:
            with self.subTest(key=key):
                with self.assertRaisesRegex(m.Refusal, 'PENDING_'): m.pending_free(database(**{key: 1}))
                row = database(); row.pop(key)
                with self.assertRaisesRegex(m.Refusal, 'COUNTS_INCOMPLETE'): m.pending_free(row)

    def test_foreign_app_and_wallet_data_refuse(self):
        for changes in ({'environment': 'production'}, {'database': 'oasis_production'},
                        {'non_sandbox_apps': 1}, {'non_sandbox_wallet_scopes': 1}):
            with self.subTest(changes=changes), self.assertRaisesRegex(m.Refusal, 'EXCLUSIVE_SANDBOX'):
                m.pending_free(database(**changes))
        row = database(); row['apps'].append(copy.deepcopy(row['apps'][0]))
        with self.assertRaisesRegex(m.Refusal, 'APP_SCOPE_UNKNOWN'): m.pending_free(row)

    def test_sql_is_read_only_includes_presentations_transfer_and_scope(self):
        runtime = m.Runtime(); query = []
        runtime.output = lambda argv, **kwargs: query.append((argv, kwargs['input'])) or json.dumps(database())
        runtime.database()
        argv, sql = query[0]
        self.assertIn(m.CONTAINER, argv); self.assertEqual(argv[-1], m.DATABASE)
        self.assertIn('REPEATABLE READ READ ONLY', sql)
        for expression in ('non_sandbox_wallet_scopes', 'pendingPlay', 'nextIndex', 'TRANSFER_SCHEMA_INCOMPLETE', 'stray_transfer_ledger'):
            self.assertIn(expression, sql)
        self.assertNotRegex(sql, r'\b(?:UPDATE|DELETE|TRUNCATE|DROP|INSERT)\b')

    def test_effective_stop_hooks_or_unknown_start_refuse(self):
        runtime = FakeRuntime(); commands = runtime.loaded_commands('oasis-api.service')
        commands['ExecStop'] = [{'path': '/bin/sh', 'argv': ['/bin/sh', '-c', 'anything'], 'ignore_errors': False}]
        with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_EXECSTOP'): m.loaded_commands_guard('oasis-api.service', commands)
        commands = runtime.loaded_commands('oasis-api.service'); commands['ExecStart'][0]['argv'].append('--other')
        with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_EXECSTART'): m.loaded_commands_guard('oasis-api.service', commands)

    def test_default_is_read_only_and_apply_flag_separate(self):
        args = m.parser().parse_args(['--production-proof', '/tmp/p', '--production-proof-sha256', 'a' * 64, '--output', '/tmp/out'])
        self.assertEqual(args.mode, 'audit'); self.assertFalse(args.apply)

    def test_historical_open06_and_distinct_production_are_required(self):
        value = proof(); value['final']['state']['resources']['container_id'] = m.CONTAINER
        with self.assertRaisesRegex(m.Refusal, 'PRODUCTION_IDENTITY'): m.proof_state(value)
        value = proof(); value['phase'] = 'complete_closed'
        with self.assertRaisesRegex(m.Refusal, 'OPEN06_PROOF'): m.proof_state(value)

    def test_historical_pin_comparison_checks_hash_identity_and_metadata(self):
        actual = {'uid': 0, 'gid': 0, 'mode': 0o600, 'device': 2, 'inode': 3, 'bytes': 5, 'sha256': 'a' * 64, 'kind': 'file'}
        legacy = {'st_uid': 0, 'st_gid': 0, 'st_mode': 0o100600, 'st_dev': 2, 'st_ino': 3, 'st_size': 5, 'sha256': 'a' * 64}
        self.assertTrue(m.pin_matches(actual, legacy))
        for key, value in (('uid', 1), ('mode', 0o644), ('inode', 4), ('bytes', 6), ('sha256', 'b' * 64)):
            self.assertFalse(m.pin_matches({**actual, key: value}, legacy))

    def test_unknown_database_tcp_client_refuses(self):
        rows = [connection('host', 100, ('127.0.0.1', 40000), ('127.0.0.1', 18883), 42)]
        with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_DATABASE_TCP'):
            m.database_connections_guard({'audit_backend_pid': 900, 'clients': []}, rows, target_ip='172.17.0.2',
                                          target_namespace='postgres', allowed_pids=[41], proxy_pids=[])

    def test_foreign_container_namespace_direct_5432_refuses(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for pid, namespace in ((41, 'host'), (42, 'foreign'), (100, 'postgres')):
                for name in ('ns', 'fd', 'net'): (root / str(pid) / name).mkdir(parents=True, exist_ok=True)
                (root / str(pid) / 'ns/net').symlink_to('net:[' + namespace + ']')
                (root / str(pid) / 'exe').symlink_to('/usr/bin/node')
                (root / str(pid) / 'net/tcp').write_text('header\n'); (root / str(pid) / 'net/tcp6').write_text('header\n')
            (root / '42/net/tcp').write_text('header\n0: 030011AC:9C40 020011AC:1538 01 0 0 0 0 0 100\n')
            (root / '100/net/tcp').write_text('header\n0: 020011AC:1538 030011AC:9C40 01 0 0 0 0 0 200\n')
            (root / '42/fd/3').symlink_to('socket:[100]'); (root / '100/fd/3').symlink_to('socket:[200]')
            original_path, original_readlink = Path, m.os.readlink
            def path(value, *parts):
                if str(value).startswith('/proc'): return original_path(folder, str(value)[len('/proc'):].lstrip('/'), *parts)
                return original_path(value, *parts)
            def readlink(value): return original_readlink(path(value))
            runtime = m.Runtime(); runtime.pg_clients = lambda: {'audit_backend_pid': 900, 'clients': [pg_client('172.17.0.3')]}
            container = {'pid': 100, 'networks': {'bridge': {'IPAddress': '172.17.0.2'}}}
            with patch.object(m, 'Path', side_effect=path), patch.object(m.os, 'readlink', side_effect=readlink):
                with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_DATABASE_BRIDGE'):
                    runtime.database_clients([41], container)

    def test_known_api_proxy_backend_and_target_namespace_are_joined(self):
        rows = [connection('host', 1, ('127.0.0.1', 45000), ('127.0.0.1', 18883), 41),
                connection('host', 2, ('127.0.0.1', 18883), ('127.0.0.1', 45000), 50),
                connection('host', 3, ('172.17.0.1', 40000), ('172.17.0.2', 5432), 50),
                connection('postgres', 4, ('172.17.0.2', 5432), ('172.17.0.1', 40000), 100)]
        pg = {'audit_backend_pid': 900, 'clients': [pg_client()]}
        value = m.database_connections_guard(pg, rows, target_ip='172.17.0.2', target_namespace='postgres', allowed_pids=[41], proxy_pids=[50])
        self.assertEqual(value['api_pids'], [41]); self.assertEqual(value['proxy_pids'], [50])
        pg['clients'][0]['client_addr'] = '172.17.0.1/32'
        value = m.database_connections_guard(pg, rows, target_ip='172.17.0.2', target_namespace='postgres', allowed_pids=[41], proxy_pids=[50])
        self.assertEqual(value['api_pids'], [41])
        pg['clients'][0]['client_addr'] = '172.17.0.1/24'
        with self.assertRaisesRegex(m.Refusal, 'ADDRESS_MASK_UNKNOWN'):
            m.database_connections_guard(pg, rows, target_ip='172.17.0.2', target_namespace='postgres', allowed_pids=[41], proxy_pids=[50])
        pg['clients'][0]['client_addr'] = None
        with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_POSTGRES_CLIENT'):
            m.database_connections_guard(pg, rows, target_ip='172.17.0.2', target_namespace='postgres', allowed_pids=[41], proxy_pids=[50])

    def test_pg_query_is_read_only_and_excludes_only_own_audit_backend(self):
        captured = []; runtime = m.Runtime()
        runtime.output = lambda argv, **kwargs: captured.append(kwargs['input']) or '{"audit_backend_pid":900,"clients":[]}'
        runtime.pg_clients(); sql = captured[0]
        self.assertIn('BEGIN READ ONLY', sql); self.assertIn("backend_type='client backend'", sql)
        self.assertIn('pid<>pg_backend_pid()', sql); self.assertIn('host(client_addr)', sql)

    def test_exact_proxy_inherited_listener_flag_and_unknown_variants(self):
        argv = ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-ip', '127.0.0.1', '-host-port', '18883',
                '-container-ip', '172.17.0.4', '-container-port', '5432']
        self.assertTrue(m.proxy_command_matches(argv, '172.17.0.4'))
        self.assertTrue(m.proxy_command_matches(argv + ['-use-listen-fd'], '172.17.0.4'))
        for damaged in (argv + ['-unknown'], argv + ['-use-listen-fd', '1'], argv[:-1] + ['5433'],
                        argv[:4] + ['0.0.0.0'] + argv[5:], argv[:6] + ['18893'] + argv[7:]):
            self.assertFalse(m.proxy_command_matches(damaged, '172.17.0.4'))

    def test_proxy_complete_file_list_and_pin_shape(self):
        runtime = m.Runtime(); rows = ['a' * 64 + '  /etc/nginx/nginx.conf', 'b' * 64 + '  /etc/nginx/conf.d/proxy.conf']
        seen = []; runtime.output = lambda argv: seen.append(argv) or '\n'.join(rows)
        self.assertEqual(runtime.proxy_nginx_files('d' * 64), rows)
        self.assertEqual(seen[0][2], 'd' * 64); self.assertIn('find /etc/nginx -type f', seen[0][-1])
        runtime.output = lambda argv: '\n'.join(rows + [rows[0]])
        with self.assertRaisesRegex(m.Refusal, 'PROXY_NGINX_FILES_INVALID'): runtime.proxy_nginx_files('d' * 64)

    def test_settled_witnessed_visual_residue_is_preserved_as_real_count(self):
        value = presentation_database(); m.pending_free(value)
        self.assertEqual(value['pending_presentations'], 1); self.assertTrue(value['settled_presentations'][0]['has_pending_play'])

    def test_observed_legacy_string_and_null_presentation_types_pass(self):
        self.assertEqual(set(m.SETTLED_PRESENTATION_SCOPE), set(m.SETTLED_PRESENTATION_PROOFS))
        for session, expected in m.SETTLED_PRESENTATION_PROOFS.items():
            with self.subTest(session=session):
                value = presentation_database(session); m.pending_free(value)
                self.assertEqual(value['settled_presentations'][0]['pending_play_type'], expected['pending_play_type'])

    def test_changed_presentation_type_body_result_cycle_and_timestamp_refuse(self):
        for session in m.SETTLED_PRESENTATION_SCOPE:
            for field in ('cycle_sha256', 'state_sha256', 'result_sha256', 'cycle_settled_at', 'pending_play_type'):
                with self.subTest(session=session, field=field):
                    value = presentation_database(session)
                    value['settled_presentations'][0][field] = 'e' * 64 if field.endswith('_sha256') else 'object' if field == 'pending_play_type' else '2026-10-10T00:00:00+00:00'
                    with self.assertRaisesRegex(m.Refusal, 'PENDING_PRESENTATION_'): m.pending_free(value)
        value = presentation_database(); value['settled_presentations'][0]['session_sha256'] = 'e' * 64
        value['settled_presentations'][0]['cycle_session_sha256'] = 'e' * 64
        with self.assertRaisesRegex(m.Refusal, 'NOT_WITNESSED'): m.pending_free(value)

    def test_presentation_missing_cycle_foreign_scope_and_nonterminal_refuse(self):
        for changes in ({'cycle_sha256': None}, {'cycle_status': 'AUTHORIZING'}, {'cycle_environment': 'production'},
                        {'cycle_session_sha256': 'e' * 64}, {'state_type': 'array'}, {'next_index': 0}, {'result_sha256': None}):
            value = presentation_database(); value['settled_presentations'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(m.Refusal): m.pending_free(value)
        value = presentation_database(); value['settled_presentations'][0]['app_scope']['environment'] = 'production'
        with self.assertRaisesRegex(m.Refusal, 'PRESENTATION_SCOPE'): m.pending_free(value)

    def test_nginx_edit_preserves_tls_acme_static_and_query_redirect(self):
        original = Path(__file__).with_name('oasis.nginx.conf').read_bytes(); updated = m.retirement_nginx(original)
        self.assertIn((m.PLAYER + '/player$is_args$args').encode(), updated)
        self.assertNotIn(b':18881', updated); self.assertNotIn(b':18885', updated)
        self.assertIn(b'location ^~ /downloads/ { return 410; }', updated)
        for section in (original.split(b'server {')[1], original.split(b'server {')[2]): self.assertIn(section, updated)
        start = original.index(b'    location ~ ^/(arena/assets'); end = original.index(b'    location @oasis_api_static')
        self.assertIn(original[start:end], updated)
        for damaged in (original.replace(b'18885', b'18886'), original.replace(b'location = /demo', b'location = /changed'), original + b'\x00'):
            with self.subTest(damaged=damaged[:10]), self.assertRaises(m.Refusal): m.retirement_nginx(damaged)

    def test_external_pin_symlink_and_changed_bytes_refuse(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, 'pin'); path.write_bytes(b'{}\n'); path.chmod(0o600)
            actual = m.metadata(path)
            with patch.object(m, 'BASE', Path(folder)):
                with self.assertRaises(m.Refusal): m.read_pinned(path, '0' * 64)
            link = Path(folder, 'link'); link.symlink_to(path)
            with self.assertRaises(m.Refusal): m.read_pinned(link, actual['sha256'])


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.original = Path(__file__).with_name('oasis.nginx.conf').read_bytes()
        self.nginx = Path(self.folder.name, 'oasis.conf'); self.nginx.write_bytes(self.original)
        self.patches = [patch.object(m, 'NGINX', self.nginx), patch.object(m, 'held_locks', return_value=nullcontext(lambda: None)),
                        patch.object(m, 'output_guard'),
                        patch.object(m, 'replace_nginx', side_effect=self.replace), patch.object(m, 'write_new', side_effect=self.write)]
        for item in self.patches: item.start()
        self.receipts = []; self.runtime = FakeRuntime(); self.retire = FakeRetirer(proof(), {'path': '/retained-proof', 'sha256': 'a' * 64}, self.runtime)
        self.inventory = self.retire.audit(); self.check = self.retire.check(self.inventory)

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.folder.cleanup()

    def replace(self, old, new):
        m.require(self.nginx.read_bytes() == old, 'NGINX_REPLACED'); self.nginx.write_bytes(new)

    def write(self, path, value): self.receipts.append(copy.deepcopy(value))

    def apply(self): return self.retire.apply(self.inventory, self.check, 'a' * 64, Path(self.folder.name, 'receipt.json'))

    def test_success_deletes_exact_database_only_and_handoff_preserves_history(self):
        receipt = self.apply(); self.assertTrue(receipt['passed'])
        self.assertFalse(self.runtime.container_exists); self.assertFalse(self.runtime.volume_exists)
        self.assertEqual(self.runtime.disabled, set(m.UNITS)); self.assertEqual(self.runtime.stopped, set(m.UNITS))
        deletes = [argv for argv in self.runtime.commands if argv[:2] == ('docker', 'rm') or argv[:3] == ('docker', 'volume', 'rm')]
        self.assertEqual(deletes, [('docker', 'rm', m.CONTAINER), ('docker', 'volume', 'rm', m.VOLUME)])
        self.assertTrue(receipt['protection_handoff']['historical_inputs_preserved'])
        self.assertEqual(receipt['protection_handoff']['revoked']['container_id'], m.CONTAINER)
        self.assertNotIn(('docker', 'network', 'rm', 'bridge'), self.runtime.commands)
        for job in ('oasis-backup.service', 'oasis-monitor.service'):
            self.assertEqual(receipt['public_units_after'][job]['UnitFileState'], 'static')
            self.assertEqual(receipt['public_units_after'][job]['ActiveState'], 'inactive')
            self.assertEqual(receipt['public_units_after'][job.replace('.service', '.timer')]['UnitFileState'], 'disabled')

    def test_verified_pool_change_before_apply_retains_raw_and_still_requires_post_stop_zero(self):
        self.runtime.client_count = 2
        receipt = self.apply()
        comparison = receipt['pre_mutation_check']['comparison']
        self.assertEqual(len(comparison['allowed_observed_differences']), 5)
        self.assertEqual(len(comparison['actual_inventory']['database_clients']['postgres_clients']), 2)
        self.assertEqual(receipt['database_clients_after_stop']['postgres_clients'], [])

    def test_static_state_is_refused_for_other_units_before_database_delete(self):
        self.runtime.static_jobs.add('oasis-api.service')
        self.inventory = self.retire.audit(); self.check = self.retire.check(self.inventory)
        with self.assertRaisesRegex(m.Refusal, 'PUBLIC_UNIT_NOT_RETIRED'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.volume_exists)
        self.assertFalse(any(argv[:2] == ('docker', 'stop') for argv in self.runtime.commands))

    def test_new_static_job_state_not_in_original_audit_refuses(self):
        self.runtime.static_jobs.remove('oasis-backup.service')
        self.inventory = self.retire.audit(); self.check = self.retire.check(self.inventory)
        original = self.runtime.run
        def run(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv == ['systemctl', 'stop', 'oasis-backup.service']: self.runtime.static_jobs.add('oasis-backup.service')
            return result
        self.runtime.run = run
        with self.assertRaisesRegex(m.Refusal, 'PUBLIC_UNIT_NOT_RETIRED'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.volume_exists)

    def test_static_job_with_external_dependents_refuses(self):
        original = self.runtime.service
        def service(unit):
            value = original(unit)
            if unit == 'oasis-backup.service' and set(m.UNITS) <= self.runtime.stopped: value['WantedBy'] = 'multi-user.target'
            return value
        self.runtime.service = service
        with self.assertRaisesRegex(m.Refusal, 'STATIC_JOB_NOT_RETIRED'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.volume_exists)

    def test_volume_foreign_consumer_before_apply_refuses_without_mutation(self):
        self.runtime.foreign_volume = True
        with self.assertRaisesRegex(m.Refusal, 'FOREIGN_PUBLIC_VOLUME'): self.apply()
        self.assertEqual(self.runtime.commands, [])

    def test_foreign_consumer_after_database_stop_keeps_container_and_volume(self):
        self.runtime.extra_volume_after_stop = True
        with self.assertRaisesRegex(m.Refusal, 'FOREIGN_PUBLIC_VOLUME'): self.apply()
        self.assertTrue(self.runtime.container_exists); self.assertTrue(self.runtime.volume_exists)
        self.assertEqual(self.receipts[-1]['phase'], 'partial_refusal')

    def test_pending_after_unit_stop_keeps_database(self):
        self.runtime.pending_after_stop = True
        with self.assertRaisesRegex(m.Refusal, 'PENDING_BUSINESS'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.volume_exists)

    def test_foreign_pg_client_after_api_stop_prevents_database_stop_and_delete(self):
        self.runtime.post_stop_client = True
        with self.assertRaisesRegex(m.Refusal, 'UNKNOWN_POSTGRES_CLIENT'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.container_exists); self.assertTrue(self.runtime.volume_exists)

    def test_shared_proxy_nginx_bytes_change_after_unit_stop_prevents_delete(self):
        self.runtime.proxy_files_changed_after_stop = True
        with self.assertRaisesRegex(m.Refusal, 'HISTORICAL_PROXY_NGINX_BYTES'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.container_exists); self.assertTrue(self.runtime.volume_exists)

    def test_settled_visual_residue_is_reported_as_purged_without_ack(self):
        self.runtime.database_value = presentation_database(); self.inventory = self.retire.audit(); self.check = self.retire.check(self.inventory)
        receipt = self.apply()
        self.assertEqual(receipt['database_before_delete']['pending_presentations'], 1)
        self.assertEqual(receipt['purged_settled_presentations']['count'], 1)
        self.assertFalse(receipt['purged_settled_presentations']['acknowledgement_performed'])

    def test_other_site_or_production_drift_prevents_delete(self):
        self.runtime.changed_after_stop = True
        with self.assertRaisesRegex(m.Refusal, 'PRESERVED_PRODUCTION'): self.apply()
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.volume_exists)

    def test_nginx_test_failure_restores_only_original_site_and_stops_before_services(self):
        self.runtime.fail_nginx = True
        with self.assertRaisesRegex(m.Refusal, 'NGINX_TEST_FAILED'): self.apply()
        self.assertEqual(self.nginx.read_bytes(), self.original); self.assertEqual(self.runtime.stopped, set())
        self.assertTrue(self.runtime.volume_exists)

    def test_expired_or_changed_check_has_no_mutation(self):
        self.check['at'] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=11)).isoformat()
        with self.assertRaisesRegex(m.Refusal, 'NOT_FRESH'): self.apply()
        self.assertEqual(self.runtime.commands, [])
        self.check = self.retire.check(self.inventory); self.check['tool_sha256'] = '0' * 64
        with self.assertRaisesRegex(m.Refusal, 'CHECK_PIN'): self.apply()
        self.assertEqual(self.runtime.commands, [])

    def test_database_identity_counts_change_before_apply_refuses(self):
        self.runtime.database_value['sessions'] += 1
        with self.assertRaisesRegex(m.Refusal, 'LIVE_INVENTORY'): self.apply()
        self.assertEqual(self.runtime.commands, [])
        self.assertEqual(len(self.receipts), 1)
        refused = self.receipts[0]
        self.assertEqual(refused['phase'], 'before_mutation_refused')
        self.assertTrue(refused['no_business_mutation']); self.assertEqual(refused['history'], [])
        self.assertNotIn('started_record', refused)
        self.assertEqual(refused['comparison']['expected_inventory'], self.inventory)
        self.assertEqual(refused['comparison']['actual_inventory']['database']['sessions'], self.inventory['database']['sessions'] + 1)
        self.assertEqual(refused['comparison']['differences'], [{'path': '/database/sessions', 'expected': 1191, 'actual': 1192}])
        self.assertEqual(self.nginx.read_bytes(), self.original)
        self.assertTrue(self.runtime.live); self.assertTrue(self.runtime.container_exists); self.assertTrue(self.runtime.volume_exists)

    def test_incomplete_initial_audit_refusal_is_recorded_without_mutation(self):
        self.runtime.foreign_volume = True
        with self.assertRaisesRegex(m.Refusal, 'FOREIGN_PUBLIC_VOLUME'): self.apply()
        self.assertEqual(self.runtime.commands, []); self.assertEqual(len(self.receipts), 1)
        refused = self.receipts[0]
        self.assertEqual(refused['phase'], 'before_mutation_refused'); self.assertEqual(refused['history'], [])
        self.assertTrue(refused['no_business_mutation']); self.assertTrue(refused['comparison']['audit_incomplete'])
        self.assertIsNone(refused['comparison']['actual_inventory'])

    def test_unknown_dependency_refuses(self):
        original = self.runtime.service
        self.runtime.service = lambda unit: {**original(unit), 'RequiredBy': 'unrelated-business.service'}
        with self.assertRaisesRegex(m.Refusal, 'FOREIGN_DEPENDENT'): self.retire.services()


if __name__ == '__main__': unittest.main()
