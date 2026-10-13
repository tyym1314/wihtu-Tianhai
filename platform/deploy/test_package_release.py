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

    def test_private_build_modes_are_readable_in_full_delta_and_inherited_stage(self):
        arena = self.repo / 'platform/arena/dist/index.html'
        arena.chmod(0o600)
        full = self.base / 'private-build.tar.gz'
        package_module.package(self.repo, full)
        with tarfile.open(full, 'r:gz') as bundle:
            self.assertEqual(bundle.getmember('platform/arena/dist/index.html').mode, 0o644)
        old_manifest = json.loads(full.with_suffix('.gz.manifest.json').read_text())
        previous = self.base / 'private-previous'
        shutil.copytree(self.repo, previous)
        (previous / 'RELEASE-MANIFEST.json').write_text(json.dumps(old_manifest))
        (previous / 'platform/arena/dist').chmod(0o700)
        self.write('platform/dist/index.html', b'new entry under private umask')
        (self.repo / 'platform/dist/index.html').chmod(0o600)
        record(self.repo)
        updated = self.base / 'private-updated.tar.gz'
        package_module.package(self.repo, updated)
        delta = self.base / 'private-delta.tar.gz'
        completed = subprocess.run([sys.executable, str(self.repo / 'platform/deploy/package-delta.py'),
                                    str(full.with_suffix('.gz.manifest.json')),
                                    str(updated.with_suffix('.gz.manifest.json')), str(delta)],
                                   capture_output=True, text=True, check=True)
        with tarfile.open(delta, 'r:gz') as bundle:
            self.assertEqual(bundle.getmember('platform/dist/index.html').mode, 0o644)
        candidate = self.base / 'private-candidate'
        stage(previous, candidate, delta, json.loads(completed.stdout)['sha256'])
        self.assertEqual((candidate / 'platform/arena/dist/index.html').stat().st_mode & 0o777, 0o644)
        self.assertEqual((candidate / 'platform/arena/dist').stat().st_mode & 0o777, 0o755)
        self.assertEqual((candidate / 'platform/dist/index.html').stat().st_mode & 0o777, 0o644)
        self.assertEqual((previous / 'platform/arena/dist/index.html').stat().st_mode & 0o777, 0o600)
        self.assertEqual((previous / 'platform/arena/dist').stat().st_mode & 0o777, 0o700)

    def test_package_refuses_missing_or_modified_retained_asset(self):
        self.write(self.historical['path'], b'different historical bytes')
        out = self.base / 'bad.tar.gz'
        with self.assertRaisesRegex(ValueError, 'RETAINED_ASSET_HASH_MISMATCH'):
            package_module.package(self.repo, out)
        self.assertFalse(out.exists())

    def test_real_archive_excludes_local_metadata_and_deploy_test_or_mock_sources(self):
        excluded = ('platform/deploy/mock-sandbox/install.py',
                    'platform/deploy/fixtures/history/PROVENANCE.json',
                    'platform/deploy/production-instance/fixtures/old/bootstrap.mjs',
                    'platform/deploy/test_stage_delta.py',
                    'platform/deploy/production-instance/production-instance.test.mjs',
                    'src/.DS_Store', 'src/._engine.mjs', 'src/Thumbs.db',
                    'platform/server/desktop.ini', 'platform/shared/.idea/workspace.xml',
                    'platform/specs/.vscode/settings.json', 'platform/deploy/.cache/check.json',
                    'platform/dist/.DS_Store', 'platform/arena/dist/._index.html',
                    'platform/legacy/dist/.cache/generated.js',
                    'platform/dist/.idea/workspace.xml', 'platform/arena/.cache/engine.mjs',
                    'platform/dist/__MACOSX/._index.html')
        kept = ('src/build/engine.mjs', 'platform/server/build/compiled.mjs',
                'platform/dist/build/chunk.js', 'platform/arena/dist/assets/Current-12345678.js',
                'platform/legacy/dist/cache/normal.js', 'platform/dist/.well-known/config.json',
                'platform/specs/DS_Store.md')
        for name in (*excluded, *kept):
            self.write(name, ('fixture ' + name).encode())
        record(self.repo)
        out = self.base / 'filtered.tar.gz'
        package_module.package(self.repo, out)
        sidecar = out.with_suffix('.gz.manifest.json').read_bytes()
        manifest = json.loads(sidecar)
        with tarfile.open(out, 'r:gz') as bundle:
            self.assertEqual(bundle.extractfile('RELEASE-MANIFEST.json').read(), sidecar)
            self.assertEqual(set(bundle.getnames()), {*manifest, 'RELEASE-MANIFEST.json'})
            for name in excluded:
                self.assertNotIn(name, manifest)
                self.assertNotIn(name, bundle.getnames())
                self.assertEqual((self.repo / name).read_bytes(), ('fixture ' + name).encode())
            for name in (*kept, self.historical['path'], RETAINED_LOCK):
                content = bundle.extractfile(name).read()
                self.assertEqual(content, (self.repo / name).read_bytes())
                self.assertEqual(hashlib.sha256(content).hexdigest(), manifest[name])
            self.assertEqual(manifest[self.historical['path']], self.historical['sha256'])

    def test_metadata_filter_does_not_weaken_file_symlink_rejection(self):
        target = self.base / 'outside.mjs'
        target.write_text('outside')
        for name in ('src/linked.mjs', 'src/.DS_Store', 'platform/dist/._index.html'):
            with self.subTest(name=name):
                path = self.repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(target)
                record(self.repo)
                out = self.base / 'unsafe.tar.gz'
                with self.assertRaisesRegex(ValueError, 'UNSAFE_RELEASE_PATH'):
                    package_module.package(self.repo, out)
                self.assertFalse(out.exists())
                path.unlink()

    def test_directory_symlink_remains_rejected(self):
        target = self.base / 'outside-src'
        target.mkdir()
        (target / 'engine.mjs').write_text('outside')
        (self.repo / 'src').symlink_to(target, target_is_directory=True)
        record(self.repo)
        out = self.base / 'unsafe.tar.gz'
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RELEASE_PATH'):
            package_module.package(self.repo, out)
        self.assertFalse(out.exists())

    def test_checkout_ancestor_named_cache_is_not_filtered(self):
        parent = self.base / '.cache'
        parent.mkdir()
        self.repo = self.repo.rename(parent / 'source')
        out = self.base / 'nested-checkout.tar.gz'
        package_module.package(self.repo, out)
        with tarfile.open(out, 'r:gz') as bundle:
            self.assertEqual(bundle.extractfile(self.historical['path']).read(), b'export default 1;')
            self.assertIn('platform/dist/index.html', bundle.getnames())


if __name__ == '__main__':
    unittest.main()
