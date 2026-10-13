import tempfile
import unittest
import hashlib
import json
from pathlib import Path
from release_build import record, verify


class ReleaseBuildGateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('platform/dist/index.html', 'platform/arena/dist/index.html',
                     'platform/legacy/dist/thunder.html', 'platform/legacy/dist/tiger.html',
                     'platform/arena/main.jsx'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
        asset = self.root / 'platform/arena/dist/assets/Old-12345678.js'
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_text('retained fixture')
        (self.root / 'platform/retained-assets.lock.json').write_text(json.dumps({
            'schema': 'oasis-retained-static-v1',
            'bundle': {'url': 'https://example.com/retained.tar.gz', 'sha256': 'a' * 64, 'bytes': 1},
            'assets': [{'path': asset.relative_to(self.root).as_posix(),
                        'publicPath': '/arena/assets/Old-12345678.js',
                        'sha256': hashlib.sha256(asset.read_bytes()).hexdigest(), 'bytes': asset.stat().st_size,
                        'contentType': 'application/javascript', 'dependencies': [],
                        'sources': [{'release': '20261007-04', 'manifest_sha256': 'b' * 64}]}]}))

    def test_requires_all_three_browser_builds(self):
        (self.root / 'platform/arena/dist/index.html').unlink()
        with self.assertRaisesRegex(ValueError, 'MISSING_BROWSER_BUILD'):
            record(self.root)

    def test_rejects_new_game_source_after_build(self):
        record(self.root)
        verify(self.root)
        (self.root / 'platform/arena/towerlink.jsx').write_text('new game')
        with self.assertRaisesRegex(ValueError, 'STALE_BUILD_INPUTS'):
            verify(self.root)

    def test_rejects_altered_and_missing_browser_assets(self):
        record(self.root)
        asset = self.root / 'platform/arena/dist/old.js'
        asset.write_text('old bundle')
        with self.assertRaisesRegex(ValueError, 'STALE_BUILD_OUTPUTS'):
            verify(self.root)
        record(self.root)
        asset.unlink()
        with self.assertRaisesRegex(ValueError, 'STALE_BUILD_OUTPUTS'):
            verify(self.root)

    def test_rejects_changed_server_source_after_build(self):
        for name in ('platform/server/wallet/index.mjs',
                     'platform/server/wallet/security.mjs',
                     'platform/server/wallet/schema.sql',
                     'platform/server/math/index.ts'):
            with self.subTest(source=name):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original kit source')
                record(self.root)
                verify(self.root)
                path.write_text('updated kit source')
                with self.assertRaisesRegex(ValueError, 'STALE_BUILD_INPUTS'):
                    verify(self.root)

    def test_requires_successful_full_build_stamp(self):
        with self.assertRaisesRegex(ValueError, 'FULL_RELEASE_BUILD_REQUIRED'):
            verify(self.root)

    def test_local_metadata_changes_do_not_invalidate_inputs_or_outputs(self):
        names = ('src/.DS_Store', 'platform/public/._banner.png',
                 'platform/server/Thumbs.db', 'platform/src/Desktop.ini',
                 'platform/shared/.idea/workspace.xml',
                 'platform/arena/.vscode/settings.json',
                 'platform/specs/.cache/index.json',
                 'platform/arena/dist/.DS_Store',
                 'platform/dist/.cache/generated.js',
                 'platform/legacy/dist/.idea/workspace.xml')
        cache_dirs = ('.AppleDouble', '__MACOSX', '.pytest_cache', '.mypy_cache',
                      '.ruff_cache', '.gradle', '.parcel-cache', '.vite', '.turbo')
        names += tuple('platform/src/' + part + '/local-data' for part in cache_dirs)
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('local metadata before build')
        manifest = record(self.root)
        for name in names:
            self.assertNotIn(name, manifest['inputs'])
            self.assertNotIn(name, manifest['outputs'])
            (self.root / name).write_text('local metadata changed after build')
        (self.root / 'platform/dist/._new-output').write_text('new metadata')
        (self.root / 'platform/arena/.DS_Store').write_text('new metadata')
        self.assertEqual(verify(self.root), manifest)
        for name in names:
            self.assertEqual((self.root / name).read_text(), 'local metadata changed after build')

    def test_build_directories_and_similarly_named_files_remain_fingerprinted(self):
        cases = {'src/build/engine.mjs': 'inputs',
                 'platform/server/build/compiled.mjs': 'inputs',
                 'platform/src/cache/data.json': 'inputs',
                 'platform/public/.well-known/config.json': 'inputs',
                 'platform/arena/dist/build/generated.js': 'outputs',
                 'platform/dist/cache/runtime.js': 'outputs',
                 'platform/legacy/dist/DS_Store.js': 'outputs'}
        for name in cases:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('real build content')
        manifest = record(self.root)
        for name, group in cases.items():
            with self.subTest(name=name):
                self.assertIn(name, manifest[group])
                (self.root / name).write_text('real content changed')
                with self.assertRaisesRegex(ValueError, 'STALE_BUILD_' + group.upper()):
                    verify(self.root)
                (self.root / name).write_text('real build content')
        self.assertEqual(verify(self.root), manifest)


if __name__ == '__main__':
    unittest.main()
