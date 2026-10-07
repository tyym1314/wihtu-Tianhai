#!/usr/bin/env python3
"""Repair only the never-started 20261007-03 mock stack with 20261007-04 tooling."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path

specification = importlib.util.spec_from_file_location('mock_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(specification)
specification.loader.exec_module(installer)

OLD = installer.BASE / 'releases/20261007-03'
NEW = installer.BASE / 'releases/20261007-04'
KIND = 'unstarted-internal-db-socket-proxy-v1'
JOURNAL = installer.PRIVATE / 'repair-socket-proxy-20261007.json'
ALLOWED_CHANGES = {'platform/deploy/mock-sandbox/' + name for name in ('install.py', 'test_install.py', 'README.md', 'repair_unstarted.py', 'test_repair_unstarted.py')}
SECRET_FILES = ('runtime.env', 'database.json', 'postgres.env', 'network.nft', 'state/master.key', 'state/hosted-demo-guest.key')


def manifest_entries(release):
    value = json.loads((release / 'RELEASE-MANIFEST.json').read_text())
    return value.get('files', value)


def verify_releases():
    _, old_hash = installer.release_check(str(OLD))
    _, new_hash = installer.release_check(str(NEW))
    old, new = manifest_entries(OLD), manifest_entries(NEW)
    changed = {name for name in old.keys() | new.keys() if old.get(name) != new.get(name)}
    installer.require(changed <= ALLOWED_CHANGES and not old.keys() - new.keys(), 'REPAIR_NON_TOOLING_CHANGE')
    installer.require('platform/deploy/mock-sandbox/install.py' in changed and 'platform/deploy/mock-sandbox/repair_unstarted.py' in new, 'REPAIR_TOOLING_MISSING')
    return old_hash, new_hash


def private_snapshot():
    result = {}
    for relative in SECRET_FILES:
        path = installer.PRIVATE / relative
        installer.require(path.is_file() and not path.is_symlink(), 'REPAIR_PRIVATE_FILE_MISSING')
        info = path.stat()
        installer.require(info.st_mode & 0o077 == 0, 'REPAIR_PRIVATE_FILE_PERMISSIONS')
        result[relative] = {'sha256': installer.digest(path), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': info.st_mode & 0o777}
    return result


def verify_unstarted(state):
    installer.database_guard(state)
    database = installer.inspect('container', installer.CONTAINER)
    installer.require(database['State']['Running'], 'REPAIR_DATABASE_NOT_RUNNING')
    installer.require(database['NetworkSettings']['Networks'][installer.NETWORK]['IPAddress'] == state['postgres_address'], 'MOCK_DATABASE_ADDRESS_CHANGED')
    installer.require(installer.pwd.getpwnam(installer.USER).pw_uid == state['uid'], 'MOCK_UID_CHANGED')
    installer.require(state.get('network_fingerprint') == installer.network_fingerprint(), 'NETWORK_POLICY_DRIFT')
    for name in installer.UNITS[:2]:
        installer.require(installer.output(['systemctl', 'is-active', name], check=False) == 'inactive', 'REPAIR_API_ALREADY_RUNNING')
        installer.require(installer.output(['systemctl', 'is-enabled', name], check=False) == 'disabled', 'REPAIR_API_ENABLED')
        for field in ('ExecMainStartTimestampMonotonic', 'MainPID'):
            installer.require(installer.output(['systemctl', 'show', name, '--property=' + field, '--value']) == '0', 'REPAIR_API_PREVIOUSLY_STARTED')
    for unit in (installer.PROXY_UNIT + '.socket', installer.PROXY_UNIT + '.service'):
        installer.require(installer.output(['systemctl', 'is-active', unit], check=False) in ('inactive', 'unknown'), 'REPAIR_PROXY_ALREADY_RUNNING')
    for port in installer.PORTS:
        installer.require(not installer.output(['ss', '-H', '-ltn', 'sport = :' + str(port)]), 'REPAIR_PORT_ALREADY_LISTENING')
    installer.require(not installer.TLS_CONF.exists() and not installer.TLS_CONF.is_symlink(), 'REPAIR_HTTPS_ALREADY_PUBLISHED')
    count = installer.database_sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','S','f');")
    installer.require(count == '0', 'REPAIR_DATABASE_NOT_EMPTY')


def target_state(original, old_hash, new_hash, status):
    return {**original, 'release': str(NEW), 'manifest_sha256': new_hash, 'tooling_repair': {'kind': KIND, 'from': str(OLD), 'from_manifest_sha256': old_hash, 'to': str(NEW), 'to_manifest_sha256': new_hash, 'status': status}}


def load_journal():
    installer.require(JOURNAL.is_file() and not JOURNAL.is_symlink(), 'REPAIR_JOURNAL_INVALID')
    info = JOURNAL.stat()
    installer.require(info.st_uid == 0 and info.st_mode & 0o777 == 0o600, 'REPAIR_JOURNAL_PERMISSIONS')
    return json.loads(JOURNAL.read_text())


def verify_proxy_destinations(state, resuming):
    for path, expected in installer.proxy_unit_files(state).items():
        installer.require(not path.is_symlink(), 'REPAIR_PROXY_PATH_CONFLICT')
        if path.exists():
            installer.require(resuming and path.is_file() and path.read_text() == expected and path.stat().st_uid == 0 and path.stat().st_mode & 0o777 == 0o644, 'REPAIR_PROXY_PATH_CONFLICT')
    directory = installer.proxy_unit_paths()[2]
    installer.require(not directory.is_symlink(), 'REPAIR_PROXY_PATH_CONFLICT')
    if directory.exists():
        installer.require(resuming and directory.is_dir() and directory.stat().st_uid == 0 and {path.name for path in directory.iterdir()} <= {'10-database-proxy.conf'}, 'REPAIR_PROXY_PATH_CONFLICT')


def repair(*, apply=False):
    old_hash, new_hash = verify_releases()
    installer.proxy_binary_guard()
    current = installer.load()
    installer.require(installer.PIN.is_symlink() and installer.PIN.lstat().st_uid == 0, 'REPAIR_PIN_INVALID')
    pin = installer.PIN.resolve(strict=True)
    if JOURNAL.exists() or JOURNAL.is_symlink():
        journal = load_journal()
        original = journal.get('original_state', {})
        installer.require(journal.get('kind') == KIND and journal.get('old_hash') == old_hash and journal.get('new_hash') == new_hash, 'REPAIR_JOURNAL_INVALID')
        installer.require(original.get('release') == str(OLD) and original.get('manifest_sha256') == old_hash and 'tooling_repair' not in original, 'REPAIR_ORIGINAL_STATE_INVALID')
        pending = target_state(original, old_hash, new_hash, 'pending_reload')
        completed = target_state(original, old_hash, new_hash, 'complete')
        installer.require(current in (original, pending, completed) and pin in (OLD, NEW), 'REPAIR_STATE_CHANGED')
        installer.require(private_snapshot() == journal.get('private_snapshot'), 'REPAIR_PRIVATE_STATE_CHANGED')
        if current == completed:
            installer.require(pin == NEW, 'REPAIR_PIN_INVALID')
            installer.proxy_files_guard(current)
            print('MOCK_REPAIR_ALREADY_COMPLETE: no changes made')
            return
    else:
        installer.require(current.get('release') == str(OLD) and current.get('manifest_sha256') == old_hash and pin == OLD and 'tooling_repair' not in current, 'REPAIR_ONLY_UNSTARTED_03_TO_04')
        original = current
        journal = {'kind': KIND, 'old_hash': old_hash, 'new_hash': new_hash, 'original_state': original, 'private_snapshot': private_snapshot()}
    verify_unstarted(original)
    verify_proxy_destinations(original, JOURNAL.exists())
    if not apply:
        print('MOCK_REPAIR_CHECK_OK: exact unstarted 03-to-04 tooling upgrade; no services will start')
        return
    installer.exact_file(JOURNAL, json.dumps(journal, indent=2) + '\n', 0o600)
    installer.install_proxy_units(original)
    temporary = installer.PRIVATE / '.repair-socket-proxy-current'
    if temporary.is_symlink():
        installer.require(temporary.lstat().st_uid == 0 and temporary.resolve(strict=True) == NEW, 'REPAIR_TEMPORARY_PIN_EXISTS')
    else:
        installer.require(not temporary.exists(), 'REPAIR_TEMPORARY_PIN_EXISTS')
        temporary.symlink_to(NEW)
    os.replace(temporary, installer.PIN)
    installer.save(target_state(original, old_hash, new_hash, 'pending_reload'))
    installer.run(['systemctl', 'daemon-reload'])
    verify_unstarted(original)
    installer.require(private_snapshot() == journal['private_snapshot'], 'REPAIR_PRIVATE_STATE_CHANGED')
    installer.proxy_files_guard(original)
    installer.save(target_state(original, old_hash, new_hash, 'complete'))
    print('MOCK_REPAIR_COMPLETE: pin 20261007-04; keys, runtime configuration, database volume and certificate retained; API/demo remain stopped')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('check', 'apply'))
    arguments = parser.parse_args()
    installer.require(os.geteuid() == 0, 'ROOT_REQUIRED')
    installer.require(Path(__file__).resolve() == NEW / 'platform/deploy/mock-sandbox/repair_unstarted.py', 'REPAIR_RUN_FROM_EXACT_NEW_RELEASE')
    os.umask(0o077)
    with open('/run/lock/oasis-android-mock-install.lock', 'a') as install_lock, open('/run/lock/oasis-android-mock-network.lock', 'a') as network_lock:
        fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(network_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        repair(apply=arguments.stage == 'apply')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error) if isinstance(error, RuntimeError) else 'MOCK_REPAIR_FAILED: ' + type(error).__name__)
