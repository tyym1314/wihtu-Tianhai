"""Real relocated filesystem checks only: no nginx, mount, container or service."""
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
a = types.ModuleType('namespace_write_paths_adapter')
a.__file__ = str(HERE / 'profile_activation.py')
exec(compile(Path(a.__file__).read_bytes(), a.__file__, 'exec'), a.__dict__)


class NamespaceWritePathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mock-namespace-paths-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        for relative in ('var', 'run', 'run/lock'):
            (self.root / relative).mkdir(mode=0o755)
        self.alias = self.root / 'var/lock'
        self.alias.symlink_to('../run/lock')
        self.owner = os.geteuid()
        self.flags = {
            'prefix': '/usr/share/nginx', 'error-log-path': 'stderr',
            'http-log-path': '/var/log/nginx/access.log', 'pid-path': '/var/log/nginx/nginx.pid',
            'lock-path': '/var/lock/nginx.lock',
            **{'http-' + key + '-temp-path': '/var/lib/nginx/' + leaf for key, leaf in
               [('client-body', 'body'), ('proxy', 'proxy'), ('fastcgi', 'fastcgi'),
                ('uwsgi', 'uwsgi'), ('scgi', 'scgi')]},
        }
        self.addCleanup(patch.stopall)
        patch.object(a.subprocess, 'run', side_effect=AssertionError('commands forbidden')).start()

    def directories(self, *, flags=None, enclosure=None):
        compiled = 'nginx version: fixture\nconfigure arguments: ' + ' '.join(
            '--' + k + '=' + v for k, v in (flags or self.flags).items())
        return set(map(str, a.namespace_write_directories(
            enclosure or {'write_directories': []}, compiled,
            filesystem_root=self.root, owner=self.owner)))

    def assert_alias_rejected(self):
        with self.assertRaisesRegex(RuntimeError, '^NGINX_COMPILED_LOCK_ALIAS_REQUIRES_REVIEW$'):
            self.directories()

    def test_exact_stderr_sentinel_needs_no_log_directory(self):
        paths = self.directories()
        self.assertNotIn('/usr/share/nginx', paths)
        self.assertEqual(paths, {'/run/lock', '/var/log/nginx', '/var/lib/nginx/body',
                                '/var/lib/nginx/proxy', '/var/lib/nginx/fastcgi',
                                '/var/lib/nginx/uwsgi', '/var/lib/nginx/scgi'})

    def test_stderr_is_not_a_general_relative_path_or_other_flag_sentinel(self):
        for flag, value in [('error-log-path', 'STDERR'), ('error-log-path', './stderr'),
                            ('error-log-path', 'stderr/'), ('http-log-path', 'stderr'),
                            ('lock-path', 'stderr'), ('http-proxy-temp-path', 'stderr')]:
            with self.subTest(flag=flag, value=value), self.assertRaisesRegex(
                    RuntimeError, 'NGINX_COMPILED_WRITE_PATH_REQUIRES_REVIEW'):
                self.directories(flags={**self.flags, flag: value})

    def test_only_two_exact_single_hop_aliases_and_standard_sticky_target(self):
        for target in ('../run/lock', '/run/lock'):
            self.alias.unlink()
            self.alias.symlink_to(target)
            for mode in (0o700, 0o755, 0o1777):
                with self.subTest(target=target, mode=oct(mode)):
                    (self.root / 'run/lock').chmod(mode)
                    self.assertIn('/run/lock', self.directories())

    def test_minimal_ancestor_shadow_still_covers_alias_target(self):
        paths = self.directories(flags={**self.flags, 'pid-path': '/run/nginx.pid'})
        self.assertIn('/run', paths)
        self.assertNotIn('/run/lock', paths)

    def test_unknown_or_noncanonical_compiled_alias_spelling_stays_rejected(self):
        for value in ('/var/lock/other.lock', '/var//lock/nginx.lock', '/var/lock/./nginx.lock',
                      '/var/lock/../lock/nginx.lock', '/var/lock/nginx.lock/../escape',
                      '/var/lock/nginx.lock/', '/opt/escape/nginx.lock'):
            with self.subTest(value=value), self.assertRaisesRegex(
                    RuntimeError, 'NGINX_COMPILED_WRITE_PATH_REQUIRES_REVIEW'):
                self.directories(flags={**self.flags, 'lock-path': value})
        with self.assertRaisesRegex(RuntimeError, 'NGINX_COMPILED_WRITE_PATH_REQUIRES_REVIEW'):
            self.directories(flags={**self.flags, 'error-log-path': '/var/lock/nginx.lock'})

    def test_unknown_chained_and_escaping_alias_targets_rejected(self):
        for target in ('../run/other', '../run/lock/../lock', '../../run/lock',
                       '/run//lock', '/run/./lock', '/tmp/lock', 'another-alias'):
            self.alias.unlink()
            self.alias.symlink_to(target)
            with self.subTest(target=target):
                self.assert_alias_rejected()

    def test_missing_alias_and_regular_directory_alias_rejected(self):
        self.alias.unlink()
        self.assert_alias_rejected()
        self.alias.mkdir()
        self.assert_alias_rejected()

    def test_missing_or_symlink_target_rejected_even_if_link_is_safe(self):
        target = self.root / 'run/lock'
        target.rmdir()
        self.assert_alias_rejected()
        (self.root / 'run/real-lock').mkdir()
        target.symlink_to('real-lock')
        self.assert_alias_rejected()

    def test_symlink_ancestors_rejected_even_if_they_stay_inside_root(self):
        for relative in ('var', 'run'):
            original = self.root / relative
            renamed = self.root / (relative + '-real')
            original.rename(renamed)
            original.symlink_to(renamed.name)
            with self.subTest(relative=relative):
                self.assert_alias_rejected()
            original.unlink()
            renamed.rename(original)

    def test_writable_ancestors_and_nonsticky_writable_target_rejected(self):
        for relative in ('', 'var', 'run', 'run/lock'):
            path = self.root / relative
            before = stat.S_IMODE(path.stat().st_mode)
            for mode in (0o775, 0o777, 0o1775):
                path.chmod(mode)
                with self.subTest(relative=relative, mode=oct(mode)):
                    self.assert_alias_rejected()
            path.chmod(before)

    def test_owner_of_each_alias_component_and_link_count_are_checked(self):
        original = Path.lstat
        for relative in ('', 'var', 'run', 'var/lock', 'run/lock'):
            changed = self.root / relative
            def wrong_owner(path, *args, **kwargs):
                result = original(path, *args, **kwargs)
                if path == changed:
                    fields = list(result)
                    fields[4] = self.owner + 1
                    return os.stat_result(fields)
                return result
            with self.subTest(relative=relative), patch.object(Path, 'lstat', wrong_owner):
                self.assert_alias_rejected()
        def multiple_links(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == self.alias:
                fields = list(result)
                fields[3] = 2
                return os.stat_result(fields)
            return result
        with patch.object(Path, 'lstat', multiple_links):
            self.assert_alias_rejected()

    def test_alias_verification_is_read_only_and_no_new_general_scope(self):
        def snapshot():
            return {str(p.relative_to(self.root)): (p.lstat().st_ino, p.lstat().st_mode,
                    p.lstat().st_uid, p.lstat().st_gid, p.lstat().st_mtime_ns,
                    os.readlink(p) if p.is_symlink() else None)
                    for p in [self.root, *self.root.rglob('*')]}
        before = snapshot()
        self.directories()
        for value in ('/opt/unreviewed', '/var/lib/nginx/../../../opt/escape'):
            with self.subTest(value=value), self.assertRaisesRegex(
                    RuntimeError, 'NGINX_COMPILED_WRITE_PATH_REQUIRES_REVIEW'):
                self.directories(flags={**self.flags, 'http-proxy-temp-path': value})
        self.assertEqual(snapshot(), before)


if __name__ == '__main__':
    unittest.main()
