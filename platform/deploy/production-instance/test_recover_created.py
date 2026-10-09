"""Isolated synthetic/temp-FS contracts. No Docker, PostgreSQL or services."""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from contextlib import nullcontext
from unittest.mock import Mock, patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('created_recovery_test', HERE / 'recover-created.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
p = r.p


def original():
    marker = {'schema': 1, 'kind': 'isolated-production-instance', 'release': r.OLD_RELEASE,
              'manifest_sha256': r.OLD_MANIFEST, 'container_id': r.CID, 'owner': r.OWNER,
              'uid': 997, 'gid': 999, 'network_id': r.NETWORK_ID, 'pg_image': r.IMAGE,
              'origins': ['https://oasis-player.43.98.202.236.sslip.io', 'https://game.tianyahuyu.com'],
              'private_pins': {'runtime.env': {'sha256': 'e' * 64}}}
    failed = {'schema': 1, 'kind': 'isolated-production-provision', 'passed': False,
              'phase': 'failed_closed', 'error_code': 'PROVISION_FAILED',
              'check_sha256': r.OLD_CHECK, 'container_id': r.CID, 'source': r.OLD_HELPERS,
              'history': [{'at': '2026-10-09T18:23:40.707457+00:00', 'phase': 'namespace_created'},
                          {'at': '2026-10-09T18:23:40.855114+00:00', 'phase': 'database_resources_created'},
                          {'at': '2026-10-09T18:23:41.135722+00:00', 'phase': 'failed_closed'}]}
    return marker, failed


def history():
    return {'schema': 1, 'kind': 'retired-never-activated-production-candidate',
            'passed': True, 'release': r.OLD_RELEASE, 'manifest_sha256': r.OLD_MANIFEST,
            'members': 1158, 'dependencies_match': '/opt/oasis/releases/20261009-03',
            'archive_sha256': r.ARCHIVE_SHA, 'activated': False, 'retired': True,
            'original_check_sha256': r.OLD_CHECK, 'protected_inventory_sha256': r.PROTECTED_SHA,
            'source_archive_provenance': {'local_verified': True},
            'runtime_dependencies': r.DEPENDENCIES, 'retired_at': p.now(),
            'protected_before_sha256': r.PUBLIC_SNAPSHOT_SHA, 'protected_after_sha256': r.PUBLIC_SNAPSHOT_SHA,
            'created_container_id': r.CID, 'original_helpers': r.OLD_HELPERS,
            'marker_sha256': r.OLD_MARKER, 'failed_receipt_sha256': r.OLD_RECEIPT,
            'preservation': {'RELEASE-MANIFEST.json': {'sha256': r.OLD_MANIFEST},
                             'marker-original.json': {'sha256': r.OLD_MARKER},
                             'receipt-original.json': {'sha256': r.OLD_RECEIPT},
                             **{'helpers/' + name: {'sha256': sha} for name, sha in r.OLD_HELPERS.items()}}}


def instance():
    tool = r.Recovery.__new__(r.Recovery)
    tool.runtime = Mock()
    tool.release = Path(r.NEW_RELEASE)
    tool.args = types.SimpleNamespace(manifest_sha256='f' * 64, retired_source=str(r.RETIRED_SOURCE),
                                     retired_source_sha256='a' * 64, check_sha256='b' * 64,
                                     recover_exact_created_closed=True)
    tool.marker, _ = original()
    tool.receipt = {'history': [], 'phase': 'database_resources_created', 'container_id': r.CID}
    return tool


class OriginContracts(unittest.TestCase):
    def test_exact_witnessed_origin(self):
        r.origin_guard(*original())

    def test_identity_changes_never_adopted(self):
        for key, value in [('container_id', 'a' * 64), ('owner', 'a' * 32), ('uid', True),
                           ('gid', 998), ('network_id', 'a' * 64), ('release', r.NEW_RELEASE),
                           ('manifest_sha256', 'a' * 64)]:
            with self.subTest(key=key):
                marker, failed = original()
                marker[key] = value
                with self.assertRaisesRegex(p.Refusal, 'ORIGINAL_MARKER'):
                    r.origin_guard(marker, failed)

    def test_history_not_reset_or_generalized(self):
        for change in ('bootstrap', 'history', 'source', 'passed', 'phase'):
            marker, failed = original()
            if change == 'history':
                failed[change].append({'at': p.now(), 'phase': 'extra'})
            elif change == 'source':
                failed[change] = {**failed[change], 'provision.py': 'a' * 64}
            else:
                failed[change] = True
            with self.subTest(change=change), self.assertRaisesRegex(p.Refusal, 'FAILED_RECEIPT'):
                r.origin_guard(marker, failed)

    def test_actual_saved_origin_is_supported(self):
        evidence = HERE.parents[1] / 'review/production-instance-20261010/apply-v1-independent.json'
        if not evidence.exists():
            self.skipTest('historical ignored server evidence is not part of the test package')
        value = json.loads(evidence.read_text())
        r.origin_guard(value['installation.json'], value['receipt.json'])

    def test_history_bound_helpers_and_manifest_without_live_old_release(self):
        manifest = {'member-' + str(i): '0' * 64 for i in range(1153)}
        manifest.update({'platform/deploy/production-instance/' + k: v for k, v in r.OLD_HELPERS.items()})
        def read(path, sha=None):
            path = Path(path)
            if path.name == 'retired-source.json':
                return p.canonical(history()), {'sha256': 'a' * 64}
            if path.name == 'RELEASE-MANIFEST.json':
                return p.canonical(manifest), {'sha256': r.OLD_MANIFEST}
            return b'original', {'sha256': sha}
        meta = {'kind': 'directory', 'uid': 0, 'gid': 0, 'mode': 0o700}
        with patch.object(r, 'read_bound', side_effect=read) as bound, patch.object(p, 'fingerprint', return_value=meta), patch.object(p, 'no_mount'):
            value = r.retired_source_guard(r.RETIRED_SOURCE, r.RETIRED_SHA)
        self.assertEqual(value['receipt']['members'], 1158)
        self.assertTrue(all(not str(call.args[0]).startswith(r.OLD_RELEASE) for call in bound.call_args_list))
        self.assertTrue(any('/helpers/provision.py' in str(call.args[0]) for call in bound.call_args_list))

    def test_retired_proof_rejects_false_provenance_fields(self):
        for key, bad in [('retired', False), ('activated', True), ('members', 1157),
                         ('archive_sha256', 'a' * 64), ('dependencies_match', '/opt/oasis/current'),
                         ('protected_inventory_sha256', 'a' * 64), ('runtime_dependencies', {})]:
            value = history()
            value[key] = bad
            with self.subTest(key=key), patch.object(r, 'read_bound', return_value=(p.canonical(value), {})), self.assertRaisesRegex(p.Refusal, 'SOURCE_PROOF'):
                r.retired_source_guard(r.RETIRED_SOURCE, r.RETIRED_SHA)

    def test_unexpected_history_path_rejected_before_read(self):
        with patch.object(r, 'read_bound') as read, self.assertRaisesRegex(p.Refusal, 'HISTORY_PATH'):
            r.retired_source_guard('/tmp/retired-source.json', 'a' * 64)
        read.assert_not_called()

    def test_actual_retirement_receipt_preservation_contract(self):
        evidence = HERE.parents[1] / 'review/production-instance-20261010/retired-source-v1.json'
        if not evidence.exists():
            self.skipTest('historical ignored server evidence is not part of the test package')
        raw = evidence.read_bytes()
        self.assertEqual(p.digest(raw), r.RETIRED_SHA)
        value = json.loads(raw)
        manifest = {'member-' + str(i): '0' * 64 for i in range(1153)}
        manifest.update({'platform/deploy/production-instance/' + k: v for k, v in r.OLD_HELPERS.items()})
        root = r.RETIRED_SOURCE.parent
        def read(path, sha=None):
            path = Path(path)
            if path == r.RETIRED_SOURCE:
                return raw, {'sha256': r.RETIRED_SHA}
            pin = value['preservation'][str(path.relative_to(root))]
            return p.canonical(manifest) if path.name == 'RELEASE-MANIFEST.json' else b'old source', pin
        meta = {'kind': 'directory', 'uid': 0, 'gid': 0, 'mode': 0o700}
        with patch.object(r, 'read_bound', side_effect=read), patch.object(p, 'fingerprint', return_value=meta), patch.object(p, 'no_mount'):
            result = r.retired_source_guard(r.RETIRED_SOURCE, r.RETIRED_SHA)
        self.assertEqual(result['receipt'], value)

    def test_empty_volume_actual_inode_and_content_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            volume = Path(temp).resolve() / 'volume'
            volume.mkdir()
            marker = {'volume_identity': {'Mountpoint': str(volume)}}
            meta = p.fingerprint(volume)
            with patch.object(r, 'VOLUME_PATH', volume), patch.object(r, 'VOLUME_META', meta), patch.object(p, 'no_mount'):
                self.assertEqual(r.empty_volume_guard(marker), meta)
                (volume / 'PG_VERSION').write_text('16')
                with self.assertRaisesRegex(p.Refusal, 'NOT_ORIGINAL_EMPTY'):
                    r.empty_volume_guard(marker)
                (volume / 'PG_VERSION').unlink()
                volume.rmdir()
                volume.mkdir()
                with self.assertRaisesRegex(p.Refusal, 'NOT_ORIGINAL_EMPTY'):
                    r.empty_volume_guard(marker)

    def test_empty_volume_symlink_and_mounted_directory_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            volume = Path(temp).resolve() / 'volume'
            volume.mkdir()
            marker = {'volume_identity': {'Mountpoint': str(volume)}}
            with patch.object(r, 'VOLUME_PATH', volume), patch.object(r, 'VOLUME_META', p.fingerprint(volume)), patch.object(p, 'no_mount', side_effect=p.Refusal('OWNED_PATH_MOUNTED')):
                with self.assertRaisesRegex(p.Refusal, 'MOUNTED'):
                    r.empty_volume_guard(marker)
            volume.rmdir()
            volume.symlink_to(Path(temp))
            with patch.object(r, 'VOLUME_PATH', volume), patch.object(p, 'no_mount'), self.assertRaisesRegex(p.Refusal, 'SYMLINK'):
                r.empty_volume_guard(marker)


class PrivateFiles(unittest.TestCase):
    def test_single_private_inode_read_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'data'
            file.write_bytes(b'private metadata only')
            file.chmod(0o600)
            real = p.fingerprint
            def root_meta(path):
                return {**real(path), 'uid': 0, 'gid': 0}
            with patch.object(p, 'fingerprint', side_effect=root_meta):
                self.assertEqual(r.read_bound(file)[0], file.read_bytes())
                file.unlink()
                file.symlink_to(Path(temp) / 'missing')
                with self.assertRaisesRegex(p.Refusal, 'SYMLINK'):
                    r.read_bound(file)

    def test_same_bytes_replaced_inode_rejected_before_read(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'data'
            file.write_bytes(b'same')
            file.chmod(0o600)
            old = {**p.fingerprint(file), 'uid': 0, 'gid': 0}
            file.unlink()
            file.write_bytes(b'same')
            file.chmod(0o600)
            with patch.object(p, 'fingerprint', return_value=old), self.assertRaisesRegex(p.Refusal, 'INODE'):
                r.read_bound(file)

    def test_external_hash_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'data'
            file.write_bytes(b'safe')
            file.chmod(0o600)
            pin = {**p.fingerprint(file), 'uid': 0, 'gid': 0}
            with patch.object(p, 'fingerprint', return_value=pin), self.assertRaisesRegex(p.Refusal, 'HASH_CHANGED'):
                r.read_bound(file, 'a' * 64)

    def test_sql_password_is_data_and_only_valid_original_url_allowed(self):
        password = 'P' * 64
        env = {'OASIS_DATABASE_URL': 'postgres://oasis_prod_app:' + password + '@127.0.0.1:18893/oasis_production'}
        self.assertIn("PASSWORD '" + password + "'", r.role_sql(env))
        for bad in [env['OASIS_DATABASE_URL'].replace('127.0.0.1', 'public.example'),
                    env['OASIS_DATABASE_URL'] + '?x=1', env['OASIS_DATABASE_URL'].replace(password, "x'%3Bdrop")]:
            with self.assertRaisesRegex(p.Refusal, 'DATABASE_CONFIG'):
                r.role_sql({'OASIS_DATABASE_URL': bad})

    def test_env_not_shell_and_duplicate_invalid(self):
        self.assertEqual(r.parse_private_env(b'OASIS_X=$(touch absent)\n'), {'OASIS_X': '$(touch absent)'})
        for body in (b'OASIS_X=1\nOASIS_X=2\n', b'OASIS_X=\x00\n', b'export OASIS_X=1\n'):
            with self.assertRaisesRegex(p.Refusal, 'ENV_FORMAT'):
                r.parse_private_env(body)

    def test_monitor_permission_fix_preserves_original_fd(self):
        with tempfile.TemporaryDirectory() as temp:
            private = Path(temp)
            directory = private / 'monitor'
            directory.mkdir(mode=0o700)
            directory.chmod(0o700)
            before = p.fingerprint(directory)
            tool = instance()
            # uid/gid are explicit synthetic actual-shape values; temp inode is real.
            before.update(uid=0, gid=999)
            tool.capsule = {'original': {'directories': {'monitor': before}}}
            tool.event = Mock()
            real_fstat = os.fstat
            def fstat(fd):
                s = real_fstat(fd)
                return types.SimpleNamespace(st_mode=s.st_mode, st_dev=s.st_dev, st_ino=s.st_ino, st_uid=0, st_gid=999)
            real_pin = p.fingerprint
            def pin(path):
                return {**real_pin(path), 'uid': 0, 'gid': 999}
            with patch.object(p, 'PRIVATE', private), patch.object(p, 'no_mount'), patch.object(p, 'fingerprint', side_effect=pin), patch.object(r.os, 'fstat', side_effect=fstat):
                tool.repair_monitor_directory()
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o750)
            self.assertEqual(tool.receipt['monitor_directory_repair']['before']['inode'], tool.receipt['monitor_directory_repair']['after']['inode'])

    def test_monitor_nonempty_or_replaced_directory_refused_without_chmod(self):
        with tempfile.TemporaryDirectory() as temp:
            private = Path(temp)
            directory = private / 'monitor'
            directory.mkdir(mode=0o700)
            tool = instance()
            tool.capsule = {'original': {'directories': {'monitor': p.fingerprint(directory)}}}
            (directory / 'unknown').write_text('foreign')
            with patch.object(p, 'PRIVATE', private), patch.object(p, 'no_mount'), patch.object(os, 'fchmod') as chmod, self.assertRaisesRegex(p.Refusal, 'MONITOR_DIRECTORY_CHANGED'):
                tool.repair_monitor_directory()
            chmod.assert_not_called()


class Sequencing(unittest.TestCase):
    def test_start_once_assigned_network_before_private_role_then_bootstrap(self):
        tool = instance()
        calls = []
        tool.fresh = lambda **kw: calls.append(('fresh', kw))
        tool.event = lambda *args, **kw: calls.append(('event', args))
        tool.runtime.command = lambda argv, **kw: calls.append(('command', argv, kw)) or ''
        secret = 'Q' * 64
        env = f'OASIS_DATABASE_URL=postgres://oasis_prod_app:{secret}@127.0.0.1:18893/oasis_production\n'.encode()
        bootstrap = {'passed': True, 'admission_enabled': False, 'players_created': 0, 'coins_funded': '0'}
        with tempfile.TemporaryDirectory() as temp:
            private = Path(temp)
            (private / 'bootstrap.json').write_text(json.dumps(bootstrap))
            with patch.object(p, 'PRIVATE', private), patch.object(p, 'PIN', private / 'pin'), patch.object(r, 'read_bound', return_value=(env, {})):
                tool.start_and_bootstrap()
        direct_start = [c for c in calls if c[0] == 'command' and c[1][:2] == ['docker', 'start']]
        self.assertEqual(len(direct_start), 1)
        sql_index = next(i for i, c in enumerate(calls) if c[0] == 'command' and 'psql' in c[1])
        self.assertEqual(calls[sql_index - 1], ('fresh', {}))
        sql = calls[sql_index]
        self.assertNotIn(secret, str(sql[1]))
        self.assertIn(secret, sql[2]['input'])
        self.assertTrue(tool.receipt['bootstrap']['passed'])

    def test_network_failure_after_start_prevents_role_pin_bootstrap(self):
        tool = instance()
        tool.fresh = Mock(side_effect=[None, p.Refusal('PRODUCTION_RESOURCE_SCOPE_CHANGED')])
        with self.assertRaisesRegex(p.Refusal, 'RESOURCE_SCOPE'):
            tool.start_and_bootstrap()
        self.assertEqual(len(tool.runtime.command.call_args_list), 2)
        self.assertFalse(any('psql' in c.args[0] or '/usr/bin/node' in c.args[0] for c in tool.runtime.command.call_args_list))

    def test_pg_readiness_wait_does_not_retry_start(self):
        tool = instance()
        tool.fresh = Mock()
        def command(argv, **kw):
            if 'pg_isready' in argv:
                raise p.Refusal('COMMAND_FAILED_DOCKER')
        tool.runtime.command.side_effect = command
        with patch.object(r.time, 'sleep'), self.assertRaisesRegex(p.Refusal, 'DATABASE_NOT_READY'):
            tool.start_and_bootstrap()
        calls = tool.runtime.command.call_args_list
        self.assertEqual(sum(c.args[0][:2] == ['docker', 'start'] for c in calls), 1)
        self.assertEqual(sum('pg_isready' in c.args[0] for c in calls), 30)

    def test_backup_default_strict_guard_and_drill_cleanup_before_units(self):
        tool = instance()
        order = []
        tool.fresh = lambda **kw: order.append('fresh')
        tool.event = lambda phase, **kw: order.append(phase)
        tool.install_units = lambda: order.append('units')
        backup = {'path': '/opt/oasis/production-backups/20261010T000000Z'}
        ops = types.SimpleNamespace(operations_lock=lambda: nullcontext(),
                                    backup=Mock(return_value=backup),
                                    restore=Mock(return_value={'passed': True, 'cleanup': {'database_removed': True, 'temporary_removed': True}}))
        tool.load_operations = lambda: ops
        tool.finish_closed()
        self.assertLess(order.index('restore_proved'), order.index('units'))
        self.assertEqual(ops.backup.call_args.args, (tool.marker, tool.runtime))
        self.assertEqual(ops.backup.call_args.kwargs, {})
        self.assertTrue(tool.receipt['passed'])
        self.assertFalse(tool.receipt['admission_enabled'])

    def test_failed_restore_never_installs_or_enables_units(self):
        tool = instance()
        tool.fresh = Mock()
        tool.event = Mock()
        tool.install_units = Mock()
        ops = types.SimpleNamespace(operations_lock=lambda: nullcontext(),
                                   backup=lambda *a: {'path': '/opt/oasis/production-backups/20261010T000000Z'},
                                   restore=lambda *a: {'passed': True, 'cleanup': {'database_removed': False, 'temporary_removed': True}})
        tool.load_operations = lambda: ops
        with self.assertRaisesRegex(p.Refusal, 'RESTORE_DRILL_FAILED'):
            tool.finish_closed()
        tool.install_units.assert_not_called()
        tool.runtime.command.assert_not_called()

    def test_old_failure_original_bytes_remain_and_new_history_is_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'recovery'
            directory.mkdir(mode=0o700)
            original_file = Path(temp) / 'receipt.json'
            original_file.write_bytes(b'original failed receipt')
            tool = instance()
            tool.receipt_pin = None
            with patch.object(r, 'RECOVERY', directory), patch.object(p.os, 'fchown'):
                tool.event('recovery_test')
                tool.event('failed_closed')
            self.assertEqual(original_file.read_bytes(), b'original failed receipt')
            self.assertEqual([x['phase'] for x in json.loads((directory / 'receipt.json').read_text())['history']], ['recovery_test', 'failed_closed'])

    def test_fresh_time_and_external_check_hash_closed(self):
        clock = dt.datetime.now(dt.timezone.utc)
        with self.assertRaisesRegex(p.Refusal, 'NOT_FRESH'):
            p.fresh_time((clock - dt.timedelta(seconds=601)).isoformat(), now=clock)
        tool = instance()
        tool.args.check = '/unused'
        with patch.object(r, 'read_bound', side_effect=p.Refusal('RECOVERY_EVIDENCE_HASH_CHANGED')), self.assertRaisesRegex(p.Refusal, 'HASH_CHANGED'):
            tool.apply()
        tool.runtime.command.assert_not_called()

    def test_shared_lock_same_path_replacement_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'lock'
            path.write_bytes(b'')
            before = p.fingerprint(path)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                path.unlink()
                path.write_bytes(b'')
                with self.assertRaisesRegex(p.Refusal, 'LOCK_REPLACED'):
                    p.lock_descriptor_guard(fd, path, before)
            finally:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
