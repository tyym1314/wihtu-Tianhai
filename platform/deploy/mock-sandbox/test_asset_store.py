"""Relocated local store transactions: no /opt writes or service operations."""
import fcntl
import io
import os
from pathlib import Path
import stat
import types
import unittest
from unittest.mock import patch


def load(name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


HERE = Path(__file__).resolve().parent
store = load('asset_store_under_test', HERE / 'asset_store.py')
fixtures = load('asset_store_bundle_fixture', HERE / 'test_asset_bundle.py')


class Interrupted(Exception):
    pass


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.BundleTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        patch.object(store, 'bundle', fixtures.bundle).start()
        patch.object(store.routes, 'bundle', fixtures.bundle).start()
        self.fixture.compile()
        self.root = self.fixture.root
        self.source = self.root / 'output/bundle.tar'
        self.parent = self.root / 'retained-assets'
        self.subject = store.Store(self.parent, owner=os.geteuid())
        self.addCleanup(self.writable_cleanup)

    def writable_cleanup(self):
        # TemporaryDirectory cannot remove a correctly sealed tree as a non-root user.
        if self.parent.is_dir() and not self.parent.is_symlink():
            for root, dirs, _files in os.walk(self.parent):
                os.chmod(root, 0o755)

    def snapshot(self):
        return {str(path.relative_to(self.root)): (stat.S_IMODE(path.lstat().st_mode),
                path.lstat().st_mtime_ns, path.read_bytes() if path.is_file() else None)
                for path in self.root.rglob('*')}

    def interrupt_at(self, event):
        def fail(name):
            if name == event:
                raise Interrupted(event)
        with patch.object(self.subject, 'checkpoint', side_effect=fail), self.assertRaises(Interrupted):
            self.subject.install(self.source)

    def test_install_exact_layout_modes_stable_validators_and_four_conflicts(self):
        result = self.subject.install(self.source)
        self.assertEqual(result, self.subject.check(self.source))
        self.assertTrue(result['store_installed'])
        self.assertTrue(result['relocated_fixture'])
        self.assertFalse(result['production_store_installed'])
        self.assertEqual(result['installation_path'], str(self.subject.final))
        for key in ('activation_performed', 'upgrade_allowed', 'apply_allowed', 'http_verified'):
            self.assertFalse(result[key])
        self.assertEqual(result['nginx_state'], 'not-inspected')
        self.assertEqual(len(result['unresolved_conflicts']), 4)
        self.assertTrue(all(item['resolution'] == 'blocked-pending-explicit-review'
                            and item['overlay_included'] is False for item in result['unresolved_conflicts']))
        expected = store.expected_artifacts(self.source)
        files = {str(path.relative_to(self.subject.final)): path.read_bytes()
                 for path in self.subject.final.rglob('*') if path.is_file()}
        self.assertEqual(files, expected['bodies'])
        for path in self.subject.final.rglob('*'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o555 if path.is_dir() else 0o444)
            if path.is_file():
                self.assertEqual(path.stat().st_mtime_ns, store.MTIME_NS)
                self.assertEqual(path.stat().st_nlink, 1)
        self.assertEqual(self.subject.final.stat().st_mode & 0o777, 0o755)
        self.assertFalse((self.subject.final / 'BUNDLE-PLAN.json').exists())
        self.assertFalse((self.subject.final / 'source').exists())

    def test_checks_are_read_only_even_for_incomplete_install(self):
        self.interrupt_at('asset-durable')
        before = self.snapshot()
        with patch.object(Path, 'mkdir', side_effect=AssertionError('write forbidden')), \
             patch.object(os, 'rename', side_effect=AssertionError('write forbidden')), \
             patch.object(Path, 'unlink', side_effect=AssertionError('write forbidden')):
            with self.assertRaisesRegex(ValueError, 'STORE_INSTALL_INCOMPLETE'):
                self.subject.check(self.source)
        self.assertEqual(before, self.snapshot())
        self.subject.recover(self.source)
        before = self.snapshot()
        self.subject.check(self.source)
        self.assertEqual(before, self.snapshot())

    def test_absent_check_and_recover_do_not_create_store(self):
        for mode in ('check', 'recover'):
            with self.subTest(mode=mode), self.assertRaises(FileNotFoundError):
                getattr(self.subject, mode)(self.source)
            self.assertFalse(self.parent.exists())

    def test_recovery_at_every_persistent_boundary(self):
        for number, event in enumerate((store.INTENT + '-written', 'intent-durable', 'stage-created',
                                        'asset-opened', 'asset-written', 'asset-durable',
                                        'directory-sealed', 'stage-sealed', 'store-published',
                                        store.RECEIPT + '-written')):
            with self.subTest(event=event):
                self.subject = store.Store(self.parent / ('fixture-' + str(number)), owner=os.geteuid())
                if not self.parent.exists():
                    self.parent.mkdir(mode=0o755)
                self.interrupt_at(event)
                if event not in ('store-published', store.RECEIPT + '-written'):
                    self.assertFalse(self.subject.final.exists(), 'partial store must not be public')
                result = self.subject.recover(self.source)
                self.assertTrue(result['store_installed'])
                self.assertEqual(result, self.subject.check(self.source))

    def test_partial_asset_write_recovers_without_overwriting_committed_assets(self):
        self.interrupt_at('asset-durable')
        expected = store.expected_artifacts(self.source)
        completed = next(self.subject.stage.rglob('*.js'))
        before = (completed.stat().st_ino, completed.stat().st_mtime_ns, completed.read_bytes())
        partial = self.parent / store.PARTIAL
        partial.write_bytes(b'partial verified input body')
        partial.chmod(0o600)
        self.subject.recover(self.source)
        after = self.subject.final / completed.relative_to(self.subject.stage)
        self.assertEqual(before, (after.stat().st_ino, after.stat().st_mtime_ns, after.read_bytes()))
        self.assertFalse(partial.exists())
        self.assertEqual(len(expected['bodies']), len(list(self.subject.final.rglob('*.js'))) +
                         len(list(self.subject.final.rglob('*.css'))))

    def test_corrupted_published_body_refused_without_repair(self):
        self.subject.install(self.source)
        path = next(self.subject.final.rglob('*.js'))
        path.chmod(0o644)
        path.write_bytes(b'corrupt')
        path.chmod(0o444)
        os.utime(path, ns=(store.MTIME_NS, store.MTIME_NS))
        before = self.snapshot()
        for method in ('check', 'recover'):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, 'STORE_FILE_METADATA|STORE_BODY_MISMATCH'):
                getattr(self.subject, method)(self.source)
        self.assertEqual(before, self.snapshot())

    def test_same_size_corruption_refused(self):
        self.subject.install(self.source)
        path = next(self.subject.final.rglob('*.js'))
        old = path.read_bytes()
        path.chmod(0o644)
        path.write_bytes(bytes([old[0] ^ 1]) + old[1:])
        path.chmod(0o444)
        os.utime(path, ns=(store.MTIME_NS, store.MTIME_NS))
        with self.assertRaisesRegex(ValueError, 'STORE_BODY_MISMATCH'):
            self.subject.recover(self.source)

    def test_mtime_or_writable_asset_refused(self):
        self.subject.install(self.source)
        path = next(self.subject.final.rglob('*.js'))
        os.utime(path, ns=(store.MTIME_NS, store.MTIME_NS + 1000000000))
        with self.assertRaisesRegex(ValueError, 'STORE_FILE_METADATA'):
            self.subject.check(self.source)
        os.utime(path, ns=(store.MTIME_NS, store.MTIME_NS))
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_FILE'):
            self.subject.check(self.source)

    def test_source_bundle_corruption_refused_before_parent_creation(self):
        self.source.write_bytes(self.source.read_bytes() + b'extra')
        with self.assertRaises(ValueError):
            self.subject.install(self.source)
        self.assertFalse(self.parent.exists())

    def test_changed_external_plan_and_receipt_are_not_trusted(self):
        (self.source.parent / 'plan.json').write_bytes(b'{"evil":"/api/"}')
        (self.source.parent / 'receipt.json').write_bytes(b'not trusted')
        self.assertTrue(self.subject.install(self.source)['store_installed'])

    def test_existing_unclaimed_store_never_adopted_or_overwritten(self):
        self.parent.mkdir(mode=0o755)
        self.subject.final.mkdir(mode=0o555)
        before = self.subject.final.stat().st_ino
        with self.assertRaisesRegex(ValueError, 'EXISTING_STORE_REQUIRES_RECOVER'):
            self.subject.install(self.source)
        with self.assertRaisesRegex(ValueError, 'UNCLAIMED_STORE'):
            self.subject.recover(self.source)
        self.assertEqual(before, self.subject.final.stat().st_ino)

    def test_extra_store_file_and_directory_refused(self):
        self.subject.install(self.source)
        self.subject.final.chmod(0o755)
        path = self.subject.final / 'sidecar.gz'
        path.write_bytes(b'not allowed')
        self.subject.final.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'STORE_EXTRA_FILE'):
            self.subject.check(self.source)
        self.subject.final.chmod(0o755)
        path.unlink()
        path.mkdir(mode=0o555)
        self.subject.final.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'STORE_EXTRA_DIRECTORY'):
            self.subject.check(self.source)

    def test_links_and_hardlinks_refused_inside_store(self):
        self.subject.install(self.source)
        path = next(self.subject.final.rglob('*.js'))
        os.link(path, self.root / 'duplicate')
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_FILE'):
            self.subject.check(self.source)
        (self.root / 'duplicate').unlink()
        path.parent.chmod(0o755)
        path.unlink()
        path.symlink_to(self.source)
        path.parent.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_FILE'):
            self.subject.recover(self.source)

    def test_parent_symlink_and_writable_ancestor_refused(self):
        self.parent.symlink_to(self.root / 'missing')
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            self.subject.install(self.source)
        self.parent.unlink()
        self.root.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_ANCESTOR'):
            self.subject.install(self.source)
        self.assertFalse(self.parent.exists())

    def test_private_intent_and_receipt_tampering_refused(self):
        self.subject.install(self.source)
        for name in (store.INTENT, store.RECEIPT):
            path = self.parent / name
            original = path.read_bytes()
            path.write_bytes(original.replace(b'"upgrade_allowed": false', b'"upgrade_allowed": true'))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'STORE_METADATA_MISMATCH'):
                self.subject.recover(self.source)
            path.write_bytes(original)

    def test_corrupt_pending_metadata_is_not_silently_replaced(self):
        self.interrupt_at(store.INTENT + '-written')
        pending = self.parent / (store.INTENT + '.pending')
        pending.write_bytes(b'foreign transaction')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'STORE_PENDING_METADATA_MISMATCH'):
            self.subject.recover(self.source)
        self.assertEqual(before, self.snapshot())

    def test_truncated_pending_metadata_can_resume(self):
        self.interrupt_at(store.INTENT + '-written')
        pending = self.parent / (store.INTENT + '.pending')
        pending.write_bytes(pending.read_bytes()[:13])
        self.assertTrue(self.subject.recover(self.source)['store_installed'])

    def test_concurrent_lock_is_nonblocking_and_makes_no_progress(self):
        self.interrupt_at('intent-durable')
        with (self.parent / store.LOCK).open('rb') as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = self.snapshot()
            with self.assertRaises(BlockingIOError):
                self.subject.recover(self.source)
            self.assertEqual(before, self.snapshot())

    def test_partial_asset_symlink_or_hardlink_refused_before_cleanup(self):
        self.interrupt_at('asset-opened')
        partial = self.parent / store.PARTIAL
        partial.unlink()
        original = self.source.read_bytes()
        partial.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_FILE'):
            self.subject.recover(self.source)
        self.assertTrue(partial.is_symlink())
        self.assertEqual(self.source.read_bytes(), original)
        partial.unlink()
        os.link(self.source, partial)
        with self.assertRaisesRegex(ValueError, 'LOCAL_NOT_REGULAR|UNSAFE_STORE_FILE'):
            self.subject.recover(self.source)
        self.assertTrue(partial.exists())
        self.assertEqual(self.source.read_bytes(), original)

    def test_missing_published_body_is_not_recreated(self):
        self.subject.install(self.source)
        path = next(self.subject.final.rglob('*.js'))
        path.parent.chmod(0o755)
        path.unlink()
        path.parent.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'STORE_MEMBERS_MISSING'):
            self.subject.recover(self.source)
        self.assertFalse(path.exists())

    def test_final_and_stage_ambiguity_refused_without_deletion(self):
        self.subject.install(self.source)
        self.subject.stage.mkdir(mode=0o700)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'AMBIGUOUS_STORE_TREES'):
            self.subject.recover(self.source)
        self.assertEqual(before, self.snapshot())

    def test_staged_corruption_refused_before_partial_cleanup(self):
        self.interrupt_at('asset-durable')
        path = next(self.subject.stage.rglob('*.js'))
        original = path.read_bytes()
        path.chmod(0o644)
        path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        path.chmod(0o444)
        os.utime(path, ns=(store.MTIME_NS, store.MTIME_NS))
        partial = self.parent / store.PARTIAL
        partial.write_bytes(b'pending')
        partial.chmod(0o600)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'STORE_BODY_MISMATCH'):
            self.subject.recover(self.source)
        self.assertEqual(before, self.snapshot())

    def test_wrong_owner_and_insecure_metadata_refused(self):
        self.subject.install(self.source)
        foreign = store.Store(self.parent, owner=os.geteuid() + 1)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_ANCESTOR|UNSAFE_STORE_DIRECTORY'):
            foreign.check(self.source)
        (self.parent / store.INTENT).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORE_FILE'):
            self.subject.recover(self.source)

    def test_recover_installed_tree_is_idempotent_but_install_never_overwrites(self):
        result = self.subject.install(self.source)
        before = self.snapshot()
        self.assertEqual(result, self.subject.recover(self.source))
        self.assertEqual(before, self.snapshot())
        with self.assertRaisesRegex(ValueError, 'EXISTING_STORE_REQUIRES_RECOVER'):
            self.subject.install(self.source)

    def test_cli_fixed_scope_and_sanitized_errors(self):
        for extra in ('--parent', '--store', '--owner', '--activate', '--waive-conflicts'):
            with patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                store.main(['install', '--bundle', str(self.source), extra, '/tmp/evil'])
        out = io.StringIO()
        with patch('sys.stdout', out), patch.object(os, 'geteuid', return_value=501):
            self.assertEqual(store.main(['check', '--bundle', '/private/sensitive.env']), 2)
        self.assertNotIn('sensitive', out.getvalue())
        self.assertFalse(self.parent.exists())


if __name__ == '__main__':
    unittest.main()
