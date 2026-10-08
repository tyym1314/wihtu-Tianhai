"""Pure/local filesystem helper tests; no Nginx/container/mount/network execution."""
import ast
import copy
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'dedicated_ingress_fixture.py'
fixture = types.ModuleType('dedicated_ingress_fixture_test')
fixture.__file__ = str(SOURCE)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), fixture.__dict__)
renderer = types.ModuleType('dedicated_ingress_renderer_test')
renderer.__file__ = str(HERE / 'dedicated_ingress.py')
exec(compile((HERE / 'dedicated_ingress.py').read_bytes(), renderer.__file__, 'exec'), renderer.__dict__)
VERSION = 'nginx version: nginx/1.22.1\nconfigure arguments: ' + ' '.join([
    '--http-client-body-temp-path=/var/lib/nginx/body', '--http-proxy-temp-path=/var/lib/nginx/proxy',
    '--http-fastcgi-temp-path=/var/lib/nginx/fastcgi', '--http-uwsgi-temp-path=/var/lib/nginx/uwsgi',
    '--http-scgi-temp-path=/var/lib/nginx/scgi', '--pid-path=/run/nginx.pid',
    '--lock-path=/var/lock/nginx.lock', '--error-log-path=stderr', '--http-log-path=/var/log/nginx/access.log'])
STATUS = 'Uid:\t2345\t2345\t2345\t2345\nGid:\t2345\t2345\t2345\t2345\nGroups:\t\n' + ''.join(k + ':\t0000000000000000\n' for k in fixture.CAP_FIELDS) + 'CapBnd:\t00000000000000eb\nNoNewPrivs:\t1\nSeccomp:\t2\n'


def mount(path):
    return f'32 20 0:10 / {path} rw - tmpfs tmpfs rw\n'


class ContractTests(unittest.TestCase):
    def test_renderer_private_paths_and_bootstrap_stderr_are_exact(self):
        paths = fixture.validate_rendered(renderer.build_config(renderer.original_profile()))
        self.assertEqual(len(paths), 9)
        self.assertEqual(paths['client_body_temp_path'], '/run/oasis-android-mock-ingress/body')
        args = fixture.nginx_argv(Path('/etc/oasis-android-mock-ingress/nginx.conf'), True)
        self.assertEqual(args, ['/usr/sbin/nginx', '-e', 'stderr', '-p', '/etc/oasis-android-mock-ingress/', '-c', '/etc/oasis-android-mock-ingress/nginx.conf', '-t'])
        self.assertNotIn('-g', args)

    def test_renderer_cannot_fall_back_to_compiled_path_or_shared_include(self):
        raw = renderer.build_config(renderer.original_profile())
        changes = [raw.replace(b'/run/oasis-android-mock-ingress/body', b'/var/lib/nginx/body'),
                   raw + b'include /etc/nginx/conf.d/*.conf;\n', raw + b'user www-data;\n',
                   raw.replace(b'access_log off;', b'access_log /var/log/nginx/access.log;'),
                   raw.replace(b'error_log stderr notice;', b'error_log /var/log/nginx/error.log;'),
                   raw.replace(b'listen 127.0.0.1:18986 ssl http2;', b'listen 443 ssl http2;'),
                   raw + b'pid /run/other.pid;\n']
        for changed in changes:
            with self.subTest(changed=changed[-90:]):
                with self.assertRaises(RuntimeError):
                    fixture.validate_rendered(changed)

    def test_compiled_path_inventory_includes_all_nine_destinations(self):
        parsed = fixture.compile_paths(VERSION)
        self.assertEqual(len(parsed), 9)
        self.assertEqual(parsed['--lock-path'], '/var/lock/nginx.lock')
        self.assertEqual(parsed['--error-log-path'], 'stderr')

    def test_compiled_unknown_missing_duplicate_relative_or_traversal_refuse(self):
        cases = [VERSION.replace('--http-scgi-temp-path=/var/lib/nginx/scgi', ''),
                 VERSION + ' --pid-path=/run/other.pid', VERSION.replace('/run/nginx.pid', 'run/nginx.pid'),
                 VERSION.replace('/run/nginx.pid', '/run/../etc/nginx.pid'),
                 VERSION.replace('/run/nginx.pid', '/run//nginx.pid'),
                 VERSION.replace('/run/nginx.pid', '/opt/nginx.pid'), VERSION.replace('configure arguments:', 'unknown:')]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    fixture.compile_paths(value)

    def test_mount_guard_accepts_only_root_system_and_docker_managed_files(self):
        text = ''.join(mount(v) for v in ('/', '/proc', '/proc/sys', '/dev', '/dev/pts', '/sys', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'))
        self.assertEqual(len(fixture.assert_container_mounts(text)), 9)

    def test_mount_guard_rejects_capsule_evidence_runtime_and_other_host_binds(self):
        for path in ('/capsule', '/evidence', '/run/oasis-android-mock-ingress', '/unrelated', '/var/lib/nginx', '/var/run/docker.sock'):
            with self.subTest(path=path):
                with self.assertRaisesRegex(RuntimeError, 'EXTRA_CONTAINER_MOUNT_FORBIDDEN'):
                    fixture.assert_container_mounts(mount('/') + mount(path))
        with self.assertRaises(RuntimeError):
            fixture.assert_container_mounts('malformed')

    def test_process_identity_requires_all_four_uid_gid_fields_and_zero_caps(self):
        parsed = fixture.security_fields(STATUS)
        self.assertEqual(fixture.assert_rootless(parsed)['Uid'], [2345] * 4)
        for key, value in [('Uid', [0, 2345, 2345, 2345]), ('Gid', [2345, 0, 2345, 2345]),
                           ('Groups', [2345]), ('NoNewPrivs', 0), *[(k, '0000000000000001') for k in fixture.CAP_FIELDS]]:
            changed = copy.deepcopy(parsed)
            changed[key] = value
            with self.subTest(key=key):
                with self.assertRaises(RuntimeError):
                    fixture.assert_rootless(changed)

    def test_security_field_missing_duplicate_and_malformed_fail_closed(self):
        for raw in (STATUS.replace('CapAmb:\t0000000000000000\n', ''), STATUS + 'Uid:\t2345\n',
                    STATUS.replace('CapEff:\t0000000000000000', 'CapEff:\t0'), STATUS.replace('Groups:\t', 'Groups:\tprivate')):
            with self.assertRaises(RuntimeError):
                fixture.security_fields(raw)

    def test_setup_allows_only_six_caps_and_default_security(self):
        fields = fixture.security_fields(STATUS)
        fields['Uid'] = fields['Gid'] = [0] * 4
        fields['CapEff'] = fields['CapPrm'] = fields['CapBnd']
        self.assertEqual(fixture.assert_setup_security(fields)['CapEff'], '00000000000000eb')
        for name, value in [('CapEff', '00000000002000eb'), ('CapBnd', '00000000a80425fb'), ('CapAmb', '0000000000000001'), ('NoNewPrivs', 0), ('Seccomp', 0)]:
            bad = copy.deepcopy(fields)
            bad[name] = value
            with self.assertRaises(RuntimeError):
                fixture.assert_setup_security(bad)

    def test_redirect_must_remain_public_and_never_follow(self):
        base = {'status': 308, 'location': 'https://' + renderer.HOST + '/demo/', 'body_bytes': b'redirect'}
        for host in (renderer.HOST, renderer.HOST + ':443'):
            with patch.object(fixture, 'tls_exchange', return_value=copy.deepcopy(base)) as fetch:
                result = fixture.tls_redirect(Path('/fixture-ca'), renderer.HOST, host)
                self.assertEqual(result['location'], base['location'])
                fetch.assert_called_once_with(Path('/fixture-ca'), renderer.HOST, '/demo', host_header=host)
        for location in ('https://' + renderer.HOST + ':18986/demo/', 'https://' + renderer.HOST + ':443/demo/', '/demo/'):
            with patch.object(fixture, 'tls_exchange', return_value={**base, 'location': location}):
                with self.assertRaisesRegex(RuntimeError, 'PRIVATE_INGRESS_PORT_LEAKED_IN_REDIRECT'):
                    fixture.tls_redirect(Path('/fixture-ca'), renderer.HOST, renderer.HOST)

    def test_drop_order_never_launches_command_or_changes_parent_in_unit_test(self):
        calls = []
        libc = types.SimpleNamespace(prctl=lambda *args: calls.append(('prctl', args)) or 0)
        with patch.object(fixture.os, 'setgroups', side_effect=lambda x: calls.append(('groups', x))), \
             patch.object(fixture.os, 'setgid', side_effect=lambda x: calls.append(('gid', x))), \
             patch.object(fixture.os, 'setuid', side_effect=lambda x: calls.append(('uid', x))), \
             patch.object(fixture.ctypes, 'CDLL', return_value=libc), \
             patch.object(Path, 'read_text', return_value=STATUS), \
             patch.object(fixture.subprocess, 'run', side_effect=AssertionError('NO_SUBPROCESS')):
            fixture.drop_privileges()
        self.assertEqual(calls, [('groups', []), ('gid', 2345), ('uid', 2345), ('prctl', (38, 1, 0, 0, 0))])

    def test_platform_refusal_is_before_any_write_or_command(self):
        with patch.object(fixture.platform, 'system', return_value='Darwin'), \
             patch.object(Path, 'mkdir', side_effect=AssertionError('NO_WRITE')), \
             patch.object(fixture.subprocess, 'run', side_effect=AssertionError('NO_COMMAND')):
            with self.assertRaisesRegex(RuntimeError, 'LINUX_REQUIRED_NOT_A_TEST_PASS'):
                fixture.main()
        main = next(n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        self.assertEqual(ast.unparse(main.body[0]), 'mount_inventory = guard()')

    def test_fixture_has_no_mount_service_or_global_nginx_signal_commands(self):
        tree = ast.parse(SOURCE.read_text())
        literals = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        for command in ('mount', 'umount', 'systemctl', 'killall', 'pkill', '--privileged', 'SYS_ADMIN', '-s'):
            self.assertNotIn(command, literals)
        text = SOURCE.read_text()
        self.assertIn('master.send_signal(signal.SIGHUP)', text)
        self.assertIn("case('rootless_startup_failure', bad_startup)", text)
        self.assertIn("case('rootless_invalid_hup_preserves_old_service', reload_invalid)", text)
        dockerfile = (HERE / 'dedicated_ingress_fixture.Dockerfile').read_text()
        self.assertNotIn('VOLUME ', dockerfile)
        self.assertIn('exit 101', dockerfile)
        self.assertNotIn('profile_activation.py', dockerfile)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='oasis-rootless-fixture-unit-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tree = self.root / 'shared'
        self.tree.mkdir()
        (self.tree / 'original').write_bytes(b'original\x00\xff')
        self.roots = [self.tree, self.root / 'missing.pid']

    def test_complete_tree_and_missing_paths_are_invariant(self):
        before = fixture.snapshot(self.roots)
        self.assertTrue(fixture.require_unchanged(before, self.roots)['unchanged'])
        self.assertEqual(before[str(self.root / 'missing.pid')], {'missing': True})
        self.assertEqual(before[str(self.tree / 'original')]['sha256'], fixture.sha(b'original\x00\xff'))
        self.assertIn('ctime_ns', before[str(self.tree)])
        self.assertNotIn('atime_ns', before[str(self.tree)])

    def test_new_file_removed_file_content_and_mode_changes_cannot_be_ignored(self):
        for operation in (lambda: (self.tree / 'new').write_text('new'),
                          lambda: (self.tree / 'original').write_bytes(b'different'),
                          lambda: (self.tree / 'original').chmod(0o500),
                          lambda: (self.tree / 'original').unlink()):
            with self.subTest(operation=operation):
                before = fixture.snapshot(self.roots)
                operation()
                with self.assertRaisesRegex(RuntimeError, 'SHARED_PATHS_CHANGED'):
                    fixture.require_unchanged(before, self.roots)
                if (self.tree / 'original').exists():
                    (self.tree / 'original').chmod(0o644)
                (self.tree / 'original').write_bytes(b'original\x00\xff')

    def test_snapshot_does_not_follow_symlink_into_unrelated_target(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'do-not-follow').write_text('sentinel')
        (self.tree / 'alias').symlink_to(outside)
        data = fixture.snapshot(self.roots)
        self.assertEqual(data[str(self.tree / 'alias')]['target'], str(outside))
        self.assertNotIn(str(self.tree / 'alias' / 'do-not-follow'), data)
        self.assertEqual(data[str(self.tree / 'alias')]['kind'], stat.S_IFLNK)

    def test_size_and_count_bounds_fail_instead_of_silent_truncation(self):
        with patch.object(fixture, 'MAX_TREE_FILES', 1):
            with self.assertRaises(RuntimeError):
                fixture.snapshot(self.roots)
        with patch.object(fixture, 'MAX_TREE_BYTES', 1):
            with self.assertRaises(RuntimeError):
                fixture.snapshot(self.roots)


if __name__ == '__main__':
    unittest.main()
