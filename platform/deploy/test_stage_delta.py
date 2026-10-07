import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from release_build import RETAINED_LOCK
from stage_delta import stage
from test_retained_assets import asset, sha


class StageRetainedAssetTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
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


if __name__ == '__main__':
    unittest.main()
