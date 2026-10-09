#!/usr/bin/python3
"""Bounded own-route wait around the exact immutable production03 ingress.

Run only from the fixed root-private location with external SHA and provenance.
This controller never issues a certificate, changes admission, or operates DBs.
The original ingress remains responsible for all mutations, locking and rollback.
"""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from contextlib import redirect_stdout

TOOL = Path('/opt/oasis/private/production-ingress-wait-20261010/production-ingress-wait.py')
RELEASE = Path('/opt/oasis/releases/20261010-03')
MANIFEST = '901d4285c22db46c11f50b6015e7f233ae65f8c17d951e5e0cf58438d4ad2a0d'
COMPLETE = Path('/opt/oasis/production-instance-private/recovery-bootstrap-tail-20261010/receipt.json')
COMPLETE_SHA = '186ce1c8f9ccdd8c9d002f2cb22b31f74dd9caee39cd1388ce61bc6dcf93de4e'
MEMBERS = {
    'ingress': ('platform/deploy/production-ingress.py', 'b61ea746225b30e25fdb590e0f358c9ad3f47f25e92057bb75cfc880e179f5f5'),
    'units': ('platform/deploy/production-ingress-units.py', 'cbf90d6be41956da9d3236be99c6d35965cb196495ef212cfafbdab093eb4243'),
    'runtime': ('platform/deploy/production-instance/provision.py', '00203af2bf2c727fcbcee2b5288da91af584f5fb4dd252de56e18e7c3be1e5cd'),
    'certificate': ('platform/deploy/production-ingress-cert.py', 'a1fa8cf6e07547870912ed0dcf3bbc095f529fefc090fc3c136a74a5e19c5c0f'),
}
HOST = 'oasis-player.43.98.202.236.sslip.io'
READY = 'https://' + HOST + '/health/ready'
CHALLENGE = 'http://' + HOST + '/.well-known/acme-challenge/'
ROOT_UID = 0
MAXIMUM = 8 * 1024 * 1024
WINDOW = 15.0
INTERVAL = 0.25
MINIMAL_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
TRANSIENT = frozenset(('HTTP_404', 'HTTP_502', 'HTTP_503', 'CONNECTION_REFUSED', 'TLS_HOSTNAME_TRANSITION'))


class Refusal(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise Refusal(code)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def metadata(value):
    return {name: getattr(value, name) for name in ('st_dev', 'st_ino', 'st_uid', 'st_gid',
            'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}


def read_bound(path, expected=None, *, private=False):
    path = Path(path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == ROOT_UID
            and not stat.S_IMODE(before.st_mode) & 0o022 and before.st_size <= MAXIMUM
            and (not private or stat.S_IMODE(before.st_mode) == 0o600), 'WAIT_INPUT_FILE_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        require(metadata(os.fstat(fd)) == metadata(before), 'WAIT_INPUT_REPLACED')
        body = bytearray()
        while len(body) <= MAXIMUM:
            block = os.read(fd, min(65536, MAXIMUM + 1 - len(body)))
            if not block:
                break
            body.extend(block)
        require(len(body) == before.st_size and metadata(os.fstat(fd)) == metadata(before)
                and metadata(path.lstat()) == metadata(before), 'WAIT_INPUT_CHANGED')
    finally:
        os.close(fd)
    raw = bytes(body)
    if expected is not None:
        require(re.fullmatch('[a-f0-9]{64}', expected or '') and sha(raw) == expected, 'WAIT_INPUT_SHA_CHANGED')
    return raw, {**metadata(before), 'sha256': sha(raw)}


def load_verified(path, expected, name):
    body, pin = read_bound(path, expected)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # No SourceFileLoader/pyc read can replace these already verified bytes.
    exec(compile(body, str(path), 'exec'), module.__dict__)
    return module, pin


def environment_guard():
    forbidden = {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE',
                 'SSL_CERT_DIR', 'SSLKEYLOGFILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
                 'DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CONFIG_HOME'}
    require(not any(key.upper() in forbidden or key.upper().startswith(('LD_', 'DYLD_', 'PYTHON', 'NODE_'))
                    for key in os.environ), 'WAIT_AMBIENT_ENVIRONMENT_REFUSED')


def private_directory(path):
    require(path.is_absolute() and all(not parent.is_symlink() for parent in (path, *path.parents)),
            'WAIT_PRIVATE_PARENT_SYMLINK')
    value = path.lstat()
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == value.st_gid == ROOT_UID
            and stat.S_IMODE(value.st_mode) == 0o700, 'WAIT_PRIVATE_DIRECTORY_UNSAFE')
    # New exclusive evidence files change directory mtime, size and link count.
    # Its ownership and identity must remain stable, not those append metadata.
    return {name: getattr(value, name) for name in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode')}


def exclusive(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(body)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def complete_guard():
    body, pin = read_bound(COMPLETE, COMPLETE_SHA, private=True)
    value = json.loads(body)
    require(value.get('kind') == 'isolated-production-bootstrap-tail-recovery'
            and value.get('passed') is True and value.get('phase') == 'complete_closed'
            and value.get('manifest_sha256') == MANIFEST and value.get('admission_enabled') is False
            and value.get('players_created') == 0 and value.get('coins_funded') == '0'
            and value.get('bootstrap', {}).get('passed') is True
            and value.get('restore', {}).get('passed') is True
            and value.get('restore', {}).get('cleanup', {}).get('database_removed') is True
            and value.get('restore', {}).get('cleanup', {}).get('temporary_removed') is True,
            'WAIT_COMPLETE_CLOSED_PROOF_REQUIRED')
    return pin


def immutable_guard():
    body, pin = read_bound(RELEASE / 'RELEASE-MANIFEST.json', MANIFEST)
    manifest = json.loads(body)
    for member, digest in MEMBERS.values():
        require(manifest.get(member) == digest, 'WAIT_IMMUTABLE_MEMBER_BINDING_CHANGED')
        read_bound(RELEASE / member, digest)
    return pin


def modules():
    immutable_guard()
    loaded = {name: load_verified(RELEASE / member, digest, 'oasis_wait_' + name)[0]
              for name, (member, digest) in MEMBERS.items()}
    ingress = loaded['ingress']
    original_binding = ingress.release_binding(RELEASE, MANIFEST)
    def load_helper(binding, name):
        require(binding == original_binding and name in ('units', 'runtime', 'certificate'),
                'WAIT_HELPER_SCOPE_CHANGED')
        member, digest = MEMBERS[name]
        read_bound(RELEASE / member, digest)
        require(Path(loaded[name].__file__) == RELEASE / member, 'WAIT_HELPER_LOCATION_CHANGED')
        return loaded[name]
    ingress.load_bound_helper = load_helper
    return ingress, loaded['runtime'], original_binding


# Fixed, source-bound child code. A subprocess deadline also bounds DNS and body
# stalls, which a socket timeout alone does not. It makes exactly one GET.
PROBE_CODE = r'''
import base64,errno,json,ssl,sys,urllib.error,urllib.request
HOST='oasis-player.43.98.202.236.sslip.io'
def result(ok,code,body=None):
 value={'ok':ok,'code':code}
 if body is not None:value['body']=base64.b64encode(body).decode('ascii')
 return value
class RejectRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise RuntimeError('REDIRECT_REFUSED')
def probe(url,timeout):
 ctx=ssl.create_default_context()
 if not ctx.check_hostname or ctx.verify_mode!=ssl.CERT_REQUIRED:return result(False,'TLS_CONTEXT_UNSAFE')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),RejectRedirect(),urllib.request.HTTPSHandler(context=ctx))
 try:
  with opener.open(url,timeout=timeout) as response:
   if response.url!=url or response.status!=200 or response.headers.get('Location'):return result(False,'RESPONSE_SCOPE_CHANGED')
   body=response.read(65537)
   if len(body)>65536:return result(False,'RESPONSE_TOO_LARGE')
   return result(True,'OK',body)
 except urllib.error.HTTPError as error:
  try:
   if error.geturl()!=url or error.headers.get('Location'):return result(False,'RESPONSE_SCOPE_CHANGED')
   return result(False,'HTTP_'+str(error.code))
  finally:error.close()
 except urllib.error.URLError as error:
  reason=error.reason
  if isinstance(reason,ssl.SSLCertVerificationError):
   if getattr(reason,'verify_code',None)==62 and getattr(reason,'verify_message',None)=="Hostname mismatch, certificate is not valid for '"+HOST+"'.":return result(False,'TLS_HOSTNAME_TRANSITION')
   return result(False,'TLS_VERIFICATION_FAILED')
  if isinstance(reason,ConnectionRefusedError) and reason.errno==errno.ECONNREFUSED:return result(False,'CONNECTION_REFUSED')
  return result(False,'TRANSPORT_ERROR')
 except RuntimeError as error:
  return result(False,'REDIRECT_REFUSED' if str(error)=='REDIRECT_REFUSED' else 'PROBE_INTERNAL_ERROR')
 except Exception:return result(False,'PROBE_INTERNAL_ERROR')
if __name__=='__main__':
 value=json.loads(sys.stdin.buffer.read(4097))
 if set(value)!={'url','timeout'} or not isinstance(value['url'],str) or not isinstance(value['timeout'],(float,int)) or not 0<value['timeout']<=15:raise SystemExit(2)
 print(json.dumps(probe(value['url'],value['timeout']),sort_keys=True))
'''


def own_kind(url, expected):
    if url == READY:
        require(expected is None, 'WAIT_READY_EXPECTATION_CHANGED')
        return 'production-ready'
    if url.startswith(CHALLENGE):
        name = url[len(CHALLENGE):]
        require(re.fullmatch('player-[a-f0-9]{32}', name) and expected == name.encode(),
                'WAIT_CHALLENGE_SCOPE_CHANGED')
        return 'own-acme-challenge'
    return None


def probe_once(url, remaining, *, execute=None):
    require(0 < remaining <= WINDOW, 'WAIT_PROBE_DEADLINE_INVALID')
    execute = execute or subprocess.run
    try:
        value = execute(['/usr/bin/python3', '-I', '-B', '-c', PROBE_CODE],
                        input=json.dumps({'url': url, 'timeout': remaining}).encode(),
                        capture_output=True, timeout=remaining, env=MINIMAL_ENV)
    except subprocess.TimeoutExpired as error:
        raise Refusal('WAIT_PROBE_DEADLINE_EXPIRED') from error
    require(value.returncode == 0 and len(value.stdout) <= 100000 and value.stderr == b'',
            'WAIT_PROBE_PROCESS_FAILED')
    try:
        result = json.loads(value.stdout)
    except (ValueError, UnicodeError) as error:
        raise Refusal('WAIT_PROBE_PROTOCOL_INVALID') from error
    require(isinstance(result, dict) and type(result.get('ok')) is bool
            and re.fullmatch('[A-Z0-9_]+', result.get('code', ''))
            and set(result) == ({'ok', 'code', 'body'} if result['ok'] else {'ok', 'code'}),
            'WAIT_PROBE_PROTOCOL_INVALID')
    if result['ok']:
        require(result['code'] == 'OK' and isinstance(result['body'], str), 'WAIT_PROBE_PROTOCOL_INVALID')
        try:
            body = base64.b64decode(result['body'], validate=True)
        except (ValueError, TypeError) as error:
            raise Refusal('WAIT_PROBE_PROTOCOL_INVALID') from error
        require(len(body) <= 65536, 'WAIT_PROBE_PROTOCOL_INVALID')
        return {'ok': True, 'code': 'OK', 'body': body}
    return result


class OwnRouteWait:
    def __init__(self, original_get, *, guard, probe=probe_once, clock=time.monotonic, sleep=time.sleep):
        self.original_get, self.guard, self.probe, self.clock, self.sleep = original_get, guard, probe, clock, sleep
        self.observations = []

    def __call__(self, url, expected=None):
        kind = own_kind(url, expected)
        if kind is None:
            return self.original_get(url, expected)
        self.guard()
        start = self.clock()
        deadline = start + WINDOW
        row = {'kind': kind, 'url_sha256': sha(url.encode()), 'window_ms': 15000, 'attempts': [], 'passed': False}
        self.observations.append(row)
        try:
            while True:
                self.guard()
                remaining = deadline - self.clock()
                require(remaining > 0 and len(row['attempts']) < 64, 'WAIT_OWN_ROUTE_DEADLINE_EXPIRED')
                result = self.probe(url, min(WINDOW, remaining))
                row['attempts'].append({'code': result['code'], 'at_ms': round((self.clock() - start) * 1000)})
                require(self.clock() <= deadline, 'WAIT_OWN_ROUTE_DEADLINE_EXPIRED')
                if result['ok']:
                    body = result['body']
                    if kind == 'own-acme-challenge':
                        require(body == expected, 'WAIT_CHALLENGE_BODY_CHANGED')
                    else:
                        try:
                            health = json.loads(body)
                        except (ValueError, UnicodeError) as error:
                            raise Refusal('WAIT_READY_BODY_INVALID') from error
                        require(isinstance(health, dict) and health.get('environment') == 'production'
                                and health.get('status') == 'ok', 'WAIT_PRODUCTION_READY_REQUIRED')
                    self.guard()
                    require(self.clock() <= deadline, 'WAIT_OWN_ROUTE_DEADLINE_EXPIRED')
                    row.update(passed=True, body_sha256=sha(body), elapsed_ms=round((self.clock() - start) * 1000))
                    return body
                require(result['code'] in TRANSIENT and (result['code'] != 'TLS_HOSTNAME_TRANSITION'
                        or kind == 'production-ready'), 'WAIT_OWN_ROUTE_' + result['code'])
                remaining = deadline - self.clock()
                require(remaining > 0, 'WAIT_OWN_ROUTE_DEADLINE_EXPIRED')
                self.sleep(min(INTERVAL, remaining))
        except Exception:
            row['elapsed_ms'] = round((self.clock() - start) * 1000)
            raise


def controller_guard(args):
    require(Path(__file__).absolute() == TOOL and re.fullmatch('[a-f0-9]{64}', args.controller_sha256 or '')
            and re.fullmatch('[a-f0-9]{40}', args.source_commit or '')
            and args.manifest_sha256 == MANIFEST and os.geteuid() == ROOT_UID, 'WAIT_CONTROLLER_PROVENANCE_INVALID')
    environment_guard()
    directory = private_directory(TOOL.parent)
    raw, pin = read_bound(TOOL, args.controller_sha256, private=True)
    return {'source_commit': args.source_commit, 'tool_sha256': sha(raw), 'tool_pin': pin, 'directory_pin': directory}


def operator_guard(args, runtime):
    value = controller_guard(args)
    runtime.no_mount(TOOL.parent)
    immutable_guard()
    value['complete_closed_receipt'] = complete_guard()
    return value


def output_guard(path):
    require(path is not None and path.parent == TOOL.parent and path.name not in (TOOL.name,)
            and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{1,127}', path.name)
            and not os.path.lexists(path), 'WAIT_EXCLUSIVE_OUTPUT_REQUIRED')


def validate_capsule(cap, controller, binding, now_ms):
    require(cap.get('schema') == 'production-ingress-wait-check-v1' and cap.get('read_only') is True
            and cap.get('passed') is True and cap.get('controller') == controller
            and cap.get('binding') == binding and type(cap.get('checked_at_ms')) is int
            and 0 <= now_ms - cap['checked_at_ms'] < 15 * 60 * 1000
            and isinstance(cap.get('ingress_check'), dict)
            and cap['ingress_check'].get('schema') == 'production-ingress-check-v1'
            and cap['ingress_check'].get('binding') == binding
            and cap['ingress_check'].get('read_only') is True,
            'WAIT_CHECK_STALE')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('check', 'start', 'acme'))
    parser.add_argument('--controller-sha256', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--check-file', type=Path)
    parser.add_argument('--check-sha256')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    controller_guard(args)
    output_guard(args.output)
    ingress, runtime, binding = modules()
    before = operator_guard(args, runtime)
    # Require the already-issued exact own lineage. This controller cannot issue it.
    signed_scope = ingress.load_bound_helper(binding, 'certificate').scope_check('renew')
    require(signed_scope['certificate']['san'] == [HOST], 'WAIT_SIGNED_OWN_CERTIFICATE_REQUIRED')
    if args.stage == 'check':
        require(args.check_file is None and args.check_sha256 is None, 'WAIT_CHECK_ARGUMENT_CONFLICT')
        original = ingress.check(binding)
        require(operator_guard(args, runtime) == before, 'WAIT_OPERATOR_CHANGED')
        capsule = {'schema': 'production-ingress-wait-check-v1', 'read_only': True, 'passed': True,
                   'checked_at_ms': int(time.time() * 1000), 'controller': before,
                   'binding': binding, 'ingress_check': original}
        exclusive(args.output, canonical(capsule))
        print(json.dumps({'passed': True, 'stage': 'check', 'output_sha256': sha(canonical(capsule))}))
        return 0
    require(args.check_file and args.check_file.parent == TOOL.parent
            and re.fullmatch('[a-f0-9]{64}', args.check_sha256 or ''), 'WAIT_BOUND_CHECK_REQUIRED')
    body, check_pin = read_bound(args.check_file, args.check_sha256, private=True)
    cap = json.loads(body)
    validate_capsule(cap, before, binding, int(time.time() * 1000))
    # Preserve the exact embedded original check. The unchanged original main
    # independently compares it to a new check under its existing shared FD lock.
    operation = TOOL.parent / ('operation-' + args.stage + '-' + os.urandom(8).hex())
    operation.mkdir(mode=0o700)
    operation.chmod(0o700)
    original_check = operation / 'original-ingress-check.json'
    exclusive(original_check, canonical(cap['ingress_check']))
    def still_owned():
        require(operator_guard(args, runtime) == before
                and read_bound(args.check_file, args.check_sha256, private=True)[1] == check_pin,
                'WAIT_OPERATOR_CHANGED')
        current = ingress.load_bound_helper(binding, 'certificate').scope_check('renew')
        require(current == signed_scope, 'WAIT_SIGNED_CERTIFICATE_CHANGED')
    waiter = OwnRouteWait(ingress.public_get, guard=still_owned)
    ingress.public_get = waiter
    report = {'schema': 'production-ingress-wait-operation-v1', 'stage': args.stage,
              'passed': False, 'controller': before, 'binding': binding,
              'check_sha256': args.check_sha256, 'original_check_sha256': sha(canonical(cap['ingress_check'])),
              'operation_directory': str(operation), 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'waits': waiter.observations, 'certificate_issued_by_this_tool': False}
    previous = sys.argv
    try:
        still_owned()
        sys.argv = [str(RELEASE / MEMBERS['ingress'][0]), args.stage, '--release', str(RELEASE),
                    '--manifest-sha256', MANIFEST, '--check-file', str(original_check)]
        with redirect_stdout(io.StringIO()):
            ingress.main()
        still_owned()
        report['passed'] = True
    except Exception as error:
        text = str(error)
        report['error_code'] = text if re.fullmatch('[A-Z0-9_]{1,160}', text) else 'WAIT_ORIGINAL_OPERATION_FAILED'
        report['error_type'] = type(error).__name__
    finally:
        sys.argv = previous
        report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        exclusive(args.output, canonical(report))
    print(json.dumps({'passed': report['passed'], 'stage': args.stage, 'output_sha256': sha(canonical(report)),
                      **({'error_code': report['error_code']} if not report['passed'] else {})}))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Refusal, OSError, ValueError, RuntimeError) as error:
        code = str(error) if re.fullmatch('[A-Z0-9_]{1,160}', str(error)) else 'WAIT_PREFLIGHT_FAILED'
        print(json.dumps({'passed': False, 'error_code': code}))
        raise SystemExit(2)
