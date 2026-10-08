"""Public APK routing: exact candidate block and optional real local Nginx.

No Nginx -t/-T/reload or existing service is used. The optional worker has a
private prefix, all five explicit temp paths, and numeric loopback only. On
Linux/root it drops to uid/gid 2345 with no supplementary groups and no-new-privs
before executing Nginx. OASIS_APK_HTTP_EVIDENCE may name a NEW output directory;
that preserves config, logs and observations instead of removing the fixture.
OASIS_REQUIRE_NGINX=1 makes a missing binary a failure, not a skipped proof.
"""
import ctypes
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
CONFIG = HERE / 'oasis.nginx.conf'
MIME = 'application/vnd.android.package-archive'
APKS = ('oasis-android-smoke-1.1.1-debug.apk', 'oasis-android-smoke-1.2.0-debug.apk')
NGINX = shutil.which('nginx')


def apk_locations(config):
    start = config.index('    location ~ /\\. { deny all; }')
    marker = '    location ~* ^/downloads/.*\\.apk$ {'
    assert config.count(marker) == 1, 'APK_ROUTE_MISSING_OR_DUPLICATE'
    first = config.index(marker)
    depth = 1
    end = first + len(marker)
    while depth:
        c = config[end]
        depth += (c == '{') - (c == '}')
        end += 1
    assert start < first
    return config[start:end]


def fixture_config(root, port, control_port, locations):
    root = Path(root).resolve(strict=True)
    assert root.is_dir() and not re.search(r'[\n\r"\\$;{}]', str(root)), 'UNSAFE_FIXTURE_PATH'
    def path(name): return '"' + str(root / name) + '"'
    return f'''worker_processes 1;
pid {path('nginx.pid')};
lock_file {path('nginx.lock')};
error_log {path('error.log')} notice;
events {{ worker_connections 32; }}
http {{
 access_log {path('access.log')};
 client_body_temp_path {path('body')};
 proxy_temp_path {path('proxy')};
 fastcgi_temp_path {path('fastcgi')};
 uwsgi_temp_path {path('uwsgi')};
 scgi_temp_path {path('scgi')};
 default_type application/octet-stream;
 etag on; gzip off; sendfile off; open_file_cache off;
 server {{
  listen 127.0.0.1:{port}; server_name fixture.invalid;
  root {path('public')};
  add_header X-Content-Type-Options nosniff always;
  {locations}
  location / {{ try_files $uri $uri/ /index.html; }}
 }}
 # Negative control is the old public generic static/SPA behavior.
 server {{
  listen 127.0.0.1:{control_port}; server_name old-fixture.invalid;
  root {path('public')};
  location / {{ try_files $uri $uri/ /index.html; }}
 }}
}}
'''


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def drop_linux_root():
    os.setgroups([])
    os.setgid(2345)
    os.setuid(2345)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'PR_SET_NO_NEW_PRIVS')


class ConfigurationTests(unittest.TestCase):
    def test_candidate_keeps_security_and_static_fallback_order(self):
        config = CONFIG.read_text()
        locations = apk_locations(config)
        self.assertIn('location ~* \\.(pem|key|env|sql)$ { deny all; }', locations)
        self.assertIn('types { application/vnd.android.package-archive apk; }', locations)
        self.assertIn('default_type application/vnd.android.package-archive;', locations)
        self.assertIn('try_files $uri =404;', locations)
        self.assertNotIn('add_header', locations)
        self.assertNotIn('proxy_pass', locations)
        self.assertLess(config.index(locations), config.index('location / { try_files $uri $uri/ /index.html; }'))

    def test_all_nginx_cycle_paths_are_confined_in_emitted_config(self):
        with tempfile.TemporaryDirectory(prefix='oasis-apk-config-') as name:
            root = Path(name).resolve()
            config = fixture_config(root, 45678, 45679, apk_locations(CONFIG.read_text()))
            for directive in ('pid', 'lock_file', 'error_log', 'access_log', 'client_body_temp_path',
                              'proxy_temp_path', 'fastcgi_temp_path', 'uwsgi_temp_path', 'scgi_temp_path'):
                values = re.findall(r'^\s*' + directive + r'\s+"([^"]+)"[^;]*;', config, re.M)
                self.assertEqual(len(values), 1, directive)
                self.assertEqual(Path(values[0]).parent, root, directive)
            self.assertNotRegex(config, r'(?m)^\s*(include|user)\s')
            self.assertEqual(re.findall(r'listen\s+([^;]+);', config), ['127.0.0.1:45678', '127.0.0.1:45679'])
            self.assertNotIn('/var/lib/nginx', config)

    def test_required_native_proof_cannot_silently_skip(self):
        if os.environ.get('OASIS_REQUIRE_NGINX') == '1':
            self.assertIsNotNone(NGINX, 'HTTP NOT VERIFIED: nginx missing')


@unittest.skipUnless(NGINX, 'HTTP NOT VERIFIED: no local nginx; no download or service fallback')
class RealNginxTests(unittest.TestCase):
    def test_apk_mime_head_cache_ranges_and_missing_files(self):
        destination = os.environ.get('OASIS_APK_HTTP_EVIDENCE')
        if destination:
            root = Path(destination).absolute()
            self.assertEqual(root.parent.resolve(), root.parent)
            root.mkdir(mode=0o700)
        else:
            root = Path(tempfile.mkdtemp(prefix='oasis-apk-http-')).resolve()
        self.addCleanup(lambda: shutil.rmtree(root) if not destination else None)
        observations = []
        report = {'passed': False, 'scope': 'Synthetic HTTP fixture using actual APK location bytes; not TLS or live service',
                  'source_sha256': hashlib.sha256(CONFIG.read_bytes()).hexdigest(), 'observations': observations}
        worker = None
        port, control_port = free_port(), free_port()
        while control_port == port:
            control_port = free_port()
        try:
            public = root / 'public'; (public / 'downloads').mkdir(parents=True)
            shell = b'<html>SPA fallback fixture</html>'
            (public / 'index.html').write_bytes(shell)
            bodies = {name: b'PK\x03\x04' + bytes(range(256)) * (i + 1) for i, name in enumerate(APKS)}
            for name, body in bodies.items():
                p = public / 'downloads' / name; p.write_bytes(body); os.utime(p, (1700000000, 1700000000))
            for name in ('body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'):
                (root / name).mkdir()
            conf = fixture_config(root, port, control_port, apk_locations(CONFIG.read_text()))
            (root / 'nginx.conf').write_text(conf)
            if sys.platform == 'linux' and os.geteuid() == 0:
                for p in [root, *root.rglob('*')]:
                    os.chown(p, 2345, 2345)
                preexec = drop_linux_root
            else:
                self.assertNotEqual(os.geteuid(), 0, 'Root fixture requires Linux privilege drop')
                preexec = None
            with (root / 'worker.stdout').open('wb') as stdout, (root / 'worker.stderr').open('wb') as stderr:
                worker = subprocess.Popen([NGINX, '-p', str(root) + '/', '-c', str(root / 'nginx.conf'),
                                           '-g', 'daemon off; master_process off;'], cwd=root,
                                          env={k:v for k,v in os.environ.items() if not k.startswith(('LD_', 'DYLD_'))},
                                          stdout=stdout, stderr=stderr, preexec_fn=preexec)
                for _ in range(100):
                    self.assertIsNone(worker.poll(), 'New isolated Nginx exited; see worker.stderr')
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.1): break
                    except OSError: time.sleep(.02)
                else: self.fail('New isolated Nginx did not bind')
                if sys.platform == 'linux':
                    status = dict(line.split(':',1) for line in Path(f'/proc/{worker.pid}/status').read_text().splitlines() if ':' in line)
                    report['process'] = {k:status[k].strip() for k in ('Uid','Gid','CapEff','CapPrm','CapInh','CapAmb','NoNewPrivs')}
                    for k in ('CapEff','CapPrm','CapInh','CapAmb'): self.assertEqual(int(status[k],16),0)
                    if os.geteuid()==0:
                        self.assertEqual(status['Uid'].split(), ['2345']*4)
                        self.assertEqual(status['Gid'].split(), ['2345']*4)
                        self.assertEqual(status['NoNewPrivs'].strip(),'1')
                def get(path, method='GET', headers=None, old=False):
                    c=http.client.HTTPConnection('127.0.0.1',control_port if old else port,timeout=3)
                    try:
                        c.request(method,path,headers=headers or {});r=c.getresponse();body=r.read();h=dict(r.getheaders())
                        h={k.lower():v for k,v in h.items()}
                        observations.append({'path':path,'method':method,'old_control':old,'request_headers':headers or {},
                                             'status':r.status,'headers':h,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()})
                        return r.status,h,body
                    finally:c.close()
                for name, body in bodies.items():
                    url='/downloads/'+name
                    status,h,b=get(url,old=True)
                    self.assertEqual((status,h['content-type'],b),(200,'application/octet-stream',body))
                    status,h,b=get(url)
                    self.assertEqual((status,h['content-type'],b),(200,MIME,body))
                    self.assertEqual(h['x-content-type-options'],'nosniff')
                    self.assertNotIn('cache-control',h)  # Public route's existing native cache policy.
                    status,hh,b=get(url,'HEAD')
                    self.assertEqual((status,hh['content-type'],b),(200,MIME,b''))
                    self.assertEqual(hh['content-length'],str(len(body)))
                    self.assertEqual(hh['etag'],h['etag'])
                    for headers in ({'If-None-Match':h['etag']},{'If-Modified-Since':h['last-modified']}):
                        self.assertEqual(get(url,headers=headers)[::2],(304,b''))
                    self.assertEqual(get(url,headers={'Range':'bytes=0-3'})[::2],(206,body[:4]))
                    self.assertEqual(get(url,headers={'If-Match':'"not-this-file"'})[0],412)
                    self.assertEqual(get(url+'?download=1')[::2],(200,body))
                self.assertEqual(get('/downloads/absent.apk',old=True)[::2],(200,shell))
                for path in ('/downloads/absent.apk','/downloads/ABSENT.APK','/downloads/sub/absent.apk',
                             '/downloads/absent%2Eapk','/downloads/absent.apk?download=1'):
                    for method in ('GET','HEAD'):
                        status,h,b=get(path,method)
                        self.assertEqual(status,404)
                        self.assertNotEqual(b,shell)
                for path in ('/downloads/.hidden.apk','/downloads/private.env'):
                    self.assertEqual(get(path)[0],403)
                self.assertEqual(get('/unrelated/spa-route')[::2],(200,shell))
                report['checks_completed']=True
        finally:
            if worker is not None:
                if worker.poll() is None: worker.terminate()
                try: worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill();worker.wait(timeout=5);report['forced_kill']=True
                report['worker_exit_code']=worker.returncode
                report['worker_closed']=worker.poll() is not None
            closed=[]
            for p in (port,control_port):
                with socket.socket() as s: closed.append(s.connect_ex(('127.0.0.1',p))!=0)
            report['ports_closed']=all(closed)
            report['passed']=bool(report.get('checks_completed') and report.get('worker_closed')
                                  and report.get('worker_exit_code')==0 and report['ports_closed']
                                  and not report.get('forced_kill'))
            (root/'report.json').write_text(json.dumps(report,indent=2))
        self.assertTrue(report['ports_closed'])
        self.assertTrue(report['worker_closed'])
        self.assertNotIn('forced_kill',report)
        self.assertEqual(report['worker_exit_code'],0)


if __name__ == '__main__': unittest.main()
