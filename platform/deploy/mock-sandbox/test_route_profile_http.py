"""Isolated loopback TLS checks for the four mutable Mock profile routes.

No install/start/reload CLI, production Nginx config or external HTTP is used.
Optional OASIS_MOCK_ROUTE_HTTP_INPUTS contains bundle.tar and 04/05 directories,
each with RELEASE-MANIFEST.json plus route_profile.SELECTED at their exact paths.
Those bytes are authenticated by the production pure builder, never test pins.
OASIS_MOCK_ROUTE_HTTP_REPORTS optionally retains exclusive per-case evidence.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name, filename):
    module = types.ModuleType(name)
    module.__file__ = str(HERE / filename)
    exec(compile((HERE / filename).read_bytes(), module.__file__, 'exec'), module.__dict__)
    return module


fixture_config = load('mutable_http_routes_fixture', 'test_asset_routes.py').nginx_fixture_config
WRITE_DIRECTIVES = {'client_body_temp_path', 'proxy_temp_path', 'fastcgi_temp_path',
                    'uwsgi_temp_path', 'scgi_temp_path', 'pid', 'lock_file', 'error_log', 'access_log'}
HAVE_HTTP = bool(shutil.which('nginx') and shutil.which('openssl'))
HTTP_MISSING = 'HTTP NOT VERIFIED: local nginx and openssl required; no installation/download fallback'


def confined_config(profile, overlay, root, port, upstream_port):
    """Relocate a verified full vhost, retaining its actual route precedence.

    The only transformations are listener, certificate and private fixture paths,
    and all existing upstream ports to one reserved, non-listening local socket.
    No proxy request is part of this test. No global include is inherited.
    """
    root = Path(root).resolve(strict=True)
    prefix = fixture_config(root, port, '').split('\nserver { listen ', 1)[0]
    config = overlay.decode('utf-8')
    replacements = {
        'listen 443 ssl http2;': f'listen 127.0.0.1:{port} ssl;',
        '/opt/oasis/acme/config/live/oasis-android-mock/fullchain.pem': str(root / 'cert.pem'),
        '/opt/oasis/acme/config/live/oasis-android-mock/privkey.pem': str(root / 'key.pem'),
    }
    for old, new in replacements.items():
        if config.count(old) != 1:
            raise ValueError('FIXTURE_PROFILE_SHAPE_CHANGED')
        config = config.replace(old, new)
    for old, new in ((profile.CURRENT, str(root / 'current')),
                     (str(profile.PROFILE_ROOT), str(root / 'materials')),
                     (profile.routes.STORE, str(root / 'store'))):
        if old not in config:
            raise ValueError('FIXTURE_PROFILE_PATH_MISSING')
        config = config.replace(old, new)
    config = re.sub(r'http://127\.0\.0\.1:(18981|18985)(?=;)',
                    f'http://127.0.0.1:{upstream_port}', config)
    config = prefix + '\n' + config + '\n}\n'
    assert_confined(config, root, port, upstream_port)
    return config


def assert_confined(config, root, port, upstream_port):
    """Independent pre-spawn guard: omitted module temp paths are unsafe."""
    root = Path(root).resolve(strict=True)
    paths = []
    for directive in WRITE_DIRECTIVES:
        values = re.findall(r'^\s*' + directive + r'\s+([^;]+);', config, re.MULTILINE)
        if len(values) != 1 or not re.fullmatch(r'"[^"\n]+"', values[0]):
            raise ValueError('FIXTURE_WRITE_DIRECTIVE_NOT_UNIQUE:' + directive)
        value = Path(values[0][1:-1])
        if not value.is_absolute() or value.parent != root:
            raise ValueError('FIXTURE_WRITE_PATH_ESCAPE:' + directive)
        paths.append(value)
    if len(set(paths)) != len(paths):
        raise ValueError('FIXTURE_WRITE_PATH_COLLISION')
    if re.search(r'(?m)^\s*include\s', config) or '/opt/oasis/' in config:
        raise ValueError('FIXTURE_EXTERNAL_CONFIG_OR_PATH')
    if re.findall(r'\blisten\s+([^;]+);', config) != [f'127.0.0.1:{port} ssl']:
        raise ValueError('FIXTURE_LISTENER_ESCAPE')
    proxies = re.findall(r'\bproxy_pass\s+([^;]+);', config)
    if len(proxies) != 4 or set(proxies) != {f'http://127.0.0.1:{upstream_port}'}:
        raise ValueError('FIXTURE_UPSTREAM_ESCAPE')
    for directive in ('root', 'alias', 'ssl_certificate', 'ssl_certificate_key'):
        for value in re.findall(r'^\s*' + directive + r'\s+([^;]+);', config, re.MULTILINE):
            if not value.startswith(str(root) + '/'):
                raise ValueError('FIXTURE_READ_PATH_ESCAPE:' + directive)


def history_inputs(profile, root):
    root = profile.bundle.safe_local_path(root)
    values = {}
    for version, prefix in (('04', 'old'), ('05', 'new')):
        values[prefix + '_manifest'] = profile.bundle.read_small(root / version / 'RELEASE-MANIFEST.json')
        values[prefix + '_files'] = {name: profile.bundle.read_small(root / version / name)
                                   for name in profile.SELECTED}
    with profile.bundle.open_regular(root / 'bundle.tar') as stream:
        values['asset_bundle'] = stream.read(profile.bundle.MAX_BUNDLE_BYTES + 1)
    profile.build_profiles(**values)
    return values


class MutableProfileHTTPTests(unittest.TestCase):
    def synthetic(self):
        fixtures = load('mutable_http_synthetic', 'test_route_profile.py')
        fixture = fixtures.ProfileTests(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixtures.profile, fixture.inputs

    def test_actual_generated_config_has_all_private_cycle_paths(self):
        profile, inputs = self.synthetic()
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve()
            for uid in (0, 1000):
                with self.subTest(uid=uid), patch('os.geteuid', return_value=uid):
                    config = confined_config(profile, profile.build_profiles(**inputs)['overlay.conf'], root, 45101, 45102)
                    self.assertEqual('user root;' in config, uid == 0)
                    self.assertEqual(config.count('location = /downloads/android-smoke-build.json {'), 1)
                    self.assertIn('try_files $uri $uri/ /index.html;', config)
                    self.assertNotIn('/var/lib/nginx', config)
                    self.assertNotIn('/var/log/nginx', config)
                    self.assertNotIn('/run/nginx', config)

    def test_each_omitted_duplicated_or_escaped_write_path_fails_before_spawn(self):
        profile, inputs = self.synthetic()
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve()
            config = confined_config(profile, profile.build_profiles(**inputs)['overlay.conf'], root, 45101, 45102)
            for directive in WRITE_DIRECTIVES:
                line = re.search(r'^\s*' + directive + r'\s+[^;]+;', config, re.MULTILINE).group()
                for bad in (config.replace(line, ''), config + '\n' + line,
                            config.replace(line, directive + ' "/var/lib/nginx/forbidden";')):
                    with self.subTest(directive=directive), self.assertRaises(ValueError):
                        assert_confined(bad, root, 45101, 45102)
            for bad in (config + '\ninclude /etc/nginx/nginx.conf;',
                        config.replace('127.0.0.1:45101 ssl', '0.0.0.0:45101 ssl'),
                        config.replace('127.0.0.1:45102', '127.0.0.1:18981')):
                with self.assertRaises(ValueError):
                    assert_confined(bad, root, 45101, 45102)

    @unittest.skipUnless(HAVE_HTTP, HTTP_MISSING)
    def test_synthetic_four_mutable_routes_04_05_04(self):
        profile, inputs = self.synthetic()
        self.exercise(profile, inputs, 'synthetic-pins')

    @unittest.skipUnless(os.environ.get('OASIS_MOCK_ROUTE_HTTP_INPUTS'),
                         'No explicit historical source capsule supplied')
    def test_historical_source_capsule_authentication_without_nginx(self):
        profile = load('mutable_http_history_readonly', 'route_profile.py')
        inputs = history_inputs(profile, Path(os.environ['OASIS_MOCK_ROUTE_HTTP_INPUTS']))
        artifacts = profile.build_profiles(**inputs)
        self.assertEqual(artifacts[profile.CANONICAL_JSON], inputs['new_files'][profile.JSON_PATH])
        self.assertNotEqual(inputs['old_files'][profile.JSON_PATH], artifacts[profile.CANONICAL_JSON])
        self.assertEqual(inputs['old_files'][profile.APK], inputs['new_files'][profile.APK])

    @unittest.skipUnless(HAVE_HTTP and os.environ.get('OASIS_MOCK_ROUTE_HTTP_INPUTS'),
                         'HISTORICAL HTTP NOT VERIFIED: explicit authenticated inputs and local nginx/openssl required')
    def test_historical_four_mutable_routes_04_05_04(self):
        profile = load('mutable_http_historical_profile', 'route_profile.py')
        inputs = history_inputs(profile, Path(os.environ['OASIS_MOCK_ROUTE_HTTP_INPUTS']))
        self.exercise(profile, inputs, 'authenticated-historical-04-05')

    def exercise(self, profile, inputs, evidence_kind):
        artifacts = profile.build_profiles(**inputs)
        reports = os.environ.get('OASIS_MOCK_ROUTE_HTTP_REPORTS')
        if reports:
            parent = Path(reports).resolve(strict=True)
            root = Path(tempfile.mkdtemp(prefix=evidence_kind + '-', dir=parent)).resolve()
        else:
            temp = tempfile.TemporaryDirectory(prefix='.mutable-http-', dir=Path.cwd())
            self.addCleanup(temp.cleanup)
            root = Path(temp.name).resolve()
        report = {'schema': 'mock-mutable-http-fixture-v1', 'evidence_kind': evidence_kind,
                  'passed': False, 'source_overlay_sha256': hashlib.sha256(artifacts['overlay.conf']).hexdigest(),
                  'scope': 'isolated loopback TLS; relocated full vhost; no production activation or upstream game calls',
                  'requests': [], 'pins': [], 'nginx_exited': False, 'port_closed': False}
        process = None
        reserved = socket.socket()
        reserved.bind(('127.0.0.1', 0))
        upstream_port = reserved.getsockname()[1]
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        report['port'] = port
        current = root / 'current'
        phase = 'startup'
        context = None

        def request(url, method='GET', headers=None):
            connection = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=4)
            try:
                connection.request(method, url, headers={'Host': profile.routes.HOST, **(headers or {})})
                response = connection.getresponse()
                body = response.read()
                received = {key.lower(): value for key, value in response.getheaders()}
                report['requests'].append({'phase': phase, 'url': url, 'method': method,
                                           'request_headers': headers or {}, 'status': response.status,
                                           'headers': received, 'bytes': len(body),
                                           'sha256': hashlib.sha256(body).hexdigest()})
                return response.status, received, body
            finally:
                connection.close()

        def complete(response, body, *, head=False):
            status, headers, received = response
            self.assertEqual(status, 200)
            self.assertEqual(received, b'' if head else body)
            self.assertEqual(headers['content-length'], str(len(body)))
            self.assertEqual(headers['cache-control'], 'no-store')
            self.assertNotIn('content-range', headers)
            self.assertNotIn('content-encoding', headers)
            return headers

        try:
            for version, key in (('04', 'old_files'), ('05', 'new_files')):
                for name, body in inputs[key].items():
                    target = root / version / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)
                    os.utime(target, (1700000000 + int(version) * 60,) * 2)
                (root / version / 'platform/dist/index.html').write_bytes(b'<html>mutable-fixture-SPA-shell</html>')
            (root / 'materials').mkdir()
            (root / 'materials' / profile.CANONICAL_JSON).write_bytes(artifacts[profile.CANONICAL_JSON])
            current.symlink_to(root / '04', target_is_directory=True)
            subprocess.run([shutil.which('openssl'), 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem'), '-days', '1',
                            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
                           check=True, capture_output=True)
            config = confined_config(profile, artifacts['overlay.conf'], root, port, upstream_port)
            (root / 'nginx.conf').write_text(config)
            report['fixture_config_sha256'] = hashlib.sha256(config.encode()).hexdigest()
            # No -t/-T and no service operation: only this owned process/config.
            process = subprocess.Popen([shutil.which('nginx'), '-p', str(root), '-c', str(root / 'nginx.conf'),
                                        '-g', 'daemon off; master_process off;'],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            context = ssl.create_default_context(cafile=str(root / 'cert.pem'))
            deadline = time.monotonic() + 5
            while True:
                try:
                    connection = ssl.create_default_context(cafile=str(root / 'cert.pem')).wrap_socket(
                        socket.socket(), server_hostname='127.0.0.1')
                    connection.settimeout(.25)
                    with connection:
                        connection.connect(('127.0.0.1', port))
                    break
                except OSError:
                    self.assertIsNone(process.poll(), 'fixture nginx exited; inspect retained stderr/config')
                    self.assertLess(time.monotonic(), deadline, 'fixture startup timed out')
                    time.sleep(.05)
            previous = {}
            first = {}
            for sequence, version in enumerate(('04', '05', '04')):
                phase = f'{sequence}:{version}'
                temporary_pin = root / 'next-pin'
                temporary_pin.symlink_to(root / version, target_is_directory=True)
                os.replace(temporary_pin, current)
                report['pins'].append(version)
                for name, policy in profile.MUTABLE.items():
                    with self.subTest(phase=phase, name=name):
                        url = '/' + name.removeprefix('platform/dist/')
                        body = inputs['new_files' if version == '05' or name == profile.JSON_PATH else 'old_files'][name]
                        headers = complete(request(url, headers={'Accept-Encoding': 'gzip'}), body)
                        mime = policy['mime'] + ('; charset=utf-8' if name.endswith('.md') else '')
                        self.assertEqual(headers['content-type'], mime)
                        self.assertIn('etag', headers)
                        self.assertIn('last-modified', headers)
                        if name == profile.ZIP_PATH:
                            self.assertEqual(headers['content-disposition'], 'attachment; filename="oasis-partner-sandbox-kit.zip"')
                        head = complete(request(url, 'HEAD'), body, head=True)
                        self.assertEqual(head['etag'], headers['etag'])
                        for method in ('GET', 'HEAD'):
                            for condition in ({'If-None-Match': headers['etag']}, {'If-None-Match': '*'}):
                                status, cached, received = request(url, method, condition)
                                self.assertEqual((status, received), (304, b''))
                                self.assertEqual(cached['cache-control'], 'no-store')
                            complete(request(url, method, {'If-Match': headers['etag']}), body, head=method == 'HEAD')
                            status, failed, _ = request(url, method, {'If-Match': '"not-current"'})
                            self.assertEqual(status, 412)
                            self.assertEqual(failed['cache-control'], 'no-store')
                            complete(request(url, method, {'If-Modified-Since': headers['last-modified']}), body, head=method == 'HEAD')
                            for range_value in ('bytes=0-1', 'bytes=0-1,4-5', 'bytes=999999999-'):
                                complete(request(url, method, {'Range': range_value, 'If-Range': headers['etag']}), body, head=method == 'HEAD')
                        if url in previous:
                            old = previous[url]
                            same = name == profile.JSON_PATH
                            self.assertEqual(headers['etag'] == old['etag'], same)
                            conditional = request(url, headers={'If-None-Match': old['etag']})
                            if same:
                                self.assertEqual((conditional[0], conditional[2]), (304, b''))
                            else:
                                complete(conditional, body)
                                self.assertEqual(request(url, headers={'If-Match': old['etag']})[0], 412)
                            complete(request(url, headers={'Range': 'bytes=4-9', 'If-Range': old['etag']}), body)
                            complete(request(url, headers={'If-Modified-Since': old['last-modified']}), body)
                        if sequence == 0:
                            first[url] = headers['etag']
                        elif sequence == 2:
                            self.assertEqual(headers['etag'], first[url])
                        previous[url] = headers
                        for method in ('POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'):
                            status, refused, received = request(url, method)
                            self.assertEqual(status, 405)
                            self.assertEqual(refused['allow'], 'GET, HEAD')
                            self.assertEqual(refused['cache-control'], 'no-store')
                            self.assertNotIn(b'mutable-fixture-SPA-shell', received)
                        segment = url.split('/')[1]
                        for bad in (url + '?x=1', url + '?', url.replace('/'+segment+'/', '//'+segment+'/'),
                                    url.replace('/'+segment+'/', '/'+segment+'/./'),
                                    url.replace('/'+segment+'/', '/'+segment+'/../'+segment+'/'),
                                    url.replace('/'+segment+'/', '/%'+format(ord(segment[0]), '02x')+segment[1:]+'/')):
                            status, rejected, received = request(bad)
                            self.assertEqual(status, 404, bad)
                            self.assertEqual(rejected['cache-control'], 'no-store')
                            self.assertNotIn(b'mutable-fixture-SPA-shell', received)
                        self.assertEqual(request(url, headers={'Host': 'game.tianyahuyu.com'})[0], 404)
                        target = root / 'materials' / profile.CANONICAL_JSON if name == profile.JSON_PATH else root / version / name
                        hidden = target.with_name(target.name + '.hidden')
                        target.rename(hidden)
                        try:
                            for method in ('GET', 'HEAD'):
                                status, missing, received = request(url, method)
                                self.assertEqual(status, 404)
                                self.assertEqual(missing['cache-control'], 'no-store')
                                self.assertNotIn(b'mutable-fixture-SPA-shell', received)
                        finally:
                            hidden.rename(target)
                        complete(request(url), body)
            self.assertEqual(request('/not-a-mutable-route')[2], b'<html>mutable-fixture-SPA-shell</html>')
            # unittest subTest records an assertion without escaping this loop.
            # Do not turn a completed loop into a passing evidence claim.
            report['passed'] = bool(self._outcome.success)
        finally:
            reserved.close()
            if process is not None:
                process.terminate()
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate(timeout=5)
                (root / 'process.stdout').write_bytes(stdout)
                (root / 'process.stderr').write_bytes(stderr)
                report['nginx_exited'] = process.poll() is not None
            with socket.socket() as closed:
                closed.settimeout(.5)
                report['port_closed'] = closed.connect_ex(('127.0.0.1', port)) != 0
            with (root / 'report.json').open('x') as stream:
                json.dump(report, stream, indent=2)
                stream.write('\n')
            if reports:
                print('MUTABLE_HTTP_EVIDENCE ' + str(root / 'report.json'), flush=True)
            self.assertTrue(report['nginx_exited'], 'owned nginx did not exit')
            self.assertTrue(report['port_closed'], 'owned listener remains')


if __name__ == '__main__':
    unittest.main()
