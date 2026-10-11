import importlib.util
from contextlib import ExitStack, redirect_stdout
import http.client
import io
import json
import os
from pathlib import Path
import posixpath
import re
import ssl
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch
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


class ProductionRenewalHealthTests(unittest.TestCase):
    READY = b'{"status":"ok","environment":"production"}'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ancestor = Path(temporary.name)
        self.root = self.ancestor / 'oasis'; self.root.mkdir()
        shared_private = self.root / 'private'; shared_private.mkdir()
        lock = shared_private / 'release.lock'; lock.touch()
        private = self.root / 'production-ingress-private'; private.mkdir(mode=0o700)
        self.private = private
        self.private_owner = {'st_uid': 0, 'st_gid': 0}
        original_lstat = Path.lstat
        def lstat(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if path == private:
                return SimpleNamespace(**{name: self.private_owner.get(name, getattr(info, name))
                    for name in dir(info) if name.startswith('st_')})
            return info
        certbot = self.root / 'certbot'; certbot.touch()
        own = self.root / 'owned-nginx.conf'; own.write_bytes(b'unchanged config')
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink')
        pin = {key: getattr(lock.stat(), key) for key in fields}
        pin['st_uid'] = 0
        original_fstat = os.fstat
        def fstat(fd):
            return SimpleNamespace(**{key: (0 if key == 'st_uid' else getattr(original_fstat(fd), key))
                                      for key in fields})
        self._original_public_get = ingress.public_get
        self._original_configurations = ingress.configurations
        self.public = Mock(return_value=self.READY)
        self.certificate = Mock()
        self.protected = Mock(return_value={'foreign-vhost': 'original'})
        self.proxy = Mock(return_value={'id': 'original', 'image': 'original'})
        self.proxy_configs = Mock(return_value={'foreign-proxy-vhost': 'original'})
        self.units = Mock(return_value={'original': 'units'})
        self.commands = Mock()
        self.output = io.StringIO()
        stack = ExitStack(); self.addCleanup(stack.close)
        values = {'BASE': self.root, 'PRIVATE': private,
                  'CERTBOT': certbot, 'LOCK': private / '.production-ingress-lock',
                  'TLS': self.root / 'own-tls.conf',
                  'configurations': Mock(return_value={str(own): own.read_bytes()}),
                  'read_regular': lambda path, *args: path.read_bytes(),
                  'file_pin': Mock(return_value=pin), 'release_binding': Mock(return_value=BINDING),
                  'load_bound_helper': Mock(return_value=SimpleNamespace(default_cli_guard=lambda: ['original'])),
                  'certificate_unit_guard': self.units, 'protected_files': self.protected,
                  'proxy_identity': self.proxy, 'proxy_configs': self.proxy_configs,
                  'public_get': self.public, 'certificate': self.certificate, 'run': self.commands}
        for name, value in values.items():
            stack.enter_context(patch.object(ingress, name, value))
        stack.enter_context(patch.object(Path, 'lstat', lstat))
        stack.enter_context(patch.object(ingress.os, 'fstat', side_effect=fstat))
        stack.enter_context(patch.object(ingress.os, 'geteuid', return_value=0))
        stack.enter_context(patch.object(ingress.os, 'umask'))
        stack.enter_context(patch('sys.argv', ['production-ingress.py', 'renew', '--release',
            BINDING['release'], '--manifest-sha256', BINDING['manifest_sha256']]))
        stack.enter_context(redirect_stdout(self.output))

    def test_check_hashes_original_real_ready_body_with_original_receipt_schema(self):
        result = ingress.check(BINDING)
        self.public.assert_called_once_with(ingress.ORIGIN + '/health/ready')
        self.assertEqual(result['public_health'], ingress.sha(self.READY))
        self.assertEqual(result['schema'], 'production-ingress-check-v1')
        self.assertEqual(set(result), {'schema', 'binding', 'certificate_units', 'certificate_scope',
            'protected', 'proxy', 'proxy_protected', 'own', 'shared_lock', 'public_health',
            'health_url', 'health_scope', 'read_only', 'checked_at_ms'})
        self.assertEqual(result['health_url'], ingress.PUBLIC_READY)
        self.assertEqual(result['health_scope'], 'public-production-https-ready')
        self.assertTrue(result['read_only'])
        self.certificate.assert_not_called()

    def test_renew_checks_real_ready_before_and_after_and_never_requests_retired_health(self):
        ingress.main()
        self.assertEqual([call.args[0] for call in self.public.call_args_list],
                         [ingress.ORIGIN + '/health/ready'] * 2)
        self.certificate.assert_called_once_with(BINDING, self.proxy.return_value, renew=True)
        self.assertEqual(self.output.getvalue(), 'PRODUCTION_INGRESS_RENEW_PASSED\n')
        self.assertFalse(ingress.LOCK.exists())

    def test_bad_real_ready_before_renew_refuses_without_certificate_operation(self):
        for body in [b'not json', b'[]', b'{}', b'{"status":"ok","environment":"sandbox"}',
                     b'{"status":"failed","environment":"production"}']:
            with self.subTest(body=body):
                self.public.return_value = body
                with self.assertRaises((RuntimeError, json.JSONDecodeError)):
                    ingress.main()
                self.certificate.assert_not_called()
                self.assertFalse(ingress.LOCK.exists())
        self.assertEqual(self.output.getvalue(), '')

    def test_bad_real_ready_after_renew_cannot_report_success(self):
        self.public.side_effect = [self.READY, b'{"status":"failed","environment":"production"}']
        with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_HEALTH_REQUIRED'):
            ingress.main()
        self.certificate.assert_called_once()
        self.assertEqual(self.output.getvalue(), '')
        self.assertFalse(ingress.LOCK.exists())

    def test_real_ready_transport_failure_is_not_swallowed_before_or_after_renew(self):
        for after in (False, True):
            with self.subTest(after=after):
                self.certificate.reset_mock()
                error = ssl.SSLCertVerificationError(1, 'certificate rejected')
                self.public.side_effect = [self.READY, error] if after else error
                with self.assertRaises(ssl.SSLCertVerificationError):
                    ingress.main()
                self.assertEqual(self.certificate.call_count, int(after))
                self.assertFalse(ingress.LOCK.exists())
        self.assertEqual(self.output.getvalue(), '')

    def test_post_renew_foreign_vhost_proxy_and_unit_guards_still_refuse(self):
        for observer, code in [(self.protected, 'OTHER_VHOST_CHANGED'),
                               (self.proxy, 'SHARED_PROXY_CHANGED'),
                               (self.proxy_configs, 'OTHER_PROXY_VHOST_CHANGED')]:
            with self.subTest(code=code):
                self.public.reset_mock(); self.certificate.reset_mock()
                observer.side_effect = [observer.return_value, {'changed': 'foreign'}]
                with self.assertRaisesRegex(RuntimeError, code):
                    ingress.main()
                self.public.assert_called_once_with(ingress.ORIGIN + '/health/ready')
                self.certificate.assert_called_once()
                observer.side_effect = None
                self.assertFalse(ingress.LOCK.exists())
        self.units.side_effect = RuntimeError('CERTIFICATE_UNITS_CHANGED')
        self.certificate.reset_mock()
        with self.assertRaisesRegex(RuntimeError, 'CERTIFICATE_UNITS_CHANGED'):
            ingress.main()
        self.certificate.assert_not_called()
        self.assertEqual(self.output.getvalue(), '')

    def test_public_get_keeps_default_verified_tls_and_no_proxy(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.url, response.status = ingress.ORIGIN + '/health/ready', 200
        response.read.return_value = self.READY
        original_build = ingress.urllib.request.build_opener
        built = []
        def build(*handlers):
            opener = original_build(*handlers)
            opener.open = Mock(return_value=response)
            built.append((handlers, opener))
            return opener
        # Exercise the original reader with open() stubbed; no network occurs.
        reader = self._original_public_get
        with patch.object(ingress.urllib.request, 'build_opener', side_effect=build):
            self.assertEqual(reader(response.url), self.READY)
        handlers, opener = built[0]
        self.assertEqual(handlers[0].proxies, {})
        https = next(handler for handler in opener.handlers
                     if isinstance(handler, ingress.urllib.request.HTTPSHandler))
        connection = http.client.HTTPSConnection(ingress.HOST, context=https._context)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(connection._context.check_hostname)
        opener.open.assert_called_once_with(response.url, timeout=15)

    def test_public_get_rejects_changed_route_http_status_and_oversized_body(self):
        ready = ingress.ORIGIN + '/health/ready'
        for url, status, body, code in [
                (ready + '/', 200, self.READY, 'PUBLIC_ROUTE_CHANGED'),
                (ready, 410, self.READY, 'PUBLIC_ROUTE_CHANGED'),
                (ready, 200, b'x' * 65537, 'PUBLIC_RESPONSE_TOO_LARGE')]:
            with self.subTest(url=url, status=status, code=code):
                response = MagicMock()
                response.__enter__.return_value = response
                response.url, response.status = url, status
                response.read.return_value = body
                opener = Mock(); opener.open.return_value = response
                with patch.object(ingress.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaisesRegex(RuntimeError, code):
                        self._original_public_get(ready)

    def test_authorized_acme_bootstraps_private_then_existing_instance_renews(self):
        self.private.rmdir()
        bridge = self.root / 'acme.conf'; webroot = self.root / 'webroot'
        configs = {str(bridge): b'acme config', str(self.private / 'proxy-acme.conf'): b'proxy config'}
        owned = {webroot, webroot / '.well-known', webroot / '.well-known/acme-challenge'}
        current_lstat = Path.lstat
        def lstat(path, *args, **kwargs):
            info = current_lstat(path, *args, **kwargs)
            if path in owned:
                return SimpleNamespace(**{name: (0 if name in ('st_uid', 'st_gid') else getattr(info, name))
                    for name in dir(info) if name.startswith('st_')})
            return info
        seen = []
        def get(url, expected=None):
            seen.append(url)
            if url in (ingress.PUBLIC_READY, ingress.LOCAL_READY):
                return self.READY
            self.assertTrue(url.startswith('http://' + ingress.HOST + '/.well-known/acme-challenge/'))
            self.assertEqual((webroot / '.well-known/acme-challenge' / url.rsplit('/', 1)[1]).read_bytes(), expected)
            return expected
        def run(args, **kwargs):
            probe = args[:4] == ['docker', 'exec', 'original', 'sh']
            return SimpleNamespace(returncode=44 if probe else 0, stdout='')
        helper = SimpleNamespace(default_cli_guard=lambda: ['original'], prepare_cli_config=Mock())
        with patch.object(ingress, 'configurations', return_value=configs), \
             patch.object(ingress, 'BRIDGE', bridge), patch.object(ingress, 'WEBROOT', webroot), \
             patch.object(Path, 'lstat', lstat), patch.object(ingress, 'public_get', side_effect=get), \
             patch.object(ingress, 'run', side_effect=run), \
             patch.object(ingress, 'load_bound_helper', return_value=helper):
            receipt = self.root / 'check.json'
            receipt.write_bytes(ingress.canonical(ingress.check(BINDING, require_public_https=False)))
            self.assertFalse(self.private.exists())
            with patch('sys.argv', ['production-ingress.py', 'acme', '--release', BINDING['release'],
                '--manifest-sha256', BINDING['manifest_sha256'], '--check-file', str(receipt)]):
                ingress.main()
            self.assertEqual(self.private.stat().st_mode & 0o777, 0o700)
            self.assertEqual(bridge.read_bytes(), configs[str(bridge)])
            self.assertEqual(list((webroot / '.well-known/acme-challenge').iterdir()), [])
            self.assertFalse(ingress.LOCK.exists())
            self.assertNotIn(ingress.PUBLIC_READY, seen)
            ingress.main()  # The unchanged outer argv is renew, now with an existing parent.
            self.assertEqual(seen[-2:], [ingress.PUBLIC_READY] * 2)
        self.certificate.assert_called_once_with(BINDING, self.proxy.return_value, renew=True)

    def test_first_acme_bad_or_missing_receipt_never_creates_private_or_lock(self):
        self.private.rmdir()
        expired = ingress.check(BINDING, require_public_https=False)
        expired['checked_at_ms'] -= 15 * 60 * 1000 + 1
        for receipt in (None, {'schema': 'foreign'}, expired):
            with self.subTest(receipt=receipt):
                argv = ['production-ingress.py', 'acme', '--release', BINDING['release'],
                        '--manifest-sha256', BINDING['manifest_sha256']]
                if receipt is not None:
                    path = self.root / 'bad-check.json'; path.write_bytes(ingress.canonical(receipt))
                    argv += ['--check-file', str(path)]
                with patch('sys.argv', argv), patch.object(ingress, 'prepare_acme') as operation:
                    with self.assertRaisesRegex(RuntimeError, 'CHECK_RECEIPT_'):
                        ingress.main()
                    operation.assert_not_called()
                self.assertFalse(self.private.exists())
                self.assertFalse(ingress.LOCK.exists())

    def test_check_with_missing_private_is_read_only_and_does_not_bootstrap(self):
        self.private.rmdir()
        before = [(path.stat().st_mtime_ns, path.stat().st_ctime_ns) for path in (self.root, self.ancestor)]
        ingress.check(BINDING)
        self.assertFalse(self.private.exists())
        self.assertFalse(ingress.LOCK.exists())
        self.assertEqual(before, [(path.stat().st_mtime_ns, path.stat().st_ctime_ns)
                                 for path in (self.root, self.ancestor)])

    def test_renew_rejects_missing_symlink_foreign_owner_group_and_wrong_mode_parent(self):
        for kind in ('missing', 'symlink', 'dangling', 'file', 'uid', 'gid', 'mode'):
            with self.subTest(kind=kind):
                self.private.rmdir()
                self.private_owner.update(st_uid=0, st_gid=0)
                if kind in ('symlink', 'dangling'):
                    self.private.symlink_to(self.root / ('private' if kind == 'symlink' else 'missing'))
                elif kind == 'file':
                    self.private.write_bytes(b'foreign')
                elif kind != 'missing':
                    self.private.mkdir(mode=0o755 if kind == 'mode' else 0o700)
                    if kind in ('uid', 'gid'):
                        self.private_owner['st_' + kind] = 1234
                self.commands.reset_mock(); self.public.reset_mock()
                with self.assertRaisesRegex(RuntimeError, 'OWNED_DIRECTORY_CHANGED'):
                    ingress.main()
                self.commands.assert_not_called(); self.public.assert_not_called()
                self.certificate.assert_not_called()
                if self.private.is_symlink() or self.private.is_file():
                    self.private.unlink()
                elif self.private.exists():
                    self.private.rmdir()
                self.private.mkdir(mode=0o700)
        self.private_owner.update(st_uid=0, st_gid=0)

    def test_renew_owned_lock_lifecycle_leaves_static_ancestors_exactly_unchanged(self):
        def pin(path):
            info = path.stat()
            return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid',
                'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
        before = [pin(path) for path in (self.root, self.ancestor)]
        def certificate(*args, **kwargs):
            self.assertEqual(ingress.LOCK.parent, self.private)
            self.assertTrue(ingress.LOCK.is_dir())
            self.assertEqual(ingress.LOCK.stat().st_mode & 0o777, 0o700)
        self.certificate.side_effect = certificate
        ingress.main()
        self.assertEqual(before, [pin(path) for path in (self.root, self.ancestor)])
        self.assertEqual(list(self.private.iterdir()), [])
        self.assertFalse((self.root / '.production-ingress-lock').exists())

    def test_existing_foreign_lock_is_refused_and_never_removed_by_finally(self):
        for kind in ('directory', 'dangling-symlink'):
            with self.subTest(kind=kind):
                if kind == 'directory':
                    ingress.LOCK.mkdir()
                else:
                    ingress.LOCK.symlink_to(self.root / 'absent-lock')
                with self.assertRaisesRegex(RuntimeError, 'INGRESS_OPERATION_RUNNING'):
                    ingress.main()
                self.certificate.assert_not_called()
                self.assertTrue(ingress.LOCK.exists() or ingress.LOCK.is_symlink())
                ingress.LOCK.rmdir() if kind == 'directory' else ingress.LOCK.unlink()

    def test_original_shared_release_flock_still_blocks_the_operation(self):
        fd = os.open(self.root / 'private/release.lock', os.O_RDWR)
        try:
            ingress.fcntl.flock(fd, ingress.fcntl.LOCK_EX | ingress.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                ingress.main()
            self.certificate.assert_not_called()
            self.assertEqual(list(self.private.iterdir()), [])
        finally:
            os.close(fd)

    def test_missing_tls_bootstrap_check_uses_only_typed_real_loopback(self):
        result = ingress.check(BINDING, require_public_https=False)
        self.assertEqual(result['health_url'], ingress.LOCAL_READY)
        self.assertEqual(result['health_scope'], 'production-loopback-bootstrap-ready')
        self.assertEqual(result['public_health'], ingress.sha(self.READY))
        self.public.assert_called_once_with(ingress.LOCAL_READY)
        for body in [b'[]', b'{"environment":"sandbox","status":"ok"}',
                     b'{"environment":"production","status":"failed"}']:
            with self.subTest(body=body):
                self.public.return_value = body
                with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_HEALTH_REQUIRED'):
                    ingress.check(BINDING, require_public_https=False)
        self.assertTrue(all(call.args[0] == ingress.LOCAL_READY for call in self.public.call_args_list))

    def test_existing_tls_or_renew_with_missing_tls_never_falls_back_to_loopback(self):
        ingress.TLS.write_bytes(b'existing TLS')
        self.public.side_effect = ssl.SSLCertVerificationError(1, 'certificate rejected')
        with self.assertRaises(ssl.SSLCertVerificationError):
            ingress.check(BINDING, require_public_https=False)
        self.public.assert_called_once_with(ingress.PUBLIC_READY)
        ingress.TLS.unlink(); self.public.reset_mock()
        with self.assertRaises(ssl.SSLCertVerificationError):
            ingress.main()  # renew remains strict even with no owned TLS config.
        self.public.assert_called_once_with(ingress.PUBLIC_READY)
        self.certificate.assert_not_called()
        self.assertFalse(ingress.LOCK.exists())

    def test_check_receipt_missing_or_mixed_health_source_is_not_reusable(self):
        original = ingress.check(BINDING, require_public_https=False)
        variants = [{key: value for key, value in original.items() if key not in ('health_url', 'health_scope')},
            {**original, 'health_url': ingress.PUBLIC_READY},
            {**original, 'health_scope': 'public-production-https-ready'}]
        for receipt in variants:
            with self.subTest(source=receipt.get('health_url')):
                path = self.root / 'check.json'; path.write_bytes(ingress.canonical(receipt))
                with patch('sys.argv', ['production-ingress.py', 'certificate', '--release', BINDING['release'],
                    '--manifest-sha256', BINDING['manifest_sha256'], '--check-file', str(path)]):
                    with self.assertRaisesRegex(RuntimeError, 'CHECK_RECEIPT_STALE'):
                        ingress.main()
                self.certificate.assert_not_called()
                self.assertFalse(ingress.LOCK.exists())

    def test_fresh_start_creates_tls_then_requires_public_https_before_success(self):
        release = self.root / 'release'; release.mkdir()
        (self.root / 'production-current').symlink_to(release)
        cert = self.root / 'cert'; cert.mkdir()
        binding = {**BINDING, 'release': str(release.resolve())}
        urls = []
        def get(url):
            urls.append(url)
            if url == ingress.PUBLIC_READY:
                self.assertTrue(ingress.TLS.is_file())
            return self.READY
        with patch.object(ingress, 'CERT', cert), \
             patch.object(ingress, 'RENEW_SERVICE', self.private / 'certificate.service'), \
             patch.object(ingress, 'RENEW_TIMER', self.private / 'certificate.timer'), \
             patch.object(ingress, 'configurations', side_effect=self._original_configurations), \
             patch.object(ingress, 'release_binding', return_value=binding), \
             patch.object(ingress, 'public_get', side_effect=get):
            receipt = self.root / 'check.json'
            receipt.write_bytes(ingress.canonical(ingress.check(binding, require_public_https=False)))
            urls.clear()
            with patch('sys.argv', ['production-ingress.py', 'start', '--release', binding['release'],
                '--manifest-sha256', binding['manifest_sha256'], '--check-file', str(receipt)]):
                ingress.main()
        self.assertEqual(urls, [ingress.LOCAL_READY, ingress.LOCAL_READY,
                               ingress.PUBLIC_READY, ingress.PUBLIC_READY])
        self.assertEqual(self.output.getvalue(), 'PRODUCTION_INGRESS_START_PASSED\n')
        self.assertFalse(ingress.LOCK.exists())


if __name__ == '__main__':
    unittest.main()
