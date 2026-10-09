"""Synthetic/temp-FS tail contracts; never call Docker, PostgreSQL or services."""
import copy
from contextlib import ExitStack
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('tail_recovery_test', HERE / 'recover-bootstrap-tail.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
p, r = t.p, t.r
FROZEN_HELPERS = t.HELPER_ROOT.resolve()


def row():
    return {'database': p.DATABASE, 'database_oid': '16384', 'role': p.DB_APP, 'privileged': False,
            'login': True, 'schema_owner': p.DB_APP, 'relations': 0, 'server_addr': '172.18.0.2/32',
            'server_host': '172.18.0.2', 'server_family': 4, 'server_masklen': 32, 'server_port': 5432}


def original():
    marker = {'schema': 1, 'kind': 'isolated-production-instance', 'container_id': r.CID, 'owner': r.OWNER,
              'uid': 997, 'gid': 999, 'pg_image': r.IMAGE, 'network_id': r.NETWORK_ID,
              'release': '/opt/oasis/releases/20261010-02',
              'manifest_sha256': '6621d3955184a6bef0e0391f7976af9c81385362967435c2e4f9022b1d4fe339',
              'origins': ['https://oasis-player.43.98.202.236.sslip.io', 'https://game.tianyahuyu.com'],
              'private_pins': {'runtime.env': {'sha256': 'e' * 64}}}
    check = {'kind': 'isolated-production-bootstrap-network-check', 'passed': True, 'tool_sha256': t.NETWORK_TOOL,
             'release': str(t.RELEASE), 'manifest_sha256': t.MANIFEST, 'helpers': t.HELPERS,
             'protected_inventory_sha256': r.PROTECTED_SHA, 'incident': {'marker': marker}}
    phases = ['original_evidence_preserved', 'legacy_database_readonly_proved', 'old_network_disconnect_authorized',
              'old_network_disconnected', 'old_network_removed', 'new_network_created', 'new_network_connect_authorized',
              'new_network_connected', 'source_and_network_advanced', 'failed_closed']
    events = [{'phase': phase} for phase in phases]
    for i in (5, 6, 7, 8):
        events[i]['new_network_id'] = t.NEW_ID
    events[8]['production_pin'] = t.PIN_META
    failure = {'schema': 1, 'kind': 'isolated-production-bootstrap-network-recovery', 'passed': False,
               'phase': 'failed_closed', 'failed_at_phase': 'source_and_network_advanced',
               'error_code': 'NETWORK_RECOVERY_APP_CONNECTION_NOT_OWN_CONTAINER', 'container_id': r.CID,
               'check_sha256': t.NETWORK_CHECK, 'tool_sha256': t.NETWORK_TOOL, 'source': t.HELPERS,
               'network_state': 'new', 'new_network_id': t.NEW_ID, 'old_network_id': r.NETWORK_ID,
               'original_failed_receipt_sha256': r.OLD_RECEIPT,
               'recovery_failed_receipt_sha256': '5f61173d76a4c44e840de855f9ff376f1f2c086bc8586a430348d15c06953f95',
               'history': events}
    return check, failure


def instance():
    tool = t.Recovery.__new__(t.Recovery)
    tool.runtime = Mock(); tool.runtime.diagnostic_records = []
    tool.release = t.RELEASE
    tool.args = types.SimpleNamespace(manifest_sha256=t.MANIFEST, controller_sha256='a' * 64,
        source_commit='b' * 40, check_sha256='c' * 64, check='/private/check.json', recover_exact_bootstrap_tail_closed=True)
    tool.marker = t.evidence_guard(*original())
    tool.receipt = {'phase': 'original_tail_evidence_preserved', 'history': [], 'passed': False, 'container_id': r.CID}
    return tool


class AddressAndOrigin(unittest.TestCase):
    def test_exact_inet_host_pair_passes_without_weakening_ip_identity(self):
        self.assertEqual(t.validate_row(row(), '172.18.0.2'), row())

    def test_actual_saved_readonly_postgres_row_passes(self):
        path = HERE.parents[1] / 'review/production-instance-20261010/app-address-probe-v2.json'
        if not path.exists():
            self.skipTest('ignored server evidence is not packaged')
        proof = json.loads(path.read_text())
        self.assertEqual(proof['node_exit'], 0); self.assertTrue(proof['read_only'])
        self.assertEqual(t.validate_row(proof['response']['row'], proof['expected_docker_ip']), proof['response']['row'])

    def test_wrong_address_family_mask_or_port_is_refused(self):
        for field, bad in [('server_host', '127.0.0.1'), ('server_host', '172.18.0.3'), ('server_addr', '172.18.0.2/24'),
                           ('server_addr', '172.18.0.2'), ('server_family', 6), ('server_masklen', 24),
                           ('server_masklen', 32.0), ('server_port', 18893), ('server_port', '5432')]:
            value = row(); value[field] = bad
            with self.subTest(field=field, bad=bad), self.assertRaisesRegex(p.Refusal, 'NOT_OWN_CONTAINER'):
                t.validate_row(value, '172.18.0.2')

    def test_docker_address_must_be_canonical_bare_ipv4(self):
        for bad in ('172.18.0.2/32', '0172.18.0.2', '::ffff:172.18.0.2', None):
            with self.subTest(bad=bad), self.assertRaisesRegex(p.Refusal, 'DOCKER_ADDRESS'):
                t.validate_row(row(), bad)

    def test_nonempty_or_wrong_database_role_schema_blocks_bootstrap(self):
        for field, bad in [('database_oid', '16385'), ('database', 'other'), ('relations', 1), ('relations', False),
                           ('relations', '0'), ('privileged', True), ('privileged', None), ('login', False),
                           ('role', p.DB_OWNER), ('schema_owner', p.DB_OWNER)]:
            value = row(); value[field] = bad
            with self.subTest(field=field), self.assertRaisesRegex(p.Refusal, 'DATABASE_NOT_EXACT_EMPTY'):
                t.validate_row(value, '172.18.0.2')

    def test_original_marker_advances_only_three_source_fields(self):
        check, failure = original()
        value = t.evidence_guard(check, failure)
        self.assertEqual(value, {**check['incident']['marker'], 'release': str(t.RELEASE), 'manifest_sha256': t.MANIFEST, 'network_id': t.NEW_ID})

    def test_exact_actual_check_and_failed_receipt_contract(self):
        base = HERE.parents[1] / 'review/production-instance-20261010'
        if not (base / 'network-apply-v1-remote.json').exists():
            self.skipTest('ignored server evidence is not packaged')
        check = json.loads((base / 'network-check-v1-remote.json').read_text())['check']
        failed = json.loads((base / 'network-apply-v1-remote.json').read_text())
        self.assertEqual(failed['receipt_sha256'], t.FAILED3)
        marker = t.evidence_guard(check, failed['receipt'])
        self.assertEqual(marker['network_id'], t.NEW_ID); self.assertEqual(marker['container_id'], r.CID)

    def test_other_failure_or_success_cannot_resume_tail(self):
        for field, bad in [('passed', True), ('phase', 'complete_closed'), ('failed_at_phase', 'production_bootstrap_proved'),
                           ('error_code', 'COMMAND_FAILED_NODE'), ('cleanup_error_code', 'STOP_FAILED'), ('network_state', 'old'),
                           ('new_network_id', 'f' * 64), ('tool_sha256', 'a' * 64), ('bootstrap', {}), ('unit_pins', {}), ('backup', {})]:
            check, failure = original(); failure[field] = bad
            with self.subTest(field=field), self.assertRaisesRegex(p.Refusal, 'ORIGINAL_FAILURE'):
                t.evidence_guard(check, failure)

    def test_changed_or_added_original_history_event_is_refused(self):
        for change in ('extra', 'remove', 'pin', 'id'):
            check, failure = original()
            if change == 'extra': failure['history'].append({'phase': 'extra'})
            elif change == 'remove': failure['history'].pop()
            elif change == 'pin': failure['history'][8]['production_pin'] = {}
            else: failure['history'][7]['new_network_id'] = 'f' * 64
            with self.subTest(change=change), self.assertRaisesRegex(p.Refusal, 'ORIGINAL_FAILURE'):
                t.evidence_guard(check, failure)

    def test_wrong_source_helpers_or_original_identity_is_refused(self):
        for field in ('helpers', 'marker'):
            check, failure = original()
            if field == 'helpers': check['helpers'] = {}
            else: check['incident']['marker']['uid'] = True
            with self.subTest(field=field), self.assertRaises(p.Refusal):
                t.evidence_guard(check, failure)


class NodeDiagnostics(unittest.TestCase):
    def runtime(self, root):
        runtime = t.DiagnosticRuntime(); runtime.diagnostic_root = root
        runtime.diagnostic_directory_pin = p.fingerprint(root); runtime.diagnostic_pins = {}; runtime.diagnostic_records = []
        return runtime

    def test_raw_failure_is_private_and_receipt_metadata_never_contains_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); os.chmod(root, 0o700); runtime = self.runtime(root)
            secret = 'synthetic-private-password'
            result = types.SimpleNamespace(returncode=1, stdout='partial-' + secret, stderr=json.dumps({'code': '42501', 'message': secret}))
            with patch.object(p, 'no_mount'), patch.object(os, 'fchown'), patch.object(p.subprocess, 'run', return_value=result), self.assertRaises(t.NodeFailure) as context:
                runtime.command(['/usr/bin/node', '/official/bootstrap.mjs'], env={'OASIS_DATABASE_URL': secret})
            error = context.exception
            self.assertEqual(str(error), 'COMMAND_FAILED_NODE'); self.assertEqual(error.diagnostics['structured_error_code'], '42501')
            self.assertNotIn(secret, json.dumps(error.diagnostics))
            self.assertIn(secret, Path(error.diagnostics['stderr']['path']).read_text())
            self.assertTrue(all(p.fingerprint(path)['mode'] == 0o600 for path in root.iterdir()))
            self.assertEqual(len(runtime.diagnostic_records), 1)

    def test_node_environment_omits_ambient_injection_variables(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); runtime = self.runtime(root)
            result = types.SimpleNamespace(returncode=0, stdout='{}', stderr='')
            with patch.dict(os.environ, {'NODE_OPTIONS': '--bad', 'LD_PRELOAD': 'bad', 'HTTP_PROXY': 'bad'}), patch.object(p, 'no_mount'), patch.object(os, 'fchown'), patch.object(p.subprocess, 'run', return_value=result) as run:
                self.assertEqual(runtime.command(['/usr/bin/node', '/probe.mjs'], env={'OASIS_ENVIRONMENT': 'production'}), '{}')
            self.assertEqual(run.call_args.kwargs['env'], {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'OASIS_ENVIRONMENT': 'production'})

    def test_timeout_preserves_partial_output_and_code(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); runtime = self.runtime(root)
            failure = p.subprocess.TimeoutExpired(['/usr/bin/node'], 30, output=b'partial', stderr=b'private-error')
            with patch.object(p, 'no_mount'), patch.object(os, 'fchown'), patch.object(p.subprocess, 'run', side_effect=failure), self.assertRaisesRegex(t.NodeFailure, 'UNAVAILABLE_OR_TIMEOUT') as context:
                runtime.command(['/usr/bin/node', '/probe.mjs'])
            self.assertEqual(context.exception.diagnostics['exit_code'], None)
            self.assertEqual(Path(context.exception.diagnostics['stdout']['path']).read_bytes(), b'partial')

    def test_malformed_error_code_is_not_exposed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); runtime = self.runtime(root)
            with patch.object(p, 'no_mount'), patch.object(os, 'fchown'):
                result = runtime.save_diagnostics('', '{"code":"password:secret"}', 1)
            self.assertIsNone(result['structured_error_code'])

    def test_same_bytes_directory_replacement_refuses_node_before_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp).resolve(); root = parent / 'diagnostics'; root.mkdir(); runtime = self.runtime(root)
            root.rename(parent / 'original'); root.mkdir()
            with patch.object(p, 'no_mount'), patch.object(p.subprocess, 'run') as run, self.assertRaisesRegex(p.Refusal, 'DIRECTORY_CHANGED'):
                runtime.command(['/usr/bin/node', '/probe.mjs'])
            run.assert_not_called()

    def test_raw_crlf_and_invalid_utf8_are_preserved_before_decode_refusal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); runtime = self.runtime(root)
            result = types.SimpleNamespace(returncode=0, stdout=b'\xff\r\n', stderr=b'\r\n')
            with patch.object(p, 'no_mount'), patch.object(os, 'fchown'), patch.object(p.subprocess, 'run', return_value=result) as run, self.assertRaisesRegex(t.NodeFailure, 'RESPONSE_UTF8_INVALID') as context:
                runtime.command(['/usr/bin/node', '/probe.mjs'])
            self.assertIs(run.call_args.kwargs['text'], False)
            self.assertEqual(Path(context.exception.diagnostics['stdout']['path']).read_bytes(), b'\xff\r\n')
            self.assertEqual(Path(context.exception.diagnostics['stderr']['path']).read_bytes(), b'\r\n')


class ControllerAndNormalScope(unittest.TestCase):
    def fixture(self, root):
        release = root / 'releases/20261010-03'; helpers = release / 'platform/deploy/production-instance'; helpers.mkdir(parents=True)
        for name in (*t.HELPERS, 'recover-created.py'):
            (helpers / name).write_bytes((FROZEN_HELPERS / name).read_bytes())
        private = root / 'private/tail'; private.mkdir(parents=True); os.chmod(private, 0o700)
        tool = private / 'recover-bootstrap-tail.py'; tool.write_bytes((HERE / 'recover-bootstrap-tail.py').read_bytes()); os.chmod(tool, 0o600)
        args = types.SimpleNamespace(controller_sha256=p.digest(tool.read_bytes()), source_commit='b' * 40)
        fingerprint = p.fingerprint
        def root_meta(path, **kwargs):
            value = fingerprint(path, **kwargs)
            if Path(path) in (tool, private): value = {**value, 'uid': 0, 'gid': 0}
            return value
        stack = ExitStack()
        for value in (patch.object(t, 'RELEASE', release), patch.object(t, 'TOOL', tool), patch.object(t, '__file__', str(tool)),
                      patch.object(t, 'HELPER_ROOT', helpers), patch.object(p, '__file__', str(helpers / 'provision.py')),
                      patch.object(r, '__file__', str(helpers / 'recover-created.py')), patch.object(p, 'fingerprint', side_effect=root_meta), patch.object(p, 'no_mount')):
            stack.enter_context(value)
        return tool, helpers, args, stack

    def test_actual_check_refuses_local_repository_import_mode_before_reader(self):
        args = types.SimpleNamespace(controller_sha256='a' * 64, source_commit='b' * 40)
        with patch.object(r, 'read_bound') as read, self.assertRaisesRegex(p.Refusal, 'CONTROLLER_LOCATION'):
            t.controller_guard(args)
        read.assert_not_called()

    def test_empty_external_controller_sha_never_reads_tool(self):
        args = types.SimpleNamespace(controller_sha256='', source_commit='b' * 40)
        with patch.object(r, 'read_bound') as read, self.assertRaisesRegex(p.Refusal, 'EXTERNAL_CONTROLLER_SHA'):
            t.controller_guard(args)
        read.assert_not_called()

    def test_root_private_fd_bound_controller_and_exact_03_imports(self):
        with tempfile.TemporaryDirectory() as temp:
            tool, helpers, args, stack = self.fixture(Path(temp).resolve())
            with stack:
                value = t.controller_guard(args)
            self.assertEqual(value['tool_sha256'], args.controller_sha256)
            self.assertEqual(value['tool_pin']['inode'], tool.lstat().st_ino)
            self.assertEqual(value['source_commit'], 'b' * 40); self.assertEqual(value['helper_root'], str(helpers))

    def test_wrong_external_sha_or_unsafe_source_commit_is_refused(self):
        for changed in ('sha', 'commit'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temp:
                tool, helpers, args, stack = self.fixture(Path(temp).resolve())
                if changed == 'sha': args.controller_sha256 = 'a' * 64
                else: args.source_commit = '$(not-a-commit)'
                with stack, self.assertRaises(p.Refusal):
                    t.controller_guard(args)

    def test_changed_immutable_helper_or_wrong_helper_module_origin_is_refused(self):
        for changed in ('bytes', 'module'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temp:
                tool, helpers, args, stack = self.fixture(Path(temp).resolve())
                with stack:
                    if changed == 'bytes': (helpers / 'operations.py').write_bytes(b'foreign')
                    else: p.__file__ = str(helpers / 'foreign.py')
                    with self.assertRaisesRegex(p.Refusal, 'IMMUTABLE_IMPORT'):
                        t.controller_guard(args)

    def test_same_controller_bytes_new_inode_changes_bound_capsule(self):
        with tempfile.TemporaryDirectory() as temp:
            tool, helpers, args, stack = self.fixture(Path(temp).resolve())
            with stack:
                before = t.controller_guard(args); body = tool.read_bytes(); tool.rename(tool.with_suffix('.original'))
                tool.write_bytes(body); os.chmod(tool, 0o600)
                after = t.controller_guard(args)
            self.assertEqual(before['tool_sha256'], after['tool_sha256'])
            self.assertNotEqual(before['tool_pin']['inode'], after['tool_pin']['inode'])

    def test_controller_symlink_is_never_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            tool, helpers, args, stack = self.fixture(Path(temp).resolve())
            target = tool.with_suffix('.original'); tool.rename(target); os.symlink(target, tool)
            with stack, self.assertRaisesRegex(p.Refusal, 'SYMLINK_REJECTED'):
                t.controller_guard(args)

    def test_helper_bytes_are_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); marker = root / 'side-effect'
            (root / 'provision.py').write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("bad")\n')
            with patch.object(t, 'HELPER_ROOT', root), self.assertRaisesRegex(ValueError, 'IMPORT_BYTES_CHANGED'):
                t.load('untrusted_never_executed', 'provision.py')
            self.assertFalse(marker.exists())

    def test_helper_fd_bytes_execute_without_second_path_read(self):
        root = FROZEN_HELPERS
        with patch.object(t, 'HELPER_ROOT', root), patch.object(importlib.machinery.SourceFileLoader, 'exec_module', side_effect=AssertionError('must not reread')):
            module = t.load('verified_fd_provision', 'provision.py')
        self.assertEqual(module.NETWORK_OPTIONS, p.NETWORK_OPTIONS)

    def test_actual_reader_chain_reuses_verified_provision_without_nested_loader_read(self):
        with patch.object(t, 'HELPER_ROOT', FROZEN_HELPERS), patch.object(importlib.machinery.SourceFileLoader, 'exec_module', side_effect=AssertionError('must not reread')), patch.object(importlib.machinery.SourceFileLoader, 'get_data', side_effect=AssertionError('must not read nested provision')):
            module = t.load('verified_actual_private_reader', 'recover-created.py', provision_module=p)
        self.assertIs(module.p, p)
        self.assertTrue(issubclass(module.Recovery, p.Provisioner))
        self.assertEqual(module.CID, r.CID)
        self.assertEqual(module.parse_private_env(b'KEY=value\n'), {'KEY': 'value'})

    def test_actual_reader_requires_exact_already_loaded_provision_origin(self):
        for module in (None, types.SimpleNamespace(__file__='/untrusted/provision.py')):
            with patch.object(t, 'HELPER_ROOT', FROZEN_HELPERS), self.assertRaisesRegex(ValueError, 'READER_PROVISION_MODULE_INVALID'):
                t.load('never_loaded_reader', 'recover-created.py', provision_module=module)

    def test_reader_ast_rejects_missing_modified_or_duplicated_known_loader(self):
        original = (HERE / 'recover-created.py').read_text()
        loader = "spec = importlib.util.spec_from_file_location('oasis_created_provision', HERE / 'provision.py')\np = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(p)"
        for body in (original.replace(loader, ''), original.replace("'oasis_created_provision'", "'foreign_provision'"), original + '\n' + loader):
            with self.assertRaisesRegex(ValueError, 'READER_IMPORT_SHAPE_INVALID'):
                t.reader_ast(body, HERE / 'recover-created.py')

    def test_normal_guard_has_no_legacy_exception_and_exact_owned_ids(self):
        tool = instance(); ops = Mock(); tool.load_operations = Mock(return_value=ops)
        ops.owned_resources.return_value = {'container_id': r.CID, 'network_id': t.NEW_ID, 'running': False}
        def fp(path): return t.VOLUME_META if path == r.VOLUME_PATH else t.OPS_PIN
        with patch.object(p, 'fingerprint', side_effect=fp), patch.object(p, 'no_mount'), patch.object(Path, 'is_symlink', return_value=False), patch.object(t, 'pin_metadata', return_value=t.PIN_META):
            self.assertFalse(tool.scope()['running'])
            ops.owned_resources.assert_called_once_with(tool.marker, tool.runtime)
            ops.owned_resources.return_value['network_id'] = r.NETWORK_ID
            with self.assertRaisesRegex(p.Refusal, 'NORMAL_RESOURCE_ID'):
                tool.scope()

    def test_initialized_volume_replacement_and_wrong_source_pin_refuse_before_normal_guard(self):
        for changed in ('volume', 'pin'):
            tool = instance(); tool.load_operations = Mock()
            def fp(path):
                if path == r.VOLUME_PATH: return {**t.VOLUME_META, 'inode': 1} if changed == 'volume' else t.VOLUME_META
                return t.OPS_PIN
            with patch.object(p, 'fingerprint', side_effect=fp), patch.object(p, 'no_mount'), patch.object(Path, 'is_symlink', return_value=False), patch.object(t, 'pin_metadata', return_value={} if changed == 'pin' else t.PIN_META), self.assertRaises(p.Refusal):
                tool.scope()
            tool.load_operations.assert_not_called()


class Sequencing(unittest.TestCase):
    def test_generated_node_probe_parses_and_has_readonly_ip_contract(self):
        tool = instance(); tool.fresh = Mock()
        tool.runtime.inspect.return_value = {'NetworkSettings': {'Networks': {p.NETWORK: {'IPAddress': '172.18.0.2'}}}}
        tool.runtime.command.return_value = json.dumps(row())
        self.assertEqual(tool.app_probe({'OASIS_DATABASE_URL': 'private-fixture-secret'}), row())
        call = tool.runtime.command.call_args; code = call.args[0][-1]
        self.assertNotIn('private-fixture-secret', str(call.args)); self.assertIn('REPEATABLE READ READ ONLY', code)
        self.assertIn('host(inet_server_addr())', code); self.assertIn('masklen(inet_server_addr())', code)
        self.assertNotIn('INSERT', code); self.assertNotIn('CREATE ROLE', code)
        result = subprocess.run([shutil.which('node'), '--input-type=module', '--check'], input=code, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_start_host_and_readonly_app_proof_precede_single_official_bootstrap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); (root / 'bootstrap.json').write_text(json.dumps({'passed': True,
                'admission_enabled': False, 'players_created': 0, 'coins_funded': '0'}))
            tool = instance(); tool.fresh = Mock(); tool.event = Mock()
            actions = []; tool.scope = Mock(side_effect=[{'running': False}, {'running': True}])
            tool.app_probe = Mock(side_effect=lambda env: actions.append('app-readonly') or row())
            tool.runtime.command.side_effect = lambda argv, **kwargs: actions.append(tuple(argv[:2])) or ''
            with (patch.object(p, 'PRIVATE', root), patch.object(p, 'require_pg_host_tcp', side_effect=lambda: actions.append('host-tcp')),
                  patch.object(r, 'read_bound', return_value=(b'OASIS_DATABASE_URL=fixture-secret\n', {}))):
                tool.bootstrap_only()
            self.assertEqual(actions[:4], [('docker', 'start'), ('docker', 'exec'), 'host-tcp', 'app-readonly'])
            self.assertEqual(actions[4], ('/usr/bin/node', '--import'))
            argv = [c.args[0] for c in tool.runtime.command.call_args_list]
            self.assertEqual(argv[0], ['docker', 'start', r.CID]); self.assertIn('-h', argv[1])
            self.assertNotIn('network', str(argv)); self.assertNotIn('CREATE ROLE', str(argv)); self.assertNotIn('volume', str(argv))
            self.assertEqual(tool.runtime.command.call_args.kwargs['env'], {})

    def test_nonempty_app_probe_never_runs_bootstrap_or_role_sql(self):
        tool = instance(); tool.fresh = Mock(); tool.event = Mock(); tool.scope = Mock(side_effect=[{'running': False}, {'running': True}])
        tool.app_probe = Mock(side_effect=p.Refusal('TAIL_DATABASE_NOT_EXACT_EMPTY'))
        with patch.object(p, 'require_pg_host_tcp'), patch.object(r, 'read_bound', return_value=(b'OASIS_DATABASE_URL=fixture\n', {})), self.assertRaises(p.Refusal):
            tool.bootstrap_only()
        self.assertFalse(any(c.args[0][0] == '/usr/bin/node' for c in tool.runtime.command.call_args_list))

    def test_host_tcp_failure_never_reads_password_or_runs_node(self):
        tool = instance(); tool.fresh = Mock(); tool.scope = Mock(side_effect=[{'running': False}, {'running': True}])
        with patch.object(p, 'require_pg_host_tcp', side_effect=p.Refusal('HOST_TCP_FAILED')), patch.object(r, 'read_bound') as read, self.assertRaises(p.Refusal):
            tool.bootstrap_only()
        read.assert_not_called()

    def test_started_pg_or_created_exception_is_never_accepted(self):
        tool = instance(); tool.fresh = Mock(); tool.scope = Mock(return_value={'running': True})
        with self.assertRaisesRegex(p.Refusal, 'ALREADY_STARTED'):
            tool.bootstrap_only()
        tool.runtime.command.assert_not_called()
        with self.assertRaisesRegex(p.Refusal, 'PRESTART_EXCEPTION'):
            t.Recovery.fresh(tool, created_prestart=True)

    def test_restore_both_cleanup_flags_must_pass_before_install(self):
        tool = instance(); tool.fresh = Mock(); tool.event = Mock(); tool.install_units = Mock()
        ops = Mock(); ops.backup.return_value = {'path': '/owned/backup'}
        ops.restore.return_value = {'passed': True, 'cleanup': {'database_removed': False, 'temporary_removed': True}}
        tool.load_operations = Mock(return_value=ops)
        with self.assertRaisesRegex(p.Refusal, 'RESTORE_DRILL_FAILED'):
            tool.finish_closed()
        tool.install_units.assert_not_called(); tool.runtime.command.assert_not_called()

    def test_same_normal_scope_typed_stop_and_original_error_preserved(self):
        tool = instance(); tool.event = Mock(); tool.scope = Mock(return_value={'running': True})
        error = t.NodeFailure('COMMAND_FAILED_NODE', {'structured_error_code': '42501'})
        tool.fail_closed(error)
        tool.runtime.command.assert_called_once_with(['docker', 'stop', '--time', '30', r.CID])
        self.assertFalse(tool.receipt['passed']); self.assertEqual(tool.receipt['diagnostics'], error.diagnostics)
        self.assertEqual(tool.receipt['error_code'], 'COMMAND_FAILED_NODE')

    def test_unknown_normal_scope_refuses_stop_and_reports_cleanup_separately(self):
        tool = instance(); tool.event = Mock(); tool.scope = Mock(side_effect=p.Refusal('PRODUCTION_RESOURCE_SCOPE_CHANGED'))
        tool.fail_closed(p.Refusal('PRIMARY_ERROR'))
        self.assertEqual(tool.receipt['error_code'], 'PRIMARY_ERROR')
        self.assertEqual(tool.receipt['cleanup_error_code'], 'PRODUCTION_RESOURCE_SCOPE_CHANGED')
        tool.runtime.command.assert_not_called()

    def test_post_complete_guard_failure_revokes_success(self):
        tool = instance(); tool.receipt.update(passed=True, phase='complete_closed'); tool.scope = Mock(return_value={'running': False})
        tool.event = Mock(side_effect=lambda phase, **fields: tool.receipt.update(phase=phase))
        tool.fail_closed(p.Refusal('LOCK_CHANGED'))
        self.assertFalse(tool.receipt['passed']); self.assertEqual(tool.receipt['failed_at_phase'], 'complete_closed')
        self.assertEqual(tool.receipt['phase'], 'failed_closed')


class FilesAndLocks(unittest.TestCase):
    def test_preserve_saves_raw_check_and_failed3_without_writing_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); prior = root / 'prior'; prior.mkdir(); recovery = root / 'new'
            (prior / 'check.json').write_bytes(b'raw-network-check'); (prior / 'receipt.json').write_bytes(b'raw-network-failure')
            (root / 'installation.json').write_bytes(b'raw-current-marker')
            tool = instance(); tool.receipt = None; tool.runtime = t.DiagnosticRuntime()
            tool.capsule = {'origin': {'marker_pin': p.fingerprint(root / 'installation.json')}, 'controller': {'source_commit': 'b' * 40}}
            def read(path, sha=None): return Path(path).read_bytes(), p.fingerprint(path)
            with (patch.object(p, 'PRIVATE', root), patch.object(t, 'PRIOR', prior), patch.object(t, 'RECOVERY', recovery),
                  patch.object(r, 'read_bound', side_effect=read), patch.object(os, 'fchown')):
                tool.preserve(b'raw-tail-check')
                self.assertEqual((recovery / 'network-check-original.json').read_bytes(), b'raw-network-check')
                self.assertEqual((recovery / 'network-failure-original.json').read_bytes(), b'raw-network-failure')
                self.assertEqual((recovery / 'check.json').read_bytes(), b'raw-tail-check')
                with self.assertRaises(FileExistsError): tool.preserve(b'another')
            self.assertEqual((prior / 'receipt.json').read_bytes(), b'raw-network-failure')
            self.assertEqual((root / 'installation.json').read_bytes(), b'raw-current-marker')

    def prepared(self):
        tool = instance(); tool.receipt = None
        controller = {'source_commit': 'b' * 40, 'tool_sha256': 'a' * 64}
        pin = {'uid': 0, 'gid': 0, 'mode': 0o644, 'device': 64515, 'inode': 1}
        cap = {'kind': 'isolated-production-bootstrap-tail-check', 'passed': True, 'at': p.now(), 'controller': controller,
               'protected': {'files': {str(p.BASE / 'private/release.lock'): pin}}}
        tool.check = Mock(return_value=cap); tool.preserve = Mock(); tool.bootstrap_only = Mock(); tool.finish_closed = Mock(return_value={'passed': True})
        return tool, cap

    def test_external_controller_change_or_no_explicit_flag_blocks_actions(self):
        for change in ('controller', 'flag'):
            tool, cap = self.prepared(); controller = cap['controller']
            if change == 'controller': controller = {'tool_sha256': 'e' * 64}
            else: tool.args.recover_exact_bootstrap_tail_closed = False
            with patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(t, 'controller_guard', return_value=controller), self.assertRaisesRegex(p.Refusal, 'EXPLICIT_FRESH_CHECK'):
                tool.apply()
            tool.check.assert_not_called(); tool.preserve.assert_not_called()

    def test_expired_600_second_check_refuses_before_flock_or_mutation(self):
        tool, cap = self.prepared(); cap['at'] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=601)).isoformat()
        with patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(os, 'open') as opened, self.assertRaisesRegex(p.Refusal, 'CHECK_NOT_FRESH'):
            tool.apply()
        opened.assert_not_called(); tool.check.assert_not_called()

    def test_empty_external_check_sha_never_reads_or_starts(self):
        tool, cap = self.prepared(); tool.args.check_sha256 = ''
        with patch.object(r, 'read_bound') as read, self.assertRaisesRegex(p.Refusal, 'EXTERNAL_CHECK_SHA'):
            tool.apply()
        read.assert_not_called(); tool.check.assert_not_called(); tool.bootstrap_only.assert_not_called()

    def test_global_and_operations_fd_inode_guards_surround_flock(self):
        tool, cap = self.prepared(); events = []
        with (patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(t, 'controller_guard', return_value=cap['controller']),
              patch.object(os, 'open', side_effect=[101, 102]), patch.object(os, 'close') as close,
              patch.object(p, 'lock_descriptor_guard', side_effect=lambda fd, *args: events.append(('guard', fd))),
              patch.object(p.fcntl, 'flock', side_effect=lambda fd, *args: events.append(('lock', fd)))):
            self.assertEqual(tool.apply(), {'passed': True})
        self.assertEqual(events[:6], [('guard', 101), ('lock', 101), ('guard', 101), ('guard', 102), ('lock', 102), ('guard', 102)])
        self.assertEqual(events[-2:], [('guard', 101), ('guard', 102)])
        self.assertEqual([c.args[0] for c in close.call_args_list], [102, 101]); self.assertFalse(hasattr(tool, 'ops_fd'))
        self.assertEqual(tool.check.call_count, 2); tool.bootstrap_only.assert_called_once()

    def test_replaced_operations_lock_never_preserves_or_starts(self):
        tool, cap = self.prepared()
        def guard(fd, *args):
            if fd == 102: raise p.Refusal('SHARED_DEPLOY_LOCK_REPLACED')
        with (patch.object(r, 'read_bound', return_value=(p.canonical(cap), {})), patch.object(t, 'controller_guard', return_value=cap['controller']),
              patch.object(os, 'open', side_effect=[101, 102]), patch.object(os, 'close') as close,
              patch.object(p, 'lock_descriptor_guard', side_effect=guard), patch.object(p.fcntl, 'flock'), self.assertRaisesRegex(p.Refusal, 'LOCK_REPLACED')):
            tool.apply()
        self.assertEqual([c.args[0] for c in close.call_args_list], [102, 101]); tool.preserve.assert_not_called(); tool.bootstrap_only.assert_not_called()


if __name__ == '__main__':
    unittest.main()
