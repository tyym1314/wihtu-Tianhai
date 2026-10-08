"""Local pure/fake-I/O adapter tests. Never calls services, SQL or the network."""
import ast
from contextlib import contextmanager
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mock_view_runtime_test', HERE / 'view_runtime.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def bare():
    task = object.__new__(m.ViewRuntime)
    task.base = Path('/opt/oasis')
    task.releases = {role: task.base / 'releases' / value[0] for role, value in m.ROLES.items()}
    task.private = task.base / 'android-mock-private'
    task.pin = task.base / 'android-mock-current'
    task.marker = task.private / 'installation.json'
    task.work = task.private / 'view-upgrade-20261007-04-to-20261008-16'
    task.journal = task.work / 'journal.json'
    task._lock_depth = 1
    tools = {name: 'fixed' for name in m.TOOLS}
    task._initial_tools = tools
    task.tool_hashes = Mock(return_value=tools)
    resources = {'container_id': 'owned-db', 'network_fingerprint': 'fixed'}
    state = {'kind': 'isolated-13-game-mock', 'host': m.HOST, 'uid': 2345, 'id': 'owned',
             'release': str(task.releases['origin']), 'manifest_sha256': m.ROLES['origin'][1]}
    states = {role: dict(state, release=str(root), manifest_sha256=m.ROLES[role][1]) for role, root in task.releases.items()}
    fixed = {'releases': {'proof': 'verified'}, 'dependencies': {'all': 'fixed'}, 'source_new_manifest_sha256': m.SOURCE_NEW_MANIFEST,
             'static_coverage': {'equal': True}, 'private_hashes': {'runtime': 'private-hash'}, 'resources': resources,
             'live_boundary': {'live_pin': 'unchanged'}}
    checks = {'states': states, 'old_marker_text': json.dumps(state) + '\n', 'tool_hashes': tools, 'fixed': fixed,
              'backup_upper_bytes': 100000, 'minimum_remaining_bytes': 3 * 1024 ** 3}
    task._checks = checks
    task.pair = {'pin': 'origin', 'marker': 'origin'}
    task._state = Mock(side_effect=lambda: (copy.deepcopy(states[task.pair['marker']]), task.releases[task.pair['pin']], checks['old_marker_text'].encode()))
    task._release_evidence = Mock(return_value={k: v for k, v in fixed.items() if k not in ('private_hashes', 'resources', 'live_boundary')})
    task.runtime = types.SimpleNamespace(resources=Mock(return_value=resources), guard=Mock(return_value=resources),
        services=Mock(return_value={'api': 'inactive', 'demo': 'inactive'}), preflight=Mock(), start=Mock(), stop=Mock(), health=Mock())
    task.database = types.SimpleNamespace(snapshot=Mock(return_value={'schema_kind': 'old'}), require_quiet=Mock(),
        allow_role=Mock(), policy=Mock(return_value='old'), migration=Mock(return_value={'schema_kind': 'migrated'}))
    @contextmanager
    def locked(network=False):
        task.events.append(('lock', network))
        yield
        task.events.append(('unlock', network))
    task.events = []
    def switch(root):
        task.events.append(('switch', str(root)))
        task.pair['pin'] = next(role for role, value in task.releases.items() if value == root)
    def write_json(path, value, *_):
        task.events.append(('write_json', str(path)))
        if path == task.marker:
            task.pair['marker'] = next(role for role, item in states.items() if item == value)
    def write_bytes(path, raw, *_):
        task.events.append(('write_bytes', str(path), raw))
        task.pair['marker'] = 'origin'
    task.low = types.SimpleNamespace(locked=locked, private_hashes=Mock(return_value=fixed['private_hashes']),
        live_boundary=Mock(return_value=fixed['live_boundary']), switch=Mock(side_effect=switch), backup=Mock(return_value={'database': 'proof'}), verify_backup=Mock())
    task.upgrade = types.SimpleNamespace(APP_UNITS=('api', 'demo'), RESERVE=3 * 1024 ** 3,
        write_json=Mock(side_effect=write_json), write_bytes=Mock(side_effect=write_bytes), mock_private_directory=Mock(),
        sync_dir=Mock(), owned_directory=Mock(), regular=Mock(), digest=Mock(return_value=m.digest(b'html')))
    task._processes = Mock(return_value={'process': 'owned'})
    task._process = Mock(return_value={'process': 'owned'})
    task._http_body = Mock(return_value=b'html')
    return task, checks


class AdapterContracts(unittest.TestCase):
    def test_helper_sources_all_verified_before_any_execution(self):
        with patch.object(m, 'module_bytes', return_value=b'not the reviewed helper'), \
             patch('builtins.exec', side_effect=AssertionError('must not execute mismatching source')):
            with self.assertRaisesRegex(RuntimeError, 'VIEW_HELPER_HASH_CHANGED'):
                m.load_verified_helpers()

    def test_database_source_must_match_frozen_digest_before_execution(self):
        with patch.object(m, 'module_bytes', return_value=b'not the reviewed database'), \
             patch('builtins.exec', side_effect=AssertionError('must not execute mismatching source')):
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_SOURCE_CHANGED'):
                m.load_verified_database(Mock(), Path('/origin'), Path('/forward'))

    def test_database_loader_executes_bound_bytes_and_passes_one_sql_callback(self):
        raw = b'class ViewDatabase:\n def __init__(self, sql, old, new):\n  self.inputs=(sql, old, new)\n'
        sql = Mock()
        with patch.object(m, 'module_bytes', return_value=raw), patch.object(m, 'DATABASE_SHA256', m.digest(raw)):
            database = m.load_verified_database(sql, Path('/origin'), Path('/forward'))
        self.assertEqual(database.inputs, (sql, Path('/origin'), Path('/forward')))
        sql.assert_not_called()

    def test_import_has_no_subprocess_network_or_host_mutation(self):
        tree = ast.parse((HERE / 'view_runtime.py').read_text())
        calls = [n for n in tree.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)]
        self.assertEqual(calls, [])
        text = (HERE / 'view_runtime.py').read_text()
        for forbidden in ('installer.check(', 'installer.start(', 'installer.stop(', 'installer.certificate(',
                          'low.apply(', 'low.recover(', 'low.check(', "['nginx'", "'nginx', '-"):
            self.assertNotIn(forbidden, text)

    def test_identity_accepts_known_mixed_and_rejects_marker_state_drift(self):
        task, checks = bare()
        task.pair['pin'] = 'forward'
        self.assertEqual(task.identity(checks), {'pin': 'forward', 'marker': 'origin'})
        state = dict(checks['states']['origin'], uid=0)
        task._state.return_value = state, task.releases['forward'], b''
        task._state.side_effect = None
        with self.assertRaisesRegex(RuntimeError, 'VIEW_MARKER_STATE_CHANGED'):
            task.identity(checks)

    def test_unknown_pin_or_marker_fails_without_service_action(self):
        task, checks = bare()
        task._state.side_effect = None
        task._state.return_value = {**checks['states']['origin'], 'manifest_sha256': 'unknown'}, task.releases['origin'], b''
        with self.assertRaisesRegex(RuntimeError, 'VIEW_IDENTITY_UNKNOWN'):
            task.identity(checks)
        task.runtime.stop.assert_not_called()
        task.runtime.start.assert_not_called()

    def test_verify_fixed_works_during_known_mixed_without_pair_guard(self):
        task, checks = bare()
        task.pair['pin'] = 'forward'
        task.verify_fixed(checks)
        task.runtime.guard.assert_not_called()
        task.runtime.resources.assert_called_once_with(checks['states']['origin'])

    def test_initial_additive_schema_refuses_before_any_stop_or_journal(self):
        task, _ = bare()
        task.database.snapshot.return_value = {'schema_kind': 'migrated'}
        with tempfile.TemporaryDirectory() as tmp:
            task.work = Path(tmp) / 'not-created'
            with self.assertRaisesRegex(RuntimeError, 'VIEW_INITIAL_OLD_SCHEMA_REQUIRED'):
                task.check_initial()
            self.assertFalse(task.work.exists())
        task.runtime.stop.assert_not_called()
        task.runtime.start.assert_not_called()
        task.low.backup.assert_not_called()

    def test_private_live_resource_release_and_tool_drift_fail_closed(self):
        changes = [lambda t: t.low.private_hashes.return_value.update(changed=True),
                   lambda t: t.low.live_boundary.return_value.update(changed=True),
                   lambda t: t.runtime.resources.return_value.update(changed=True),
                   lambda t: t._release_evidence.return_value.update(changed=True),
                   lambda t: t.tool_hashes.return_value.update(changed=True)]
        for change in changes:
            task, checks = bare()
            # Isolate the baseline objects from the fake observation's dictionaries.
            checks = copy.deepcopy(checks)
            task._initial_tools = copy.deepcopy(task._initial_tools)
            change(task)
            with self.subTest(change=change), self.assertRaises((RuntimeError, KeyError)):
                task.verify_fixed(checks)
            task.runtime.stop.assert_not_called()
            task.runtime.start.assert_not_called()

    def test_switch_pin_marker_each_has_separate_network_lock(self):
        task, checks = bare()
        task.switch_pin('forward', checks)
        self.assertEqual(task.identity(checks), {'pin': 'forward', 'marker': 'origin'})
        task.switch_marker('forward', checks)
        self.assertEqual(task.identity(checks), {'pin': 'forward', 'marker': 'forward'})
        self.assertEqual(task.events[0], ('lock', True))
        self.assertEqual(task.events[2], ('unlock', True))
        self.assertEqual(task.events[3], ('lock', True))
        self.assertEqual(task.events[-1], ('unlock', True))
        task.runtime.start.assert_not_called()

    def test_switch_requires_inactive_apps_and_exact_target_before_marker(self):
        task, checks = bare()
        with self.assertRaisesRegex(RuntimeError, 'VIEW_MARKER_REQUIRES_TARGET_PIN'):
            task.switch_marker('forward', checks)
        task.runtime.services.return_value['api'] = 'active'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_SWITCH_REQUIRES_STOPPED_APPS'):
            task.switch_pin('forward', checks)
        task.low.switch.assert_not_called()
        task.upgrade.write_json.assert_not_called()

    def test_origin_marker_restores_exact_original_bytes(self):
        task, checks = bare()
        task.pair = {'pin': 'origin', 'marker': 'forward'}
        task.switch_marker('origin', checks)
        task.upgrade.write_bytes.assert_called_once_with(task.marker, checks['old_marker_text'].encode(), task.upgrade.mock_private_directory)
        task.upgrade.write_json.assert_not_called()

    def test_database_forwarders_do_not_split_or_retry(self):
        task, _ = bare()
        value = {'baseline': 'one transaction'}
        self.assertEqual(task.snapshot(), {'schema_kind': 'old'})
        self.assertEqual(task.policy({}, value), 'old')
        task.require_quiet(value)
        task.allow_role(value, 'rollback')
        self.assertEqual(task.migrate(value), {'schema_kind': 'migrated'})
        task.database.migration.assert_called_once_with(value)
        task.database.migration.side_effect = RuntimeError('transaction failed')
        with self.assertRaisesRegex(RuntimeError, 'transaction failed'):
            task.migrate(value)
        self.assertEqual(task.database.migration.call_count, 2)

    def test_database_gate_failure_blocks_pin_start_and_migration_needs_stopped_apps(self):
        task, checks = bare()
        task.database.allow_role.side_effect = RuntimeError('new business incompatible')
        with self.assertRaisesRegex(RuntimeError, 'new business incompatible'):
            task.switch_pin('rollback', checks)
        task.low.switch.assert_not_called()
        task.runtime.services.return_value['api'] = 'active'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_MIGRATION_REQUIRES_STOPPED_APPS'):
            task.migrate({})
        task.database.migration.assert_not_called()

    def test_stop_checks_inactive_readback(self):
        task, _ = bare()
        task.runtime.services.return_value['api'] = 'active'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_STOP_NOT_CONFIRMED'):
            task.stop()
        task.runtime.stop.assert_called_once()

    def test_start_is_idempotent_only_after_matching_pid_validation(self):
        task, checks = bare()
        task.runtime.services.return_value = {'api': 'active', 'demo': 'active'}
        self.assertEqual(task.start('origin', checks), {'process': 'owned'})
        task._processes.assert_called_once_with('origin', checks)
        task.runtime.start.assert_not_called()
        task._processes.side_effect = RuntimeError('wrong cwd')
        with self.assertRaisesRegex(RuntimeError, 'wrong cwd'):
            task.start('origin', checks)
        task.runtime.start.assert_not_called()

    def test_start_partial_active_validates_survivor_before_any_start(self):
        task, checks = bare()
        task.runtime.services.return_value['api'] = 'active'
        task._process.side_effect = RuntimeError('wrong existing process')
        with self.assertRaisesRegex(RuntimeError, 'wrong existing process'):
            task.start('origin', checks)
        task.runtime.start.assert_not_called()
        task._process.side_effect = None
        task.start('origin', checks)
        task.runtime.start.assert_called_once()
        task.runtime.preflight.assert_called_once_with(task.releases['origin'])

    def test_start_and_health_reject_mixed_before_guard_or_http(self):
        for operation in ('start', 'health'):
            task, checks = bare()
            task.pair['pin'] = 'forward'
            with self.assertRaisesRegex(RuntimeError, 'VIEW_MATCHING_ROLE_REQUIRED'):
                getattr(task, operation)('forward', checks)
            task.runtime.guard.assert_not_called()
            task.runtime.start.assert_not_called()
            task._http_body.assert_not_called()

    def test_health_requires_sandbox_health_exact_body_and_stable_pid(self):
        task, checks = bare()
        result = task.health('origin', checks)
        self.assertTrue(result['https_verified'])
        self.assertEqual(len(result['bodies']), 3)
        self.assertEqual(task._processes.call_count, 2)
        task._http_body.return_value = b'wrong release'
        with self.assertRaisesRegex(RuntimeError, 'VIEW_HEALTH_WRONG_RELEASE_BODY'):
            task.health('origin', checks)
        task.runtime.start.assert_not_called()

    def test_health_process_restart_during_probe_refuses(self):
        task, checks = bare()
        task._processes.side_effect = [{'pid': 2}, {'pid': 3}]
        with self.assertRaisesRegex(RuntimeError, 'VIEW_HEALTH_PROCESS_CHANGED'):
            task.health('origin', checks)

    def test_backup_adapts_only_old_low_level_schema_and_keeps_artifacts_verified(self):
        task, checks = bare()
        journal = {'format': 1, 'kind': 'mock-view-upgrade-v1', 'phase': 'backing_up', 'checks': checks, 'tool_hashes': task.tool_hashes()}
        self.assertEqual(task.backup(journal), {'database': 'proof'})
        adapted = task.low.backup.call_args.args[0]
        self.assertEqual(adapted['old_state'], checks['states']['origin'])
        self.assertEqual(adapted['checks']['old_manifest'], m.ROLES['origin'][1])
        journal['backup'] = {'database': 'proof'}
        task.verify_backup(journal)
        task.low.verify_backup.assert_called_once()

    def test_missing_backup_only_early_or_compatible_aborted_origin(self):
        task, checks = bare()
        journal = {'format': 1, 'kind': 'mock-view-upgrade-v1', 'phase': 'prepared', 'checks': checks, 'tool_hashes': task.tool_hashes()}
        for phase in m.EARLY_PHASES:
            journal['phase'] = phase
            task.verify_backup(journal)
        for phase in ('migrating', 'migrated', 'switching', 'healthy', 'complete', 'rolled_back'):
            journal['phase'] = phase
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, 'VIEW_BACKUP_REQUIRED'):
                task.verify_backup(journal)
        journal['phase'] = 'aborted'
        task.verify_backup(journal)
        task.database.snapshot.return_value = {'schema_kind': 'migrated'}
        task.verify_backup(journal)
        task.database.allow_role.assert_called_with({'schema_kind': 'migrated'}, 'origin')
        task.database.allow_role.side_effect = RuntimeError('VIEW_DATABASE_OLD_ROLE_HAS_V23')
        with self.assertRaisesRegex(RuntimeError, 'VIEW_DATABASE_OLD_ROLE_HAS_V23'):
            task.verify_backup(journal)
        task.database.snapshot.return_value = {'schema_kind': 'unknown'}
        with self.assertRaisesRegex(RuntimeError, 'VIEW_ABORTED_WITHOUT_COMPATIBLE_SCHEMA'):
            task.verify_backup(journal)
        journal['migration'] = {}
        with self.assertRaisesRegex(RuntimeError, 'VIEW_ABORTED_WITHOUT_ORIGINAL_IDENTITY'):
            task.verify_backup(journal)

    def test_journal_shapes_tool_drift_and_mutations_without_lock_refuse(self):
        task, checks = bare()
        journal = {'format': 1, 'kind': 'mock-view-upgrade-v1', 'phase': 'prepared', 'checks': checks, 'tool_hashes': task.tool_hashes()}
        task._journal_valid(journal)
        for change in ({'phase': 'unknown'}, {'kind': 'old-unsupported'}, {'tool_hashes': {}}):
            with self.assertRaises(RuntimeError):
                task._journal_valid({**journal, **change})
        task._lock_depth = 0
        for operation in (lambda: task.stop(), lambda: task.start('origin', checks), lambda: task.migrate({}),
                          lambda: task.switch_pin('forward', checks), lambda: task.save(journal)):
            with self.assertRaisesRegex(RuntimeError, 'VIEW_MUTATION_REQUIRES_LOCK'):
                operation()

    def test_journal_exclusive_creation_and_private_durable_writes(self):
        task, checks = bare()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            task.private = root
            task.work = root / 'owned-journal'
            task.journal = task.work / 'journal.json'
            journal = {'format': 1, 'kind': 'mock-view-upgrade-v1', 'phase': 'prepared', 'checks': checks}
            task.create_journal(journal)
            self.assertEqual(task.work.stat().st_mode & 0o777, 0o700)
            self.assertEqual(journal['tool_hashes'], task.tool_hashes())
            task.upgrade.write_json.assert_called_once_with(task.journal, journal)
            with self.assertRaisesRegex(RuntimeError, 'VIEW_JOURNAL_ALREADY_EXISTS'):
                task.create_journal(journal)
            task.upgrade.write_json.assert_called_once()

    def test_json_duplicate_nonfinite_and_size_refuse(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'x' * (m.MAX_JSON + 1)):
            with self.assertRaises(RuntimeError):
                m.json_value(raw)


class DependencyInventoryContracts(unittest.TestCase):
    def tree(self, root):
        folder = root / 'platform/node_modules'
        (folder / 'pkg').mkdir(parents=True)
        (folder / '.bin').mkdir()
        (folder / 'pkg/main.js').write_bytes(b'program')
        (folder / 'pkg/main.js').chmod(0o755)
        (folder / '.bin/tool').symlink_to('../pkg/main.js')
        folder.chmod(0o755)
        return folder

    def test_frozen_algorithm_includes_root_and_release_relative_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            folder = self.tree(root)
            expected = {
                'platform/node_modules': ['directory', 0o755],
                'platform/node_modules/.bin': ['directory', 0o755],
                'platform/node_modules/.bin/tool': ['link', '../pkg/main.js'],
                'platform/node_modules/pkg': ['directory', 0o755],
                'platform/node_modules/pkg/main.js': ['file', 0o755, m.digest(b'program')],
            }
            observed = m.installed_dependencies(root)
            self.assertEqual(observed, {'entries': 5, 'sha256': m.digest(json.dumps(expected, sort_keys=True).encode())})
            legacy_keys = {name.removeprefix('platform/node_modules/'): value for name, value in expected.items()
                           if name != 'platform/node_modules'}
            self.assertNotEqual(observed['sha256'], m.digest(json.dumps(legacy_keys, sort_keys=True).encode()))
            folder.chmod(0o750)
            self.assertNotEqual(observed['sha256'], m.installed_dependencies(root)['sha256'])

    def test_internal_symlink_allowed_but_external_link_hardlink_or_root_link_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            folder = self.tree(root)
            link = folder / '.bin/tool'
            link.unlink(); link.symlink_to(root)
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DEPENDENCY_LINK_OUTSIDE_ROOT'):
                m.installed_dependencies(root)
            link.unlink()
            os.link(folder / 'pkg/main.js', folder / 'pkg/duplicate.js')
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DEPENDENCY_FILE_UNSAFE'):
                m.installed_dependencies(root)
            (folder / 'pkg/duplicate.js').unlink()
            folder.rename(root / 'real-dependencies')
            folder.symlink_to(root / 'real-dependencies', target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'VIEW_DEPENDENCY_DIRECTORY_UNSAFE'):
                m.installed_dependencies(root)


class SqlSessionContracts(unittest.TestCase):
    def test_fixed_mock_single_session_whole_script_and_180_second_deadline(self):
        source = 'BEGIN; SELECT 1; COMMIT;'
        result = types.SimpleNamespace(returncode=0, stdout=b'  1\n', stderr=b'')
        with patch.object(m.subprocess, 'run', return_value=result) as run:
            self.assertEqual(m.run_mock_sql(source), '1')
        run.assert_called_once_with(['docker', 'exec', '-i', 'oasis-android-mock-postgres',
            'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'oasis_android_mock'],
            input=source.encode(), capture_output=True, check=False, timeout=180)

    def test_command_errors_and_timeout_are_redacted_unknown_outcomes_without_retry(self):
        secret = 'SQL_SECRET_SHOULD_NEVER_APPEAR'
        failures = [OSError(secret), m.subprocess.TimeoutExpired([secret], 180, output=secret.encode(), stderr=secret.encode()),
                    types.SimpleNamespace(returncode=1, stdout=secret.encode(), stderr=secret.encode())]
        for failure in failures:
            options = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
            with self.subTest(kind=type(failure).__name__), patch.object(m.subprocess, 'run', **options) as run:
                with self.assertRaisesRegex(RuntimeError, '^VIEW_SQL_COMMAND_FAILED$') as raised:
                    m.run_mock_sql('SELECT ' + secret)
                self.assertNotIn(secret, str(raised.exception))
                run.assert_called_once()

    def test_invalid_sql_is_rejected_before_spawn_and_invalid_output_is_redacted(self):
        for source in (None, b'SELECT 1', '', 'SELECT\0 1', '\ud800', 'x' * (m.MAX_JSON + 1)):
            with self.subTest(kind=type(source).__name__), patch.object(m.subprocess, 'run') as run:
                with self.assertRaises(RuntimeError):
                    m.run_mock_sql(source)
                run.assert_not_called()
        for output in (b'\xff', 'unbounded text', b'x' * (m.MAX_JSON + 1)):
            result = types.SimpleNamespace(returncode=0, stdout=output, stderr=b'private')
            with patch.object(m.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(RuntimeError, '^VIEW_SQL_OUTPUT_INVALID$'):
                    m.run_mock_sql('SELECT 1')

    def test_runtime_sql_requires_the_deployment_lock(self):
        task, _ = bare()
        with patch.object(m, 'run_mock_sql', return_value='one response') as run:
            self.assertEqual(task.sql('whole transaction'), 'one response')
            run.assert_called_once_with('whole transaction')
            task._lock_depth = 0
            with self.assertRaisesRegex(RuntimeError, 'VIEW_MUTATION_REQUIRES_LOCK'):
                task.sql('SELECT 1')
            run.assert_called_once()


class ReceiptContracts(unittest.TestCase):
    def values(self):
        name = 'platform/server/index.mjs'
        hashed = m.digest(b'body')
        entry = {'source': 'new', 'path': name, 'sha256': hashed, 'bytes': 4, 'mode': 0o644, 'output_mode': 0o644}
        return name, {'files': {name: entry}}, {name: ('new', name, hashed)}, {name: hashed, 'MOCK-VIEW-RECEIPT.json': 'receipt'}, {name: {'sha256': hashed, 'bytes': 4, 'mode': 0o644}}

    def test_every_body_has_exact_source_path_hash_size_and_mode(self):
        _, receipt, plan, manifest, files = self.values()
        m.validate_recipe_entries(receipt, plan, manifest, files)

    def test_missing_or_extra_body_and_changed_source_path_hash_refuse(self):
        for kind in ('missing', 'extra', 'source', 'path', 'hash', 'actual_hash', 'mode', 'size'):
            name, receipt, plan, manifest, files = self.values()
            if kind == 'missing':
                del receipt['files'][name]
            elif kind == 'extra':
                manifest['hidden-body'] = 'hash'
            elif kind == 'source':
                receipt['files'][name]['source'] = 'old'
            elif kind == 'path':
                receipt['files'][name]['path'] = 'different/source.mjs'
            elif kind == 'hash':
                receipt['files'][name]['sha256'] = '0' * 64
            elif kind == 'actual_hash':
                files[name]['sha256'] = '0' * 64
            elif kind == 'mode':
                files[name]['mode'] = 0o777
            else:
                files[name]['bytes'] = 5
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                m.validate_recipe_entries(receipt, plan, manifest, files)


class PublicationContracts(unittest.TestCase):
    def test_role_epochs_are_after_all_sources_and_not_future(self):
        for role, timestamp in (('forward', 200000000000), ('rollback', 201000000000)):
            receipt = {'publication_epoch': 200, 'output_mtime_ns': timestamp}
            proof = m.validate_publication(receipt, role, 199999999999, [timestamp] * 4, 201)
            self.assertEqual(proof['output_mtime_ns'], timestamp)

    def test_wrong_file_dir_source_future_and_empty_mtime_proof_refuse(self):
        receipt = {'publication_epoch': 200, 'output_mtime_ns': 200000000000}
        cases = [(receipt, 200000000000, [200000000000], 201),
                 (receipt, 199999999999, [200000000000], 200),
                 (receipt, 199999999999, [200000000000, 201000000000], 201),
                 (receipt, 199999999999, [], 201),
                 ({**receipt, 'output_mtime_ns': 201000000000}, 199999999999, [201000000000], 201)]
        for raw, source, actual, now in cases:
            with self.subTest(raw=raw, source=source, actual=actual, now=now), self.assertRaises(RuntimeError):
                m.validate_publication(raw, 'forward', source, actual, now)


class ProcessContracts(unittest.TestCase):
    def valid(self):
        unit = 'oasis-android-mock-api'
        root = Path('/opt/oasis/releases/20261008-16')
        return dict(pid=123, pid_after=123, start_ticks=20, start_ticks_after=20, cwd=str(root / 'platform'), cwd_after=str(root / 'platform'),
                    uids=[2345] * 4, argv=['/usr/bin/node', '--import', 'tsx', 'server/index.mjs'], exe=str(Path('/usr/bin/node').resolve()),
                    control_group='/system.slice/' + unit + '.service', cgroups=['/system.slice/' + unit + '.service']), root, unit

    def test_correct_actual_release_process(self):
        observed, root, unit = self.valid()
        result = m.validate_process(observed, role_root=root, unit=unit, uid=2345, entry='server/index.mjs')
        self.assertEqual(result['pid'], 123)

    def test_pid_reuse_wrong_release_uid_cmdline_exe_or_cgroup_refuses(self):
        for key, value in [('pid_after', 124), ('start_ticks_after', 21), ('cwd', '/opt/oasis/releases/20261007-04/platform'),
                           ('uids', [0] * 4), ('argv', ['/usr/bin/node', 'evil.mjs']), ('exe', '/tmp/node'),
                           ('control_group', '/other'), ('cgroups', ['/other'])]:
            observed, root, unit = self.valid()
            observed[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_process(observed, role_root=root, unit=unit, uid=2345, entry='server/index.mjs')


if __name__ == '__main__':
    unittest.main()
