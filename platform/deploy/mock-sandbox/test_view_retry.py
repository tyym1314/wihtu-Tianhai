"""Local fault injection only; never operates services, SQL or the network."""
from contextlib import contextmanager
import copy
import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load('view_retry_test', HERE / 'view_retry.py')
f = load('view_retry_original_controller_tests', HERE / 'test_view_upgrade.py')
r = load('view_retry_frozen_runtime', HERE / 'view_runtime.py')


class FakeClock:
    def __init__(self):
        self.value = 0.0
    def now(self):
        return self.value
    def sleep(self, delay):
        self.value += delay


def rolled_back():
    runtime = f.FakeRuntime()
    runtime.fail_once = 'start:forward'
    result = f.controller.ViewUpgrade(runtime).apply()
    assert result['status'] == 'rolled_back'
    runtime.journal['tool_hashes'] = {'view_upgrade.py':m.CONTROLLER_SHA,'view_runtime.py':m.RUNTIME_SHA}
    runtime.events.clear()
    return runtime


def retry(runtime, **options):
    return m.ViewRetry(runtime, f.controller, **options)


def real_start_fixture(errors):
    """Use the actual frozen start function, including its proven error line."""
    task = object.__new__(r.ViewRuntime)
    task._locked = Mock()
    task._matching_guard = Mock()
    task.upgrade = types.SimpleNamespace(APP_UNITS=('api', 'demo'))
    task.releases = {'forward': Path('/opt/oasis/releases/20261008-16')}
    task.runtime = types.SimpleNamespace(services=Mock(return_value={'api':'inactive','demo':'inactive'}),
                                        preflight=Mock(), start=Mock())
    task._processes = Mock(side_effect=errors)
    task.save = Mock()
    journal = {'retry':{'startup_observations':[]}}
    owner = types.SimpleNamespace(journal=journal)
    return task, owner


class StartupTests(unittest.TestCase):
    def test_actual_frozen_start_transient_cwd_error_then_strictly_normal(self):
        task, owner = real_start_fixture([RuntimeError('VIEW_PROCESS_RELEASE_MISMATCH'), {'pid':'strict proof'}])
        clock = FakeClock()
        observe = Mock(return_value={'api':{'pid':2,'cwd':'/','argv':['<redacted>']}})
        adapter = m.StartupReadiness(task, owner, clock=clock.now, sleep=clock.sleep, observer=observe)
        result = adapter.start('forward', {})
        self.assertEqual(result, {'pid':'strict proof'})
        task.runtime.start.assert_called_once()
        self.assertEqual(task._processes.call_count, 2)
        self.assertEqual(len(owner.journal['retry']['startup_observations']),1)
        record = owner.journal['retry']['startup_observations'][0]
        self.assertTrue(record['strict_pass'])
        self.assertEqual(record['original_error'],'VIEW_PROCESS_RELEASE_MISMATCH')
        self.assertEqual(task.save.call_count,2)

    def test_persistent_wrong_process_expires_without_second_start(self):
        task, owner = real_start_fixture(RuntimeError('VIEW_PROCESS_RELEASE_MISMATCH'))
        clock = FakeClock()
        adapter = m.StartupReadiness(task, owner, clock=clock.now, sleep=clock.sleep, observer=lambda _: {})
        with self.assertRaisesRegex(m.ReadinessDeadline,'RETRY_STARTUP_READINESS_TIMEOUT'):
            adapter.start('forward', {})
        task.runtime.start.assert_called_once()
        self.assertEqual(clock.value,10)
        self.assertFalse(owner.journal['retry']['startup_observations'][0]['strict_pass'])

    def test_existing_wrong_role_and_preflight_error_are_not_startup_race(self):
        for kind in ('already_active','preflight'):
            task, owner = real_start_fixture(RuntimeError('VIEW_PROCESS_RELEASE_MISMATCH'))
            if kind == 'already_active':
                task.runtime.services.return_value = {'api':'active','demo':'active'}
            else:
                task.runtime.preflight.side_effect = RuntimeError('VIEW_PROCESS_RELEASE_MISMATCH')
            observer = Mock()
            adapter = m.StartupReadiness(task, owner, observer=observer)
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError,'VIEW_PROCESS_RELEASE_MISMATCH'):
                adapter.start('forward', {})
            task.runtime.start.assert_not_called()
            observer.assert_not_called()
            self.assertEqual(owner.journal['retry']['startup_observations'],[])

    def test_guard_or_unknown_post_start_errors_are_not_reclassified(self):
        task, owner = real_start_fixture(RuntimeError('UNKNOWN_PROCESS_FAILURE'))
        adapter = m.StartupReadiness(task, owner, observer=Mock())
        with self.assertRaisesRegex(RuntimeError,'UNKNOWN_PROCESS_FAILURE'):
            adapter.start('forward', {})
        task.runtime.start.assert_called_once()
        self.assertEqual(owner.journal['retry']['startup_observations'],[])

    def test_hard_signal_deadline_is_always_disarmed_and_restores_handler(self):
        before = m.signal.getsignal(m.signal.SIGALRM)
        with self.assertRaisesRegex(RuntimeError,'injected'):
            with m.read_deadline(10):
                raise RuntimeError('injected')
        self.assertEqual(m.signal.getitimer(m.signal.ITIMER_REAL),(0.0,0.0))
        self.assertIs(m.signal.getsignal(m.signal.SIGALRM),before)

    def test_hard_deadline_interrupts_a_stalled_read_probe(self):
        with self.assertRaisesRegex(m.ReadinessDeadline,'RETRY_STARTUP_READINESS_TIMEOUT'):
            with m.read_deadline(0.02):
                m.time.sleep(0.2)
        self.assertEqual(m.signal.getitimer(m.signal.ITIMER_REAL),(0.0,0.0))


class RetryTests(unittest.TestCase):
    def test_only_once_with_original_checks_backup_baseline_and_tool_hashes_unchanged(self):
        runtime = rolled_back()
        original = copy.deepcopy(runtime.journal)
        result = retry(runtime).apply()
        self.assertEqual(result['status'],'upgraded')
        self.assertEqual(runtime.journal['phase'],'complete')
        for field in ('checks','baseline','backup','migration','tool_hashes'):
            self.assertEqual(runtime.journal[field],original[field])
        self.assertEqual(runtime.journal['retry']['attempt'],1)
        self.assertNotIn('migrate',runtime.events)
        self.assertNotIn('backup',runtime.events)
        with self.assertRaisesRegex(RuntimeError,'RETRY_ALREADY_USED'):
            retry(runtime).apply()
        runtime.events.clear()
        result=retry(runtime).recover()
        self.assertEqual(result['status'],'already_complete')
        self.assertFalse(any(x.startswith(('start:','switch_pin:','switch_marker:','save_before:')) or x=='stop' for x in runtime.events))

    def test_check_only_and_existing_new_business_refuse_without_consuming_retry(self):
        runtime = rolled_back()
        self.assertEqual(retry(runtime).check()['status'],'eligible')
        self.assertNotIn('retry',runtime.journal)
        runtime.business['revision'] += 1
        runtime.events.clear()
        with self.assertRaisesRegex(RuntimeError,'RETRY_NEW_BUSINESS_OR_SCHEMA'):
            retry(runtime).apply()
        self.assertNotIn('retry',runtime.journal)
        self.assertNotIn('stop',runtime.events)
        self.assertFalse(any(x.startswith('start:') for x in runtime.events))

    def test_new_business_before_or_during_stop_keeps_rollback_role_and_consumes_one_retry(self):
        for point in ('save_after:stopping','stop'):
            runtime = rolled_back()
            runtime.hooks[point]=lambda:runtime.business.update(revision=1)
            result=retry(runtime).apply()
            self.assertEqual(result['status'],'rolled_back')
            self.assertEqual(runtime.pair,{'pin':'rollback','marker':'rollback'})
            self.assertTrue(runtime.active)
            self.assertNotIn('switch_pin:forward',runtime.events)
            if point=='save_after:stopping':
                self.assertNotIn('stop',runtime.events)
            self.assertEqual(runtime.journal['retry']['attempt'],1)

    def test_power_loss_at_every_forward_phase_recovers_using_same_tool(self):
        for phase in ('stopping','switching','pin_switched','marker_switched','starting'):
            for when in ('before','after'):
                runtime=rolled_back()
                runtime.cut_phase,runtime.cut_when=phase,when
                with self.subTest(phase=phase,when=when),self.assertRaises(f.PowerCut):
                    retry(runtime).apply()
                if 'retry' not in runtime.journal:
                    self.assertEqual(phase,'stopping')
                    self.assertEqual(when,'before')
                    self.assertEqual(runtime.journal['phase'],'rolled_back')
                    continue
                outcome=retry(runtime).recover()
                self.assertEqual(outcome['status'],'rolled_back')
                self.assertEqual(runtime.pair,{'pin':'rollback','marker':'rollback'})
                self.assertTrue(runtime.active)
                self.assertNotIn('migrate',runtime.events)
                self.assertNotIn('backup',runtime.events)

    def test_new_business_in_mixed_switch_is_not_hidden_or_rolled_back(self):
        runtime=rolled_back()
        runtime.hooks['pin_switched:forward']=lambda:runtime.business.update(revision=1,v23=1)
        with self.assertRaisesRegex(RuntimeError,'NEW_BUSINESS_WITH_MIXED_VIEW_IDENTITY'):
            retry(runtime).apply()
        self.assertEqual(runtime.pair,{'pin':'forward','marker':'rollback'})
        self.assertFalse(runtime.active)
        self.assertNotIn('switch_marker:forward',runtime.events)
        self.assertNotIn('switch_pin:rollback',runtime.events)

    def test_committed_forward_business_is_preserved_on_retry_guard_failure(self):
        runtime=rolled_back()
        runtime.hooks['marker_switched:forward']=lambda:runtime.business.update(revision=1,v23=1)
        result=retry(runtime).apply()
        self.assertEqual(result['status'],'upgraded')
        self.assertEqual(runtime.pair,{'pin':'forward','marker':'forward'})
        self.assertEqual(runtime.business['v23'],1)
        self.assertNotIn('switch_pin:rollback',runtime.events)

    def test_corrupt_retry_binding_or_backup_refuses_before_stopping(self):
        runtime=rolled_back()
        runtime.cut_phase='switching'
        with self.assertRaises(f.PowerCut):
            retry(runtime).apply()
        for kind in ('tool','backup'):
            broken=copy.deepcopy(runtime)
            if kind=='tool':
                broken.journal['retry']['tool_sha256']='wrong'
            else:
                broken.backup_corrupt=True
            broken.events.clear()
            with self.assertRaises(RuntimeError):
                retry(broken).recover()
            self.assertNotIn('stop',broken.events)
            self.assertFalse(any(x.startswith('start:') for x in broken.events))

    def test_initial_identity_drift_after_health_is_checked_again(self):
        runtime=rolled_back()
        original_health=runtime.health
        def drift_after_health(role,checks):
            original_health(role,checks)
            runtime.pair.update(pin='forward')
        runtime.health=drift_after_health
        with self.assertRaisesRegex(RuntimeError,'RETRY_IDENTITY_CHANGED'):
            retry(runtime).apply()
        self.assertNotIn('retry',runtime.journal)
        self.assertNotIn('stop',runtime.events)


if __name__=='__main__':
    unittest.main()
