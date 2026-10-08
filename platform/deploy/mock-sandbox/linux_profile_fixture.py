#!/usr/bin/env python3
"""Opt-in real Linux namespace/HUP fixture; never a production entrypoint.

Only runs as PID 1 in the dedicated, disposable, network-isolated Docker image.
No service mocks, patched syscalls, production paths mounted from the host, or
profile activation. A platform refusal is NOT a passing/skip test result.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import types
import urllib.request

HERE = Path(__file__).resolve().parent
OUT = Path('/evidence')
TOKEN = 'oasis-private-linux-profile-v1'


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def guard():
    require(platform.system() == 'Linux', 'LINUX_REQUIRED_NOT_A_TEST_PASS')
    require(os.geteuid() == 0 and os.getpid() == 1, 'OWNED_CONTAINER_PID1_REQUIRED')
    require(Path('/.dockerenv').is_file(), 'DEDICATED_DOCKER_CONTAINER_REQUIRED')
    require(os.environ.get('OASIS_PROFILE_LINUX_FIXTURE') == TOKEN,
            'EXPLICIT_FIXTURE_ENVIRONMENT_REQUIRED')
    require(Path('/fixture-marker').read_text() == TOKEN + '\n', 'IMAGE_MARKER_REQUIRED')
    require(HERE == Path('/capsule') and not OUT.exists(), 'FRESH_PRIVATE_IMAGE_REQUIRED')
    # No external network or host network namespace is acceptable. Docker's
    # --network none exposes only loopback in this disposable container.
    require(set(os.listdir('/sys/class/net')) == {'lo'}, 'PRIVATE_LOOPBACK_ONLY_REQUIRED')
    require(not Path('/var/run/docker.sock').exists(), 'DOCKER_SOCKET_MUST_NOT_BE_MOUNTED')


def write(path, raw, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
    path.chmod(mode)
    return path


def identity(path):
    path = Path(path)
    s = path.lstat()
    return {'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode),
            'inode': s.st_ino, 'nlink': s.st_nlink,
            **({'sha256': sha(path.read_bytes()), 'bytes': s.st_size}
               if path.is_file() and not path.is_symlink() else {}),
            **({'link': os.readlink(path)} if path.is_symlink() else {})}


def snapshot(paths):
    return {str(p): identity(p) for p in paths}


def command(args, timeout=30):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    require(p.returncode == 0, 'COMMAND_FAILED ' + json.dumps({
        'argv': args, 'returncode': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}))
    return p


def self_security_context():
    """Diagnostic only: fixed self files, bounded reads, no inferred mount errno.

    Missing or denied diagnostics do not replace the native mount result. Never
    copy other status fields, environment, process arguments or host state.
    """
    def read(path, limit):
        try:
            with Path(path).open('rb') as stream:
                raw = stream.read(limit + 1)
        except OSError as error:
            return None, {'state': 'unavailable', 'reason': 'read_error', 'errno': error.errno}
        if len(raw) > limit:
            return None, {'state': 'unavailable', 'reason': 'size_limit'}
        try:
            return raw.decode('utf-8'), None
        except UnicodeError:
            return None, {'state': 'unavailable', 'reason': 'invalid_utf8'}

    text, error = read('/proc/self/status', 16 * 1024)
    if error:
        status = error
    else:
        allowed = ('CapEff', 'CapBnd', 'NoNewPrivs', 'Seccomp')
        found = {name: [] for name in allowed}
        for line in text.splitlines():
            name, colon, value = line.partition(':')
            if colon and name in found:
                found[name].append(value.strip())
        fields, unavailable = {}, {}
        for name, values in found.items():
            if len(values) != 1:
                unavailable[name] = 'missing' if not values else 'duplicate'
            elif name.startswith('Cap') and re.fullmatch(r'[0-9a-fA-F]{16}', values[0]):
                fields[name] = values[0]
            elif name == 'NoNewPrivs' and values[0] in ('0', '1'):
                fields[name] = int(values[0])
            elif name == 'Seccomp' and values[0] in ('0', '1', '2'):
                fields[name] = int(values[0])
            else:
                unavailable[name] = 'malformed'
        status = {'state': 'partial' if unavailable else 'available',
                  'fields': fields, 'unavailable_fields': unavailable}

    text, error = read('/proc/self/attr/current', 1024)
    if error:
        label = error
    else:
        value = text.removesuffix('\n')
        label = ({'state': 'available', 'value': value} if value and value.isprintable()
                 else {'state': 'unavailable', 'reason': 'malformed'})
    return {'scope': 'container_process_self', 'proc_self_status': status, 'lsm_current': label}


def wait_body(port, expected, timeout=5):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    start = time.monotonic()
    observations = []
    while time.monotonic() - start < timeout:
        try:
            with opener.open('http://127.0.0.1:' + str(port) + '/', timeout=0.4) as response:
                body = response.read()
            observations.append({'elapsed': time.monotonic() - start, 'body': body.decode()})
            if body == expected:
                return observations
        except (OSError, TimeoutError) as error:
            observations.append({'elapsed': time.monotonic() - start, 'error': str(error)})
        time.sleep(0.025)
    raise RuntimeError('OWNED_NGINX_READBACK_FAILED ' + json.dumps(observations))


def case(report, name, operation):
    result = {'name': name, 'passed': False}
    report['cases'].append(result)
    try:
        result.update(operation())
        result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        (OUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


def main():
    guard()  # No output directory, subprocess or Linux write before this guard.
    OUT.mkdir(mode=0o700)
    capsule = types.ModuleType('unmodified_profile_activation')
    capsule.__file__ = str(HERE / 'profile_activation.py')
    exec(compile((HERE / 'profile_activation.py').read_bytes(), capsule.__file__, 'exec'), capsule.__dict__)
    a = capsule
    report = {'schema': TOKEN, 'passed': False, 'kernel': platform.release(),
              'machine': platform.machine(), 'identity': a.dependency_identity(),
              'namespace': os.readlink('/proc/self/ns/mnt'), 'cases': [],
              'synthetic_config_only': True, 'real_syscalls_and_nginx': True,
              'systemd_dispatch_tested': False, 'production_accessed': False,
              'cleanup': {'owned_nginx_exited': False, 'nested_mount_removed': False}}
    master = None
    nginx_started = False
    mounted = False
    protected = []
    main_conf = Path('/etc/nginx/nginx.conf')
    target = a.profile.TLS_CONF
    other = Path('/etc/nginx/conf.d/fixture-unrelated.conf')
    # These are all inside the owned image, never a bind mount from the Mac or
    # production server. Include closure and compiled defaults are still real.
    old = b'server { listen 127.0.0.1:18080; return 200 "before"; }\n'
    new = b'server { listen 127.0.0.1:18080; return 200 "after"; }\n'
    temp_paths = [Path('/var/lib/nginx') / n for n in ('body', 'proxy', 'fastcgi', 'uwsgi', 'scgi')]
    try:
        control = a.profile.PROFILE_ROOT.parent / a.CONTROL_NAME
        control.mkdir(parents=True, mode=0o700)
        control.chmod(0o700)
        write(main_conf, '''user www-data;
worker_processes 1;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
lock_file /run/lock/nginx.lock;
include /etc/nginx/modules-enabled/*.conf;
events { worker_connections 32; }
http {
 access_log /var/log/nginx/access.log;
 client_body_temp_path /var/lib/nginx/body;
 proxy_temp_path /var/lib/nginx/proxy;
 fastcgi_temp_path /var/lib/nginx/fastcgi;
 uwsgi_temp_path /var/lib/nginx/uwsgi;
 scgi_temp_path /var/lib/nginx/scgi;
 proxy_cache_path /var/lib/nginx/fixture-proxy-cache keys_zone=fixture_proxy:1m;
 fastcgi_cache_path /var/lib/nginx/fixture-fastcgi-cache keys_zone=fixture_fastcgi:1m;
 include /etc/nginx/conf.d/*.conf;
}
''')
        write(target, old)
        write(other, 'server { listen 127.0.0.1:18081; return 200 "unrelated"; }\n')
        version = command(['/usr/sbin/nginx', '-V'])
        report['nginx_version'] = version.stderr
        inventory = a.config_inventory()
        destinations = a.namespace_write_directories(inventory, version.stderr)
        for p in destinations + temp_paths:
            p.mkdir(parents=True, exist_ok=True)
        for p in temp_paths:
            p.chmod(0o750)
            os.chown(p, 1234, 1234)
        for p in destinations + [Path('/unrelated')]:
            p.mkdir(parents=True, exist_ok=True)
            sentinel = write(p / 'fixture-unrelated-original', b'owned sentinel\x00\xff', 0o440)
            os.chown(sentinel, 1234, 1234)
            protected += [p, sentinel]
        nested = Path('/unrelated/nested')
        nested.mkdir()
        report['process_security_before_first_mount'] = self_security_context()
        command(['/usr/bin/mount', '-t', 'tmpfs', '-o', 'size=1m', 'fixture-owned', str(nested)])
        mounted = True
        sentinel = write(nested / 'original', b'nested separate mount', 0o400)
        protected += [nested, sentinel, main_conf, target, other, *HERE.glob('*.py')]
        protected = list(dict.fromkeys(protected))
        before = snapshot(protected)
        (OUT / 'protected-before.json').write_text(json.dumps(before, indent=2) + '\n')
        materials = types.SimpleNamespace(control=control, config=target)
        class RecordedNativeRuntime(a.ActivationRuntime):
            """Run every real command once, retaining the native failure output."""
            serial = 0

            def run(self, args, **kwargs):
                self.serial += 1
                started = time.monotonic()
                record = {'argv': args, 'real_subprocess': True}
                try:
                    result = subprocess.run(args, capture_output=True, check=False, timeout=60, **kwargs)
                    record.update(returncode=result.returncode,
                                  stdout=result.stdout.decode(errors='replace'),
                                  stderr=result.stderr.decode(errors='replace'))
                    require(result.returncode == 0, 'MOCK_COMMAND_FAILED')
                    return result.stdout
                except (OSError, subprocess.TimeoutExpired) as error:
                    record['error'] = str(error)
                    raise RuntimeError('MOCK_COMMAND_FAILED') from error
                finally:
                    record['elapsed_seconds'] = time.monotonic() - started
                    (OUT / ('native-command-%02d.json' % self.serial)).write_text(
                        json.dumps(record, indent=2) + '\n')

        runtime = RecordedNativeRuntime(materials)

        def positive():
            digest = runtime.syntax(new, inventory)
            require(snapshot(protected) == before, 'NAMESPACE_CHANGED_ORIGINAL_IDENTITIES')
            results = sorted(control.glob('syntax-*/result.json'))
            proofs = [json.loads(p.read_text()) for p in results]
            require(len(proofs) == 1 and proofs[0]['recursive_readonly'], 'MISSING_REAL_PROOF')
            require(sha(results[0].read_bytes()) == digest, 'PROOF_HASH_MISMATCH')
            return {'proof': proofs[0], 'proof_sha256': digest, 'protected_unchanged': True}
        case(report, 'real_recursive_readonly_full_enclosure_success', positive)

        def rejection(raw, expected_before):
            try:
                runtime.syntax(raw, a.config_inventory())
            except RuntimeError as error:
                require(snapshot(protected) == expected_before, 'FAILED_SYNTAX_CHANGED_ORIGINALS')
                return {'refusal': str(error), 'protected_unchanged': True}
            raise RuntimeError('REAL_NGINX_MUST_REJECT_INVALID_SYNTAX')
        case(report, 'candidate_syntax_failure_isolated', lambda: rejection(
            b'server { listen 18080; invalid_fixture_directive on; }\n', before))
        write(other, 'server { listen 18081; invalid_unrelated_directive on; }\n')
        case(report, 'unrelated_include_syntax_failure_proves_full_enclosure',
             lambda: rejection(new, snapshot(protected)))
        write(other, 'server { listen 127.0.0.1:18081; return 200 "unrelated"; }\n')
        require(snapshot(protected) == before, 'FIXTURE_RESTORE_CHANGED_ORIGINALS')

        # Actual owned nginx master startup is separate from the syntax check.
        # All paths are this container's paths, not a host service or systemctl.
        command(['/usr/sbin/nginx'])
        nginx_started = True
        master = int(Path('/run/nginx.pid').read_text())
        require(master > 1 and Path('/proc/' + str(master) + '/exe').resolve() == Path('/usr/sbin/nginx'),
                'OWNED_NGINX_MASTER_REQUIRED')
        report['master_pid'] = master
        report['initial_http'] = wait_body(18080, b'before')
        hup_protected = [p for p in protected if p != target]
        hup_before = snapshot(hup_protected)
        (OUT / 'hup-protected-before.json').write_text(json.dumps(hup_before, indent=2) + '\n')

        def hup():
            write(target, new)
            os.kill(master, signal.SIGHUP)
            observations = wait_body(18080, b'after')
            wait_body(18081, b'unrelated')
            after = snapshot(hup_protected)
            (OUT / 'hup-protected-after.json').write_text(json.dumps(after, indent=2) + '\n')
            require(after == hup_before, 'DIRECT_HUP_CHANGED_UNRELATED_IDENTITIES')
            return {'readback': observations, 'protected_unchanged': True,
                    'signal': 'SIGHUP', 'same_master': int(Path('/run/nginx.pid').read_text()) == master}
        case(report, 'real_direct_hup_preserves_current_unrelated_files_owners_modes', hup)

        # A separate drift case intentionally changes an owned compiled temp
        # directory before another valid HUP. Any create_paths chown/chmod is a
        # real blocker to an unrestricted immutability claim, NOT an expected
        # mutation reclassified as green. No production directory is involved.
        def drift_hup():
            drift = temp_paths[0]
            os.chown(drift, 1234, 1234)
            drift.chmod(0o500)
            drift_before = identity(drift)
            write(target, b'server { listen 127.0.0.1:18080; return 200 "drift"; }\n')
            os.kill(master, signal.SIGHUP)
            observations = wait_body(18080, b'drift')
            drift_after = identity(drift)
            finding = {'path': str(drift), 'before': drift_before, 'after': drift_after,
                       'readback': observations, 'protected_unchanged': drift_before == drift_after}
            (OUT / 'hup-drift-result.json').write_text(json.dumps(finding, indent=2) + '\n')
            require(drift_before == drift_after, 'DIRECT_HUP_MUTATES_DRIFTED_COMPILED_TEMP_METADATA')
            return finding
        case(report, 'real_direct_hup_drifted_shared_temp_metadata_is_not_silently_mutated', drift_hup)
        report['passed'] = True
    except Exception as error:
        report['failure'] = str(error)
    finally:
        if master is not None:
            try:
                os.kill(master, signal.SIGQUIT)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    pid, _ = os.waitpid(master, os.WNOHANG)
                except ChildProcessError:
                    pid = master if not Path('/proc/' + str(master)).exists() else 0
                if pid == master:
                    report['cleanup']['owned_nginx_exited'] = True
                    break
                time.sleep(0.025)
        else:
            report['cleanup']['owned_nginx_exited'] = not nginx_started
        if mounted:
            try:
                command(['/usr/bin/umount', '/unrelated/nested'])
                report['cleanup']['nested_mount_removed'] = True
            except Exception as error:
                report['cleanup']['mount_error'] = str(error)
        else:
            report['cleanup']['nested_mount_removed'] = True
        ports_closed = []
        for port in (18080, 18081):
            with socket.socket() as probe:
                probe.settimeout(0.2)
                ports_closed.append(probe.connect_ex(('127.0.0.1', port)) != 0)
        report['cleanup']['ports_closed'] = all(ports_closed)
        report['passed'] = report['passed'] and all(report['cleanup'].values())
        report['identity_after'] = a.dependency_identity()
        report['capsule_unchanged'] = report['identity_after'] == report['identity']
        report['passed'] = report['passed'] and report['capsule_unchanged']
        (OUT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'passed': False, 'completed': False, 'refusal': str(error)}), file=sys.stderr)
        sys.exit(2)
