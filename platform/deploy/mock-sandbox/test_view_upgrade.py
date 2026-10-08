"""Pure in-memory fault injection for the view-specific upgrade controller.

No PostgreSQL, subprocess, filesystem deployment, installer, network or service
is involved. Runtime side effects and durable journal writes are deliberately
separate so a simulated power loss cannot be mistaken for exception recovery.
"""
from contextlib import contextmanager
import copy
import importlib.util
from pathlib import Path
import unittest


SOURCE = Path(__file__).with_name('view_upgrade.py')
SPEC = importlib.util.spec_from_file_location('view_upgrade_under_test', SOURCE)
controller = importlib.util.module_from_spec(SPEC)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), controller.__dict__)


class PowerCut(BaseException):
    """An abrupt process loss; normal controller recovery must not catch this."""


class FakeRuntime:
    def __init__(self):
        self.events = []
        self.active = True
        self.pair = {'pin': 'origin', 'marker': 'origin'}
        self.checks = {'identity': 'fixed-mock-fixture', 'plan_sha256': 'a' * 64}
        self.fixed = copy.deepcopy(self.checks)
        self.business = {'schema': 'old', 'revision': 0, 'pending': 0, 'v23': 0}
        self.journal = None
        self.backup_receipt = None
        self.backup_corrupt = False
        self.cut_phase = None
        self.cut_when = 'after'
        self.fail_once = None
        self.hooks = {}
        self.lock_depth = 0

    def event(self, name):
        if self.lock_depth < 1:
            raise AssertionError('Runtime operation outside transaction lock: ' + name)
        self.events.append(name)
        if self.fail_once == name:
            self.fail_once = None
            raise RuntimeError('FIXTURE_FAILURE:' + name)
        hook = self.hooks.pop(name, None)
        if hook:
            hook()

    @contextmanager
    def locked(self):
        self.lock_depth += 1
        try:
            yield
        finally:
            self.lock_depth -= 1

    def check_initial(self):
        self.event('check_initial')
        self.verify_fixed(self.checks)
        if self.pair != {'pin': 'origin', 'marker': 'origin'}:
            raise RuntimeError('INITIAL_PAIR_NOT_ORIGIN')
        if self.business['schema'] != 'old':
            raise RuntimeError('INITIAL_SCHEMA_NOT_OLD')
        self.require_quiet(self.business)
        self.allow_role(self.business, 'origin')
        return copy.deepcopy(self.checks)

    def _store(self, journal):
        phase = journal['phase']
        self.event('save_before:' + phase)
        if self.cut_phase == phase and self.cut_when == 'before':
            self.cut_phase = None
            raise PowerCut('before:' + phase)
        self.journal = copy.deepcopy(journal)
        self.event('save_after:' + phase)
        if self.cut_phase == phase and self.cut_when == 'after':
            self.cut_phase = None
            raise PowerCut('after:' + phase)

    def create_journal(self, journal):
        if self.journal is not None:
            raise RuntimeError('JOURNAL_ALREADY_EXISTS')
        self._store(journal)

    def save(self, journal):
        if self.journal is None:
            raise RuntimeError('JOURNAL_MISSING')
        self._store(journal)

    def load_journal(self):
        self.event('load_journal')
        if self.journal is None:
            raise RuntimeError('JOURNAL_MISSING')
        return copy.deepcopy(self.journal)

    def verify_fixed(self, checks):
        self.event('verify_fixed')
        if checks != self.checks or self.fixed != self.checks:
            raise RuntimeError('FIXED_FOREIGN_IDENTITY')

    def identity(self, checks):
        self.event('identity')
        return copy.deepcopy(self.pair)

    def backup(self, journal):
        self.event('backup')
        if self.active:
            raise RuntimeError('BACKUP_REQUIRES_STOP')
        self.backup_receipt = {'sha256': 'b' * 64, 'baseline': copy.deepcopy(journal['baseline'])}
        self.event('backup_created')
        return copy.deepcopy(self.backup_receipt)

    def verify_backup(self, journal):
        self.event('verify_backup')
        if 'backup' in journal and (self.backup_corrupt or journal['backup'] != self.backup_receipt):
            raise RuntimeError('BACKUP_CORRUPT')

    def snapshot(self):
        self.event('snapshot')
        return dict(copy.deepcopy(self.business), schema_kind={
            'old': 'old', 'migrated': 'migrated',
        }.get(self.business['schema'], 'unknown'))

    def policy(self, snapshot, baseline):
        self.event('policy')
        if snapshot['schema'] not in ('old', 'migrated'):
            raise RuntimeError('UNAPPROVED_SCHEMA')
        if baseline is not None and any(snapshot[key] != baseline[key] for key in ('revision', 'pending', 'v23')):
            return 'new_business'
        return 'old' if snapshot['schema'] == 'old' else 'migrated_empty'

    def migrate(self, baseline):
        self.event('migrate')
        if self.active:
            raise RuntimeError('MIGRATION_REQUIRES_STOP')
        if self.policy(self.business, baseline) != 'old':
            raise RuntimeError('MIGRATION_BASELINE_CHANGED')
        self.business['schema'] = 'migrated'
        # A failure here represents DB COMMIT before the journal records it.
        self.event('migration_committed')
        return self.snapshot()

    def require_quiet(self, snapshot):
        self.event('require_quiet')
        if snapshot['pending']:
            raise RuntimeError('BUSINESS_NOT_QUIET')

    def allow_role(self, snapshot, role):
        self.event('allow_role:' + role)
        if role not in ('origin', 'forward', 'rollback'):
            raise RuntimeError('FOREIGN_ROLE')
        if snapshot['schema'] not in ('old', 'migrated'):
            raise RuntimeError('UNAPPROVED_SCHEMA')
        if role != 'forward' and snapshot['v23']:
            raise RuntimeError('V23_CANNOT_USE_OLD_RUNTIME')
        if role == 'forward' and snapshot['schema'] != 'migrated':
            raise RuntimeError('FORWARD_REQUIRES_MIGRATED_SCHEMA')

    def stop(self):
        self.event('stop_before')
        self.active = False
        self.event('stop')

    def start(self, role, checks):
        self.event('start:' + role)
        if self.pair != {'pin': role, 'marker': role}:
            raise RuntimeError('START_WITH_MIXED_IDENTITY')
        self.allow_role(self.business, role)
        self.active = True
        self.event('started:' + role)

    def switch_pin(self, role, checks):
        if self.active:
            raise RuntimeError('SWITCH_WHILE_ACTIVE')
        self.event('switch_pin:' + role)
        self.pair['pin'] = role
        self.event('pin_switched:' + role)

    def switch_marker(self, role, checks):
        if self.active:
            raise RuntimeError('SWITCH_WHILE_ACTIVE')
        self.event('switch_marker:' + role)
        self.pair['marker'] = role
        self.event('marker_switched:' + role)

    def health(self, role, checks):
        self.event('health:' + role)
        if not self.active or self.pair != {'pin': role, 'marker': role}:
            raise RuntimeError('UNHEALTHY_ROLE')

    def play(self, *, v23=False, pending=1):
        self.business['revision'] += 1
        self.business['pending'] = pending
        if v23:
            self.business['v23'] += 1


def fixture():
    runtime = FakeRuntime()
    return controller.ViewUpgrade(runtime), runtime


def interrupted(phase='starting'):
    task, runtime = fixture()
    runtime.cut_phase = phase
    try:
        task.apply()
    except PowerCut:
        return task, runtime
    raise AssertionError('Expected a durable phase interruption: ' + phase)


class ViewUpgradeTests(unittest.TestCase):
    def assert_pair(self, runtime, role):
        self.assertEqual(runtime.pair, {'pin': role, 'marker': role})
        self.assertTrue(runtime.active)
        self.assertEqual(runtime.lock_depth, 0)

    def assert_no_mutations(self, events):
        for event in events:
            self.assertFalse(event == 'stop' or event.startswith(('start:', 'switch_pin:', 'switch_marker:', 'save_', 'migrate', 'backup_created')), event)

    def test_check_is_read_only_and_success_ends_at_forward(self):
        task, rt = fixture()
        task.check()
        self.assertIsNone(rt.journal)
        self.assert_no_mutations(rt.events)
        result = task.apply()
        self.assert_pair(rt, 'forward')
        self.assertEqual(result['status'], 'upgraded')
        self.assertEqual(result['role'], 'forward')
        self.assertFalse(result['database_restored'])
        self.assertEqual(rt.journal['phase'], 'complete')
        self.assertEqual(rt.business, {'schema': 'migrated', 'revision': 0, 'pending': 0, 'v23': 0})
        self.assertEqual(rt.events.count('stop'), 1)

    def test_each_forward_durable_phase_before_and_after_power_loss(self):
        phases = ('prepared', 'stopping', 'stopped', 'backing_up', 'backed_up', 'migrating', 'migrated',
                  'switching', 'pin_switched', 'marker_switched', 'starting', 'healthy', 'complete')
        for phase in phases:
            for when in ('before', 'after'):
                with self.subTest(phase=phase, when=when):
                    task, rt = fixture()
                    rt.cut_phase, rt.cut_when = phase, when
                    with self.assertRaises(PowerCut):
                        task.apply()
                    if rt.journal is None:
                        self.assert_pair(rt, 'origin')
                        self.assertNotIn('stop', rt.events)
                        continue
                    durable = rt.journal['phase']
                    backed_up = 'backup' in rt.journal
                    task.recover()
                    expected = 'forward' if durable in ('healthy', 'complete') else 'rollback' if backed_up else 'origin'
                    self.assert_pair(rt, expected)
                    self.assertEqual(rt.business['revision'], 0)
                    self.assertFalse(any('restore' in event or 'delete' in event for event in rt.events))

    def test_each_rollback_phase_and_aborted_phase_power_loss(self):
        phases = ('rolling_back', 'rollback_pin_switched', 'rollback_marker_switched',
                  'rollback_starting', 'rollback_healthy', 'rolled_back', 'aborted')
        for phase in phases:
            for when in ('before', 'after'):
                with self.subTest(phase=phase, when=when):
                    task, rt = fixture()
                    rt.fail_once = 'backup' if phase == 'aborted' else 'start:forward'
                    rt.cut_phase, rt.cut_when = phase, when
                    with self.assertRaises(PowerCut):
                        task.apply()
                    task.recover()
                    self.assert_pair(rt, 'origin' if phase == 'aborted' else 'rollback')

    def test_database_commit_before_migrated_journal_preserves_additive_schema(self):
        task, rt = fixture()
        rt.hooks['migration_committed'] = lambda: (_ for _ in ()).throw(PowerCut('after DB COMMIT'))
        with self.assertRaises(PowerCut):
            task.apply()
        self.assertEqual(rt.journal['phase'], 'migrating')
        self.assertEqual(rt.business['schema'], 'migrated')
        task.recover()
        self.assert_pair(rt, 'rollback')
        self.assertEqual(rt.business['schema'], 'migrated')

    def test_pin_and_marker_side_effect_before_their_journal_writes(self):
        for operation in ('pin_switched:forward', 'marker_switched:forward',
                          'pin_switched:rollback', 'marker_switched:rollback'):
            with self.subTest(operation=operation):
                task, rt = fixture()
                if operation.endswith(':rollback'):
                    rt.fail_once = 'start:forward'
                rt.hooks[operation] = lambda: (_ for _ in ()).throw(PowerCut('after identity effect'))
                with self.assertRaises(PowerCut):
                    task.apply()
                task.recover()
                self.assert_pair(rt, 'rollback')

    def test_original_business_racing_initial_stop_is_preserved_without_backup(self):
        task, rt = fixture()
        rt.hooks['stop'] = lambda: rt.play(pending=1)
        task.apply()
        self.assert_pair(rt, 'origin')
        self.assertEqual(rt.business['pending'], 1)
        self.assertEqual(rt.business['revision'], 1)
        self.assertNotIn('backup', rt.events)
        self.assertNotIn('migrate', rt.events)

    def test_initial_already_migrated_schema_refuses_without_stopping_or_journal(self):
        for operation in ('check', 'apply'):
            with self.subTest(operation=operation):
                task, rt = fixture()
                rt.business['schema'] = 'migrated'
                with self.assertRaisesRegex(RuntimeError, 'INITIAL_SCHEMA_NOT_OLD'):
                    getattr(task, operation)()
                self.assert_pair(rt, 'origin')
                self.assertIsNone(rt.journal)
                self.assert_no_mutations(rt.events)

    def test_empty_additive_schema_racing_initial_stop_aborts_without_recording_false_baseline(self):
        task, rt = fixture()
        rt.hooks['stop'] = lambda: rt.business.update(schema='migrated')
        result = task.apply()
        self.assertEqual(result['status'], 'aborted_original_preserved')
        self.assert_pair(rt, 'origin')
        self.assertEqual(rt.journal['phase'], 'aborted')
        self.assertNotIn('baseline', rt.journal)
        self.assertNotIn('backup', rt.journal)
        self.assertNotIn('migration', rt.journal)
        self.assertNotIn('backup', rt.events)
        self.assertNotIn('migrate', rt.events)
        self.assertEqual(rt.business, {'schema': 'migrated', 'revision': 0, 'pending': 0, 'v23': 0})
        self.assertEqual(rt.journal['completion_observation']['schema_kind'], 'migrated')

    def test_unapproved_schema_or_v23_racing_stop_cannot_use_no_backup_origin_recovery(self):
        for damage in ('unknown_schema', 'v23'):
            with self.subTest(damage=damage):
                task, rt = fixture()
                def changed():
                    rt.business['schema'] = 'unexpected-ddl' if damage == 'unknown_schema' else 'migrated'
                    if damage == 'v23':
                        rt.play(v23=True, pending=0)
                rt.hooks['stop'] = changed
                with self.assertRaises(RuntimeError):
                    task.apply()
                self.assertNotIn('baseline', rt.journal)
                self.assertNotIn('backup', rt.events)
                self.assertNotIn('migrate', rt.events)
                self.assertFalse(any(x.startswith('start:') for x in rt.events))
                self.assertFalse(rt.active)
                self.assertEqual(rt.lock_depth, 0)

    def test_business_before_recovery_does_not_stop_matching_origin_forward_or_rollback(self):
        for role in ('origin', 'forward', 'rollback'):
            with self.subTest(role=role):
                task, rt = interrupted('backed_up' if role == 'origin' else 'starting')
                rt.pair = {'pin': role, 'marker': role}
                rt.active = True
                rt.play(v23=role == 'forward')
                before = len(rt.events)
                task.recover()
                self.assert_pair(rt, role)
                self.assertNotIn('stop', rt.events[before:])
                self.assertEqual(rt.business['revision'], 1)

    def test_business_racing_recovery_stop_restarts_only_matching_role(self):
        for role in ('origin', 'forward', 'rollback'):
            with self.subTest(role=role):
                task, rt = interrupted('backed_up' if role == 'origin' else 'starting')
                rt.pair = {'pin': role, 'marker': role}
                rt.active = True
                rt.hooks['stop'] = lambda role=role: rt.play(v23=role == 'forward')
                before = len(rt.events)
                task.recover()
                self.assert_pair(rt, role)
                self.assertEqual(rt.business['revision'], 1)
                self.assertEqual([x for x in rt.events[before:] if x.startswith('start:')], ['start:' + role])
                self.assertFalse(any(x.startswith('switch_') for x in rt.events[before:]))

    def test_forward_v23_business_accepted_during_start_survives_failed_health(self):
        task, rt = fixture()
        rt.hooks['started:forward'] = lambda: rt.play(v23=True)
        rt.fail_once = 'health:forward'
        task.apply()
        self.assert_pair(rt, 'forward')
        self.assertEqual(rt.events.count('stop'), 1)
        self.assertNotIn('start:rollback', rt.events)
        self.assertEqual(rt.business['v23'], 1)

    def test_no_obligations_is_insufficient_for_v23_rollback(self):
        for role in ('origin', 'rollback'):
            with self.subTest(role=role):
                task, rt = interrupted()
                rt.pair = {'pin': role, 'marker': role}
                rt.active = True
                rt.play(v23=True, pending=0)
                before = len(rt.events)
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assertTrue(rt.active)
                self.assert_no_mutations(rt.events[before:])
                self.assertEqual(rt.business['v23'], 1)

    def test_mixed_identity_and_new_business_refuses_without_guessing_runtime(self):
        for pair in ({'pin': 'forward', 'marker': 'origin'}, {'pin': 'rollback', 'marker': 'forward'}):
            with self.subTest(pair=pair):
                task, rt = interrupted()
                rt.pair = pair
                rt.active = True
                rt.play(v23=True)
                before = len(rt.events)
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assertEqual(rt.pair, pair)
                self.assertTrue(rt.active)
                self.assert_no_mutations(rt.events[before:])

    def test_corrupt_backup_fixed_identity_or_foreign_pair_never_stops_healthy_service(self):
        for damage in ('backup', 'fixed', 'foreign_pair', 'unknown_schema'):
            with self.subTest(damage=damage):
                task, rt = interrupted()
                rt.active = True
                if damage == 'backup':
                    rt.backup_corrupt = True
                elif damage == 'fixed':
                    rt.fixed['identity'] = 'other-owner'
                elif damage == 'foreign_pair':
                    rt.pair['pin'] = 'unowned-release'
                else:
                    rt.business['schema'] = 'unexpected-ddl'
                before = len(rt.events)
                pair = copy.deepcopy(rt.pair)
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assertEqual(rt.pair, pair)
                self.assertTrue(rt.active)
                self.assert_no_mutations(rt.events[before:])

    def test_fixed_or_origin_identity_drift_after_prepared_journal_refuses_before_stop(self):
        for damage in ('fixed', 'pin', 'marker'):
            with self.subTest(damage=damage):
                task, rt = fixture()
                def drift():
                    if damage == 'fixed':
                        rt.fixed['identity'] = 'foreign-owner'
                    else:
                        rt.pair[damage] = 'unowned-release'
                rt.hooks['save_after:stopping'] = drift
                with self.assertRaises(RuntimeError):
                    task.apply()
                self.assertTrue(rt.active)
                self.assertNotIn('stop', rt.events)
                self.assertFalse(any(x.startswith(('start:', 'switch_')) for x in rt.events))
                self.assertNotIn('backup', rt.events)
                self.assertNotIn('migrate', rt.events)
                self.assertEqual(rt.journal['phase'], 'stopping')
                self.assertEqual(rt.lock_depth, 0)

    def test_recovery_identity_drift_at_rolling_back_write_refuses_before_stop(self):
        for damage in ('fixed', 'pin', 'marker'):
            with self.subTest(damage=damage):
                task, rt = interrupted()
                rt.active = True
                def drift():
                    if damage == 'fixed':
                        rt.fixed['identity'] = 'foreign-owner'
                    else:
                        rt.pair[damage] = 'unowned-release'
                rt.hooks['save_after:rolling_back'] = drift
                before = len(rt.events)
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assertTrue(rt.active)
                self.assertNotIn('stop', rt.events[before:])
                self.assertFalse(any(x.startswith(('start:', 'switch_')) for x in rt.events[before:]))
                self.assertEqual(rt.journal['phase'], 'rolling_back')
                self.assertEqual(rt.lock_depth, 0)

    def test_completed_journals_are_readback_only_even_with_new_business(self):
        for role in ('forward', 'rollback', 'origin'):
            with self.subTest(role=role):
                task, rt = fixture()
                if role != 'forward':
                    rt.fail_once = 'backup' if role == 'origin' else 'start:forward'
                task.apply()
                self.assert_pair(rt, role)
                rt.play(v23=role == 'forward')
                before = len(rt.events)
                task.recover()
                self.assert_pair(rt, role)
                self.assert_no_mutations(rt.events[before:])

    def test_missing_backup_cannot_authorize_forward_or_mixed_identity(self):
        for pair in ({'pin': 'forward', 'marker': 'forward'}, {'pin': 'forward', 'marker': 'origin'}):
            with self.subTest(pair=pair):
                task, rt = interrupted('stopped')
                rt.pair = pair
                rt.active = True
                before = len(rt.events)
                with self.assertRaises(RuntimeError):
                    task.recover()
                self.assert_no_mutations(rt.events[before:])


if __name__ == '__main__':
    unittest.main()
