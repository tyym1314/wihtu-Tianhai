"""Offline release promotion tests: all services, database and HTTP calls are mocked."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


def load_script():
    location = Path(__file__).with_name('activate-release.py')
    spec = importlib.util.spec_from_file_location('oasis_activate_release_under_test', location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleasePromotionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='oasis-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        (self.base / 'private').mkdir(mode=0o700)
        (self.base / 'releases').mkdir()
        self.old = self.make_release('old')
        self.candidate = self.make_release('candidate')
        (self.base / 'current').symlink_to(self.old)
        self.module = load_script()
        self.module.BASE = self.base
        self.commands = []
        self.output = io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(self.module.os, 'geteuid', return_value=0))
        self.stack.enter_context(mock.patch.object(self.module.grp, 'getgrnam', return_value=mock.Mock(gr_gid=12345)))
        self.chown = self.stack.enter_context(mock.patch.object(self.module.os, 'chown'))
        self.stack.enter_context(mock.patch.object(self.module.subprocess, 'run', side_effect=AssertionError('REAL_SUBPROCESS_FORBIDDEN')))
        self.run = self.stack.enter_context(mock.patch.object(self.module, 'run', side_effect=self.record_command))
        self.stack.enter_context(contextlib.redirect_stdout(self.output))

    def make_release(self, name):
        release = self.base / 'releases' / name
        release.mkdir()
        files = {f'platform/dist/asset-{i}.js': f'// {name} asset {i}\n' for i in range(10)}
        files['platform/server/index.mjs'] = '// test release source\n'
        files['platform/deploy/backup.sh'] = '# test only, never executed\n'
        manifest = {}
        for relative, contents in files.items():
            filename = release / relative
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_text(contents)
            manifest[relative] = hashlib.sha256(contents.encode()).hexdigest()
        dependencies = release / 'platform/node_modules/tsx/package.json'
        dependencies.parent.mkdir(parents=True)
        dependencies.write_text('{}')
        (release / 'RELEASE-MANIFEST.json').write_text(json.dumps(manifest))
        return release

    def record_command(self, args, **kwargs):
        self.commands.append(list(args))
        return ''

    def promote(self, *flags):
        with mock.patch('sys.argv', ['activate-release.py', str(self.candidate), *flags]):
            self.module.main()

    def manifest(self):
        return json.loads((self.candidate / 'RELEASE-MANIFEST.json').read_text())

    def test_manifest_rejects_traversal_absolute_and_symlink_paths(self):
        original = self.manifest()
        outside = self.base / 'outside.txt'
        outside.write_text('outside release')
        (self.candidate / 'direct-link').symlink_to(outside)
        (self.candidate / 'linked-directory').symlink_to(self.base, target_is_directory=True)
        for unsafe in ['../../outside.txt', str(outside), 'direct-link', 'linked-directory/outside.txt']:
            with self.subTest(path=unsafe):
                manifest = {**original, unsafe: hashlib.sha256(outside.read_bytes()).hexdigest()}
                (self.candidate / 'RELEASE-MANIFEST.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, 'UNSAFE_RELEASE_PATH'):
                    self.module.verify_release(self.candidate)
        self.assertEqual(self.commands, [])

    def test_modified_release_bytes_fail_hash_verification(self):
        (self.candidate / 'platform/server/index.mjs').write_text('// modified after packaging\n')
        with self.assertRaisesRegex(ValueError, 'RELEASE_HASH_MISMATCH'):
            self.module.verify_release(self.candidate)
        self.assertEqual((self.base / 'current').resolve(), self.old)

    def test_missing_runtime_dependencies_fail_before_promotion(self):
        (self.candidate / 'platform/node_modules/tsx/package.json').unlink()
        with self.assertRaisesRegex(ValueError, 'RELEASE_DEPENDENCIES_MISSING'):
            self.module.verify_release(self.candidate)

    def test_active_obligations_prevent_backup_stop_and_symlink_switch(self):
        with mock.patch.object(self.module, 'pending', return_value=1), mock.patch.object(self.module, 'health') as health:
            with self.assertRaisesRegex(RuntimeError, 'ACTIVE_GAMES_OR_PENDING_SETTLEMENT'):
                self.promote('--compatible-schema')
        self.assertEqual(self.commands, [])
        health.assert_not_called()
        self.assertEqual((self.base / 'current').resolve(), self.old)

    def test_check_only_verifies_artifacts_without_mutating_services_or_current(self):
        with mock.patch.object(self.module, 'pending', return_value=0), mock.patch.object(self.module, 'health') as health:
            self.promote('--check-only')
        self.assertEqual(self.commands, [])
        health.assert_not_called()
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertEqual(json.loads(self.output.getvalue())['verified_files'], 12)

    def test_schema_compatibility_is_required_before_backup_and_service_stop(self):
        with mock.patch.object(self.module, 'pending', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'SCHEMA_COMPATIBILITY_CONFIRMATION_REQUIRED'):
                self.promote()
        self.assertEqual(self.commands, [])
        self.assertEqual((self.base / 'current').resolve(), self.old)

    def test_obligation_started_during_preflight_restarts_old_services_without_switch(self):
        def old_health():
            self.assertEqual((self.base / 'current').resolve(), self.old)

        with mock.patch.object(self.module, 'pending', side_effect=[0, 1]), mock.patch.object(self.module, 'health', side_effect=old_health) as health:
            with self.assertRaisesRegex(RuntimeError, 'OBLIGATIONS_STARTED_DURING_PREFLIGHT'):
                self.promote('--compatible-schema')
        self.assertEqual(self.commands, [
            ['sh', str(self.old / 'platform/deploy/backup.sh')],
            ['systemctl', 'stop', 'oasis-demo', 'oasis-api'],
            ['systemctl', 'start', 'oasis-api', 'oasis-demo'],
        ])
        health.assert_called_once()
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertFalse((self.base / 'private/last-release.json').exists())

    def test_failed_candidate_health_restores_actual_symlink_and_rechecks_old_release(self):
        observed = []

        def health():
            current = (self.base / 'current').resolve()
            observed.append(current)
            if current == self.candidate:
                raise RuntimeError('RELEASE_HEALTH_FAILED')
            self.assertEqual(current, self.old)

        with mock.patch.object(self.module, 'pending', side_effect=[0, 0]), mock.patch.object(self.module, 'health', side_effect=health):
            with self.assertRaisesRegex(RuntimeError, 'RELEASE_HEALTH_FAILED'):
                self.promote('--compatible-schema')
        self.assertEqual(observed, [self.candidate, self.old])
        self.assertEqual(self.commands, [
            ['sh', str(self.old / 'platform/deploy/backup.sh')],
            ['systemctl', 'stop', 'oasis-demo', 'oasis-api'],
            ['systemctl', 'start', 'oasis-api', 'oasis-demo'],
            ['systemctl', 'stop', 'oasis-demo', 'oasis-api'],
            ['systemctl', 'start', 'oasis-api', 'oasis-demo'],
        ])
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertFalse((self.base / 'private/last-release.json').exists())
        self.assertEqual(list(self.base.glob('.current-*')), [])

    def test_success_records_verified_promotion_and_keeps_private_state(self):
        sentinel = self.base / 'private/state-sentinel'
        sentinel.write_bytes(b'private state must remain unchanged')

        def health():
            self.assertEqual((self.base / 'current').resolve(), self.candidate)

        with mock.patch.object(self.module, 'pending', side_effect=[0, 0]), mock.patch.object(self.module, 'health', side_effect=health):
            self.promote('--compatible-schema')
        report_file = self.base / 'private/last-release.json'
        report = json.loads(report_file.read_text())
        self.assertEqual(report['previous'], str(self.old))
        self.assertEqual(report['current'], str(self.candidate))
        self.assertEqual(report['health'], 'passed')
        self.assertTrue(report['database_and_private_state_preserved'])
        self.assertEqual(report_file.stat().st_mode & 0o777, 0o640)
        self.chown.assert_called_once_with(report_file, 0, 12345)
        self.assertEqual(sentinel.read_bytes(), b'private state must remain unchanged')

    def test_demo_health_carries_exact_configured_host_and_checks_database(self):
        (self.base / 'private/runtime.env').write_text('OASIS_PUBLIC_ORIGIN=https://games.partner.test:9443\n')
        self.run.side_effect = lambda args, **kwargs: '1'
        seen = []

        def urlopen(request, timeout):
            seen.append(request)
            response = io.BytesIO(b'{"status":"ok"}')
            response.status = 200
            if isinstance(request, self.module.urllib.request.Request):
                self.assertEqual(request.full_url, 'http://127.0.0.1:18885/demo/')
                self.assertEqual(request.get_header('Host'), 'games.partner.test:9443')
            return response

        with mock.patch.object(self.module.urllib.request, 'urlopen', side_effect=urlopen), mock.patch.object(self.module.time, 'sleep') as sleep:
            self.module.health()
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], 'http://127.0.0.1:18881/health')
        self.assertEqual(self.run.call_args.args[0][-1], 'SELECT 1')
        sleep.assert_not_called()

    def test_database_failure_cannot_be_hidden_by_green_http(self):
        self.run.side_effect = lambda args, **kwargs: '0'
        with mock.patch.object(self.module.urllib.request, 'urlopen') as urlopen:
            with self.assertRaisesRegex(RuntimeError, 'DATABASE_UNHEALTHY'):
                self.module.health()
        urlopen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
