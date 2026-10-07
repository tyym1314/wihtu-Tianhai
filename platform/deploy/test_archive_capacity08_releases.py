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


# Development-only test harness: stage the new ignored wrapper beside exact
# existing dependencies. The runnable wrapper itself has no path fallback.
import atexit
HERE = Path(__file__).resolve().parent
DEPLOY = HERE if (HERE / 'archive-releases.py').exists() else HERE.parents[1] / 'deploy'
TOOLS = tempfile.TemporaryDirectory(prefix='capacity08-source-tests-')
atexit.register(TOOLS.cleanup)
SOURCE_PATHS = {'archive-capacity08-releases.py': HERE / 'archive-capacity08-releases.py'}
SOURCE_PATHS.update({name: DEPLOY / name for name in ('archive-releases.py', 'publish-static-assets.py', 'release_build.py')})
for filename, path in SOURCE_PATHS.items():
    shutil.copyfile(path, Path(TOOLS.name) / filename)
spec = importlib.util.spec_from_file_location('archive_capacity08', Path(TOOLS.name) / 'archive-capacity08-releases.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
archive = module.archive
NAME = module.ALLOW[0]
ASSET = 'platform/arena/dist/assets/RunGame-abcdefgh.js'
CURRENT = '20261008-07'
MOCK = '20261007-04'
RECENT = ('20261008-04', '20261008-05', '20261008-06')


class Capacity08ArchiveTests(unittest.TestCase):
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
            files = {ASSET: archive.digest(target / ASSET)}
            for i in range(10):
                path = target / f'platform/server/fixture-{i}.mjs'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('unchanged server fixture')
                files[path.relative_to(target).as_posix()] = archive.digest(path)
            (target / 'RELEASE-MANIFEST.json').write_text(json.dumps(files))
        (self.base / 'current').symlink_to(self.releases / CURRENT)
        (self.base / 'android-mock-current').symlink_to(self.releases / MOCK)
        self.last = self.base / 'private/last-release.json'
        self.last.write_text(json.dumps({'current': str(self.releases / CURRENT), 'previous': str(self.releases / RECENT[-1])}))
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
        self.oct07_archives = self.base / 'release-archives-oct07'
        self.oct07_archives.mkdir(mode=0o700)
        for name in ('20261007-01', '20261007-02', '20261007-03'):
            folder = self.oct07_archives / name
            folder.mkdir(mode=0o700)
            for filename in ('identity.json', 'receipt.json', 'snapshot.json', 'release.tar.gz'):
                (folder / filename).write_bytes((name + ':' + filename).encode())
        self.capacity_archives = self.base / 'release-archives-capacity-20261008'
        self.capacity_archives.mkdir(mode=0o700)
        for name in ('20261004-01', '20261008-01'):
            folder = self.capacity_archives / name
            folder.mkdir(mode=0o700)
            for filename in ('identity.json', 'receipt.json', 'snapshot.json', 'release.tar.gz'):
                (folder / filename).write_bytes((name + ':' + filename).encode())
        self.capacity07_archives = self.base / 'release-archives-capacity07-20261008'
        self.capacity07_archives.mkdir(mode=0o700)
        for name in ('20260922-04', '20260926-01', '20261008-02'):
            folder = self.capacity07_archives / name
            folder.mkdir(mode=0o700)
            for filename in ('identity.json', 'receipt.json', 'snapshot.json', 'release.tar.gz'):
                (folder / filename).write_bytes((name + ':' + filename).encode())
        self.task = module.Capacity08Archiver(self.base, self.proc, reserve=0)
        self.source, self.work, self.final = self.task.paths(NAME)

    def test_exact_scope_and_original_allowlist_are_independent(self):
        original_allow = archive.ALLOW
        self.assertEqual(module.ALLOW, ('20261008-03', '20260922-05', '20260922-06'))
        self.assertTrue(set(module.ALLOW).isdisjoint(original_allow))
        old = archive.Archiver(self.base, self.proc, reserve=0)
        for name in module.ALLOW:
            source, work, final = self.task.paths(name)
            self.assertEqual(source, self.releases / name)
            self.assertEqual(work, self.base / 'release-archives-capacity08-20261008' / ('.work-' + name))
            self.assertEqual(final, self.base / 'release-archives-capacity08-20261008' / name)
            with self.assertRaisesRegex(ValueError, 'NOT_ALLOWLISTED'):
                old.paths(name)
        for name in (*original_allow, '20261007-01', '20261007-02', '20261007-03',
                     '20260922-04', '20260926-01', '20261008-02', '20260926-02', '20261004-01', '20261008-01', MOCK, CURRENT, '../20261008-01', '/tmp', '20261008-*'):
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
            with patch.object(module, 'Capacity08Archiver', return_value=self.task), patch.object(os, 'geteuid', return_value=0), patch.object(os, 'umask'), contextlib.redirect_stdout(output):
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
        for filename in (module.TOOL, 'archive-releases.py', 'publish-static-assets.py', 'release_build.py'):
            shutil.copy2(SOURCE_PATHS[filename], tools / filename)
        environment = {key: value for key, value in os.environ.items() if key != 'PYTHONDONTWRITEBYTECODE'}
        result = subprocess.run([sys.executable, str(tools / module.TOOL), '--help'],
                                capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((tools / '__pycache__').exists())

    def test_real_archive_restore_preserves_three_trees_and_existing_batches(self):
        old_metadata = archive.snapshot(self.original_archives)
        old_proof = archive.snapshot(self.old_proof)
        oct07_metadata = archive.snapshot(self.oct07_archives)
        capacity_metadata = archive.snapshot(self.capacity_archives)
        capacity07_metadata = archive.snapshot(self.capacity07_archives)
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
        self.assertEqual(archive.snapshot(self.oct07_archives), oct07_metadata)
        self.assertEqual(archive.snapshot(self.capacity_archives), capacity_metadata)
        self.assertEqual(archive.snapshot(self.capacity07_archives), capacity07_metadata)
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
                lock.write_text('existing capacity archive lock')
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
        with self.assertRaisesRegex(ValueError, 'CAPACITY08_TAR_RETIREMENT_NOT_SUPPORTED'):
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
        with self.assertRaisesRegex(ValueError, 'CAPACITY08_UNDECLARED_GLOBAL_ASSET'):
            self.task.check(NAME)
        extra.unlink()
        link = self.source / 'node_modules/.bin/tool'
        link.unlink()
        link.symlink_to('../../../../private/release.lock')
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())

    def published_missing_assets(self, count=1):
        manifest_path = self.source / 'RELEASE-MANIFEST.json'
        manifest = json.loads(manifest_path.read_text())
        names = []
        for i in range(count):
            name = f'platform/arena/dist/assets/OldChunk-{i:08d}.js'
            path = self.source / name
            path.write_bytes((f'old chunk {i};\n' * 400).encode())
            manifest[name] = archive.digest(path)
            names.append(name)
        manifest_path.write_text(json.dumps(manifest))
        with patch.object(module.publisher, 'RESERVE', 0):
            module.publisher.publish(self.source, self.base, apply=True)
        return names

    def test_nineteen_registered_missing_chunks_real_archive_restore(self):
        # Exercise the actual 0803 shape, not only the first allowlisted release.
        name = '20261008-03'
        self.source, self.work, self.final = self.task.paths(name)
        missing = self.published_missing_assets(19)
        before = archive.snapshot(self.source)
        report, _ = self.task.check(name)
        self.assertEqual(report['static_coverage']['current_files'], 1)
        self.assertEqual(report['static_coverage']['global_files'], 19)
        self.assertEqual(report['static_coverage']['global_verification']['registered_assets'], 20)
        result = self.task.archive(name)
        self.assertEqual(result['static_coverage']['global_files'], 19)
        self.assertGreater(result['reclaimed_bytes'], 0)
        tar_sha = archive.digest(self.final / 'release.tar.gz')
        restored = self.task.recover(name, restore=True)
        self.assertEqual(restored['static_coverage']['global_files'], 19)
        self.assertEqual(archive.content(archive.snapshot(self.source)), archive.content(before))
        self.assertEqual(archive.digest(self.final / 'release.tar.gz'), tar_sha)
        self.assertTrue(all(not (self.releases / CURRENT / path).exists() for path in missing))

    def test_same_url_bad_current_or_symlink_cannot_use_good_global_store(self):
        self.published_missing_assets()
        target = self.releases / CURRENT / ASSET
        body = target.read_bytes()
        target.write_bytes(b'corrupt same URL')
        with self.assertRaisesRegex(ValueError, 'CURRENT_STATIC_ASSET_HASH_MISMATCH'):
            self.task.check(NAME)
        target.unlink()
        target.symlink_to(self.source / ASSET)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RETAINED_PATH'):
            self.task.check(NAME)
        target.unlink()
        target.write_bytes(body)

    def test_unmanifested_missing_chunk_cannot_borrow_registered_url(self):
        missing = self.published_missing_assets()[0]
        path = self.source / 'RELEASE-MANIFEST.json'
        manifest = json.loads(path.read_text())
        del manifest[missing]
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'CAPACITY08_UNDECLARED_GLOBAL_ASSET'):
            self.task.archive(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())

    def test_pending_or_missing_head_missing_receipt_and_bad_body_refuse(self):
        missing = self.published_missing_assets()[0]
        head = self.base / module.publisher.HEAD_PATH
        head_bytes = head.read_bytes()
        value = json.loads(head_bytes)
        value['pending'] = {'release': NAME, 'receipt_sha256': value['receipts'][0],
                            'manifest_sha256': archive.digest(self.source / 'RELEASE-MANIFEST.json')}
        head.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'STATIC_PUBLISH_INCOMPLETE'):
            self.task.check(NAME)
        head.unlink()
        with self.assertRaisesRegex(ValueError, 'STATIC_HEAD_MISSING'):
            self.task.check(NAME)
        head.write_bytes(head_bytes)
        receipt = next((self.base / 'static-assets/.registry').iterdir())
        receipt_bytes = receipt.read_bytes()
        receipt.unlink()
        with self.assertRaisesRegex(ValueError, 'STATIC_REGISTERED_RECEIPT_MISSING'):
            self.task.check(NAME)
        receipt.write_bytes(receipt_bytes)
        asset = self.base / 'static-assets' / module.release_build.static_public_path(missing).lstrip('/')
        body = asset.read_bytes()
        asset.write_bytes(body + b'corrupt')
        with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_HASH_MISMATCH'):
            self.task.check(NAME)
        asset.unlink()
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_MISSING|STATIC_ASSET_MISSING'):
            self.task.check(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())

    def test_unrelated_registered_body_and_forged_receipt_are_not_ignored(self):
        self.published_missing_assets()
        # ASSET is present in current; its separate store copy still belongs to
        # the global registry, so validating only the missing URLs is unsafe.
        target = self.base / 'static-assets' / module.release_build.static_public_path(ASSET).lstrip('/')
        body = target.read_bytes()
        target.write_bytes(b'x')
        with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_HASH_MISMATCH'):
            self.task.check(NAME)
        target.write_bytes(body)
        receipt = next((self.base / 'static-assets/.registry').iterdir())
        receipt.write_bytes(receipt.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'STATIC_RECEIPT_HASH_MISMATCH'):
            self.task.check(NAME)

    def test_global_store_rechecked_after_unpack_and_quarantine(self):
        missing = self.published_missing_assets()[0]
        asset = self.base / 'static-assets' / module.release_build.static_public_path(missing).lstrip('/')
        body = asset.read_bytes()
        unpack = self.task.unpack
        def changed_after_unpack(*args):
            result = unpack(*args)
            asset.write_bytes(b'changed after actual extraction')
            return result
        with patch.object(self.task, 'unpack', side_effect=changed_after_unpack):
            with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_HASH_MISMATCH'):
                self.task.archive(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.final.exists())
        asset.write_bytes(body)
        sync = archive.sync_dir
        def changed_after_quarantine(path):
            result = sync(path)
            if path == self.work and (self.work / 'original').exists():
                asset.write_bytes(b'changed after quarantine')
            return result
        before = archive.content(archive.snapshot(self.source))
        with patch.object(archive, 'sync_dir', side_effect=changed_after_quarantine):
            with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_HASH_MISMATCH'):
                self.task.archive(NAME)
        self.assertEqual(archive.content(archive.snapshot(self.source)), before)
        self.assertFalse(self.final.exists())
        self.assertFalse(self.work.exists())

    def test_restore_coverage_failure_keeps_tar_and_recovers_after_store_repair(self):
        missing = self.published_missing_assets()[0]
        asset = self.base / 'static-assets' / module.release_build.static_public_path(missing).lstrip('/')
        body = asset.read_bytes()
        self.task.archive(NAME)
        tar_sha = archive.digest(self.final / 'release.tar.gz')
        asset.write_bytes(b'corrupt during later restore')
        with self.assertRaisesRegex(ValueError, 'STATIC_ASSET_HASH_MISMATCH'):
            self.task.recover(NAME, restore=True)
        self.assertFalse(self.source.exists())
        self.assertEqual(archive.digest(self.final / 'release.tar.gz'), tar_sha)
        asset.write_bytes(body)
        self.assertEqual(self.task.recover(NAME)['status'], 'restored')
        self.assertEqual(archive.digest(self.final / 'release.tar.gz'), tar_sha)

    def test_registered_url_identity_must_match_source_and_unanchored_receipt_refuses(self):
        missing = self.published_missing_assets()[0]
        head = self.base / module.publisher.HEAD_PATH
        head_bytes = head.read_bytes()
        folder = self.base / 'static-assets/.registry'
        receipt = next(folder.iterdir())
        value = json.loads(receipt.read_text())
        public = module.release_build.static_public_path(missing)
        target = self.base / 'static-assets' / public.lstrip('/')
        target.write_bytes(b'a completely different yet internally consistent registered asset')
        value['assets'][public] = {'sha256': archive.digest(target), 'bytes': target.stat().st_size}
        payload = module.publisher.json_bytes(value)
        sha = module.hashlib.sha256(payload).hexdigest()
        (folder / (sha + '.json')).write_bytes(payload)
        with self.assertRaisesRegex(ValueError, 'STATIC_REGISTRY_CONFLICT|STATIC_UNANCHORED_RECEIPT'):
            self.task.check(NAME)
        receipt.unlink()
        updated = json.loads(head_bytes)
        updated['receipts'] = [sha]
        head.write_text(json.dumps(updated))
        with self.assertRaisesRegex(ValueError, 'STATIC_COVERAGE_MISSING'):
            self.task.check(NAME)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.work.exists())

    def test_changed_head_during_verification_cannot_report_coverage(self):
        self.published_missing_assets()
        verify = module.publisher.verify_coverage
        def changed(*args):
            result = verify(*args)
            path = self.base / module.publisher.HEAD_PATH
            head = json.loads(path.read_text())
            head['receipts'] = []
            path.write_text(json.dumps(head))
            return result
        with patch.object(module.publisher, 'verify_coverage', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'STATIC_HEAD_CHANGED'):
                self.task.check(NAME)
        self.assertIsNone(self.task._release)

    def test_global_restore_published_then_interrupted_resumes_and_retains_archive(self):
        self.published_missing_assets()
        before = archive.content(archive.snapshot(self.source))
        self.task.archive(NAME)
        tar_sha = archive.digest(self.final / 'release.tar.gz')
        sync = archive.sync_dir
        def interrupted(path):
            if path == self.releases and self.source.exists():
                raise KeyboardInterrupt()
            return sync(path)
        with patch.object(archive, 'sync_dir', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.task.recover(NAME, restore=True)
        self.assertIsNone(self.task._release)
        self.assertTrue((self.final / 'restore-in-progress.json').exists())
        result = self.task.recover(NAME)
        self.assertEqual(result['status'], 'restore_cleanup_completed')
        self.assertEqual(result['static_coverage']['global_files'], 1)
        self.assertEqual(archive.content(archive.snapshot(self.source)), before)
        self.assertEqual(archive.digest(self.final / 'release.tar.gz'), tar_sha)


    def future_release(self):
        name = '20261008-08'
        shutil.copytree(self.releases / CURRENT, self.releases / name, symlinks=True)
        link = self.base / 'current'
        link.unlink()
        link.symlink_to(self.releases / name)
        self.last.write_text(json.dumps({'current': str(self.releases / name),
                                         'previous': str(self.releases / CURRENT)}))
        return name

    def test_new_archives_refuse_changed_baseline_without_retiring_sources(self):
        self.future_release()
        before = archive.snapshot(self.releases)
        for name in module.ALLOW:
            for method in (self.task.check, self.task.archive):
                with self.subTest(release=name, method=method.__name__), self.assertRaisesRegex(ValueError, 'CAPACITY08_BASELINE_CHANGED'):
                    method(name)
                source, work, final = self.task.paths(name)
                self.assertTrue(source.exists())
                self.assertFalse(work.exists())
                self.assertFalse(final.exists())
                self.assertFalse(self.task._baseline_required)
        self.assertEqual(archive.snapshot(self.releases), before)

    def test_previous_or_hot_baseline_drift_refuses_before_tar_creation(self):
        original = self.last.read_bytes()
        self.last.write_text(json.dumps({'current': str(self.releases / CURRENT),
                                         'previous': str(self.releases / RECENT[0])}))
        with self.assertRaisesRegex(ValueError, 'CAPACITY08_BASELINE_CHANGED'):
            self.task.check(NAME)
        self.last.write_bytes(original)
        shutil.copytree(self.releases / CURRENT, self.releases / '20261008-08', symlinks=True)
        with self.assertRaisesRegex(ValueError, 'CAPACITY08_BASELINE_CHANGED'):
            self.task.check(NAME)
        self.assertFalse(self.task.archives.exists())

    def test_future_safe_restore_is_not_locked_to_obsolete_current_pin(self):
        before = archive.content(archive.snapshot(self.source))
        self.task.archive(NAME)
        future = self.future_release()
        self.assertEqual(self.task.recover(NAME, restore=True)['status'], 'restored')
        self.assertEqual(archive.content(archive.snapshot(self.source)), before)
        protection = self.task.protection()
        self.assertEqual(protection['pins']['current'], future)
        self.assertTrue(module.BASELINE_PROTECTED <= set(protection['protected']))
        self.assertTrue((self.final / 'release.tar.gz').exists())

    def test_baseline_change_after_unpack_keeps_original_source(self):
        original = self.task.unpack
        def changed(*args):
            result = original(*args)
            self.future_release()
            return result
        before = archive.content(archive.snapshot(self.source))
        with patch.object(self.task, 'unpack', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'CAPACITY08_BASELINE_CHANGED'):
                self.task.archive(NAME)
        self.assertEqual(archive.content(archive.snapshot(self.source)), before)
        self.assertFalse(self.work.exists())
        self.assertFalse(self.final.exists())

    def test_bad_gzip_footer_truncation_and_trailing_tar_data_keep_source(self):
        import gzip
        original = self.task.unpack
        before = archive.snapshot(self.source)
        for kind in ('crc', 'truncated', 'tail-data', 'second-tar', 'oversized'):
            def changed(folder, target, name):
                path = folder / 'release.tar.gz'
                raw = path.read_bytes()
                if kind == 'crc':
                    body = bytearray(raw)
                    body[-8] ^= 1
                    body = bytes(body)
                elif kind == 'truncated':
                    body = raw[:-8]
                else:
                    unpacked = gzip.decompress(raw)
                    if kind == 'tail-data':
                        body = gzip.compress(unpacked[:-1] + b'x')
                    elif kind == 'second-tar':
                        body = raw + gzip.compress(unpacked)
                    else:
                        upper = archive.space_bounds(before)['archive_conservative_upper_bytes']
                        body = gzip.compress(unpacked + b'0' * (upper + 1))
                path.write_bytes(body)
                receipt = folder / 'receipt.json'
                value = json.loads(receipt.read_text())
                value['archive_sha256'] = archive.digest(path)
                receipt.write_text(json.dumps(value))
                return original(folder, target, name)
            with self.subTest(kind=kind), patch.object(self.task, 'unpack', side_effect=changed):
                with self.assertRaisesRegex(ValueError, 'CAPACITY08_(GZIP|TAR)_'):
                    self.task.archive(NAME)
            self.assertEqual(archive.snapshot(self.source), before)
            self.assertFalse(self.work.exists())
            self.assertFalse(self.final.exists())

    def test_future_restore_still_rejects_new_process_reference(self):
        self.task.archive(NAME)
        self.future_release()
        process = self.proc / '199'
        process.mkdir()
        (process / 'fd').mkdir()
        (process / 'cmdline').write_bytes(b'node\0')
        (process / 'maps').write_text('')
        (process / 'cwd').symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, 'PROTECTED'):
            self.task.recover(NAME, restore=True)
        self.assertFalse(self.source.exists())
        self.assertTrue((self.final / 'release.tar.gz').exists())


if __name__ == '__main__':
    unittest.main()
