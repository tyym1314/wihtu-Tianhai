import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

from release_build import RETAINED_LOCK, record, verify_retained_assets
from stage_delta import stage, verify_tree
from test_retained_assets import asset, sha

DEPLOY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('package_release', DEPLOY / 'package-release.py')
package_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_module)


class PackageRetainedAssetTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repo = self.base / 'source'
        self.repo.mkdir()
        self.historical = asset('Historical-12345678.js')
        self.lock = {'schema': 'oasis-retained-static-v1',
                     'bundle': {'url': 'https://example.com/retained.tar.gz', 'bytes': 1, 'sha256': 'c' * 64},
                     'assets': [self.historical]}
        files = ['platform/dist/index.html', 'platform/arena/dist/index.html',
                 'platform/legacy/dist/thunder.html', 'platform/legacy/dist/tiger.html',
                 'platform/package.json', 'platform/package-lock.json',
                 'platform/legacy/build-manifest.json', 'platform/scripts/benchmark-release.mjs',
                 'platform/scripts/benchmark-workload.mjs', 'platform/scripts/benchmark-observer.mjs',
                 'platform/scripts/benchmark-evaluation.mjs', 'platform/scripts/android-game-actions.mjs']
        for name in files:
            self.write(name, b'fixture')
        self.write(self.historical['path'], b'export default 1;')
        self.write(RETAINED_LOCK, json.dumps(self.lock).encode())
        (self.repo / 'platform/deploy').mkdir()
        shutil.copyfile(DEPLOY / 'package-delta.py', self.repo / 'platform/deploy/package-delta.py')
        record(self.repo)

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def test_full_archive_contains_identical_standalone_manifest_and_every_retained_asset(self):
        out = self.base / 'release.tar.gz'
        report = package_module.package(self.repo, out)
        sidecar = out.with_suffix('.gz.manifest.json').read_bytes()
        manifest = json.loads(sidecar)
        self.assertEqual(report['files'], len(manifest))
        self.assertNotIn('RELEASE-MANIFEST.json', manifest)
        self.assertIn(RETAINED_LOCK, manifest)
        self.assertEqual(manifest[self.historical['path']], self.historical['sha256'])
        extracted = self.base / 'fresh'
        extracted.mkdir()
        with tarfile.open(out, 'r:gz') as bundle:
            self.assertEqual(bundle.extractfile('RELEASE-MANIFEST.json').read(), sidecar)
            self.assertEqual(set(bundle.getnames()), {*manifest, 'RELEASE-MANIFEST.json'})
            # Extract only verified ordinary fixture files, independent of local dist.
            for entry in bundle:
                self.assertTrue(entry.isfile())
                path = extracted / entry.name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bundle.extractfile(entry).read())
        verify_tree(extracted, manifest)
        verify_retained_assets(extracted)

    def test_unchanged_delta_tool_accepts_sidecar_and_new_stage_preserves_contract(self):
        out = self.base / 'old.tar.gz'
        package_module.package(self.repo, out)
        old_manifest = json.loads(out.with_suffix('.gz.manifest.json').read_text())
        previous = self.base / 'previous'
        shutil.copytree(self.repo, previous)
        (previous / 'RELEASE-MANIFEST.json').write_text(json.dumps(old_manifest))
        self.write('platform/dist/index.html', b'new admin entry')
        record(self.repo)
        new_out = self.base / 'new.tar.gz'
        package_module.package(self.repo, new_out)
        delta = self.base / 'delta.tar.gz'
        completed = subprocess.run([sys.executable, str(self.repo / 'platform/deploy/package-delta.py'),
                                    str(out.with_suffix('.gz.manifest.json')),
                                    str(new_out.with_suffix('.gz.manifest.json')), str(delta)],
                                   capture_output=True, text=True, check=True)
        report = json.loads(completed.stdout)
        candidate = self.base / 'candidate'
        stage(previous, candidate, delta, report['sha256'])
        self.assertEqual((candidate / 'platform/dist/index.html').read_bytes(), b'new admin entry')
        self.assertEqual((previous / 'platform/dist/index.html').read_bytes(), b'fixture')
        verify_retained_assets(candidate)

    def test_package_refuses_missing_or_modified_retained_asset(self):
        self.write(self.historical['path'], b'different historical bytes')
        out = self.base / 'bad.tar.gz'
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_HASH_MISMATCH'):
            package_module.package(self.repo, out)
        self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
