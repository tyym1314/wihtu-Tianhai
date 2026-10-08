"""Offline candidate/byteguard tests; not systemd, TLS or Linux startup proof.

Historical material tests use the existing explicit synthetic profile pins.
Dependency tests separately verify the unmodified production source pins.
No Nginx parser, service command, network request or system path is touched.
"""
import builtins
import hashlib
import os
from pathlib import Path
import re
import tempfile
import types
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent


def load(name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


ingress = load('dedicated_ingress_test', HERE / 'dedicated_ingress.py')
fixtures = load('dedicated_ingress_profile_fixtures', HERE / 'test_route_profile.py')


def replaced_profile(raw):
    """The only three permitted edits to a previously verified full vhost."""
    return (raw.replace(b'    listen 443 ssl http2;',
                        b'    listen 127.0.0.1:18986 ssl http2;')
            .replace(b'/opt/oasis/acme/config/live/oasis-android-mock/fullchain.pem',
                     (ingress.CREDENTIALS + '/fullchain.pem').encode())
            .replace(b'/opt/oasis/acme/config/live/oasis-android-mock/privkey.pem',
                     (ingress.CREDENTIALS + '/privkey.pem').encode()))


class OriginalTests(unittest.TestCase):
    def test_exact_original_is_preserved_inside_standalone_enclosure(self):
        raw = ingress.original_profile()
        result = ingress.build_config(raw)
        self.assertTrue(result.endswith(replaced_profile(raw) + b'}\n'))
        self.assertEqual(result.count(b'    listen '), 1)
        self.assertNotIn(b'listen 443', result)
        for upstream in (b'http://127.0.0.1:18981', b'http://127.0.0.1:18985'):
            self.assertEqual(result.count(upstream), raw.count(upstream))
        self.assertNotIn(b':18881', result)
        self.assertNotIn(b':18885', result)

    def test_arbitrary_fragments_suffixes_and_listener_changes_are_refused(self):
        original = ingress.original_profile()
        for raw in (b'', 'server {}', original.decode(), bytearray(original),
                    b'server { listen 18986; }', original + b'\n',
                    original + b'include /etc/nginx/conf.d/*.conf;\n',
                    original.replace(b'18981', b'18881'), original[:-2],
                    original.replace(b'443 ssl', b'9443 ssl')):
            with self.subTest(kind=type(raw).__name__), \
                    self.assertRaisesRegex(ValueError, 'INGRESS_UNVERIFIED_PROFILE'):
                ingress.build_config(raw)

    def test_original_template_hash_cannot_be_overridden_by_profile_input(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmp:
            path = Path(tmp) / 'mock.nginx.conf.example'
            path.write_bytes((HERE / path.name).read_bytes() + b'\n')
            with patch.object(ingress, 'HERE', Path(tmp)), \
                    self.assertRaisesRegex(ValueError, 'INGRESS_TEMPLATE_CHANGED'):
                ingress.build_config(ingress.original_profile())

    def test_every_writable_nginx_destination_is_explicit_and_private(self):
        config = ingress.build_config(ingress.original_profile()).decode()
        expected = {'client_body_temp_path': 'body', 'proxy_temp_path': 'proxy',
                    'fastcgi_temp_path': 'fastcgi', 'uwsgi_temp_path': 'uwsgi',
                    'scgi_temp_path': 'scgi', 'pid': 'nginx.pid', 'lock_file': 'nginx.lock'}
        for directive, suffix in expected.items():
            self.assertEqual(re.findall(r'^\s*' + directive + r'\s+([^;]+);', config, re.M),
                             [ingress.RUNTIME + '/' + suffix])
        self.assertEqual(re.findall(r'^\s*error_log\s+([^;]+);', config, re.M), ['stderr notice'])
        self.assertEqual(re.findall(r'^\s*access_log\s+([^;]+);', config, re.M), ['off'])
        self.assertIsNone(re.search(r'^\s*(?:include|user)\s', config, re.M))
        self.assertNotIn('/var/lib/nginx', config)
        self.assertNotIn('/var/log/nginx', config)

    def test_inner_redirects_cannot_advertise_the_private_tls_port(self):
        # A real Location response remains part of the native fixture. This
        # catches removal of the enclosure guard before it reaches that test.
        config = ingress.build_config(ingress.original_profile()).decode()
        self.assertEqual(re.findall(r'^\s*port_in_redirect\s+([^;]+);', config, re.M), ['off'])
        self.assertIn('location = /demo { return 308 /demo/; }', config)
        self.assertEqual(config.count('listen 127.0.0.1:18986 ssl http2;'), 1)

    def test_rootless_unit_credential_targets_match_generated_tls_files(self):
        # This checks the execution contract, not the availability/semantics of
        # LoadCredential on the destination's actual systemd installation.
        unit = (HERE / 'mock-ingress.service.example').read_text()
        entries = {}
        for line in unit.splitlines():
            if line and not line.startswith(('#', '[')):
                key, value = line.split('=', 1)
                entries.setdefault(key, []).append(value)
        self.assertEqual(entries['User'], [ingress.USER])
        self.assertEqual(entries['Group'], [ingress.USER])
        self.assertEqual(entries['RuntimeDirectory'], [Path(ingress.RUNTIME).name])
        self.assertEqual(entries['RuntimeDirectoryMode'], ['0700'])
        self.assertEqual(entries['ReadWritePaths'], [ingress.RUNTIME])
        self.assertEqual(entries['CapabilityBoundingSet'], [''])
        self.assertEqual(entries['AmbientCapabilities'], [''])
        credentials = dict(value.split(':', 1) for value in entries['LoadCredential'])
        self.assertEqual(set(credentials), {'fullchain.pem', 'privkey.pem'})
        config = ingress.build_config(ingress.original_profile()).decode()
        destinations = re.findall(r'^\s*ssl_certificate(?:_key)?\s+([^;]+);', config, re.M)
        self.assertEqual(set(destinations), {ingress.CREDENTIALS + '/' + name for name in credentials})
        self.assertEqual(ingress.CREDENTIALS, '/run/credentials/' + ingress.UNIT)
        for name, source in credentials.items():
            self.assertEqual(source, '/opt/oasis/acme/config/live/oasis-android-mock/' + name)
            self.assertNotIn(source, config)
        for key in ('ExecStartPre', 'ExecStart'):
            self.assertEqual(len(entries[key]), 1)
            self.assertTrue(entries[key][0].startswith('/usr/sbin/nginx -e stderr -p ' + ingress.PREFIX + '/ '))
            self.assertIn('-c ' + ingress.PREFIX + '/nginx.conf', entries[key][0])
            self.assertNotIn('+', entries[key][0])
        self.assertEqual(entries['ExecReload'], ['/bin/kill -HUP $MAINPID'])


class DependencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ingress.DEPENDENCIES:
            path = self.root / name
            path.write_bytes((HERE / name).read_bytes())
            path.chmod(0o644)
        self.patch = patch.object(ingress, 'HERE', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def no_exec(self):
        return patch.object(ingress, 'exec', side_effect=AssertionError('executed before verification'), create=True)

    def test_current_production_transitive_pins_load_the_real_modules(self):
        loaded = ingress.verified_profile_module()
        self.assertEqual(loaded.TEMPLATE_SHA, ingress.TEMPLATE_SHA)
        self.assertEqual(loaded.routes.HOST, ingress.HOST)
        self.assertTrue(callable(loaded.build_profiles))
        self.assertTrue(callable(loaded.store.Store))
        self.assertTrue(callable(loaded.bundle.check_bytes))

    def test_every_dependency_mismatch_refuses_before_first_exec(self):
        for name in ingress.DEPENDENCIES:
            path = self.root / name
            raw = path.read_bytes()
            path.write_bytes(raw + b'\n')
            try:
                with self.subTest(name=name), self.no_exec(), \
                        self.assertRaisesRegex(ValueError, 'INGRESS_DEPENDENCY_CHANGED'):
                    ingress.verified_profile_module()
            finally:
                path.write_bytes(raw)

    def test_missing_dependency_refuses_before_first_exec(self):
        (self.root / next(reversed(ingress.DEPENDENCIES))).unlink()
        with self.no_exec(), self.assertRaises(FileNotFoundError):
            ingress.verified_profile_module()

    def test_symlink_hardlink_and_writable_dependency_refuse_before_exec(self):
        name = next(reversed(ingress.DEPENDENCIES))
        path = self.root / name
        raw = path.read_bytes()
        for kind in ('symlink', 'hardlink', 'group-writable', 'other-writable', 'directory'):
            path.unlink()
            if kind == 'symlink':
                path.symlink_to(HERE / name)
            elif kind == 'directory':
                path.mkdir()
            else:
                path.write_bytes(raw)
                path.chmod({'group-writable': 0o664, 'other-writable': 0o646}.get(kind, 0o644))
                if kind == 'hardlink':
                    os.link(path, self.root / 'extra-link')
            with self.subTest(kind=kind), self.no_exec(), \
                    self.assertRaisesRegex(ValueError, 'INGRESS_DEPENDENCY_CHANGED'):
                ingress.verified_profile_module()
            if kind == 'directory':
                path.rmdir()
                path.write_bytes(raw)
            if kind == 'hardlink':
                (self.root / 'extra-link').unlink()

    def test_all_transitive_sources_checked_before_first_module_exec(self):
        reads, executed = [], []
        original_read = Path.read_bytes

        def read(path):
            reads.append(path.name)
            return original_read(path)

        def execute(code, globals_):
            executed.append(set(reads))
            self.assertTrue(set(ingress.DEPENDENCIES) <= set(reads))
            builtins.exec(code, globals_)

        with patch.object(Path, 'read_bytes', read), patch.object(ingress, 'exec', execute, create=True):
            ingress.verified_profile_module()
        self.assertEqual(len(executed), 1)


class VerifiedHistoricalProfilesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ProfileTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        # Only the dependency loader is replaced here: the real profile,
        # bundle/store/routes implementations run with explicit synthetic pins.
        patch.object(ingress, 'verified_profile_module', return_value=fixtures.profile).start()

    def build(self, **changes):
        return ingress.build_profile_configs(**dict(self.fixture.inputs, **changes))

    def test_complete_original_and_overlay_preserved_not_selected_locations_only(self):
        material = self.fixture.artifacts()
        configs, identity = self.build()
        self.assertEqual(set(configs), {'original.conf', 'overlay.conf'})
        for name, config in configs.items():
            self.assertTrue(config.endswith(replaced_profile(material[name]) + b'}\n'))
            self.assertEqual(identity['configs'][name], hashlib.sha256(config).hexdigest())
            self.assertEqual(identity['profile_sources'][name], hashlib.sha256(material[name]).hexdigest())
        self.assertEqual(identity['profile_receipt_sha256'], ingress.sha(material['receipt.json']))
        self.assertNotEqual(configs['original.conf'], configs['overlay.conf'])

    def test_historical_mutable_and_retained_asset_semantics_survive_render(self):
        overlay = self.build()[0]['overlay.conf'].decode()
        profile = fixtures.profile
        for name in profile.MUTABLE:
            url = '/' + name.removeprefix('platform/dist/')
            self.assertIn('location = ' + url + ' {', overlay)
        self.assertIn('Cache-Control no-store always;', overlay)
        self.assertIn('alias ' + str(profile.PROFILE_ROOT / profile.CANONICAL_JSON), overlay)
        self.assertIn('public,max-age=31536000,immutable', overlay)
        self.assertIn('if ($scheme != https)', overlay)
        self.assertIn('(:443)?$', overlay)
        self.assertIn(profile.routes.STORE, overlay)
        self.assertNotIn('(:18986)?$', overlay)

    def test_candidate_does_not_claim_store_installation_http_or_runtime_upgrade(self):
        before = self.fixture.snapshot()
        with patch.object(Path, 'mkdir', side_effect=AssertionError('unexpected installation')), \
                patch.object(Path, 'write_bytes', side_effect=AssertionError('unexpected installation')):
            _configs, identity = self.build()
        self.assertEqual(before, self.fixture.snapshot())
        self.assertFalse(identity['installed'])
        self.assertFalse(identity['shared_front_door_migrated'])
        self.assertIn('current-release-pair', identity['remaining'])
        self.assertIn('systemd-and-credential-lifecycle', identity['remaining'])
        self.assertIn('13-game-apk-acceptance', identity['remaining'])
        self.assertFalse(self.fixture.parent.exists())

    def test_overlay_cannot_enter_original_only_api(self):
        with self.assertRaisesRegex(ValueError, 'INGRESS_UNVERIFIED_PROFILE'):
            ingress.build_config(self.fixture.artifacts()['overlay.conf'])

    def test_manifest_bundle_and_selected_body_guards_not_bypassed(self):
        for field in ('old_manifest', 'new_manifest', 'asset_bundle'):
            with self.subTest(field=field), self.assertRaises((ValueError, fixtures.profile.tarfile.TarError)):
                self.build(**{field: self.fixture.inputs[field] + b'\n'})
        for field in ('old_files', 'new_files'):
            for name in fixtures.profile.SELECTED:
                with self.subTest(field=field, name=name), self.assertRaisesRegex(ValueError, 'PROFILE_SOURCE_HASH'):
                    self.build(**{field: dict(self.fixture.inputs[field], **{name: b'unknown'})})

    def test_source_set_and_foreign_config_receipt_parameters_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'PROFILE_SOURCE_SET'):
            self.build(old_files=dict(self.fixture.old_files, unexpected=b'include external;'))
        for name in ('profile_bytes', 'config', 'receipt', 'manifest_pin', 'installed'):
            with self.subTest(name=name), self.assertRaises(TypeError):
                self.build(**{name: b'caller-controlled'})

    def test_real_filesystem_verifier_still_rejects_missing_or_corrupt_overlay_store(self):
        # A pure generated candidate cannot be used as filesystem activation
        # evidence. Exercise the real existing verifier, not a fake receipt.
        self.build()
        self.fixture.config.write_bytes(self.fixture.artifacts()['overlay.conf'])
        self.fixture.config.chmod(0o644)
        with self.assertRaises(FileNotFoundError):
            self.fixture.verify()
        self.fixture.installed_fixture()
        self.assertTrue(self.fixture.verify()['store_checked'])
        target = next(self.fixture.subject.final.rglob('*.js'))
        target.chmod(0o644)
        target.write_bytes(b'corrupt')
        target.chmod(0o444)
        with self.assertRaisesRegex(ValueError, 'STORE_FILE|STORE_BODY'):
            self.fixture.verify()


if __name__ == '__main__':
    unittest.main()
