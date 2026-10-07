import hashlib
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

from release_build import RETAINED_LOCK
import stage_delta
from stage_delta import stage
from test_retained_assets import asset, sha


class StageRetainedAssetTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.base = self.root / 'base'
        self.base.mkdir()
        self.candidate = self.root / 'candidate'
        self.old = {}
        self.contents = {}
        for index in range(10):
            name = f'src/fixture-{index}.mjs'
            self.put(name, f'fixture {index}'.encode())
        self.historical = asset('Historical-12345678.js')
        self.put(self.historical['path'], b'export default 1;')
        self.lock = {'schema': 'oasis-retained-static-v1',
                     'bundle': {'url': 'https://example.com/retained.tar.gz', 'sha256': 'c' * 64, 'bytes': 1},
                     'assets': [self.historical]}
        self.write_base_manifest()

    def put(self, name, value, listed=True):
        destination = self.base / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(value)
        self.contents[name] = value
        if listed:
            self.old[name] = sha(value)

    def write_base_manifest(self):
        (self.base / 'RELEASE-MANIFEST.json').write_text(json.dumps(self.old))

    def make_delta(self, overrides=None, omit=()):
        payloads = dict(self.contents)
        payloads[RETAINED_LOCK] = json.dumps(self.lock).encode()
        payloads.update(overrides or {})
        for name in omit:
            payloads.pop(name, None)
        new = {name: sha(value) for name, value in payloads.items()}
        changed = {name: value for name, value in payloads.items() if self.old.get(name) != new[name]}
        archive = self.root / 'delta.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, content in [*changed.items(), ('RELEASE-MANIFEST.json', json.dumps(new).encode())]:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
        return archive, sha(archive.read_bytes())

    def publish_base(self):
        """Use real publisher files/receipts/head; mock only fixture disk capacity."""
        (self.root / 'private').mkdir()
        (self.root / 'private/release.lock').touch()
        (self.root / 'releases').mkdir()
        release = self.root / 'releases/20261008-01'
        self.base.rename(release)
        self.base = release
        self.candidate = self.root / 'releases/20261008-02'
        (self.root / 'current').symlink_to(self.base)
        (self.root / 'android-mock-current').symlink_to(self.base)
        self.unlocked = 'platform/arena/dist/assets/FreshOld-abcdefgh.js'
        self.put(self.unlocked, b'old unlocked chunk')
        self.put(RETAINED_LOCK, json.dumps(self.lock).encode())
        self.write_base_manifest()
        publisher = stage_delta.static_assets
        with mock.patch.object(publisher.os, 'statvfs', return_value=mock.Mock(
                f_frsize=4096, f_bsize=4096, f_bavail=20 * 1024 ** 3 // 4096)):
            publisher.publish(self.base, self.root, apply=True)
        self.store = self.root / 'static-assets'

    def snapshot(self, root):
        return {path.relative_to(root).as_posix():
                ('link', path.readlink().as_posix()) if path.is_symlink() else
                ('file', sha(path.read_bytes()), path.stat().st_ino, path.stat().st_mode)
                for path in root.rglob('*') if path.is_file() or path.is_symlink()}

    def stage_with_store(self, archive, digest):
        with stage_delta.static_assets.deployment_lock(self.root):
            return stage(self.base, self.candidate, archive, digest, static_base=self.root)

    def assert_store_stage_refused(self, archive, digest, error):
        before = self.snapshot(self.base)
        store = self.snapshot(self.store)
        with self.assertRaisesRegex(ValueError, error):
            self.stage_with_store(archive, digest)
        self.assertFalse(self.candidate.exists())
        self.assertEqual(self.snapshot(self.base), before)
        self.assertEqual(self.snapshot(self.store), store)

    def test_staging_is_independent_and_all_historical_bytes_are_manifested(self):
        archive, digest = self.make_delta({'src/fixture-0.mjs': b'new code'})
        report = stage(self.base, self.candidate, archive, digest)
        self.assertEqual(report['retained_static_files'], 1)
        self.assertEqual((self.base / 'src/fixture-0.mjs').read_bytes(), b'fixture 0')
        self.assertEqual((self.candidate / 'src/fixture-0.mjs').read_bytes(), b'new code')
        self.assertNotEqual((self.base / self.historical['path']).stat().st_ino,
                            (self.candidate / self.historical['path']).stat().st_ino)

    def test_unlisted_old_actual_fingerprint_must_be_explicitly_added_to_new_manifest(self):
        self.old.pop(self.historical['path'])
        self.write_base_manifest()
        archive, digest = self.make_delta(omit=(self.historical['path'],))
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_ASSET_NOT_RETAINED'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())
        archive, digest = self.make_delta()
        stage(self.base, self.candidate, archive, digest)
        self.assertIn(self.historical['path'], json.loads((self.candidate / 'RELEASE-MANIFEST.json').read_text()))

    def test_same_immutable_url_cannot_change_bytes(self):
        archive, digest = self.make_delta({self.historical['path']: b'different'})
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_ASSET_NOT_RETAINED'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())

    def test_old_locked_nonfingerprinted_dependency_is_preserved(self):
        model = asset('pvp/run/fox.glb', b'model', role='dependency', contentType='model/gltf-binary')
        self.historical['dependencies'].append(model['publicPath'])
        self.lock['assets'].append(model)
        self.put(model['path'], b'model')
        self.put(RETAINED_LOCK, json.dumps(self.lock).encode())
        self.write_base_manifest()
        # A later lock removing the dependency cannot silently alter the URL contract.
        self.historical['dependencies'] = []
        self.lock['assets'] = [self.historical]
        archive, digest = self.make_delta({model['path']: b'new model'})
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_ASSET_NOT_RETAINED'):
            stage(self.base, self.candidate, archive, digest)

    def test_current_mutable_nonfingerprint_can_still_be_updated(self):
        name = 'platform/arena/dist/assets/unlocked-logo.png'
        self.put(name, b'old image')
        self.write_base_manifest()
        archive, digest = self.make_delta({name: b'new image'})
        stage(self.base, self.candidate, archive, digest)
        self.assertEqual((self.candidate / name).read_bytes(), b'new image')

    def test_deleted_manifested_files_do_not_survive_delta_staging(self):
        source = 'src/fixture-9.mjs'
        mutable = 'platform/arena/dist/assets/obsolete-logo.png'
        self.put(mutable, b'obsolete image')
        self.write_base_manifest()
        archive, digest = self.make_delta(omit=(source, mutable))
        report = stage(self.base, self.candidate, archive, digest)
        self.assertEqual(report['removed_files'], 2)
        for name in (source, mutable):
            self.assertTrue((self.base / name).is_file(), 'immutable previous release stays intact')
            self.assertFalse((self.candidate / name).exists())

    def test_deletion_refuses_a_changed_old_file_or_symlink(self):
        name = 'src/fixture-9.mjs'
        archive, digest = self.make_delta(omit=(name,))
        original = self.base / name
        original.write_bytes(b'unexpected runtime modification')
        with self.assertRaisesRegex(ValueError, 'REMOVED_RELEASE_HASH_MISMATCH'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())
        original.unlink()
        original.symlink_to(self.base / 'src/fixture-8.mjs')
        with self.assertRaisesRegex(ValueError, 'UNSAFE_REMOVED_RELEASE_PATH'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())
        self.assertTrue(original.is_symlink())

    def test_previous_lock_cannot_drop_an_asset_while_leaving_its_bytes_unlocked(self):
        extra = asset('Extra-abcdefgh.js', b'old extra')
        self.lock['assets'].append(extra)
        self.put(extra['path'], b'old extra')
        self.put(RETAINED_LOCK, json.dumps(self.lock).encode())
        self.write_base_manifest()
        self.lock['assets'] = [self.historical]
        archive, digest = self.make_delta()
        with self.assertRaisesRegex(ValueError, 'PREVIOUS_RETAINED_LOCK_ASSET_DROPPED'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())

    def test_invalid_new_lock_causes_candidate_cleanup(self):
        self.historical['sha256'] = 'f' * 64
        archive, digest = self.make_delta()
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_HASH_MISMATCH'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())

    def test_new_lock_itself_must_be_manifested(self):
        self.put(RETAINED_LOCK, json.dumps(self.lock).encode())
        self.write_base_manifest()
        archive, digest = self.make_delta(omit=(RETAINED_LOCK,))
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_MISSING_FROM_RELEASE_MANIFEST'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())

    def test_registered_unlocked_chunk_can_leave_candidate_without_mutating_original_or_store(self):
        self.publish_base()
        new_chunk = 'platform/arena/dist/assets/FreshNew-ijklmnop.js'
        archive, digest = self.make_delta({new_chunk: b'new build chunk'}, omit=(self.unlocked,))
        before, store = self.snapshot(self.base), self.snapshot(self.store)
        head = (self.root / stage_delta.static_assets.HEAD_PATH).read_bytes()
        report = self.stage_with_store(archive, digest)
        self.assertEqual(report['retained_in_static_store'], [self.unlocked])
        self.assertEqual(report['removed_files'], 1)
        self.assertEqual(report['static_store_coverage']['registered_assets'], 2)
        self.assertEqual(report['static_store_coverage']['receipts'], 1)
        manifest = json.loads((self.candidate / 'RELEASE-MANIFEST.json').read_text())
        self.assertNotIn(self.unlocked, manifest)
        self.assertFalse((self.candidate / self.unlocked).exists())
        self.assertEqual((self.candidate / new_chunk).read_bytes(), b'new build chunk')
        self.assertNotEqual((self.base / self.historical['path']).stat().st_ino,
                            (self.candidate / self.historical['path']).stat().st_ino)
        self.assertEqual(self.snapshot(self.base), before)
        self.assertEqual(self.snapshot(self.store), store)
        self.assertEqual((self.root / stage_delta.static_assets.HEAD_PATH).read_bytes(), head)
        self.assertEqual((self.root / 'current').resolve(), self.base)
        self.assertEqual((self.root / 'android-mock-current').resolve(), self.base)

    def test_existing_store_does_not_relax_default_or_allow_same_url_new_bytes(self):
        self.publish_base()
        archive, digest = self.make_delta(omit=(self.unlocked,))
        before = self.snapshot(self.base)
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_ASSET_NOT_RETAINED'):
            stage(self.base, self.candidate, archive, digest)
        self.assertFalse(self.candidate.exists())
        self.assertEqual(self.snapshot(self.base), before)
        archive, digest = self.make_delta({self.unlocked: b'changed under same URL'})
        self.assert_store_stage_refused(archive, digest, 'IMMUTABLE_ASSET_NOT_RETAINED')

    def test_registered_but_unlisted_actual_old_chunk_cannot_use_store_exception(self):
        self.publish_base()
        self.old.pop(self.unlocked)
        self.write_base_manifest()
        archive, digest = self.make_delta(omit=(self.unlocked,))
        self.assert_store_stage_refused(archive, digest, 'IMMUTABLE_ASSET_NOT_REGISTERED')

    def test_store_cannot_replace_locked_dependency_or_allow_new_lock_to_drop_it(self):
        model = asset('pvp/run/fox.glb', b'model', role='dependency', contentType='model/gltf-binary')
        self.historical['dependencies'].append(model['publicPath'])
        self.lock['assets'].append(model)
        self.put(model['path'], b'model')
        self.publish_base()
        archive, digest = self.make_delta(omit=(self.unlocked, model['path']))
        self.assert_store_stage_refused(archive, digest, 'IMMUTABLE_ASSET_NOT_RETAINED')
        # Keeping dependency bytes in the manifest is insufficient if the new
        # retained lock itself silently forgets the previous public obligation.
        self.historical['dependencies'] = []
        self.lock['assets'] = [self.historical]
        archive, digest = self.make_delta(omit=(self.unlocked,))
        self.assert_store_stage_refused(archive, digest, 'PREVIOUS_RETAINED_LOCK_ASSET_DROPPED')

    def test_store_exception_requires_committed_head_receipts_and_unchanged_bodies(self):
        self.publish_base()
        archive, digest = self.make_delta(omit=(self.unlocked,))
        head = self.root / stage_delta.static_assets.HEAD_PATH
        receipt = next((self.store / '.registry').glob('*.json'))
        body = self.store / 'arena/assets/FreshOld-abcdefgh.js'
        pending = json.loads(head.read_text())
        pending['pending'] = {'receipt_sha256': 'a' * 64, 'manifest_sha256': 'b' * 64,
                              'release': '20261008-02'}
        cases = [('missing_head', head, None, 'STATIC_HEAD_MISSING'),
                 ('pending', head, json.dumps(pending).encode(), 'STATIC_PUBLISH_INCOMPLETE'),
                 ('missing_receipt', receipt, None, 'STATIC_REGISTERED_RECEIPT_MISSING'),
                 ('corrupt_receipt', receipt, b'{}', 'STATIC_RECEIPT_HASH_MISMATCH'),
                 ('missing_body', body, None, 'STATIC_ASSET_MISSING'),
                 ('corrupt_body', body, b'X' * body.stat().st_size, 'STATIC_ASSET_HASH_MISMATCH')]
        for name, path, broken, error in cases:
            with self.subTest(name=name):
                original = path.read_bytes()
                try:
                    path.unlink() if broken is None else path.write_bytes(broken)
                    self.assert_store_stage_refused(archive, digest, error)
                finally:
                    path.write_bytes(original)

    def test_cli_holds_existing_deployment_lock_before_staging(self):
        self.publish_base()
        archive, digest = self.make_delta(omit=(self.unlocked,))
        arguments = ['stage_delta.py', self.candidate.name, str(archive), digest]
        with mock.patch.object(stage_delta, 'BASE', self.root), mock.patch.object(sys, 'argv', arguments):
            before = self.snapshot(self.root)
            with stage_delta.static_assets.deployment_lock(self.root):
                with mock.patch.object(stage_delta, 'stage', wraps=stage) as called:
                    with self.assertRaises(BlockingIOError):
                        stage_delta.main()
                    called.assert_not_called()
            self.assertFalse(self.candidate.exists())
            self.assertEqual(self.snapshot(self.root), before)
            # The same unmodified CLI invocation can proceed after lock release
            # and actually passes static_base through to its strict stage path.
            def stage_while_locked(*args, **kwargs):
                with self.assertRaises(BlockingIOError):
                    with stage_delta.static_assets.deployment_lock(self.root):
                        pass
                return stage(*args, **kwargs)

            output = io.StringIO()
            with mock.patch.object(stage_delta, 'stage', side_effect=stage_while_locked) as called:
                with redirect_stdout(output):
                    stage_delta.main()
                called.assert_called_once()
            self.assertEqual(json.loads(output.getvalue())['retained_in_static_store'], [self.unlocked])


if __name__ == '__main__':
    unittest.main()
