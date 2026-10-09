"""Local fake-command and temporary-FS adversarial tests; no real SSH/Docker/UI."""
from contextlib import nullcontext, ExitStack
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('retire_android_mock', Path(__file__).with_name('retire-android-mock.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def obligations(**changes):
    row = {'environment': 'sandbox', 'apps': 3, 'sessions': 110, 'transfer_schema': 'present',
           **{key: 0 for key in ('pending_rooms', 'pending_cycles', 'non_sandbox_apps', 'pending_gp_operations',
             'pending_pvp_operations', 'pending_presentations', 'pending_integration_checks', 'pending_reservations',
             'pending_wallet_matches', 'pending_wallet_probability', 'pending_reserved_balances', 'pending_transfers',
             'pending_transfer_inbound_minor', 'pending_transfer_outbound_minor')}}
    row.update(changes)
    return row


def command_document(*rows):
    return {'type': 'a(sasbttttuii)', 'data': list(rows)}


def database_stop_row(**changes):
    row = ['/usr/bin/docker', ['/usr/bin/docker', 'stop', '--time', '30', m.CONTAINER], False, 0, 0, 0, 0, 0, 0, 0]
    if 'argv' in changes: row[1] = changes['argv']
    return row


class DBusString(str): pass
class DBusObjectPath(str): pass
class DBusBoolean(int): pass
class DBusUInt64(int): pass
class DBusUInt32(int): pass
class DBusInt32(int): pass
class DBusStruct(tuple): pass
class DBusArray(list):
    def __init__(self, value=(), signature=None):
        super().__init__(value); self.signature = signature


def typed_commands(rows=()):
    values = []
    for row in rows:
        values.append(DBusStruct([DBusString(row[0]), DBusArray(map(DBusString, row[1]), 's'), DBusBoolean(row[2]),
                                 *[DBusUInt64(value) for value in row[3:7]], DBusUInt32(row[7]),
                                 DBusInt32(row[8]), DBusInt32(row[9])]))
    return DBusArray(values, '(sasbttttuii)')


class FakeDBus:
    """An inactive unit disappears unless held by the same live sender.
    Reading a property on a different connection, or before RefUnit, fails.
    """
    String, ObjectPath, Boolean = DBusString, DBusObjectPath, DBusBoolean
    UInt64, UInt32, Int32, Struct, Array = DBusUInt64, DBusUInt32, DBusInt32, DBusStruct, DBusArray
    def __init__(self, *, object_path=None, command=None, failure=None):
        self.events = []; self.unit = None; self.referenced = False; self.closed = False
        self.object_path, self.command, self.failure = object_path, command, failure
        self.module = types.SimpleNamespace(**{name: getattr(self, name) for name in
            ('String', 'ObjectPath', 'Boolean', 'UInt64', 'UInt32', 'Int32', 'Struct', 'Array', 'SystemBus', 'Interface')})
    def SystemBus(self, *, private):
        assert private is True
        assert 'DBUS_SYSTEM_BUS_ADDRESS' not in os.environ and 'DBUS_SESSION_BUS_ADDRESS' not in os.environ
        self.events.append('connect'); return self
    def get_object(self, name, path):
        assert name == 'org.freedesktop.systemd1'
        if path != '/org/freedesktop/systemd1':
            assert self.referenced and path == m.dbus_unit_path(self.unit)
        return self
    def Interface(self, obj, name):
        assert obj is self
        assert name in ('org.freedesktop.systemd1.Manager', 'org.freedesktop.DBus.Properties')
        return self
    def RefUnit(self, unit, **kwargs):
        self.events.append('ref')
        if self.failure == 'ref': raise RuntimeError('FIXTURE_REF_FAILED')
        self.unit, self.referenced = unit, True
    def GetUnit(self, unit, **kwargs):
        self.events.append('getunit')
        assert self.referenced and unit == self.unit
        if self.failure == 'getunit': raise RuntimeError('FIXTURE_GETUNIT_FAILED')
        return self.object_path if self.object_path is not None else DBusObjectPath(m.dbus_unit_path(unit))
    def Get(self, interface, name, **kwargs):
        self.events.append(name)
        assert self.referenced and not self.closed
        if self.failure == name: raise RuntimeError('FIXTURE_TYPED_GET_FAILED')
        if name == 'NeedDaemonReload': return DBusBoolean(False)
        row = self.command if self.command is not None else database_stop_row()
        return typed_commands([row] if self.unit == 'oasis-android-mock-db.service' and name == 'ExecStop' else [])
    def UnrefUnit(self, unit, **kwargs):
        self.events.append('unref'); assert self.referenced and unit == self.unit
        self.referenced = False
        if self.failure == 'unref': raise RuntimeError('FIXTURE_UNREF_FAILED')
    def close(self):
        self.events.append('close'); self.closed = True; self.referenced = False


def inventory(volume_path='/unused/volume'):
    labels = {m.LABEL: 'fixture-owner'}
    label_sha = m.sha(json.dumps(labels, sort_keys=True).encode())
    return {'read_only': True, 'marker_kind': 'isolated-13-game-mock', 'mock_release': m.MOCK,
            'public_current': m.CURRENT, 'uid': 997, 'marker_sha256': 'd' * 64,
            'ownership_id_sha256': m.sha(b'fixture-owner'),
            'public_last_release': {'current': m.CURRENT, 'previous': m.PREVIOUS, 'health': 'passed'},
            'mock_database': obligations(), 'services': {'oasis-production.service': {'ActiveState': 'inactive'}},
            'docker': {
                'container': {'name': m.CONTAINER, 'owned_label_matches': True, 'id': 'a' * 64,
                              'image': 'sha256:' + 'b' * 64, 'labels_sha256': label_sha,
                              'mounts': [{'Type': 'volume', 'Name': m.VOLUME, 'Source': volume_path,
                                          'Destination': '/var/lib/postgresql/data'}]},
                'volume': {'name': m.VOLUME, 'owned_label_matches': True, 'mountpoint': volume_path,
                           'labels_sha256': label_sha, 'consumers': [m.CONTAINER]},
                'network': {'name': m.NETWORK, 'owned_label_matches': True, 'id': 'c' * 64,
                            'labels_sha256': label_sha, 'internal': True, 'container_names': [m.CONTAINER]}}}


def capsule():
    return {'schema': 'android-mock-retirement-check-v1', 'at': m.now(), 'read_only': True,
            'passed': True, 'inventory_sha256': 'e' * 64, 'tool_sha256': 'f' * 64,
            'database': obligations(), 'public': {}, 'files': {}, 'resources': {}, 'install_sha256': '9' * 64}


class FakeRuntime:
    def __init__(self, inventory_row=None):
        self.commands, self.database_calls = [], 0
        self.failure, self.pending_after_stop = None, False
        self.uid_live, self.mock_stopped = False, False
        self.row = inventory_row or inventory()
        path = self.row['docker']['volume']['mountpoint']
        labels = {m.LABEL: 'fixture-owner'}
        self.container = {'id': 'a' * 64, 'labels': labels, 'running': False, 'image': 'sha256:' + 'b' * 64,
                          'mounts': copy.deepcopy(self.row['docker']['container']['mounts']), 'networks': {m.NETWORK: {}}}
        self.volume = {'name': m.VOLUME, 'labels': labels, 'mountpoint': path,
                       'created_at': '2026-10-08T00:00:00Z', 'driver': 'local', 'options': None, 'scope': 'local'}
        self.network = {'id': 'c' * 64, 'labels': labels, 'internal': True, 'containers': {}}
        self.volume_consumers = [m.CONTAINER]
        self.proxy = 'original proxy'
        self.proxy_mode = 0o644
        self.fail_nginx = False
        self.cached_db_stop = None

    def run(self, args, **kwargs):
        self.commands.append(tuple(args))
        if self.failure == 'start' and args[:2] == ['docker', 'start']:
            raise RuntimeError('FIXTURE_START_FAILURE')
        if self.fail_nginx and args == ['nginx', '-t']:
            self.fail_nginx = False
            raise RuntimeError('FIXTURE_NGINX_FAILURE')
        if args[:2] == ['docker', 'cp']:
            self.proxy = Path(args[2]).read_text().strip()
            self.proxy_mode = stat.S_IMODE(Path(args[2]).stat().st_mode)
        if args[:5] == ['docker', 'exec', 'proxy-nginx', 'chmod', '644']:
            self.proxy_mode = 0o644
        if args[-1:] == ['stop'] and args[0] == '/usr/bin/python3':
            self.mock_stopped = True
        return types.SimpleNamespace(returncode=0, stdout='', stderr='')

    def output(self, args, **kwargs):
        if '--property=NeedDaemonReload' in args: return 'no'
        if args[0] == 'busctl' and 'call' in args:
            return json.dumps({'type': 'o', 'data': [m.dbus_unit_path(args[-1])]})
        if args[0] == 'busctl' and 'get-property' in args:
            row = database_stop_row() if args[-1] == 'ExecStop' and args[-3] == m.dbus_unit_path('oasis-android-mock-db.service') else None
            return json.dumps(command_document(row) if row is not None else command_document())
        if args[:3] == ['docker', 'ps', '-a']:
            return '\n'.join(self.volume_consumers)
        if 'cat' in args:
            return self.proxy
        if 'stat' in args:
            return '0:' + format(self.proxy_mode, 'o') + ':1:regular file'
        return ''

    def inspect(self, kind, name, fields, absent=False):
        return copy.deepcopy({'container': self.container, 'volume': self.volume, 'network': self.network}[kind])

    def database(self, **kwargs):
        self.database_calls += 1
        if self.database_calls == 2 and self.failure == 'query':
            raise RuntimeError('FIXTURE_QUERY_FAILURE')
        return obligations(pending_transfers=1 if self.database_calls == 2 and self.pending_after_stop else 0)

    def service(self, unit):
        return {'ActiveState': 'inactive', 'MainPID': '0', 'UnitFileState': 'disabled'}

    def loaded_stop(self, unit):
        binding = FakeDBus(command=self.cached_db_stop)
        with patch.dict(sys.modules, {'dbus': binding.module}):
            return m.Runtime.loaded_stop(self, unit)

    def uid_processes(self, uid):
        return [77] if self.uid_live else []

    def http(self, url, expected, **kwargs):
        if self.failure == 'http':
            raise RuntimeError('FIXTURE_HTTPS_FAILURE')
        return {'status': expected, 'strict_tls': True}


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name)
        self.row = inventory(str(self.path))
        self.runtime = FakeRuntime(self.row)
        self.retire = m.Retirer(self.row, 'e' * 64, 'f' * 64, self.runtime)
        self.retire.state = {'id': 'fixture-owner', 'postgres_image': 'sha256:' + 'b' * 64}

    def tearDown(self):
        self.folder.cleanup()

    def test_sole_stopped_container_and_local_volume_are_accepted(self):
        self.assertEqual(self.retire.resources()['container']['id'], 'a' * 64)

    def test_foreign_volume_consumer_refuses(self):
        self.runtime.volume_consumers.append('public-database')
        with self.assertRaisesRegex(RuntimeError, 'FOREIGN_VOLUME_CONSUMER'):
            self.retire.resources()

    def test_foreign_network_endpoint_refuses(self):
        self.runtime.network['containers'] = {'alien': {'Name': 'public-api'}}
        with self.assertRaisesRegex(RuntimeError, 'FOREIGN_NETWORK_CONSUMER'):
            self.retire.resources()

    def test_each_resource_label_drift_refuses(self):
        for kind in ('container', 'volume', 'network'):
            with self.subTest(kind=kind):
                resource = getattr(self.runtime, kind)
                resource['labels'] = {m.LABEL: 'foreign-owner'}
                with self.assertRaisesRegex(RuntimeError, 'RESOURCE_OWNERSHIP_CHANGED'):
                    self.retire.resources()
                resource['labels'] = {m.LABEL: 'fixture-owner'}

    def test_same_name_different_container_or_network_id_refuses(self):
        for kind, code in (('container', 'CONTAINER_ID'), ('network', 'NETWORK_ID')):
            with self.subTest(kind=kind):
                resource = getattr(self.runtime, kind)
                original = resource['id']; resource['id'] = '8' * 64
                with self.assertRaisesRegex(RuntimeError, code):
                    self.retire.resources()
                resource['id'] = original

    def test_driver_options_and_foreign_mount_refuse(self):
        self.runtime.volume['options'] = {'device': '/opt/oasis/private'}
        with self.assertRaisesRegex(RuntimeError, 'VOLUME_DRIVER_OR_OPTIONS'):
            self.retire.resources()
        self.runtime.volume['options'] = None
        self.runtime.container['mounts'].append({'Type': 'bind', 'Source': '/opt/oasis/private', 'Destination': '/extra'})
        with self.assertRaisesRegex(RuntimeError, 'CONTAINER_MOUNT_OR_NETWORK'):
            self.retire.resources()


class InputAndTreeTests(unittest.TestCase):
    def test_cached_unknown_execstop_and_reload_drift_refuse(self):
        values = {'NeedDaemonReload': 'no', 'ExecStopPost': command_document(), 'ExecStop': command_document()}
        m.loaded_stop_guard('oasis-android-mock-api.service', values)
        with self.assertRaisesRegex(RuntimeError, 'LOADED_EXEC_STOP_PROPERTY_MISSING'):
            m.loaded_stop_guard('oasis-android-mock-api.service', {'NeedDaemonReload': 'no'})
        m.loaded_stop_guard('oasis-android-mock-certificate.timer', {'NeedDaemonReload': 'no'})
        m.loaded_stop_guard('oasis-android-mock-db-proxy.socket', {'NeedDaemonReload': 'no', 'ExecStopPre': command_document(), 'ExecStopPost': command_document()})
        with self.assertRaisesRegex(RuntimeError, 'OWNED_UNIT_MANAGER_NEEDS_RELOAD'):
            m.loaded_stop_guard('oasis-android-mock-api.service', {**values, 'NeedDaemonReload': 'yes'})
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_LOADED_EXECSTOP'):
            m.loaded_stop_guard('oasis-android-mock-api.service', {**values, 'ExecStop': command_document(database_stop_row())})
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_LOADED_DATABASE_STOP'):
            m.loaded_stop_guard('oasis-android-mock-db.service', {**values, 'ExecStop': command_document(database_stop_row(argv=['/usr/bin/docker', 'rm', 'public']))})
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_LOADED_EXECSTOPPOST'):
            m.loaded_stop_guard('oasis-android-mock-network.service', {**values, 'ExecStopPost': command_document(database_stop_row())})

    def test_dbus_missing_variant_wrong_type_or_row_is_never_empty(self):
        for value in ('', {}, {'type': 'a(sasbttttuii)'}, {'type': 'as', 'data': []},
                      {'type': 'a(sasbttttuii)', 'data': [[]]}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                m.loaded_stop_guard('oasis-android-mock-api.service', {'NeedDaemonReload': 'no', 'ExecStop': value, 'ExecStopPost': command_document()})

    def test_loaded_history_is_excluded_from_fresh_identity(self):
        first = database_stop_row(); second = database_stop_row()
        second[3:] = [123, 456, 789, 1000, 42, 1, 0]
        def normalized(row):
            return m.loaded_stop_guard('oasis-android-mock-db.service', {'NeedDaemonReload': 'no', 'ExecStop': command_document(row), 'ExecStopPost': command_document()})
        self.assertEqual(normalized(first), normalized(second))

    def test_all_obligation_types_block_even_when_rooms_cycles_zero(self):
        for key in obligations():
            if key.startswith('pending_') or key == 'non_sandbox_apps':
                with self.subTest(key=key), self.assertRaises(m.PendingBusiness):
                    m.pending_free(obligations(**{key: 1}), 'PENDING')

    def test_missing_and_boolean_business_count_refuse(self):
        row = obligations(); del row['pending_transfers']
        with self.assertRaisesRegex(RuntimeError, 'BUSINESS_COUNTS_INCOMPLETE'):
            m.pending_free(row, 'PENDING')
        with self.assertRaisesRegex(RuntimeError, 'BUSINESS_COUNTS_INCOMPLETE'):
            m.pending_free(obligations(pending_transfers=False), 'PENDING')

    def test_expired_future_and_wrong_bound_capsule_refuse(self):
        row = capsule()
        stamp = dt.datetime.fromisoformat(row['at']).timestamp()
        for clock in (stamp - 1, stamp + 601):
            with self.assertRaisesRegex(RuntimeError, 'SAFE_CHECK_EXPIRED_OR_FUTURE'):
                m.validate_capsule(row, 'e' * 64, 'f' * 64, clock)
        with self.assertRaisesRegex(RuntimeError, 'SAFE_CHECK_BINDING'):
            m.validate_capsule(row, 'e' * 64, '0' * 64, stamp)

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'DUPLICATE_JSON_KEY'):
            m.decode('{"uid":997,"uid":0}')

    def test_symlink_hardlink_and_same_device_bind_mount_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / 'file'; data.write_bytes(b'fixture-secret-not-printed')
            with patch.object(m, 'mount_points', return_value=()), patch.object(m.os, 'getuid', return_value=os.getuid()):
                # The directory ownership check is injected only for the local
                # macOS fixture, never exposed through a real tool CLI.
                original_lstat = Path.lstat
                def fixture_lstat(path):
                    info = original_lstat(path)
                    if path == root:
                        values = list(info); values[4] = 0
                        return os.stat_result(values)
                    return info
                with patch.object(Path, 'lstat', fixture_lstat):
                    m.tree(root, os.getuid())
                    link = root / 'unknown'; link.symlink_to(data)
                    with self.assertRaisesRegex(RuntimeError, 'TREE_SYMLINK'):
                        m.tree(root, os.getuid())
                    link.unlink(); os.link(data, link)
                    with self.assertRaisesRegex(RuntimeError, 'TREE_SPECIAL_OR_HARDLINK'):
                        m.tree(root, os.getuid())
                    link.unlink()
                    with self.assertRaisesRegex(RuntimeError, 'NESTED_MOUNT'):
                        m.tree(root, os.getuid(), mounts=(root / 'same-device-public-bind',))

    def test_mountinfo_escaped_path_is_decoded(self):
        with patch.object(Path, 'read_text', return_value='1 2 0:1 / /opt/oasis/android-mock-private/a\\040b rw - ext4 /dev/root rw\n'):
            self.assertEqual(m.mount_points(), (Path('/opt/oasis/android-mock-private/a b'),))

    def test_public_current_previous_and_foreign_consumer_inventory_refuse(self):
        for mutation in ('current', 'previous', 'volume', 'network'):
            row = inventory()
            if mutation == 'current': row['public_current'] = m.PREVIOUS
            if mutation == 'previous': row['public_last_release']['previous'] = m.MOCK
            if mutation == 'volume': row['docker']['volume']['consumers'].append('public')
            if mutation == 'network': row['docker']['network']['container_names'].append('public')
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                m.validate_inventory(row)


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.root = Path(self.folder.name)
        self.tls, self.bridge, self.receipt = (self.root / value for value in ('tls.conf', 'bridge.conf', 'receipt'))
        self.receipt.mkdir()
        self.tls.write_bytes(b'original tls'); self.bridge.write_bytes(b'original bridge')
        self.runtime = FakeRuntime()
        self.retire = m.Retirer(inventory(), 'e' * 64, 'f' * 64, self.runtime)
        self.retire.capsule = {'public': {}, 'files': {'routing': {}, 'proxy_routing_sha256': m.sha(self.runtime.proxy.encode())}}
        self.patches = [patch.object(m, 'TLS', self.tls), patch.object(m, 'BRIDGE', self.bridge),
                        patch.object(m, 'RECEIPT', self.receipt),
                        patch.object(m, 'body', side_effect=lambda path, **kw: path.read_bytes()),
                        patch.object(m, 'fingerprint', side_effect=lambda path, *args: {'sha256': m.sha(path.read_bytes())})]
        for item in self.patches: item.start()
        self.retire.capsule['files']['routing'] = {str(self.tls): m.fingerprint(self.tls), str(self.bridge): m.fingerprint(self.bridge)}
        self.events = []
        self.retire.public_guard = lambda *args, **kw: {}
        self.retire.event = lambda phase, **values: self.events.append((phase, values))

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.folder.cleanup()

    def test_410_uses_no_upstream_and_two_nginx_tests_precede_reload(self):
        self.retire.tombstone()
        self.assertIn(b'return 410', self.tls.read_bytes())
        self.assertNotIn(b'proxy_pass', self.tls.read_bytes())
        self.assertFalse(self.bridge.exists())
        commands = self.runtime.commands
        self.assertLess(commands.index(('nginx', '-t')), commands.index(('systemctl', 'reload', 'nginx')))
        self.assertLess(commands.index(('docker', 'exec', 'proxy-nginx', 'nginx', '-t')),
                        commands.index(('systemctl', 'reload', 'nginx')))

    def test_actual_umask077_proxy_copy_and_fresh_guard_preserve_explicit_modes(self):
        previous = os.umask(0o077)
        try:
            self.retire.tombstone()
            self.retire.receipt = {'routing': self.events[-1][1]['routing']}
            self.retire.routing_guard()  # real stat policy after copy under 077
            self.assertEqual(self.runtime.proxy_mode, 0o644)
            self.assertEqual(stat.S_IMODE(self.tls.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE((self.receipt / 'proxy-tombstone.conf').stat().st_mode), 0o644)
            for name in ('tls.conf', 'bridge.conf', 'proxy.conf'):
                self.assertEqual(stat.S_IMODE((self.receipt / name).stat().st_mode), 0o600)
            # Creation remains exclusive and cannot chmod an existing file.
            unknown = self.root / 'unknown'; unknown.write_bytes(b'foreign'); unknown.chmod(0o600)
            with self.assertRaises(FileExistsError):
                self.retire.exclusive(unknown, b'replacement', 0o644)
            self.assertEqual(unknown.read_bytes(), b'foreign')
            self.assertEqual(stat.S_IMODE(unknown.stat().st_mode), 0o600)
        finally:
            os.umask(previous)

    def test_test_failure_restores_only_config_and_no_data_command(self):
        self.runtime.fail_nginx = True
        with self.assertRaisesRegex(RuntimeError, 'FIXTURE_NGINX_FAILURE'):
            self.retire.tombstone()
        self.assertEqual(self.tls.read_bytes(), b'original tls')
        self.assertEqual(self.bridge.read_bytes(), b'original bridge')
        self.assertEqual(self.runtime.proxy, 'original proxy')
        self.assertFalse(any('rm' in command for command in self.runtime.commands))

    def test_initial_refusal_never_overwrites_foreign_config(self):
        self.tls.write_bytes(b'foreign public server block')
        with self.assertRaisesRegex(RuntimeError, 'ROUTING_CHANGED_BEFORE_REPLACE'):
            self.retire.tombstone()
        self.assertEqual(self.tls.read_bytes(), b'foreign public server block')
        self.assertEqual(self.runtime.commands, [])

    def test_post_tombstone_drift_refuses_fresh_routing_guard(self):
        self.retire.tombstone()
        routing = self.events[-1][1]['routing']
        self.retire.receipt = {'routing': routing}
        self.tls.write_bytes(b'foreign upstream')
        with self.assertRaisesRegex(RuntimeError, 'TOMBSTONE_ROUTING_CHANGED'):
            self.retire.routing_guard()

    def test_unknown_tls_during_recovery_is_preserved(self):
        def fail_after_write(*args, **kwargs):
            self.tls.write_bytes(b'foreign public route')
            raise RuntimeError('FIXTURE_HTTPS_FAILURE')
        self.runtime.http = fail_after_write
        with self.assertRaisesRegex(RuntimeError, 'ROUTING_CHANGED_BEFORE_REPLACE'):
            self.retire.tombstone()
        self.assertEqual(self.tls.read_bytes(), b'foreign public route')
        self.assertFalse(any('rm' in command for command in self.runtime.commands))


class StopFinallyTests(unittest.TestCase):
    def run_case(self, *, failure=None, pending=False, route_failure=True):
        runtime = FakeRuntime(); runtime.failure = failure; runtime.pending_after_stop = pending
        retire = m.Retirer(inventory(), 'e' * 64, 'f' * 64, runtime)
        row = capsule(); events = []
        retire.check = lambda: row
        retire.fresh = lambda **kwargs: events.append(('fresh', kwargs))
        retire.stopped_guard = lambda: None
        retire.event = lambda phase, **kwargs: events.append((phase, kwargs))
        def routing():
            raise RuntimeError('FIXTURE_ROUTE_PROOF_FAILED')
        retire.tombstone = routing
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, 'RECEIPT', Path(temporary) / 'receipt'), \
                patch.object(m, 'locked', side_effect=lambda path: nullcontext()), patch.object(m.time, 'sleep'):
            with self.assertRaises(RuntimeError): retire.apply(row)
        return runtime.commands, events

    def test_query_failure_stops_exact_pg_id_and_never_removes_volume(self):
        commands, _ = self.run_case(failure='query')
        self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), commands)
        self.assertFalse(any('rm' in command for command in commands))

    def test_pending_transfer_after_stop_stops_exact_pg_id_and_retains_data(self):
        commands, events = self.run_case(pending=True)
        self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), commands)
        self.assertFalse(any('rm' in command for command in commands))
        self.assertTrue(any(phase == 'post_stop_business_readback' for phase, _ in events))

    def test_start_failure_still_attempts_exact_pg_stop(self):
        commands, _ = self.run_case(failure='start')
        self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), commands)
        self.assertFalse(any('rm' in command for command in commands))

    def test_route_failure_comes_after_pg_finally_and_no_delete(self):
        commands, events = self.run_case()
        self.assertTrue(any(phase == 'old_installer_stopped' for phase, _ in events))
        self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), commands)
        self.assertFalse(any('rm' in command for command in commands))
        self.assertFalse(any(command[:2] == ('systemctl', 'start') for command in commands))


class FreshActualFilesTests(unittest.TestCase):
    """Exercise real files(), then actually unlink BRIDGE and call real fresh()."""
    def test_bridge_unlink_and_410_binding_keep_other_files_guarded(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            private, webroot = base / 'android-mock-private', base / 'webroot'
            private.mkdir(mode=0o750); private.chmod(0o750); webroot.mkdir()
            systemd = base / 'systemd'; systemd.mkdir()
            mock = base / 'releases/20261008-23'; templates = mock / 'platform/deploy/mock-sandbox'; templates.mkdir(parents=True)
            tls, bridge = base / 'mock.conf', base / 'acme.conf'
            tls.write_text('original fixture TLS'); bridge.write_text('original fixture ACME')
            renewal = base / 'renewal.conf'; renewal.write_text('fixture renewal')
            cert = base / 'acme/config/live/oasis-android-mock'; cert.mkdir(parents=True)
            archive = base / 'acme/config/archive/oasis-android-mock'; archive.mkdir(parents=True)
            for name in ('fullchain', 'privkey'):
                target = archive / (name + '1.pem'); target.write_bytes(b'fixture leaf')
                (cert / (name + '.pem')).symlink_to(target)
            for unit in m.UNITS: (systemd / unit).write_text('fixture unit\n')
            dropin = systemd / 'oasis-android-mock-api.service.d'; dropin.mkdir()
            dropfile = dropin / '10-database-proxy.conf'; dropfile.write_text('fixture dropin\n')
            for short in ('api', 'demo'): (templates / ('mock-' + short + '.service.example')).write_text('fixture unit\n')
            trusted_source = Path(m.__file__).parent / 'mock-sandbox/install.py'
            (templates / 'install.py').write_bytes(trusted_source.read_bytes())
            manifest = {'files': {'platform/deploy/mock-sandbox/' + name: m.sha((templates / name).read_bytes())
                                  for name in ('install.py', 'mock-api.service.example', 'mock-demo.service.example')}}
            (mock / 'RELEASE-MANIFEST.json').write_bytes(m.canonical(manifest))
            for name in ('installation.json', 'runtime.env', 'postgres.env', 'network.nft'):
                (private / name).write_bytes(b'fixture opaque file')
            (base / 'android-mock-current').symlink_to(mock)
            original_fingerprint, original_body, original_lstat = m.fingerprint, m.body, Path.lstat
            def fingerprint(path, owners=(0,)):
                return original_fingerprint(path, (os.getuid(),))
            def root_lstat(path):
                info = original_lstat(path)
                if path in (private, webroot):
                    values = list(info); values[4] = 0
                    return os.stat_result(values)
                return info
            proxy = f'''server {{
 listen 80;
 server_name {m.HOST};
 location ^~ /.well-known/acme-challenge/ {{
  proxy_pass http://172.17.0.1:18884;
  proxy_set_header Host $host;
 }}
 location / {{ return 301 https://{m.HOST}$request_uri; }}
}}'''
            runtime = FakeRuntime(); runtime.proxy = proxy
            def service(unit):
                return {'ActiveState': 'inactive', 'MainPID': '0', 'UnitFileState': 'disabled', 'FragmentPath': str(systemd / unit)}
            runtime.service = service
            original_output = runtime.output
            def output(args, **kwargs):
                if '--property=DropInPaths' in args:
                    return str(dropfile) if args[2] == 'oasis-android-mock-api.service' else ''
                return original_output(args, **kwargs)
            runtime.output = output
            with patch.multiple(m, BASE=base, PRIVATE=private, WEBROOT=webroot, SYSTEMD=systemd,
                                MOCK=str(mock), TLS=tls, BRIDGE=bridge, RENEWAL=renewal, CERT=cert), \
                    patch.object(m, 'fingerprint', side_effect=fingerprint), \
                    patch.object(m, 'body', side_effect=lambda path, **kwargs: original_body(path, owner=os.getuid())), \
                    patch.object(m, 'mount_points', return_value=()), patch.object(Path, 'lstat', root_lstat):
                row = inventory(); row['uid'] = os.getuid()
                row['mock_files'] = {name: {'sha256': fingerprint(private / name)['sha256']}
                                     for name in ('installation.json', 'runtime.env', 'postgres.env', 'network.nft')}
                row['mock_files'].update({str(path): {'sha256': fingerprint(path)['sha256']} for path in (tls, bridge)})
                retire = m.Retirer(row, 'e' * 64, 'f' * 64, runtime)
                retire.state = {'manifest_sha256': m.sha((mock / 'RELEASE-MANIFEST.json').read_bytes()),
                                'postgres_address': '172.19.0.2'}
                for target, content in retire.unit_templates().items():
                    Path(target).write_bytes(content)
                before = retire.files()  # real file inventory, not stubbed
                foreign = systemd / 'foreign.service'
                foreign.write_text('[Unit]\nPartOf=oasis-android-mock-api.service\n[Service]\nExecStart=/bin/true\n')
                with self.assertRaisesRegex(RuntimeError, 'FOREIGN_UNIT_NAMESPACE_CONSUMER'):
                    retire.files()
                foreign.unlink()
                runtime.cached_db_stop = database_stop_row(argv=['/usr/bin/docker', 'rm', 'public'])
                with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_LOADED_DATABASE_STOP'):
                    retire.files()  # disk remains the exact trusted generator
                runtime.cached_db_stop = None
                original_tls = tls.read_bytes(); tls.write_bytes(original_tls + b'\nserver { server_name public; }')
                with self.assertRaisesRegex(RuntimeError, 'MOCK_ROUTING_DRIFTED_FROM_INVENTORY'):
                    retire.files()
                tls.write_bytes(original_tls)
                (systemd / 'oasis-android-mock-db.service').write_text('fixture malicious ExecStop=docker rm public\n')
                with self.assertRaisesRegex(RuntimeError, 'OWNED_UNIT_NOT_TRUSTED_TEMPLATE'):
                    retire.files()
                for target, content in retire.unit_templates().items():
                    Path(target).write_bytes(content)
                before = retire.files()
                retire.public_guard = lambda *args, **kw: {}
                retire.marker = lambda: None; retire.nft_guard = lambda: None
                retire.resources = lambda **kwargs: {'container': None, 'volume': None, 'network': None}
                retire.capsule = {'public': {}, 'resources': {}, 'files': before}
                tls.write_text('fixture tombstone 410'); bridge.unlink(); runtime.proxy = 'fixture proxy 410'
                retire.receipt = {'routing': {'tls_sha256': fingerprint(tls)['sha256'], 'proxy_sha256': m.sha(runtime.proxy.encode())}}
                retire.fresh(routing_changed=True, container_present=False, volume_present=False, network_present=False)
                (private / 'runtime.env').write_bytes(b'fixture drift')
                with self.assertRaisesRegex(RuntimeError, 'MOCK_SECRET_HASH_CHANGED'):
                    retire.fresh(routing_changed=True, container_present=False, volume_present=False, network_present=False)

class DatabaseProtocolTests(unittest.TestCase):
    def test_getunit_requires_typed_exact_owned_object_path(self):
        runtime = m.Runtime('a' * 64)
        unit = 'oasis-android-mock-api.service'; object_path = m.dbus_unit_path(unit)
        for data in (object_path, [], [object_path], DBusObjectPath('/org/freedesktop/systemd1/unit/foreign')):
            binding = FakeDBus(object_path=data)
            with self.subTest(data=data), patch.dict(sys.modules, {'dbus': binding.module}):
                with self.assertRaisesRegex(RuntimeError, 'DBUS_UNIT_IDENTITY_MISMATCH'):
                    runtime.loaded_stop(unit)
                self.assertEqual(binding.events[-2:], ['unref', 'close'])
        binding = FakeDBus()
        with patch.dict(sys.modules, {'dbus': binding.module}):
            self.assertEqual(runtime.loaded_stop(unit)['typed_commands']['ExecStop']['count'], 0)
        self.assertEqual(binding.events, ['connect', 'ref', 'getunit', 'NeedDaemonReload', 'ExecStop', 'ExecStopPost', 'unref', 'close'])

    def test_inactive_unit_is_held_by_same_sender_without_start_or_job(self):
        binding = FakeDBus(); unit = 'oasis-android-mock-db.service'
        with patch.dict(sys.modules, {'dbus': binding.module}), \
                patch.dict(os.environ, {'DBUS_SYSTEM_BUS_ADDRESS': 'fixture-foreign-system-bus'}):
            observed = m.Runtime('a' * 64).loaded_stop(unit)
            self.assertEqual(os.environ['DBUS_SYSTEM_BUS_ADDRESS'], 'fixture-foreign-system-bus')
        self.assertEqual(observed['typed_commands']['ExecStop']['commands'][0]['argv'], database_stop_row()[1])
        self.assertEqual(binding.events.count('connect'), 1)
        self.assertFalse(binding.referenced); self.assertTrue(binding.closed)
        self.assertNotIn('start', binding.events)
        with self.assertRaises(AssertionError):  # former next-sender/GC read fails
            binding.Get('org.freedesktop.systemd1.Service', 'ExecStop')

    def test_read_ref_unref_failures_never_become_empty_and_close_bus(self):
        for failure in ('ref', 'getunit', 'NeedDaemonReload', 'ExecStop', 'ExecStopPost', 'unref'):
            binding = FakeDBus(failure=failure)
            with self.subTest(failure=failure), patch.dict(sys.modules, {'dbus': binding.module}):
                with self.assertRaisesRegex(RuntimeError, 'FIXTURE_'):
                    m.Runtime().loaded_stop('oasis-android-mock-api.service')
            self.assertTrue(binding.closed)
            self.assertEqual(binding.events[-1], 'close')
            self.assertEqual('unref' in binding.events, failure != 'ref')

    def test_binding_rejects_wrong_array_signature_and_untyped_history(self):
        for change in ('signature', 'history'):
            binding = FakeDBus(); original = binding.Get
            def get(interface, name, **kwargs):
                result = original(interface, name, **kwargs)
                if name == 'ExecStop':
                    if change == 'signature': result.signature = 's'
                    else: result[0] = DBusStruct([*result[0][:3], 0, *result[0][4:]])
                return result
            binding.Get = get
            with self.subTest(change=change), patch.dict(sys.modules, {'dbus': binding.module}):
                with self.assertRaisesRegex(RuntimeError, 'LOADED_COMMAND_DBUS_'):
                    m.Runtime().loaded_stop('oasis-android-mock-db.service')
            self.assertEqual(binding.events[-2:], ['unref', 'close'])

    def test_child_execution_strips_proxy_tls_and_injection_environment(self):
        runtime = m.Runtime('a' * 64)
        result = types.SimpleNamespace(returncode=0, stdout='', stderr='')
        unsafe = {'HTTPS_PROXY': 'https://fixture.invalid', 'http_proxy': 'http://fixture.invalid',
                  'NODE_TLS_REJECT_UNAUTHORIZED': '0', 'NODE_OPTIONS': '--require fixture', 'PYTHONPATH': '/fixture'}
        with patch.dict(m.os.environ, unsafe), patch.object(m.subprocess, 'run', return_value=result) as execute:
            runtime.run(['nginx', '-t'])
            environment = execute.call_args.kwargs['env']
            self.assertFalse(any(key in environment for key in unsafe))
            self.assertEqual(environment['LC_ALL'], 'C')

    def test_proxy_exec_and_copy_use_bound_container_id(self):
        runtime = m.Runtime('a' * 64); runtime.proxy_container_id = '9' * 64
        result = types.SimpleNamespace(returncode=0, stdout='', stderr='')
        with patch.object(m.subprocess, 'run', return_value=result) as execute:
            runtime.run(['docker', 'exec', 'proxy-nginx', 'nginx', '-t'])
            self.assertEqual(execute.call_args.args[0][2], '9' * 64)
            runtime.run(['docker', 'cp', '/fixture/mock.conf', 'proxy-nginx:/etc/nginx/conf.d/oasis-android-mock-acme.conf'])
            self.assertEqual(execute.call_args.args[0][3], '9' * 64 + ':/etc/nginx/conf.d/oasis-android-mock-acme.conf')
        unbound = m.Runtime('a' * 64)
        with patch.object(m.subprocess, 'run') as execute:
            with self.assertRaisesRegex(RuntimeError, 'PROXY_CONTAINER_ID_NOT_BOUND'):
                unbound.run(['docker', 'exec', 'proxy-nginx', 'nginx', '-t'])
            execute.assert_not_called()

    def test_transfer_schema_partial_refuses_before_obligation_read(self):
        runtime = m.Runtime('a' * 64)
        with patch.object(runtime, 'output', return_value='3') as read:
            with self.assertRaisesRegex(RuntimeError, 'TRANSFER_SCHEMA_INCOMPLETE'):
                runtime.database()
            self.assertEqual(read.call_count, 1)

    def test_absent_schema_checks_stray_transfer_ledger_and_read_only(self):
        runtime = m.Runtime('a' * 64)
        row = obligations(transfer_schema='absent', pending_transfer_schema_stray=0)
        with patch.object(runtime, 'output', side_effect=['0', json.dumps(row)]) as read:
            runtime.database()
            query = read.call_args.kwargs['input']
            self.assertIn('READ ONLY', query)
            self.assertIn('pending_transfer_schema_stray', query)
            self.assertIn('transfer_%', query)
            self.assertNotIn('UPDATE', query)
            self.assertEqual(read.call_args.args[0][3], 'a' * 64)

    def test_safe_error_never_repeats_a_secret_or_command(self):
        self.assertEqual(m.safe_error(RuntimeError('password=fixture-private-value')), 'RuntimeError')
        self.assertEqual(m.safe_error(RuntimeError('MOCK_UID_CHANGED')), 'MOCK_UID_CHANGED')


class ResumeTests(unittest.TestCase):
    """The actual fresh() resource/file/public guards run over a stopped fixture.
    Linux identity/file ownership is injected only for local temporary files.
    """
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.base = Path(self.folder.name).resolve()
        self.receipt_dir = self.base / 'receipt'; self.receipt_dir.mkdir(mode=0o700)
        self.volume = self.base / 'volume'; self.volume.mkdir()
        self.mock = self.base / 'mock'; self.mock.mkdir()
        (self.base / 'android-mock-current').symlink_to(self.mock)
        self.runtime = FakeRuntime(inventory(str(self.volume)))
        self.retire = m.Retirer(self.runtime.row, 'e' * 64, 'f' * 64, self.runtime)
        self.retire.state = {'id': 'fixture-owner', 'postgres_image': 'sha256:' + 'b' * 64}
        self.retire.marker = lambda: None; self.retire.nft_guard = lambda: None
        self.public, self.files = {'proof': 'original-public'}, {'proof': 'original-files'}
        def public(expected=None, **kwargs):
            m.require(expected is None or expected == self.public, 'PUBLIC_FRESH_GUARD_CHANGED')
            return copy.deepcopy(self.public)
        self.retire.public_guard = public
        self.retire.files = lambda **kwargs: copy.deepcopy(self.files)
        self.original = capsule(); self.original['tool_sha256'] = m.FAILED_V5_TOOL_SHA
        self.original['at'] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat()
        self.original.update(public=copy.deepcopy(self.public), files=copy.deepcopy(self.files), resources=self.retire.resources())
        self.original['resources']['container']['running'] = True  # old historical PG
        self.check_raw = m.canonical(self.original)
        self.receipt = {'schema': 'android-mock-retirement-receipt-v1', 'inventory_sha256': 'e' * 64,
                        'check_sha256': m.sha(self.check_raw), 'tool_sha256': m.FAILED_V5_TOOL_SHA,
                        'permanent_dedicated_data_deletion_authorized': True, 'phase': 'failed_closed',
                        'passed': False, 'failed_at_phase': 'before_old_installer_stop', 'error_code': 'COMMAND_FAILED_BUSCTL',
                        'history': [{'phase': 'before_old_installer_stop', 'at': self.original['at']},
                                    {'phase': 'failed_closed', 'at': self.original['at'], 'passed': False,
                                     'failed_at_phase': 'before_old_installer_stop', 'error_code': 'COMMAND_FAILED_BUSCTL'}]}
        self.receipt_raw = m.canonical(self.receipt)
        (self.receipt_dir / 'receipt.json').write_bytes(self.receipt_raw)
        self.receipt_sha = m.sha(self.receipt_raw)
        self.stack = ExitStack()
        real_lstat, real_fingerprint, real_body = Path.lstat, m.fingerprint, m.body
        def receipt_lstat(path):
            info = real_lstat(path)
            if path == self.receipt_dir:
                values = list(info); values[4] = 0
                return os.stat_result(values)
            return info
        for scope in (patch.multiple(m, BASE=self.base, MOCK=str(self.mock), RECEIPT=self.receipt_dir,
                                     FAILED_V5_CHECK_SHA=m.sha(self.check_raw), FAILED_V5_RECEIPT_SHA=self.receipt_sha),
                      patch.object(m, 'body', side_effect=lambda path, **kwargs: real_body(path, owner=os.getuid())),
                      patch.object(m, 'fingerprint', side_effect=lambda path, *args: real_fingerprint(path, (os.getuid(),))),
                      patch.object(m, 'mount_points', return_value=()), patch.object(Path, 'lstat', receipt_lstat)):
            self.stack.enter_context(scope)

    def tearDown(self):
        self.stack.close(); self.folder.cleanup()

    def test_historical_v5_is_not_fresh_authorization_and_check_does_not_query_pg(self):
        with self.assertRaisesRegex(RuntimeError, 'SAFE_CHECK_EXPIRED_OR_FUTURE'):
            m.validate_capsule(self.original, 'e' * 64, m.FAILED_V5_TOOL_SHA)
        reviewed = self.retire.resume_check(self.check_raw, self.receipt_sha)
        self.assertEqual(self.runtime.database_calls, 0)
        self.assertEqual(self.runtime.commands, [])
        self.assertFalse(reviewed['resources']['container']['running'])
        self.assertEqual(reviewed['files'], self.original['files'])
        self.assertNotIn('database', reviewed)
        m.validate_resume_check(reviewed, 'e' * 64, 'f' * 64)
        self.assertEqual((self.receipt_dir / 'receipt.json').read_bytes(), self.receipt_raw)

    def test_any_origin_byte_tool_or_receipt_phase_history_change_refuses(self):
        for raw in (self.check_raw + b' ', b'{}'):
            with self.assertRaisesRegex(RuntimeError, 'RESUME_ORIGINAL_EXTERNAL_HASH_MISMATCH'):
                m.resume_origin(raw, self.receipt_raw, 'e' * 64)
        changes = ({'phase': 'complete'}, {'failed_at_phase': 'before_irreversible_volume_deletion'},
                   {'error_code': 'OTHER_ERROR'}, {'tool_sha256': '0' * 64},
                   {'history': self.receipt['history'] + [{'phase': 'tombstone', 'at': m.now()}]},
                   {'permanent_dedicated_data_deletion_authorized': False}, {'routing': {}})
        for changeset in changes:
            changed = m.canonical({**self.receipt, **changeset})
            with self.subTest(change=changeset), patch.object(m, 'FAILED_V5_RECEIPT_SHA', m.sha(changed)):
                with self.assertRaisesRegex(RuntimeError, 'RESUME_ORIGINAL_(RECEIPT|HISTORY)_NOT_SUPPORTED'):
                    m.resume_origin(self.check_raw, changed, 'e' * 64)
        with patch.object(m, 'FAILED_V5_TOOL_SHA', '0' * 64):
            with self.assertRaisesRegex(RuntimeError, 'SAFE_CHECK_BINDING_MISMATCH'):
                m.resume_origin(self.check_raw, self.receipt_raw, 'e' * 64)

    def test_fresh_public_file_consumer_or_live_uid_changes_refuse_before_resume(self):
        for what in ('public', 'files', 'consumer', 'uid', 'running', 'pending_unit'):
            before_public, before_files = copy.deepcopy(self.public), copy.deepcopy(self.files)
            before_service = self.runtime.service
            if what == 'public': self.public['proof'] = 'changed'
            if what == 'files': self.files['proof'] = 'changed'
            if what == 'consumer': self.runtime.volume_consumers.append('foreign')
            if what == 'uid': self.runtime.uid_live = True
            if what == 'running': self.runtime.container['running'] = True
            if what == 'pending_unit': self.runtime.service = lambda unit: {'ActiveState': 'active', 'MainPID': '9', 'UnitFileState': 'enabled'}
            with self.subTest(what=what), self.assertRaises(RuntimeError):
                self.retire.resume_check(self.check_raw, self.receipt_sha)
            self.public, self.files = before_public, before_files
            self.runtime.volume_consumers = [m.CONTAINER]; self.runtime.uid_live = False
            self.runtime.container['running'] = False; self.runtime.service = before_service
            self.assertEqual(self.runtime.commands, [])

    def test_resume_receipt_extra_files_or_nested_mount_refuse(self):
        extra = self.receipt_dir / 'foreign'; extra.write_text('fixture')
        with self.assertRaisesRegex(RuntimeError, 'RESUME_RECEIPT_DIRECTORY_NOT_PRISTINE'):
            self.retire.resume_check(self.check_raw, self.receipt_sha)
        extra.unlink()
        with patch.object(m, 'mount_points', return_value=(self.receipt_dir / 'same-device-bind',)):
            with self.assertRaisesRegex(RuntimeError, 'NESTED_MOUNT'):
                self.retire.resume_check(self.check_raw, self.receipt_sha)

    def test_new_resume_capsule_expired_future_wrong_tool_or_origin_refuses(self):
        reviewed = self.retire.resume_check(self.check_raw, self.receipt_sha)
        observed = dt.datetime.fromisoformat(reviewed['at']).timestamp()
        for clock in (observed - 1, observed + 601):
            with self.assertRaisesRegex(RuntimeError, 'RESUME_CHECK_EXPIRED_OR_FUTURE'):
                m.validate_resume_check(reviewed, 'e' * 64, 'f' * 64, clock)
        for key in ('tool_sha256', 'original_receipt_sha256', 'original_check_sha256', 'original_tool_sha256'):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'RESUME_CHECK_BINDING_MISMATCH'):
                m.validate_resume_check({**reviewed, key: '0' * 64}, 'e' * 64, 'f' * 64)

    def test_apply_rechecks_reviewed_proof_and_preserves_unknown_receipt(self):
        reviewed = self.retire.resume_check(self.check_raw, self.receipt_sha)
        self.runtime.service = lambda unit: {'ActiveState': 'inactive', 'MainPID': '0', 'UnitFileState': 'static'}
        with self.assertRaisesRegex(RuntimeError, 'RESUME_APPLY_FRESH_CHECK_CHANGED'):
            self.retire.resume_apply(reviewed, self.check_raw, self.receipt_sha)
        self.assertEqual((self.receipt_dir / 'receipt.json').read_bytes(), self.receipt_raw)
        self.assertFalse((self.receipt_dir / 'failed-v5-receipt.json').exists())
        self.assertEqual(self.runtime.commands, [])

    def test_resume_continuation_keeps_original_chain_no_old_stop_and_pg_finally(self):
        for failure in ('query', 'start', 'pending'):
            with self.subTest(failure=failure):
                reviewed = self.retire.resume_check(self.check_raw, self.receipt_sha)
                self.runtime.database_calls = 1; self.runtime.failure = failure
                self.runtime.pending_after_stop = failure == 'pending'
                with self.assertRaises(RuntimeError):
                    self.retire.resume_apply(reviewed, self.check_raw, self.receipt_sha)
                preserved = self.receipt_dir / 'failed-v5-receipt.json'
                self.assertEqual(preserved.read_bytes(), self.receipt_raw)
                current = m.decode((self.receipt_dir / 'receipt.json').read_bytes())
                self.assertEqual(current['history'][:2], self.receipt['history'])
                self.assertEqual(current['tool_sha256'], m.FAILED_V5_TOOL_SHA)
                self.assertEqual(current['check_sha256'], m.FAILED_V5_CHECK_SHA)
                self.assertEqual(current['resume']['tool_sha256'], 'f' * 64)
                self.assertIn(('docker', 'start', 'a' * 64), self.runtime.commands)
                self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), self.runtime.commands)
                self.assertFalse(any('rm' in command or command[0] == '/usr/bin/python3' or
                                     command[:2] == ('systemctl', 'start') for command in self.runtime.commands))
                with self.assertRaisesRegex(RuntimeError, 'RESUME_RECEIPT_DIRECTORY_NOT_PRISTINE'):
                    self.retire.resume_check(self.check_raw, self.receipt_sha)
                # Reset ONLY these temporary fixture bytes, never live evidence.
                preserved.unlink(); (self.receipt_dir / 'receipt.json').write_bytes(self.receipt_raw)
                self.runtime.commands = []; self.retire.receipt = None


class V6RecoveryTests(unittest.TestCase):
    tearDown = ResumeTests.tearDown

    def setUp(self):
        ResumeTests.setUp(self)
        self.tls, self.bridge = self.base / 'tls.conf', self.base / 'bridge.conf'
        original_tls, original_bridge = b'fixture old tls', b'fixture old bridge'
        host, proxy = b'fixture authored retired TLS 410\n', b'fixture authored retired HTTP 410\n'
        self.tls.write_bytes(host); self.tls.chmod(0o600)
        self.runtime.proxy, self.runtime.proxy_mode = proxy.decode().strip(), 0o600
        self.raw_proxy_sha = m.sha(proxy)
        self.original['files'].update(routing={str(self.tls): {'sha256': m.sha(original_tls)},
                                               str(self.bridge): {'sha256': m.sha(original_bridge)}},
                                      proxy_routing_sha256=m.sha(b'original proxy'))
        self.check_raw = m.canonical(self.original)
        self.receipt['check_sha256'] = m.sha(self.check_raw)
        self.receipt_raw = m.canonical(self.receipt); self.receipt_sha = m.sha(self.receipt_raw)
        self.old_resume = {'schema': 'android-mock-retirement-resume-check-v1', 'at': self.original['at'],
                           'read_only': True, 'passed': True, 'inventory_sha256': 'e' * 64,
                           'tool_sha256': m.FAILED_V6_TOOL_SHA, 'original_tool_sha256': m.FAILED_V5_TOOL_SHA,
                           'original_check_sha256': m.sha(self.check_raw), 'original_receipt_sha256': self.receipt_sha,
                           'mock_database_readback': 'historical-only; fresh SQL required in resume-apply'}
        self.resume_raw = m.canonical(self.old_resume); resume_sha = m.sha(self.resume_raw)
        proof = {'tool_sha256': m.FAILED_V6_TOOL_SHA, 'check_sha256': resume_sha,
                 'original_receipt_sha256': self.receipt_sha, 'original_check_sha256': m.sha(self.check_raw),
                 'original_tool_sha256': m.FAILED_V5_TOOL_SHA, 'old_installer_stop_repeated': False}
        routing = {'tls_sha256': m.sha(host), 'proxy_sha256': m.sha(proxy.strip())}
        self.v6_receipt = {**self.receipt, 'failed_at_phase': 'tombstone_verified_before_data_deletion',
                           'error_code': 'MOCK_PROXY_CONFIG_UNSAFE', 'resume': proof, 'routing': routing,
                           'database': obligations(), 'history': [*self.receipt['history'],
                           {'phase': 'v6_resume_after_verified_old_installer_stop', 'at': m.now(), 'resume': proof},
                           {'phase': 'post_stop_business_readback', 'at': m.now(), 'database': obligations()},
                           {'phase': 'tombstone_verified_before_data_deletion', 'at': m.now(), 'routing': routing},
                           {'phase': 'failed_closed', 'at': m.now(), 'passed': False,
                            'failed_at_phase': 'tombstone_verified_before_data_deletion', 'error_code': 'MOCK_PROXY_CONFIG_UNSAFE'}]}
        self.v6_receipt_raw = m.canonical(self.v6_receipt); self.v6_receipt_sha = m.sha(self.v6_receipt_raw)
        for name, value in {'receipt.json': self.v6_receipt_raw, 'failed-v5-receipt.json': self.receipt_raw,
                            'tls.conf': original_tls, 'bridge.conf': original_bridge,
                            'proxy.conf': b'original proxy', 'proxy-tombstone.conf': proxy}.items():
            path = self.receipt_dir / name; path.write_bytes(value); path.chmod(0o600)
        prior_fingerprint, prior_lstat, prior_regular = m.fingerprint, Path.lstat, m.regular
        def fingerprint(path, *args):
            row = prior_fingerprint(path, *args); row['uid'] = row['gid'] = 0
            return row
        def lstat(path):
            info = prior_lstat(path)
            if path == self.base:
                values = list(info); values[4] = values[5] = 0
                return os.stat_result(values)
            return info
        for scope in (patch.multiple(m, TLS=self.tls, BRIDGE=self.bridge,
                                     FAILED_V5_CHECK_SHA=m.sha(self.check_raw), FAILED_V5_RECEIPT_SHA=self.receipt_sha,
                                     FAILED_V6_CHECK_SHA=resume_sha, FAILED_V6_RECEIPT_SHA=self.v6_receipt_sha,
                                     V6_TLS_SHA=m.sha(host), V6_PROXY_SHA=m.sha(proxy.strip()), V6_PROXY_RAW_SHA=m.sha(proxy)),
                      patch.object(m, 'fingerprint', side_effect=fingerprint), patch.object(Path, 'lstat', lstat),
                      patch.object(m, 'regular', side_effect=lambda path, **kwargs: prior_regular(path, owner=os.getuid(),
                          **{key: value for key, value in kwargs.items() if key != 'owner'}))):
            self.stack.enter_context(scope)
        prior_output, prior_run = self.runtime.output, self.runtime.run
        def output(args, **kwargs):
            if args[-2:] == ['%u:%g:%a:%h:%F:%d:%i:%s', m.PROXY_CONF]:
                return '0:0:' + format(self.runtime.proxy_mode, 'o') + ':1:regular file:1:2:' + str(len(proxy))
            if args[-2:] == ['%u:%g:%a:%F:%d:%i', str(Path(m.PROXY_CONF).parent)]:
                return '0:0:755:directory:1:3'
            if 'sha256sum' in args: return self.raw_proxy_sha + '  ' + m.PROXY_CONF
            return prior_output(args, **kwargs)
        def run(args, **kwargs):
            if args[:5] == ['docker', 'exec', 'proxy-nginx', '/bin/sh', '-c']:
                self.runtime.commands.append(tuple(args)); self.runtime.proxy_mode = 0o644
                return types.SimpleNamespace(returncode=0, stdout='', stderr='')
            return prior_run(args, **kwargs)
        self.runtime.output, self.runtime.run = output, run
        def files(**kwargs):
            if kwargs.get('_exact_v6_mode_recovery'): self.retire.v6_mode_guard()
            else: self.retire.proxy_file_guard()
            return copy.deepcopy(self.files)
        self.retire.files = files
        self.retire.tombstone = lambda: self.fail('recovery must not re-create tombstone')

    def check(self):
        return self.retire.recover_v6_check(self.check_raw, self.resume_raw, self.v6_receipt_sha)

    def test_readonly_600_exception_is_exact_and_normal_proxy_guard_stays644(self):
        reviewed = self.check()
        self.assertEqual(self.runtime.commands, []); self.assertEqual(self.runtime.database_calls, 0)
        self.assertEqual(len(reviewed['receipt_files']), 6)
        with self.assertRaisesRegex(RuntimeError, 'MOCK_PROXY_CONFIG_UNSAFE'):
            self.retire.proxy_file_guard()
        m.validate_v6_recovery_check(reviewed, 'e' * 64, 'f' * 64)
        stamp = dt.datetime.fromisoformat(reviewed['at']).timestamp()
        with self.assertRaisesRegex(RuntimeError, 'V6_RECOVERY_CHECK_EXPIRED_OR_FUTURE'):
            m.validate_v6_recovery_check(reviewed, 'e' * 64, 'f' * 64, stamp + 601)
        with self.assertRaisesRegex(RuntimeError, 'RESUME_CHECK_EXPIRED_OR_FUTURE'):
            m.validate_resume_check(self.old_resume, 'e' * 64, m.FAILED_V6_TOOL_SHA)
        future = {**self.old_resume, 'at': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()}
        with self.assertRaisesRegex(RuntimeError, 'RESUME_CHECK_EXPIRED_OR_FUTURE'):
            m.validate_resume_check(future, 'e' * 64, m.FAILED_V6_TOOL_SHA, historical=True)

    def test_unknown_body_receipt_extra_file_and_symlink_refuse_no_mutation(self):
        for what in ('body', 'rawproxy', 'symlink', 'extra', 'bridge'):
            original_host = self.tls.read_bytes()
            if what == 'body': self.tls.write_bytes(b'unknown public upstream')
            if what == 'rawproxy': self.raw_proxy_sha = '0' * 64
            if what == 'symlink':
                self.tls.unlink(); self.tls.symlink_to(self.receipt_dir / 'tls.conf')
            if what == 'extra': (self.receipt_dir / 'foreign').write_text('fixture')
            if what == 'bridge': self.bridge.write_text('unknown')
            with self.subTest(what=what), self.assertRaises(RuntimeError): self.check()
            self.assertEqual(self.runtime.commands, [])
            if what == 'symlink': self.tls.unlink(); self.tls.write_bytes(original_host); self.tls.chmod(0o600)
            if what == 'body': self.tls.write_bytes(original_host)
            if what == 'extra': (self.receipt_dir / 'foreign').unlink()
            if what == 'bridge': self.bridge.unlink()
            self.raw_proxy_sha = m.V6_PROXY_RAW_SHA

    def test_v6_history_phase_or_source_change_refuses_even_with_rebound_fixture_hash(self):
        for changes in ({'failed_at_phase': 'before_container_removal'}, {'phase': 'complete'},
                        {'history': self.v6_receipt['history'] + [{'phase': 'before_container_removal'}]},
                        {'resume': {**self.v6_receipt['resume'], 'old_installer_stop_repeated': True}}):
            raw = m.canonical({**self.v6_receipt, **changes})
            with self.subTest(change=changes), patch.object(m, 'FAILED_V6_RECEIPT_SHA', m.sha(raw)):
                with self.assertRaisesRegex(RuntimeError, 'V6_RECOVERY_'):
                    m.v6_origin(self.check_raw, self.resume_raw, raw, self.receipt_raw, 'e' * 64)

    def test_apply_repairs_only_authored_modes_preserves_chain_and_continues_after_tombstone(self):
        reviewed = self.check(); self.runtime.database_calls = 1
        self.retire.after_tombstone = lambda original: self.retire.receipt
        result = self.retire.recover_v6_apply(reviewed, self.check_raw, self.resume_raw, self.v6_receipt_sha)
        self.assertEqual(stat.S_IMODE(self.tls.stat().st_mode), 0o644)
        self.assertEqual(self.runtime.proxy_mode, 0o644)
        self.assertEqual((self.receipt_dir / 'failed-v6-receipt.json').read_bytes(), self.v6_receipt_raw)
        self.assertEqual(result['history'][:6], self.v6_receipt['history'])
        self.assertEqual(result['tool_sha256'], m.FAILED_V5_TOOL_SHA)
        self.assertEqual(result['resume'], self.v6_receipt['resume'])
        self.assertEqual(result['recovery']['tool_sha256'], 'f' * 64)
        self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), self.runtime.commands)
        self.assertFalse(any(command[0] == '/usr/bin/python3' or command[:2] == ('systemctl', 'start')
                             or command[:2] == ('docker', 'cp') for command in self.runtime.commands))

    def test_failed_sql_or_new_obligation_stops_pg_and_retains_data(self):
        for problem in ('query', 'pending'):
            reviewed = self.check(); self.runtime.database_calls = 1
            self.runtime.failure = problem; self.runtime.pending_after_stop = problem == 'pending'
            with self.subTest(problem=problem), self.assertRaises(RuntimeError):
                self.retire.recover_v6_apply(reviewed, self.check_raw, self.resume_raw, self.v6_receipt_sha)
            self.assertIn(('docker', 'stop', '--time', '30', 'a' * 64), self.runtime.commands)
            self.assertFalse(any('rm' in command for command in self.runtime.commands))
            self.assertEqual((self.receipt_dir / 'failed-v6-receipt.json').read_bytes(), self.v6_receipt_raw)
            # Reset only this temporary fixture; live recovery is never repeated.
            (self.receipt_dir / 'failed-v6-receipt.json').unlink()
            (self.receipt_dir / 'receipt.json').write_bytes(self.v6_receipt_raw)
            self.tls.chmod(0o600); self.runtime.proxy_mode = 0o600
            self.runtime.commands = []; self.retire.receipt = None

    def test_guard_refusal_cannot_chmod_unknown_host_file(self):
        reviewed = self.check(); self.tls.write_bytes(b'unknown file')
        with self.assertRaisesRegex(RuntimeError, 'V6_RECOVERY_HOST_BODY_OR_MODE_CHANGED'):
            self.retire.repair_v6_modes(reviewed['routing_modes'])
        self.assertEqual(self.tls.read_bytes(), b'unknown file')
        self.assertEqual(stat.S_IMODE(self.tls.stat().st_mode), 0o600)
        self.assertEqual(self.runtime.commands, [])

    def test_proxy_script_real_shell_fd_survives_exec_and_rejects_path_swap(self):
        reviewed = self.check()
        self.retire.receipt = self.v6_receipt
        self.retire.repair_v6_modes(reviewed['routing_modes'])
        command = next(row for row in self.runtime.commands if row[:5] == ('docker', 'exec', 'proxy-nginx', '/bin/sh', '-c'))
        script = command[5]
        helpers = self.base / 'helpers'; helpers.mkdir()
        dispatcher = '''import hashlib,os,pathlib,stat,sys
name=pathlib.Path(sys.argv[0]).name
p=sys.argv[-1]
is_fd=p=='/proc/self/fd/3'
if name=='stat':
 s=os.fstat(3) if is_fd else os.lstat(p)
 kind='regular file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symbolic link'
 fields=[str(s.st_uid),str(s.st_gid),format(stat.S_IMODE(s.st_mode),'o')]
 if '%h' in sys.argv[-2]: fields += [str(s.st_nlink),kind,str(s.st_dev),str(s.st_ino),str(s.st_size)]
 else: fields += [kind,str(s.st_dev),str(s.st_ino)]
 print(':'.join(fields),flush=True)
 if os.environ.get('FIXTURE_SWAP_TARGET')==p and not pathlib.Path(p+'.old').exists():
  os.rename(p,p+'.old');os.symlink(os.environ['FIXTURE_FOREIGN'],p)
elif name=='sha256sum':
 if is_fd:
  os.lseek(3,0,0)
  with os.fdopen(os.dup(3),'rb') as f: data=f.read()
 else: data=pathlib.Path(p).read_bytes()
 print(hashlib.sha256(data).hexdigest()+'  '+p)
elif name=='chmod':
 assert sys.argv[1:] == ['644','/proc/self/fd/3']
 os.fchmod(3,0o644)
 pathlib.Path(os.environ['FIXTURE_CHMOD_MARKER']).write_text('called')
else: raise RuntimeError('UNEXPECTED_FIXTURE_TOOL')
'''
        for name in ('stat', 'sha256sum', 'chmod'):
            path = helpers / name; path.write_text('#!' + sys.executable + '\n' + dispatcher); path.chmod(0o700)
        for swapping in (False, True):
            target = self.base / ('proxy-' + str(swapping)); target.write_bytes(b'fixture proxy body\n'); target.chmod(0o600)
            foreign = self.base / ('foreign-' + str(swapping)); foreign.write_bytes(b'foreign shared config'); foreign.chmod(0o600)
            marker = self.base / ('chmod-marker-' + str(swapping))
            s, d = target.stat(), self.base.stat()
            before = ':'.join(map(str, (s.st_uid,s.st_gid,'600',s.st_nlink,'regular file',s.st_dev,s.st_ino,s.st_size)))
            after = before.split(':'); after[2] = '644'
            parent = ':'.join(map(str, (d.st_uid,d.st_gid,format(stat.S_IMODE(d.st_mode),'o'),'directory',d.st_dev,d.st_ino)))
            env = {**os.environ, 'PATH': str(helpers), 'FIXTURE_CHMOD_MARKER': str(marker)}
            if swapping: env.update(FIXTURE_SWAP_TARGET=str(target), FIXTURE_FOREIGN=str(foreign))
            actual = m.subprocess.run(['/bin/sh','-c',script,'fd-mode-fixture',str(target),m.sha(target.read_bytes()),
                                       str(self.base),parent,before,':'.join(after)],capture_output=True,text=True,env=env)
            with self.subTest(swapping=swapping):
                self.assertEqual(actual.returncode == 0, not swapping)
                self.assertEqual(marker.exists(), not swapping)
                self.assertEqual(stat.S_IMODE(foreign.stat().st_mode), 0o600)
                if not swapping: self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
                else: self.assertEqual(stat.S_IMODE(Path(str(target)+'.old').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
