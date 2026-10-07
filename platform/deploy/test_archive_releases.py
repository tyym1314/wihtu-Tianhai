import importlib.util
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('archive_releases', Path(__file__).with_name('archive-releases.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NAME = module.ALLOW[0]
ASSET = 'platform/arena/dist/assets/RunGame-abcdefgh.js'


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        if not hasattr(os, 'listxattr'):
            portability = patch.object(os, 'listxattr', return_value=[], create=True)
            portability.start()
            self.addCleanup(portability.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve() / 'oasis'
        self.releases = self.base / 'releases'
        self.releases.mkdir(parents=True)
        self.proc = Path(self.temp.name).resolve() / 'proc'
        self.proc.mkdir()
        (self.base / 'private').mkdir()
        (self.base / 'private/release.lock').write_text('existing deployment lock; never read or write')
        for name in (NAME, '20261007-01', '20261007-02', '20261007-03', '20261007-04'):
            root = self.releases / name
            (root / Path(ASSET).parent).mkdir(parents=True)
            (root / ASSET).write_bytes(b'window.fixture = true;\n' * 10000)
            (root / 'node_modules/tool').mkdir(parents=True)
            (root / 'node_modules/.bin').mkdir()
            (root / 'node_modules/tool/cli.js').write_text('fixture executable\n')
            (root / 'node_modules/tool/cli.js').chmod(0o751)
            (root / 'node_modules/.bin/tool').symlink_to('../tool/cli.js')
            (root / 'RELEASE-MANIFEST.json').write_text(json.dumps({ASSET: module.digest(root / ASSET)}))
        (self.base / 'current').symlink_to(self.releases / '20261007-04')
        (self.base / 'android-mock-current').symlink_to(self.releases / '20261007-04')
        (self.base / 'private/last-release.json').write_text(json.dumps({'current': str(self.releases / '20261007-04'), 'previous': str(self.releases / '20261007-03')}))
        self.task = module.Archiver(self.base, self.proc, reserve=0)
        self.source, self.work, self.final = self.task.paths(NAME)

    def test_check_is_read_only_and_reports_all_space_and_protections(self):
        lock_hash = module.digest(self.base / 'private/release.lock')
        report, before = self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())
        self.assertEqual(report['external_dependencies'], [])
        self.assertEqual(report['static_fingerprints_verified'], 1)
        self.assertEqual(report['protection']['protected'], ['20261007-01', '20261007-02', '20261007-03', '20261007-04'])
        self.assertGreater(report['temporary_required_bytes'], before['allocated_bytes'])
        self.assertEqual(module.digest(self.base / 'private/release.lock'), lock_hash)

    def test_exact_allowlist_pins_recent_and_process_references_are_protected(self):
        with self.assertRaisesRegex(ValueError, 'ALLOWLISTED'):
            self.task.check('20260922-04')
        (self.base / 'android-mock-current').unlink()
        (self.base / 'android-mock-current').symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, 'PROTECTED'):
            self.task.check(NAME)
        (self.base / 'android-mock-current').unlink()
        (self.base / 'android-mock-current').symlink_to(self.releases / '20261007-04')
        process = self.proc / '123'
        process.mkdir()
        (process / 'fd').mkdir()
        (process / 'maps').write_text('')
        (process / 'cmdline').write_bytes(('node\0' + str(self.source / 'server.mjs')).encode())
        with self.assertRaisesRegex(ValueError, 'PROTECTED'):
            self.task.check(NAME)

    def test_real_compression_extraction_restore_and_no_overwrite(self):
        before = module.snapshot(self.source)
        result = self.task.archive(NAME)
        self.assertEqual(result['status'], 'archived')
        self.assertFalse(self.source.exists())
        self.assertFalse(self.work.exists())
        self.assertLess(result['archive_bytes'], before['allocated_bytes'])
        self.assertEqual(self.task.recover(NAME)['status'], 'already_archived')
        self.assertEqual(self.task.recover(NAME, restore=True)['status'], 'restored')
        self.assertEqual(module.content(module.snapshot(self.source)), module.content(before))
        self.assertEqual(os.readlink(self.source / 'node_modules/.bin/tool'), '../tool/cli.js')
        with self.assertRaisesRegex(ValueError, 'OVERWRITE'):
            self.task.recover(NAME, restore=True)
        with self.assertRaisesRegex(ValueError, 'EXISTING_ARCHIVE'):
            self.task.archive(NAME)

    def test_same_deployment_lock_blocks_archive_and_is_never_modified(self):
        path = self.base / 'private/release.lock'
        before = path.read_bytes()
        with path.open('rb') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.task.archive(NAME)
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.task.archives.exists())

    def test_source_mutation_during_archive_keeps_original_and_cleans_only_work(self):
        unpack = self.task.unpack
        def change(*args):
            result = unpack(*args)
            (self.source / 'changed-after-snapshot.txt').write_text('must remain')
            return result
        with patch.object(self.task, 'unpack', side_effect=change):
            with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED'):
                self.task.archive(NAME)
        self.assertTrue((self.source / 'changed-after-snapshot.txt').is_file())
        self.assertFalse(self.work.exists())
        self.assertFalse(self.final.exists())

    def test_asset_coverage_is_checked_again_after_compression(self):
        unpack = self.task.unpack
        def change(*args):
            result = unpack(*args)
            (self.releases / '20261007-04' / ASSET).write_text('changed current bytes')
            return result
        with patch.object(self.task, 'unpack', side_effect=change):
            with self.assertRaisesRegex(ValueError, 'CURRENT_STATIC_ASSET_HASH'):
                self.task.archive(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())

    def test_new_pin_during_compression_aborts_without_removing_source(self):
        unpack = self.task.unpack
        def pin(*args):
            result = unpack(*args)
            (self.base / 'android-mock-current').unlink()
            (self.base / 'android-mock-current').symlink_to(self.source)
            return result
        with patch.object(self.task, 'unpack', side_effect=pin):
            with self.assertRaisesRegex(ValueError, 'PROTECTED'):
                self.task.archive(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())

    def test_external_symlink_and_manifest_tampering_fail_closed(self):
        link = self.source / 'node_modules/.bin/tool'
        link.unlink()
        link.symlink_to('../../../../private/release.lock')
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.task.check(NAME)
        link.unlink()
        link.symlink_to('../tool/cli.js')
        (self.source / ASSET).write_text('source no longer matches manifest')
        with self.assertRaisesRegex(ValueError, 'MANIFEST_MISMATCH'):
            self.task.check(NAME)

    def test_insufficient_space_is_refused_without_output(self):
        with patch.object(module, 'available_bytes', return_value=1):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_TEMPORARY_SPACE'):
                self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())

    def test_interrupted_preparation_recovers_without_touching_source(self):
        self.work.mkdir(parents=True, mode=0o700)
        self.task.archives.chmod(0o700)
        module.write_json(self.work / 'identity.json', {'format': 1, 'release': NAME})
        (self.work / 'incomplete.tar.gz').write_bytes(b'partial')
        before = module.snapshot(self.source)
        self.assertEqual(self.task.recover(NAME)['status'], 'preparation_rolled_back')
        self.assertEqual(module.snapshot(self.source), before)
        self.assertFalse(self.work.exists())

    def test_interrupted_partial_quarantine_deletion_restores_full_archive(self):
        before = module.snapshot(self.source)
        self.task.archive(NAME)
        (self.final / 'original').mkdir()
        (self.final / 'original/remaining.txt').write_text('partial quarantine after interruption')
        self.assertEqual(self.task.recover(NAME)['status'], 'restored')
        self.assertEqual(module.content(module.snapshot(self.source)), module.content(before))
        self.assertFalse((self.final / 'original').exists())

    def test_corrupt_archive_is_not_restored_or_deleted(self):
        self.task.archive(NAME)
        archive = self.final / 'release.tar.gz'
        archive.write_bytes(archive.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_HASH_MISMATCH'):
            self.task.recover(NAME, restore=True)
        self.assertTrue(archive.exists())
        self.assertFalse(self.source.exists())

    def test_unlisted_fingerprinted_asset_and_extended_attributes_are_rejected(self):
        retained = self.source / 'platform/arena/dist/assets/OldGame-01234567.js'
        retained.write_text('old cached clients can still request this')
        with self.assertRaisesRegex(ValueError, 'CURRENT_STATIC_ASSET_MISSING'):
            self.task.check(NAME)
        retained.unlink()
        with patch.object(os, 'listxattr', return_value=['system.posix_acl_access']):
            with self.assertRaisesRegex(ValueError, 'EXTENDED_ATTRIBUTES'):
                self.task.check(NAME)

    def test_interruption_after_quarantine_rename_rolls_back_source(self):
        before = module.snapshot(self.source)
        sync = module.sync_dir
        def fail_after_rename(path):
            if path == self.work and (self.work / 'original').exists():
                raise KeyboardInterrupt()
            return sync(path)
        with patch.object(module, 'sync_dir', side_effect=fail_after_rename):
            with self.assertRaises(KeyboardInterrupt):
                self.task.archive(NAME)
        self.assertEqual(module.content(module.snapshot(self.source)), module.content(before))
        self.assertFalse(self.work.exists())

    def test_restore_interruption_after_source_rename_resumes_cleanup(self):
        before = module.snapshot(self.source)
        self.task.archive(NAME)
        sync = module.sync_dir
        def fail_after_rename(path):
            if path == self.releases and self.source.exists():
                raise KeyboardInterrupt()
            return sync(path)
        with patch.object(module, 'sync_dir', side_effect=fail_after_rename):
            with self.assertRaises(KeyboardInterrupt):
                self.task.recover(NAME, restore=True)
        self.assertTrue((self.final / 'restore-in-progress.json').is_file())
        self.assertEqual(self.task.recover(NAME)['status'], 'restore_cleanup_completed')
        self.assertEqual(module.content(module.snapshot(self.source)), module.content(before))
        self.assertFalse((self.final / 'restore-in-progress.json').exists())
        self.assertFalse((self.final / 'recovery').exists())

    def test_changed_restored_source_does_not_trigger_cleanup(self):
        self.task.archive(NAME)
        self.task.recover(NAME, restore=True)
        module.write_json(self.final / 'restore-in-progress.json', {'format': 1, 'release': NAME})
        (self.source / 'user-change.txt').write_text('keep me')
        with self.assertRaisesRegex(ValueError, 'RESTORED_SOURCE_CHANGED'):
            self.task.recover(NAME)
        self.assertTrue((self.source / 'user-change.txt').exists())
        self.assertTrue((self.final / 'release.tar.gz').exists())

    def test_tar_traversal_with_updated_archive_hash_is_still_refused(self):
        self.task.archive(NAME)
        archive_path = self.final / 'release.tar.gz'
        with tarfile.open(archive_path, 'w:gz') as archive:
            archive.addfile(tarfile.TarInfo('../../escape'))
        receipt_path = self.final / 'receipt.json'
        receipt = json.loads(receipt_path.read_text())
        receipt['archive_sha256'] = module.digest(archive_path)
        receipt_path.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_ENTRY_SET_MISMATCH'):
            self.task.recover(NAME, restore=True)
        self.assertFalse((self.base / 'escape').exists())
        self.assertFalse(self.source.exists())
        self.assertTrue(archive_path.exists())

    def test_archive_identity_symlink_cannot_authorize_cleanup(self):
        self.work.mkdir(parents=True, mode=0o700)
        self.task.archives.chmod(0o700)
        identity = self.base / 'other.json'
        module.write_json(identity, {'format': 1, 'release': NAME})
        (self.work / 'identity.json').symlink_to(identity)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_ARCHIVE_FILE'):
            self.task.recover(NAME)
        self.assertTrue(self.work.exists())
        self.assertTrue(self.source.exists())

    def test_open_descriptors_and_mapped_files_protect_releases(self):
        process = self.proc / '999'
        (process / 'fd').mkdir(parents=True)
        (process / 'cmdline').write_text('unrelated-process')
        (process / 'maps').write_text('1000-2000 r-xp 00000000 00:00 1 ' + str(self.source / 'native.node'))
        with self.assertRaisesRegex(ValueError, 'RELEASE_IS_PROTECTED'):
            self.task.check(NAME)
        (process / 'maps').write_text('')
        (process / 'fd/4').symlink_to(self.source / ASSET)
        with self.assertRaisesRegex(ValueError, 'RELEASE_IS_PROTECTED'):
            self.task.check(NAME)
        (process / 'fd/4').unlink()
        (process / 'maps').unlink()
        with self.assertRaisesRegex(ValueError, 'PROCESS_STATE_UNREADABLE'):
            self.task.check(NAME)


if __name__ == '__main__':
    unittest.main()
