import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load('compact_release_archives', 'compact-release-archives.py')
fixtures = load('archive_fixtures', 'test_archive_releases.py')
NAME = tool.archive.ALLOW[0]
OTHER = tool.archive.ALLOW[1]


class FakeRestic:
    def __init__(self, task, storage):
        self.task, self.storage = task, storage
        self.backups = 0
        self.corrupt_restore = False
        self.config_id = 'a' * 64
        self.records = {}

    def __call__(self, *args, cwd=None):
        if args[:2] == ('cat', 'config'):
            return json.dumps({'id': self.config_id, 'version': 2})
        if args[0] == 'check':
            return '{}'
        if args[0] == 'backup':
            self.backups += 1
            identity = hashlib.sha256(str(self.backups).encode()).hexdigest()
            destination = self.storage / identity
            shutil.copytree(cwd, destination, symlinks=True)
            self.records[identity] = {'id': identity, 'hostname': 'oasis-release-dedup-pilot',
                                      'tags': ['release=' + args[1], 'oasis-release-pilot-v1']}
            return json.dumps({'message_type': 'summary', 'snapshot_id': identity})
        if args[0] == 'snapshots':
            return json.dumps([self.records[args[1]]])
        if args[0] == 'dump':
            return (self.storage / args[1] / args[2].lstrip('/')).read_text()
        if args[0] == 'restore':
            target = Path(args[args.index('--target') + 1])
            shutil.copytree(self.storage / args[1], target, symlinks=True)
            if self.corrupt_restore:
                release = next(path for path in target.iterdir() if path.name != 'archive-metadata')
                (release / fixtures.ASSET).write_text('wrong restored data')
            return '{}'
        raise AssertionError(args)


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ArchiveTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.base = self.fixture.base
        self.task = tool.Compactor(self.base, self.fixture.proc, reserve=0)
        self.fixture.task.archive(NAME)
        self.original = self.fixture.final

    def fake_initialize(self):
        for folder in (self.task.root, self.task.repo, self.task.root / 'bin', self.task.scratch, self.task.restored):
            folder.mkdir(mode=0o700)
        tool.write_bytes(self.task.password, b'not-a-real-secret-fixture-password\n')
        tool.write_bytes(self.task.binary, b'fixture executable', mode=0o500)
        digest = hashlib.sha256(b'fixture executable').hexdigest()
        self.patch_binary = patch.object(tool, 'BINARY_SHA256', digest)
        self.patch_binary.start()
        self.addCleanup(self.patch_binary.stop)
        tool.write_json(self.task.root / 'identity.json', {'format': 1, 'purpose': 'release-dedup-pilot', 'restic_version': tool.VERSION})
        tool.write_json(self.task.index_path, {'format': 1, 'restic_version': tool.VERSION, 'repository_id': 'a' * 64,
                                             'original_tar_policy': 'retained', 'entries': {}})
        self.fake = FakeRestic(self.task, self.base / 'fake-object-storage')
        self.patch_runner = patch.object(self.task, 'restic', side_effect=self.fake)
        self.patch_runner.start()
        self.addCleanup(self.patch_runner.stop)


class CompactorTests(FixtureCase):
    def test_check_only_does_not_initialize_or_write(self):
        before = tool.archive.snapshot(self.original)
        result = self.task.check_only([NAME])
        self.assertFalse(result['initialized'])
        self.assertFalse(self.task.root.exists())
        self.assertEqual(tool.archive.snapshot(self.original), before)

    def test_invalid_official_download_is_rejected_before_output(self):
        candidate = self.base / 'wrong.bz2'
        candidate.write_bytes(b'untrusted')
        with self.assertRaisesRegex(ValueError, 'DOWNLOAD_HASH_MISMATCH'):
            self.task.initialize(candidate)
        self.assertFalse(self.task.root.exists())

    def test_password_permissions_and_binary_digest_are_enforced(self):
        self.fake_initialize()
        self.task.password.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_PILOT_FILE'):
            self.task.backup(NAME)
        self.task.password.chmod(0o600)
        self.task.binary.chmod(0o700)
        self.task.binary.write_bytes(b'different executable')
        self.task.binary.chmod(0o500)
        with self.assertRaisesRegex(ValueError, 'BINARY_HASH_MISMATCH'):
            self.task.backup(NAME)

    def test_password_symlink_is_refused(self):
        self.fake_initialize()
        self.task.password.rename(self.task.root / 'original-password')
        self.task.password.symlink_to(self.task.root / 'original-password')
        with self.assertRaisesRegex(ValueError, 'UNSAFE_PILOT_FILE'):
            self.task.backup(NAME)

    def test_backup_verifies_restore_and_records_full_id_without_removing_tar(self):
        self.fake_initialize()
        original_hash = tool.archive.digest(self.original / 'release.tar.gz')
        result = self.task.backup(NAME)
        self.assertEqual(result['status'], 'verified')
        entry = self.task.index()['entries'][NAME]
        self.assertEqual(len(entry['snapshot_id']), 64)
        self.assertEqual(tool.archive.digest(self.original / 'release.tar.gz'), original_hash)
        self.assertFalse(any(self.task.scratch.iterdir()))
        self.assertEqual(self.task.backup(NAME)['status'], 'already_verified')
        self.assertEqual(self.fake.backups, 1)

    def test_corrupt_restored_data_prevents_index_commit_and_keeps_evidence(self):
        self.fake_initialize()
        self.fake.corrupt_restore = True
        with self.assertRaisesRegex(ValueError, 'RESTORED_TREE_MISMATCH'):
            self.task.backup(NAME)
        self.assertEqual(self.task.index()['entries'], {})
        self.assertTrue((self.task.scratch / ('backup-' + NAME) / 'backup-result.json').is_file())
        self.assertTrue((self.original / 'release.tar.gz').exists())
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE_PILOT'):
            self.task.backup(NAME)
        self.assertEqual(self.fake.backups, 1)

    def test_repository_identity_mismatch_stops_before_backup(self):
        self.fake_initialize()
        self.fake.config_id = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'REPOSITORY_ID_MISMATCH'):
            self.task.backup(NAME)
        self.assertFalse(any(self.task.scratch.iterdir()))

    def test_deployment_lock_blocks_every_mutation(self):
        self.fake_initialize()
        with (self.base / 'private/release.lock').open('rb') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.task.backup(NAME)
        self.assertEqual(self.fake.backups, 0)

    def test_low_space_and_non_allowlisted_release_are_refused(self):
        with patch.object(tool.archive, 'available_bytes', return_value=1):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_PILOT_SPACE'):
                self.task.check_only([NAME])
        with self.assertRaisesRegex(ValueError, 'ALLOWLISTED'):
            self.task.check_only(['20260922-04'])

    def test_restoration_is_independent_of_original_tar_and_never_publishes(self):
        self.fake_initialize()
        self.task.backup(NAME)
        (self.original / 'release.tar.gz').rename(self.original / 'retained-but-unavailable.tar.gz')
        pins = self.fixture.task.protection()['pins']
        result = self.task.restore(NAME)
        self.assertFalse(result['published'])
        expected = json.loads((self.original / 'snapshot.json').read_text())
        restored = tool.archive.snapshot(Path(result['path']))
        self.assertEqual(tool.archive.content(restored), tool.archive.content(expected))
        self.assertFalse((self.base / 'releases' / NAME).exists())
        self.assertEqual(self.fixture.task.protection()['pins'], pins)
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS'):
            self.task.restore(NAME)

    def test_tampered_snapshot_metadata_cannot_be_restored(self):
        self.fake_initialize()
        self.task.backup(NAME)
        identity = self.task.index()['entries'][NAME]['snapshot_id']
        (self.fake.storage / identity / 'archive-metadata/snapshot.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'METADATA_HASH_MISMATCH'):
            self.task.verify([NAME])
        self.assertTrue((self.original / 'release.tar.gz').exists())

    def test_short_snapshot_id_and_wrong_tag_fail_closed(self):
        self.fake_initialize()
        self.task.backup(NAME)
        entry = self.task.index()['entries'][NAME]
        self.fake.records[entry['snapshot_id']]['tags'] = ['release=' + OTHER]
        with self.assertRaisesRegex(ValueError, 'SNAPSHOT_IDENTITY_MISMATCH'):
            self.task.verify([NAME])
        data = json.loads(self.task.index_path.read_text())
        data['entries'][NAME]['snapshot_id'] = entry['snapshot_id'][:8]
        self.task.index_path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'INVALID_PILOT_DIGEST'):
            self.task.index()

    def test_active_process_reference_prevents_restore(self):
        self.fake_initialize()
        self.task.backup(NAME)
        process = self.fixture.proc / '991'
        (process / 'fd').mkdir(parents=True)
        (process / 'cmdline').write_text('node ' + str(self.base / 'releases' / NAME / 'server.mjs'))
        (process / 'maps').write_text('')
        with self.assertRaisesRegex(ValueError, 'RELEASE_IS_PROTECTED'):
            self.task.restore(NAME)

    def test_index_cannot_understate_restore_space(self):
        self.fake_initialize()
        self.task.backup(NAME)
        data = json.loads(self.task.index_path.read_text())
        data['entries'][NAME]['restore_upper_bytes'] = 1
        self.task.index_path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'RESTORE_SPACE_BOUND_MISMATCH'):
            self.task.restore(NAME)
        self.assertFalse((self.task.restored / NAME).exists())

    def test_repository_sync_failure_cannot_commit_verified_index(self):
        self.fake_initialize()
        sync = tool.archive.sync_tree
        def fail_repository(path):
            if path == self.task.repo:
                raise OSError('fixture sync failure')
            return sync(path)
        with patch.object(tool.archive, 'sync_tree', side_effect=fail_repository):
            with self.assertRaisesRegex(OSError, 'fixture sync failure'):
                self.task.backup(NAME)
        self.assertEqual(self.task.index()['entries'], {})
        self.assertTrue((self.task.scratch / ('backup-' + NAME) / 'backup-result.json').is_file())
        self.assertTrue((self.original / 'release.tar.gz').exists())

    def test_changed_original_receipt_is_not_silently_rebound(self):
        self.fake_initialize()
        self.task.backup(NAME)
        receipt = self.original / 'receipt.json'
        receipt.write_text(receipt.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'INDEX_ORIGINAL_ARCHIVE_MISMATCH'):
            self.task.backup(NAME)
        self.assertEqual(self.fake.backups, 1)


@unittest.skipUnless(os.environ.get('RESTIC_REAL_BINARY_ARCHIVE'), 'real Linux binary archive not selected')
class RealResticTests(FixtureCase):
    def test_real_two_release_backup_check_restore_and_tar_independence(self):
        self.assertEqual(os.uname().sysname, 'Linux')
        self.assertEqual(os.geteuid(), 0)
        self.task.reserve = tool.archive.RESERVE
        self.task.legacy.reserve = tool.archive.RESERVE
        initial = self.task.initialize(Path(os.environ['RESTIC_REAL_BINARY_ARCHIVE']))
        self.assertEqual(initial['status'], 'initialized')
        password_hash = tool.archive.digest(self.task.password)
        first = self.task.backup(NAME)
        self.assertEqual(first['status'], 'verified')
        source = self.base / 'releases' / OTHER
        shutil.copytree(self.fixture.releases / '20261007-04', source, symlinks=True)
        for relative in ('node_modules/tool/cli.js', 'node_modules/.bin/tool'):
            os.chown(source / relative, 23456, 23457, follow_symlinks=False)
            os.utime(source / relative, ns=(1740000000123456789, 1740000000123456789), follow_symlinks=False)
        self.fixture.task.archive(OTHER)
        second = self.task.backup(OTHER)
        self.assertNotEqual(first['snapshot_id'], second['snapshot_id'])
        self.assertEqual(self.task.backup(NAME)['status'], 'already_verified')
        self.assertEqual(len(self.task.verify()['releases']), 2)
        (self.original / 'release.tar.gz').rename(self.original / 'retained-but-unavailable.tar.gz')
        self.assertEqual(self.task.restore(NAME)['status'], 'restored')
        self.assertEqual(tool.archive.digest(self.task.password), password_hash)
        self.assertEqual(len(self.task.index()['entries']), 2)
        with self.assertRaisesRegex(ValueError, 'PILOT_ALREADY_EXISTS'):
            self.task.initialize(Path(os.environ['RESTIC_REAL_BINARY_ARCHIVE']))
        print('REAL_RESTIC_EVIDENCE ' + json.dumps({'version': tool.VERSION, 'repository_id': initial['repository_id'],
              'snapshot_ids': [first['snapshot_id'], second['snapshot_id']], 'indexed_releases': sorted(self.task.index()['entries']),
              'full_data_check': 'passed', 'independent_restore_without_original_tar': 'passed',
              'password_unchanged': True, 'repository_allocated_bytes': tool.archive.allocated_bytes(self.task.repo)}))


if __name__ == '__main__':
    unittest.main()
