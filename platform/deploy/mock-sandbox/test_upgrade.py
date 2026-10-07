"""Local filesystem protocol fixtures. Systemd/Docker are injected, never contacted.

These run unchanged on Linux, but do not substitute for a real PostgreSQL dump/
restore drill, an installed Mock preflight or public/device acceptance.
"""
from contextlib import contextmanager, ExitStack
import copy
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('upgrade.py')
spec = importlib.util.spec_from_file_location('mock_upgrade_test', SOURCE)
upgrade = importlib.util.module_from_spec(spec)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), upgrade.__dict__)


class FakeRuntime:
    def __init__(self):
        self.events = []
        self.active = True
        self.failure = None
        self.business = {'audit': dict.fromkeys(upgrade.INTEGRITY_COUNTS, 0), 'pending': {'presentations': 0},
                         'tables': {'wallet_users': {'rows': 2, 'sha256': 'a' * 64}}, 'schema_sha256': 'b' * 64}
        self.identity = {'container_id': 'fixture-container', 'volume': upgrade.installer.VOLUME,
                         'uid': os.geteuid(), 'postgres_image': 'fixture-pinned', 'network_fingerprint': 'same'}

    def event(self, event):
        self.events.append(event)
        if self.failure == event:
            self.failure = None
            raise RuntimeError('FIXTURE_INJECTED_FAILURE')

    def services(self):
        return {name: 'active' if self.active or name in upgrade.INFRA_UNITS else 'inactive'
                for name in (*upgrade.APP_UNITS, *upgrade.INFRA_UNITS)}

    def resources(self, state):
        self.event('resources')
        return copy.deepcopy(self.identity)

    def guard(self, state):
        self.event('guard')
        return self.resources(state)

    def preflight(self, release):
        self.event('preflight:' + release.name)

    def inspect_business(self, release):
        self.event('business')
        return copy.deepcopy(self.business)

    def database_size(self):
        return 100

    def stop(self):
        self.event('stop')
        self.active = False

    def start(self):
        self.event('start')
        self.active = True

    def health(self):
        self.event('health')
        if not self.active:
            raise RuntimeError('FIXTURE_INACTIVE')

    def dump(self, target, maximum, base):
        self.event('dump')
        with target.open('xb') as stream:
            stream.write(b'fixture dump, NOT PostgreSQL')
            stream.flush()
            os.fsync(stream.fileno())
        target.chmod(0o600)
        return {'bytes': target.stat().st_size, 'sha256': upgrade.digest(target),
                'toc_sha256': 'c' * 64, 'validation': 'fixture only'}


def put(root, name, data, mode=0o644):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)
    return path


def tree(root):
    result = {}
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        result[path.relative_to(root).as_posix()] = (info.st_mode, info.st_ino,
            os.readlink(path) if path.is_symlink() else upgrade.digest(path) if path.is_file() else None)
    return result


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
        base = Path(temporary).resolve()
        runtime = FakeRuntime()
        task = upgrade.Upgrade(base, runtime, base / 'locks')
        for root in (task.old, task.new):
            root.mkdir(parents=True)
            sources = {
                'platform/server/schema.sql': 'platform schema',
                'platform/server/pvp/schema.sql': 'pvp schema',
                'platform/server/wallet/schema.sql': 'wallet schema',
                'platform/server/index.mjs': 'server', 'platform/shared/games.mjs': 'games',
                'platform/package.json': 'package', 'platform/package-lock.json': 'lock',
                'platform/deploy/mock-sandbox/install.py': upgrade.DEPENDENCY.read_bytes(),
                'platform/deploy/mock-sandbox/preflight.mjs': 'preflight',
                'platform/deploy/mock-sandbox/isolation.mjs': 'isolation',
                'platform/deploy/demo-host.mjs': 'host',
                'platform/deploy/restore-drill.mjs': 'restore audit',
                'platform/server/pvp/index.mjs': 'old pvp' if root == task.old else 'new reviewed pvp',
                'platform/dist/assets/index-abcdefgh.js': 'shared static',
            }
            if root == task.new:
                sources['platform/shared/run-action-receipt.mjs'] = 'new receipt'
            for name, data in sources.items():
                put(root, name, data)
            entries = {name: upgrade.digest(root / name) for name in sources}
            put(root, 'RELEASE-MANIFEST.json', json.dumps({'files': entries}, sort_keys=True))
            put(root, 'platform/node_modules/tsx/package.json', '{"version":"fixed"}')
            put(root, 'platform/node_modules/pg/package.json', '{"version":"fixed"}')
            put(root, 'platform/node_modules/tsx/dist/cli.mjs', 'binary fixture', 0o755)
            (root / 'platform/node_modules/.bin').mkdir()
            (root / 'platform/node_modules/.bin/tsx').symlink_to('../tsx/dist/cli.mjs')
        stack.enter_context(patch.object(upgrade, 'NEW_MANIFEST', upgrade.digest(task.new / 'RELEASE-MANIFEST.json')))
        stack.enter_context(patch.object(upgrade, 'REVIEWED_PVP', tuple(upgrade.digest(root / 'platform/server/pvp/index.mjs') for root in (task.old, task.new))))
        stack.enter_context(patch.object(upgrade, 'RECEIPT_SHA', upgrade.digest(task.new / 'platform/shared/run-action-receipt.mjs')))
        stack.enter_context(patch.object(upgrade, 'available', return_value=upgrade.RESERVE + 2 ** 30))
        stack.enter_context(patch.object(upgrade.installer.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getgid())))
        task.private.mkdir(mode=0o750)
        task.private.chmod(0o750)
        for name in upgrade.PRIVATE_FILES:
            put(task.private, name, 'fixture secret ' + name, 0o600)
        (task.private / 'state').chmod(0o700)
        put(task.private, 'state/static-cache/cached-abcdefgh.js', 'old private cache', 0o600)
        state = {'kind': 'isolated-13-game-mock', 'host': upgrade.installer.HOST,
                 'release': str(task.old), 'manifest_sha256': upgrade.digest(task.old / 'RELEASE-MANIFEST.json'),
                 'id': 'fixture-owned', 'tooling_repair': {'status': 'complete'}, 'uid': os.geteuid()}
        put(task.private, 'installation.json', json.dumps(state), 0o600)
        task.pin.symlink_to(task.old)
        (base / 'current').symlink_to(task.new)
        put(base, 'private/runtime.env', 'untouched live secret', 0o600)
        put(base, 'private/release.lock', '')
        for name in ('install', 'network'):
            put(task.lock_root, 'oasis-android-mock-' + name + '.lock', '')
        put(base, 'published.apk', 'unchanged apk')
        yield task, runtime, state


class UpgradeTests(unittest.TestCase):
    def test_default_check_is_read_only_and_complete(self):
        with fixture() as (task, runtime, state):
            before = tree(task.base)
            result, actual = task.check()
            self.assertTrue(result['apply_allowed'])
            self.assertEqual(actual, state)
            self.assertGreater(result['runtime_compatibility']['installed_dependencies']['entries'], 0)
            self.assertEqual(before, tree(task.base))
            self.assertNotIn('stop', runtime.events)

    def test_missing_forward_or_reverse_unlisted_fingerprint_refuses_before_stop(self):
        for side, key in (('old', 'forward_assets'), ('new', 'rollback_assets')):
            with self.subTest(side=side), fixture() as (task, runtime, _):
                put(getattr(task, side), 'platform/arena/dist/assets/unlisted-12345678.js', 'actual unlisted bytes')
                result, _ = task.check()
                self.assertEqual(result['blockers'], [key])
                self.assertEqual(result[key]['missing'], ['platform/arena/dist/assets/unlisted-12345678.js'])
                with self.assertRaisesRegex(RuntimeError, 'STATIC_FORWARD_OR_ROLLBACK'):
                    task.apply()
                self.assertFalse(task.work.exists())
                self.assertNotIn('stop', runtime.events)

    def test_changed_same_url_or_symlink_static_is_rejected(self):
        with fixture() as (task, _, _):
            for root, value in ((task.old, 'old'), (task.new, 'new')):
                put(root, 'platform/public/asset-12345678.js', value)
            result, _ = task.check()
            self.assertEqual(result['blockers'], ['forward_assets', 'rollback_assets'])
        with fixture() as (task, _, _):
            path = task.old / 'platform/public'
            path.symlink_to(task.new / 'platform/dist')
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_STATIC_DIRECTORY'):
                task.check()

    def test_unhashed_media_dependencies_are_checked_but_html_can_change(self):
        with fixture() as (task, _, _):
            put(task.old, 'platform/public/art/character.png', 'old artwork')
            put(task.new, 'platform/public/art/character.png', 'new artwork')
            put(task.old, 'platform/dist/index.html', 'old document')
            put(task.new, 'platform/dist/index.html', 'new document')
            result, _ = task.check()
            self.assertEqual(result['forward_assets']['changed'], ['platform/public/art/character.png'])

    def test_manifest_hash_paths_and_actual_dependencies_are_verified(self):
        for relative, message in [('platform/server/schema.sql', 'RELEASE_HASH_MISMATCH'),
                                  ('platform/node_modules/pg/package.json', 'INSTALLED_DEPENDENCIES_CHANGED')]:
            with self.subTest(relative=relative), fixture() as (task, _, _):
                (task.new / relative).write_text('changed')
                with self.assertRaisesRegex(RuntimeError, message):
                    task.check()
        with fixture() as (task, _, _):
            (task.new / 'platform/node_modules/.bin/tsx').unlink()
            (task.new / 'platform/node_modules/.bin/tsx').symlink_to('/bin/sh')
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_DEPENDENCY_LINK'):
                task.check()

    def test_unreviewed_runtime_dependency_or_schema_changes_fail_closed(self):
        with fixture() as (task, _, _):
            old, new = upgrade.manifest(task.old), upgrade.manifest(task.new)
            for name in ('platform/server/schema.sql', 'platform/deploy/demo-host.mjs', 'src/run.ts', 'platform/arena/run/engine.mjs'):
                with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'SCHEMA_ENGINE_OR_DEPENDENCY_CHANGED'):
                    upgrade.compatible(old, dict(new, **{name: 'f' * 64}))
            with self.assertRaisesRegex(RuntimeError, 'UNREVIEWED_PVP_CHANGE'):
                upgrade.compatible(old, dict(new, **{'platform/server/pvp/index.mjs': 'f' * 64}))

    def test_marker_pin_or_private_symlink_mismatch_is_rejected(self):
        with fixture() as (task, _, _):
            task.pin.unlink()
            task.pin.symlink_to(task.new)
            with self.assertRaisesRegex(RuntimeError, 'EXACT_RUNNING_04_REQUIRED'):
                task.check()
        with fixture() as (task, _, _):
            path = task.private / 'runtime.env'
            data = path.read_bytes()
            path.unlink()
            elsewhere = put(task.base, 'elsewhere', data, 0o600)
            path.symlink_to(elsewhere)
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_PATH_COMPONENT'):
                task.check()

    def test_pending_business_or_insufficient_space_does_not_stop(self):
        for kind in ('audit', 'pending'):
            with self.subTest(kind=kind), fixture() as (task, runtime, _):
                runtime.business[kind]['fixture'] = 1
                with self.assertRaisesRegex(RuntimeError, 'MOCK_.*(OBLIGATIONS|WALLET)'):
                    task.apply()
                self.assertNotIn('stop', runtime.events)
        with fixture() as (task, runtime, _), patch.object(upgrade, 'available', return_value=upgrade.RESERVE):
            with self.assertRaisesRegex(RuntimeError, 'SPACE_INSUFFICIENT'):
                task.apply()
            self.assertNotIn('stop', runtime.events)

    def test_dual_locks_and_network_lock_exclude_competitors(self):
        with fixture() as (task, runtime, _):
            for path in (task.base / 'private/release.lock', task.lock_root / 'oasis-android-mock-install.lock', task.lock_root / 'oasis-android-mock-network.lock'):
                with path.open('rb') as stream:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.subTest(path=path.name), self.assertRaises(BlockingIOError):
                        with task.locked(network='network' in path.name):
                            self.fail('must not enter')
            self.assertNotIn('stop', runtime.events)

    def test_success_preserves_originals_and_retains_verified_private_backup(self):
        with fixture() as (task, runtime, state):
            before = {root: tree(root) for root in (task.old, task.new)}
            private = task.private_hashes()
            boundary = task.live_boundary()
            result = task.apply()
            self.assertEqual(result['status'], 'upgraded')
            self.assertEqual(task.state(), (dict(state, release=str(task.new), manifest_sha256=upgrade.NEW_MANIFEST), task.new))
            self.assertEqual(private, task.private_hashes())
            self.assertEqual(boundary, task.live_boundary())
            self.assertEqual((task.base / 'published.apk').read_text(), 'unchanged apk')
            for root in before:
                self.assertEqual(before[root], tree(root))
            journal = task.load_journal()
            task.verify_backup(journal)
            with tarfile.open(task.work / 'backup/private-config.tar') as bundle:
                self.assertIn('android-mock-private/state/static-cache/cached-abcdefgh.js', bundle.getnames())
                self.assertFalse(any('upgrade-2026' in name for name in bundle.getnames()))
                old = json.load(bundle.extractfile('android-mock-private/installation.json'))
                self.assertEqual(old, state)
            self.assertTrue(runtime.active)
            self.assertEqual(task.recover()['status'], 'already_complete')

    def test_backup_or_new_preflight_failure_rolls_back_exactly(self):
        for failure in ('dump', 'preflight:' + upgrade.NEW_NAME, 'health'):
            with self.subTest(failure=failure), fixture() as (task, runtime, state):
                runtime.failure = failure
                marker_bytes = task.marker.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'FAILED_ROLLED_BACK'):
                    task.apply()
                self.assertEqual(task.state(), (state, task.old))
                self.assertEqual(task.marker.read_bytes(), marker_bytes)
                self.assertTrue(runtime.active)
                self.assertEqual(task.load_journal()['phase'], 'rolled_back')
                self.assertEqual(task.recover()['status'], 'already_rolled_back')

    def test_pending_discovered_after_stop_restores_original_service_without_clearing_it(self):
        with fixture() as (task, runtime, state):
            stop = runtime.stop
            def race():
                stop()
                runtime.business['pending']['presentations'] = 1
            with patch.object(runtime, 'stop', side_effect=race), self.assertRaisesRegex(RuntimeError, 'FAILED_ROLLED_BACK'):
                task.apply()
            self.assertEqual(task.state(), (state, task.old))
            self.assertEqual(runtime.business['pending']['presentations'], 1)
            self.assertTrue(runtime.active)
            self.assertNotIn('dump', runtime.events)

    def test_space_loss_during_private_backup_keeps_original_and_partial_evidence(self):
        with fixture() as (task, runtime, state):
            dump = runtime.dump
            def consume(*args):
                receipt = dump(*args)
                upgrade.available.return_value = upgrade.RESERVE
                return receipt
            with patch.object(runtime, 'dump', side_effect=consume), self.assertRaisesRegex(RuntimeError, 'FAILED_ROLLED_BACK'):
                task.apply()
            self.assertEqual(task.state(), (state, task.old))
            self.assertTrue((task.work / 'backup/database.dump').exists())
            self.assertTrue(runtime.active)

    def test_each_durable_phase_interrupt_recovers_without_restoring_database(self):
        for phase in ('prepared', 'stopping', 'stopped', 'backing_up', 'backed_up', 'switching', 'pin_switched', 'marker_switched', 'starting'):
            with self.subTest(phase=phase), fixture() as (task, runtime, state):
                original = task.save
                def crash(journal, next_phase):
                    original(journal, next_phase)
                    if next_phase == phase:
                        raise KeyboardInterrupt('fixture crash')
                with patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                    task.apply()
                result = task.recover()
                self.assertEqual(result['status'], 'rolled_back')
                self.assertFalse(result['database_restored'])
                self.assertEqual(task.state(), (state, task.old))
                self.assertTrue(runtime.active)

    def test_business_changes_after_new_start_preserve_healthy_service_and_pending_game(self):
        with fixture() as (task, runtime, _):
            original = runtime.start
            def changed():
                original()
                runtime.business['tables']['wallet_users']['rows'] += 1
                runtime.business['pending']['presentations'] = 1
            with patch.object(runtime, 'start', side_effect=changed):
                result = task.apply()
            self.assertEqual(result['status'], 'upgraded')
            self.assertTrue(result['business_changed_after_start'])
            self.assertTrue(runtime.active)
            self.assertEqual(runtime.business['tables']['wallet_users']['rows'], 3)
            self.assertEqual(task.pin.resolve(), task.new)
            self.assertEqual(runtime.events.count('stop'), 1)
            self.assertEqual(task.recover()['status'], 'already_complete')

    def test_installed_0750_private_layout_and_group_are_validated_without_chmod(self):
        with fixture() as (task, _, _):
            before = task.private.stat()
            self.assertEqual(before.st_mode & 0o777, 0o750)
            task.check()
            self.assertEqual(task.private.stat(), before)
            with patch.object(upgrade.installer.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.geteuid(), pw_gid=before.st_gid + 1)):
                with self.assertRaisesRegex(RuntimeError, 'UNSAFE_MOCK_PRIVATE_DIRECTORY'):
                    task.check()
            task.private.chmod(0o770)
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_MOCK_PRIVATE_DIRECTORY'):
                task.check()

    def test_new_healthy_boundary_crashes_and_activity_do_not_stop_new_service(self):
        for after_write in (False, True):
            with self.subTest(after_write=after_write), fixture() as (task, runtime, _):
                save = task.save
                def crash(journal, phase):
                    if phase == 'healthy':
                        runtime.business['pending']['presentations'] = 1
                        if after_write:
                            save(journal, phase)
                        raise KeyboardInterrupt()
                    save(journal, phase)
                with patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                    task.apply()
                stops = runtime.events.count('stop')
                result = task.recover()
                self.assertEqual(result['status'], 'upgraded')
                self.assertTrue(result['business_changed_after_start'])
                self.assertTrue(runtime.active)
                self.assertEqual(runtime.events.count('stop'), stops)
                self.assertEqual(task.pin.resolve(), task.new)

    def test_old_healthy_boundary_crashes_and_activity_do_not_stop_restored_service(self):
        for after_write in (False, True):
            with self.subTest(after_write=after_write), fixture() as (task, runtime, state):
                runtime.failure = 'preflight:' + upgrade.NEW_NAME
                start, save = runtime.start, task.save
                def active_player():
                    start()
                    runtime.business['pending']['presentations'] = 1
                def crash(journal, phase):
                    if phase == 'rollback_healthy':
                        if after_write:
                            save(journal, phase)
                        raise KeyboardInterrupt()
                    save(journal, phase)
                with patch.object(runtime, 'start', side_effect=active_player), patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                    task.apply()
                stops = runtime.events.count('stop')
                result = task.recover()
                self.assertEqual(result['status'], 'rolled_back')
                self.assertEqual(task.state(), (state, task.old))
                self.assertTrue(runtime.active)
                self.assertEqual(runtime.events.count('stop'), stops)
                self.assertEqual(runtime.business['pending']['presentations'], 1)

    def test_new_activity_racing_recovery_stop_restarts_matching_new_version(self):
        with fixture() as (task, runtime, _):
            save = task.save
            def crash(journal, phase):
                save(journal, phase)
                if phase == 'starting':
                    raise KeyboardInterrupt()
            with patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                task.apply()
            runtime.active = True
            stop = runtime.stop
            def race():
                stop()
                runtime.business['pending']['presentations'] = 1
            with patch.object(runtime, 'stop', side_effect=race):
                result = task.recover()
            self.assertEqual(result['status'], 'upgraded')
            self.assertTrue(runtime.active)
            self.assertEqual(task.pin.resolve(), task.new)
            self.assertTrue(result['business_changed_after_start'])

    def test_old_activity_racing_recovery_stop_restarts_matching_restored_version(self):
        with fixture() as (task, runtime, state):
            runtime.failure = 'preflight:' + upgrade.NEW_NAME
            save = task.save
            def crash(journal, phase):
                if phase == 'rollback_healthy':
                    raise KeyboardInterrupt()
                save(journal, phase)
            with patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                task.apply()
            self.assertEqual(task.load_journal()['phase'], 'rolling_back')
            self.assertTrue(runtime.active)
            self.assertEqual(task.state(), (state, task.old))
            stop = runtime.stop
            def race():
                stop()
                runtime.business['pending']['presentations'] = 1
            with patch.object(runtime, 'stop', side_effect=race):
                result = task.recover()
            self.assertEqual(result['status'], 'rolled_back')
            self.assertTrue(runtime.active)
            self.assertEqual(task.state(), (state, task.old))
            self.assertEqual(runtime.business['pending']['presentations'], 1)
            self.assertTrue(task.load_journal()['rollback_business_changed_after_start'])

    def test_changed_new_runtime_with_failed_health_or_integrity_is_not_stopped(self):
        for failure in ('health', 'integrity'):
            with self.subTest(failure=failure), fixture() as (task, runtime, _):
                save = task.save
                def crash(journal, phase):
                    save(journal, phase)
                    if phase == 'starting':
                        raise KeyboardInterrupt()
                with patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                    task.apply()
                runtime.active = True
                runtime.business['pending']['presentations'] = 1
                if failure == 'health':
                    runtime.failure = 'health'
                else:
                    runtime.business['audit']['balance_mismatches'] = 1
                stops = runtime.events.count('stop')
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assertTrue(runtime.active)
                self.assertEqual(runtime.events.count('stop'), stops)
                self.assertEqual(task.pin.resolve(), task.new)
                runtime.business['audit']['balance_mismatches'] = 0
                self.assertEqual(task.recover()['status'], 'upgraded')

    def test_recovery_refuses_corrupt_backup_private_drift_or_wrong_identity(self):
        for drift in ('backup', 'private', 'identity', 'journal'):
            with self.subTest(drift=drift), fixture() as (task, runtime, _):
                original = task.save
                def crash(journal, phase):
                    original(journal, phase)
                    if phase == 'pin_switched':
                        raise KeyboardInterrupt()
                with patch.object(task, 'save', side_effect=crash), self.assertRaises(KeyboardInterrupt):
                    task.apply()
                if drift == 'backup':
                    (task.work / 'backup/database.dump').write_text('changed')
                elif drift == 'private':
                    (task.private / 'runtime.env').write_text('changed')
                elif drift == 'identity':
                    runtime.identity['container_id'] = 'different'
                else:
                    journal = json.loads(task.journal.read_text())
                    journal['new_state']['id'] = 'changed'
                    upgrade.write_json(task.journal, journal)
                before = task.state()
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assertEqual(task.state(), before)
                self.assertTrue(task.journal.exists())

    def test_cli_default_prints_no_private_evidence_and_acquires_locks(self):
        with fixture() as (task, _, _), patch.object(upgrade, 'Upgrade', return_value=task), patch.object(upgrade.os, 'geteuid', return_value=os.getuid()), patch('sys.stdout', new=io.StringIO()) as output:
            # Avoid spoofing file ownership: exercise production root guard separately.
            with patch.object(upgrade, 'require', side_effect=lambda value, code: None if code == 'ROOT_REQUIRED' else (_ for _ in ()).throw(RuntimeError(code)) if not value else None):
                upgrade.main([])
            report = json.loads(output.getvalue())
            self.assertEqual(report['mode'], 'check-only')
            for forbidden in ('private_hashes', 'business', 'live_boundary', 'resources'):
                self.assertNotIn(forbidden, report)
            self.assertNotIn('fixture secret', output.getvalue())

    def test_runtime_commands_only_target_fixed_mock_and_sanitize_errors(self):
        runtime = upgrade.Runtime()
        with patch.object(runtime, 'run', return_value=b'1') as run:
            self.assertEqual(runtime.sql('SELECT 1'), '1')
            command = run.call_args.args[0]
            self.assertIn(upgrade.installer.CONTAINER, command)
            self.assertIn('oasis_android_mock', command)
            self.assertEqual(run.call_args.kwargs['input'], b'SELECT 1')
        with patch.object(upgrade.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'password-value', b'key-value')):
            with self.assertRaisesRegex(RuntimeError, '^MOCK_COMMAND_FAILED$'):
                runtime.run(['fixture'])
        with patch.object(runtime, 'run') as run, patch.object(runtime, 'services', return_value={key: 'inactive' for key in upgrade.APP_UNITS}):
            runtime.stop()
            runtime.start()
            self.assertEqual([call.args[0] for call in run.call_args_list], [
                ['systemctl', 'stop', upgrade.APP_UNITS[1], upgrade.APP_UNITS[0]],
                ['systemctl', 'start', upgrade.APP_UNITS[0], upgrade.APP_UNITS[1]]])

    def test_business_audit_runs_once_in_read_only_snapshot_and_covers_pending_presentations(self):
        with tempfile.TemporaryDirectory() as temporary:
            release = Path(temporary)
            put(release, 'platform/deploy/restore-drill.mjs', 'export const RESTORE_AUDIT_SQL=`SELECT audit;`;')
            audit = {str(i): 0 for i in range(11)}
            rows = {'rows': 0, 'sha256': 'a' * 64}
            lines = [json.dumps(audit), '{"presentations":0}', *[json.dumps(rows) for _ in upgrade.BUSINESS_TABLES], 'b' * 64]
            runtime = upgrade.Runtime()
            with patch.object(runtime, 'sql', return_value='\n'.join(lines)) as sql:
                result = runtime.inspect_business(release)
                self.assertEqual(len(result['tables']), len(upgrade.BUSINESS_TABLES))
                sql.assert_called_once()
                text = sql.call_args.args[0]
                self.assertTrue(text.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'))
                self.assertTrue(text.endswith('ROLLBACK;'))
                for token in ('pendingPlay', 'nextIndex', "state='RESERVED'", 'credit_pending', 'pg_indexes'):
                    self.assertIn(token, text)
                self.assertNotIn('DELETE', text)
                self.assertNotIn('UPDATE ', text)

    def test_dump_is_bounded_and_uses_no_password_or_live_container(self):
        real_popen = subprocess.Popen
        def fake_dump(command, **kwargs):
            self.assertEqual(command, ['docker', 'exec', upgrade.installer.CONTAINER,
                                      'pg_dump', '-U', 'postgres', '-d', 'oasis_android_mock', '-Fc'])
            return real_popen(['python3', '-c', 'import sys; sys.stdout.buffer.write(b"x" * 4096)'], **kwargs)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'database.dump'
            with patch.object(upgrade.subprocess, 'Popen', side_effect=fake_dump), patch.object(upgrade, 'available', return_value=upgrade.RESERVE + 10000):
                with self.assertRaisesRegex(RuntimeError, 'MOCK_BACKUP_SPACE_EXHAUSTED'):
                    upgrade.Runtime().dump(target, 1024, Path(temporary))
            self.assertTrue(target.is_file())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
