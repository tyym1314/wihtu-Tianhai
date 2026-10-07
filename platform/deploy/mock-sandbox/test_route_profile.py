"""Offline profile fixtures. Synthetic pins are never exposed by a CLI."""
import copy
import io
import os
from pathlib import Path
import types
import unittest
from unittest.mock import patch


def load(name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


HERE = Path(__file__).resolve().parent
profile = load('mock_route_profile_test', HERE / 'route_profile.py')
fixtures = load('mock_route_profile_fixtures', HERE / 'test_asset_bundle.py')


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.BundleTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        for target, field, value in ((profile, 'bundle', fixtures.bundle),
                                      (profile.routes, 'bundle', fixtures.bundle),
                                      (profile.store, 'bundle', fixtures.bundle)):
            patch.object(target, field, value).start()
        self.apk = b'fixture-apk'
        self.old_json = {'apk': Path(profile.APK).name, 'version': '1.2.0', 'version_code': 5,
                         'sha256': fixtures.bundle.sha(self.apk), 'game_count': 13,
                         'device_verification': 'not_performed_by_build'}
        self.new_json = dict(self.old_json, schema_version=2, variant='historical-live',
                             distribution_status='historical-qa', origin='https://game.tianyahuyu.com',
                             package_name='com.tianyahuyu.oasis.smoke',
                             launch_activity='com.tianyahuyu.oasis.smoke.MainActivity')
        template = (HERE / 'mock.nginx.conf.example').read_bytes()
        self.old_files = {profile.TEMPLATE: template, profile.APK: self.apk}
        self.new_files = dict(self.old_files)
        for name in profile.MUTABLE:
            self.old_files[name] = b'old fixture ' + name.encode()
            self.new_files[name] = b'new fixture ' + name.encode()
        self.old_files[profile.JSON_PATH] = fixtures.bundle.encoded(self.old_json)
        self.new_files[profile.JSON_PATH] = fixtures.bundle.encoded(self.new_json)
        patch.object(profile, 'APK_SHA', fixtures.bundle.sha(self.apk)).start()
        patch.object(profile, 'APK_BYTES', len(self.apk)).start()
        self.prepare()
        self.parent = self.root / 'store'
        self.material = self.root / 'materials'
        self.config = self.root / 'nginx.conf'
        self.subject = profile.store.Store(self.parent, owner=os.geteuid())
        self.addCleanup(self.unseal)

    def prepare(self):
        self.fixture.bodies.update(self.new_files)
        self.fixture.manifest = {k: fixtures.bundle.sha(v) for k, v in self.fixture.bodies.items()}
        old = {k: fixtures.bundle.sha(v) for k, v in self.old_files.items()}
        old['platform/server/index.mjs'] = self.fixture.manifest['platform/server/index.mjs']
        self.old_manifest = fixtures.bundle.encoded(old)
        self.new_manifest = fixtures.bundle.encoded(self.fixture.manifest)
        self.fixture.sources['manifest'] = self.new_manifest
        self.fixture.report['old_manifest'] = fixtures.bundle.sha(self.old_manifest)
        self.fixture.report['new_manifest'] = fixtures.bundle.sha(self.new_manifest)
        self.fixture.pins['old_manifest'] = fixtures.bundle.sha(self.old_manifest)
        self.fixture.update_evidence()
        self.fixture.write_source()
        self.fixture.compile()
        self.source = self.root / 'output/bundle.tar'
        patch.object(profile, 'MANIFEST_PINS', {'04': fixtures.bundle.sha(self.old_manifest),
                                              '05': fixtures.bundle.sha(self.new_manifest)}).start()
        patch.object(profile, 'MANIFEST_COUNTS', {'04': len(old), '05': len(self.fixture.manifest)}).start()
        mutable = copy.deepcopy(profile.MUTABLE)
        for name in mutable:
            mutable[name]['04'] = (fixtures.bundle.sha(self.old_files[name]), len(self.old_files[name]))
            mutable[name]['05'] = (fixtures.bundle.sha(self.new_files[name]), len(self.new_files[name]))
        patch.object(profile, 'MUTABLE', mutable).start()
        self.inputs = {'old_manifest': self.old_manifest, 'new_manifest': self.new_manifest,
                       'old_files': self.old_files, 'new_files': self.new_files,
                       'asset_bundle': self.source.read_bytes()}

    def unseal(self):
        if self.parent.exists():
            for root, _dirs, _files in os.walk(self.parent):
                os.chmod(root, 0o755)

    def artifacts(self):
        return profile.build_profiles(**self.inputs)

    def installed_fixture(self, kind='overlay'):
        values = self.artifacts()
        self.subject.install(self.source)
        self.material.mkdir(mode=0o755)
        self.material.chmod(0o755)
        for name, raw in values.items():
            path = self.material / name
            path.write_bytes(raw)
            path.chmod(0o444)
        self.config.write_bytes(values[kind + '.conf'])
        self.config.chmod(0o644)

    def verify(self):
        return profile.verify_profile_files(self.inputs, self.config, self.source,
                                            store_parent=self.parent, material_root=self.material,
                                            owner=os.geteuid())

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.lstat().st_ino, p.lstat().st_mode, p.lstat().st_mtime_ns,
                                               p.read_bytes() if p.is_file() else None)
                for p in self.root.rglob('*')}

    def test_pure_builder_never_opens_files_or_claims_installation(self):
        with patch.object(os, 'open', side_effect=AssertionError('no filesystem reads')):
            values = self.artifacts()
            self.assertEqual(values, self.artifacts())
        receipt = profile.bundle.json_value(values['receipt.json'])
        for field in ('release_trees_verified', 'store_checked', 'installed', 'http_verified', 'apply_allowed'):
            self.assertFalse(receipt[field])
        self.assertEqual(values[profile.CANONICAL_JSON], self.new_files[profile.JSON_PATH])
        original = self.old_files[profile.TEMPLATE].replace(b'mock-game.example.invalid', profile.routes.HOST.encode()).replace(b'/live/ANDROID_MOCK/', b'/live/oasis-android-mock/')
        self.assertEqual(values['original.conf'], original)
        # The complete existing vhost is preserved; only insert before its final brace.
        self.assertTrue(values['overlay.conf'].startswith(original[:-2]))

    def test_exact_two_configs_only_no_extra_include_or_directive(self):
        values = self.artifacts()
        for name in ('original', 'overlay'):
            actual = values[name + '.conf']
            self.assertEqual(profile.classify_config_bytes(actual, **self.inputs)['profile'], name)
            for bad in (actual + b'\n', actual + b'include /etc/nginx/foreign.conf;\n',
                        actual.replace(b'18981', b'18881'), actual[:-2]):
                with self.subTest(name=name, bad=bad[-40:]), self.assertRaisesRegex(ValueError, 'UNKNOWN_ROUTE_PROFILE'):
                    profile.classify_config_bytes(bad, **self.inputs)

    def test_four_mutable_aliases_have_explicit_cache_method_and_no_spa_contract(self):
        config = self.artifacts()['overlay.conf'].decode()
        for name, policy in profile.MUTABLE.items():
            url = '/' + name.removeprefix('platform/dist/')
            location = config.split('location = ' + url + ' {', 1)[1].split('\n}', 1)[0]
            for token in ('open_file_cache off;', 'max_ranges 0;', 'gzip off;',
                          'if_modified_since off;', 'etag on;', 'Cache-Control no-store always;',
                          'error_page 403 404 =404 @oasis_mock_mutable_missing;',
                          'if ($request_method !~ "^(GET|HEAD)$")', f'if ($request_uri != "{url}")'):
                self.assertIn(token, location)
            self.assertIn('default_type ' + policy['mime'] + ';', location)
            self.assertNotIn('try_files', location)
            self.assertNotIn('return 412', location)
            if name == profile.JSON_PATH:
                self.assertIn('alias ' + str(profile.PROFILE_ROOT / profile.CANONICAL_JSON), location)
                self.assertNotIn(profile.CURRENT, location)
            else:
                self.assertIn('alias ' + profile.CURRENT + '/' + name, location)
                self.assertIn('disable_symlinks on from=' + profile.CURRENT, location)
        self.assertIn('filename="oasis-partner-sandbox-kit.zip"', config)
        self.assertIn('add_header Allow "GET, HEAD" always;', config)

    def test_unknown_manifests_or_body_pairs_refused(self):
        for field in ('old_manifest', 'new_manifest', 'asset_bundle'):
            changed = dict(self.inputs, **{field: self.inputs[field] + b'\n'})
            with self.subTest(field=field), self.assertRaises((ValueError, profile.tarfile.TarError)):
                profile.build_profiles(**changed)
        for field in ('old_files', 'new_files'):
            for name in profile.SELECTED:
                changed = dict(self.inputs, **{field: dict(self.inputs[field], **{name: b'third content'})})
                with self.subTest(field=field, name=name), self.assertRaisesRegex(ValueError, 'PROFILE_SOURCE_HASH'):
                    profile.build_profiles(**changed)

    def test_selected_source_set_is_exact(self):
        for value in (dict(self.old_files, extra=b'untrusted'), {k: v for k, v in self.old_files.items() if k != profile.APK}):
            with self.assertRaisesRegex(ValueError, 'PROFILE_SOURCE_SET'):
                profile.build_profiles(**dict(self.inputs, old_files=value))

    def test_semantic_metadata_checks_survive_a_different_fixture_hash(self):
        # Test the independent semantic guard without changing production pins.
        for field, value in (('schema_version', 1), ('origin', profile.bundle.ORIGIN),
                             ('variant', 'mock'), ('version_code', 6), ('sha256', '0' * 64)):
            bad = dict(self.new_json, **{field: value})
            raw = profile.bundle.encoded(bad)
            changed = dict(self.inputs, new_files=dict(self.new_files, **{profile.JSON_PATH: raw}))
            with patch.object(profile, 'checked_selected'), self.subTest(field=field), \
                    self.assertRaisesRegex(ValueError, 'PROFILE_METADATA_IDENTITY'):
                profile.build_profiles(**changed)

    def test_original_file_check_does_not_require_an_overlay_store(self):
        self.config.write_bytes(self.artifacts()['original.conf'])
        self.config.chmod(0o644)
        result = self.verify()
        self.assertEqual(result['profile'], 'original')
        self.assertTrue(result['filesystem_verified'])
        self.assertFalse(result['store_checked'])
        self.assertFalse(self.parent.exists())

    def test_relocated_complete_store_and_materials_checked_without_writes(self):
        self.installed_fixture()
        before = self.snapshot()
        with patch.object(os, 'rename', side_effect=AssertionError('write')), \
             patch.object(Path, 'mkdir', side_effect=AssertionError('write')):
            result = self.verify()
        self.assertEqual(before, self.snapshot())
        for field in ('filesystem_verified', 'store_checked', 'material_files_verified', 'relocated_fixture'):
            self.assertTrue(result[field])
        for field in ('http_verified', 'active_config_verified', 'pin_verified', 'apply_allowed'):
            self.assertFalse(result[field])

    def test_overlay_absent_or_incomplete_store_is_refused_not_created(self):
        self.config.write_bytes(self.artifacts()['overlay.conf'])
        self.config.chmod(0o644)
        with self.assertRaises(FileNotFoundError):
            self.verify()
        self.assertFalse(self.parent.exists())
        self.subject.install(self.source)
        (self.parent / profile.store.RECEIPT).unlink()
        with self.assertRaisesRegex(ValueError, 'STORE_INSTALL_INCOMPLETE'):
            self.verify()
        self.assertFalse((self.parent / profile.store.RECEIPT).exists())

    def test_material_receipt_body_extra_file_and_permissions_refused(self):
        self.installed_fixture()
        for name in (profile.CANONICAL_JSON, 'receipt.json', 'overlay.conf'):
            path = self.material / name
            old = path.read_bytes()
            path.chmod(0o644)
            path.write_bytes(old + b'x')
            path.chmod(0o444)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'PROFILE_FILE_LENGTH|PROFILE_MATERIAL_CHANGED'):
                self.verify()
            path.chmod(0o644)
            path.write_bytes(old)
            path.chmod(0o444)
        (self.material / 'extra').write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'PROFILE_MATERIAL_MEMBERS'):
            self.verify()
        (self.material / 'extra').unlink()
        (self.material / profile.CANONICAL_JSON).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PROFILE_FILE_PERMISSIONS'):
            self.verify()

    def test_config_symlink_hardlink_and_foreign_bytes_refuse_before_store(self):
        self.config.symlink_to(self.root / 'absent')
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            self.verify()
        self.config.unlink()
        self.config.write_bytes(self.artifacts()['overlay.conf'])
        self.config.chmod(0o644)
        os.link(self.config, self.root / 'other')
        with self.assertRaisesRegex(ValueError, 'LOCAL_NOT_REGULAR'):
            self.verify()
        (self.root / 'other').unlink()
        self.config.write_bytes(b'foreign include')
        with self.assertRaisesRegex(ValueError, 'UNKNOWN_ROUTE_PROFILE'):
            self.verify()
        self.assertFalse(self.parent.exists())

    def test_material_symlink_and_hardlink_are_never_followed(self):
        self.installed_fixture()
        target = self.material / profile.CANONICAL_JSON
        target.unlink()
        target.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            self.verify()
        target.unlink()
        target.write_bytes(self.new_files[profile.JSON_PATH])
        target.chmod(0o444)
        os.link(target, self.root / 'linked-json')
        with self.assertRaisesRegex(ValueError, 'LOCAL_NOT_REGULAR'):
            self.verify()

    def test_store_body_drift_is_not_excused_by_an_exact_profile(self):
        self.installed_fixture()
        target = next(self.subject.final.rglob('*.js'))
        original = target.read_bytes()
        target.chmod(0o644)
        target.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        target.chmod(0o444)
        os.utime(target, ns=(profile.store.MTIME_NS, profile.store.MTIME_NS))
        with self.assertRaisesRegex(ValueError, 'STORE_BODY_MISMATCH'):
            self.verify()
        self.assertNotEqual(target.read_bytes(), original)

    def test_config_permissions_and_different_bundle_refused(self):
        self.installed_fixture()
        self.config.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'PROFILE_FILE_PERMISSIONS'):
            self.verify()
        self.config.chmod(0o644)
        self.source.write_bytes(self.inputs['asset_bundle'] + b'bad')
        with self.assertRaisesRegex(ValueError, 'PROFILE_STORE_BUNDLE_CHANGED'):
            self.verify()

    def test_release_reader_verifies_nonselected_declared_files_and_symlinks(self):
        release = self.root / 'old-release'
        release.mkdir()
        (release / 'RELEASE-MANIFEST.json').write_bytes(self.old_manifest)
        bodies = dict(self.old_files, **{'platform/server/index.mjs': self.fixture.bodies['platform/server/index.mjs']})
        for name, raw in bodies.items():
            target = release / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        self.assertEqual(profile.read_release_inputs(release, '04'), (self.old_manifest, self.old_files))
        target = release / 'platform/server/index.mjs'
        target.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'PROFILE_RELEASE_FILE_HASH'):
            profile.read_release_inputs(release, '04')
        target.unlink()
        target.symlink_to(release / profile.JSON_PATH)
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            profile.read_release_inputs(release, '04')


if __name__ == '__main__':
    unittest.main()
