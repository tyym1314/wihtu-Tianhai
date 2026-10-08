"""Real relocated filesystem rollback boundaries, with fake service adapters.

These tests prove neither Linux mount isolation nor Nginx reload behavior. They
exercise the actual activation controller and filesystem writes, while the
existing FakeRuntime forbids host commands, database access and networking.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
import unittest
from unittest.mock import patch


def load(name, path):
    import types
    result = types.ModuleType(name)
    result.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), result.__dict__)
    return result


fixture = load('profile_recovery_existing_fixture', Path(__file__).with_name('test_profile_activation.py'))
a = fixture.a


@contextmanager
def owned_case():
    case = fixture.ActivationTests('runTest')
    try:
        case.setUp()
        yield case
    finally:
        case.doCleanups()


class ProfileRecoveryTests(unittest.TestCase):
    def crash_configured(self, case):
        save = case.task.save
        def crash(journal, phase):
            save(journal, phase)
            if phase == 'configured':
                raise fixture.Crash()
        with patch.object(case.task, 'save', side_effect=crash), self.assertRaises(fixture.Crash):
            case.task.activate()
        self.assertEqual(case.task.load()['phase'], 'configured')

    def assert_original(self, case):
        self.assertEqual(case.materials.config.read_bytes(), case.artifacts['original.conf'])
        self.assertEqual(case.runtime.loaded, 'original')
        self.assertEqual(case.task.load()['phase'], 'rolled_back')
        case.assert_untouched()

    def test_interruption_at_each_restoration_journal_boundary_converges(self):
        for phase in ('restoring', 'restored', 'rolled_back'):
            with self.subTest(phase=phase), owned_case() as case:
                case.prepare()
                case.runtime.failure = 'probe:overlay'
                save = case.task.save
                def crash(journal, next_phase):
                    save(journal, next_phase)
                    if next_phase == phase:
                        raise fixture.Crash()
                with patch.object(case.task, 'save', side_effect=crash), self.assertRaises(fixture.Crash):
                    case.task.activate()
                self.assertEqual(case.task.load()['phase'], phase)
                case.runtime.failure = None
                result = case.task.recover()
                self.assertIn(result['status'], ('restored_original', 'already_restored'))
                self.assert_original(case)

    def test_restoration_replace_before_journal_crash_does_not_reactivate_overlay(self):
        with owned_case() as case:
            case.prepare()
            case.runtime.failure = 'probe:overlay'
            replace = case.task.replace_config
            def crash(raw):
                replace(raw)
                if raw == case.artifacts['original.conf']:
                    raise fixture.Crash()
            with patch.object(case.task, 'replace_config', side_effect=crash), self.assertRaises(fixture.Crash):
                case.task.activate()
            self.assertEqual(case.task.load()['phase'], 'restoring')
            self.assertEqual(case.materials.config.read_bytes(), case.artifacts['original.conf'])
            case.runtime.failure = None
            self.assertEqual(case.task.recover()['status'], 'restored_original')
            self.assert_original(case)

    def test_failed_restoration_retains_original_and_can_recover_without_app_stop(self):
        with owned_case() as case:
            case.prepare()
            probe = case.runtime.probe
            def failed_probe(kind, inputs, release):
                if kind == 'overlay':
                    raise RuntimeError('FIXTURE_OVERLAY_READBACK_FAILED')
                return probe(kind, inputs, release)
            reload_config = case.runtime.reload
            def failed_restore_reload():
                if case.materials.config.read_bytes() == case.artifacts['original.conf']:
                    raise RuntimeError('FIXTURE_ORIGINAL_RELOAD_FAILED')
                return reload_config()
            with patch.object(case.runtime, 'probe', side_effect=failed_probe), \
                 patch.object(case.runtime, 'reload', side_effect=failed_restore_reload), \
                 self.assertRaisesRegex(RuntimeError, 'ACTIVATION_RECOVERY_REQUIRED'):
                case.task.activate()
            self.assertEqual(case.task.load()['phase'], 'restored')
            self.assertEqual(case.materials.config.read_bytes(), case.artifacts['original.conf'])
            self.assertEqual(case.runtime.loaded, 'overlay')  # disk != loaded is explicit until recovery
            case.assert_untouched()
            self.assertEqual(case.task.recover()['status'], 'restored_original')
            self.assert_original(case)

    def test_unknown_effective_config_during_rollback_is_never_overwritten(self):
        with owned_case() as case:
            case.prepare()
            self.crash_configured(case)
            unknown = b'# independently changed configuration\n'
            case.materials.config.write_bytes(unknown)
            before = fixture.uf.tree(case.root)
            with self.assertRaisesRegex((RuntimeError, ValueError), 'UNKNOWN_ROUTE_PROFILE'):
                case.task.recover()
            self.assertEqual(fixture.uf.tree(case.root), before)
            self.assertEqual(case.materials.config.read_bytes(), unknown)
            self.assertNotIn('reload', case.runtime.events)
            case.assert_untouched()

    def test_corrupt_backup_refuses_restoration_without_overwriting_effective_config(self):
        with owned_case() as case:
            case.prepare()
            self.crash_configured(case)
            journal = case.task.load()
            case.task.save(journal, 'restoring')
            backup = case.materials.control / 'original.conf'
            backup.write_bytes(b'corrupt backup')
            before = fixture.uf.tree(case.root)
            with self.assertRaisesRegex(RuntimeError, 'PROFILE_BACKUP_CHANGED'):
                case.task.recover()
            self.assertEqual(fixture.uf.tree(case.root), before)
            self.assertEqual(case.materials.config.read_bytes(), case.artifacts['overlay.conf'])
            self.assertNotIn('reload', case.runtime.events)
            case.assert_untouched()

    def test_atomic_replace_preserves_open_old_body_and_publishes_complete_new_body(self):
        with owned_case() as case:
            path = case.materials.config
            before = path.stat()
            with path.open('rb') as old_reader:
                case.task.replace_config(case.artifacts['overlay.conf'])
                self.assertEqual(old_reader.read(), case.artifacts['original.conf'])
                self.assertEqual(os.fstat(old_reader.fileno()).st_ino, before.st_ino)
            self.assertNotEqual(path.stat().st_ino, before.st_ino)
            self.assertEqual(path.read_bytes(), case.artifacts['overlay.conf'])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(path.stat().st_nlink, 1)
            case.assert_untouched()

    def test_replacement_fsyncs_new_body_before_rename_then_parent(self):
        with owned_case() as case:
            events = []
            real_fsync, real_replace, real_sync = a.os.fsync, a.os.replace, a.upgrade.sync_dir
            def fsync(fd):
                events.append(('fsync', stat.S_ISREG(os.fstat(fd).st_mode)))
                return real_fsync(fd)
            def replace(source, target):
                self.assertEqual(case.materials.config.read_bytes(), case.artifacts['original.conf'])
                self.assertEqual(Path(source).read_bytes(), case.artifacts['overlay.conf'])
                events.append(('replace', Path(target)))
                return real_replace(source, target)
            def sync(parent):
                events.append(('sync_dir', Path(parent)))
                return real_sync(parent)
            with patch.object(a.os, 'fsync', side_effect=fsync), \
                 patch.object(a.os, 'replace', side_effect=replace), \
                 patch.object(a.upgrade, 'sync_dir', side_effect=sync):
                case.task.replace_config(case.artifacts['overlay.conf'])
            self.assertEqual(events[:3], [('fsync', True), ('replace', case.materials.config),
                                         ('sync_dir', case.materials.config.parent)])
            case.assert_untouched()

    def test_rename_failure_preserves_effective_original_and_evidence(self):
        with owned_case() as case:
            before = case.materials.config.stat()
            with patch.object(a.os, 'replace', side_effect=OSError('fixture rename refused')), \
                 self.assertRaisesRegex(OSError, 'fixture rename refused'):
                case.task.replace_config(case.artifacts['overlay.conf'])
            self.assertEqual(case.materials.config.read_bytes(), case.artifacts['original.conf'])
            self.assertEqual(case.materials.config.stat().st_ino, before.st_ino)
            pending = list(case.materials.config.parent.glob('.oasis-mock-profile-*'))
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].read_bytes(), case.artifacts['overlay.conf'])
            # Retained owned evidence is not interpreted as an installed config.
            self.assertFalse(case.task.journal.exists())
            case.assert_untouched()

    def test_parent_fsync_failure_after_replace_recovers_from_durable_switching(self):
        with owned_case() as case:
            case.prepare()
            real_sync = a.upgrade.sync_dir
            fired = False
            def fail_once(parent):
                nonlocal fired
                if (not fired and Path(parent) == case.materials.config.parent
                        and case.materials.config.read_bytes() == case.artifacts['overlay.conf']):
                    fired = True
                    raise fixture.Crash()
                return real_sync(parent)
            with patch.object(a.upgrade, 'sync_dir', side_effect=fail_once), self.assertRaises(fixture.Crash):
                case.task.activate()
            self.assertTrue(fired)
            self.assertEqual(case.task.load()['phase'], 'switching')
            self.assertEqual(case.task.recover()['status'], 'activated')
            self.assertEqual(case.task.load()['phase'], 'complete')
            case.assert_untouched()


if __name__ == '__main__':
    unittest.main()
