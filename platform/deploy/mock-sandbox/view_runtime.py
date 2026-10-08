"""Fixed-host adapter for the reviewed Mock origin/forward/rollback views.

No stage, Nginx, installer lifecycle or legacy upgrade controller entry point.
All mutations require the controller's locks. Importing this module is inert.
"""
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import types
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/oasis')
HOST = 'oasis-mock.43.98.202.236.sslip.io'
ROLES = {
    'origin': ('20261007-04', '47e5cab2ff8c910e7821e6c1edbd92a26135944241fc5b0c1610a44952d883bc'),
    'forward': ('20261008-16', '91e8796604c13db1d676ec51a9deb3f6095d6bd9793e5bb754b4d738a23367a4'),
    'rollback': ('20261008-17', 'a08f03687efa36a16454513e31d72de6bd4e0d35eb8d929c91c72703cfa8c61b'),
}
SOURCE_NEW = '20261008-15'
SOURCE_NEW_MANIFEST = '6b4f3548a8382083d18ded796c9aec7ee09d5a82fcf1020267d3dc2b309db25f'
INVENTORY_SHA = 'e4c603a7847191fb42cad14436a2605aa589fa3ef7aca1824cbd51e1da19184c'
RECEIPTS = {
    'forward': 'db0fa021e27f7ac13d24276408eba0d8c76728fa984dd30cab2c9ea2d820f376',
    'rollback': 'cfd36800081a652e94fdda3a94f2114fe3ebeb5e5c3b7287022f811f39de9a4f',
}
DEPENDENCIES = {
    'upgrade.py': 'ea6417ca904f95a8bc5cc6e2589d2ee543b803975509d226578eb638659d1fcf',
    'install.py': '9ccd1b7b1f751ebb2d0d5e5dc52699de4ad1daff4f7a1423108059dbc4f52639',
    'release_views.py': '12a416139035ce4b8f81e572ba284b8dbfe91adbd76d3e4cfeec8be65d0e32d8',
}
DATABASE_SHA256 = 'ec042ed37649519fd2ded4370daa5a76236225ab0c33bd40d8fb40003284a95e'
TOOLS = ('view_upgrade.py', 'view_runtime.py', 'view_database.py', 'upgrade.py', 'install.py', 'release_views.py')
PHASES = ('prepared', 'stopping', 'stopped', 'backing_up', 'backed_up', 'migrating', 'migrated',
          'switching', 'pin_switched', 'marker_switched', 'starting', 'healthy', 'complete',
          'rolling_back', 'rollback_pin_switched', 'rollback_marker_switched', 'rollback_starting',
          'rollback_healthy', 'rolled_back', 'aborted')
EARLY_PHASES = ('prepared', 'stopping', 'stopped', 'backing_up')
INSTALLED_DEPS = {'entries': 8339, 'sha256': 'ffbdec70433152f668085394af0fc09d2d9871dd6bd406dd3ab6ad7233d8ffcc'}
MAX_JSON = 16 * 1024 * 1024
SQL_COMMAND = ('docker', 'exec', '-i', 'oasis-android-mock-postgres', 'psql', '-X', '-qAt',
               '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'oasis_android_mock')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def json_value(raw):
    require(isinstance(raw, bytes) and len(raw) <= MAX_JSON, 'VIEW_JSON_SIZE')
    def pairs(items):
        result = {}
        for name, value in items:
            require(name not in result, 'VIEW_DUPLICATE_JSON_KEY')
            result[name] = value
        return result
    def invalid(_):
        raise RuntimeError('VIEW_NONFINITE_JSON')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def module_bytes(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o022 and info.st_size <= MAX_JSON,
            'VIEW_UNSAFE_TOOL_FILE')
    return path.read_bytes()


def load_verified_helpers():
    # Verify every transitive legacy dependency before executing any source.
    data = {name: module_bytes(HERE / name) for name in DEPENDENCIES}
    require(all(digest(data[name]) == expected for name, expected in DEPENDENCIES.items()), 'VIEW_HELPER_HASH_CHANGED')
    loaded = []
    old_bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        for name in ('upgrade.py', 'release_views.py'):
            module = types.ModuleType('mock_view_' + name.replace('.', '_'))
            module.__file__ = str(HERE / name)
            exec(compile(data[name], str(HERE / name), 'exec'), module.__dict__)
            loaded.append(module)
    finally:
        sys.dont_write_bytecode = old_bytecode
    return tuple(loaded)


def load_verified_database(sql, old_release, new_release):
    raw = module_bytes(HERE / 'view_database.py')
    require(digest(raw) == DATABASE_SHA256, 'VIEW_DATABASE_SOURCE_CHANGED')
    module = types.ModuleType('mock_view_database_bound')
    module.__file__ = str(HERE / 'view_database.py')
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    return module.ViewDatabase(sql, old_release, new_release)


def run_mock_sql(sql):
    """One fixed session, no retry; do not disclose SQL or captured diagnostics.

    The bound database module limits each server statement to 60 seconds. The
    complete transaction includes its postcondition snapshot and COMMIT, so the
    legacy runner's 60-second process timeout is too short. A process timeout is
    an unknown outcome, never evidence of rollback; recovery re-observes the DB.
    """
    require(type(sql) is str and bool(sql) and '\0' not in sql, 'VIEW_SQL_INPUT_INVALID')
    try:
        payload = sql.encode('utf8')
    except UnicodeError:
        raise RuntimeError('VIEW_SQL_INPUT_INVALID') from None
    require(len(payload) <= MAX_JSON, 'VIEW_SQL_INPUT_TOO_LARGE')
    try:
        result = subprocess.run(list(SQL_COMMAND), input=payload, capture_output=True, check=False, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('VIEW_SQL_COMMAND_FAILED') from None
    require(result.returncode == 0, 'VIEW_SQL_COMMAND_FAILED')
    require(isinstance(result.stdout, bytes) and len(result.stdout) <= MAX_JSON, 'VIEW_SQL_OUTPUT_INVALID')
    try:
        return result.stdout.decode('utf8').strip()
    except UnicodeError:
        raise RuntimeError('VIEW_SQL_OUTPUT_INVALID') from None


def installed_dependencies(root):
    """Match the independently frozen inventory, including its root entry.

    Keys are release-relative (platform/node_modules/...), unlike the older
    upgrade.dependencies helper. JSON separators deliberately match inventory.py.
    Only internal symlinks are permitted; regular files are independent copies.
    """
    root = Path(root)
    require(root.is_absolute() and root.resolve(strict=True) == root, 'VIEW_DEPENDENCY_ROOT_UNSAFE')
    folder = root / 'platform/node_modules'
    for parent in (root, root / 'platform', folder):
        require(stat.S_ISDIR(parent.lstat().st_mode), 'VIEW_DEPENDENCY_DIRECTORY_UNSAFE')
    def fingerprint(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    records = {}
    def visit(path):
        before = path.lstat()
        name = path.relative_to(root).as_posix()
        require(len(records) < 50000, 'VIEW_DEPENDENCY_ENTRY_LIMIT')
        if stat.S_ISLNK(before.st_mode):
            require(path.resolve(strict=True).is_relative_to(folder), 'VIEW_DEPENDENCY_LINK_OUTSIDE_ROOT')
            records[name] = ['link', os.readlink(path)]
        elif stat.S_ISDIR(before.st_mode):
            records[name] = ['directory', stat.S_IMODE(before.st_mode)]
            for child in sorted(path.iterdir()):
                visit(child)
        else:
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and not before.st_mode & 0o7000,
                    'VIEW_DEPENDENCY_FILE_UNSAFE')
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            hashed = hashlib.sha256()
            with os.fdopen(descriptor, 'rb') as stream:
                require(fingerprint(os.fstat(descriptor)) == fingerprint(before), 'VIEW_DEPENDENCY_CHANGED')
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    hashed.update(block)
                require(fingerprint(os.fstat(descriptor)) == fingerprint(before), 'VIEW_DEPENDENCY_CHANGED')
            records[name] = ['file', stat.S_IMODE(before.st_mode), hashed.hexdigest()]
        require(fingerprint(path.lstat()) == fingerprint(before), 'VIEW_DEPENDENCY_CHANGED')
    visit(folder)
    return {'entries': len(records), 'sha256': digest(json.dumps(records, sort_keys=True).encode())}


def validate_process(observed, *, role_root, unit, uid, entry):
    """Pure assertion over a twice-bound /proc + systemd observation."""
    require(type(observed.get('pid')) is int and observed['pid'] > 1, 'VIEW_MAIN_PID_INVALID')
    require(observed.get('pid_after') == observed['pid'] and observed.get('start_ticks') == observed.get('start_ticks_after')
            and type(observed.get('start_ticks')) is int and observed['start_ticks'] > 0, 'VIEW_PROCESS_IDENTITY_CHANGED')
    require(observed.get('cwd') == str(role_root / 'platform') and observed.get('cwd_after') == observed['cwd'], 'VIEW_PROCESS_RELEASE_MISMATCH')
    require(observed.get('uids') == [uid] * 4 and uid > 0, 'VIEW_PROCESS_UID_MISMATCH')
    require(observed.get('argv') == ['/usr/bin/node', '--import', 'tsx', entry], 'VIEW_PROCESS_COMMAND_MISMATCH')
    require(observed.get('exe') == str(Path('/usr/bin/node').resolve()), 'VIEW_PROCESS_EXECUTABLE_MISMATCH')
    group = '/system.slice/' + unit + '.service'
    require(observed.get('control_group') == group and group in observed.get('cgroups', []), 'VIEW_PROCESS_CGROUP_MISMATCH')
    return {'pid': observed['pid'], 'start_ticks': observed['start_ticks'], 'cwd': observed['cwd'], 'unit': unit,
            'uid': uid, 'entry': entry, 'control_group': group}


def validate_recipe_entries(receipt, plan, manifest, files, *, receipt_name='MOCK-VIEW-RECEIPT.json'):
    require(set(receipt['files']) == set(plan) and set(manifest) == set(plan) | {receipt_name}, 'VIEW_RECEIPT_BODY_COVERAGE')
    for name, expected in plan.items():
        entry = receipt['files'][name]
        require((entry['source'], entry['path'], entry['sha256']) == expected
                and manifest[name] == files[name]['sha256'] == expected[2], 'VIEW_BODY_SOURCE_MISMATCH')
        expected_mode = 0o755 if entry['mode'] & 0o111 else 0o644
        require(files[name]['bytes'] == entry['bytes'] and files[name]['mode'] == entry['output_mode'] == expected_mode,
                'VIEW_BODY_METADATA_MISMATCH')


def validate_publication(receipt, role, source_max_mtime_ns, output_mtimes, now_seconds):
    epoch, output = receipt.get('publication_epoch'), receipt.get('output_mtime_ns')
    require(role in ('forward', 'rollback') and type(epoch) is int and 0 < epoch < 2147483646,
            'VIEW_PUBLICATION_EPOCH_INVALID')
    require(type(output) is int and output == (epoch + (role == 'rollback')) * 1000000000,
            'VIEW_PUBLICATION_ROLE_TIME_INVALID')
    require(type(source_max_mtime_ns) is int and source_max_mtime_ns < epoch * 1000000000,
            'VIEW_PUBLICATION_NOT_AFTER_SOURCES')
    require(epoch + 1 <= now_seconds, 'VIEW_FUTURE_VALIDATOR_FORBIDDEN')
    require(bool(output_mtimes) and all(type(value) is int and value == output for value in output_mtimes),
            'VIEW_OUTPUT_MTIME_CHANGED')
    return {'publication_epoch': epoch, 'output_mtime_ns': output}


class ViewRuntime:
    def __init__(self, *, runtime=None, database=None):
        self.upgrade, self.views = load_verified_helpers()
        self.base = BASE
        self.private = self.base / 'android-mock-private'
        self.marker = self.private / 'installation.json'
        self.pin = self.base / 'android-mock-current'
        self.releases = {role: self.base / 'releases' / name for role, (name, _) in ROLES.items()}
        self.work = self.private / 'view-upgrade-20261007-04-to-20261008-16'
        self.journal = self.work / 'journal.json'
        self.runtime = runtime or self.upgrade.Runtime()
        # Reuse only specific low-level lock/private/backup helpers. Never invoke
        # the old check/apply/recover/state machine or installer lifecycle.
        self.low = object.__new__(self.upgrade.Upgrade)
        for name, value in {'base': self.base, 'private': self.private, 'marker': self.marker, 'pin': self.pin,
                            'old': self.releases['origin'], 'new': self.releases['forward'], 'work': self.work,
                            'journal': self.journal, 'runtime': self.runtime, 'lock_root': Path('/run/lock')}.items():
            setattr(self.low, name, value)
        self._lock_depth = 0
        self._checks = None
        self._initial_tools = self.tool_hashes()
        if database is None:
            database = load_verified_database(self.sql, self.releases['origin'], self.releases['forward'])
        self.database = database

    def tool_hashes(self):
        result = {name: digest(module_bytes(HERE / name)) for name in TOOLS}
        require(all(result[name] == value for name, value in DEPENDENCIES.items()), 'VIEW_HELPER_HASH_CHANGED')
        require(result['view_database.py'] == DATABASE_SHA256, 'VIEW_DATABASE_SOURCE_CHANGED')
        return result

    installed_dependencies = staticmethod(installed_dependencies)

    def _locked(self):
        require(self._lock_depth > 0, 'VIEW_MUTATION_REQUIRES_LOCK')
        require(self.tool_hashes() == self._initial_tools, 'VIEW_TOOLS_CHANGED')

    @contextmanager
    def locked(self):
        require(self._lock_depth == 0, 'VIEW_LOCK_REENTRY')
        with self.low.locked():
            self._lock_depth = 1
            try:
                yield
            finally:
                self._lock_depth = 0

    def _inventory(self):
        raw = self.views.read_small(HERE / 'view-origin-inventory.json')
        return self.views.validate_inventory(raw, INVENTORY_SHA, ROLES['origin'][1])

    def _source_new(self):
        path = self.base / 'releases' / SOURCE_NEW / self.views.MANIFEST
        raw = self.views.read_small(path)
        manifest = self.views.validate_manifest(raw, SOURCE_NEW_MANIFEST)
        scan = self.views.scan_tree(path.parent)
        require(all(name in scan['files'] and scan['files'][name]['sha256'] == value for name, value in manifest.items()),
                'VIEW_ORIGINAL_NEW_SOURCE_BODY_CHANGED')
        extras = set(scan['files']) - set(manifest) - {self.views.MANIFEST}
        require(all(self.views.cache_path(name) for name in extras), 'VIEW_ORIGINAL_NEW_UNKNOWN_EXTRA')
        return manifest, scan

    def _release_evidence(self):
        inventory = self._inventory()
        origin = self.views.verify_source(self.releases['origin'], ROLES['origin'][1], inventory=inventory)
        new_manifest, new_source_scan = self._source_new()
        source_max_mtime = max(info[-2] for scan in (origin['observed'], new_source_scan) for info in scan['identities'].values())
        source_old = origin['observed']['files']
        old_bodies = {name: value['sha256'] for name, value in source_old.items() if name != self.views.MANIFEST
                      and name not in origin['excluded_caches'] and name not in origin['excluded_source_metadata']}
        forward = {name: ('new', name, value) for name, value in new_manifest.items()}
        for name, value in old_bodies.items():
            if self.views.is_static(name):
                require(name not in forward or forward[name][2] == value or name in self.views.MUTABLE, 'VIEW_UNCLASSIFIED_STATIC_CONFLICT')
                forward.setdefault(name, ('old', name, value))
        versioned = {}
        for name in self.views.MUTABLE:
            require(name in old_bodies and name in new_manifest, 'VIEW_MUTABLE_SOURCE_MISSING')
            version = 'platform/dist/mock-releases/' + SOURCE_NEW_MANIFEST + '/' + name.removeprefix('platform/dist/')
            require(version not in forward and version not in old_bodies, 'VIEW_VERSIONED_PATH_CONFLICT')
            forward[name] = ('old', name, old_bodies[name])
            forward[version] = ('new', name, new_manifest[name])
            versioned[name] = version
        rollback = {name: ('old', name, value) for name, value in old_bodies.items()}
        for name, item in forward.items():
            if self.views.is_static(name):
                require(name not in rollback or rollback[name][2] == item[2], 'VIEW_ROLLBACK_STATIC_CONFLICT')
                rollback.setdefault(name, item)
        static = lambda plan: {name: item[2] for name, item in plan.items() if self.views.is_static(name)}
        require(static(forward) == static(rollback), 'VIEW_STATIC_COVERAGE_MISMATCH')
        result = {'origin': {'manifest_sha256': ROLES['origin'][1], 'files': len(source_old),
                             'installed_inventory_sha256': INVENTORY_SHA}}
        epochs = set()
        for role, plan in (('forward', forward), ('rollback', rollback)):
            root = self.releases[role]
            raw_manifest = self.views.read_small(root / self.views.MANIFEST)
            require(digest(raw_manifest) == ROLES[role][1], 'VIEW_MANIFEST_IDENTITY_MISMATCH')
            manifest = json_value(raw_manifest)
            require(isinstance(manifest, dict) and set(manifest) == set(plan) | {self.views.RECEIPT}, 'VIEW_FULL_MANIFEST_COVERAGE')
            for name, hashed in manifest.items():
                self.views.safe_name(name)
                self.views.digest(hashed)
            scan = self.views.scan_tree(root)
            require(set(scan['files']) == set(manifest) | {self.views.MANIFEST}, 'VIEW_UNDECLARED_BODY')
            require(scan['directories'] == self.views.parents(scan['files']), 'VIEW_UNDECLARED_DIRECTORY')
            require(all(scan['files'][name]['sha256'] == value for name, value in manifest.items()), 'VIEW_BODY_HASH_MISMATCH')
            raw_receipt = self.views.read_small(root / self.views.RECEIPT)
            require(digest(raw_receipt) == RECEIPTS[role] == manifest[self.views.RECEIPT], 'VIEW_RECEIPT_IDENTITY_MISMATCH')
            receipt = json_value(raw_receipt)
            observed_mtimes = [info[-2] for info in scan['identities'].values()]
            observed_mtimes += [(root / name).lstat().st_mtime_ns for name in scan['directories']]
            observed_mtimes.append(root.lstat().st_mtime_ns)
            publication = validate_publication(receipt, role, source_max_mtime, observed_mtimes, int(time.time()))
            epochs.add(publication['publication_epoch'])
            require(receipt['schema'] == self.views.SCHEMA and receipt['role'] == role and receipt['derived_view'] is True
                    and receipt['original_release_identity'] is False and receipt['source_manifests'] ==
                    {'old': ROLES['origin'][1], 'new': SOURCE_NEW_MANIFEST}, 'VIEW_RECEIPT_SCOPE')
            require(receipt['old_installed_inventory_sha256'] == INVENTORY_SHA and receipt['new_versioned_files'] == versioned
                    and receipt['excluded_caches'] == origin['excluded_caches']
                    and receipt['excluded_source_metadata'] == origin['excluded_source_metadata'], 'VIEW_SOURCE_EXCLUSION_OR_INVENTORY_CHANGED')
            validate_recipe_entries(receipt, plan, manifest, scan['files'], receipt_name=self.views.RECEIPT)
            result[role] = {'manifest_sha256': ROLES[role][1], 'receipt_sha256': RECEIPTS[role],
                            'files': len(manifest), 'static_files': len(static(plan)), **publication}
        require(len(epochs) == 1, 'VIEW_PUBLICATION_EPOCH_PAIR_MISMATCH')
        dependencies = {role: self.installed_dependencies(root) for role, root in self.releases.items()}
        require(all(value == INSTALLED_DEPS for value in dependencies.values()), 'VIEW_INSTALLED_DEPENDENCIES_MISMATCH')
        # Runtime resources compare units/route to origin templates. Require all
        # three sources to contain those same exact templates, not just a path.
        for name in ('mock-api.service.example', 'mock-demo.service.example', 'mock.nginx.conf.example'):
            values = [self.upgrade.digest(root / 'platform/deploy/mock-sandbox' / name) for root in self.releases.values()]
            require(len(set(values)) == 1, 'VIEW_SERVICE_OR_ROUTE_TEMPLATE_CHANGED')
        return {'releases': result, 'dependencies': dependencies, 'source_new_manifest_sha256': SOURCE_NEW_MANIFEST,
                'static_coverage': {'equal': True, 'files': len(static(forward)), 'sha256': digest(self.views.encoded(static(forward)))}}

    def _state(self):
        self.upgrade.mock_private_directory(self.private)
        self.upgrade.regular(self.marker, True)
        raw = self.views.read_small(self.marker)
        state = json_value(raw)
        require(state.get('kind') == 'isolated-13-game-mock' and state.get('host') == HOST, 'VIEW_MARKER_SCOPE')
        require(self.pin.is_symlink() and self.pin.lstat().st_uid == os.geteuid(), 'VIEW_PIN_UNSAFE')
        target = self.pin.readlink()
        require(target.is_absolute() and target in self.releases.values() and self.pin.resolve(strict=True) == target, 'VIEW_PIN_UNKNOWN')
        return state, target, raw

    def identity(self, checks=None):
        checks = checks or self._checks
        state, pin, _ = self._state()
        pin_role = next((role for role, root in self.releases.items() if root == pin), None)
        marker_role = next((role for role, root in self.releases.items()
                            if state.get('release') == str(root) and state.get('manifest_sha256') == ROLES[role][1]), None)
        require(pin_role is not None and marker_role is not None, 'VIEW_IDENTITY_UNKNOWN')
        if checks is not None:
            self._validate_checks(checks)
            require(state == checks['states'][marker_role], 'VIEW_MARKER_STATE_CHANGED')
        return {'pin': pin_role, 'marker': marker_role}

    def _validate_checks(self, checks):
        require(isinstance(checks, dict) and set(checks['states']) == set(ROLES), 'VIEW_CHECKS_SHAPE')
        origin = checks['states']['origin']
        require(origin.get('kind') == 'isolated-13-game-mock' and origin.get('host') == HOST,
                'VIEW_CHECKS_ORIGIN_SCOPE')
        require(json_value(checks['old_marker_text'].encode()) == origin, 'VIEW_CHECKS_ORIGINAL_MARKER')
        for role, root in self.releases.items():
            require(checks['states'][role] == dict(origin, release=str(root), manifest_sha256=ROLES[role][1]), 'VIEW_CHECKS_ROLE_MAPPING')
        require(checks['tool_hashes'] == self.tool_hashes() == self._initial_tools, 'VIEW_TOOLS_CHANGED')
        require(type(checks['backup_upper_bytes']) is int and checks['backup_upper_bytes'] > 0
                and checks['minimum_remaining_bytes'] == self.upgrade.RESERVE, 'VIEW_BACKUP_BUDGET_INVALID')

    def _process(self, unit, role, entry, uid):
        def number():
            raw = self.runtime.run(['systemctl', 'show', unit, '--property=MainPID', '--value']).decode().strip()
            require(raw.isdigit() and int(raw) > 1, 'VIEW_MAIN_PID_INVALID')
            return int(raw)
        pid = number()
        process = Path('/proc') / str(pid)
        def ticks():
            raw = (process / 'stat').read_text()
            return int(raw[raw.rfind(')') + 2:].split()[19])
        start = ticks()
        group = self.runtime.run(['systemctl', 'show', unit, '--property=ControlGroup', '--value']).decode().strip()
        status = (process / 'status').read_text()
        matched = re.findall(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$', status, re.M)
        observed = {'pid': pid, 'start_ticks': start, 'cwd': str((process / 'cwd').resolve(strict=True)),
                    'exe': str((process / 'exe').resolve(strict=True)),
                    'argv': (process / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0'),
                    'uids': [int(value) for value in matched[0]] if len(matched) == 1 else [],
                    'control_group': group, 'cgroups': [line.split(':', 2)[2] for line in (process / 'cgroup').read_text().splitlines()],
                    'cwd_after': str((process / 'cwd').resolve(strict=True)), 'start_ticks_after': ticks(), 'pid_after': number()}
        return validate_process(observed, role_root=self.releases[role], unit=unit, uid=uid, entry=entry)

    def _processes(self, role, checks):
        states = self.runtime.services()
        require(all(states[name] == 'active' for name in self.upgrade.APP_UNITS), 'VIEW_APPLICATION_NOT_ACTIVE')
        return {unit: self._process(unit, role, entry, checks['states'][role]['uid']) for unit, entry in
                zip(self.upgrade.APP_UNITS, ('server/index.mjs', 'deploy/demo-host.mjs'))}

    def check_initial(self):
        self._locked()
        require(not self.work.exists() and not self.work.is_symlink(), 'VIEW_EXISTING_JOURNAL_REQUIRES_RECOVERY')
        releases = self._release_evidence()
        state, pin, raw = self._state()
        require(pin == self.releases['origin'] and state['release'] == str(pin)
                and state['manifest_sha256'] == ROLES['origin'][1], 'VIEW_EXACT_ORIGIN_REQUIRED')
        states = {role: dict(state, release=str(root), manifest_sha256=ROLES[role][1]) for role, root in self.releases.items()}
        resources = self.runtime.guard(state)
        self.runtime.preflight(self.releases['origin'])
        baseline = self.snapshot()
        require(baseline.get('schema_kind') == 'old', 'VIEW_INITIAL_OLD_SCHEMA_REQUIRED')
        self.require_quiet(baseline)
        self.allow_role(baseline, 'origin')
        size = self.runtime.database_size()
        require(type(size) is int and size > 0, 'VIEW_DATABASE_SIZE_INVALID')
        private_bytes = 0
        for path in self.private.rglob('*'):
            self.upgrade.no_link_components(self.private, path)
            require(path.is_dir() or path.is_file(), 'VIEW_UNSAFE_PRIVATE_BACKUP_PATH')
            if path.is_file():
                self.upgrade.regular(path)
                private_bytes += path.stat().st_size
            private_bytes += 8192
        upper = size * 2 + private_bytes + 64 * 1024 ** 2
        require(self.upgrade.available(self.base) >= self.upgrade.RESERVE + upper, 'VIEW_BACKUP_SPACE_INSUFFICIENT')
        checks = {'states': states, 'old_marker_text': raw.decode(), 'tool_hashes': self.tool_hashes(),
                  'fixed': {**releases, 'private_hashes': self.low.private_hashes(), 'resources': resources,
                            'live_boundary': self.low.live_boundary()}, 'initial_database': baseline,
                  'backup_upper_bytes': upper, 'minimum_remaining_bytes': self.upgrade.RESERVE}
        self._validate_checks(checks)
        checks['initial_processes'] = self._processes('origin', checks)
        self._checks = copy.deepcopy(checks)
        checks['initial_health'] = self.health('origin', checks)
        self._checks = copy.deepcopy(checks)
        return checks

    def verify_fixed(self, checks):
        self._validate_checks(checks)
        self.identity(checks)  # A known mixed pair is observable during recovery.
        fixed = checks['fixed']
        actual = self._release_evidence()
        require(all(actual[key] == fixed[key] for key in actual), 'VIEW_RELEASE_EVIDENCE_CHANGED')
        require(self.low.private_hashes() == fixed['private_hashes'], 'VIEW_PRIVATE_STATE_CHANGED')
        require(self.low.live_boundary() == fixed['live_boundary'], 'VIEW_LIVE_BOUNDARY_CHANGED')
        # resources() deliberately does not invoke release_guard or bind current
        # pin to current marker. A known interrupted switch remains recoverable.
        require(self.runtime.resources(checks['states']['origin']) == fixed['resources'], 'VIEW_RESOURCES_CHANGED')
        self._checks = copy.deepcopy(checks)

    def _journal_valid(self, journal):
        require(isinstance(journal, dict) and journal.get('format') == 1 and journal.get('kind') == 'mock-view-upgrade-v1'
                and journal.get('phase') in PHASES, 'VIEW_JOURNAL_SHAPE')
        require(journal.get('tool_hashes') == self.tool_hashes() == self._initial_tools, 'VIEW_JOURNAL_TOOLS_CHANGED')
        self._validate_checks(journal['checks'])

    def create_journal(self, journal):
        self._locked()
        require(journal.get('phase') == 'prepared' and not self.work.exists() and not self.work.is_symlink(), 'VIEW_JOURNAL_ALREADY_EXISTS')
        journal['tool_hashes'] = self.tool_hashes()
        self._journal_valid(journal)
        self.upgrade.mock_private_directory(self.private)
        self.work.mkdir(mode=0o700)
        self.upgrade.sync_dir(self.private)
        self.save(journal)

    def save(self, journal):
        self._locked()
        self._journal_valid(journal)
        self.upgrade.write_json(self.journal, journal)

    def load_journal(self):
        self._locked()
        self.upgrade.owned_directory(self.work)
        self.upgrade.regular(self.journal, True)
        journal = json_value(self.views.read_small(self.journal))
        self._journal_valid(journal)
        self._checks = copy.deepcopy(journal['checks'])
        return journal

    def snapshot(self):
        return self.database.snapshot()

    def sql(self, source):
        self._locked()
        return run_mock_sql(source)

    def policy(self, observed, baseline):
        return self.database.policy(observed, baseline)

    def require_quiet(self, observed):
        return self.database.require_quiet(observed)

    def allow_role(self, observed, role):
        require(role in ROLES, 'VIEW_UNKNOWN_ROLE')
        return self.database.allow_role(observed, role)

    def migrate(self, baseline):
        self._locked()
        require(all(self.runtime.services()[unit] == 'inactive' for unit in self.upgrade.APP_UNITS), 'VIEW_MIGRATION_REQUIRES_STOPPED_APPS')
        return self.database.migration(baseline)

    def _backup_legacy_shape(self, journal):
        return {**journal, 'old_state': journal['checks']['states']['origin'],
                'checks': {**journal['checks'], 'old_manifest': ROLES['origin'][1]}}

    def backup(self, journal):
        self._locked()
        self._journal_valid(journal)
        require(all(self.runtime.services()[unit] == 'inactive' for unit in self.upgrade.APP_UNITS), 'VIEW_BACKUP_REQUIRES_STOPPED_APPS')
        self.verify_fixed(journal['checks'])
        return self.low.backup(self._backup_legacy_shape(journal))

    def verify_backup(self, journal):
        self._journal_valid(journal)
        if 'backup' not in journal:
            if journal['phase'] == 'aborted':
                require('migration' not in journal and self.identity(journal['checks']) == {'pin': 'origin', 'marker': 'origin'},
                        'VIEW_ABORTED_WITHOUT_ORIGINAL_IDENTITY')
                observed = self.snapshot()
                require(observed.get('schema_kind') in ('old', 'migrated'), 'VIEW_ABORTED_WITHOUT_COMPATIBLE_SCHEMA')
                # A schema change between check and stop can abort before a
                # baseline/backup is recorded. Keeping origin is safe only if
                # the exact database contract still permits that role.
                self.allow_role(observed, 'origin')
            else:
                require(journal['phase'] in EARLY_PHASES, 'VIEW_BACKUP_REQUIRED')
            return
        self.low.verify_backup(self._backup_legacy_shape(journal))

    def stop(self):
        self._locked()
        self.runtime.stop()
        require(all(self.runtime.services()[unit] == 'inactive' for unit in self.upgrade.APP_UNITS), 'VIEW_STOP_NOT_CONFIRMED')

    def _matching_guard(self, role, checks):
        require(role in ROLES, 'VIEW_UNKNOWN_ROLE')
        self.verify_fixed(checks)
        require(self.identity(checks) == {'pin': role, 'marker': role}, 'VIEW_MATCHING_ROLE_REQUIRED')
        require(self.runtime.guard(checks['states'][role]) == checks['fixed']['resources'], 'VIEW_GUARD_RESOURCES_CHANGED')
        self.allow_role(self.snapshot(), role)

    def start(self, role, checks):
        self._locked()
        self._matching_guard(role, checks)
        states = self.runtime.services()
        if all(states[unit] == 'active' for unit in self.upgrade.APP_UNITS):
            return self._processes(role, checks)
        for unit, entry in zip(self.upgrade.APP_UNITS, ('server/index.mjs', 'deploy/demo-host.mjs')):
            require(states[unit] in ('active', 'inactive', 'failed'), 'VIEW_APP_TRANSITION_IN_PROGRESS')
            if states[unit] == 'active':
                self._process(unit, role, entry, checks['states'][role]['uid'])
        self.runtime.preflight(self.releases[role])
        self.runtime.start()
        return self._processes(role, checks)

    def switch_pin(self, role, checks):
        self._locked()
        require(role in ROLES, 'VIEW_UNKNOWN_ROLE')
        require(all(self.runtime.services()[unit] == 'inactive' for unit in self.upgrade.APP_UNITS), 'VIEW_SWITCH_REQUIRES_STOPPED_APPS')
        self.verify_fixed(checks)
        self.allow_role(self.snapshot(), role)
        with self.low.locked(network=True):
            self.low.switch(self.releases[role])
        require(self.identity(checks)['pin'] == role, 'VIEW_PIN_SWITCH_NOT_CONFIRMED')

    def switch_marker(self, role, checks):
        self._locked()
        require(role in ROLES, 'VIEW_UNKNOWN_ROLE')
        require(all(self.runtime.services()[unit] == 'inactive' for unit in self.upgrade.APP_UNITS), 'VIEW_SWITCH_REQUIRES_STOPPED_APPS')
        self.verify_fixed(checks)
        require(self.identity(checks)['pin'] == role, 'VIEW_MARKER_REQUIRES_TARGET_PIN')
        self.allow_role(self.snapshot(), role)
        with self.low.locked(network=True):
            if role == 'origin':
                self.upgrade.write_bytes(self.marker, checks['old_marker_text'].encode(), self.upgrade.mock_private_directory)
            else:
                self.upgrade.write_json(self.marker, checks['states'][role], self.upgrade.mock_private_directory)
        require(self.identity(checks) == {'pin': role, 'marker': role}, 'VIEW_MARKER_SWITCH_NOT_CONFIRMED')

    def _http_body(self, url):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, request, response, code, message, headers, new_url):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(url, headers={'Host': HOST, 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache'})
        with opener.open(request, timeout=5) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            require(response.status == 200 and len(body) <= 2 * 1024 * 1024
                    and not response.headers.get('Content-Encoding'), 'VIEW_HEALTH_BODY_TRANSPORT')
            return body

    def health(self, role, checks):
        self._matching_guard(role, checks)
        self.runtime.health()
        before = self._processes(role, checks)
        root = self.releases[role]
        bodies = {}
        for url, name in (('https://' + HOST + '/', 'platform/dist/index.html'),
                          ('https://' + HOST + '/play/run', 'platform/arena/dist/index.html'),
                          ('http://127.0.0.1:18981/play/run', 'platform/arena/dist/index.html')):
            observed = digest(self._http_body(url))
            require(observed == self.upgrade.digest(root / name), 'VIEW_HEALTH_WRONG_RELEASE_BODY')
            bodies[url] = {'source_body': name, 'sha256': observed}
        after = self._processes(role, checks)
        require(before == after and self.identity(checks) == {'pin': role, 'marker': role}, 'VIEW_HEALTH_PROCESS_CHANGED')
        return {'role': role, 'processes': after, 'bodies': bodies, 'environment': 'sandbox', 'https_verified': True}
