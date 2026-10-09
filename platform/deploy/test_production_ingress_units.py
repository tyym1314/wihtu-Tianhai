import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name('production-ingress-units.py')
spec = importlib.util.spec_from_file_location('production_ingress_units', MODULE)
units = importlib.util.module_from_spec(spec)
spec.loader.exec_module(units)

SERVICE, TIMER = units.UNIT_NAMES
TEMPLATES = {
    SERVICE: '[Unit]\nDescription=Production certificate\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 -I -B /opt/oasis/releases/20261010-01/platform/deploy/production-ingress.py renew --release /opt/oasis/releases/20261010-01 --manifest-sha256 ' + 'a' * 64 + '\n',
    TIMER: '[Unit]\nDescription=Certificate schedule\n[Timer]\nOnCalendar=*-*-* 00,12:20:00\n[Install]\nWantedBy=timers.target\n',
}


class FakeRuntime:
    def __init__(self, main, installed=False):
        self.main = main
        self.installed = installed
        self.command_override = {}
        self.state_override = {}
        self.reads = []
        self.enabled = []

    def service(self, name):
        return self.state_override.get(name, {
            'FragmentPath': str(self.main / name) if self.installed else '',
            'DropInPaths': '', 'MainPID': '0', 'NeedDaemonReload': 'no',
        })

    def loaded_commands(self, name):
        self.reads.append(name)
        return self.command_override.get(name, units.expected_commands(TEMPLATES[name])
                                         if name == SERVICE else {})

    def enable(self):
        self.enabled.append(TIMER)


class ProductionIngressUnitsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name).resolve()
        self.main = root / 'etc/systemd/system'
        self.main.mkdir(parents=True)
        self.transient = root / 'run/systemd/transient'
        self.control = root / 'run/systemd/system.control'
        self.transient.mkdir(parents=True)
        self.control.mkdir(parents=True)
        self.runtime = FakeRuntime(self.main)
        self.patches = [patch.object(units, 'MAIN_ROOT', self.main),
                        patch.object(units, 'SYSTEMD_ROOTS', (self.main, self.transient, self.control)),
                        # The filesystem tests run as the desktop user, not host root.
                        patch.object(units, 'ROOT_UID', os.getuid())]
        for change in self.patches:
            change.start()

    def tearDown(self):
        for change in reversed(self.patches):
            change.stop()
        self.temporary.cleanup()

    def install(self):
        for name, body in TEMPLATES.items():
            file = self.main / name
            file.write_text(body)
            file.chmod(0o644)
        self.runtime.installed = True

    def enable_after_guard(self):
        units.loaded_guard(TEMPLATES, self.runtime)
        self.runtime.enable()

    def test_fixed_two_units_only(self):
        for value in [{SERVICE: TEMPLATES[SERVICE]}, {**TEMPLATES, 'foreign.service': '[Service]'}]:
            with self.assertRaisesRegex(RuntimeError, 'TEMPLATE_SCOPE'):
                units.namespace_guard(value, self.runtime)

    def test_empty_namespace_requires_uncached_units(self):
        self.assertFalse(units.namespace_guard(TEMPLATES, self.runtime)['installed'])
        for field, value in [('FragmentPath', '/run/systemd/transient/' + SERVICE),
                             ('DropInPaths', '/run/foreign.conf'), ('MainPID', '234')]:
            with self.subTest(field=field):
                self.runtime.state_override[SERVICE] = {field: value}
                with self.assertRaisesRegex(RuntimeError, 'ALREADY_LOADED'):
                    units.namespace_guard(TEMPLATES, self.runtime)
        self.assertEqual(self.runtime.enabled, [])

    def test_exact_installed_templates_and_timer_enable_link_pass(self):
        self.install()
        wants = self.main / 'timers.target.wants'
        wants.mkdir()
        (wants / TIMER).symlink_to(self.main / TIMER)
        self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [TIMER])
        self.assertEqual(self.runtime.reads, [SERVICE, TIMER])

    def test_real_dropin_refused_before_enable(self):
        self.install()
        dropin = self.main / (SERVICE + '.d')
        dropin.mkdir()
        (dropin / 'foreign.conf').write_text('[Service]\nExecStartPre=/foreign/root-command\n')
        with self.assertRaisesRegex(RuntimeError, 'FOREIGN_DIRECTORY'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])
        self.assertEqual(self.runtime.reads, [])

    def test_transient_and_control_foreign_references_refused(self):
        self.install()
        for root in (self.transient, self.control):
            file = root / 'foreign.service'
            file.write_text('[Unit]\nPartOf=' + SERVICE + '\n')
            with self.subTest(root=root), self.assertRaisesRegex(RuntimeError, 'FOREIGN_DEPENDENCY'):
                self.enable_after_guard()
            file.unlink()
        self.assertEqual(self.runtime.enabled, [])

    def test_real_wrong_wants_and_foreign_alias_symlinks_refused(self):
        self.install()
        for parent, name in [('multi-user.target.wants', TIMER),
                             ('timers.target.wants', SERVICE), ('foreign.target.wants', TIMER)]:
            directory = self.main / parent
            directory.mkdir(exist_ok=True)
            link = directory / name
            link.symlink_to(self.main / name)
            with self.subTest(parent=parent, name=name), self.assertRaisesRegex(RuntimeError, 'LINK_UNSAFE'):
                self.enable_after_guard()
            link.unlink()
        alias = self.main / 'foreign.service'
        alias.symlink_to(self.main / SERVICE)
        with self.assertRaisesRegex(RuntimeError, 'LINK_UNSAFE'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_timer_wants_directory_cannot_be_a_symlink(self):
        self.install()
        foreign = Path(self.temporary.name) / 'foreign'
        foreign.mkdir()
        (self.main / 'timers.target.wants').symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'DIRECTORY_UNSAFE'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_owned_namespace_fifo_is_refused_without_reading(self):
        self.install()
        os.mkfifo(self.transient / (units.UNIT_PREFIX + '-foreign.service'))
        with self.assertRaisesRegex(RuntimeError, 'SPECIAL_FILE'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_wrong_root_file_mode_symlink_hardlink_or_content_refused(self):
        self.install()
        file = self.main / SERVICE
        file.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'FILE_UNSAFE'):
            self.enable_after_guard()
        file.chmod(0o644)
        hard = self.main / 'other-file'
        os.link(file, hard)
        with self.assertRaisesRegex(RuntimeError, 'FILE_UNSAFE'):
            self.enable_after_guard()
        hard.unlink()
        file.write_text(TEMPLATES[SERVICE] + 'ExecStartPre=/foreign\n')
        with self.assertRaisesRegex(RuntimeError, 'CONTENT_CHANGED'):
            self.enable_after_guard()
        file.unlink()
        target = self.main / 'foreign-file'
        target.write_text(TEMPLATES[SERVICE])
        file.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'LINK_UNSAFE'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_missing_definition_refused(self):
        self.install()
        (self.main / TIMER).unlink()
        with self.assertRaisesRegex(RuntimeError, 'DEFINITION_MISSING'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_cached_bad_exec_start_pre_refused_before_enable(self):
        self.install()
        self.runtime.command_override[SERVICE] = {**units.expected_commands(TEMPLATES[SERVICE]),
            'ExecStartPre': [['/foreign/root-command', ['/foreign/root-command'], False]]}
        with self.assertRaisesRegex(RuntimeError, 'LOADED_COMMAND_CHANGED'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_effective_fragment_dropin_reload_and_timer_commands_refused(self):
        self.install()
        for key, value in [('FragmentPath', '/run/systemd/system/' + SERVICE),
                           ('DropInPaths', '/run/foreign.conf'), ('NeedDaemonReload', 'yes')]:
            self.runtime.state_override[SERVICE] = {**self.runtime.service(SERVICE), key: value}
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'LOADED_FRAGMENT_CHANGED'):
                self.enable_after_guard()
            self.runtime.state_override.clear()
        self.runtime.command_override[TIMER] = {'ExecStart': [['/foreign', ['/foreign'], False]]}
        with self.assertRaisesRegex(RuntimeError, 'LOADED_COMMAND_CHANGED'):
            self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_runtime_typed_dependency_refusal_is_never_bypassed(self):
        self.install()
        with patch.object(self.runtime, 'loaded_commands', side_effect=RuntimeError('OWNED_LOADED_FOREIGN_DEPENDENCY')):
            with self.assertRaisesRegex(RuntimeError, 'FOREIGN_DEPENDENCY'):
                self.enable_after_guard()
        self.assertEqual(self.runtime.enabled, [])

    def test_expected_commands_match_reviewed_provision_parser(self):
        module = Path(__file__).parent / 'production-instance/provision.py'
        loaded_spec = importlib.util.spec_from_file_location('reviewed_provision', module)
        provision = importlib.util.module_from_spec(loaded_spec)
        loaded_spec.loader.exec_module(provision)
        self.assertEqual(units.expected_commands(TEMPLATES[SERVICE]),
                         provision.expected_commands(TEMPLATES[SERVICE]))


if __name__ == '__main__':
    unittest.main()
