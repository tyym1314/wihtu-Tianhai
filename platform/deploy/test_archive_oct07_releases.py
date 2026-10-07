import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('archive_oct07', Path(__file__).with_name('archive-oct07-releases.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
archive = module.archive
NAME = module.ALLOW[0]
ASSET = 'platform/arena/dist/assets/RunGame-abcdefgh.js'
CURRENT = '20261008-04'
MOCK = '20261007-04'
RECENT = ('20261008-01', '20261008-02', '20261008-03')


class Oct07ArchiveTests(unittest.TestCase):
    def setUp(self):
        if not hasattr(os, 'listxattr'):
            portability = patch.object(os, 'listxattr', return_value=[], create=True)
            portability.start()
            self.addCleanup(portability.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.base = self.root / 'oasis'
        self.releases = self.base / 'releases'
        self.releases.mkdir(parents=True)
        self.proc = self.root / 'proc'
        self.proc.mkdir()
        (self.base / 'private').mkdir()
        (self.base / 'private/release.lock').write_text('existing shared deployment lock')
        for name in (*module.ALLOW, MOCK, *RECENT, CURRENT):
            target = self.releases / name
            (target / Path(ASSET).parent).mkdir(parents=True)
            (target / ASSET).write_bytes(b'window.archive_fixture = true;\n' * 10000)
            (target / 'node_modules/tool').mkdir(parents=True)
            (target / 'node_modules/.bin').mkdir()
            (target / 'node_modules/tool/cli.js').write_text('preserve installed dependency\n')
            (target / 'node_modules/tool/cli.js').chmod(0o751)
            (target / 'node_modules/.bin/tool').symlink_to('../tool/cli.js')
            (target / 'RELEASE-MANIFEST.json').write_text(json.dumps({ASSET: archive.digest(target / ASSET)}))
        (self.base / 'current').symlink_to(self.releases / CURRENT)
        (self.base / 'android-mock-current').symlink_to(self.releases / MOCK)
        self.last = self.base / 'private/last-release.json'
        self.last.write_text(json.dumps({'current': str(self.releases / CURRENT), 'previous': str(self.releases / RECENT[-1])}))
        # Existing nine-release metadata/proofs are outside the new batch, even
        # when they describe permanently retained or Restic-only old releases.
        self.original_archives = self.base / 'release-archives'
        self.original_archives.mkdir(mode=0o700)
        for name in archive.ALLOW:
            folder = self.original_archives / name
            folder.mkdir()
            for filename in ('identity.json', 'receipt.json', 'snapshot.json', 'storage.json'):
                (folder / filename).write_text(json.dumps({'existing_release': name, 'evidence': filename}))
        self.old_proof = self.base / 'release-dedup-pilot'
        self.old_proof.mkdir(mode=0o700)
        (self.old_proof / 'index.json').write_text('existing nine-release index bytes\n')
        (self.old_proof / 'proof.json').write_text('existing nine-release recovery evidence bytes\n')
        self.task = module.Oct07Archiver(self.base, self.proc, reserve=0)
        self.source, self.work, self.final = self.task.paths(NAME)

    def test_exact_scope_and_original_allowlist_are_independent(self):
        original_allow = archive.ALLOW
        self.assertEqual(module.ALLOW, ('20261007-01', '20261007-02', '20261007-03'))
        self.assertTrue(set(module.ALLOW).isdisjoint(original_allow))
        old = archive.Archiver(self.base, self.proc, reserve=0)
        for name in module.ALLOW:
            source, work, final = self.task.paths(name)
            self.assertEqual(source, self.releases / name)
            self.assertEqual(work, self.base / 'release-archives-oct07' / ('.work-' + name))
            self.assertEqual(final, self.base / 'release-archives-oct07' / name)
            with self.assertRaisesRegex(ValueError, 'NOT_ALLOWLISTED'):
                old.paths(name)
        for name in (*original_allow, MOCK, CURRENT, '../20261007-01', '/tmp', '20261007-*'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'NOT_ALLOWLISTED'):
                self.task.paths(name)
        self.assertIs(archive.ALLOW, original_allow)
        self.assertEqual(old.archives, self.original_archives)

    def test_default_and_selected_checks_create_no_files_or_locks(self):
        before = archive.snapshot(self.releases)
        lock = self.base / 'private/release.lock'
        lock_before = (lock.read_bytes(), lock.stat().st_ino)
        for args, count in (([], 3), (['--check-only'], 3), ([NAME, '--check-only'], 1), ([NAME], 1)):
            output = io.StringIO()
            with patch.object(module, 'Oct07Archiver', return_value=self.task), patch.object(os, 'geteuid', return_value=0), patch.object(os, 'umask'), contextlib.redirect_stdout(output):
                module.main(args)
            result = json.loads(output.getvalue())
            self.assertEqual(result['mode'], 'check-only')
            self.assertEqual(len(result['releases']), count)
            self.assertEqual(result['archive_directory'], str(self.task.archives))
            for row in result['releases']:
                self.assertEqual(row['tar_policy'], 'permanently_retained')
                self.assertIn(module.TOOL, row['recover_command'])
                self.assertIn(module.TOOL, row['restore_command'])
        self.assertFalse(self.task.archives.exists())
        self.assertEqual(archive.snapshot(self.releases), before)
        self.assertEqual((lock.read_bytes(), lock.stat().st_ino), lock_before)

    def test_cli_requires_one_exact_release_and_import_does_not_write_bytecode(self):
        for args in (['--archive'], ['--recover'], ['--restore'], [archive.ALLOW[0]], [NAME, '--archive', '--restore']):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                module.parse_args(args)
        for mode in ('--archive', '--recover', '--restore'):
            self.assertEqual(module.parse_args([NAME, mode]).release, NAME)
        tools = self.root / 'tools'
        tools.mkdir()
        for filename in (module.TOOL, 'archive-releases.py'):
            shutil.copy2(Path(__file__).with_name(filename), tools / filename)
        environment = {key: value for key, value in os.environ.items() if key != 'PYTHONDONTWRITEBYTECODE'}
        result = subprocess.run([sys.executable, str(tools / module.TOOL), '--help'],
                                capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((tools / '__pycache__').exists())

    def test_real_archive_restore_preserves_three_trees_and_original_nine_evidence(self):
        old_metadata = archive.snapshot(self.original_archives)
        old_proof = archive.snapshot(self.old_proof)
        lock = self.base / 'private/release.lock'
        lock_bytes = lock.read_bytes()
        for name in module.ALLOW:
            with self.subTest(release=name):
                source, work, final = self.task.paths(name)
                before = archive.snapshot(source)
                result = self.task.archive(name)
                self.assertEqual(result['status'], 'archived')
                self.assertGreater(result['reclaimed_bytes'], 0)
                self.assertFalse(source.exists())
                self.assertFalse(work.exists())
                tar = final / 'release.tar.gz'
                tar_sha = archive.digest(tar)
                self.assertEqual(self.task.recover(name)['status'], 'already_archived')
                self.assertEqual(self.task.recover(name, restore=True)['status'], 'restored')
                self.assertEqual(archive.content(archive.snapshot(source)), archive.content(before))
                self.assertEqual(archive.digest(tar), tar_sha)
                self.assertEqual(os.readlink(source / 'node_modules/.bin/tool'), '../tool/cli.js')
                with self.assertRaisesRegex(ValueError, 'OVERWRITE'):
                    self.task.recover(name, restore=True)
                with self.assertRaisesRegex(ValueError, 'EXISTING_ARCHIVE'):
                    self.task.archive(name)
        self.assertEqual(archive.snapshot(self.original_archives), old_metadata)
        self.assertEqual(archive.snapshot(self.old_proof), old_proof)
        self.assertEqual(lock.read_bytes(), lock_bytes)

    def test_all_pin_previous_recent_and_process_protections_are_inherited(self):
        self.assertEqual(self.task.check(NAME)[0]['protection']['protected'], sorted((MOCK, *RECENT, CURRENT)))
        for pin in ('current', 'android-mock-current'):
            link = self.base / pin
            target = link.resolve()
            link.unlink()
            link.symlink_to(self.source)
            original_last = self.last.read_text()
            if pin == 'current':
                self.last.write_text(json.dumps({'current': str(self.source), 'previous': str(self.releases / RECENT[-1])}))
            with self.subTest(pin=pin), self.assertRaisesRegex(ValueError, 'PROTECTED'):
                self.task.check(NAME)
            link.unlink()
            link.symlink_to(target)
            self.last.write_text(original_last)
        original_last = self.last.read_text()
        self.last.write_text(json.dumps({'current': str(self.releases / CURRENT), 'previous': str(self.source)}))
        with self.assertRaisesRegex(ValueError, 'PROTECTED'):
            self.task.check(NAME)
        self.last.write_text(original_last)
        for field in ('cwd', 'exe', 'cmdline', 'maps', 'fd'):
            process = self.proc / '123'
            process.mkdir()
            (process / 'fd').mkdir()
            (process / 'cmdline').write_bytes(b'node\0')
            (process / 'maps').write_text('')
            if field in ('cwd', 'exe'):
                (process / field).symlink_to(self.source)
            elif field == 'fd':
                (process / 'fd/7').symlink_to(self.source / ASSET)
            else:
                (process / field).write_text(str(self.source / ASSET))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'PROTECTED'):
                self.task.check(NAME)
            shutil.rmtree(process)
        for name in RECENT:
            shutil.rmtree(self.releases / name)
        with self.assertRaisesRegex(ValueError, 'PROTECTED'):
            self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())

    def test_shared_release_lock_and_separate_batch_lock_both_refuse_contention(self):
        for lock in (self.base / 'private/release.lock', self.task.archives / '.lock'):
            if lock.parent == self.task.archives:
                lock.parent.mkdir(mode=0o700)
                lock.write_text('existing oct07 archive lock')
            before = lock.read_bytes()
            with lock.open('rb') as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    self.task.archive(NAME)
            self.assertEqual(lock.read_bytes(), before)
            self.assertTrue(self.source.exists())
            self.assertFalse(self.work.exists())

    def test_mutated_source_or_coverage_or_pin_after_real_unpack_cannot_remove_source(self):
        unpack = self.task.unpack
        def changed_source(*args):
            result = unpack(*args)
            (self.source / 'changed.txt').write_text('keep original evidence')
            return result
        with patch.object(self.task, 'unpack', side_effect=changed_source):
            with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED'):
                self.task.archive(NAME)
        self.assertTrue((self.source / 'changed.txt').is_file())
        self.assertFalse(self.work.exists())
        def changed_coverage(*args):
            result = unpack(*args)
            (self.releases / CURRENT / ASSET).write_text('different current asset')
            return result
        with patch.object(self.task, 'unpack', side_effect=changed_coverage):
            with self.assertRaisesRegex(ValueError, 'CURRENT_STATIC_ASSET_HASH'):
                self.task.archive(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())
        shutil.copy2(self.source / ASSET, self.releases / CURRENT / ASSET)
        def changed_pin(*args):
            result = unpack(*args)
            link = self.base / 'android-mock-current'
            link.unlink()
            link.symlink_to(self.source)
            return result
        with patch.object(self.task, 'unpack', side_effect=changed_pin):
            with self.assertRaisesRegex(ValueError, 'PROTECTED'):
                self.task.archive(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())
        self.assertFalse(self.final.exists())

    def test_failed_real_verification_never_deletes_original(self):
        before = archive.snapshot(self.source)
        unpack = self.task.unpack
        def failure(*args):
            unpack(*args)
            raise ValueError('RESTORED_TREE_MISMATCH')
        with patch.object(self.task, 'unpack', side_effect=failure):
            with self.assertRaisesRegex(ValueError, 'RESTORED_TREE_MISMATCH'):
                self.task.archive(NAME)
        self.assertEqual(archive.snapshot(self.source), before)
        self.assertFalse(self.work.exists())
        self.assertFalse(self.final.exists())

    def test_space_floor_exact_boundary_and_restore_floor(self):
        self.task.reserve = archive.RESERVE
        before = archive.snapshot(self.source)
        bounds = archive.space_bounds(before)
        threshold = bounds['temporary_required_bytes'] + archive.RESERVE
        with patch.object(archive, 'available_bytes', return_value=threshold - 1):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_TEMPORARY_SPACE'):
                self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())
        with patch.object(archive, 'available_bytes', return_value=threshold):
            self.assertEqual(self.task.check(NAME)[0]['minimum_remaining_bytes'], 3 * 1024 ** 3)
            self.task.archive(NAME)
        tar = self.final / 'release.tar.gz'
        tar_sha = archive.digest(tar)
        threshold = bounds['extraction_upper_bytes'] + archive.RESERVE
        with patch.object(archive, 'available_bytes', return_value=threshold - 1):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_RESTORE_SPACE'):
                self.task.recover(NAME, restore=True)
        self.assertFalse(self.source.exists())
        self.assertEqual(archive.digest(tar), tar_sha)
        with patch.object(archive, 'available_bytes', return_value=threshold):
            self.assertEqual(self.task.recover(NAME, restore=True)['status'], 'restored')

    def test_interruption_after_quarantine_rolls_back_and_after_restore_resumes(self):
        before = archive.snapshot(self.source)
        sync = archive.sync_dir
        def after_quarantine(path):
            if path == self.work and (self.work / 'original').exists():
                raise KeyboardInterrupt()
            return sync(path)
        with patch.object(archive, 'sync_dir', side_effect=after_quarantine):
            with self.assertRaises(KeyboardInterrupt):
                self.task.archive(NAME)
        self.assertEqual(archive.content(archive.snapshot(self.source)), archive.content(before))
        self.task.archive(NAME)
        def after_restore(path):
            if path == self.releases and self.source.exists():
                raise KeyboardInterrupt()
            return sync(path)
        with patch.object(archive, 'sync_dir', side_effect=after_restore):
            with self.assertRaises(KeyboardInterrupt):
                self.task.recover(NAME, restore=True)
        self.assertTrue((self.final / 'restore-in-progress.json').exists())
        self.assertEqual(self.task.recover(NAME)['status'], 'restore_cleanup_completed')
        self.assertEqual(archive.content(archive.snapshot(self.source)), archive.content(before))
        self.assertTrue((self.final / 'release.tar.gz').exists())

    def test_corrupt_tar_preserved_and_retirement_state_cannot_redirect_to_old_tools(self):
        self.task.archive(NAME)
        state = self.final / 'storage.json'
        state.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'OCT07_TAR_RETIREMENT_NOT_SUPPORTED'):
            self.task.recover(NAME, restore=True)
        self.assertTrue(state.exists())
        state.unlink()
        tar = self.final / 'release.tar.gz'
        tar.write_bytes(tar.read_bytes() + b'corrupt')
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_HASH_MISMATCH'):
            self.task.recover(NAME, restore=True)
        self.assertTrue(tar.exists())
        self.assertFalse(self.source.exists())

    def test_unmanifested_asset_and_external_symlink_are_still_refused(self):
        extra = self.source / 'platform/arena/dist/assets/OldGame-01234567.js'
        extra.write_text('old cached-client resource')
        with self.assertRaisesRegex(ValueError, 'CURRENT_STATIC_ASSET_MISSING'):
            self.task.check(NAME)
        extra.unlink()
        link = self.source / 'node_modules/.bin/tool'
        link.unlink()
        link.symlink_to('../../../../private/release.lock')
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())


if __name__ == '__main__':
    unittest.main()
