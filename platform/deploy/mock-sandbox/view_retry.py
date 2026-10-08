#!/usr/bin/env python3
"""One forward retry of the fixed, completed Mock17 rollback; no DDL or backup.

Original tools and their journal bindings remain immutable. Startup observation
is bounded; it never restarts a service or accepts a weaker process identity.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import sys
import time
import types

HERE = Path(__file__).resolve().parent
CONTROLLER_SHA = 'a37081bbe10bc1a60bc51a34e70d2c33d6e8f8f7872ec567476abf683a81547d'
RUNTIME_SHA = '67f6f91809f8cee2e9ef0ae8f2655e2d8b2fce0019427bcc3734aa99b7007bc8'
# Exact frozen source: return self._processes(role, checks) after runtime.start().
POST_START_OBSERVATION_LINE = 568
PROCESS_CODES = frozenset(('VIEW_APPLICATION_NOT_ACTIVE', 'VIEW_MAIN_PID_INVALID',
    'VIEW_PROCESS_IDENTITY_CHANGED', 'VIEW_PROCESS_RELEASE_MISMATCH', 'VIEW_PROCESS_UID_MISMATCH',
    'VIEW_PROCESS_COMMAND_MISMATCH', 'VIEW_PROCESS_EXECUTABLE_MISMATCH', 'VIEW_PROCESS_CGROUP_MISMATCH'))
MAX_OBSERVATIONS = 8
WAIT_SECONDS = 10


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def tool_bytes(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
            and not info.st_mode & 0o022 and info.st_size <= 16 * 1024 ** 2, 'RETRY_UNSAFE_TOOL')
    return path.read_bytes()


def load_controller():
    raw = {name: tool_bytes(HERE / name) for name in ('view_upgrade.py', 'view_runtime.py')}
    require(sha(raw['view_upgrade.py']) == CONTROLLER_SHA and sha(raw['view_runtime.py']) == RUNTIME_SHA,
            'RETRY_FROZEN_TOOL_CHANGED')
    module = types.ModuleType('mock_view_retry_controller')
    module.__file__ = str(HERE / 'view_upgrade.py')
    exec(compile(raw['view_upgrade.py'], module.__file__, 'exec'), module.__dict__)
    return module, module.load_runtime()


class ReadinessDeadline(RuntimeError):
    pass


@contextmanager
def read_deadline(seconds):
    # Dedicated CLI/main-thread use only. Cancel only our read-only probe's CLI
    # wait, never a service. Do not steal an existing application's alarm.
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'RETRY_EXISTING_ALARM')
    old = signal.getsignal(signal.SIGALRM)
    def expired(_signal, _frame):
        raise ReadinessDeadline('RETRY_STARTUP_READINESS_TIMEOUT')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def post_start_process_error(error):
    code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    if code not in PROCESS_CODES and not isinstance(error, FileNotFoundError):
        return False
    cursor = error.__traceback__
    while cursor:
        frame = cursor.tb_frame
        if (Path(frame.f_code.co_filename).name == 'view_runtime.py'
                and frame.f_code.co_name == 'start' and cursor.tb_lineno == POST_START_OBSERVATION_LINE):
            return True
        cursor = cursor.tb_next
    return False


def process_observation(runtime):
    """Post-error observation, not a reconstruction of the lost failing read."""
    result = {}
    allowed_arguments = {'/usr/bin/node', '--import', 'tsx', 'server/index.mjs', 'deploy/demo-host.mjs'}
    for unit in runtime.upgrade.APP_UNITS:
        value = {'observed_after_error': True}
        try:
            raw = runtime.runtime.run(['systemctl', 'show', unit, '--property=MainPID', '--value']).decode().strip()
            require(raw.isdigit(), 'RETRY_PID_UNAVAILABLE')
            pid = int(raw)
            value['pid'] = pid
            if pid > 1:
                process = Path('/proc') / str(pid)
                cwd = os.readlink(process / 'cwd')
                value['cwd'] = cwd if cwd == '/' or cwd.startswith('/opt/oasis/') else '<outside-known-root>'
                argv = (process / 'cmdline').read_bytes()[:4096].rstrip(b'\0').decode(errors='replace').split('\0')
                value['argv'] = [arg if arg in allowed_arguments else '<redacted>' for arg in argv[:8]]
        except ReadinessDeadline:
            raise
        except Exception:
            value['read_error'] = 'PROCESS_OBSERVATION_UNAVAILABLE'
        result[unit] = value
    return result


class StartupReadiness:
    def __init__(self, runtime, owner, *, clock=time.monotonic, sleep=time.sleep,
                 observer=process_observation):
        self.original, self.owner = runtime, owner
        self.clock, self.sleep, self.observer = clock, sleep, observer

    def __getattr__(self, name):
        return getattr(self.original, name)

    def load_journal(self):
        journal = self.original.load_journal()
        self.owner.bind(journal, required=True)
        return journal

    def start(self, role, checks):
        require(len(self.owner.journal['retry']['startup_observations']) < MAX_OBSERVATIONS, 'RETRY_OBSERVATION_CAPACITY')
        try:
            return self.original.start(role, checks)  # Exactly one invocation.
        except Exception as error:
            if not post_start_process_error(error):
                raise
            code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        record = {'role': role, 'original_error': code, 'strict_pass': False,
                  'observation_semantics': 'read_after_error_not_original_failing_sample'}
        self.owner.journal['retry']['startup_observations'].append(record)
        # Persist the original code before further probes; no phase/tool change.
        self.original.save(self.owner.journal)
        start = self.clock()
        last_error = code
        try:
            with read_deadline(WAIT_SECONDS):
                record['first_observation'] = self.observer(self.original)
                while self.clock() - start < WAIT_SECONDS:
                    try:
                        answer = self.original._processes(role, checks)
                        record['strict_pass'] = True
                        record['final_observation'] = self.observer(self.original)
                        return answer
                    except ReadinessDeadline:
                        raise
                    except Exception as error:
                        last_error = str(error) if isinstance(error, RuntimeError) else type(error).__name__
                        if last_error not in PROCESS_CODES and not isinstance(error, FileNotFoundError):
                            raise
                    self.sleep(min(0.1, max(0, WAIT_SECONDS - (self.clock() - start))))
                raise ReadinessDeadline('RETRY_STARTUP_READINESS_TIMEOUT')
        finally:
            record['elapsed_ms'] = round((self.clock() - start) * 1000, 3)
            record['last_error'] = last_error
            self.original.save(self.owner.journal)


class ViewRetry:
    def __init__(self, runtime, controller_module, **readiness_options):
        self.runtime = runtime
        self.tool_sha = sha(tool_bytes(Path(__file__)))
        self.journal = None
        self.adapter = StartupReadiness(runtime, self, **readiness_options)
        self.controller = controller_module.ViewUpgrade(self.adapter)

    def bind(self, journal, *, required):
        self.controller.validate_journal(journal)
        retry = journal.get('retry')
        if retry is None:
            require(not required, 'RETRY_JOURNAL_BINDING_MISSING')
        else:
            require(isinstance(retry, dict) and retry.get('format') == 1
                    and retry.get('kind') == 'mock-view-forward-retry-v1' and retry.get('attempt') == 1
                    and retry.get('tool_sha256') == self.tool_sha and retry.get('controller_sha256') == CONTROLLER_SHA
                    and retry.get('runtime_sha256') == RUNTIME_SHA and isinstance(retry.get('startup_observations'), list)
                    and len(retry['startup_observations']) <= MAX_OBSERVATIONS, 'RETRY_JOURNAL_BINDING_CHANGED')
        self.journal = journal
        return journal

    def empty_guard(self, journal, pair):
        self.controller.fixed(journal)
        require(self.controller.identity(journal) == pair, 'RETRY_IDENTITY_CHANGED')
        snapshot, category = self.controller.observe(journal)
        require(category == 'migrated_empty' and snapshot.get('schema_kind') == 'migrated', 'RETRY_NEW_BUSINESS_OR_SCHEMA')
        self.runtime.require_quiet(snapshot)
        return snapshot

    def initial(self):
        journal = self.bind(self.runtime.load_journal(), required=False)
        require('retry' not in journal, 'RETRY_ALREADY_USED')
        require(journal['phase'] == 'rolled_back' and 'baseline' in journal and 'backup' in journal, 'RETRY_COMPLETED_ROLLBACK_REQUIRED')
        pair = {'pin': 'rollback', 'marker': 'rollback'}
        self.empty_guard(journal, pair)
        self.runtime.health('rollback', journal['checks'])
        self.empty_guard(journal, pair)
        return journal

    def check(self):
        with self.runtime.locked():
            self.initial()
            return {'status': 'eligible', 'mode': 'check-only', 'retry_used': False, 'mutations': False}

    def recover(self):
        with self.runtime.locked():
            self.bind(self.runtime.load_journal(), required=True)
            return self.controller.recover_locked()

    def apply(self):
        with self.runtime.locked():
            journal = self.initial()
            journal['retry'] = {'format': 1, 'kind': 'mock-view-forward-retry-v1', 'attempt': 1,
                'tool_sha256': self.tool_sha, 'controller_sha256': CONTROLLER_SHA, 'runtime_sha256': RUNTIME_SHA,
                'startup_observations': []}
            self.controller.save(journal, 'stopping')  # The once-only claim is durable first.
            try:
                rollback = {'pin': 'rollback', 'marker': 'rollback'}
                self.empty_guard(journal, rollback)
                self.runtime.stop()
                self.empty_guard(journal, rollback)
                self.controller.save(journal, 'switching')
                self.empty_guard(journal, rollback)
                self.runtime.switch_pin('forward', journal['checks'])
                self.controller.save(journal, 'pin_switched')
                self.empty_guard(journal, {'pin': 'forward', 'marker': 'rollback'})
                self.runtime.switch_marker('forward', journal['checks'])
                self.controller.save(journal, 'marker_switched')
                self.empty_guard(journal, {'pin': 'forward', 'marker': 'forward'})
                self.controller.save(journal, 'starting')
                return self.controller.finish(journal, 'forward')
            except Exception:
                # Always reload the durable phase, including an interrupted save.
                return self.controller.recover_locked()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', default='check-only', choices=('check-only', 'apply', 'recover'))
    args = parser.parse_args()
    try:
        sys.dont_write_bytecode = True
        module, runtime = load_controller()
        retry = ViewRetry(runtime, module)
        result = {'check-only': retry.check, 'apply': retry.apply, 'recover': retry.recover}[args.mode]()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({'status': 'refused', 'mode': args.mode, 'code': code}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
