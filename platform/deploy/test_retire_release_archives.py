import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tarfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load('retirement', 'retire-release-archives.py')
existing = load('retirement_compact_fixtures', 'test_compact_release_archives.py')
NAME = tool.archive.ALLOW[0]
OTHER = tool.archive.ALLOW[1]


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.fx = existing.FixtureCase()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.fx.fake_initialize()
        self.base = self.fx.base
        for name in tool.archive.ALLOW:
            if name != NAME:
                source = self.base / 'releases' / name
                shutil.copytree(self.fx.fixture.releases / '20261007-04', source, symlinks=True)
                self.fx.fixture.task.archive(name)
            self.fx.task.backup(name)
        self.task = tool.Retirer(self.base, self.fx.fixture.proc, reserve=0)
        self.task.task = self.fx.task
        self.proofs = self.base / 'independent-copy-proof'
        self.proofs.mkdir(mode=0o700)
        self.source_index = self.fx.task.index_path.read_bytes()
        self.index = json.loads(self.source_index)
        self.expected_index = tool.sha(self.source_index)
        self.make_proofs()

    def make_proofs(self):
        binary = tool.compact.BINARY_SHA256
        bundle = tool.sha(b'independent frozen repo export')
        materials = dict(format=1, source='independent-mac-copy', repository_id=self.index['repository_id'], original_tars_retained=True,
                         materials={'repository.tar': {'sha256': bundle, 'bytes': 123456},
                                    'restic-' + tool.compact.VERSION: {'sha256': binary, 'bytes': tool.compact.BINARY_BYTES},
                                    'verify-release-replica.py': {'sha256': tool.sha(b'approved validator'), 'bytes': 30000},
                                    'archive-releases.py': {'sha256': tool.sha(b'approved pure helpers'), 'bytes': 24000}})
        report = dict(format=1, purpose='independent-release-replica-verification', status='verified', phase='complete',
                      check_read_data='passed', independent_linux_recovery=True, original_repository_consulted=False,
                      original_tars_modified=False, published=False, restic_version=tool.compact.VERSION,
                      restic_binary_sha256=binary, excluded_fields=['ctime_ns'],
                      compared_fields=['path', 'type', 'sha256', 'size', 'uid', 'gid', 'mode', 'mtime_ns', 'symlink_target'],
                      repository_id=self.index['repository_id'], index_sha256=self.expected_index,
                      bundle_sha256=bundle, bundle_bytes=123456, tool_sha256=tool.sha(b'approved validator'),
                      archive_helpers_sha256=tool.sha(b'approved pure helpers'), releases=[])
        for name, entry in self.index['entries'].items():
            report['releases'].append({key: entry[key] for key in tool.DIGEST_KEYS} | dict(release=name, status='verified', temporary_restore_removed=True, entries=8, manifest_files=1))
        if hasattr(self, 'real_report'):
            report = self.real_report
            bundle = report['bundle_sha256']
            materials['materials']['repository.tar'] = {'sha256': bundle, 'bytes': report['bundle_bytes']}
            for filename, key in [('verify-release-replica.py', 'tool_sha256'), ('archive-releases.py', 'archive_helpers_sha256')]:
                materials['materials'][filename] = {'sha256': report[key], 'bytes': Path(__file__).with_name(filename).stat().st_size}
        transfer = dict(format=1, material_receipt_sha256=tool.sha(encoded(materials)), linux_report_sha256=tool.sha(encoded(report)),
                        independent_linux_recovery=True, password_copied_separately_from_mac=True, mac_materials_read_back=True,
                        original_tars_retained=True, verified_releases=9, repository_id=self.index['repository_id'],
                        index_sha256=self.expected_index, bundle_sha256=bundle, bundle_bytes=report['bundle_bytes'])
        for filename, value in [('materials.json', materials), ('linux-restore-report.json', report), ('transfer-proof.json', transfer)]:
            (self.proofs / filename).write_bytes(encoded(value))
            (self.proofs / filename).chmod(0o600)
        self.expected_transfer = tool.sha(encoded(transfer))

    def args(self, name=NAME):
        return name, self.proofs, self.expected_transfer, self.expected_index

    def state(self, name=NAME):
        return tool.archive.storage_state(self.base / 'release-archives' / name, name)

    def tar(self, name=NAME):
        return self.base / 'release-archives' / name / 'release.tar.gz'

    def stage(self):
        result = self.task.inspect(*self.args())
        self.task.initialize_v2(result[1], result[2], result[3], result[4])

    def test_default_check_is_read_only_and_never_executes_restic(self):
        before = tool.archive.snapshot(self.base / 'release-archives')
        index_before = self.fx.task.index_path.read_bytes()
        calls = self.fx.task.restic.call_count
        report = self.task.inspect(*self.args())[0]
        self.assertEqual(report['mode'], 'check-only')
        self.assertFalse(report['repository_verified'])
        self.assertEqual(calls, self.fx.task.restic.call_count)
        self.assertEqual(before, tool.archive.snapshot(self.base / 'release-archives'))
        self.assertEqual(index_before, self.fx.task.index_path.read_bytes())
        self.assertFalse(self.task.capsule_dir.exists())

    def test_one_tar_released_metadata_and_other_eight_remain_and_restore_works(self):
        originals = {name: tool.archive.digest(self.tar(name)) for name in tool.archive.ALLOW}
        metadata = {name: tool.archive.digest(self.tar().parent / (name + '.json')) for name in ('snapshot', 'receipt', 'identity')}
        result = self.task.release_tar(*self.args())
        self.assertEqual(result['status'], 'released')
        self.assertFalse(self.tar().exists())
        self.assertEqual(self.state()['state'], 'restic_only')
        self.assertGreater(result['released_tar_allocated_bytes'], 0)
        self.assertEqual(self.fx.task.index()['format'], 2)
        self.assertFalse(self.fx.task.tar_summary(self.fx.task.index())['original_tars_retained'])
        for name in tool.archive.ALLOW[1:]:
            self.assertEqual(tool.archive.digest(self.tar(name)), originals[name])
        for name, digest in metadata.items():
            self.assertEqual(tool.archive.digest(self.tar().parent / (name + '.json')), digest)
        self.assertEqual(self.task.release_tar(NAME)['status'], 'already_released')
        response = self.fx.fixture.task.recover(NAME, restore=True)
        self.assertEqual(response['status'], 'ARCHIVE_MOVED_TO_RESTIC')
        self.assertFalse(response['restored'])
        self.assertEqual(self.fx.task.restore(NAME)['status'], 'restored')
        self.assertEqual(self.fx.task.backup(NAME)['status'], 'already_verified')
        self.assertEqual(len(self.fx.task.verify()['releases']), 9)
        self.assertEqual(len(self.fx.task.check_only(list(tool.archive.ALLOW))['releases']), 9)
        self.assertEqual(self.fx.fake.backups, 9)

    def test_missing_bad_or_changed_proof_refuses_without_tar_mutation(self):
        with self.assertRaisesRegex(ValueError, 'PINNED_SECOND_COPY'):
            self.task.inspect(NAME)
        with self.assertRaisesRegex(ValueError, 'EXTERNAL_PIN'):
            self.task.release_tar(NAME, self.proofs, 'f' * 64, self.expected_index)
        self.stage()
        (self.task.capsule_dir / 'linux-restore-report.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'CAPSULE_FILE_HASH'):
            self.task.release_tar(NAME)
        self.assertTrue(self.tar().exists())

    def test_proof_requires_full_restore_scope_and_exact_nine(self):
        raw = {name: (self.proofs / name).read_bytes() for name in tool.PROOF_FILES if name != 'source-index.json'}
        raw['source-index.json'] = self.source_index
        for change in ('partial', 'wrong_id', 'not_mac', 'missing_uid'):
            value = dict(raw)
            report = json.loads(value['linux-restore-report.json'])
            transfer = json.loads(value['transfer-proof.json'])
            if change == 'partial':
                report['releases'].pop()
            elif change == 'wrong_id':
                report['releases'][0]['snapshot_id'] = 'f' * 64
            elif change == 'not_mac':
                transfer['password_copied_separately_from_mac'] = False
            else:
                report['compared_fields'].remove('uid')
            value['linux-restore-report.json'] = encoded(report)
            transfer['linux_report_sha256'] = tool.sha(value['linux-restore-report.json'])
            value['transfer-proof.json'] = encoded(transfer)
            with self.subTest(change=change), self.assertRaises(ValueError):
                tool.validate_proof(value, tool.sha(value['transfer-proof.json']), self.expected_index)

    def test_tar_symlink_hardlink_and_changed_bytes_are_rejected(self):
        outside = self.base / 'other-file'
        outside.write_bytes(b'must stay')
        self.tar().rename(self.tar().with_name('saved.tar'))
        self.tar().symlink_to(outside)
        with self.assertRaises((ValueError, OSError)):
            self.task.release_tar(*self.args())
        self.tar().unlink()
        os.link(outside, self.tar())
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RETIREMENT_TAR'):
            self.task.release_tar(*self.args())
        self.tar().unlink()
        self.tar().with_name('saved.tar').rename(self.tar())
        self.tar().write_bytes(self.tar().read_bytes() + b'tamper')
        with self.assertRaisesRegex(ValueError, 'TAR_HASH_MISMATCH'):
            self.task.release_tar(*self.args())
        self.assertEqual(outside.read_bytes(), b'must stay')

    def test_current_or_process_pin_and_both_locks_block_deletion(self):
        with (self.base / 'private/release.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.task.release_tar(*self.args())
        with (self.base / 'release-archives/.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.task.release_tar(*self.args())
        (self.base / 'android-mock-current').unlink()
        (self.base / 'releases' / NAME).mkdir()
        (self.base / 'android-mock-current').symlink_to(self.base / 'releases' / NAME)
        with self.assertRaisesRegex(ValueError, 'PROTECTED'):
            self.task.release_tar(*self.args())
        self.assertTrue(self.tar().exists())

    def test_server_restore_failure_keeps_tar_and_failure_evidence(self):
        self.fx.fake.corrupt_restore = True
        with self.assertRaisesRegex(ValueError, 'RESTORED_TREE_MISMATCH'):
            self.task.release_tar(*self.args())
        self.assertTrue(self.tar().exists())
        self.assertEqual(self.state()['state'], 'retained')
        self.assertTrue((self.fx.task.scratch / ('retire-' + NAME)).exists())
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE_PILOT'):
            self.task.recover(NAME)

    def test_new_pin_after_server_restore_is_rechecked(self):
        original = self.task.fresh_server_restore
        def pin(entry):
            result = original(entry)
            (self.base / 'android-mock-current').unlink()
            (self.base / 'releases' / NAME).mkdir()
            (self.base / 'android-mock-current').symlink_to(self.base / 'releases' / NAME)
            return result
        with patch.object(self.task, 'fresh_server_restore', side_effect=pin):
            with self.assertRaisesRegex(ValueError, 'PROTECTED'):
                self.task.release_tar(*self.args())
        self.assertTrue(self.tar().exists())

    def test_v2_missing_storage_cannot_be_treated_as_retained(self):
        self.stage()
        (self.tar().parent / 'storage.json').unlink()
        with self.assertRaisesRegex(ValueError, 'V2_STORAGE_STATE_MISSING'):
            self.task.release_tar(NAME)
        self.assertTrue(self.tar().exists())

    def test_initialization_interrupted_before_index_commit_can_resume_without_tar_loss(self):
        original = tool.atomic_json
        def fail(path, value):
            if path == self.fx.task.index_path:
                raise KeyboardInterrupt()
            return original(path, value)
        with patch.object(tool, 'atomic_json', side_effect=fail):
            with self.assertRaises(KeyboardInterrupt):
                self.task.release_tar(*self.args())
        self.assertEqual(self.fx.task.index()['format'], 1)
        self.assertTrue(all(self.tar(name).exists() for name in tool.archive.ALLOW))
        self.assertEqual(self.task.recover(*self.args())['status'], 'preparation_completed_no_tar_removed')
        self.assertTrue(all(self.tar(name).exists() for name in tool.archive.ALLOW))
        self.assertEqual(self.fx.task.index()['format'], 2)

    def test_crash_at_each_state_commit_preserves_or_recovers_exact_tar(self):
        # Each iteration reuses a different release; no shared tar can be accidentally removed by recovery.
        for name, phase in zip(tool.archive.ALLOW, ('quarantine_prepared', 'quarantined', 'unlink_prepared')):
            expected_hash = tool.archive.digest(self.tar(name))
            original = self.task.write_state
            def crash(folder, state, next_phase):
                result = original(folder, state, next_phase)
                if next_phase == phase:
                    raise KeyboardInterrupt()
                return result
            with self.subTest(phase=phase), patch.object(self.task, 'write_state', side_effect=crash):
                with self.assertRaises(KeyboardInterrupt):
                    self.task.release_tar(*self.args(name))
            self.assertEqual(self.state(name)['state'], phase)
            self.assertEqual(self.task.recover(name)['status'], 'tar_retained_after_recovery')
            self.assertEqual(tool.archive.digest(self.tar(name)), expected_hash)
            self.assertEqual(self.state(name)['state'], 'retained')

    def test_crash_after_rename_before_state_write_rolls_back(self):
        original = self.task.write_state
        def crash(folder, state, phase):
            if phase == 'quarantined':
                raise KeyboardInterrupt()
            return original(folder, state, phase)
        with patch.object(self.task, 'write_state', side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.task.release_tar(*self.args())
        self.assertFalse(self.tar().exists())
        self.assertEqual(self.state()['state'], 'quarantine_prepared')
        self.assertEqual(self.task.recover(NAME)['status'], 'tar_retained_after_recovery')
        self.assertTrue(self.tar().exists())

    def test_crash_after_unlink_before_final_state_reverifies_and_finalizes(self):
        original = self.task.write_state
        def crash(folder, state, phase):
            if phase == 'restic_only':
                raise KeyboardInterrupt()
            return original(folder, state, phase)
        with patch.object(self.task, 'write_state', side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.task.release_tar(*self.args())
        self.assertFalse(self.tar().exists())
        self.assertEqual(self.state()['state'], 'unlink_prepared')
        before = self.fx.task.restic.call_count
        self.assertEqual(self.task.recover(NAME)['status'], 'release_completion_recovered')
        self.assertGreater(self.fx.task.restic.call_count, before)
        self.assertEqual(self.state()['state'], 'restic_only')
        self.assertEqual(self.fx.task.restore(NAME)['status'], 'restored')

    def test_quarantine_identity_swap_fails_without_unlink(self):
        original = self.task.write_state
        def replace(folder, state, phase):
            result = original(folder, state, phase)
            if phase == 'quarantined':
                target = folder / tool.QUARANTINE
                value = target.read_bytes()
                target.rename(folder / 'keep-original.tar')
                target.write_bytes(value)
                target.chmod(0o600)
            return result
        with patch.object(self.task, 'write_state', side_effect=replace):
            with self.assertRaisesRegex(ValueError, 'TAR_IDENTITY_CHANGED'):
                self.task.release_tar(*self.args())
        self.assertTrue((self.tar().parent / tool.QUARANTINE).exists())
        self.assertTrue((self.tar().parent / 'keep-original.tar').exists())

    def test_low_space_fails_before_protocol_mutation(self):
        with patch.object(existing.tool.archive, 'available_bytes', return_value=1):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_PILOT_SPACE'):
                self.task.release_tar(*self.args())
        self.assertFalse(self.task.capsule_dir.exists())
        self.assertTrue(self.tar().exists())

    def test_metadata_changed_during_restore_prevents_quarantine(self):
        original = self.task.fresh_server_restore
        def change(entry):
            result = original(entry)
            with (self.tar().parent / 'receipt.json').open('ab') as stream:
                stream.write(b'\n')
            return result
        with patch.object(self.task, 'fresh_server_restore', side_effect=change):
            with self.assertRaisesRegex(ValueError, 'ORIGINAL_METADATA_CHANGED'):
                self.task.release_tar(*self.args())
        self.assertTrue(self.tar().exists())
        self.assertEqual(self.state()['state'], 'retained')

    def test_capsule_changed_during_restore_prevents_quarantine(self):
        original = self.task.fresh_server_restore
        def change(entry):
            result = original(entry)
            (self.task.capsule_dir / 'transfer-proof.json').write_bytes(b'{}')
            return result
        with patch.object(self.task, 'fresh_server_restore', side_effect=change):
            with self.assertRaisesRegex(ValueError, 'CAPSULE_FILE_HASH_MISMATCH'):
                self.task.release_tar(*self.args())
        self.assertTrue(self.tar().exists())

    def test_fsync_failure_after_quarantine_rename_can_recover(self):
        original = tool.archive.sync_dir
        def fail(path):
            if path == self.tar().parent and (path / tool.QUARANTINE).exists() and self.state()['state'] == 'quarantine_prepared':
                raise OSError('injected fsync failure')
            return original(path)
        with patch.object(tool.archive, 'sync_dir', side_effect=fail):
            with self.assertRaises(OSError):
                self.task.release_tar(*self.args())
        self.assertEqual(self.state()['state'], 'quarantine_prepared')
        self.assertEqual(self.task.recover(NAME)['status'], 'tar_retained_after_recovery')
        self.assertTrue(self.tar().exists())

    def test_unlink_failure_leaves_reversible_tar_and_legacy_redirect(self):
        original = tool.os.unlink
        def fail(path, *args, **kwargs):
            if path == tool.QUARANTINE:
                raise OSError('injected unlink refusal')
            return original(path, *args, **kwargs)
        with patch.object(tool.os, 'unlink', side_effect=fail):
            with self.assertRaises(OSError):
                self.task.release_tar(*self.args())
        self.assertEqual(self.state()['state'], 'unlink_prepared')
        response = self.fx.fixture.task.recover(NAME, restore=True)
        self.assertEqual(response['status'], 'ARCHIVE_RETIREMENT_IN_PROGRESS')
        self.assertEqual(self.task.recover(NAME)['status'], 'tar_retained_after_recovery')
        self.assertTrue(self.tar().exists())

    def test_storage_or_capsule_symlink_cannot_authorize_deletion(self):
        self.stage()
        state = self.tar().parent / 'storage.json'
        state.rename(state.with_name('original-storage.json'))
        state.symlink_to(state.with_name('original-storage.json'))
        with self.assertRaisesRegex(ValueError, 'UNSAFE_STORAGE_STATE'):
            self.task.release_tar(NAME)
        self.assertTrue(self.tar().exists())


@unittest.skipUnless(os.environ.get('RESTIC_REAL_BINARY_ARCHIVE'), 'real Linux binary archive not selected')
class RealRetirementTests(unittest.TestCase):
    """Actual Restic backup/copy/restore/unlink in a temporary Linux fixture only.

    The Mac custody receipt is simulated here; real Mac transfer evidence is a
    separate operational prerequisite, not something a Linux fixture can prove.
    """
    make_proofs = RetirementTests.make_proofs
    args = RetirementTests.args
    state = RetirementTests.state
    tar = RetirementTests.tar

    def setUp(self):
        self.assertEqual(os.uname().sysname, 'Linux')
        self.assertEqual(os.geteuid(), 0)
        self.fx = existing.FixtureCase()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.base = self.fx.base
        self.fx.task.reserve = self.fx.task.legacy.reserve = tool.archive.RESERVE
        self.fx.task.initialize(Path(os.environ['RESTIC_REAL_BINARY_ARCHIVE']))
        for name in tool.archive.ALLOW:
            if name != NAME:
                source = self.base / 'releases' / name
                shutil.copytree(self.fx.fixture.releases / '20261007-04', source, symlinks=True)
                if name == OTHER:
                    for relative in ('node_modules/tool/cli.js', 'node_modules/.bin/tool'):
                        os.chown(source / relative, 23456, 23457, follow_symlinks=False)
                        os.utime(source / relative, ns=(1740000000123456789, 1740000000123456789), follow_symlinks=False)
                self.fx.fixture.task.archive(name)
            self.fx.task.backup(name)
        self.task = tool.Retirer(self.base, self.fx.fixture.proc)
        self.task.task = self.fx.task
        self.source_index = self.fx.task.index_path.read_bytes()
        self.index = json.loads(self.source_index)
        self.expected_index = tool.sha(self.source_index)
        independent = self.base / 'independent-materials'
        independent.mkdir(mode=0o700)
        bundle = independent / 'repository.tar'
        with tarfile.open(bundle, 'w', format=tarfile.USTAR_FORMAT) as output:
            for name in ('repo', 'index.json', 'identity.json'):
                output.add(self.fx.task.root / name, arcname=name)
        password = independent / 'password'
        binary = independent / 'restic'
        shutil.copy2(self.fx.task.password, password)
        shutil.copy2(self.fx.task.binary, binary)
        replica = load('retirement_actual_replica', 'verify-release-replica.py')
        verifier = replica.ReplicaVerifier(bundle, tool.archive.digest(bundle), bundle.stat().st_size,
                                           password, binary, self.base / 'independent-linux-verification')
        self.real_report = verifier.run()
        self.assertEqual(self.real_report['status'], 'verified')
        self.proofs = self.base / 'independent-copy-proof'
        self.proofs.mkdir(mode=0o700)
        self.make_proofs()

    def test_actual_linux_release_and_exact_restore_with_nondefault_posix_metadata(self):
        expected = json.loads((self.tar(OTHER).parent / 'snapshot.json').read_text())
        self.assertEqual(self.task.release_tar(*self.args(OTHER))['status'], 'released')
        self.assertFalse(self.tar(OTHER).exists())
        restored = self.fx.task.restore(OTHER)
        actual = tool.archive.snapshot(Path(restored['path']))
        self.assertEqual(tool.archive.content(actual), tool.archive.content(expected))
        self.assertTrue(all(self.tar(name).exists() for name in tool.archive.ALLOW if name != OTHER))
        self.assertEqual(self.task.release_tar(OTHER)['status'], 'already_released')
        print('REAL_RETIREMENT_EVIDENCE ' + json.dumps(dict(release=OTHER, repository_id=self.index['repository_id'],
              snapshot_id=self.index['entries'][OTHER]['snapshot_id'], independent_copy_restores=9,
              original_tar_unlinked=True, original_metadata_retained=True, exact_server_restore='passed',
              uid_gid_mode_link_mtime='passed', mac_custody='simulated fixture; not operational Mac evidence')))


if __name__ == '__main__':
    unittest.main()
