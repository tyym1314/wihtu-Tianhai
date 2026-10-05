import tempfile
import unittest
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

    def test_rejects_changed_partner_kit_source_after_build(self):
        for name in ('platform/server/wallet/index.mjs',
                     'platform/server/wallet/security.mjs',
                     'platform/server/wallet/schema.sql',
                     'platform/server/math/index.ts',
                     'platform/examples/partner-wallet/server.mjs',
                     'platform/examples/partner-wallet/config.example.json',
                     'platform/examples/partner-wallet/README.md'):
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


if __name__ == '__main__':
    unittest.main()
