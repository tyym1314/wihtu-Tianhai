import base64
import copy
import errno
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import pwd
import grp
from pathlib import Path
import secrets
import shlex
import ssl
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import Mock, patch

HERE = Path(__file__).parent
ORIGINAL_INGRESS = HERE / 'fixtures/production-ingress-20261010-03/production-ingress.py'
spec = importlib.util.spec_from_file_location('production_ingress_wait', HERE / 'production-ingress-wait.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
HEALTH = b'{"status":"ok","environment":"production"}'


class Clock:
    def __init__(self):
        self.at = 0.0

    def now(self):
        return self.at

    def sleep(self, value):
        self.at += value


def success(body=HEALTH):
    return {'ok': True, 'code': 'OK', 'body': body}


def failure(code):
    return {'ok': False, 'code': code}


def certificate_error(code, text):
    value = ssl.SSLCertVerificationError(1, 'actual validation failure')
    value.verify_code = code
    value.verify_message = text
    return value


class ProductionIngressWaitTests(unittest.TestCase):
    def setUp(self):
        self.root = patch.object(w, 'ROOT_UID', os.getuid())
        self.root.start()
        self.addCleanup(self.root.stop)

    def waiter(self, values, *, fallback=None, guard=None):
        clock = Clock()
        probe = Mock(side_effect=values)
        value = w.OwnRouteWait(fallback or Mock(side_effect=RuntimeError('unexpected fallback')),
                              guard=guard or Mock(), probe=probe, clock=clock.now, sleep=clock.sleep)
        return value, clock, probe

    def test_only_exact_signed_ready_and_authored_challenge_have_wait_scope(self):
        self.assertEqual(w.own_kind(w.READY, None), 'production-ready')
        token = 'player-' + 'a' * 32
        self.assertEqual(w.own_kind(w.CHALLENGE + token, token.encode()), 'own-acme-challenge')
        for url in ['https://game.tianyahuyu.com/health', 'http://127.0.0.1:18891/health/ready',
                    w.READY + '?retry=true', w.READY + '/', w.READY.replace('https:', 'http:')]:
            self.assertIsNone(w.own_kind(url, None))
        for token in ['../other', 'player-' + 'a' * 31, 'player-' + 'A' * 32, 'diagnostic-' + 'a' * 32]:
            with self.assertRaisesRegex(w.Refusal, 'WAIT_CHALLENGE_SCOPE_CHANGED'):
                w.own_kind(w.CHALLENGE + token, token.encode())
        with self.assertRaises(w.Refusal):
            w.own_kind(w.CHALLENGE + 'player-' + 'a' * 32, b'foreign-body')
        with self.assertRaises(w.Refusal):
            w.own_kind(w.READY, HEALTH)

    def test_public_and_local_probe_errors_are_never_retried(self):
        original = Mock(side_effect=RuntimeError('original 404'))
        waiter, _, probe = self.waiter([], fallback=original)
        for url in ['https://game.tianyahuyu.com/health', 'http://127.0.0.1:18891/health/ready']:
            with self.assertRaisesRegex(RuntimeError, 'original 404'):
                waiter(url)
        self.assertEqual(original.call_count, 2)
        probe.assert_not_called()
        self.assertEqual(waiter.observations, [])

    def test_reload_transitions_eventually_require_actual_production_ready(self):
        waiter, clock, probe = self.waiter([failure('HTTP_404'), failure('HTTP_502'),
            failure('HTTP_503'), failure('CONNECTION_REFUSED'), failure('TLS_HOSTNAME_TRANSITION'), success()])
        self.assertEqual(waiter(w.READY), HEALTH)
        self.assertEqual(probe.call_count, 6)
        self.assertLess(clock.at, 15)
        row = waiter.observations[0]
        self.assertTrue(row['passed'])
        self.assertEqual(row['body_sha256'], w.sha(HEALTH))
        self.assertEqual(row['attempts'][-1]['code'], 'OK')

    def test_host_mismatch_is_never_accepted_without_later_verified_success(self):
        waiter, clock, probe = self.waiter(lambda *_: failure('TLS_HOSTNAME_TRANSITION'))
        with self.assertRaisesRegex(w.Refusal, 'WAIT_OWN_ROUTE_DEADLINE_EXPIRED'):
            waiter(w.READY)
        self.assertEqual(clock.at, 15)
        self.assertLessEqual(probe.call_count, 64)
        self.assertFalse(waiter.observations[0]['passed'])

    def test_unknown_tls_transport_and_http_fail_fast(self):
        for code in ['TLS_VERIFICATION_FAILED', 'TRANSPORT_ERROR', 'HTTP_401', 'HTTP_403', 'HTTP_500',
                     'HTTP_301', 'REDIRECT_REFUSED', 'RESPONSE_SCOPE_CHANGED', 'RESPONSE_TOO_LARGE']:
            with self.subTest(code=code):
                waiter, _, probe = self.waiter([failure(code), success()])
                with self.assertRaises(w.Refusal):
                    waiter(w.READY)
                self.assertEqual(probe.call_count, 1)

    def test_unexpected_ready_response_and_environment_never_wait_for_better_body(self):
        for body in [b'not json', b'[]', b'{}', b'{"status":"ok","environment":"sandbox"}',
                     b'{"status":"failed","environment":"production"}']:
            waiter, _, probe = self.waiter([success(body), success()])
            with self.assertRaises(w.Refusal):
                waiter(w.READY)
            self.assertEqual(probe.call_count, 1)

    def test_exact_challenge_body_is_required_after_transient_route(self):
        token = ('player-' + 'c' * 32).encode()
        waiter, _, probe = self.waiter([failure('HTTP_404'), success(token)])
        self.assertEqual(waiter(w.CHALLENGE + token.decode(), token), token)
        self.assertEqual(probe.call_count, 2)
        for result in [success(b'another body'), failure('TLS_HOSTNAME_TRANSITION')]:
            value, _, called = self.waiter([result])
            with self.assertRaises(w.Refusal):
                value(w.CHALLENGE + token.decode(), token)
            self.assertEqual(called.call_count, 1)

    def test_operator_drift_refuses_before_any_next_attempt(self):
        guard = Mock(side_effect=[None, None, RuntimeError('owned pin changed')])
        waiter, _, probe = self.waiter([failure('HTTP_404'), success()], guard=guard)
        with self.assertRaisesRegex(RuntimeError, 'owned pin changed'):
            waiter(w.READY)
        self.assertEqual(probe.call_count, 1)

    def test_attempt_is_bounded_by_remaining_window_and_late_success_fails(self):
        clock = Clock()
        def slow(url, timeout):
            self.assertLessEqual(timeout, 15)
            clock.at += 15.1
            return success()
        waiter = w.OwnRouteWait(Mock(), guard=lambda: None, probe=slow, clock=clock.now, sleep=clock.sleep)
        with self.assertRaisesRegex(w.Refusal, 'WAIT_OWN_ROUTE_DEADLINE_EXPIRED'):
            waiter(w.READY)
        self.assertFalse(waiter.observations[0]['passed'])

    def child_probe(self, *, body=HEALTH, error=None, headers=None, url=None):
        namespace = {'__name__': 'fixture_only'}
        exec(compile(w.PROBE_CODE, '<fixed-probe>', 'exec'), namespace)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.url, response.status, response.headers = url or w.READY, 200, headers or {}
        response.read.return_value = body
        opener = Mock()
        if error is not None:
            opener.open.side_effect = error
        else:
            opener.open.return_value = response
        with patch('urllib.request.build_opener', return_value=opener) as build:
            result = namespace['probe'](w.READY, 1)
            handlers = build.call_args.args
            https = next(handler for handler in handlers if isinstance(handler, urllib.request.HTTPSHandler))
            self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(https._context.check_hostname)
            self.assertEqual(next(handler for handler in handlers if isinstance(handler, urllib.request.ProxyHandler)).proxies, {})
        return result, namespace

    def test_child_uses_real_strict_tls_context_and_returns_only_bounded_body(self):
        result, _ = self.child_probe()
        self.assertTrue(result['ok'])
        self.assertEqual(base64.b64decode(result['body']), HEALTH)
        result, _ = self.child_probe(body=b'x' * 65537)
        self.assertEqual(result, failure('RESPONSE_TOO_LARGE'))

    def test_child_matches_only_typed_code62_and_exact_own_hostname(self):
        text = "Hostname mismatch, certificate is not valid for '" + w.HOST + "'."
        result, _ = self.child_probe(error=urllib.error.URLError(certificate_error(62, text)))
        self.assertEqual(result, failure('TLS_HOSTNAME_TRANSITION'))
        for code, message in [(10, text), (20, text), (62, text.replace(w.HOST, 'foreign.invalid')),
                              (62, 'Hostname mismatch')]:
            result, _ = self.child_probe(error=urllib.error.URLError(certificate_error(code, message)))
            self.assertEqual(result, failure('TLS_VERIFICATION_FAILED'))
        result, _ = self.child_probe(error=urllib.error.URLError(text))
        self.assertEqual(result, failure('TRANSPORT_ERROR'))

    def test_child_only_errno_connection_refused_is_transient(self):
        result, _ = self.child_probe(error=urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, 'refused')))
        self.assertEqual(result, failure('CONNECTION_REFUSED'))
        for error in [ConnectionResetError(errno.ECONNRESET, 'reset'), TimeoutError('timeout'), OSError('refused')]:
            result, _ = self.child_probe(error=urllib.error.URLError(error))
            self.assertEqual(result, failure('TRANSPORT_ERROR'))

    def test_child_refuses_redirects_changed_url_and_location_header(self):
        result, namespace = self.child_probe(url='https://foreign.invalid/')
        self.assertEqual(result, failure('RESPONSE_SCOPE_CHANGED'))
        result, _ = self.child_probe(headers={'Location': 'https://foreign.invalid/'})
        self.assertEqual(result, failure('RESPONSE_SCOPE_CHANGED'))
        with self.assertRaisesRegex(RuntimeError, 'REDIRECT_REFUSED'):
            namespace['RejectRedirect']().redirect_request()

    def test_child_classifies_http_status_without_body_or_secret_message(self):
        for status in [404, 502, 503, 401, 500]:
            error = urllib.error.HTTPError(w.READY, status, 'do not expose this text', {}, None)
            result, _ = self.child_probe(error=error)
            self.assertEqual(result, failure('HTTP_' + str(status)))
            self.assertNotIn('do not expose', json.dumps(result))

    def test_probe_runner_uses_absolute_isolated_python_and_clean_environment(self):
        execute = Mock(return_value=SimpleNamespace(returncode=0, stderr=b'', stdout=json.dumps(
            {'ok': True, 'code': 'OK', 'body': base64.b64encode(HEALTH).decode()}).encode()))
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://foreign.invalid', 'SSL_CERT_FILE': '/bad',
                                     'PYTHONPATH': '/foreign'}, clear=True):
            self.assertEqual(w.probe_once(w.READY, 3, execute=execute), success())
        self.assertEqual(execute.call_args.args[0][:4], ['/usr/bin/python3', '-I', '-B', '-c'])
        self.assertEqual(execute.call_args.kwargs['env'], w.MINIMAL_ENV)
        self.assertEqual(execute.call_args.kwargs['timeout'], 3)
        self.assertEqual(json.loads(execute.call_args.kwargs['input']), {'url': w.READY, 'timeout': 3})

    def test_real_stuck_child_is_killed_reaped_without_network(self):
        code = 'import os,time; print(os.getpid(),flush=True); time.sleep(5)'
        start = time.monotonic()
        with patch.object(w, 'PROBE_CODE', code), self.assertRaisesRegex(w.Refusal, 'WAIT_PROBE_DEADLINE_EXPIRED') as caught:
            w.probe_once(w.READY, .2)
        self.assertLess(time.monotonic() - start, 1)
        pid = int(caught.exception.__cause__.stdout)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_probe_protocol_cannot_fabricate_ok_or_unbounded_body(self):
        rows = [b'not json', b'{"ok":1,"code":"OK","body":""}', b'{"ok":true,"code":"NO","body":""}',
                b'{"ok":true,"code":"OK","body":"invalid!"}', b'{"ok":false,"code":"HTTP_404","headers":{}}',
                json.dumps({'ok': True, 'code': 'OK', 'body': base64.b64encode(b'x' * 65537).decode()}).encode()]
        for raw in rows:
            with self.subTest(raw_length=len(raw)), self.assertRaises(w.Refusal):
                w.probe_once(w.READY, 1, execute=Mock(return_value=SimpleNamespace(returncode=0, stdout=raw, stderr=b'')))

    def test_verified_import_never_calls_source_loader_or_cached_pyc(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'helper.py'
            path.write_bytes(b"VALUE = 'verified source'\n")
            with patch.object(importlib.machinery.SourceFileLoader, 'get_data', side_effect=AssertionError('second path read')), \
                 patch.object(importlib.machinery.SourceFileLoader, 'exec_module', side_effect=AssertionError('pyc import')):
                module, pin = w.load_verified(path, w.sha(path.read_bytes()), 'verified_fixture')
            self.assertEqual(module.VALUE, 'verified source')
            self.assertEqual(pin['sha256'], w.sha(path.read_bytes()))

    def test_all_four_actual03_modules_can_be_imported_with_no_pyc_loader(self):
        with patch.object(importlib.machinery.SourceFileLoader, 'get_data', side_effect=AssertionError('second read')), \
             patch.object(importlib.machinery.SourceFileLoader, 'exec_module', side_effect=AssertionError('pyc read')):
            for name, (member, digest) in w.MEMBERS.items():
                path = (HERE / 'production-instance/fixtures/bootstrap-tail-20261010-03/provision.py'
                        if name == 'runtime' else ORIGINAL_INGRESS
                        if name == 'ingress' else HERE.parent.parent / member)
                module, _ = w.load_verified(path, digest, 'actual_03_' + name)
                self.assertEqual(Path(module.__file__), path)

    def test_fixture_metadata_cannot_authorize_a_changed_historical_ingress_body(self):
        _, expected = w.MEMBERS['ingress']
        self.assertEqual(w.sha(ORIGINAL_INGRESS.read_bytes()), expected)
        provenance = json.loads(ORIGINAL_INGRESS.with_name('PROVENANCE.json').read_text())
        self.assertEqual(provenance['member']['sha256'], expected)
        self.assertEqual(provenance['release_manifest_sha256'], w.MANIFEST)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'production-ingress.py'
            changed = ORIGINAL_INGRESS.read_bytes() + b'\n# unapproved historical source\n'
            path.write_bytes(changed)
            # Even a rewritten provenance document cannot replace the fixed
            # original-member digest supplied by the actual wait controller.
            provenance['member']['sha256'] = w.sha(changed)
            path.with_name('PROVENANCE.json').write_text(json.dumps(provenance))
            with patch('builtins.compile', side_effect=AssertionError('unapproved source compiled')), \
                 self.assertRaisesRegex(w.Refusal, 'WAIT_INPUT_SHA_CHANGED'):
                w.load_verified(path, expected, 'changed_historical_ingress')

    def test_private_parent_identity_survives_own_evidence_appends_but_not_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory).resolve() / 'owned'; parent.mkdir(mode=0o700)
            original_lstat = Path.lstat
            def adapted_lstat(path):
                value = original_lstat(path)
                if path == parent:
                    # Only adapt Mac fixture owner GID; Linux production still
                    # requires real root/root and all other fields are real FS.
                    return SimpleNamespace(**{**w.metadata(value), 'st_gid': os.getuid()})
                return value
            with patch.object(Path, 'lstat', adapted_lstat):
                before = w.private_directory(parent)
                w.exclusive(parent / 'check.json', b'owned evidence')
                (parent / 'operation').mkdir(mode=0o700)
                self.assertEqual(w.private_directory(parent), before)
                parent.rename(parent.with_name('old'))
                parent.mkdir(mode=0o700)
                self.assertNotEqual(w.private_directory(parent), before)

    def test_complete_closed_guard_requires_all_bootstrap_and_restore_proofs(self):
        valid = {'kind': 'isolated-production-bootstrap-tail-recovery', 'passed': True,
                 'phase': 'complete_closed', 'manifest_sha256': w.MANIFEST,
                 'admission_enabled': False, 'players_created': 0, 'coins_funded': '0',
                 'bootstrap': {'passed': True}, 'restore': {'passed': True,
                 'cleanup': {'database_removed': True, 'temporary_removed': True}}}
        pin = {'sha256': w.COMPLETE_SHA}
        with patch.object(w, 'read_bound', return_value=(w.canonical(valid), pin)) as read:
            self.assertEqual(w.complete_guard(), pin)
            read.assert_called_once_with(w.COMPLETE, w.COMPLETE_SHA, private=True)
        for change in [lambda x: x.update(phase='failed_closed'), lambda x: x.update(admission_enabled=True),
                       lambda x: x.update(players_created=1), lambda x: x.update(coins_funded='1'),
                       lambda x: x.update(manifest_sha256='0' * 64), lambda x: x['bootstrap'].update(passed=False),
                       lambda x: x['restore']['cleanup'].update(database_removed=False),
                       lambda x: x['restore']['cleanup'].update(temporary_removed=False)]:
            bad = copy.deepcopy(valid); change(bad)
            with patch.object(w, 'read_bound', return_value=(w.canonical(bad), pin)), self.assertRaises(w.Refusal):
                w.complete_guard()

    def test_import_refuses_hash_drift_symlink_hardlink_and_changed_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.py'
            path.write_bytes(b'VALUE=1\n')
            digest = w.sha(path.read_bytes())
            with self.assertRaises(w.Refusal):
                w.load_verified(path, 'a' * 64, 'bad')
            symlink = path.with_name('link.py'); symlink.symlink_to(path)
            with self.assertRaises(w.Refusal):
                w.read_bound(symlink, digest)
            link = path.with_name('hard.py'); os.link(path, link)
            with self.assertRaises(w.Refusal):
                w.read_bound(path, digest)
            link.unlink()
            original_read = os.read
            changed = False
            def replace(fd, count):
                nonlocal changed
                value = original_read(fd, count)
                if not changed:
                    changed = True
                    replacement = path.with_name('replacement.py'); replacement.write_bytes(path.read_bytes())
                    replacement.replace(path)
                return value
            with patch.object(w.os, 'read', side_effect=replace), self.assertRaises(w.Refusal):
                w.read_bound(path, digest)

    def test_exclusive_evidence_is_0600_and_does_not_overwrite_old_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            previous = os.umask(0o000)
            try:
                w.exclusive(path, b'original')
            finally:
                os.umask(previous)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                w.exclusive(path, b'changed')
            self.assertEqual(path.read_bytes(), b'original')

    def test_ambient_loaders_proxy_ca_and_key_logging_are_refused(self):
        with patch.dict(os.environ, w.MINIMAL_ENV, clear=True):
            w.environment_guard()
        for name in ['HTTPS_PROXY', 'http_proxy', 'SSL_CERT_FILE', 'SSLKEYLOGFILE', 'PYTHONPATH',
                     'NODE_OPTIONS', 'LD_PRELOAD', 'DBUS_SYSTEM_BUS_ADDRESS', 'XDG_CONFIG_HOME']:
            with patch.dict(os.environ, {name: 'foreign'}, clear=True), self.assertRaises(w.Refusal):
                w.environment_guard()

    def test_capsule_must_bind_controller_receipt_manifest_and_fresh_time(self):
        controller = {'tool': 'actual', 'complete': w.COMPLETE_SHA}
        binding = {'manifest': w.MANIFEST}
        cap = {'schema': 'production-ingress-wait-check-v1', 'read_only': True, 'passed': True,
               'controller': controller, 'binding': binding, 'checked_at_ms': 1000,
               'ingress_check': {'schema': 'production-ingress-check-v1', 'binding': binding, 'read_only': True}}
        w.validate_capsule(cap, controller, binding, 1001)
        for change in [lambda x: x.update(checked_at_ms=1002), lambda x: x.update(checked_at_ms=-900000),
                       lambda x: x.update(checked_at_ms=True), lambda x: x.update(controller={}),
                       lambda x: x.update(binding={}), lambda x: x['ingress_check'].update(binding={}),
                       lambda x: x['ingress_check'].update(read_only=False)]:
            bad = copy.deepcopy(cap); change(bad)
            with self.assertRaises(w.Refusal):
                w.validate_capsule(bad, controller, binding, 1001)

    def actual_ingress(self):
        _, digest = w.MEMBERS['ingress']
        return w.load_verified(ORIGINAL_INGRESS, digest, 'actual_original_ingress')[0]

    def test_actual_original_start_rollback_still_removes_only_authored_tls(self):
        ingress = self.actual_ingress()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); release = root / 'release'; release.mkdir()
            (root / 'production-current').symlink_to(release)
            cert = root / 'cert'; cert.mkdir()
            tls = root / 'own.conf'
            waiter, _, _ = self.waiter([failure('TLS_VERIFICATION_FAILED')], fallback=Mock(return_value=HEALTH))
            calls = []
            with patch.object(ingress, 'BASE', root), patch.object(ingress, 'CERT', cert), \
                 patch.object(ingress, 'TLS', tls), patch.object(ingress, 'public_get', waiter), \
                 patch.object(ingress, 'read_regular', side_effect=lambda p: p.read_bytes()), \
                 patch.object(ingress, 'certificate_unit_guard'), \
                 patch.object(ingress, 'run', side_effect=lambda a: calls.append(a)):
                with self.assertRaisesRegex(w.Refusal, 'TLS_VERIFICATION_FAILED'):
                    ingress.start({'release': str(release.resolve()), 'manifest_sha256': w.MANIFEST})
            self.assertFalse(tls.exists())
            self.assertEqual(calls, [['nginx', '-t'], ['systemctl', 'reload', 'nginx'],
                                     ['nginx', '-t'], ['systemctl', 'reload', 'nginx']])

    def test_actual_original_rollback_preserves_replaced_same_bytes_tls(self):
        ingress = self.actual_ingress()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); release = root / 'release'; release.mkdir()
            (root / 'production-current').symlink_to(release)
            cert = root / 'cert'; cert.mkdir()
            tls = root / 'own.conf'
            def changed(url, remaining):
                path = root / 'replacement'; path.write_bytes(tls.read_bytes()); path.replace(tls)
                return failure('TLS_VERIFICATION_FAILED')
            waiter = w.OwnRouteWait(Mock(return_value=HEALTH), guard=lambda: None, probe=changed)
            with patch.object(ingress, 'BASE', root), patch.object(ingress, 'CERT', cert), \
                 patch.object(ingress, 'TLS', tls), patch.object(ingress, 'public_get', waiter), \
                 patch.object(ingress, 'read_regular', side_effect=lambda p: p.read_bytes()), \
                 patch.object(ingress, 'certificate_unit_guard'), patch.object(ingress, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_CONFIG_REPLACED'):
                    ingress.start({'release': str(release.resolve()), 'manifest_sha256': w.MANIFEST})
            self.assertTrue(tls.exists())


if __name__ == '__main__':
    unittest.main()
