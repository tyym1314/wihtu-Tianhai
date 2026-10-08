#!/usr/bin/env python3
"""Opt-in real Linux fixture for the rootless dedicated Mock ingress.

Never run on a host: fresh disposable Docker PID 1, --network none, no host
binds/devices, only the explicit six-default-capability setup subset, and no
mount or shared service operation. Every Nginx child has zero usable caps.
Ordinary local unit tests cover helpers only; a platform refusal is not a pass.
"""
import ctypes
import hashlib
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shlex
import signal
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
OUT = Path('/evidence')
TOKEN = 'oasis-rootless-dedicated-ingress-v1'
UID = GID = 2345
PREFIX = Path('/etc/oasis-android-mock-ingress')
RUNTIME = Path('/run/oasis-android-mock-ingress')
CREDENTIALS = Path('/run/credentials/oasis-android-mock-ingress.service')
NGINX = '/usr/sbin/nginx'
TEMP_NAMES = ('body', 'proxy', 'fastcgi', 'uwsgi', 'scgi')
CAP_FIELDS = ('CapEff', 'CapPrm', 'CapInh', 'CapAmb')
SETUP_CAP_MASK = 0xeb  # CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID only
MAX_TREE_FILES = 4096
MAX_TREE_BYTES = 16 * 1024 * 1024


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def mount_targets(text):
    targets = []
    for line in text.splitlines():
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields, 'MOUNT_INVENTORY_INVALID')
        target = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), fields[4])
        require(target.startswith('/') and '\x00' not in target, 'MOUNT_TARGET_INVALID')
        targets.append(target)
    return targets


def assert_container_mounts(text):
    # Docker-managed hostname/resolver files are not user-supplied fixture binds.
    allowed = {'/', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'}
    targets = mount_targets(text)
    require('/' in targets, 'ROOT_MOUNT_MISSING')
    for target in targets:
        require(target in allowed or any(target == p or target.startswith(p + '/')
                for p in ('/proc', '/dev', '/sys')), 'EXTRA_CONTAINER_MOUNT_FORBIDDEN: ' + target)
    return targets


def guard():
    require(platform.system() == 'Linux', 'LINUX_REQUIRED_NOT_A_TEST_PASS')
    require(os.geteuid() == 0 and os.getpid() == 1, 'OWNED_CONTAINER_ROOT_PID1_REQUIRED')
    require(Path('/.dockerenv').is_file(), 'DEDICATED_DOCKER_CONTAINER_REQUIRED')
    require(os.environ.get('OASIS_DEDICATED_INGRESS_FIXTURE') == TOKEN, 'EXPLICIT_FIXTURE_ENVIRONMENT_REQUIRED')
    require(Path('/fixture-marker').read_text() == TOKEN + '\n', 'IMAGE_MARKER_REQUIRED')
    require(HERE == Path('/capsule') and not OUT.exists(), 'FRESH_CAPSULE_AND_EVIDENCE_REQUIRED')
    require(set(os.listdir('/sys/class/net')) == {'lo'}, 'NETWORK_NONE_REQUIRED')
    require(not Path('/var/run/docker.sock').exists(), 'DOCKER_SOCKET_FORBIDDEN')
    assert_setup_security(security_fields(Path('/proc/self/status').read_text()))
    require(Path('/proc/self/attr/current').read_text().strip() == 'docker-default (enforce)', 'DEFAULT_APPARMOR_REQUIRED')
    return assert_container_mounts(Path('/proc/self/mountinfo').read_text())


def security_fields(text):
    names = ('Uid', 'Gid', 'Groups', *CAP_FIELDS, 'CapBnd', 'NoNewPrivs', 'Seccomp')
    result = {}
    for line in text.splitlines():
        key, colon, value = line.partition(':')
        if colon and key in names:
            require(key not in result, 'DUPLICATE_SECURITY_FIELD')
            value = value.strip()
            if key in CAP_FIELDS or key == 'CapBnd':
                require(re.fullmatch(r'[a-fA-F0-9]{16}', value), 'INVALID_CAPABILITY_FIELD')
                result[key] = value
            elif key in ('Uid', 'Gid', 'Groups'):
                require(not value or re.fullmatch(r'\d+(?:\s+\d+)*', value), 'INVALID_PROCESS_IDENTITY')
                result[key] = [int(v) for v in value.split()]
            else:
                require(value.isdigit(), 'INVALID_SECURITY_FIELD')
                result[key] = int(value)
    require(set(result) == set(names), 'INCOMPLETE_SECURITY_FIELDS')
    return result


def assert_setup_security(fields):
    require(fields['Uid'] == [0] * 4 and fields['Gid'] == [0] * 4, 'SETUP_ROOT_IDENTITY_REQUIRED')
    require(all(int(fields[k], 16) == SETUP_CAP_MASK for k in ('CapEff', 'CapPrm', 'CapBnd')),
            'ONLY_SIX_SETUP_CAPABILITIES_ALLOWED')
    require(all(int(fields[k], 16) == 0 for k in ('CapInh', 'CapAmb')), 'SETUP_INHERITED_CAPS_FORBIDDEN')
    require(fields['NoNewPrivs'] == 1 and fields['Seccomp'] == 2, 'DEFAULT_SECCOMP_AND_NO_NEW_PRIVILEGES_REQUIRED')
    return fields


def assert_rootless(fields):
    require(fields['Uid'] == [UID] * 4 and fields['Gid'] == [GID] * 4, 'ROOTLESS_IDENTITY_MISMATCH')
    require(fields['Groups'] == [], 'SUPPLEMENTARY_GROUPS_FORBIDDEN')
    require(all(int(fields[k], 16) == 0 for k in CAP_FIELDS), 'CHILD_CAPABILITIES_NOT_ZERO')
    require(fields['NoNewPrivs'] == 1, 'NO_NEW_PRIVILEGES_REQUIRED')
    require(int(fields['CapBnd'], 16) == SETUP_CAP_MASK and fields['Seccomp'] == 2, 'CHILD_BOUND_OR_SECCOMP_CHANGED')
    return fields


def drop_privileges():
    # A container root setup process may use its ordinary SETUID/SETGID caps;
    # the Nginx master, workers, syntax checker and upstream get none of them.
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(38, 1, 0, 0, 0) == 0, 'NO_NEW_PRIVILEGES_FAILED')
    assert_rootless(security_fields(Path('/proc/self/status').read_text()))


def identity(path):
    info = path.lstat()
    result = {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
              'kind': stat.S_IFMT(info.st_mode), 'device': info.st_dev, 'inode': info.st_ino,
              'nlink': info.st_nlink, 'mtime_ns': info.st_mtime_ns, 'ctime_ns': info.st_ctime_ns}
    if stat.S_ISREG(info.st_mode):
        require(info.st_size <= MAX_TREE_BYTES, 'PROTECTED_FILE_TOO_LARGE')
        result.update(size=info.st_size, sha256=sha(path.read_bytes()))
    elif stat.S_ISLNK(info.st_mode):
        result['target'] = os.readlink(path)
    return result


def snapshot(roots):
    """Do not follow aliases or include atime (the read itself can change it)."""
    result = {}
    total_bytes = 0
    def visit(path):
        nonlocal total_bytes
        require(len(result) < MAX_TREE_FILES, 'PROTECTED_TREE_TOO_LARGE')
        name = str(path)
        if name in result:
            return
        try:
            entry = identity(path)
        except FileNotFoundError:
            result[name] = {'missing': True}
            return
        result[name] = entry
        total_bytes += entry.get('size', 0)
        require(total_bytes <= MAX_TREE_BYTES, 'PROTECTED_BYTES_TOO_LARGE')
        if entry['kind'] == stat.S_IFDIR:
            for child in sorted(path.iterdir()):
                visit(child)
    for root in roots:
        visit(Path(root))
    return result


def require_unchanged(before, roots):
    after = snapshot(roots)
    changes = [name for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)]
    require(not changes, 'SHARED_PATHS_CHANGED: ' + json.dumps(changes))
    return {'protected_entries': len(after), 'unchanged': True, 'snapshot_sha256': sha(json.dumps(after, sort_keys=True).encode())}


def compile_paths(version):
    matches = re.findall(r'^configure arguments:\s*(.*)$', version, re.M)
    require(len(matches) == 1, 'NGINX_COMPILE_ARGUMENTS_MISSING')
    paths = {}
    allowed = {'--http-client-body-temp-path', '--http-proxy-temp-path', '--http-fastcgi-temp-path',
               '--http-uwsgi-temp-path', '--http-scgi-temp-path', '--pid-path', '--lock-path',
               '--error-log-path', '--http-log-path'}
    for argument in shlex.split(matches[0]):
        name, equal, value = argument.partition('=')
        if name not in allowed:
            continue
        require(equal and name not in paths, 'COMPILED_PATH_DUPLICATE')
        if value == 'stderr' and name == '--error-log-path':
            paths[name] = value
            continue
        require(value.startswith('/') and '..' not in Path(value).parts and '//' not in value,
                'UNSAFE_COMPILED_PATH')
        require(any(value == p or value.startswith(p + '/') for p in ('/var', '/run')),
                'UNEXPECTED_COMPILED_PATH_REQUIRES_REVIEW')
        paths[name] = value
    require(allowed <= set(paths), 'COMPILED_WRITE_PATH_INVENTORY_INCOMPLETE')
    return paths


def validate_rendered(raw):
    require(isinstance(raw, bytes) and len(raw) <= 128 * 1024, 'RENDERED_CONFIG_INVALID')
    text = raw.decode('utf-8')
    expected = {**{name + '_temp_path': str(RUNTIME / suffix) for name, suffix in
                  (('client_body', 'body'), ('proxy', 'proxy'), ('fastcgi', 'fastcgi'), ('uwsgi', 'uwsgi'), ('scgi', 'scgi'))},
                'pid': str(RUNTIME / 'nginx.pid'), 'lock_file': str(RUNTIME / 'nginx.lock'),
                'error_log': 'stderr notice', 'access_log': 'off'}
    for directive, value in expected.items():
        found = re.findall(r'^\s*' + directive + r'\s+([^;\n]+);\s*$', text, re.M)
        require(found == [value], 'EXPLICIT_PRIVATE_PATH_REQUIRED: ' + directive)
    require(not re.search(r'^\s*(?:user|include)\s', text, re.M), 'SHARED_CONFIG_INCLUDE_OR_USER_FORBIDDEN')
    for value in (b'daemon off;', b'master_process on;', b'worker_processes 1;',
                  b'listen 127.0.0.1:18986 ssl http2;',
                  b'ssl_certificate ' + str(CREDENTIALS / 'fullchain.pem').encode() + b';',
                  b'ssl_certificate_key ' + str(CREDENTIALS / 'privkey.pem').encode() + b';'):
        require(raw.count(value) == 1, 'DEDICATED_CONFIG_CONTRACT_MISMATCH')
    return expected


def write(path, raw, mode=0o444):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
    path.chmod(mode)
    return path


def protect_shared(compiled):
    roots = [Path('/etc/nginx'), Path('/var/lib/nginx'), Path('/var/log/nginx'),
             Path('/run/lock'), Path('/run/nginx.pid'), Path('/var/lock'), HERE]
    directories = {Path('/var/lib/nginx') / name for name in TEMP_NAMES}
    for name, value in compiled.items():
        if value == 'stderr':
            continue
        path = Path(value)
        if name.endswith('-temp-path'):
            directories.add(path)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            require(not path.is_symlink(), 'COMPILED_FILE_ALIAS_REQUIRES_REVIEW')
            write(path, b'fixture original compiled destination\n', 0o400)
            roots.append(path)
    for i, path in enumerate(sorted(directories)):
        path.mkdir(parents=True, exist_ok=True)
        write(path / 'root-original', b'fixture root sentinel\x00\xff', 0o400)
        foreign = write(path / 'foreign-original', b'fixture uid1234 sentinel\x00\xff', 0o400)
        os.chown(foreign, 1234, 1234)
        os.chown(path, 0 if i % 2 == 0 else 1234, 0 if i % 2 == 0 else 1234)
        path.chmod(0o500)
        roots.append(path)
    # Additional foreign owner on the real compiled body path, reproducing the
    # prior direct-HUP metadata regression without changing its old assertion.
    body = Path(compiled['--http-client-body-temp-path'])
    os.chown(body, 1234, 1234)
    body.chmod(0o500)
    roots.extend(directories)
    return list(dict.fromkeys(roots))


def nginx_argv(config, syntax=False):
    args = [NGINX, '-e', 'stderr', '-p', str(PREFIX) + '/', '-c', str(config)]
    return args + (['-t'] if syntax else [])


def process_identity(pid):
    status = Path('/proc') / str(pid) / 'status'
    text = (Path('/proc') / str(pid) / 'stat').read_text()
    # The comm field may contain spaces/parentheses; fields after its last ')'.
    fields = text[text.rfind(')') + 2:].split()
    return {'pid': pid, 'start_ticks': int(fields[19]), 'security': assert_rootless(security_fields(status.read_text()))}


def workers(master):
    raw = (Path('/proc') / str(master.pid) / 'task' / str(master.pid) / 'children').read_text()
    return [process_identity(int(pid)) for pid in raw.split()]


def wait_for(operation, code, timeout=5):
    end = time.monotonic() + timeout
    observations = []
    while time.monotonic() < end:
        try:
            value = operation()
            if value:
                return value
        except (OSError, ValueError, ssl.SSLError) as error:
            observations.append(type(error).__name__)
        time.sleep(.025)
    raise RuntimeError(code + ': ' + ','.join(observations[-4:]))


def tls_exchange(cafile, host, path='/health', real_ip=None, host_header=None):
    context = ssl.create_default_context(cafile=str(cafile))
    with socket.create_connection(('127.0.0.1', 18986), timeout=.8) as plain:
        with context.wrap_socket(plain, server_hostname=host) as connection:
            extra = '' if real_ip is None else 'X-Real-IP: ' + real_ip + '\r\n'
            connection.sendall(('GET ' + path + ' HTTP/1.1\r\nHost: ' + (host_header or host) + '\r\n' + extra + 'Connection: close\r\n\r\n').encode())
            response = http.client.HTTPResponse(connection)
            response.begin()
            body = response.read(16 * 1024)
            return {'status': response.status, 'tls_version': connection.version(), 'body_bytes': body,
                    'location': response.getheader('Location'), 'certificate_validated': True,
                    'socket': '127.0.0.1:18986', 'sni': host}


def tls_read(cafile, host, path='/health', real_ip=None):
    response = tls_exchange(cafile, host, path, real_ip)
    require(response['status'] == 200, 'TLS_UPSTREAM_STATUS_FAILED')
    body = json.loads(response.pop('body_bytes'))
    require(body.get('fixture') == 'owned-loopback-upstream', 'WRONG_TLS_UPSTREAM_BODY')
    return {**response, 'body': body}


def tls_redirect(cafile, host, host_header):
    response = tls_exchange(cafile, host, '/demo', host_header=host_header)
    require(response['status'] == 308, 'MOCK_DEMO_REDIRECT_STATUS_FAILED')
    require(response['location'] == 'https://' + host + '/demo/', 'PRIVATE_INGRESS_PORT_LEAKED_IN_REDIRECT')
    response['body_sha256'] = sha(response.pop('body_bytes'))
    response['request_host'] = host_header
    return response


def run_upstreams():
    require(platform.system() == 'Linux' and os.getppid() == 1 and os.geteuid() == UID,
            'OWNED_ROOTLESS_UPSTREAM_REQUIRED')
    require(os.environ.get('OASIS_DEDICATED_INGRESS_FIXTURE') == TOKEN, 'UPSTREAM_FIXTURE_ENV_REQUIRED')
    assert_rootless(security_fields(Path('/proc/self/status').read_text()))
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            raw = json.dumps({'fixture': 'owned-loopback-upstream', 'path': self.path,
                              'host': self.headers.get('Host'), 'x-real-ip': self.headers.get('X-Real-IP')}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        def log_message(self, *_args):
            pass
    servers = [http.server.ThreadingHTTPServer(('127.0.0.1', p), Handler) for p in (18981, 18985)]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print('OWNED_UPSTREAM_READY', flush=True)
    while True:
        signal.pause()


def main():
    mount_inventory = guard()  # Before output, filesystem mutation or subprocess.
    OUT.mkdir(mode=0o700)
    report = {'schema': TOKEN, 'passed': False, 'kernel': platform.release(),
              'mount_targets': mount_inventory, 'setup_security': security_fields(Path('/proc/self/status').read_text()),
              'apparmor': Path('/proc/self/attr/current').read_text().strip(), 'real_nginx': True, 'rootless_uid': UID,
              'production_accessed': False, 'host_binds_used': False, 'mount_syscalls_used': False,
              'cases': [], 'commands': [], 'cleanup': {},
              'limitations': ['Synthetic private Linux TLS/paths only; not production/systemd activation.',
                              'The shared outer TLS proxy and its header sanitization are not exercised.',
                              'Historical overlay routing, current release pair, DB and 13-game APK acceptance remain separate.',
                              'No systemd LoadCredential namespace/lifecycle, unit sandbox or certificate renewal restart is tested.']}
    master = upstream = None
    protected = None
    before = None
    logs = []
    config = PREFIX / 'nginx.conf'
    def persist():
        (OUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    def command(args, *, rootless=False, expect=0, timeout=15):
        started = time.monotonic()
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           preexec_fn=drop_privileges if rootless else None)
        report['commands'].append({'argv': args, 'rootless': rootless, 'returncode': p.returncode,
                                   'stdout': p.stdout, 'stderr': p.stderr,
                                   'elapsed_seconds': time.monotonic() - started})
        persist()
        require(p.returncode == expect if expect is not None else p.returncode != 0, 'REAL_COMMAND_RESULT_UNEXPECTED')
        return p
    def case(name, operation):
        record = {'name': name, 'passed': False}
        report['cases'].append(record)
        try:
            record.update(operation() or {})
            record.update(require_unchanged(before, protected))
            record['passed'] = True
        except Exception as error:
            record['error'] = str(error)
            raise
        finally:
            persist()
    try:
        version = command([NGINX, '-e', 'stderr', '-V'], rootless=True)
        report['nginx_version'] = version.stderr
        report['nginx_sha256'] = sha(Path(NGINX).read_bytes())
        compiled = compile_paths(version.stderr)
        report['compiled_paths'] = compiled
        spec = importlib.util.spec_from_file_location('dedicated_ingress_fixture_renderer', HERE / 'dedicated_ingress.py')
        renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(renderer)
        profile = renderer.original_profile()
        rendered = renderer.build_config(profile)
        report['explicit_private_destinations'] = validate_rendered(rendered)
        report['profile_sha256'] = sha(profile)
        report['rendered_sha256'] = sha(rendered)
        report['capsule_sha256'] = {p.name: sha(p.read_bytes()) for p in sorted(HERE.iterdir()) if p.is_file()}
        PREFIX.mkdir(mode=0o755)
        write(config, rendered)
        source_profile = write(PREFIX / 'source-profile.conf', profile)
        PREFIX.chmod(0o555)
        RUNTIME.mkdir(mode=0o700)
        os.chown(RUNTIME, UID, GID)
        private = Path('/fixture-private')
        private.mkdir(mode=0o700)
        CREDENTIALS.mkdir(parents=True, mode=0o750)
        os.chown(CREDENTIALS, 0, GID)
        ca = private / 'ca.pem'
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                 '-subj', '/CN=OASIS dedicated fixture CA', '-keyout', str(private / 'ca.key'), '-out', str(ca)])
        command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + renderer.HOST,
                 '-keyout', str(CREDENTIALS / 'privkey.pem'), '-out', str(private / 'server.csr')])
        extensions = write(private / 'extensions.cnf', 'subjectAltName=DNS:' + renderer.HOST + ',DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        command(['openssl', 'x509', '-req', '-in', str(private / 'server.csr'), '-CA', str(ca),
                 '-CAkey', str(private / 'ca.key'), '-CAcreateserial', '-days', '1',
                 '-extfile', str(extensions), '-out', str(CREDENTIALS / 'fullchain.pem')])
        for path in CREDENTIALS.iterdir():
            os.chown(path, 0, GID)
            path.chmod(0o440)
        protected = protect_shared(compiled) + [source_profile, CREDENTIALS]
        # Source/profile and shared trees are immutable to the dedicated user;
        # only the explicit test config changes during invalid-HUP injection.
        before = snapshot(protected)
        write(OUT / 'protected-before.json', json.dumps(before, indent=2) + '\n', 0o600)
        upstream_log = (OUT / 'upstream.log').open('wb')
        logs.append(upstream_log)
        upstream = subprocess.Popen([sys.executable, '-B', str(HERE / 'dedicated_ingress_fixture.py'), '--upstream'],
                                    stdout=upstream_log, stderr=subprocess.STDOUT, preexec_fn=drop_privileges)
        wait_for(lambda: b'OWNED_UPSTREAM_READY' in (OUT / 'upstream.log').read_bytes(), 'UPSTREAM_NOT_READY')
        report['upstream_identity'] = process_identity(upstream.pid)
        case('rootless_syntax_success', lambda: {'returncode': command(nginx_argv(config, True), rootless=True).returncode})
        def bad_syntax():
            write(config, rendered + b'fixture_invalid_directive on;\n')
            try:
                result = command(nginx_argv(config, True), rootless=True, expect=None)
                require('fixture_invalid_directive' in result.stderr, 'INVALID_DIRECTIVE_NOT_REJECTED')
                return {'returncode': result.returncode}
            finally:
                write(config, rendered)
        case('rootless_syntax_failure', bad_syntax)
        def bad_startup():
            write(config, rendered + b'fixture_invalid_directive on;\n')
            try:
                result = command(nginx_argv(config), rootless=True, expect=None)
                require('fixture_invalid_directive' in result.stderr, 'INVALID_STARTUP_NOT_REJECTED')
                return {'returncode': result.returncode, 'invalid_startup_rejected': True}
            finally:
                write(config, rendered)
        case('rootless_startup_failure', bad_startup)
        error_log = (OUT / 'nginx.log').open('wb')
        logs.append(error_log)
        master = subprocess.Popen(nginx_argv(config), stdout=error_log, stderr=subprocess.STDOUT, preexec_fn=drop_privileges)
        def started():
            response = wait_for(lambda: tls_read(ca, renderer.HOST), 'TLS_STARTUP_FAILED')
            children = wait_for(lambda: workers(master), 'WORKER_STARTUP_FAILED')
            require(len(children) == 1, 'ONE_DEDICATED_WORKER_REQUIRED')
            report['master_identity'] = process_identity(master.pid)
            report['initial_workers'] = children
            for name in TEMP_NAMES:
                info = (RUNTIME / name).stat()
                require(info.st_uid == UID and stat.S_ISDIR(info.st_mode), 'TEMP_PATH_NOT_PRIVATE_ROOTLESS')
            require(int((RUNTIME / 'nginx.pid').read_text()) == master.pid, 'PRIVATE_MASTER_PID_MISMATCH')
            return {'tls': response, 'workers': children}
        case('rootless_startup_tls', started)
        case('public_redirect_hides_private_port', lambda: {'responses': [tls_redirect(ca, renderer.HOST, name) for name in (renderer.HOST, renderer.HOST + ':443')]})
        def reload_valid():
            old = workers(master)
            require(len(old) == 1, 'ONE_OLD_WORKER_REQUIRED')
            require(config.read_bytes() == rendered, 'LEGAL_CONFIG_BYTES_CHANGED')
            master.send_signal(signal.SIGHUP)
            def changed():
                current = workers(master)
                return current if len(current) == 1 and current != old else None
            new = wait_for(changed, 'VALID_HUP_DID_NOT_REPLACE_WORKER')
            require(process_identity(master.pid) == report['master_identity'], 'MASTER_IDENTITY_CHANGED')
            return {'old_workers': old, 'new_workers': new, 'tls': tls_read(ca, renderer.HOST),
                    'config_sha256': sha(config.read_bytes())}
        case('rootless_valid_hup', reload_valid)
        def reload_invalid():
            old = workers(master)
            offset = (OUT / 'nginx.log').stat().st_size
            write(config, rendered + b'fixture_invalid_directive on;\n')
            master.send_signal(signal.SIGHUP)
            wait_for(lambda: b'fixture_invalid_directive' in (OUT / 'nginx.log').read_bytes()[offset:],
                     'INVALID_HUP_REJECTION_NOT_OBSERVED')
            time.sleep(.15)
            require(workers(master) == old, 'INVALID_HUP_CHANGED_WORKERS')
            require(process_identity(master.pid) == report['master_identity'], 'INVALID_HUP_CHANGED_MASTER')
            return {'old_workers_retained': True, 'tls': tls_read(ca, renderer.HOST),
                    'invalid_config_sha256': sha(config.read_bytes()), 'native_rejection_observed': True}
        try:
            case('rootless_invalid_hup_preserves_old_service', reload_invalid)
        finally:
            write(config, rendered)
        case('rootless_hup_after_invalid_config', reload_valid)
        ip = tls_read(ca, renderer.HOST, '/api/demo/fixture', '198.51.100.17')
        report['real_ip_observation'] = {'synthetic_outer_header': '198.51.100.17', 'upstream': ip,
            'outer_proxy_sanitization_tested': False, 'note': 'Direct loopback models the trusted outer hop only; it does not prove external header sanitization.'}
        if b'real_ip_header X-Real-IP;' in rendered:
            require(ip['body']['x-real-ip'] == '198.51.100.17', 'TRUSTED_LOOPBACK_REAL_IP_LOST')
        def shutdown():
            master.send_signal(signal.SIGQUIT)
            require(master.wait(timeout=10) == 0, 'NGINX_SHUTDOWN_FAILED')
            require(not (RUNTIME / 'nginx.pid').exists(), 'OWNED_PID_FILE_REMAINS')
            with socket.socket() as check:
                check.settimeout(.5)
                require(check.connect_ex(('127.0.0.1', 18986)) != 0, 'OWNED_TLS_LISTENER_REMAINS')
            return {'exit_code': master.returncode, 'listener_closed': True}
        case('rootless_graceful_shutdown', shutdown)
        report['passed'] = True
    except Exception as error:
        report['failure'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        for name, process in (('nginx', master), ('upstream', upstream)):
            if process is None:
                report['cleanup'][name] = {'started': False}
                continue
            forced = False
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        forced = True
                        process.kill()
                        process.wait(timeout=3)
                report['cleanup'][name] = {'pid': process.pid, 'exit_code': process.returncode, 'exited': True, 'forced_kill': forced}
                if forced:
                    report['passed'] = False
            except Exception as error:
                report['cleanup'][name] = {'exited': False, 'error': type(error).__name__}
                report['passed'] = False
        for log in logs:
            log.close()
        if protected is not None and before is not None:
            try:
                after = snapshot(protected)
                write(OUT / 'protected-after.json', json.dumps(after, indent=2) + '\n', 0o600)
                report['cleanup']['shared_unchanged'] = before == after
                if before != after:
                    report['passed'] = False
            except Exception as error:
                report['cleanup']['shared_unchanged'] = None
                report['cleanup']['snapshot_error'] = type(error).__name__
                report['passed'] = False
        persist()
        print(json.dumps({'passed': report['passed'], 'cases': report['cases'], 'cleanup': report['cleanup']}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    if sys.argv[1:] == ['--upstream']:
        run_upstreams()
    else:
        require(not sys.argv[1:], 'NO_ARBITRARY_FIXTURE_ARGUMENTS')
        raise SystemExit(main())
