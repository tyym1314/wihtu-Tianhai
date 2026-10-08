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
        (self.base / 'private/release.lock').touch()
        # Fixture publication writes a few bytes; promotion tests must not
        # depend on the developer disk meeting the server's 3 GiB reserve.
        # Real reserve failures remain covered by test_publish_static_assets.
        with mock.patch.object(self.module.static_assets, 'filesystem_space',
                               return_value=(4096, 20 * 1024 ** 3)):
            self.module.static_assets.publish(self.old, self.base, apply=True)
            self.module.static_assets.publish(self.candidate, self.base, apply=True)
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
        files[f'platform/dist/assets/{name}-12345678.js'] = f'// {name} fingerprint\n'
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
        self.assertEqual(json.loads(self.output.getvalue())['verified_files'], 13)

    def test_missing_registered_static_asset_blocks_activation_before_service_changes(self):
        required, _ = self.module.static_assets.manifest_assets(self.candidate)
        public = next(iter(required))
        (self.base / 'static-assets' / public.lstrip('/')).unlink()
        with mock.patch.object(self.module, 'pending', return_value=0), mock.patch.object(self.module, 'health') as health:
            with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_MISSING'):
                self.promote('--compatible-schema')
        self.assertEqual(self.commands, [])
        health.assert_not_called()
        self.assertEqual((self.base / 'current').resolve(), self.old)

    def test_rollback_to_old_release_without_lock_keeps_newer_registered_urls(self):
        newer = self.candidate
        before = {p.relative_to(self.base / 'static-assets').as_posix(): p.read_bytes()
                  for p in (self.base / 'static-assets').rglob('*') if p.is_file()}
        (self.base / 'current').unlink()
        (self.base / 'current').symlink_to(newer)
        self.candidate = self.old
        with mock.patch.object(self.module, 'pending', return_value=0), mock.patch.object(self.module, 'health'):
            self.promote('--compatible-schema')
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertEqual(self.module.static_assets.verify_coverage(newer, self.base)['registered_assets'], 2)
        after = {p.relative_to(self.base / 'static-assets').as_posix(): p.read_bytes()
                 for p in (self.base / 'static-assets').rglob('*') if p.is_file()}
        self.assertEqual(after, before)

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
        pending_checks = []

        def pending():
            pending_checks.append((self.base / 'current').resolve())
            if len(pending_checks) > 1:
                self.assertEqual(self.commands[-1], ['systemctl', 'stop', 'oasis-demo', 'oasis-api'])
            return 0

        def health():
            current = (self.base / 'current').resolve()
            observed.append(current)
            if current == self.candidate:
                raise RuntimeError('RELEASE_HEALTH_FAILED')
            self.assertEqual(current, self.old)

        with mock.patch.object(self.module, 'pending', side_effect=pending), mock.patch.object(self.module, 'health', side_effect=health):
            with self.assertRaisesRegex(RuntimeError, 'RELEASE_HEALTH_FAILED'):
                self.promote('--compatible-schema')
        self.assertEqual(observed, [self.candidate, self.old])
        self.assertEqual(pending_checks, [self.old, self.old, self.candidate])
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

    def fail_health_after_new_obligation(self, *, rooms=0, cycles=0, transfers=0):
        # Exercise the real pending() SQL dispatch: neither type may be omitted
        # from the post-start guard, even when the initial two checks were zero.
        created = False
        serving = True
        queries = []
        previous_report = self.base / 'private/last-release.json'
        previous_report.write_bytes(b'{"previous_success":"unchanged"}\n')

        def command(args, **kwargs):
            nonlocal serving
            self.record_command(args)
            if args[:2] == ['systemctl', 'stop']:
                serving = False
            elif args[:2] == ['systemctl', 'start']:
                serving = True
            elif args[:4] == ['docker', 'exec', '-i', 'oasis-postgres']:
                self.assertEqual(args[4:], ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'oasis', '-d', 'oasis_platform'])
                self.assertIn("gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')", kwargs['input'])
                self.assertIn("pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')", kwargs['input'])
                self.assertIn("gp_transfers WHERE state='PENDING'", kwargs['input'])
                queries.append((created, serving, (self.base / 'current').resolve()))
                if created:
                    self.assertFalse(serving, 'pending must be read only after stopping candidate admission')
                return json.dumps({'transfer_schema': 'present', 'pending_games': rooms + cycles if created else 0,
                                   'pending_transfers': transfers if created else 0,
                                   'audit': dict.fromkeys(self.module.TRANSFER_AUDIT_FIELDS, 0)})
            return ''

        def health():
            nonlocal created
            self.assertTrue(serving)
            self.assertEqual((self.base / 'current').resolve(), self.candidate)
            created = True
            raise RuntimeError('RELEASE_HEALTH_FAILED')

        self.run.side_effect = command
        with mock.patch.object(self.module, 'health', side_effect=health) as health_check:
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_BLOCKED_PENDING_OBLIGATIONS'):
                self.promote('--compatible-schema')
        self.assertEqual(queries, [(False, True, self.old), (False, False, self.old), (True, False, self.candidate)])
        self.assertFalse(serving)
        health_check.assert_called_once()
        self.assertEqual((self.base / 'current').resolve(), self.candidate)
        self.assertEqual(sum(command[:2] == ['systemctl', 'start'] for command in self.commands), 1)
        self.assertEqual(previous_report.read_bytes(), b'{"previous_success":"unchanged"}\n')
        self.assertEqual(self.output.getvalue(), '')

    def test_new_room_blocks_rollback_to_release_without_its_rules(self):
        self.fail_health_after_new_obligation(rooms=1)

    def test_new_wallet_obligation_blocks_rollback(self):
        self.fail_health_after_new_obligation(cycles=1)

    def test_new_unknown_transfer_blocks_rollback_even_with_no_game_obligation(self):
        self.fail_health_after_new_obligation(transfers=1)

    def test_rollback_database_read_failure_keeps_candidate_stopped_and_diagnostic_fixed(self):
        with mock.patch.object(self.module, 'pending', side_effect=[0, 0, RuntimeError('private DB diagnostic')]) as pending, \
                mock.patch.object(self.module, 'health', side_effect=RuntimeError('RELEASE_HEALTH_FAILED')) as health:
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_BLOCKED_PENDING_CHECK_FAILED') as error:
                self.promote('--compatible-schema')
        self.assertNotIn('private DB diagnostic', str(error.exception))
        self.assertIn('API/demo stopped', str(error.exception))
        self.assertEqual(pending.call_count, 3)
        health.assert_called_once()
        self.assertEqual((self.base / 'current').resolve(), self.candidate)
        self.assertEqual(self.commands[-1], ['systemctl', 'stop', 'oasis-demo', 'oasis-api'])
        self.assertEqual(sum(command[:2] == ['systemctl', 'start'] for command in self.commands), 1)
        self.assertFalse((self.base / 'private/last-release.json').exists())
        self.assertEqual(self.output.getvalue(), '')

    def test_rollback_stop_failure_never_checks_database_or_switches_to_old(self):
        stops = 0

        def command(args, **kwargs):
            nonlocal stops
            self.record_command(args)
            if args[:2] == ['systemctl', 'stop']:
                stops += 1
                if stops == 2:
                    raise self.module.subprocess.CalledProcessError(1, args, stderr='private service diagnostic')
            return ''

        self.run.side_effect = command
        with mock.patch.object(self.module, 'pending', side_effect=[0, 0]) as pending, \
                mock.patch.object(self.module, 'health', side_effect=RuntimeError('RELEASE_HEALTH_FAILED')) as health:
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_BLOCKED_STOP_FAILED') as error:
                self.promote('--compatible-schema')
        self.assertNotIn('private service diagnostic', str(error.exception))
        self.assertIn('service state unverified', str(error.exception))
        self.assertEqual(pending.call_count, 2)
        health.assert_called_once()
        self.assertEqual((self.base / 'current').resolve(), self.candidate)
        self.assertEqual(self.commands[-1], ['systemctl', 'stop', 'oasis-demo', 'oasis-api'])
        self.assertEqual(sum(command[:2] == ['systemctl', 'start'] for command in self.commands), 1)
        self.assertFalse((self.base / 'private/last-release.json').exists())

    def test_partially_failed_candidate_start_also_requires_post_stop_pending_guard(self):
        def command(args, **kwargs):
            self.record_command(args)
            if args[:2] == ['systemctl', 'start']:
                raise self.module.subprocess.CalledProcessError(1, args)
            return ''

        self.run.side_effect = command
        with mock.patch.object(self.module, 'pending', side_effect=[0, 0, 1]) as pending, \
                mock.patch.object(self.module, 'health') as health:
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_BLOCKED_PENDING_OBLIGATIONS'):
                self.promote('--compatible-schema')
        self.assertEqual(pending.call_count, 3)
        health.assert_not_called()
        self.assertEqual((self.base / 'current').resolve(), self.candidate)
        self.assertEqual(self.commands[-1], ['systemctl', 'stop', 'oasis-demo', 'oasis-api'])
        self.assertEqual(sum(command[:2] == ['systemctl', 'start'] for command in self.commands), 1)

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


class TransferObligationChecks(unittest.TestCase):
    def setUp(self):
        self.module = load_script()

    def report(self, schema='present', transfers=0, games=0):
        return {'transfer_schema': schema, 'pending_games': games, 'pending_transfers': transfers,
                'audit': dict.fromkeys(self.module.TRANSFER_AUDIT_FIELDS, 0) if schema == 'present' else None}

    def test_full_feature_checks_games_pending_transfers_and_shared_audit_in_one_read_only_session(self):
        with mock.patch.object(self.module, 'run', return_value=json.dumps(self.report(transfers=3, games=2))) as run:
            self.assertEqual(self.module.pending(), 5)
        args = run.call_args.args[0]
        self.assertEqual(args, ['docker', 'exec', '-i', 'oasis-postgres', 'psql', '-X', '-qAt',
                               '-v', 'ON_ERROR_STOP=1', '-U', 'oasis', '-d', 'oasis_platform'])
        query = run.call_args.kwargs['input']
        self.assertEqual(run.call_args.kwargs['timeout'], 30)
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', query)
        self.assertIn("count(c.oid)=0 AS transfer_absent", query)
        self.assertIn("count(c.oid)=5 AND bool_and(c.relkind='r')", query)
        self.assertIn("gp_transfers WHERE state='PENDING'", query)
        self.assertIn(self.module.transfer_audit_sql(), query)
        self.assertIn("RAISE EXCEPTION 'TRANSFER_SCHEMA_INCOMPLETE'", query)
        self.assertTrue(query.endswith('COMMIT;'))
        run.assert_called_once()

    def test_explicit_absent_feature_requires_no_transfer_ledger_trace(self):
        with mock.patch.object(self.module, 'run', return_value=json.dumps(self.report('absent', games=2))):
            self.assertEqual(self.module.pending(), 2)
        query = self.module.pending_sql()
        self.assertIn("account LIKE 'transfer:%' OR meta->>'kind' LIKE 'transfer_%'", query)
        self.assertLess(query.index('\\if :transfer_legacy_clean'), query.index("'transfer_schema','absent'"))

    def test_missing_partial_unknown_malformed_audit_never_defaults_to_zero(self):
        invalid = [{}, self.report('partial'), self.report('absent', transfers=1)]
        for field in self.module.TRANSFER_AUDIT_FIELDS:
            for value in (1, None, False, '0', -1):
                report = self.report(); report['audit'][field] = value; invalid.append(report)
        for key in ('audit', 'pending_games', 'pending_transfers', 'transfer_schema'):
            report = self.report(); del report[key]; invalid.append(report)
        for value in (None, False, '0', -1):
            report = self.report(); report['pending_transfers'] = value; invalid.append(report)
        for report in invalid:
            with self.subTest(report=report), mock.patch.object(self.module, 'run', return_value=json.dumps(report)):
                with self.assertRaisesRegex(RuntimeError, '^OBLIGATIONS_CHECK_FAILED$'):
                    self.module.pending()

    def test_psql_partial_schema_or_query_failure_is_sanitized_and_never_retried(self):
        with mock.patch.object(self.module, 'run', side_effect=RuntimeError('private provider account')) as run:
            with self.assertRaisesRegex(RuntimeError, '^OBLIGATIONS_CHECK_FAILED$') as error:
                self.module.pending()
        run.assert_called_once(); self.assertNotIn('private', str(error.exception))

    def test_shared_audit_literal_cannot_silently_disappear_interpolate_or_expand_to_psql_commands(self):
        valid = 'export const TRANSFER_AUDIT_SQL=`WITH records AS (SELECT 1) SELECT 1`;'
        for source in ('', valid + valid, valid.replace('SELECT 1`', 'SELECT ${value}`'),
                       valid.replace('SELECT 1`', 'SELECT 1; SELECT 2`'),
                       valid.replace('SELECT 1`', 'SELECT 1\\gexec`')):
            with self.subTest(source=source), mock.patch.object(Path, 'read_text', return_value=source):
                with self.assertRaisesRegex(RuntimeError, '^TRANSFER_AUDIT_INTERFACE_INVALID$'):
                    self.module.transfer_audit_sql()


if __name__ == '__main__':
    unittest.main()
