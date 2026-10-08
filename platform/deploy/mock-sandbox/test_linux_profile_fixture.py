"""Local diagnostics tests; no /proc, mount, Nginx, container or service calls."""
import ast
import errno
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().with_name('linux_profile_fixture.py')
fixture = types.ModuleType('linux_profile_fixture_diagnostics_test')
fixture.__file__ = str(SOURCE)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), fixture.__dict__)
STATUS = b'CapEff:\t00000000002000c1\nCapBnd:\t00000000002000c1\nNoNewPrivs:\t1\nSeccomp:\t0\n'
LABEL = b'docker-default (enforce)\n'


class DiagnosticTests(unittest.TestCase):
    def capture(self, status=STATUS, label=LABEL):
        sources = {'/proc/self/status': status, '/proc/self/attr/current': label}
        self.opened, self.read_sizes = [], []
        sizes = self.read_sizes
        class Stream(io.BytesIO):
            def read(self, size=-1):
                sizes.append(size)
                return super().read(size)
        def open_file(path, mode):
            self.assertEqual(mode, 'rb')
            self.assertIn(str(path), sources)
            self.opened.append(str(path))
            value = sources[str(path)]
            if isinstance(value, OSError):
                raise value
            return Stream(value)
        with patch.object(Path, 'open', open_file), patch.object(
                fixture.subprocess, 'run', side_effect=AssertionError('diagnostics must not launch commands')):
            return fixture.self_security_context()

    def test_fixed_self_paths_bounded_reads_and_no_extra_status_fields(self):
        result = self.capture(b'Name:\tprivate process\nUid:\t1234\nOther:\tDO_NOT_COPY\n' + STATUS)
        self.assertEqual(self.opened, ['/proc/self/status', '/proc/self/attr/current'])
        self.assertEqual(self.read_sizes, [16385, 1025])
        self.assertEqual(result, {
            'scope': 'container_process_self',
            'proc_self_status': {'state': 'available', 'fields': {
                'CapEff': '00000000002000c1', 'CapBnd': '00000000002000c1',
                'NoNewPrivs': 1, 'Seccomp': 0}, 'unavailable_fields': {}},
            'lsm_current': {'state': 'available', 'value': 'docker-default (enforce)'}})
        self.assertNotIn('DO_NOT_COPY', json.dumps(result))
        self.assertNotIn('private process', json.dumps(result))

    def test_zero_capabilities_and_all_known_seccomp_values_are_not_gates(self):
        for value in (0, 1, 2):
            status = STATUS.replace(b'00000000002000c1', b'0000000000000000').replace(
                b'Seccomp:\t0', b'Seccomp:\t' + str(value).encode())
            with self.subTest(value=value):
                result = self.capture(status, b'unconfined\n')
                self.assertEqual(result['proc_self_status']['state'], 'available')
                self.assertEqual(result['proc_self_status']['fields']['Seccomp'], value)
                self.assertEqual(result['proc_self_status']['fields']['CapEff'], '0000000000000000')
                self.assertNotIn('passed', result)
                self.assertNotIn('skip', result)

    def test_missing_and_duplicate_fields_are_explicit_not_inferred(self):
        result = self.capture(b'CapEff:\t00000000002000c1\nCapEff:\t00000000002000c1\nSeccomp:\t2\n')
        self.assertEqual(result['proc_self_status'], {
            'state': 'partial', 'fields': {'Seccomp': 2},
            'unavailable_fields': {'CapEff': 'duplicate', 'CapBnd': 'missing', 'NoNewPrivs': 'missing'}})

    def test_malformed_capabilities_or_integer_values_are_not_accepted(self):
        for name, old, bad in [('CapEff', b'00000000002000c1', b'0x2000c1'),
                               ('CapBnd', b'00000000002000c1', b'fffffffffffffffff'),
                               ('NoNewPrivs', b'1', b'2'), ('Seccomp', b'0', b'3'),
                               ('Seccomp', b'0', b'-1')]:
            status = STATUS.replace(name.encode() + b':\t' + old,
                                    name.encode() + b':\t' + bad)
            with self.subTest(name=name, bad=bad):
                result = self.capture(status)['proc_self_status']
                self.assertNotIn(name, result['fields'])
                self.assertEqual(result['unavailable_fields'][name], 'malformed')

    def test_read_denied_or_missing_is_unavailable_without_exception_text(self):
        result = self.capture(PermissionError(errno.EACCES, 'DO_NOT_COPY'),
                              FileNotFoundError(errno.ENOENT, 'DO_NOT_COPY'))
        self.assertEqual(result['proc_self_status'], {
            'state': 'unavailable', 'reason': 'read_error', 'errno': errno.EACCES})
        self.assertEqual(result['lsm_current'], {
            'state': 'unavailable', 'reason': 'read_error', 'errno': errno.ENOENT})
        self.assertNotIn('DO_NOT_COPY', json.dumps(result))

    def test_one_failed_file_does_not_hide_the_other_diagnostic(self):
        result = self.capture(PermissionError(errno.EACCES, 'denied'))
        self.assertEqual(result['lsm_current']['value'], 'docker-default (enforce)')
        result = self.capture(label=PermissionError(errno.EACCES, 'denied'))
        self.assertEqual(result['proc_self_status']['state'], 'available')

    def test_oversize_and_invalid_utf8_are_bounded_unavailable(self):
        for status, label, reason in [(b'x' * 20000, b'x' * 2000, 'size_limit'),
                                      (b'\xff', b'\xff', 'invalid_utf8')]:
            with self.subTest(reason=reason):
                result = self.capture(status, label)
                self.assertEqual(self.read_sizes, [16385, 1025])
                for name in ('proc_self_status', 'lsm_current'):
                    self.assertEqual(result[name], {'state': 'unavailable', 'reason': reason})

    def test_empty_or_multiline_label_is_not_reported_as_a_valid_lsm(self):
        for label in (b'', b'\n', b'label\nextra\n', b'label\x00', b'label\t'):
            with self.subTest(label=label):
                self.assertEqual(self.capture(label=label)['lsm_current'],
                                 {'state': 'unavailable', 'reason': 'malformed'})

    def test_unavailable_diagnostic_does_not_replace_original_native_failure(self):
        result = self.capture(PermissionError(errno.EACCES, 'denied'),
                              PermissionError(errno.EACCES, 'denied'))
        args = ['/usr/bin/mount', '-t', 'tmpfs', '-o', 'size=1m', 'fixture-owned', '/unrelated/nested']
        stderr = ('mount: /unrelated/nested: cannot mount fixture-owned read-only.\n'
                  '       dmesg(1) may have more information after failed mount system call.\n')
        report = {'passed': False, 'process_security_before_first_mount': result}
        with patch.object(fixture.subprocess, 'run', return_value=types.SimpleNamespace(
                returncode=32, stdout='', stderr=stderr)) as run:
            with self.assertRaises(RuntimeError) as raised:
                fixture.command(args)
            run.assert_called_once_with(args, capture_output=True, text=True, timeout=30)
        report['failure'] = str(raised.exception)
        self.assertEqual(json.loads(report['failure'].removeprefix('COMMAND_FAILED ')),
                         {'argv': args, 'returncode': 32, 'stdout': '', 'stderr': stderr})
        self.assertFalse(report['passed'])
        self.assertNotIn('skip', report)

    def test_capture_is_after_guard_and_immediately_before_first_mount(self):
        tree = ast.parse(SOURCE.read_text(), feature_version=(3, 10))
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        self.assertEqual(ast.unparse(main.body[0]), 'guard()')
        block = next(n for n in main.body if isinstance(n, ast.Try))
        index = next(i for i, n in enumerate(block.body)
                     if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
                     and ast.unparse(n.value.func) == 'self_security_context')
        self.assertEqual(ast.unparse(block.body[index].targets[0]),
                         "report['process_security_before_first_mount']")
        self.assertEqual(ast.literal_eval(block.body[index + 1].value.args[0].elts[0]), '/usr/bin/mount')


if __name__ == '__main__':
    unittest.main()
