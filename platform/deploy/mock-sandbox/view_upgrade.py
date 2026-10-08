#!/usr/bin/env python3
"""Upgrade the fixed Mock release views, preserving accepted business on recovery.

The controller has no shell, SQL, Nginx or database-restore implementation. Its
host adapter authenticates the fixed releases and owns every durable operation.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROLES = ('origin', 'forward', 'rollback')
PHASES = ('prepared', 'stopping', 'stopped', 'backing_up', 'backed_up',
          'migrating', 'migrated', 'switching', 'pin_switched', 'marker_switched',
          'starting', 'healthy', 'complete', 'rolling_back', 'rollback_pin_switched',
          'rollback_marker_switched', 'rollback_starting', 'rollback_healthy',
          'rolled_back', 'aborted')
TERMINAL = {'complete': 'forward', 'rolled_back': 'rollback', 'aborted': 'origin'}
RUNTIME_SHA256 = '67f6f91809f8cee2e9ef0ae8f2655e2d8b2fce0019427bcc3734aa99b7007bc8'


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


class ViewUpgrade:
    def __init__(self, runtime):
        self.runtime = runtime

    def save(self, journal, phase):
        require(phase in PHASES, 'INVALID_VIEW_PHASE')
        journal['phase'] = phase
        self.runtime.save(journal)

    def validate_journal(self, journal):
        require(isinstance(journal, dict) and journal.get('format') == 1
                and journal.get('kind') == 'mock-view-upgrade-v1'
                and journal.get('phase') in PHASES
                and isinstance(journal.get('checks'), dict), 'INVALID_VIEW_JOURNAL')

    def fixed(self, journal):
        self.runtime.verify_fixed(journal['checks'])
        self.runtime.verify_backup(journal)

    def identity(self, journal):
        pair = self.runtime.identity(journal['checks'])
        require(isinstance(pair, dict) and set(pair) == {'pin', 'marker'}
                and all(value in ROLES for value in pair.values()), 'FOREIGN_VIEW_IDENTITY')
        return pair

    def matching(self, journal, role):
        require(self.identity(journal) == {'pin': role, 'marker': role}, 'VIEW_PAIR_MISMATCH')

    def observe(self, journal):
        snapshot = self.runtime.snapshot()
        category = None
        if 'baseline' in journal:
            category = self.runtime.policy(snapshot, journal['baseline'])
            require(category in ('old', 'migrated_empty', 'new_business'), 'INVALID_VIEW_POLICY')
        return snapshot, category

    def check(self):
        with self.runtime.locked():
            return {'mode': 'check-only', 'apply_allowed': True,
                    'checks': self.runtime.check_initial()}

    def finish(self, journal, role):
        """Bring back only the matching runtime, without overwriting business."""
        self.matching(journal, role)
        self.fixed(journal)
        before, _ = self.observe(journal)
        self.runtime.allow_role(before, role)
        self.runtime.start(role, journal['checks'])
        self.runtime.health(role, journal['checks'])
        after, _ = self.observe(journal)
        self.runtime.allow_role(after, role)
        self.fixed(journal)
        self.matching(journal, role)
        journal['completion_observation'] = after
        if role == 'forward':
            self.save(journal, 'healthy')
            self.save(journal, 'complete')
            status = 'upgraded'
        elif role == 'rollback':
            self.save(journal, 'rollback_healthy')
            self.save(journal, 'rolled_back')
            status = 'rolled_back'
        else:
            self.save(journal, 'aborted')
            status = 'aborted_original_preserved'
        return {'status': status, 'role': role, 'database_restored': False,
                'business_preserved': True, 'fresh_gameplay_acceptance_required': True}

    def terminal_readback(self, journal):
        role = TERMINAL[journal['phase']]
        self.matching(journal, role)
        self.runtime.health(role, journal['checks'])
        snapshot, _ = self.observe(journal)
        self.runtime.allow_role(snapshot, role)
        self.fixed(journal)
        self.matching(journal, role)
        return {'status': 'already_' + journal['phase'], 'role': role,
                'database_restored': False, 'readback_only': True}

    def recover_locked(self):
        journal = self.runtime.load_journal()
        self.validate_journal(journal)
        # Corrupt artifacts and unknown identities must fail before stopping a
        # healthy application, even when a journal requests recovery.
        self.fixed(journal)
        pair = self.identity(journal)
        if journal['phase'] in TERMINAL:
            return self.terminal_readback(journal)
        snapshot, category = self.observe(journal)
        matching_role = pair['pin'] if pair['pin'] == pair['marker'] else None

        if 'baseline' not in journal or 'backup' not in journal:
            require(matching_role == 'origin', 'INCOMPLETE_BACKUP_AFTER_VIEW_CHANGE')
            return self.finish(journal, 'origin')

        if category == 'new_business':
            require(matching_role is not None, 'NEW_BUSINESS_WITH_MIXED_VIEW_IDENTITY')
            # Even terminal/rejected V2.3 records make old code unsuitable. The
            # adapter's allow_role gate enforces this before any start.
            return self.finish(journal, matching_role)
        if journal['phase'] == 'healthy':
            require(matching_role == 'forward', 'HEALTHY_VIEW_IDENTITY_CHANGED')
            return self.finish(journal, 'forward')
        if journal['phase'] == 'rollback_healthy':
            require(matching_role == 'rollback', 'HEALTHY_ROLLBACK_IDENTITY_CHANGED')
            return self.finish(journal, 'rollback')

        self.runtime.require_quiet(snapshot)
        self.save(journal, 'rolling_back')
        self.fixed(journal)
        require(self.identity(journal) == pair, 'VIEW_CHANGED_BEFORE_STOP')
        self.runtime.stop()
        self.fixed(journal)
        require(self.identity(journal) == pair, 'VIEW_CHANGED_DURING_STOP')
        stopped, category = self.observe(journal)
        if category == 'new_business':
            # Closing admission by stopping can race a final accepted request.
            # Restart the exact matching version instead of rolling it back.
            require(matching_role is not None, 'NEW_BUSINESS_WITH_MIXED_VIEW_IDENTITY')
            return self.finish(journal, matching_role)
        self.runtime.require_quiet(stopped)
        self.runtime.allow_role(stopped, 'rollback')
        self.runtime.switch_pin('rollback', journal['checks'])
        self.save(journal, 'rollback_pin_switched')
        self.runtime.switch_marker('rollback', journal['checks'])
        self.save(journal, 'rollback_marker_switched')
        self.save(journal, 'rollback_starting')
        return self.finish(journal, 'rollback')

    def recover(self):
        with self.runtime.locked():
            return self.recover_locked()

    def apply(self):
        with self.runtime.locked():
            checks = self.runtime.check_initial()
            journal = {'format': 1, 'kind': 'mock-view-upgrade-v1',
                       'phase': 'prepared', 'checks': checks}
            self.runtime.create_journal(journal)
            try:
                self.save(journal, 'stopping')
                self.fixed(journal)
                self.matching(journal, 'origin')
                self.runtime.stop()
                self.fixed(journal)
                self.matching(journal, 'origin')
                baseline = self.runtime.snapshot()
                self.runtime.require_quiet(baseline)
                self.runtime.allow_role(baseline, 'origin')
                require(baseline.get('schema_kind') == 'old', 'VIEW_OLD_BASELINE_REQUIRED')
                journal['baseline'] = baseline
                self.save(journal, 'stopped')
                self.save(journal, 'backing_up')
                journal['backup'] = self.runtime.backup(journal)
                self.save(journal, 'backed_up')
                self.fixed(journal)
                _, category = self.observe(journal)
                require(category == 'old', 'BUSINESS_CHANGED_BEFORE_VIEW_MIGRATION')
                self.save(journal, 'migrating')
                journal['migration'] = self.runtime.migrate(baseline)
                self.save(journal, 'migrated')
                self.fixed(journal)
                migrated, category = self.observe(journal)
                require(category == 'migrated_empty', 'BUSINESS_CHANGED_AFTER_VIEW_MIGRATION')
                self.runtime.require_quiet(migrated)
                self.save(journal, 'switching')
                self.runtime.switch_pin('forward', checks)
                self.save(journal, 'pin_switched')
                self.runtime.switch_marker('forward', checks)
                self.save(journal, 'marker_switched')
                self.save(journal, 'starting')
                return self.finish(journal, 'forward')
            except Exception:
                # The persisted journal, never the potentially advanced local
                # object, is authoritative after a failed durable write.
                return self.recover_locked()


def load_runtime():
    path = Path(__file__).with_name('view_runtime.py')
    require(not path.is_symlink() and path.is_file(), 'VIEW_RUNTIME_MISSING')
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == RUNTIME_SHA256, 'VIEW_RUNTIME_NOT_FROZEN')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('mock_view_runtime', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module.ViewRuntime()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', default='check-only', choices=('check-only', 'apply', 'recover'))
    args = parser.parse_args()
    try:
        controller = ViewUpgrade(load_runtime())
        result = {'check-only': controller.check, 'apply': controller.apply,
                  'recover': controller.recover}[args.mode]()
    except Exception:
        print(json.dumps({'status': 'refused', 'mode': args.mode,
                          'detail': 'Inspect the retained private journal and validated operator evidence.'}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
