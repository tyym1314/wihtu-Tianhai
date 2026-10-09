"""Pure and temporary-FS recovery contracts; no real Docker/DB/service calls."""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('network_recovery_test', HERE / 'recover-bootstrap-network.py')
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)
p, r = n.p, n.r
NEW_ID = 'a' * 64


def origin():
    marker = {'schema': 1, 'kind': 'isolated-production-instance', 'release': n.OLD_RELEASE,
              'manifest_sha256': n.OLD_MANIFEST, 'container_id': r.CID, 'owner': r.OWNER,
              'uid': 997, 'gid': 999, 'network_id': r.NETWORK_ID, 'pg_image': r.IMAGE,
              'origins': ['https://oasis-player.43.98.202.236.sslip.io', 'https://game.tianyahuyu.com'],
              'volume_identity': {'Name': p.VOLUME, 'CreatedAt': '2026-10-10T02:23:40+08:00',
                                  'Driver': 'local', 'Options': None, 'Mountpoint': str(r.VOLUME_PATH)},
              'private_pins': {name: {'sha256': 'e' * 64} for name in
                               ('runtime.env', 'postgres.env', 'operator-credentials.json', 'state/master.key')}}
    failure = {'schema': 1, 'kind': 'isolated-production-created-recovery', 'phase': 'failed_closed',
               'passed': False, 'failed_at_phase': 'database_resources_created', 'error_code': 'COMMAND_FAILED_NODE',
               'container_id': r.CID, 'recovery_tool_sha256': n.PREVIOUS_TOOL,
               'original_failed_receipt_sha256': r.OLD_RECEIPT,
               'source': {k: v for k, v in n.OLD_HELPERS.items() if k != 'recover-created.py'}}
    return marker, failure


def database():
    return {'database': p.DATABASE, 'database_oid': '16384', 'role': p.DB_APP, 'privileged': False,
            'login': True, 'schema_owner': p.DB_APP, 'relations': 0, 'server_addr': '172.19.0.2', 'server_port': 5432}


def history():
    return {'schema': 1, 'kind': 'retired-unactivated-bootstrap-failed-candidate', 'passed': True,
            'retired': True, 'activated': False, 'release': n.OLD_RELEASE, 'manifest_sha256': n.OLD_MANIFEST,
            'members': 1161, 'marker_sha256': n.OLD_MARKER, 'failed_receipt_sha256': r.OLD_RECEIPT,
            'recovery_failed_receipt_sha256': n.FAILED2, 'original_recovery_sha256': n.PREVIOUS_TOOL,
            'database_oid': '16384', 'created_container_id': r.CID,
            'original_helpers': {k: v for k, v in n.OLD_HELPERS.items() if k != 'recover-created.py'},
            'production_pin': n.PIN_META, 'production_pin_removed': True, 'volume_metadata': n.VOLUME_META,
            'original_private_pins': origin()[0]['private_pins'],
            'public_manifest_sha256': n.PUBLIC_MANIFEST, 'protected_inventory_sha256': r.PROTECTED_SHA,
            'protected_before_sha256': r.PUBLIC_SNAPSHOT_SHA, 'protected_after_sha256': r.PUBLIC_SNAPSHOT_SHA,
            'runtime_dependencies': r.DEPENDENCIES, 'dependencies_match': '/opt/oasis/releases/20261009-03',
            'archive_sha256': n.ARCHIVE_SHA, 'archive_bytes': 195388678,
            'source_archive_provenance': {'bytes': 195388678, 'passed': True, 'contains_node_modules': False,
                'verified_source_members': 1161, 'manifest_sha256': n.OLD_MANIFEST, 'archive_sha256': n.ARCHIVE_SHA}}


def instance():
    tool = n.Recovery.__new__(n.Recovery)
    tool.runtime = Mock()
    tool.release = Path(n.NEW_RELEASE)
    tool.args = types.SimpleNamespace(manifest_sha256='f' * 64, retired_source=str(n.HISTORY),
        retired_source_sha256='b' * 64, check_sha256='c' * 64, recover_exact_bootstrap_network_closed=True)
    tool.marker, _ = origin()
    tool.receipt = {'history': [], 'phase': 'original_evidence_preserved', 'container_id': r.CID}
    tool.network_state = 'old'
    tool.new_network_id = NEW_ID
    return tool


def resource_fixture():
    tool = instance()
    c = {'Id': r.CID, 'Name': '/' + p.CONTAINER, 'Image': r.IMAGE, 'Config': {'Labels': {p.LABEL: r.OWNER}},
         'State': {'Status': 'running', 'Running': True}, 'HostConfig': {'PortBindings': p.PG_PORT_BINDINGS, 'NetworkMode': p.NETWORK},
         'Mounts': [{'Type': 'volume', 'Name': p.VOLUME, 'Source': str(r.VOLUME_PATH),
                     'Destination': '/var/lib/postgresql/data', 'RW': True}],
         'NetworkSettings': {'Networks': {p.NETWORK: {'NetworkID': r.NETWORK_ID}}, 'Ports': {'5432/tcp': None}}}
    v = {**tool.marker['volume_identity'], 'Labels': {p.LABEL: r.OWNER}}
    old = {'Id': r.NETWORK_ID, 'Name': p.NETWORK, 'Driver': 'bridge', 'Internal': True,
           'Options': {}, 'Labels': {p.LABEL: r.OWNER}, 'Containers': {r.CID: {}}}
    new = {**old, 'Id': NEW_ID, 'Internal': False, 'Options': p.NETWORK_OPTIONS}
    def inspect(kind, ident):
        return copy.deepcopy(c if kind == 'container' else v if kind == 'volume' else old if ident == r.NETWORK_ID else new)
    tool.runtime.inspect.side_effect = inspect
    tool.runtime.command.return_value = r.CID
    def fingerprint(path):
        if path == r.VOLUME_PATH:
            return n.VOLUME_META
        if path == p.PRIVATE:
            return {'kind': 'directory', 'uid': 0, 'gid': 999, 'mode': 0o750}
        if path == p.PRIVATE / 'state':
            return {'kind': 'directory', 'uid': 997, 'gid': 999, 'mode': 0o700}
        return tool.marker['private_pins'][str(Path(path).relative_to(p.PRIVATE))]
    return tool, c, v, old, new, fingerprint


class OriginAndDatabase(unittest.TestCase):
    def test_exact_origin(self):
        n.origin_guard(*origin())

    def test_actual_failure_and_marker_contract(self):
        base = HERE.parents[1] / 'review/production-instance-20261010'
        if not (base / 'pre-retire-02-v1.json').exists():
            self.skipTest('ignored historical server evidence is not packaged')
        marker = json.loads((base / 'pre-retire-02-v1.json').read_text())['marker']
        value = json.loads((base / 'recover-failure-v1-independent.json').read_text())
        self.assertEqual(value['receipt_sha256'], n.FAILED2)
        n.origin_guard(marker, value['receipt'])

    def test_changed_original_identity_is_refused(self):
        for field, bad in [('container_id', NEW_ID), ('uid', True), ('gid', 998), ('owner', 'x'),
                           ('network_id', NEW_ID), ('manifest_sha256', '0' * 64), ('release', n.NEW_RELEASE)]:
            marker, failure = origin()
            marker[field] = bad
            with self.subTest(field=field), self.assertRaisesRegex(p.Refusal, 'ORIGINAL_MARKER'):
                n.origin_guard(marker, failure)

    def test_success_or_other_failure_phase_is_refused(self):
        for field, bad in [('passed', True), ('phase', 'complete_closed'), ('failed_at_phase', 'production_bootstrap_proved'),
                           ('error_code', 'OTHER'), ('cleanup_error_code', 'STOP_FAILED'), ('bootstrap', {}), ('unit_pins', {})]:
            marker, failure = origin()
            failure[field] = bad
            with self.subTest(field=field), self.assertRaisesRegex(p.Refusal, 'ORIGINAL_FAILURE'):
                n.origin_guard(marker, failure)

    def test_original_helper_hash_cannot_change(self):
        marker, failure = origin()
        failure['source'] = {**failure['source'], 'provision.py': '0' * 64}
        with self.assertRaisesRegex(p.Refusal, 'ORIGINAL_FAILURE'):
            n.origin_guard(marker, failure)

    def test_empty_database_and_correct_container_connection(self):
        self.assertEqual(n.validate_database_evidence(database(), '172.19.0.2'), database())

    def test_nonempty_wrong_oid_role_or_privilege_blocks_bootstrap(self):
        for field, bad in [('relations', 1), ('relations', False), ('relations', '0'), ('database_oid', '16385'),
                           ('role', p.DB_OWNER), ('schema_owner', p.DB_OWNER), ('privileged', None),
                           ('privileged', True), ('login', False), ('database', 'other')]:
            value = database(); value[field] = bad
            with self.subTest(field=field, bad=bad), self.assertRaisesRegex(p.Refusal, 'DATABASE_NOT_EXACT_EMPTY'):
                n.validate_database_evidence(value)

    def test_wrong_server_ip_or_port_is_refused(self):
        for field, bad in [('server_addr', '127.0.0.1'), ('server_port', 18893)]:
            value = database(); value[field] = bad
            with self.subTest(field=field), self.assertRaisesRegex(p.Refusal, 'NOT_OWN_CONTAINER'):
                n.validate_database_evidence(value, '172.19.0.2')


class HistoricalSource(unittest.TestCase):
    def fixture(self, value=None):
        value = copy.deepcopy(value or history())
        manifest = {'member-' + str(i): '0' * 64 for i in range(1161 - len(n.OLD_HELPERS))}
        manifest.update({'platform/deploy/production-instance/' + k: v for k, v in n.OLD_HELPERS.items()})
        paths = {'RELEASE-MANIFEST.json': n.OLD_MANIFEST, 'marker-original.json': n.OLD_MARKER,
                 'receipt-original.json': r.OLD_RECEIPT, 'recovery-created-receipt-original.json': n.FAILED2,
                 'production-pin.json': 'c' * 64, **{'helpers/' + k: v for k, v in n.OLD_HELPERS.items()}}
        value['preservation'] = {k: {'sha256': v} for k, v in paths.items()}
        def read(path, sha=None):
            path = Path(path)
            if path == n.HISTORY:
                return p.canonical(value), {'sha256': 'b' * 64}
            name = str(path.relative_to(n.HISTORY.parent))
            body = p.canonical(manifest) if name == 'RELEASE-MANIFEST.json' else p.canonical(n.PIN_META) if name == 'production-pin.json' else b'old immutable bytes'
            return body, value['preservation'][name]
        return value, read

    def test_history_is_read_without_executing_or_resolving_old_release(self):
        value, read = self.fixture()
        directory = {'kind': 'directory', 'uid': 0, 'gid': 0, 'mode': 0o700}
        with patch.object(r, 'read_bound', side_effect=read) as bound, patch.object(p, 'fingerprint', return_value=directory), patch.object(p, 'no_mount'):
            self.assertEqual(n.history_guard(n.HISTORY, n.HISTORY_SHA)['receipt'], value)
        self.assertFalse(any(str(c.args[0]).startswith(n.OLD_RELEASE) for c in bound.call_args_list))
        self.assertEqual(len([c for c in bound.call_args_list if '/helpers/' in str(c.args[0])]), 6)

    def test_proof_fields_cannot_be_generalized(self):
        for field, bad in [('activated', True), ('retired', False), ('release', n.NEW_RELEASE), ('members', 1160),
                           ('database_oid', '16385'), ('original_helpers', {}), ('production_pin', {}),
                           ('volume_metadata', {}), ('production_pin_removed', False), ('original_private_pins', {}), ('public_manifest_sha256', '0' * 64),
                           ('protected_after_sha256', '0' * 64), ('runtime_dependencies', {})]:
            value = history(); value[field] = bad
            _, read = self.fixture(value)
            with self.subTest(field=field), patch.object(r, 'read_bound', side_effect=read), self.assertRaisesRegex(p.Refusal, 'RETIRED_SOURCE'):
                n.history_guard(n.HISTORY, n.HISTORY_SHA)

    def test_wrong_archive_evidence_is_refused(self):
        value = history(); value['source_archive_provenance']['archive_sha256'] = 'c' * 64
        _, read = self.fixture(value)
        with patch.object(r, 'read_bound', side_effect=read), self.assertRaisesRegex(p.Refusal, 'ARCHIVE_PROOF'):
            n.history_guard(n.HISTORY, n.HISTORY_SHA)

    def test_other_history_path_is_refused_before_read(self):
        with patch.object(r, 'read_bound') as read, self.assertRaisesRegex(p.Refusal, 'HISTORY_INPUT'):
            n.history_guard('/tmp/retired-source.json', 'b' * 64)
        read.assert_not_called()

    def test_actual_retired_receipt_schema_and_all_eleven_preserved_pins(self):
        path = HERE.parents[1] / 'review/production-instance-20261010/retired-source02-v1.json'
        if not path.exists():
            self.skipTest('ignored historical server evidence is not packaged')
        raw = path.read_bytes(); self.assertEqual(p.digest(raw), n.HISTORY_SHA)
        value = json.loads(raw)
        manifest = {'member-' + str(i): '0' * 64 for i in range(1161 - len(n.OLD_HELPERS))}
        manifest.update({'platform/deploy/production-instance/' + k: v for k, v in n.OLD_HELPERS.items()})
        def read(path, sha=None):
            path = Path(path)
            if path == n.HISTORY:
                return raw, {'sha256': n.HISTORY_SHA}
            name = str(path.relative_to(n.HISTORY.parent))
            body = p.canonical(manifest) if name == 'RELEASE-MANIFEST.json' else p.canonical(n.PIN_META) if name == 'production-pin.json' else b'old immutable bytes'
            return body, value['preservation'][name]
        directory = {'kind': 'directory', 'uid': 0, 'gid': 0, 'mode': 0o700}
        with patch.object(r, 'read_bound', side_effect=read), patch.object(p, 'fingerprint', return_value=directory), patch.object(p, 'no_mount'):
            result = n.history_guard(n.HISTORY, n.HISTORY_SHA)
        self.assertEqual(result['receipt'], value); self.assertEqual(len(result['files']), 11)

    def test_other_external_retirement_sha_never_reads_history(self):
        with patch.object(r, 'read_bound') as read, self.assertRaisesRegex(p.Refusal, 'HISTORY_INPUT'):
            n.history_guard(n.HISTORY, 'b' * 64)
        read.assert_not_called()


class ScopeAndStops(unittest.TestCase):
    def run_scope(self, tool, fingerprint, allowed):
        with patch.object(p, 'account_guard'), patch.object(p, 'no_mount'), patch.object(p, 'fingerprint', side_effect=fingerprint):
            return tool.core_scope(allowed)

    def test_only_original_legacy_network_is_allowed_before_transition(self):
        tool, c, v, old, new, fingerprint = resource_fixture()
        self.assertEqual(self.run_scope(tool, fingerprint, {'old'})['Id'], r.CID)
        c['NetworkSettings']['Networks'][p.NETWORK]['NetworkID'] = NEW_ID
        with self.assertRaisesRegex(p.Refusal, 'UNAUTHORED_NETWORK'):
            self.run_scope(tool, fingerprint, {'old'})

    def test_new_normal_network_requires_exact_options(self):
        tool, c, v, old, new, fingerprint = resource_fixture()
        c['NetworkSettings']['Networks'][p.NETWORK]['NetworkID'] = NEW_ID
        self.run_scope(tool, fingerprint, {'new'})
        new['Options'] = {}
        with self.assertRaisesRegex(p.Refusal, 'NETWORK_IDENTITY'):
            self.run_scope(tool, fingerprint, {'new'})

    def test_unknown_network_attachment_is_never_stopped(self):
        tool, c, v, old, new, fingerprint = resource_fixture()
        c['NetworkSettings']['Networks']['foreign'] = {'NetworkID': 'f' * 64}
        tool.event = Mock()
        with patch.object(p, 'account_guard'), patch.object(p, 'no_mount'), patch.object(p, 'fingerprint', side_effect=fingerprint):
            tool.fail_closed(p.Refusal('PRIMARY_FAILURE'))
        self.assertEqual(tool.receipt['error_code'], 'PRIMARY_FAILURE')
        self.assertIn('UNAUTHORED_NETWORK', tool.receipt['cleanup_error_code'])
        self.assertFalse(any(call.args[0][:2] == ['docker', 'stop'] for call in tool.runtime.command.call_args_list))

    def test_foreign_volume_consumer_blocks_every_action(self):
        tool, c, v, old, new, fingerprint = resource_fixture()
        inspect = tool.runtime.inspect.side_effect
        foreign = {'Id': 'f' * 64, 'Mounts': [{'Name': p.VOLUME}], 'NetworkSettings': {'Networks': {}}}
        tool.runtime.inspect.side_effect = lambda kind, ident: foreign if ident == 'foreign' else inspect(kind, ident)
        tool.runtime.command.return_value = 'foreign'
        with self.assertRaisesRegex(p.Refusal, 'FOREIGN_CONSUMER'):
            self.run_scope(tool, fingerprint, {'old'})

    def test_changed_volume_or_private_inode_is_refused(self):
        tool, c, v, old, new, fingerprint = resource_fixture()
        for path in (r.VOLUME_PATH, p.PRIVATE / 'runtime.env'):
            def changed(candidate):
                return {**fingerprint(candidate), 'inode': 0} if candidate == path else fingerprint(candidate)
            with self.subTest(path=path), self.assertRaises(p.Refusal):
                self.run_scope(tool, changed, {'old'})

    def test_per_phase_stop_allows_only_authored_outcomes(self):
        for phase, allowed in [('old', {'old'}), ('disconnecting', {'old', 'empty'}), ('empty', {'empty'}),
                               ('connecting', {'empty', 'new'}), ('new', {'new'})]:
            tool = instance(); tool.network_state = phase; tool.event = Mock()
            tool.core_scope = Mock(return_value={'State': {'Running': True}})
            tool.fail_closed(p.Refusal('PRIMARY_FAILURE'))
            tool.core_scope.assert_called_once_with(allowed)
            tool.runtime.command.assert_called_once_with(['docker', 'stop', '--time', '30', r.CID])
            self.assertNotIn('cleanup_error_code', tool.receipt)

    def test_failed_stop_keeps_primary_failure_separate(self):
        tool = instance(); tool.event = Mock(); tool.core_scope = Mock(side_effect=p.Refusal('SCOPE_CHANGED'))
        tool.fail_closed(p.Refusal('PRIMARY_FAILURE'))
        self.assertEqual(tool.receipt['error_code'], 'PRIMARY_FAILURE')
        self.assertEqual(tool.receipt['cleanup_error_code'], 'SCOPE_CHANGED')
        tool.runtime.command.assert_not_called()

    def test_post_completion_guard_failure_revokes_success_receipt(self):
        tool = instance(); tool.receipt.update(passed=True, phase='complete_closed')
        tool.event = Mock(side_effect=lambda phase, **fields: tool.receipt.update(phase=phase))
        tool.core_scope = Mock(return_value={'State': {'Running': False}})
        tool.fail_closed(p.Refusal('SHARED_DEPLOY_LOCK_REPLACED'))
        self.assertIs(tool.receipt['passed'], False)
        self.assertEqual(tool.receipt['failed_at_phase'], 'complete_closed')
        self.assertEqual(tool.receipt['phase'], 'failed_closed')
        self.assertEqual(tool.receipt['error_code'], 'SHARED_DEPLOY_LOCK_REPLACED')


class SequencingAndFiles(unittest.TestCase):
    def transition(self):
        tool = instance(); tool.guard_current = Mock(); tool.event = Mock()
        tool.core_scope = Mock(side_effect=lambda allowed: {'State': {'Running': False if tool.runtime.command.call_count == 0 else True, 'Status': 'exited'}})
        tool.legacy_database_probe = Mock(return_value=database())
        tool.network_guard = Mock(return_value={'Containers': {}})
        tool.runtime.names.return_value = set()
        tool.runtime.command.side_effect = lambda argv, **kwargs: NEW_ID if argv[:3] == ['docker', 'network', 'create'] else ''
        return tool

    def test_running_transition_order_uses_exact_ids_without_force_or_role_ddl(self):
        tool = self.transition(); tool.replace_network()
        argv = [c.args[0] for c in tool.runtime.command.call_args_list]
        self.assertEqual(argv[0], ['docker', 'start', r.CID])
        self.assertIn('-h', argv[1])
        self.assertEqual([a[:3] for a in argv[2:]], [['docker', 'network', 'disconnect'], ['docker', 'network', 'rm'],
                                                  ['docker', 'network', 'create'], ['docker', 'network', 'connect']])
        self.assertEqual(argv[2][3:], [r.NETWORK_ID, r.CID])
        self.assertEqual(argv[3][3:], [r.NETWORK_ID])
        self.assertEqual(argv[-1][3:], [NEW_ID, r.CID])
        self.assertIn('com.docker.network.bridge.host_binding_ipv4=127.0.0.1', argv[4])
        self.assertNotIn('--internal', argv[4]); self.assertNotIn('--force', str(argv))
        self.assertEqual(sum(a[:2] == ['docker', 'start'] for a in argv), 1)
        self.assertNotIn('CREATE ROLE', str(argv)); self.assertNotIn('volume', str(argv))
        self.assertEqual(tool.network_state, 'new')

    def test_readonly_empty_database_failure_never_disconnects(self):
        tool = self.transition(); tool.legacy_database_probe.side_effect = p.Refusal('NONEMPTY')
        with self.assertRaisesRegex(p.Refusal, 'NONEMPTY'):
            tool.replace_network()
        self.assertFalse(any(c.args[0][:2] == ['docker', 'network'] for c in tool.runtime.command.call_args_list))

    def test_network_name_reuse_never_creates_or_connects(self):
        tool = self.transition(); tool.runtime.names.return_value = {p.NETWORK}
        with self.assertRaisesRegex(p.Refusal, 'NAME_REUSED'):
            tool.replace_network()
        self.assertFalse(any(c.args[0][:3] == ['docker', 'network', 'create'] for c in tool.runtime.command.call_args_list))

    def test_invalid_created_network_id_does_not_connect(self):
        tool = self.transition()
        tool.runtime.command.side_effect = lambda argv, **kwargs: r.NETWORK_ID if argv[:3] == ['docker', 'network', 'create'] else ''
        with self.assertRaisesRegex(p.Refusal, 'NEW_NETWORK_ID'):
            tool.replace_network()
        self.assertFalse(any(c.args[0][:3] == ['docker', 'network', 'connect'] for c in tool.runtime.command.call_args_list))

    def test_live_pin_is_not_required_after_retirement_and_dangling_foreign_pin_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            pin = Path(temp).resolve() / 'production'
            with patch.object(p, 'PIN', pin):
                self.assertIsNone(n.current_pin_metadata())
                os.symlink(n.OLD_RELEASE, pin)
                self.assertEqual(n.current_pin_metadata()['target'], n.OLD_RELEASE)
                self.assertNotEqual(n.current_pin_metadata(), None)

    def test_source_advance_changes_only_authorized_three_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); private = root / 'private'; private.mkdir(); recovery = private / 'recovery'; recovery.mkdir()
            marker, _ = origin(); path = private / 'installation.json'; path.write_bytes(p.canonical(marker)); os.chmod(path, 0o600)
            pin = root / 'production'
            tool = instance(); tool.guard_current = Mock(); tool.core_scope = Mock(); tool.event = Mock()
            tool.capsule = {'incident': {'marker': marker}}; tool.marker_pin = p.fingerprint(path)
            with patch.object(p, 'PRIVATE', private), patch.object(p, 'PIN', pin), patch.object(n, 'RECOVERY', recovery), patch.object(os, 'fchown'):
                tool.advance_source()
                value = json.loads(path.read_bytes())
                self.assertEqual(value, {**marker, 'release': n.NEW_RELEASE, 'manifest_sha256': 'f' * 64, 'network_id': NEW_ID})
                self.assertEqual(os.readlink(pin), n.NEW_RELEASE)
                self.assertEqual(tool.current_pin, n.pin_metadata(pin))
                self.assertEqual(value['private_pins'], marker['private_pins'])

    def test_foreign_pin_blocks_source_advance_before_any_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); path = root / 'installation.json'; path.write_bytes(b'old'); os.chmod(path, 0o600)
            pin = root / 'production'; os.symlink('/unowned/missing', pin)
            tool = instance(); tool.guard_current = Mock(); tool.core_scope = Mock(); tool.capsule = {'incident': {'marker': origin()[0]}}
            tool.marker_pin = p.fingerprint(path)
            with patch.object(p, 'PRIVATE', root), patch.object(p, 'PIN', pin), patch.object(p, 'exclusive') as write, self.assertRaisesRegex(p.Refusal, 'OLD_SOURCE_PIN'):
                tool.advance_source()
            write.assert_not_called(); self.assertEqual(path.read_bytes(), b'old')

    def test_node_probe_is_readonly_and_password_is_env_only(self):
        tool = instance(); tool.core_scope = Mock(return_value={'NetworkSettings': {'Networks': {p.NETWORK: {'IPAddress': '172.19.0.2'}}}})
        tool.runtime.command.return_value = json.dumps(database())
        secret = 'private-fixture-secret'
        self.assertEqual(tool.app_database_probe({'OASIS_DATABASE_URL': 'postgres://app:' + secret + '@127.0.0.1:18893/db'}), database())
        call = tool.runtime.command.call_args
        self.assertNotIn(secret, str(call.args))
        self.assertIn(secret, call.kwargs['env']['OASIS_DATABASE_URL'])
        self.assertIn('REPEATABLE READ READ ONLY', call.args[0][-1]); self.assertIn('count(*)::int', call.args[0][-1])
        self.assertNotIn('INSERT', call.args[0][-1]); self.assertNotIn('migrate', call.args[0][-1])

    def test_readonly_legacy_probe_does_not_create_role_or_schema(self):
        tool = instance(); tool.runtime.command.return_value = json.dumps(database()) + '\n'
        tool.legacy_database_probe()
        call = tool.runtime.command.call_args
        self.assertIn('READ ONLY', call.kwargs['input'])
        self.assertIn('rolbypassrls', call.kwargs['input'])
        self.assertNotIn('CREATE', call.kwargs['input']); self.assertNotIn('ALTER', call.kwargs['input'])

    def test_created_exception_is_never_available(self):
        tool = instance()
        with self.assertRaisesRegex(p.Refusal, 'CREATED_EXCEPTION_FORBIDDEN'):
            tool.fresh(created_prestart=True)

    def test_two_successful_restore_cleanup_proofs_required(self):
        tool = instance(); tool.fresh = Mock(); tool.event = Mock()
        ops = Mock(); ops.backup.return_value = {'path': '/owned/backup'}
        ops.restore.return_value = {'passed': True, 'cleanup': {'database_removed': True, 'temporary_removed': False}}
        tool.load_operations = Mock(return_value=ops); tool.install_units = Mock()
        with self.assertRaisesRegex(p.Refusal, 'RESTORE_DRILL_FAILED'):
            tool.finish_closed()
        tool.install_units.assert_not_called(); tool.runtime.command.assert_not_called()

    def test_original_raw_failures_are_preserved_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); recovery = root / 'recovery'; failed2 = root / 'previous/receipt.json'
            failed2.parent.mkdir(); (root / 'installation.json').write_bytes(b'original-marker')
            (root / 'receipt.json').write_bytes(b'original-failure-one'); failed2.write_bytes(b'original-failure-two')
            tool = instance(); tool.receipt = None
            tool.capsule = {'incident': {'marker_pin': p.fingerprint(root / 'installation.json')}, 'helpers': n.OLD_HELPERS, 'tool_sha256': 'd' * 64}
            originals = {root / 'installation.json': b'original-marker', root / 'receipt.json': b'original-failure-one',
                         failed2: b'original-failure-two', n.HISTORY: b'original-retirement'}
            def read(path, sha=None):
                return originals[Path(path)], {}
            with patch.object(p, 'PRIVATE', root), patch.object(n, 'RECOVERY', recovery), patch.object(n, 'FAILED2_PATH', failed2), patch.object(r, 'read_bound', side_effect=read), patch.object(os, 'fchown'):
                tool.preserve(b'original-check-raw')
                self.assertEqual((recovery / 'receipt-original.json').read_bytes(), b'original-failure-one')
                self.assertEqual((recovery / 'recovery-created-receipt-original.json').read_bytes(), b'original-failure-two')
                self.assertEqual((recovery / 'check.json').read_bytes(), b'original-check-raw')
                self.assertEqual(json.loads((recovery / 'production-pin.json').read_bytes()), n.PIN_META)
                with self.assertRaises(FileExistsError):
                    tool.preserve(b'another-check')
            self.assertEqual((root / 'receipt.json').read_bytes(), b'original-failure-one')
            self.assertEqual(failed2.read_bytes(), b'original-failure-two')

    def test_host_tcp_and_app_readonly_proof_precede_only_official_bootstrap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); root.joinpath('bootstrap.json').write_text(json.dumps({'passed': True,
                'admission_enabled': False, 'players_created': 0, 'coins_funded': '0'}))
            tool = instance(); tool.fresh = Mock(); tool.event = Mock()
            actions = []
            tool.app_database_probe = Mock(side_effect=lambda env: actions.append('app-readonly') or database())
            tool.runtime.command.side_effect = lambda argv, **kwargs: actions.append('bootstrap') or ''
            with (patch.object(p, 'PRIVATE', root), patch.object(p, 'require_pg_host_tcp', side_effect=lambda: actions.append('host-tcp')),
                    patch.object(r, 'read_bound', return_value=(b'OASIS_DATABASE_URL=private-fixture-secret\n', {}))):
                tool.bootstrap_only()
            self.assertEqual(actions, ['host-tcp', 'app-readonly', 'bootstrap'])
            call = tool.runtime.command.call_args
            self.assertEqual(call.args[0][0], '/usr/bin/node')
            self.assertIn('/bootstrap.mjs', call.args[0][-3]); self.assertNotIn('private-fixture-secret', str(call.args))
            self.assertNotIn('CREATE ROLE', str(call))
            self.assertEqual(call.kwargs['env'], {})  # private environment cleared after execution

    def test_host_tcp_failure_never_runs_node_or_bootstrap(self):
        tool = instance(); tool.fresh = Mock(); tool.app_database_probe = Mock()
        with patch.object(p, 'require_pg_host_tcp', side_effect=p.Refusal('PRODUCTION_DATABASE_HOST_TCP_UNAVAILABLE')), self.assertRaises(p.Refusal):
            tool.bootstrap_only()
        tool.app_database_probe.assert_not_called(); tool.runtime.command.assert_not_called()


class CheckAndLockContracts(unittest.TestCase):
    def prepared(self):
        tool = instance(); tool.receipt = None; tool.args.check = '/private/check.json'
        global_pin = {'uid': 0, 'gid': 0, 'mode': 0o644, 'device': 64515, 'inode': 1}
        cap = {'kind': 'isolated-production-bootstrap-network-check', 'passed': True, 'at': p.now(),
               'tool_sha256': p.digest((HERE / 'recover-bootstrap-network.py').read_bytes()),
               'protected': {'files': {str(p.BASE / 'private/release.lock'): global_pin}}}
        tool.check = Mock(return_value=cap)
        for name in ('preserve', 'replace_network', 'advance_source', 'bootstrap_only'):
            setattr(tool, name, Mock())
        tool.finish_closed = Mock(return_value={'passed': True})
        return tool, cap

    def test_global_and_operations_fd_guards_surround_each_flock(self):
        tool, cap = self.prepared(); events = []
        with (patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(os, 'open', side_effect=[101, 102]),
                patch.object(os, 'close') as close, patch.object(p, 'lock_descriptor_guard', side_effect=lambda fd, *args: events.append(('guard', fd))),
                patch.object(p.fcntl, 'flock', side_effect=lambda fd, *args: events.append(('lock', fd)))):
            self.assertEqual(tool.apply(), {'passed': True})
        self.assertEqual(events[:6], [('guard', 101), ('lock', 101), ('guard', 101), ('guard', 102), ('lock', 102), ('guard', 102)])
        self.assertEqual(events[-2:], [('guard', 101), ('guard', 102)])
        self.assertEqual(tool.check.call_count, 2); tool.preserve.assert_called_once()
        self.assertEqual([c.args[0] for c in close.call_args_list], [102, 101])
        self.assertFalse(hasattr(tool, 'ops_fd'))

    def test_operations_fd_replacement_refuses_before_preservation_and_keeps_original_error(self):
        tool, cap = self.prepared()
        def guard(fd, *args):
            if fd == 102:
                raise p.Refusal('SHARED_DEPLOY_LOCK_REPLACED')
        with (patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(os, 'open', side_effect=[101, 102]),
                patch.object(os, 'close') as close, patch.object(p, 'lock_descriptor_guard', side_effect=guard), patch.object(p.fcntl, 'flock'),
                self.assertRaisesRegex(p.Refusal, 'LOCK_REPLACED')):
            tool.apply()
        tool.preserve.assert_not_called(); self.assertEqual([c.args[0] for c in close.call_args_list], [102, 101])

    def test_stale_check_never_inspects_or_locks_or_mutates(self):
        tool, cap = self.prepared(); cap['at'] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=601)).isoformat()
        with patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(os, 'open') as opened, self.assertRaisesRegex(p.Refusal, 'CHECK_NOT_FRESH'):
            tool.apply()
        tool.check.assert_not_called(); opened.assert_not_called(); tool.preserve.assert_not_called()

    def test_controller_hash_or_explicit_flag_mismatch_blocks_all_actions(self):
        for changed in ('hash', 'flag'):
            tool, cap = self.prepared()
            if changed == 'hash':
                cap['tool_sha256'] = '0' * 64
            else:
                tool.args.recover_exact_bootstrap_network_closed = False
            with self.subTest(changed=changed), patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), self.assertRaisesRegex(p.Refusal, 'EXPLICIT_FRESH_CHECK'):
                tool.apply()
            tool.check.assert_not_called(); tool.preserve.assert_not_called()


class IncidentPhase(unittest.TestCase):
    def fixture(self, root):
        private = root / 'private'; private.mkdir(); backup = root / 'backups'; backup.mkdir()
        for name in n.PRIVATE_MEMBERS:
            path = private / name
            if name in ('monitor', 'state', 'recovery-created-20261010'):
                path.mkdir()
            else:
                path.write_bytes(b'old')
        (private / 'state/master.key').write_bytes(b'k' * 32)
        marker, failure = origin()
        tool = instance(); tool.receipt = None
        state = {'Status': 'exited', 'Running': False, 'Paused': False, 'Restarting': False, 'OOMKilled': False,
                 'Dead': False, 'Pid': 0, 'ExitCode': 0, 'Error': '', 'StartedAt': '2026-10-09T18:54:32Z'}
        tool.core_scope = Mock(return_value={'State': state})
        tool.network_guard = Mock(return_value={'Id': r.NETWORK_ID})
        tool.runtime.service.return_value = {'FragmentPath': '', 'DropInPaths': '', 'MainPID': '0',
                                            'ActiveState': 'inactive', 'NeedDaemonReload': 'no'}
        tool.runtime.command.return_value = ''
        def read(path, sha=None):
            return p.canonical(marker if Path(path).name == 'installation.json' else failure), {'sha256': sha}
        def fingerprint(path):
            return n.OPS_PIN if Path(path).name == 'operations.lock' else n.MONITOR_META
        return tool, private, backup, read, fingerprint

    def contexts(self, root, private, backup, read, fingerprint):
        from contextlib import ExitStack
        stack = ExitStack()
        for value in (patch.object(p, 'PRIVATE', private), patch.object(p, 'BACKUPS', backup),
                      patch.object(p, 'PIN', root / 'production'), patch.object(n, 'RECOVERY', private / 'recovery-network'),
                      patch.object(n, 'FAILED2_PATH', private / 'recovery-created-20261010/receipt.json'),
                      patch.object(r, 'read_bound', side_effect=read), patch.object(p, 'fingerprint', side_effect=fingerprint),
                      patch.object(p, 'unit_namespace_guard')):
            stack.enter_context(value)
        return stack

    def test_exact_stopped_phase_has_absent_live_pin(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); tool, private, backup, read, fingerprint = self.fixture(root)
            with self.contexts(root, private, backup, read, fingerprint):
                result = tool.incident_snapshot()
            self.assertIsNone(result['production_pin']); self.assertEqual(result['state']['Running'], False)

    def test_existing_dangling_pin_or_unexpected_private_file_refuses_incident(self):
        for changed in ('pin', 'private', 'bootstrap', 'backup', 'monitor', 'state'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve(); tool, private, backup, read, fingerprint = self.fixture(root)
                if changed == 'pin':
                    os.symlink(n.OLD_RELEASE, root / 'production')
                elif changed == 'private':
                    (private / 'unknown').write_text('foreign')
                elif changed == 'bootstrap':
                    (private / 'bootstrap.json').write_text('{}')
                else:
                    (backup if changed == 'backup' else private / changed).joinpath('unexpected').write_text('foreign')
                with self.contexts(root, private, backup, read, fingerprint), self.assertRaisesRegex(p.Refusal, 'INCIDENT_PHASE'):
                    tool.incident_snapshot()

    def test_running_or_created_pg_never_reenters_this_recovery(self):
        for status in ('running', 'created'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve(); tool, private, backup, read, fingerprint = self.fixture(root)
                tool.core_scope.return_value['State']['Status'] = status
                with self.contexts(root, private, backup, read, fingerprint), self.assertRaisesRegex(p.Refusal, 'PG_NOT_STOPPED'):
                    tool.incident_snapshot()

    def test_cached_fragment_or_active_pid_is_refused_before_start(self):
        for field, bad in [('FragmentPath', '/foreign.service'), ('DropInPaths', '/foreign.conf'),
                           ('MainPID', '42'), ('NeedDaemonReload', 'yes')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve(); tool, private, backup, read, fingerprint = self.fixture(root)
                tool.runtime.service.return_value[field] = bad
                with self.contexts(root, private, backup, read, fingerprint), self.assertRaisesRegex(p.Refusal, 'UNIT_ALREADY_EXISTS'):
                    tool.incident_snapshot()


if __name__ == '__main__':
    unittest.main()
