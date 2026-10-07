import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('replica_verifier', Path(__file__).with_name('verify-release-replica.py'))
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


class ReplicaTests(unittest.TestCase):
    def setUp(self):
        # The macOS Python build lacks listxattr; these are synthetic unit fixtures,
        # not a substitute for the root/Linux recovery run required by the CLI.
        if not hasattr(os, 'listxattr'):
            portability = patch.object(os, 'listxattr', return_value=[], create=True)
            portability.start()
            self.addCleanup(portability.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.export = self.base / 'export-source'
        self.export.mkdir()
        self.storage = self.base / 'fake-snapshots'
        self.storage.mkdir()
        self.binary = self.base / 'restic-input'
        self.binary.write_bytes(b'fake restic binary, not an executable')
        self.password = self.base / 'separate-password'
        self.password.write_bytes(b'fixture-only-separate-secret-abcdefghijklmnopqrstuvwxyz\n')
        self.password.chmod(0o600)
        self.bundle = self.base / 'replica.tar'
        self.index = dict(format=1, restic_version=tool.VERSION, repository_id='a' * 64, original_tar_policy='retained', entries={})
        self.records = []
        self.calls = []
        self.mutate_restore = None
        self.fail_check = False
        for name in tool.ALLOW:
            sid = tool.sha(name.encode())
            destination = self.storage / sid
            tree = destination / name
            tree.mkdir(parents=True)
            (tree / 'asset.txt').write_bytes(b'original bytes ' + name.encode())
            (tree / 'asset.txt').chmod(0o640)
            (tree / 'link').symlink_to('asset.txt')
            (tree / 'RELEASE-MANIFEST.json').write_bytes(encoded({'files': {'asset.txt': tool.archive.digest(tree / 'asset.txt')}}))
            snapshot = tool.archive.snapshot(tree)
            metadata = destination / 'archive-metadata'
            metadata.mkdir()
            values = {'snapshot': snapshot, 'identity': dict(format=1, release=name)}
            values['receipt'] = dict(format=1, release=name, archive_sha256=tool.sha(('tar-' + name).encode()), snapshot_sha256=tool.sha(encoded(snapshot)))
            for key, value in values.items():
                (metadata / (key + '.json')).write_bytes(encoded(value))
                (metadata / (key + '.json')).chmod(0o600)
            entry = dict(release=name, snapshot_id=sid, status='verified', archive_sha256=values['receipt']['archive_sha256'],
                         restore_upper_bytes=tool.archive.space_bounds(snapshot)['extraction_upper_bytes'])
            entry.update({key + '_sha256': tool.sha(encoded(value)) for key, value in values.items()})
            self.index['entries'][name] = entry
            self.records.append(dict(id=sid, hostname='oasis-release-dedup-pilot', tags=['release=' + name, 'oasis-release-pilot-v1']))
        repo = self.export / 'repo'
        for child in ('data/ab', 'keys', 'snapshots', 'index', 'locks'):
            (repo / child).mkdir(parents=True, exist_ok=True)
        (repo / 'config').write_bytes(b'fake encrypted config')
        (repo / 'data/ab' / ('ab' + '1' * 62)).write_bytes(b'fake encrypted data')
        (repo / 'keys' / ('2' * 64)).write_bytes(b'fake encrypted key')
        (self.export / 'identity.json').write_bytes(encoded(dict(format=1, purpose='release-dedup-pilot', restic_version=tool.VERSION)))
        self.make_bundle()
        self.addCleanup(patch.stopall)
        patch.object(tool, 'BINARY_SHA256', tool.archive.digest(self.binary)).start()
        patch.object(tool, 'BINARY_BYTES', self.binary.stat().st_size).start()
        patch.object(tool.archive, 'available_bytes', return_value=100 * 1024**3).start()
        patch.object(tool.archive, 'Archiver', side_effect=AssertionError('must not consult original deployment')).start()

    def make_bundle(self):
        (self.export / 'index.json').write_bytes(encoded(self.index))
        with tarfile.open(self.bundle, 'w', format=tarfile.USTAR_FORMAT) as output:
            for name in ('repo', 'index.json', 'identity.json'):
                output.add(self.export / name, arcname=name)

    def task(self, root='verification'):
        result = tool.ReplicaVerifier(self.bundle, tool.archive.digest(self.bundle), self.bundle.stat().st_size,
                                      self.password, self.binary, self.base / root)
        result.restic = self.fake_restic
        return result

    def fake_restic(self, *args):
        self.calls.append(args)
        if args[:2] == ('cat', 'config'):
            return encoded(dict(id=self.index['repository_id'], version=2))
        if args[0] == 'snapshots':
            return encoded(self.records)
        if args[0] == 'check':
            if self.fail_check:
                raise ValueError('RESTIC_COMMAND_FAILED_CHECK')
            return b'{}'
        if args[0] == 'dump':
            return (self.storage / args[1] / args[2].lstrip('/')).read_bytes()
        if args[0] == 'restore':
            target = Path(args[3])
            shutil.copytree(self.storage / args[1], target, symlinks=True)
            if self.mutate_restore:
                self.mutate_restore(target)
            return b'{}'
        raise AssertionError(args)

    def test_exact_nine_success_is_independent_and_preserves_all_inputs(self):
        original = {path: tool.archive.digest(path) for path in (self.bundle, self.password, self.binary)}
        task = self.task()
        result = task.run()
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(len(result['releases']), 9)
        self.assertTrue(all(row['temporary_restore_removed'] for row in result['releases']))
        self.assertEqual([call[1] for call in self.calls if call[0] == 'restore'], [self.index['entries'][name]['snapshot_id'] for name in tool.ALLOW])
        self.assertIn(('check', '--read-data'), self.calls)
        self.assertFalse(any((task.root / 'restored').iterdir()))
        self.assertTrue((task.root / 'export/repo/config').exists())
        self.assertFalse((task.root / 'password').exists())
        self.assertEqual(original, {path: tool.archive.digest(path) for path in original})
        self.assertNotIn(self.password.read_text().strip(), (task.root / 'report.json').read_text())
        self.assertEqual(result['excluded_fields'], ['ctime_ns'])
        self.assertFalse(result['original_repository_consulted'])
        self.assertEqual(json.loads((task.root / 'report.json').read_text())['status'], 'verified')
        with self.assertRaisesRegex(ValueError, 'ALREADY_EXISTS'):
            self.task().run()

    def test_wrong_bundle_digest_or_size_fails_before_output(self):
        for field, value in [('expected_sha', 'f' * 64), ('expected_bytes', 1024)]:
            with self.subTest(field=field):
                task = self.task()
                setattr(task, field, value)
                with self.assertRaisesRegex(ValueError, 'BUNDLE_HASH_OR_SIZE'):
                    task.run()
                self.assertFalse(task.root.exists())

    def test_binary_pin_and_password_permissions_and_symlink_are_enforced(self):
        self.binary.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'BINARY_HASH'):
            self.task().run()
        self.binary.write_bytes(b'fake restic binary, not an executable')
        self.password.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PASSWORD'):
            self.task().run()
        self.password.chmod(0o600)
        original = self.base / 'real-password'
        self.password.rename(original)
        self.password.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_INPUT_PATH'):
            self.task().run()

    def test_original_opt_oasis_paths_are_forbidden(self):
        task = self.task()
        task.root = Path('/opt/oasis/should-never-be-read')
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_PLATFORM_PATH_FORBIDDEN'):
            task.run()

    def test_index_requires_nine_unique_full_ids_and_retained_policy(self):
        cases = []
        missing = copy.deepcopy(self.index)
        del missing['entries'][tool.ALLOW[0]]
        cases.append(missing)
        duplicate = copy.deepcopy(self.index)
        duplicate['entries'][tool.ALLOW[0]]['snapshot_id'] = duplicate['entries'][tool.ALLOW[1]]['snapshot_id']
        cases.append(duplicate)
        short = copy.deepcopy(self.index)
        short['entries'][tool.ALLOW[0]]['snapshot_id'] = 'abc123'
        cases.append(short)
        wrong = copy.deepcopy(self.index)
        wrong['original_tar_policy'] = 'deleted'
        cases.append(wrong)
        for data in cases:
            with self.subTest(data=data['original_tar_policy']):
                with self.assertRaises(ValueError):
                    tool.validate_index(data)

    def test_exact_repository_snapshot_set_and_identity_required_before_check(self):
        self.records[0]['id'] = 'f' * 64
        task = self.task()
        with self.assertRaisesRegex(ValueError, 'EXACT_SNAPSHOT_SET'):
            task.run()
        self.assertNotIn(('check', '--read-data'), self.calls)
        self.assertEqual(json.loads((task.root / 'report.json').read_text())['status'], 'failed')

    def test_wrong_tag_and_extra_snapshot_are_rejected(self):
        self.records[0]['tags'].append('unexpected')
        with self.assertRaisesRegex(ValueError, 'SNAPSHOT_IDENTITY'):
            self.task().run()
        self.records[0]['tags'].pop()
        self.records.append(copy.deepcopy(self.records[0]))
        with self.assertRaisesRegex(ValueError, 'EXACT_NINE_SNAPSHOTS'):
            self.task('verification2').run()

    def test_failed_check_preserves_repository_and_never_restores(self):
        self.fail_check = True
        task = self.task()
        with self.assertRaisesRegex(ValueError, 'FAILED_CHECK'):
            task.run()
        self.assertTrue((task.root / 'export/repo/config').exists())
        self.assertFalse(any(call[0] == 'restore' for call in self.calls))

    def test_snapshot_metadata_digest_is_checked_before_restore(self):
        entry = self.index['entries'][tool.ALLOW[0]]
        (self.storage / entry['snapshot_id'] / 'archive-metadata/snapshot.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'METADATA_HASH'):
            self.task().run()
        self.assertFalse(any(call[0] == 'restore' for call in self.calls))

    def test_valid_digest_does_not_allow_wrong_archive_identity_or_receipt(self):
        entry = self.index['entries'][tool.ALLOW[0]]
        path = self.storage / entry['snapshot_id'] / 'archive-metadata/identity.json'
        path.write_bytes(encoded(dict(format=1, release=tool.ALLOW[1])))
        entry['identity_sha256'] = tool.archive.digest(path)
        self.make_bundle()
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_IDENTITY_MISMATCH'):
            self.task().run()
        self.assertFalse(any(call[0] == 'restore' for call in self.calls))

    def test_restored_metadata_hash_is_rechecked_after_dump(self):
        def corrupt(target):
            (target / 'archive-metadata/receipt.json').write_bytes(b'{}')
        self.mutate_restore = corrupt
        task = self.task()
        with self.assertRaisesRegex(ValueError, 'RESTORED_METADATA_HASH'):
            task.run()
        self.assertTrue((task.root / 'restored' / tool.ALLOW[0]).exists())

    def test_manifest_is_checked_even_if_snapshot_matches_corrupt_manifest(self):
        entry = self.index['entries'][tool.ALLOW[0]]
        root = self.storage / entry['snapshot_id']
        (root / tool.ALLOW[0] / 'RELEASE-MANIFEST.json').write_bytes(encoded({'files': {'asset.txt': 'f' * 64}}))
        data = tool.archive.snapshot(root / tool.ALLOW[0])
        (root / 'archive-metadata/snapshot.json').write_bytes(encoded(data))
        entry['snapshot_sha256'] = tool.sha(encoded(data))
        receipt = dict(format=1, release=entry['release'], archive_sha256=entry['archive_sha256'], snapshot_sha256=entry['snapshot_sha256'])
        (root / 'archive-metadata/receipt.json').write_bytes(encoded(receipt))
        entry['receipt_sha256'] = tool.sha(encoded(receipt))
        entry['restore_upper_bytes'] = tool.archive.space_bounds(data)['extraction_upper_bytes']
        self.make_bundle()
        with self.assertRaisesRegex(ValueError, 'RELEASE_MANIFEST_MISMATCH'):
            self.task().run()

    def test_interrupt_records_failed_phase_and_keeps_exact_owned_target(self):
        def interrupt(target):
            raise KeyboardInterrupt()
        self.mutate_restore = interrupt
        task = self.task()
        with self.assertRaises(KeyboardInterrupt):
            task.run()
        report = json.loads((task.root / 'report.json').read_text())
        self.assertEqual(report['failed_phase'], 'restoring')
        self.assertEqual(report['active_release'], tool.ALLOW[0])
        self.assertTrue((task.root / 'restored' / tool.ALLOW[0]).exists())
        with self.assertRaisesRegex(ValueError, 'OUTPUT_ROOT_ALREADY_EXISTS'):
            self.task().run()

    def test_source_mutation_is_detected_before_success(self):
        original_runner = self.fake_restic
        task = self.task()
        def changed(*args):
            value = original_runner(*args)
            if args[0] == 'check':
                self.password.write_bytes(b'changed fixture password long enough to stay plausible\n')
            return value
        task.restic = changed
        with self.assertRaisesRegex(ValueError, 'INPUT_CHANGED_DURING_READ'):
            task.run()
        self.assertEqual(json.loads((task.root / 'report.json').read_text())['status'], 'failed')

    def test_space_bound_cannot_be_understated(self):
        self.index['entries'][tool.ALLOW[0]]['restore_upper_bytes'] = 1
        self.make_bundle()
        with self.assertRaisesRegex(ValueError, 'SPACE_BOUND_MISMATCH'):
            self.task().run()
        self.assertFalse(any(call[0] == 'restore' for call in self.calls))

    def test_restored_content_mode_mtime_and_link_are_actually_compared(self):
        name = tool.ALLOW[0]
        def content(target):
            (target / name / 'asset.txt').write_bytes(b'wrong')
        def mode(target):
            (target / name / 'asset.txt').chmod(0o600)
        def mtime(target):
            path = target / name / 'asset.txt'
            os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1))
        def link(target):
            path = target / name / 'link'
            path.unlink()
            path.symlink_to('RELEASE-MANIFEST.json')
        for i, mutate in enumerate((content, mode, mtime, link)):
            with self.subTest(mutation=i):
                self.mutate_restore = mutate
                task = self.task('verification' + str(i))
                with self.assertRaisesRegex(ValueError, 'RESTORED_TREE_MISMATCH'):
                    task.run()
                self.assertTrue((task.root / 'restored' / name).exists())
                self.assertEqual(json.loads((task.root / 'report.json').read_text())['status'], 'failed')

    def test_low_space_fails_before_output_and_keeps_three_gib_guard(self):
        with patch.object(tool.archive, 'available_bytes', return_value=tool.archive.RESERVE):
            task = self.task()
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_REPLICA_SPACE'):
                task.run()
            self.assertFalse(task.root.exists())

    def test_partial_restore_exception_is_retained_without_secret_in_report(self):
        def failure(target):
            raise RuntimeError(self.password.read_text())
        self.mutate_restore = failure
        task = self.task()
        with self.assertRaises(RuntimeError):
            task.run()
        report = (task.root / 'report.json').read_text()
        self.assertNotIn(self.password.read_text().strip(), report)
        self.assertEqual(json.loads(report)['error_code'], 'RuntimeError')
        self.assertTrue((task.root / 'restored' / tool.ALLOW[0]).exists())

    def test_duplicate_json_and_unsafe_snapshot_paths_links_rejected(self):
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_JSON'):
            tool.parse_json(b'{"a":1,"a":2}')
        entry = self.index['entries'][tool.ALLOW[0]]
        original = json.loads((self.storage / entry['snapshot_id'] / 'archive-metadata/snapshot.json').read_text())
        for target in ('/etc/passwd', '../../escape', 'link'):
            data = copy.deepcopy(original)
            data['entries']['link']['target'] = target
            with self.subTest(target=target), self.assertRaises(ValueError):
                tool.validate_snapshot(data)
        data = copy.deepcopy(original)
        data['entries']['../escape'] = data['entries']['asset.txt']
        with self.assertRaises(ValueError):
            tool.validate_snapshot(data)

    def test_all_tar_link_special_traversal_duplicate_and_password_members_fail(self):
        for kind, name in [(tarfile.SYMTYPE, 'repo/evil'), (tarfile.LNKTYPE, 'repo/evil'),
                           (tarfile.FIFOTYPE, 'repo/evil'), (tarfile.REGTYPE, '../escape'),
                           (tarfile.REGTYPE, '/absolute'), (tarfile.REGTYPE, 'password'),
                           (tarfile.REGTYPE, 'repo/config'), (tarfile.XHDTYPE, 'pax')]:
            with self.subTest(kind=kind, name=name):
                self.make_bundle()
                # Append a second real header before the canonical end blocks.
                with tarfile.open(self.bundle, 'a', format=tarfile.USTAR_FORMAT) as output:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        item.linkname = '../../escape'
                    output.addfile(item)
                task = self.task()
                with self.assertRaises(ValueError):
                    task.run()
                self.assertFalse(task.root.exists())
        self.assertFalse((self.base / 'escape').exists())

    def test_gnu_and_hidden_trailing_tar_payload_are_rejected(self):
        with tarfile.open(self.bundle, 'w', format=tarfile.GNU_FORMAT) as output:
            output.add(self.export / 'repo', arcname='repo')
        with self.assertRaisesRegex(ValueError, 'USTAR_FORMAT'):
            self.task().run()
        self.make_bundle()
        with self.bundle.open('ab') as stream:
            stream.write(b'x' * 512)
        with self.assertRaisesRegex(ValueError, 'TRAILING_DATA'):
            self.task().run()

    def test_binary_subprocess_uses_only_own_repo_and_fd_password(self):
        task = self.task()
        task.root.mkdir()
        task.created = True
        task.password_stream = self.password.open('rb')
        self.addCleanup(task.password_stream.close)
        fake = type('Result', (), {'returncode': 0, 'stdout': b'{}'})()
        with patch.object(tool.subprocess, 'run', return_value=fake) as execute:
            tool.ReplicaVerifier.restic(task, 'check', '--read-data')
        args, kwargs = execute.call_args
        self.assertIn(str(task.root / 'export/repo'), args[0])
        self.assertIn('/proc/self/fd/' + str(task.password_stream.fileno()), args[0])
        self.assertNotIn(str(self.password), args[0])
        self.assertEqual(kwargs['pass_fds'], (task.password_stream.fileno(),))
        self.assertEqual(set(kwargs['env']), {'PATH', 'LANG', 'TMPDIR', 'GOMAXPROCS'})
        self.assertNotIn('/opt/oasis', ' '.join(args[0]))


if __name__ == '__main__':
    unittest.main()
