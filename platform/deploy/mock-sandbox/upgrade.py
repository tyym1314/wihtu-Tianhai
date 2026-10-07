#!/usr/bin/env python3
"""Exact, fail-closed upgrade of the running Mock 20261007-04 to 20261008-05.

Default: read-only checks. No provisioning, database restore, automatic settlement,
Nginx change, global static-store fallback or APK modification is supported.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import stat
import subprocess
import tarfile
import time
import urllib.request
import uuid

DEPENDENCY = Path(__file__).with_name('install.py')
_spec = importlib.util.spec_from_file_location('mock_upgrade_install', DEPENDENCY)
installer = importlib.util.module_from_spec(_spec)
exec(compile(DEPENDENCY.read_bytes(), str(DEPENDENCY), 'exec'), installer.__dict__)

OLD_NAME, NEW_NAME = '20261007-04', '20261008-05'
NEW_MANIFEST = 'b5ae243cf9860cd8323783422459811ff3efb13ff41ba3342084f9ae50ca78db'
REVIEWED_PVP = ('163bcbd3aed9f1fd937d3d636160a90170aa3c226db74ad8a29347e279b2d038',
                '9fd86a28ad86d765014fa4422ba7f36a9b73f48c1ccd8e9c21a84a0d2d23b10b')
RECEIPT_SHA = '594e46943f32cf1db9a14c092be2a5f192630a5f3c50ea14a36429287b28932c'
RESERVE = 3 * 1024 ** 3
PRIVATE_FILES = ('runtime.env', 'database.json', 'postgres.env', 'network.nft',
                 'state/master.key', 'state/hosted-demo-guest.key')
APP_UNITS = ('oasis-android-mock-api', 'oasis-android-mock-demo')
INFRA_UNITS = ('oasis-android-mock-db', 'oasis-android-mock-network',
               'oasis-android-mock-db-proxy.socket', 'oasis-android-mock-db-proxy.service')
STATIC = ('platform/dist/', 'platform/arena/dist/', 'platform/legacy/dist/',
          'platform/public/', 'platform/specs/examples/partner-host/public/')
UI_MODULES = {'platform/' + name for name in (
    'arena/run/atlas-characters.mjs', 'arena/run/characters.mjs', 'arena/run/frame-trace.mjs',
    'arena/run/input-presentation.mjs', 'arena/run/presentation.mjs', 'arena/run/scene.mjs',
    'arena/shared/client.mjs', 'arena/shared/room-poller.mjs')}
BUSINESS_TABLES = ('gp_apps', 'gp_keys', 'gp_sessions', 'gp_cycles', 'gp_operations', 'gp_plays',
                   'gp_migrations', 'pvp_rooms', 'pvp_actions', 'pvp_requests', 'pvp_operations',
                   'wallet_scopes', 'wallet_keys', 'wallet_users', 'wallet_ledger', 'wallet_operations',
                   'wallet_matches', 'wallet_reservations', 'wallet_probability', 'wallet_operation_ids')
PHASES = ('prepared', 'stopping', 'stopped', 'backing_up', 'backed_up', 'switching',
          'pin_switched', 'marker_switched', 'starting', 'healthy', 'complete', 'rolling_back', 'rollback_healthy', 'rolled_back')
INTEGRITY_COUNTS = ('balance_mismatches', 'scope_mismatches', 'unbalanced_transactions',
                    'ledger_version_mismatches', 'orphan_records', 'invalid_constraints')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(path):
    return installer.digest(path)


def available(path):
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def regular(path, private=False):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'UNSAFE_FILE')
    if private:
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600, 'UNSAFE_PRIVATE_FILE')
    return info


def owned_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'UNSAFE_PRIVATE_DIRECTORY')


def mock_private_directory(path):
    # provision() gives the confined Mock account traversal to its own state;
    # it never grants that group write access to this root or the root-only files.
    info = path.lstat()
    account = installer.pwd.getpwnam(installer.USER)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_gid == account.pw_gid and stat.S_IMODE(info.st_mode) == 0o750,
            'UNSAFE_MOCK_PRIVATE_DIRECTORY')


def no_link_components(root, path):
    require(path.is_relative_to(root), 'PATH_OUTSIDE_ROOT')
    for item in (path, *path.parents):
        require(not item.is_symlink(), 'UNSAFE_PATH_COMPONENT')
        if item == root:
            break


def write_bytes(path, value, parent_checker=owned_directory):
    """Atomic and durable; abandoned unique temporary files remain for inspection."""
    parent_checker(path.parent)
    if path.exists() or path.is_symlink():
        regular(path, True)
    temporary = path.parent / ('.' + path.name + '-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    sync_dir(path.parent)


def write_json(path, value, parent_checker=owned_directory):
    write_bytes(path, (json.dumps(value, sort_keys=True, indent=2) + '\n').encode(), parent_checker)


def manifest(root):
    regular(root / 'RELEASE-MANIFEST.json')
    require(root.resolve(strict=True) == root and root.is_dir(), 'IMMUTABLE_RELEASE_REQUIRED')
    data = json.loads((root / 'RELEASE-MANIFEST.json').read_text())
    data = data.get('files', data)
    require(isinstance(data, dict) and len(data) > 10, 'INVALID_RELEASE_MANIFEST')
    for name, expected in data.items():
        rel = PurePosixPath(name)
        require(not rel.is_absolute() and '..' not in rel.parts and rel.as_posix() == name
                and re.fullmatch(r'[a-f0-9]{64}', str(expected)), 'UNSAFE_RELEASE_MANIFEST')
        path = root / name
        no_link_components(root, path)
        require(path.resolve(strict=True).is_relative_to(root), 'UNSAFE_RELEASE_PATH')
        regular(path)
        require(digest(path) == expected, 'RELEASE_HASH_MISMATCH')
    for dependency in ('tsx', 'pg'):
        require((root / 'platform/node_modules' / dependency / 'package.json').is_file(), 'DEPENDENCY_MISSING')
    return data


def compatible(old, new):
    pvp, receipt = 'platform/server/pvp/index.mjs', 'platform/shared/run-action-receipt.mjs'
    require((old.get(pvp), new.get(pvp)) == REVIEWED_PVP, 'UNREVIEWED_PVP_CHANGE')
    require(receipt not in old and new.get(receipt) == RECEIPT_SHA, 'UNREVIEWED_RECEIPT_CHANGE')
    def critical(name):
        return (name.startswith(('platform/server/', 'platform/shared/', 'src/', 'platform/deploy/mock-sandbox/'))
                or name in ('package.json', 'package-lock.json', 'platform/package.json', 'platform/package-lock.json',
                            'platform/deploy/restore-drill.mjs', 'platform/deploy/demo-host.mjs')
                or name.startswith('platform/arena/') and name.endswith(('.mjs', '.json'))
                or name.startswith('platform/specs/') and name.endswith('.json'))
    checked = 0
    for name in old.keys() | new.keys():
        if critical(name) and name not in UI_MODULES and name not in (pvp, receipt):
            require(old.get(name) == new.get(name), 'SCHEMA_ENGINE_OR_DEPENDENCY_CHANGED')
            checked += 1
    require(all(name in old and name in new for name in ('platform/server/schema.sql', 'platform/server/pvp/schema.sql',
            'platform/server/wallet/schema.sql', 'platform/server/index.mjs', 'platform/package-lock.json',
            'platform/deploy/mock-sandbox/install.py', 'platform/deploy/restore-drill.mjs')), 'COMPATIBILITY_INPUT_MISSING')
    return {'identical_critical_files': checked, 'reviewed_exception': 'exact Run POST receipt source hashes; no schema change'}


def dependencies(root):
    """Compare installed bytes, executable modes and internal link targets, not just npm declarations."""
    folder = root / 'platform/node_modules'
    no_link_components(root, folder)
    require(folder.is_dir(), 'DEPENDENCY_MISSING')
    entries = {}
    for path in sorted(folder.rglob('*')):
        info = path.lstat()
        name = path.relative_to(folder).as_posix()
        if stat.S_ISLNK(info.st_mode):
            require(path.resolve(strict=True).is_relative_to(folder), 'UNSAFE_DEPENDENCY_LINK')
            entries[name] = ['link', os.readlink(path)]
        elif stat.S_ISDIR(info.st_mode):
            entries[name] = ['directory', stat.S_IMODE(info.st_mode)]
        else:
            regular(path)
            entries[name] = ['file', stat.S_IMODE(info.st_mode), digest(path)]
    require(entries, 'DEPENDENCY_MISSING')
    return {'entries': len(entries), 'sha256': hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()}


def static_assets(root):
    # Include unhashed GLB dependencies, art, fonts and media as well as chunks.
    # HTML is an entry document, not an immutable dependency. Conservative byte
    # equality may refuse harmless media changes; it must never assume them safe.
    values = {}
    for prefix in STATIC:
        folder = root / prefix
        require(not folder.is_symlink(), 'UNSAFE_STATIC_DIRECTORY')
        if not folder.exists():
            continue
        for path in folder.rglob('*'):
            require(not path.is_symlink(), 'UNSAFE_STATIC_LINK')
            if path.is_file() and path.suffix.lower() != '.html':
                regular(path)
                values[path.relative_to(root).as_posix()] = digest(path)
    return values


def coverage(source, target):
    missing, changed = [], []
    for name, expected in source.items():
        if name not in target:
            missing.append(name)
        elif target[name] != expected:
            changed.append(name)
    return {'checked': len(source), 'missing': sorted(missing), 'changed': sorted(changed),
            'compatible': not missing and not changed}


class Runtime:
    """All commands have fixed Mock names; subprocess output is never echoed."""
    def run(self, args, **kwargs):
        try:
            result = subprocess.run(args, capture_output=True, check=False, timeout=60, **kwargs)
        except (OSError, subprocess.TimeoutExpired):
            raise RuntimeError('MOCK_COMMAND_FAILED') from None
        require(result.returncode == 0, 'MOCK_COMMAND_FAILED')
        return result.stdout

    def sql(self, sql):
        return self.run(['docker', 'exec', '-i', installer.CONTAINER, 'psql', '-X', '-qAt',
                         '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'oasis_android_mock'],
                        input=sql.encode()).decode().strip()

    def services(self):
        return {name: self.run(['systemctl', 'show', name, '--property=ActiveState', '--value']).decode().strip()
                for name in (*APP_UNITS, *INFRA_UNITS)}

    def guard(self, state):
        installer.guard(state)
        return self.resources(state)

    def resources(self, state):
        installer.database_guard(state)
        states = self.services()
        require(all(states[name] == 'active' for name in INFRA_UNITS), 'MOCK_INFRA_NOT_ACTIVE')
        container = installer.inspect('container', installer.CONTAINER)
        require(container['State']['Running'], 'MOCK_DATABASE_NOT_RUNNING')
        require(container['NetworkSettings']['Networks'][installer.NETWORK]['IPAddress'] == state['postgres_address']
                and installer.pwd.getpwnam(installer.USER).pw_uid == state['uid']
                and installer.network_fingerprint() == state['network_fingerprint'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
        installer.proxy_files_guard(state)
        # Never start a drifted unit or silently rely on a different static route.
        templates = Path(state['release']) / 'platform/deploy/mock-sandbox'
        config_hashes = {}
        for name, unit in zip(('api', 'demo'), APP_UNITS):
            path = Path('/etc/systemd/system') / (unit + '.service')
            info = regular(path)
            require(info.st_uid == 0 and not info.st_mode & 0o022
                    and path.read_bytes() == (templates / ('mock-' + name + '.service.example')).read_bytes(), 'MOCK_APPLICATION_UNIT_CHANGED')
            require(self.run(['systemctl', 'show', unit, '--property=FragmentPath', '--value']).decode().strip() == str(path), 'MOCK_APPLICATION_UNIT_CHANGED')
            expected_dropins = sorted(str(p) for p in installer.proxy_unit_files(state)
                                      if p.parent == Path(str(path) + '.d'))
            actual_dropins = self.run(['systemctl', 'show', unit, '--property=DropInPaths', '--value']).decode().split()
            require(sorted(actual_dropins) == expected_dropins, 'MOCK_APPLICATION_DROPINS_CHANGED')
            config_hashes[unit] = digest(path)
        config = installer.TLS_CONF
        info = regular(config)
        expected = (templates / 'mock.nginx.conf.example').read_text().replace('mock-game.example.invalid', installer.HOST).replace('/live/ANDROID_MOCK/', '/live/oasis-android-mock/')
        require(info.st_uid == 0 and not info.st_mode & 0o022 and config.read_text() == expected, 'MOCK_NGINX_ROUTE_CHANGED')
        config_hashes['nginx'] = digest(config)
        return {'container_id': container['Id'], 'volume': installer.VOLUME, 'configuration_sha256': config_hashes,
                'postgres_image': state['postgres_image'], 'address': state['postgres_address'],
                'uid': state['uid'], 'network_fingerprint': state['network_fingerprint']}

    def preflight(self, release):
        self.run(['node', str(release / 'platform/deploy/mock-sandbox/preflight.mjs'),
                  '--mock-env', str(installer.PRIVATE / 'runtime.env'), '--live-env', str(installer.LIVE_ENV)])

    def inspect_business(self, release):
        text = (release / 'platform/deploy/restore-drill.mjs').read_text()
        match = re.search(r'export const RESTORE_AUDIT_SQL=`(.*?)`;', text, re.S)
        require(match is not None, 'RESTORE_AUDIT_SQL_MISSING')
        pending_sql = """SELECT json_build_object(
          'presentations',(SELECT count(*) FROM gp_sessions s LEFT JOIN gp_cycles c ON c.id=s.state->>'cycleId'
            WHERE s.state->>'pendingPlay' IS NOT NULL OR COALESCE((s.state->>'nextIndex')::int,0)<COALESCE(jsonb_array_length(c.result->'rounds'),0)),
          'integration_checks',(SELECT count(*) FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING')),
          'reservations',(SELECT count(*) FROM wallet_reservations WHERE state='RESERVED'),
          'wallet_matches',(SELECT count(*) FROM wallet_matches WHERE state NOT IN ('SETTLED','VOIDED','CANCELLED')),
          'wallet_probability',(SELECT count(*) FROM wallet_probability WHERE state NOT IN ('SETTLED','CANCELLED','EXPIRED')),
          'reserved_balances',(SELECT count(*) FROM wallet_users WHERE reserved<>0 OR credit_pending<>0));"""
        statements = [match[1], pending_sql]
        for table in BUSINESS_TABLES:
            statements.append("SELECT json_build_object('rows',count(*),'sha256',encode(sha256(convert_to(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text),''),'UTF8')),'hex')) FROM (SELECT to_jsonb(t) row FROM " + table + ' t) stable;')
        statements.append("SELECT encode(sha256(convert_to(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text),''),'UTF8')),'hex') FROM (SELECT to_jsonb(c) row FROM information_schema.columns c WHERE table_schema='public' UNION ALL SELECT to_jsonb(i) FROM pg_indexes i WHERE schemaname='public') definition;")
        # One consistent, read-only snapshot. This does not settle or expire anything.
        lines = self.sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='45s';\n"
                         + '\n'.join(statements) + '\nROLLBACK;').splitlines()
        require(len(lines) == 3 + len(BUSINESS_TABLES), 'INVALID_BUSINESS_SNAPSHOT')
        audit, pending = json.loads(lines[0]), json.loads(lines[1])
        require(isinstance(audit, dict) and len(audit) >= 11, 'INVALID_LEDGER_AUDIT')
        rows = {table: json.loads(line) for table, line in zip(BUSINESS_TABLES, lines[2:-1])}
        schema = lines[-1]
        require(re.fullmatch(r'[a-f0-9]{64}', schema), 'INVALID_SCHEMA_FINGERPRINT')
        return {'audit': audit, 'pending': pending, 'tables': rows, 'schema_sha256': schema}

    def database_size(self):
        return int(self.sql('SELECT pg_database_size(current_database());'))

    def stop(self):
        self.run(['systemctl', 'stop', APP_UNITS[1], APP_UNITS[0]])
        require(all(self.services()[name] == 'inactive' for name in APP_UNITS), 'MOCK_APPS_NOT_STOPPED')

    def start(self):
        self.run(['systemctl', 'start', APP_UNITS[0], APP_UNITS[1]])

    def health(self):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for attempt in range(15):
            try:
                with opener.open('http://127.0.0.1:18981/health/ready', timeout=2) as response:
                    data = json.load(response)
                    require(response.status == 200 and data.get('status') == 'ok' and data.get('environment') == 'sandbox', 'MOCK_HEALTH_FAILED')
                request = urllib.request.Request('http://127.0.0.1:18985/demo/', headers={'Host': installer.HOST})
                with opener.open(request, timeout=2) as response:
                    require(response.status == 200, 'MOCK_HEALTH_FAILED')
                with opener.open('http://127.0.0.1:18982/health', timeout=2) as response:
                    require(response.status == 200 and json.load(response).get('status') == 'ok', 'MOCK_HEALTH_FAILED')
                installer.public_probe('https://' + installer.HOST + '/health',
                    lambda body: json.loads(body).get('status') == 'ok' and json.loads(body).get('environment') == 'sandbox', 'MOCK_HTTPS_FAILED')
                return
            except Exception:
                if attempt == 14:
                    raise RuntimeError('MOCK_HEALTH_FAILED') from None
                time.sleep(1)

    def dump(self, target, maximum, base):
        command = ['docker', 'exec', installer.CONTAINER, 'pg_dump', '-U', 'postgres', '-d', 'oasis_android_mock', '-Fc']
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            written = 0
            try:
                deadline = time.monotonic() + 180
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        require(time.monotonic() < deadline, 'MOCK_DUMP_TIMEOUT')
                        if not selector.select(min(1, max(0, deadline - time.monotonic()))):
                            continue
                        chunk = os.read(process.stdout.fileno(), 1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        require(written <= maximum and available(base) >= RESERVE + len(chunk), 'MOCK_BACKUP_SPACE_EXHAUSTED')
                        output.write(chunk)
                require(process.wait(timeout=30) == 0 and written > 0, 'MOCK_DUMP_FAILED')
                output.flush()
                os.fsync(output.fileno())
            except BaseException:
                process.kill()
                process.wait()
                raise
            finally:
                process.stdout.close()
        with target.open('rb') as source:
            result = subprocess.run(['docker', 'exec', '-i', installer.CONTAINER, 'pg_restore', '--list'],
                                    stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        require(result.returncode == 0 and bool(result.stdout), 'MOCK_DUMP_UNREADABLE')
        return {'bytes': written, 'sha256': digest(target), 'toc_sha256': hashlib.sha256(result.stdout).hexdigest(),
                'validation': 'pg_restore --list; not a real database restore drill'}


class Upgrade:
    def __init__(self, base=installer.BASE, runtime=None, lock_root=Path('/run/lock')):
        self.base, self.runtime, self.lock_root = Path(base), runtime or Runtime(), Path(lock_root)
        self.private = self.base / 'android-mock-private'
        self.marker, self.pin = self.private / 'installation.json', self.base / 'android-mock-current'
        self.old, self.new = (self.base / 'releases' / name for name in (OLD_NAME, NEW_NAME))
        self.work = self.private / 'upgrade-20261007-04-to-20261008-05'
        self.journal = self.work / 'journal.json'

    @contextmanager
    def locked(self, network=False):
        paths = [self.lock_root / 'oasis-android-mock-network.lock'] if network else [
            self.base / 'private/release.lock', self.lock_root / 'oasis-android-mock-install.lock']
        descriptors = []
        try:
            for path in paths:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                descriptors.append(descriptor)
                info = os.fstat(descriptor)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1, 'UNSAFE_UPGRADE_LOCK')
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                current = path.lstat()
                require((info.st_dev, info.st_ino) == (current.st_dev, current.st_ino), 'UNSAFE_UPGRADE_LOCK')
            yield
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def state(self):
        require(self.base.resolve(strict=True) == self.base, 'UNSAFE_BASE_PATH')
        mock_private_directory(self.private)
        regular(self.marker, True)
        value = json.loads(self.marker.read_text())
        require(value.get('kind') == 'isolated-13-game-mock' and value.get('host') == installer.HOST, 'MOCK_MARKER_INVALID')
        require(self.pin.is_symlink() and self.pin.lstat().st_uid == os.geteuid(), 'MOCK_PIN_INVALID')
        return value, self.pin.resolve(strict=True)

    def private_hashes(self):
        values = {}
        for name in PRIVATE_FILES:
            path = self.private / name
            no_link_components(self.private, path)
            info = regular(path)
            require(stat.S_IMODE(info.st_mode) == 0o600, 'MOCK_PRIVATE_PERMISSIONS')
            values[name] = {'sha256': digest(path), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
        return values

    def live_boundary(self):
        link = self.base / 'current'
        require(link.is_symlink(), 'LIVE_PIN_INVALID')
        return {'live_pin': str(link.resolve(strict=True)), 'runtime_sha256': digest(self.base / 'private/runtime.env')}

    def release_checks(self):
        old, new = manifest(self.old), manifest(self.new)
        require(digest(self.new / 'RELEASE-MANIFEST.json') == NEW_MANIFEST, 'TARGET_MANIFEST_NOT_PINNED')
        require(old['platform/deploy/mock-sandbox/install.py'] == digest(DEPENDENCY), 'INSTALLER_DEPENDENCY_CHANGED')
        compatibility = compatible(old, new)
        before_dependencies, after_dependencies = dependencies(self.old), dependencies(self.new)
        require(before_dependencies == after_dependencies, 'INSTALLED_DEPENDENCIES_CHANGED')
        compatibility['installed_dependencies'] = before_dependencies
        before, after = static_assets(self.old), static_assets(self.new)
        return {'old_manifest': digest(self.old / 'RELEASE-MANIFEST.json'), 'new_manifest': NEW_MANIFEST,
                'runtime_compatibility': compatibility, 'forward_assets': coverage(before, after),
                'rollback_assets': coverage(after, before)}

    @staticmethod
    def no_obligations(business):
        require(bool(business['audit']) and all(type(n) is int and n == 0 for n in business['audit'].values()), 'MOCK_LEDGER_OR_PENDING_OBLIGATIONS')
        require(bool(business['pending']) and all(type(n) is int and n == 0 for n in business['pending'].values()), 'MOCK_PENDING_PRESENTATION_OR_WALLET')

    def check(self):
        require(not self.work.exists() and not self.work.is_symlink(), 'EXISTING_UPGRADE_REQUIRES_RECOVER')
        state, pin = self.state()
        releases = self.release_checks()
        require(state.get('release') == str(self.old) and pin == self.old
                and state.get('manifest_sha256') == releases['old_manifest'], 'EXACT_RUNNING_04_REQUIRED')
        resources = self.runtime.guard(state)
        require(all(self.runtime.services()[name] == 'active' for name in APP_UNITS), 'RUNNING_MOCK_REQUIRED')
        self.runtime.preflight(self.old)
        business = self.runtime.inspect_business(self.old)
        self.no_obligations(business)
        private = self.private_hashes()
        size = self.runtime.database_size()
        require(size > 0, 'INVALID_DATABASE_SIZE')
        private_bytes = 0
        for path in self.private.rglob('*'):
            no_link_components(self.private, path)
            require(path.is_dir() or path.is_file(), 'UNSAFE_PRIVATE_BACKUP_PATH')
            if path.is_file():
                regular(path)
                private_bytes += path.stat().st_size
            private_bytes += 8192
        backup_upper = size * 2 + private_bytes + 64 * 1024 ** 2
        require(available(self.base) >= RESERVE + backup_upper, 'MOCK_UPGRADE_SPACE_INSUFFICIENT')
        blockers = [key for key in ('forward_assets', 'rollback_assets') if not releases[key]['compatible']]
        return {'mode': 'check-only', 'old': str(self.old), 'new': str(self.new), 'apply_allowed': not blockers,
                'blockers': blockers, **releases, 'private_hashes': private, 'resources': resources,
                'live_boundary': self.live_boundary(), 'business': business, 'backup_upper_bytes': backup_upper,
                'minimum_remaining_bytes': RESERVE}, state

    def save(self, journal, phase):
        journal['phase'] = phase
        write_json(self.journal, journal)

    def verify_fixed(self, journal):
        require(self.private_hashes() == journal['checks']['private_hashes'], 'MOCK_PRIVATE_STATE_CHANGED')
        require(self.live_boundary() == journal['checks']['live_boundary'], 'LIVE_BOUNDARY_CHANGED')
        require(self.release_checks() == {key: journal['checks'][key] for key in
                ('old_manifest', 'new_manifest', 'runtime_compatibility', 'forward_assets', 'rollback_assets')}, 'RELEASE_COMPATIBILITY_CHANGED')

    def switch(self, release):
        temporary = self.base / ('.android-mock-upgrade-' + uuid.uuid4().hex)
        temporary.symlink_to(release)
        os.replace(temporary, self.pin)
        sync_dir(self.base)

    def backup(self, journal):
        folder = self.work / 'backup'
        folder.mkdir(mode=0o700)
        sync_dir(self.work)
        dump = self.runtime.dump(folder / 'database.dump', journal['checks']['backup_upper_bytes'], self.base)
        private_tar = folder / 'private-config.tar'
        names = []
        for path in [self.private, *sorted(self.private.rglob('*'))]:
            if path == self.work or path.is_relative_to(self.work):
                continue
            require(not path.is_symlink() and (path.is_dir() or path.is_file()), 'UNSAFE_PRIVATE_BACKUP_PATH')
            names.append(path)
        required = sum(path.stat().st_size + 8192 for path in names) + 10240
        require(available(self.base) >= RESERVE + required, 'MOCK_PRIVATE_BACKUP_SPACE_INSUFFICIENT')
        with tarfile.open(private_tar, 'x', format=tarfile.PAX_FORMAT) as bundle:
            for path in names:
                bundle.add(path, arcname='android-mock-private' + ('' if path == self.private else '/' + path.relative_to(self.private).as_posix()), recursive=False)
        private_tar.chmod(0o600)
        with private_tar.open('rb') as stream:
            os.fsync(stream.fileno())
        with tarfile.open(private_tar, 'r:') as bundle:
            members = bundle.getmembers()
            require(len(members) == len(names), 'PRIVATE_BACKUP_ENTRY_MISMATCH')
            for member, path in zip(members, names):
                info = path.stat()
                expected_name = 'android-mock-private' + ('' if path == self.private else '/' + path.relative_to(self.private).as_posix())
                require(member.name == expected_name, 'PRIVATE_BACKUP_ENTRY_MISMATCH')
                require((member.uid, member.gid, member.mode) == (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), 'PRIVATE_BACKUP_METADATA_MISMATCH')
                if path.is_file():
                    require(member.isfile() and hashlib.sha256(bundle.extractfile(member).read()).hexdigest() == digest(path), 'PRIVATE_BACKUP_CONTENT_MISMATCH')
                else:
                    require(member.isdir(), 'PRIVATE_BACKUP_TYPE_MISMATCH')
        receipt = {'database': dump, 'private_sha256': digest(private_tar), 'private_members': len(names),
                   'old_manifest': journal['checks']['old_manifest'], 'old_marker': journal['old_state']}
        write_json(folder / 'receipt.json', receipt)
        sync_dir(folder)
        return receipt

    def verify_backup(self, journal):
        if 'backup' not in journal:
            require(journal['phase'] not in ('backed_up', 'switching', 'pin_switched', 'marker_switched', 'starting', 'healthy', 'complete'), 'MISSING_UPGRADE_BACKUP')
            return
        folder = self.work / 'backup'
        owned_directory(folder)
        for name in ('receipt.json', 'database.dump', 'private-config.tar'):
            regular(folder / name, True)
        receipt = json.loads((folder / 'receipt.json').read_text())
        require(receipt == journal['backup'] and receipt['old_marker'] == journal['old_state']
                and receipt['old_manifest'] == journal['checks']['old_manifest'], 'UPGRADE_BACKUP_RECEIPT_CHANGED')
        require(digest(folder / 'database.dump') == receipt['database']['sha256']
                and (folder / 'database.dump').stat().st_size == receipt['database']['bytes']
                and digest(folder / 'private-config.tar') == receipt['private_sha256'], 'UPGRADE_BACKUP_CHANGED')

    def load_journal(self):
        owned_directory(self.work)
        regular(self.journal, True)
        journal = json.loads(self.journal.read_text())
        require(journal.get('format') == 1 and journal.get('kind') == 'mock-04-to-05-v1'
                and journal.get('phase') in PHASES and journal.get('controller_sha256') == digest(Path(__file__))
                and journal.get('installer_sha256') == digest(DEPENDENCY), 'INVALID_UPGRADE_JOURNAL')
        require(journal['old_state'].get('release') == str(self.old) and journal['new_state'] ==
                dict(journal['old_state'], release=str(self.new), manifest_sha256=NEW_MANIFEST), 'INVALID_UPGRADE_STATE')
        require(json.loads(journal['old_marker_text']) == journal['old_state'], 'INVALID_UPGRADE_STATE')
        require(journal['checks']['apply_allowed'] and not journal['checks']['blockers'], 'INVALID_UPGRADE_CHECKS')
        require(journal['old_state']['manifest_sha256'] == journal['checks']['old_manifest']
                and journal['checks']['new_manifest'] == NEW_MANIFEST, 'INVALID_UPGRADE_CHECKS')
        return journal

    def recover_locked(self):
        journal = self.load_journal()
        self.verify_fixed(journal)
        self.verify_backup(journal)
        state, pin = self.state()
        require(state in (journal['old_state'], journal['new_state']) and pin in (self.old, self.new), 'UPGRADE_STATE_CONFLICT')
        require(self.runtime.resources(state) == journal['checks']['resources'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
        if journal['phase'] in ('complete', 'rolled_back'):
            expected = self.new if journal['phase'] == 'complete' else self.old
            require(pin == expected and state['release'] == str(expected), 'UPGRADE_STATE_CONFLICT')
            require(self.runtime.guard(state) == journal['checks']['resources'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
            self.runtime.health()
            return {'status': 'already_' + journal['phase'], 'release': str(expected), 'database_restored': False}
        new_pair = (state, pin) == (journal['new_state'], self.new)
        business = self.runtime.inspect_business(self.old)
        changed = journal.get('baseline') is not None and business != journal['baseline']
        if new_pair and (changed or journal['phase'] == 'healthy'):
            # A healthy new runtime may already have accepted legitimate play.
            # Keep that version and data; never stop it just to reproduce an old
            # quiescent snapshot. Failed verification leaves its current state.
            return self.finish_new(journal)
        if (state, pin) == (journal['old_state'], self.old) and (
                journal['phase'] == 'rollback_healthy' or journal['phase'] == 'rolling_back' and changed):
            return self.finish_old(journal)
        require(not changed, 'MOCK_BUSINESS_CHANGED_REQUIRES_INSPECTION')
        self.save(journal, 'rolling_back')
        self.runtime.stop()
        business = self.runtime.inspect_business(self.old)
        if journal.get('baseline') is not None:
            if business != journal['baseline'] and new_pair:
                # Close the observation-to-stop race: preserve newly accepted
                # work and restart only the already-matching new version.
                return self.finish_new(journal)
            if business != journal['baseline'] and (state, pin) == (journal['old_state'], self.old):
                # The restored old runtime has the same observation-to-stop
                # race. Preserve that new work and bring its matching version
                # back instead of leaving a previously healthy service stopped.
                return self.finish_old(journal)
            require(business == journal['baseline'], 'MOCK_BUSINESS_CHANGED_REQUIRES_INSPECTION')
        with self.locked(network=True):
            self.verify_fixed(journal)
            self.switch(self.old)
            write_bytes(self.marker, journal['old_marker_text'].encode(), mock_private_directory)
        return self.finish_old(journal)

    def finish_old(self, journal):
        require(self.state() == (journal['old_state'], self.old), 'UPGRADE_STATE_CONFLICT')
        self.verify_fixed(journal)
        require(self.runtime.guard(journal['old_state']) == journal['checks']['resources'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
        self.runtime.preflight(self.old)
        if not all(self.runtime.services()[name] == 'active' for name in APP_UNITS):
            self.runtime.start()
        self.runtime.health()
        self.verify_fixed(journal)
        # The old compatible runtime is now accepting requests again. A fresh
        # user action is not grounds to stop it or overwrite its database.
        observed = self.runtime.inspect_business(self.old)
        self.integrity(observed, journal.get('baseline'))
        journal['rollback_business_changed_after_start'] = journal.get('baseline') is not None and observed != journal['baseline']
        self.save(journal, 'rollback_healthy')
        self.save(journal, 'rolled_back')
        return {'status': 'rolled_back', 'release': str(self.old), 'database_restored': False,
                'backup_retained': (self.work / 'backup').exists()}

    def recover(self):
        with self.locked():
            return self.recover_locked()

    @staticmethod
    def integrity(business, baseline):
        require(all(type(business['audit'].get(key)) is int and business['audit'][key] == 0
                    for key in INTEGRITY_COUNTS), 'MOCK_INTEGRITY_CHANGED_REQUIRES_INSPECTION')
        if baseline is not None:
            require(business['schema_sha256'] == baseline['schema_sha256'], 'MOCK_SCHEMA_CHANGED_REQUIRES_INSPECTION')

    def finish_new(self, journal):
        require(self.state() == (journal['new_state'], self.new), 'UPGRADE_STATE_CONFLICT')
        self.verify_fixed(journal)
        self.verify_backup(journal)
        require(self.runtime.guard(journal['new_state']) == journal['checks']['resources'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
        self.runtime.preflight(self.new)
        if not all(self.runtime.services()[name] == 'active' for name in APP_UNITS):
            self.runtime.start()
        self.runtime.health()
        observed = self.runtime.inspect_business(self.new)
        self.integrity(observed, journal['baseline'])
        self.verify_fixed(journal)
        require(self.state() == (journal['new_state'], self.new), 'UPGRADE_STATE_CONFLICT')
        journal['business_changed_after_start'] = observed != journal['baseline']
        journal['completion_observation'] = observed
        self.save(journal, 'healthy')
        self.save(journal, 'complete')
        return {'status': 'upgraded', 'release': str(self.new), 'database_restored': False,
                'database_and_private_preserved': True, 'backup_retained': True, 'apk_changed': False,
                'business_changed_after_start': journal['business_changed_after_start'],
                'requires_fresh_mock_13_game_and_device_acceptance': True}

    def apply(self):
        with self.locked():
            checks, old_state = self.check()
            require(checks['apply_allowed'], 'MOCK_STATIC_FORWARD_OR_ROLLBACK_COVERAGE_MISSING')
            self.work.mkdir(mode=0o700)
            sync_dir(self.private)
            journal = {'format': 1, 'kind': 'mock-04-to-05-v1', 'controller_sha256': digest(Path(__file__)),
                       'installer_sha256': digest(DEPENDENCY), 'checks': checks, 'old_state': old_state,
                       'old_marker_text': self.marker.read_text(),
                       'new_state': dict(old_state, release=str(self.new), manifest_sha256=NEW_MANIFEST)}
            self.save(journal, 'prepared')
            try:
                self.save(journal, 'stopping')
                self.runtime.stop()
                baseline = self.runtime.inspect_business(self.old)
                self.no_obligations(baseline)
                journal['baseline'] = baseline
                self.save(journal, 'stopped')
                self.verify_fixed(journal)
                require(self.runtime.guard(old_state) == checks['resources'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
                self.save(journal, 'backing_up')
                journal['backup'] = self.backup(journal)
                require(self.runtime.inspect_business(self.old) == baseline, 'MOCK_BUSINESS_CHANGED_DURING_BACKUP')
                self.save(journal, 'backed_up')
                self.verify_backup(journal)
                with self.locked(network=True):
                    self.verify_fixed(journal)
                    require(self.state() == (old_state, self.old), 'UPGRADE_STATE_CONFLICT')
                    self.save(journal, 'switching')
                    self.switch(self.new)
                    self.save(journal, 'pin_switched')
                    write_json(self.marker, journal['new_state'], mock_private_directory)
                    self.save(journal, 'marker_switched')
                require(self.runtime.guard(journal['new_state']) == checks['resources'], 'MOCK_RESOURCE_IDENTITY_CHANGED')
                self.runtime.preflight(self.new)
                self.save(journal, 'starting')
                self.runtime.start()
                return self.finish_new(journal)
            except Exception:
                try:
                    recovered = self.recover_locked()
                except Exception:
                    raise RuntimeError('MOCK_UPGRADE_RECOVERY_REQUIRES_INSPECTION') from None
                if recovered['status'] == 'upgraded':
                    return recovered
                raise RuntimeError('MOCK_UPGRADE_FAILED_ROLLED_BACK') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', default='check-only', choices=('check-only', 'apply', 'recover'))
    args = parser.parse_args(argv)
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    task = Upgrade()
    if args.mode == 'check-only':
        with task.locked():
            result = task.check()[0]
    else:
        result = getattr(task, args.mode)()
    # Private hashes/business checks stay in the private journal. Reports expose
    # only compatibility, counts and public paths, never configuration contents.
    public = {key: value for key, value in result.items() if key not in ('private_hashes', 'business', 'resources', 'live_boundary')}
    print(json.dumps(public, indent=2))
    if public.get('apply_allowed') is False:
        raise SystemExit(2)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z0-9_]+', str(error)) else 'MOCK_UPGRADE_FAILED'
        raise SystemExit(code) from None
