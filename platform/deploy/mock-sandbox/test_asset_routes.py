"""Pure local candidates plus optional real loopback Nginx/TLS contract checks."""
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import time
import types
import unittest
from unittest.mock import patch


def load(name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


HERE = Path(__file__).resolve().parent
routes = load('asset_routes_under_test', HERE / 'asset_routes.py')
fixture_module = load('asset_routes_bundle_fixture', HERE / 'test_asset_bundle.py')


class RoutesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.BundleTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        patch.object(routes, 'bundle', fixture_module.bundle).start()
        self.root = self.fixture.root
        self.fixture.compile()
        self.source = self.root / 'output/bundle.tar'
        self.output = self.root / 'candidate'

    def generate(self):
        return routes.generate(self.source, self.output)

    def test_internal_plan_only_and_native_contract_declared(self):
        (self.source.parent / 'plan.json').write_text('{"entries":[{"url_path":"/api/private"}]}')
        (self.source.parent / 'receipt.json').write_text('untrusted adjacent receipt')
        result = self.generate()
        self.assertFalse(result['apply_allowed'])
        self.assertFalse(result['http_verified'])
        self.assertEqual(result['unresolved_conflicts'], 4)
        config = (self.output / 'locations.conf').read_text()
        self.assertNotIn('/api/private', config)
        self.assertNotIn('sha256-', config)
        self.assertEqual(config.count('location = '), 2)
        self.assertIn('etag on;', config)
        self.assertIn('if_modified_since exact;', config)
        self.assertIn('max_ranges 0;', config)
        self.assertNotIn('$http_if_none_match', config)
        contract = json.loads((self.output / 'adapter.json').read_text())
        self.assertEqual(contract['store'], routes.STORE)
        self.assertEqual(len(contract['unresolved_conflicts']), 4)
        self.assertIn('native Nginx', contract['revised_validator_contract']['candidate'])

    def test_raw_paths_host_scheme_and_methods_all_guarded(self):
        self.generate()
        config = (self.output / 'locations.conf').read_text()
        for name in self.fixture.assets:
            path = routes.bundle.asset_url(name)
            self.assertIn(f'location = {path} {{', config)
            self.assertIn(f'if ($request_uri != "{path}") {{ return 404; }}', config)
            self.assertIn(f'alias {routes.STORE}/files{path};', config)
        self.assertEqual(config.count('if ($scheme != https)'), 2)
        self.assertEqual(config.count('if ($http_host !~*'), 2)
        self.assertEqual(config.count('if ($request_method !~ "^(GET|HEAD)$")'), 2)
        self.assertNotIn('location /', config)
        self.assertNotIn('proxy_pass', config)

    def test_headers_length_and_error_fallback_are_not_forged(self):
        self.generate()
        config = (self.output / 'locations.conf').read_text()
        self.assertIn('default_type text/css;', config)
        self.assertIn('default_type text/javascript;', config)
        self.assertEqual(config.count('gzip off;'), 2)
        self.assertEqual(config.count('charset off;'), 2)
        self.assertEqual(config.count('disable_symlinks on;'), 2)
        self.assertNotIn('add_header Content-Length', config)
        self.assertNotIn('add_header ETag', config)
        self.assertNotIn('try_files', config)
        self.assertIn('error_page 403 404 =404 @oasis_mock_retained_missing;', config)
        self.assertIn('add_header Allow "GET, HEAD" always;', config)
        self.assertIn('add_header Cache-Control no-store always;', config)

    def test_deterministic_exclusive_output_and_readonly_check(self):
        receipt = self.generate()
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.output.iterdir()}
        self.assertEqual(routes.check_candidate(self.source, self.output), receipt)
        self.assertEqual({p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.output.iterdir()}, before)
        with self.assertRaises(FileExistsError):
            self.generate()
        other = self.root / 'other'
        routes.generate(self.source, other)
        self.assertEqual({p.name: p.read_bytes() for p in other.iterdir()}, {k: v[0] for k, v in before.items()})
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in self.output.iterdir()))

    def test_tampered_candidate_fields_and_extra_member_refused(self):
        self.generate()
        for name in routes.OUTPUT_NAMES:
            path = self.output / name
            original = path.read_bytes()
            path.write_bytes(original + b'\n')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'CANDIDATE_MISMATCH'):
                routes.check_candidate(self.source, self.output)
            path.write_bytes(original)
        (self.output / 'unexpected').write_bytes(b'x')
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_MEMBERS'):
            routes.check_candidate(self.source, self.output)

    def test_invalid_bundle_never_creates_output(self):
        raw = self.source.read_bytes()
        for bad in (raw[:-1], raw[:len(raw)//2], raw + b'\0' * 512, b'not a tar'):
            self.source.write_bytes(bad)
            with self.assertRaises((ValueError, routes.tarfile.TarError)):
                self.generate()
            self.assertFalse(self.output.exists())

    def test_modified_internal_plan_cannot_add_route_or_waive_conflicts(self):
        files = self.fixture.files()
        plan = json.loads(files['BUNDLE-PLAN.json'])
        plan['entries'][0]['url_path'] = '/api/private'
        plan['unresolved_conflicts'] = []
        files['BUNDLE-PLAN.json'] = routes.bundle.encoded(plan)
        self.source.write_bytes(routes.bundle.tar_bytes(files))
        with self.assertRaisesRegex(ValueError, 'PLAN_MISMATCH'):
            self.generate()
        self.assertFalse(self.output.exists())

    def test_links_in_inputs_outputs_or_parents_refused(self):
        self.output.symlink_to(self.root / 'absent')
        with self.assertRaisesRegex(ValueError, 'LOCAL_SYMLINK'):
            self.generate()
        self.output.unlink()
        linked = self.root / 'bundle-link'
        os.link(self.source, linked)
        with self.assertRaisesRegex(ValueError, 'LOCAL_NOT_REGULAR'):
            self.generate()
        linked.unlink()
        self.generate()
        path = self.output / 'locations.conf'
        os.link(path, self.root / 'configuration-link')
        with self.assertRaisesRegex(ValueError, 'LOCAL_NOT_REGULAR'):
            routes.check_candidate(self.source, self.output)

    def test_deployment_paths_and_missing_parent_refused_without_writing(self):
        for path in ('/opt/oasis/mock-candidate', '/etc/nginx/asset-candidate', '/run/asset-candidate'):
            # macOS /etc is itself a symlink; either boundary must refuse before mkdir.
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'DEPLOYMENT_OUTPUT_FORBIDDEN|LOCAL_SYMLINK'):
                routes.generate(self.source, path)
        with self.assertRaisesRegex(ValueError, 'OUTPUT_PARENT_MISSING'):
            routes.generate(self.source, self.root / 'absent/child')
        self.assertFalse((self.root / 'absent').exists())

    def test_cli_sanitizes_errors_and_has_no_install_or_pin_override(self):
        out = io.StringIO()
        with patch('sys.stdout', out):
            code = routes.main(['check', '--bundle', str(self.root / 'sensitive.env'), '--candidate', str(self.output)])
        self.assertEqual(code, 2)
        self.assertNotIn('sensitive', out.getvalue())
        for command in ('apply', 'install', 'reload'):
            with patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                routes.main([command])

    @unittest.skipUnless(shutil.which('nginx') and shutil.which('openssl'),
                         'HTTP NOT VERIFIED: local nginx and openssl executables are required; no download/install fallback')
    def test_real_nginx_https_raw_paths_cache_range_head_and_isolation(self):
        self.generate()
        store = self.root / 'store'
        for name, body in self.fixture.assets.items():
            file = store / ('files' + routes.bundle.asset_url(name))
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)
        cert, key = self.root / 'cert.pem', self.root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key),
                        '-out', str(cert), '-days', '1', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, capture_output=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        # Only the immutable store path is relocated into this owned local fixture.
        locations = (self.output / 'locations.conf').read_text().replace(routes.STORE, str(store))
        config = self.root / 'nginx.conf'
        # A root-invoked Linux fixture must not silently drop to nobody and lose
        # access to its private temporary parent. This never edits a service.
        caller = 'user root;\n' if os.geteuid() == 0 else ''
        config.write_text(caller + f'''pid {self.root}/nginx.pid;
error_log {self.root}/error.log;
events {{}}
http {{ access_log off; client_body_temp_path {self.root}/body;
server {{ listen 127.0.0.1:{port} ssl; server_name {routes.HOST};
ssl_certificate {cert}; ssl_certificate_key {key};
gzip on; gzip_min_length 1; gzip_types text/javascript text/css; charset utf-8;
error_page 404 /index.html;
location = /index.html {{ default_type text/html; return 200 '<html>shell</html>'; }}
location /api/ {{ return 200 'existing API'; }}
location /private/ {{ return 403; }}
location / {{ return 404; }}
{locations}
}} }}
''')
        cmd = [shutil.which('nginx'), '-p', str(self.root), '-c', str(config)]
        checked = subprocess.run(cmd + ['-t'], capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        process = subprocess.Popen(cmd + ['-g', 'daemon off; master_process off;'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        context = ssl.create_default_context(cafile=str(cert))
        def request(path, method='GET', headers=None):
            connection = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=3)
            try:
                connection.request(method, path, headers={'Host': routes.HOST, **(headers or {})})
                response = connection.getresponse()
                return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
            finally:
                connection.close()
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    request('/api/ping')
                    break
                except OSError:
                    self.assertIsNone(process.poll(), 'Nginx fixture exited')
                    self.assertLess(time.monotonic(), deadline, 'Nginx fixture startup timed out')
                    time.sleep(.05)
            for name, body in self.fixture.assets.items():
                url = routes.bundle.asset_url(name)
                status, headers, received = request(url, headers={'Accept-Encoding': 'gzip'})
                self.assertEqual((status, received), (200, body))
                self.assertEqual(headers['content-type'], 'text/css' if name.endswith('.css') else 'text/javascript')
                self.assertEqual(headers['content-length'], str(len(body)))
                self.assertNotIn('content-encoding', headers)
                self.assertEqual(headers['cache-control'], 'public,max-age=31536000,immutable')
                self.assertNotIn('sha256-', headers['etag'])
                status, head, received = request(url, 'HEAD')
                self.assertEqual((status, received), (200, b''))
                self.assertEqual(head['content-length'], str(len(body)))
                self.assertEqual(head['etag'], headers['etag'])
                self.assertEqual(request(url, headers={'If-None-Match': headers['etag']})[0], 304)
                self.assertEqual(request(url, headers={'If-None-Match': '*'})[0], 304)
                self.assertEqual(request(url, headers={'If-Modified-Since': headers['last-modified']})[0], 304)
                self.assertEqual(request(url, headers={'If-Match': '"wrong"'})[0], 412)
                ranged = request(url, headers={'Range': 'bytes=0-1', 'If-Range': headers['etag']})
                self.assertEqual((ranged[0], ranged[2]), (200, body))
                for bad in (url+'?x=1', url+'?', url.replace('/assets/', '/%61ssets/'), url.replace('/assets/', '//assets/'), url.replace('/assets/', '/assets/./'), url.replace('/assets/', '/assets/../assets/')):
                    status, bad_headers, received = request(bad)
                    self.assertEqual(status, 404, bad)
                    self.assertNotIn('immutable', bad_headers.get('cache-control', ''))
                    self.assertNotEqual(received, body)
                self.assertEqual(request(url, headers={'Host': 'game.tianyahuyu.com'})[0], 404)
                status, failed, _ = request(url, 'POST')
                self.assertEqual(status, 405)
                self.assertEqual(failed['allow'], 'GET, HEAD')
                self.assertEqual(failed['cache-control'], 'no-store')
                file = store / ('files' + url)
                file.unlink()
                status, missing, received = request(url)
                self.assertEqual(status, 404)
                self.assertNotIn(b'<html>shell', received)
                self.assertEqual(missing['cache-control'], 'no-store')
            self.assertEqual(request('/api/ping')[2], b'existing API')
            self.assertEqual(request('/private/key')[0], 403)
            self.assertEqual(request('/not-an-overlay')[2], b'<html>shell</html>')
        finally:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
            self.assertIsNotNone(process.poll(), 'Nginx fixture still running')


if __name__ == '__main__':
    unittest.main()
