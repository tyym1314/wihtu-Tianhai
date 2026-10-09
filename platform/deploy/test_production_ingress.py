import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote

MODULE = Path(__file__).with_name('production-ingress.py')
spec = importlib.util.spec_from_file_location('production_ingress', MODULE)
ingress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingress)
BINDING = {'release': '/opt/oasis/releases/20261010-01', 'manifest_sha256': 'a' * 64,
           'tool_sha256': 'b' * 64}


def location_blocks(config):
    """Read generated locations including nested MIME tables for route contracts."""
    result = []
    for match in re.finditer(r'\blocation\s+(?:(=|\^~|~\*?)\s+)?([^\s{]+)\s*\{', config):
        depth, end = 1, match.end()
        while depth and end < len(config):
            depth += (config[end] == '{') - (config[end] == '}')
            end += 1
        if depth:
            raise AssertionError('Unclosed generated location')
        result.append((match.group(1) or '', match.group(2), config[match.end():end - 1]))
    return result


def selected_location(locations, request_path):
    """Model Nginx URI normalization and exact/prefix/first-regex precedence only."""
    path = posixpath.normpath(unquote(request_path))
    if request_path.endswith('/') and not path.endswith('/'):
        path += '/'
    for kind, pattern, body in locations:
        if kind == '=' and path == pattern:
            return pattern, body
    prefixes = [(kind, pattern, body) for kind, pattern, body in locations
                if kind in ('', '^~') and not pattern.startswith('@') and path.startswith(pattern)]
    prefix = max(prefixes, key=lambda item: len(item[1])) if prefixes else None
    if prefix and prefix[0] == '^~':
        return prefix[1], prefix[2]
    for kind, pattern, body in locations:
        if kind in ('~', '~*') and re.search(pattern, path, re.I if kind == '~*' else 0):
            return pattern, body
    return (prefix[1], prefix[2]) if prefix else (None, '')


class ProductionIngressTests(unittest.TestCase):
    def test_same_bytes_replacement_cannot_reuse_the_open_deployment_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / 'private'; private.mkdir()
            lock = private / 'release.lock'; lock.write_bytes(b'')
            with patch.object(ingress, 'BASE', root), \
                 patch.object(ingress, 'read_regular', side_effect=lambda p: p.read_bytes()):
                expected = ingress.file_pin(lock)
                fd = os.open(lock, os.O_RDONLY)
                try:
                    ingress.release_lock_guard(fd, expected)
                    replacement = private / 'replacement'; replacement.write_bytes(b'')
                    replacement.replace(lock)
                    with self.assertRaisesRegex(RuntimeError, 'SHARED_RELEASE_LOCK_REPLACED'):
                        ingress.release_lock_guard(fd, expected)
                finally:
                    os.close(fd)

    def test_failed_start_preserves_same_bytes_replacement_of_its_created_tls_file(self):
        with tempfile.TemporaryDirectory() as directory:
            tls = Path(directory) / 'own.conf'
            root = Path(directory) / 'oasis'; release = root / 'release'; release.mkdir(parents=True)
            (root / 'production-current').symlink_to(release, target_is_directory=True)
            cert = root / 'cert'; cert.mkdir()
            binding = {**BINDING, 'release': str(release.resolve())}
            def get(url):
                if url == 'http://127.0.0.1:18891/health/ready':
                    return b'{"status":"ok","environment":"production"}'
                replacement = tls.with_name('replacement.conf')
                replacement.write_bytes(tls.read_bytes()); replacement.replace(tls)
                raise RuntimeError('TLS_PROBE_FAILED')
            with patch.object(ingress, 'BASE', root), patch.object(ingress, 'TLS', tls), \
                 patch.object(ingress, 'CERT', cert), patch.object(ingress, 'public_get', side_effect=get), \
                 patch.object(ingress, 'read_regular', side_effect=lambda p: p.read_bytes()), \
                 patch.object(ingress, 'certificate_unit_guard'), \
                 patch.object(ingress, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_CONFIG_REPLACED'):
                    ingress.start(binding)
            self.assertTrue(tls.exists())

    def test_replaced_shared_proxy_is_refused_before_any_acme_write_or_reload(self):
        expected = {'id': 'a' * 64, 'image': 'sha256:' + 'b' * 64}
        replacement = {**expected, 'id': 'c' * 64}
        with patch.object(ingress, 'proxy_identity', return_value=replacement), \
             patch.object(ingress, 'exact_file') as write, \
             patch.object(ingress, 'run') as execute, \
             patch.object(Path, 'mkdir') as mkdir:
            for renew in [False, True]:
                with self.subTest(renew=renew), self.assertRaisesRegex(RuntimeError, 'SHARED_PROXY_CHANGED'):
                    ingress.certificate(BINDING, expected, renew=renew)
            write.assert_not_called()
            execute.assert_not_called()
            mkdir.assert_not_called()

    def test_actual_executing_controller_must_match_the_release(self):
        release = Path(BINDING['release'])
        html = b'actual player'
        controller = b'reviewed release controller'
        manifest = {'platform/dist/index.html': ingress.sha(html),
                    'platform/deploy/production-ingress.py': ingress.sha(controller)}
        manifest.update({member: ingress.sha(b'helper') for member in ingress.HELPER_MEMBERS.values()})
        raw = json.dumps(manifest).encode()
        contents = {release / 'RELEASE-MANIFEST.json': raw,
                    release / 'platform/dist/index.html': html,
                    release / 'platform/deploy/production-ingress.py': controller,
                    MODULE.resolve(): b'other executing controller'}
        contents.update({release / member: b'helper' for member in ingress.HELPER_MEMBERS.values()})
        with patch.object(Path, 'is_dir', return_value=True), \
             patch.object(Path, 'is_symlink', return_value=False), \
             patch.object(ingress, 'read_regular', side_effect=lambda p, *args: contents[p]):
            with self.assertRaisesRegex(RuntimeError, 'EXECUTING_CONTROLLER_CHANGED'):
                ingress.release_binding(release, ingress.sha(raw))
            contents[MODULE.resolve()] = controller
            self.assertEqual(ingress.release_binding(release, ingress.sha(raw))['tool_sha256'],
                             manifest['platform/deploy/production-ingress.py'])

    def test_commands_use_absolute_executables_and_minimal_environment(self):
        with patch.dict(os.environ, {'PATH': '/tmp/foreign', 'LD_PRELOAD': '/tmp/foreign.so',
                                    'DBUS_SYSTEM_BUS_ADDRESS': 'unix:path=/tmp/foreign',
                                    'NODE_OPTIONS': '--require=/tmp/foreign',
                                    'HTTPS_PROXY': 'http://foreign.invalid'}, clear=True), \
             patch.object(ingress.subprocess, 'run') as execute:
            execute.return_value.returncode = 0
            ingress.run(['nginx', '-t'])
            self.assertEqual(execute.call_args.args[0], ['/usr/sbin/nginx', '-t'])
            self.assertEqual(execute.call_args.kwargs['env'],
                             {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
            with self.assertRaisesRegex(RuntimeError, 'UNRECOGNIZED_OPERATOR_COMMAND'):
                ingress.run(['/tmp/foreign', '-t'])
            self.assertEqual(execute.call_count, 1)

    def test_exact_hostname_and_real_api_are_isolated_from_demo(self):
        configs = ingress.configurations(BINDING)
        tls = configs[str(ingress.TLS)].decode()
        self.assertIn('server_name oasis-player.43.98.202.236.sslip.io;', tls)
        self.assertIn('root /opt/oasis/production-current/platform/dist;', tls)
        self.assertIn('location ^~ /api/demo/ { return 410; }', tls)
        self.assertIn('location ~ ^/(api|v1|play|arena|legacy)/ { proxy_pass http://127.0.0.1:18891; }', tls)
        self.assertNotIn('18881', tls)
        self.assertNotIn('/opt/oasis/current/', tls)
        self.assertNotIn('android-mock', tls)

    def test_mutable_bootstrap_and_unversioned_images_are_not_immutable(self):
        tls = ingress.configurations(BINDING)[str(ingress.TLS)].decode()
        self.assertIn('default "public, max-age=0, must-revalidate";', tls)
        self.assertIn('add_header Cache-Control no-store always;', tls)
        self.assertNotIn('add_header Cache-Control "public, max-age=31536000, immutable";', tls)
        pattern = r'-[A-Za-z0-9_-]{8}\.(js|mjs|css|png|webp|jpe?g|svg|glb|gltf|bin|woff2?|mp3|ogg|wasm)$'
        self.assertIsNone(re.search(pattern, '/previews/golf.webp'))
        self.assertIsNotNone(re.search(pattern, '/assets/Player-AbCd1234.js'))

    def test_old_game_and_player_chunks_use_stable_store_before_current_fallback(self):
        tls = ingress.configurations(BINDING)[str(ingress.TLS)].decode()
        locations = location_blocks(tls)
        game_pattern = '^/(arena/assets|legacy/assets|legacy/bundles)/'
        player_pattern = '^/(assets|previews)/'
        for path, pattern, fallback in [
            ('/arena/assets/RunGame-QJIPAPjX.js', game_pattern, '@oasis_production_api_static'),
            ('/legacy/assets/OldGame-AbCd1234.js', game_pattern, '@oasis_production_api_static'),
            ('/legacy/bundles/OldGame-AbCd1234.js', game_pattern, '@oasis_production_api_static'),
            ('/assets/index-CtYnvOXL.js', player_pattern, '@oasis_production_player_static'),
            ('/previews/golf.webp', player_pattern, '@oasis_production_player_static'),
        ]:
            with self.subTest(path=path):
                selected, body = selected_location(locations, path)
                self.assertEqual(selected, pattern)
                self.assertIn('root /opt/oasis/static-assets;', body)
                self.assertIn('try_files $uri ' + fallback + ';', body)
                self.assertNotIn('/opt/oasis/current', body)
                self.assertNotIn('proxy_pass ', body)
        named = {pattern: body for kind, pattern, body in locations if pattern.startswith('@')}
        self.assertEqual(set(named), {'@oasis_production_api_static', '@oasis_production_player_static'})
        self.assertIn('proxy_pass http://127.0.0.1:18891;', named['@oasis_production_api_static'])
        self.assertNotIn('18881', named['@oasis_production_api_static'])
        self.assertIn('root /opt/oasis/production-current/platform/dist;', named['@oasis_production_player_static'])
        self.assertIn('try_files $uri =404;', named['@oasis_production_player_static'])
        self.assertNotIn('/index.html', named['@oasis_production_player_static'])

    def test_static_routes_do_not_bypass_sensitive_paths_or_capture_live_api(self):
        tls = ingress.configurations(BINDING)[str(ingress.TLS)].decode()
        locations = location_blocks(tls)
        for path in ['/arena/assets/.env', '/legacy/assets/secret.pem', '/legacy/bundles/secret.key',
                     '/assets/secret.env', '/previews/secret.sql', '/arena/assets/%2eenv',
                     '/assets/secret%2esql', '/assets/%2e%2e/.env']:
            with self.subTest(path=path):
                _, body = selected_location(locations, path)
                self.assertIn('deny all;', body)
                self.assertNotIn('try_files ', body)
                self.assertNotIn('proxy_pass ', body)
        for path in ['/api/player/app', '/v1/sessions', '/play/golf', '/arena/index.html',
                     '/legacy/index.html', '/arena/assets/%2e%2e/%2e%2e/api/player/app']:
            with self.subTest(path=path):
                pattern, body = selected_location(locations, path)
                self.assertEqual(pattern, '^/(api|v1|play|arena|legacy)/')
                self.assertIn('proxy_pass http://127.0.0.1:18891;', body)
                self.assertNotIn('static-assets', body)
        for path, status in [('/demo', '410'), ('/demo/index.html', '410'),
                             ('/api/demo/.env', '410'), ('/downloads/.env', '404')]:
            with self.subTest(path=path):
                _, body = selected_location(locations, path)
                self.assertIn('return ' + status + ';', body)
        regexes = [pattern for kind, pattern, _ in locations if kind in ('~', '~*')]
        self.assertLess(regexes.index(r'/\.'), regexes.index('^/(arena/assets|legacy/assets|legacy/bundles)/'))
        self.assertLess(regexes.index(r'\.(pem|key|env|sql)$'), regexes.index('^/(assets|previews)/'))
        self.assertLess(regexes.index('^/(arena/assets|legacy/assets|legacy/bundles)/'),
                        regexes.index('^/(api|v1|play|arena|legacy)/'))
        self.assertFalse(any(kind == '^~' and pattern.startswith(('/assets', '/arena', '/legacy', '/previews'))
                             for kind, pattern, _ in locations))

    def test_stable_and_current_static_files_keep_mime_cache_and_security_headers(self):
        tls = ingress.configurations(BINDING)[str(ingress.TLS)].decode()
        locations = location_blocks(tls)
        paths = ['^/(arena/assets|legacy/assets|legacy/bundles)/', '^/(assets|previews)/',
                 '@oasis_production_player_static']
        for pattern in paths:
            body = next(body for _, actual, body in locations if actual == pattern)
            with self.subTest(location=pattern):
                for mime, extensions in [('application/javascript', 'js mjs'), ('text/css', 'css'),
                                         ('model/gltf-binary', 'glb'), ('application/wasm', 'wasm'),
                                         ('font/woff2', 'woff2'), ('image/webp', 'webp')]:
                    self.assertIn(mime + ' ' + extensions + ';', body)
                self.assertIn('add_header Cache-Control $oasis_production_static_cache_control;', body)
                self.assertIn('add_header X-Content-Type-Options nosniff always;', body)
                self.assertIn('add_header Referrer-Policy no-referrer always;', body)
        cache_rules = re.findall(r'"~([^\"]+)"\s+"([^\"]+)";', tls)
        def cache(path):
            return next((value for pattern, value in cache_rules if re.search(pattern, path)),
                        'public, max-age=0, must-revalidate')
        for path in ['/arena/assets/RunGame-QJIPAPjX.js', '/assets/index-CtYnvOXL.js',
                     '/arena/assets/pin-AbCd1234.glb', '/arena/assets/img-mobile-0123456789.webp']:
            self.assertEqual(cache(path), 'public, max-age=31536000, immutable')
        for path in ['/previews/golf.webp', '/assets/config.json', '/assets/index.html']:
            self.assertEqual(cache(path), 'public, max-age=0, must-revalidate')
        for path in ['/index.html', '/player']:
            _, body = selected_location(locations, path)
            self.assertIn('add_header Cache-Control no-store always;', body)

    def test_acme_server_does_not_publish_player_or_business_routes(self):
        configs = ingress.configurations(BINDING)
        bridge = configs[str(ingress.BRIDGE)].decode()
        proxy = configs[str(ingress.PRIVATE / 'proxy-acme.conf')].decode()
        self.assertIn('location / { return 404; }', bridge)
        self.assertEqual(proxy.count('proxy_pass '), 1)
        self.assertNotIn('18891', proxy)
        self.assertNotIn('game.tianyahuyu.com', bridge + proxy)

    def test_certificate_renewal_is_pinned_and_does_not_restart_business(self):
        configs = ingress.configurations(BINDING)
        service = configs[str(ingress.RENEW_SERVICE)].decode()
        self.assertIn(BINDING['release'] + '/platform/deploy/production-ingress.py renew', service)
        self.assertIn('--manifest-sha256 ' + BINDING['manifest_sha256'], service)
        self.assertNotIn('restart', service)
        self.assertNotIn('OASIS_PRODUCTION_ADMISSION_ENABLED', service)

    def test_release_paths_cannot_escape_to_current_or_shell_text(self):
        for value in ['/opt/oasis/current', '/opt/oasis/releases/20261010-01/../01',
                      '/opt/oasis/releases/20261010-01;touch /tmp/x', '/tmp/20261010-01']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'IMMUTABLE_RELEASE_REQUIRED'):
                ingress.release_binding(Path(value), 'a' * 64)
        with self.assertRaisesRegex(RuntimeError, 'EXACT_MANIFEST_SHA_REQUIRED'):
            ingress.release_binding(Path(BINDING['release']), 'bad')

    def test_exclusive_new_config_explicitly_sets_mode_under_private_umask(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'new.conf'
            previous = os.umask(0o077)
            try:
                self.assertTrue(ingress.exact_file(path, b'config\n'))
            finally:
                os.umask(previous)
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
            self.assertEqual(path.read_bytes(), b'config\n')

    def test_existing_foreign_config_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'existing.conf'
            path.write_bytes(b'foreign\n')
            with patch.object(ingress, 'read_regular', return_value=b'foreign\n'):
                with self.assertRaisesRegex(RuntimeError, 'EXISTING_CONFIG_CONFLICT'):
                    ingress.exact_file(path, b'new\n')
            self.assertEqual(path.read_bytes(), b'foreign\n')

    def test_failed_public_start_removes_only_the_file_created_by_that_start(self):
        with tempfile.TemporaryDirectory() as directory:
            tls = Path(directory) / 'own.conf'
            root = Path(directory) / 'oasis'; release = root / 'release'; release.mkdir(parents=True)
            (root / 'production-current').symlink_to(release, target_is_directory=True)
            cert = root / 'cert'; cert.mkdir()
            binding = {**BINDING, 'release': str(release.resolve())}
            calls = []
            def get(url):
                if url == 'http://127.0.0.1:18891/health/ready':
                    return b'{"status":"ok","environment":"production"}'
                raise RuntimeError('TLS_PROBE_FAILED')
            with patch.object(ingress, 'BASE', root), patch.object(ingress, 'TLS', tls), \
                 patch.object(ingress, 'CERT', cert), patch.object(ingress, 'public_get', side_effect=get), \
                 patch.object(ingress, 'read_regular', side_effect=lambda p: p.read_bytes()), \
                 patch.object(ingress, 'certificate_unit_guard'), \
                 patch.object(ingress, 'run', side_effect=lambda args: calls.append(args)):
                with self.assertRaisesRegex(RuntimeError, 'TLS_PROBE_FAILED'):
                    ingress.start(binding)
            self.assertFalse(tls.exists())
            self.assertEqual(calls, [['nginx', '-t'], ['systemctl', 'reload', 'nginx'],
                                     ['nginx', '-t'], ['systemctl', 'reload', 'nginx']])


if __name__ == '__main__':
    unittest.main()
