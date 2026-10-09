#!/usr/bin/python3
"""Continue only the independently witnessed 20261010 Created, empty instance."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('oasis_created_provision', HERE / 'provision.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

OLD_RELEASE = '/opt/oasis/releases/20261010-01'
NEW_RELEASE = '/opt/oasis/releases/20261010-02'
OLD_MANIFEST = '999266c0d29be0f3d02443f754c9b62c6cbb46bdac9db78bdae52d956e14fff3'
OLD_MARKER = '13f350ddd05e9515e04bce50a90f40bb7a8c21c0b210e52e038183d2a684f1a7'
OLD_RECEIPT = '95179f504a63d3728fc3c9c02183354dba7621dc514c94dff444dddd13556c24'
OLD_CHECK = '762e357520746166a045d3a44f77e2f103b00262964f95c698265ae954cab5d3'
CID = '2ee98b7bb89bb14a0772f5bed1b6783024241664c367531ee6b52fc22fd86af6'
OWNER = 'f35571b2005dbe05ee68a41e72d11b75'
NETWORK_ID = 'b1b267204ed485591a35284087e738718199f7ae1ee8cc4211f89c904b32cc1e'
IMAGE = 'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb'
OLD_HELPERS = {
    'bootstrap.mjs': '754397b8b4604a66bbcaf5010e1a13ae21675dd024f00b729289019e301abe5a',
    'inspect-backup.mjs': '07adc794f4fdceb393ca9c59f0a70235a34bb444ba3f4e16a2559e1211350c23',
    'monitor.mjs': 'a846a8958d1e29ad8ee4785512642ffc52ce709816a685166c4d95685005afa5',
    'operations.py': '97f080f66417bacaa4f3f3c96b5ccc42efb4ef9100e25f5546240102ddef1329',
    'provision.py': 'a67251f186e28b1b505442cede6f478a6e515ff74a6dbf9ba077ca8ca29d815b',
}
VOLUME_META = {'kind': 'directory', 'uid': 70, 'gid': 70, 'mode': 0o1777,
               'device': 64515, 'inode': 378617}
VOLUME_PATH = Path('/var/lib/docker/volumes/oasis-production-pgdata/_data')
RECOVERY = p.PRIVATE / 'recovery-created-20261010'
RETIRED_SOURCE = Path('/opt/oasis/private/production-stage-20261010-v2/retired-source/retired-source.json')
ARCHIVE_SHA = '195742c54c9e5593bb68b89cea52fdf0183a099505963d6210033fb3dd0e1b25'
PROTECTED_SHA = 'ac5c5769946b8ea08695c56d0106bb6c8d1f562b9e7ec152f3e83fb05375eeac'
RETIRED_SHA = '38ca2031bde2841e4986d23990c5a1991e6aed80f1def613393b8b319cd8d073'
PUBLIC_SNAPSHOT_SHA = '853a6078a3b2e441df8c9b5af6a1cd259bf199028d96fade5beb9f7d370b4a80'
DEPENDENCIES = {'entries': 7861, 'source': '/opt/oasis/releases/20261009-03',
                'tree_sha256': 'c184cd9c6c1e765d4a6b5e35d63615cc6e1b599c91d739c98f9ef931e4d82369'}
PRIVATE_MEMBERS = {'installation.json', 'receipt.json', 'postgres.env', 'runtime.env',
                   'operator-credentials.json', 'state', 'monitor'}


def read_bound(path, expected_sha=None):
    """Read a single root-private inode; do not follow a replaced secret path."""
    before = p.fingerprint(path)
    p.require(before['kind'] == 'file' and before['uid'] == before['gid'] == 0
              and before['mode'] == 0o600 and before['bytes'] <= 2 << 20,
              'RECOVERY_EVIDENCE_FILE_UNSAFE')
    if expected_sha:
        p.require(before['sha256'] == expected_sha, 'RECOVERY_EVIDENCE_HASH_CHANGED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        p.require((opened.st_dev, opened.st_ino) == (before['device'], before['inode'])
                  and stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1,
                  'RECOVERY_EVIDENCE_INODE_CHANGED')
        body = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            body.extend(block)
            p.require(len(body) <= 2 << 20, 'RECOVERY_EVIDENCE_TOO_LARGE')
        after = os.fstat(fd)
        p.require((after.st_mtime_ns, after.st_ctime_ns, after.st_size)
                  == (opened.st_mtime_ns, opened.st_ctime_ns, opened.st_size)
                  and p.digest(body) == before['sha256'] and p.fingerprint(path) == before,
                  'RECOVERY_EVIDENCE_CHANGED_DURING_READ')
        return bytes(body), before
    finally:
        os.close(fd)


def origin_guard(marker, receipt):
    p.require(marker.get('schema') == 1 and marker.get('kind') == 'isolated-production-instance'
              and marker.get('release') == OLD_RELEASE and marker.get('manifest_sha256') == OLD_MANIFEST
              and marker.get('container_id') == CID and marker.get('owner') == OWNER
              and type(marker.get('uid')) is int and marker['uid'] == 997
              and type(marker.get('gid')) is int and marker['gid'] == 999
              and marker.get('network_id') == NETWORK_ID and marker.get('pg_image') == IMAGE
              and marker.get('origins') == ['https://oasis-player.43.98.202.236.sslip.io',
                                           'https://game.tianyahuyu.com'], 'RECOVERY_ORIGINAL_MARKER_INVALID')
    p.require(receipt.get('schema') == 1 and receipt.get('kind') == 'isolated-production-provision'
              and receipt.get('passed') is False and receipt.get('phase') == 'failed_closed'
              and receipt.get('error_code') == 'PROVISION_FAILED'
              and receipt.get('check_sha256') == OLD_CHECK and receipt.get('container_id') == CID
              and receipt.get('source') == OLD_HELPERS
              and receipt.get('history') == [
                  {'at': '2026-10-09T18:23:40.707457+00:00', 'phase': 'namespace_created'},
                  {'at': '2026-10-09T18:23:40.855114+00:00', 'phase': 'database_resources_created'},
                  {'at': '2026-10-09T18:23:41.135722+00:00', 'phase': 'failed_closed'}]
              and not any(key in receipt for key in ('bootstrap', 'units_installed', 'unit_pins', 'backup', 'restore')),
              'RECOVERY_ORIGINAL_FAILED_RECEIPT_INVALID')


def retired_source_guard(path, external_sha):
    p.require(Path(path) == RETIRED_SOURCE and external_sha == RETIRED_SHA,
              'RECOVERY_HISTORY_PATH_OR_EXTERNAL_HASH_INVALID')
    raw, pin = read_bound(path, external_sha)
    value = json.loads(raw)
    p.require(value.get('schema') == 1 and value.get('kind') == 'retired-never-activated-production-candidate'
              and value.get('passed') is True and value.get('release') == OLD_RELEASE
              and value.get('manifest_sha256') == OLD_MANIFEST and value.get('members') == 1158
              and value.get('dependencies_match') == '/opt/oasis/releases/20261009-03'
              and value.get('archive_sha256') == ARCHIVE_SHA and value.get('retired') is True
              and value.get('activated') is False and value.get('original_check_sha256') == OLD_CHECK
              and value.get('protected_inventory_sha256') == PROTECTED_SHA
              and value.get('source_archive_provenance') and value.get('runtime_dependencies') == DEPENDENCIES
              and value.get('protected_before_sha256') == value.get('protected_after_sha256') == PUBLIC_SNAPSHOT_SHA
              and value.get('created_container_id') == CID and value.get('original_helpers') == OLD_HELPERS
              and value.get('marker_sha256') == OLD_MARKER and value.get('failed_receipt_sha256') == OLD_RECEIPT
              and isinstance(value.get('retired_at'), str),
              'RECOVERY_RETIRED_SOURCE_PROOF_INVALID')
    root = Path(path).parent
    meta = p.fingerprint(root)
    p.require(meta['kind'] == 'directory' and meta['uid'] == meta['gid'] == 0
              and meta['mode'] == 0o700, 'RECOVERY_HISTORY_DIRECTORY_UNSAFE')
    p.no_mount(root)
    manifest_raw, manifest_pin = read_bound(root / 'RELEASE-MANIFEST.json', OLD_MANIFEST)
    manifest = json.loads(manifest_raw)
    p.require(isinstance(manifest, dict) and len(manifest) == 1158
              and all(isinstance(name, str) and not Path(name).is_absolute() and '..' not in Path(name).parts
                      and isinstance(sha, str) and re.fullmatch('[a-f0-9]{64}', sha)
                      for name, sha in manifest.items()), 'RECOVERY_HISTORY_MANIFEST_INVALID')
    files = {'retired-source': pin, 'RELEASE-MANIFEST.json': manifest_pin}
    for name, sha in OLD_HELPERS.items():
        p.require(manifest.get('platform/deploy/production-instance/' + name) == sha,
                  'RECOVERY_HISTORY_HELPER_MANIFEST_MISMATCH')
        _, files[name] = read_bound(root / 'helpers' / name, sha)
    helper_meta = p.fingerprint(root / 'helpers')
    p.require(helper_meta['kind'] == 'directory' and helper_meta['uid'] == helper_meta['gid'] == 0
              and helper_meta['mode'] == 0o700, 'RECOVERY_HISTORY_HELPER_DIRECTORY_UNSAFE')
    for name, sha in (('marker-original.json', OLD_MARKER), ('receipt-original.json', OLD_RECEIPT)):
        _, files[name] = read_bound(root / name, sha)
    preservation = {'RELEASE-MANIFEST.json': files['RELEASE-MANIFEST.json'],
                    'marker-original.json': files['marker-original.json'],
                    'receipt-original.json': files['receipt-original.json'],
                    **{'helpers/' + name: files[name] for name in OLD_HELPERS}}
    p.require(value.get('preservation') == preservation, 'RECOVERY_HISTORY_COPY_IDENTITY_CHANGED')
    return {'receipt': value, 'directory': meta, 'helper_directory': helper_meta, 'files': files}


def parse_private_env(body):
    env = {}
    for line in body.decode().splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        p.require(sep and re.fullmatch('[A-Z][A-Z0-9_]*', key) and key not in env
                  and '\x00' not in value and '\r' not in value, 'RECOVERY_ENV_FORMAT_INVALID')
        env[key] = value
    return env


def empty_volume_guard(marker):
    volume = Path(marker['volume_identity']['Mountpoint'])
    p.require(volume == VOLUME_PATH and not any(parent.is_symlink() for parent in volume.parents),
              'RECOVERY_VOLUME_PATH_CHANGED')
    p.no_mount(volume)
    p.require(p.fingerprint(volume) == VOLUME_META and not list(volume.iterdir()),
              'RECOVERY_VOLUME_NOT_ORIGINAL_EMPTY')
    return VOLUME_META


def role_sql(env):
    url = urlsplit(env.get('OASIS_DATABASE_URL', ''))
    password = unquote(url.password or '')
    p.require(url.scheme == 'postgres' and url.hostname == '127.0.0.1' and url.port == 18893
              and url.path == '/' + p.DATABASE and unquote(url.username or '') == p.DB_APP
              and not url.query and not url.fragment and re.fullmatch('[A-Za-z0-9_-]{64}', password),
              'RECOVERY_APP_DATABASE_CONFIG_INVALID')
    return (f"CREATE ROLE {p.DB_APP} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 96 PASSWORD '{password}';\n"
            'REVOKE CONNECT ON DATABASE postgres,template0,template1 FROM PUBLIC;\n'
            f'REVOKE ALL ON DATABASE {p.DATABASE} FROM PUBLIC;\n'
            f'GRANT CONNECT,TEMPORARY ON DATABASE {p.DATABASE} TO {p.DB_APP};\n'
            f'ALTER SCHEMA public OWNER TO {p.DB_APP};\nREVOKE ALL ON SCHEMA public FROM PUBLIC;\n')


class Recovery(p.Provisioner):
    def historical_guard(self):
        p.require(retired_source_guard(self.args.retired_source, self.args.retired_source_sha256)
                  == self.capsule['retired_source'], 'RECOVERY_HISTORY_CHANGED')
        p.require(p.fingerprint(p.PRIVATE / 'receipt.json') == self.capsule['original']['failed_receipt_pin'],
                  'RECOVERY_ORIGINAL_FAILED_RECEIPT_CHANGED')
        if self.receipt:
            p.require(p.fingerprint(RECOVERY) == self.recovery_directory_pin, 'RECOVERY_DIRECTORY_CHANGED')
            for name, pin in self.saved_pins.items():
                p.require(p.fingerprint(RECOVERY / name) == pin, 'RECOVERY_PRESERVED_EVIDENCE_CHANGED')
            if hasattr(self, 'advanced_marker_pin'):
                p.require(p.fingerprint(p.PRIVATE / 'installation.json') == self.advanced_marker_pin,
                          'RECOVERY_ADVANCED_MARKER_CHANGED')

    def created_snapshot(self):
        marker_raw, marker_pin = read_bound(p.PRIVATE / 'installation.json', OLD_MARKER)
        failed_raw, failed_pin = read_bound(p.PRIVATE / 'receipt.json', OLD_RECEIPT)
        marker, failed = json.loads(marker_raw), json.loads(failed_raw)
        origin_guard(marker, failed)
        self.marker = marker
        resources = self.load_operations().owned_resources(marker, self.runtime, created_prestart=True)
        p.require(not os.path.lexists(p.PIN) and not os.path.lexists(RECOVERY)
                  and {x.name for x in p.PRIVATE.iterdir()} == PRIVATE_MEMBERS
                  and {x.name for x in (p.PRIVATE / 'state').iterdir()} == {'master.key'}
                  and not list((p.PRIVATE / 'monitor').iterdir()) and not list(p.BACKUPS.iterdir()),
                  'RECOVERY_CREATED_NAMESPACE_NOT_EMPTY')
        p.unit_namespace_guard()
        states = {name: self.runtime.service(name) for name in p.UNITS}
        p.require(all(not s.get('FragmentPath') and not s.get('DropInPaths')
                      and str(s.get('MainPID') or '0') == '0' and s.get('ActiveState') == 'inactive'
                      and s.get('NeedDaemonReload') == 'no' for s in states.values()),
                  'RECOVERY_OWNED_UNIT_ALREADY_LOADED')
        ports = self.runtime.command(['ss', '-H', '-ltn'])
        p.require(not any(re.search(r':(?:18891|18893)\s', row) for row in ports.splitlines()),
                  'RECOVERY_CREATED_PORT_IN_USE')
        process_uids = self.runtime.command(['ps', '-eo', 'uid=']).split()
        p.require('997' not in process_uids, 'RECOVERY_CREATED_UID_HAS_PROCESS')
        volume_meta = empty_volume_guard(marker)
        directories = {name: p.fingerprint(p.PRIVATE / name) for name in ('state', 'monitor')}
        p.require(directories['state']['uid'] == 997 and directories['state']['gid'] == 999
                  and directories['state']['mode'] == 0o700 and directories['state']['kind'] == 'directory'
                  and directories['monitor']['uid'] == 0 and directories['monitor']['gid'] == 999
                  and directories['monitor']['mode'] == 0o700 and directories['monitor']['kind'] == 'directory',
                  'RECOVERY_PRIVATE_DIRECTORY_CHANGED')
        return {'marker': marker, 'failed_receipt': failed, 'marker_pin': marker_pin,
                'failed_receipt_pin': failed_pin, 'volume': volume_meta, 'resources': resources,
                'directories': directories, 'services': states, 'backup_directory': p.fingerprint(p.BACKUPS)}

    def check(self):
        p.require(str(self.release) == NEW_RELEASE and self.args.pg_image == IMAGE
                  and self.args.origin == 'https://oasis-player.43.98.202.236.sslip.io',
                  'RECOVERY_EXACT_CANDIDATE_REQUIRED')
        p.require(p.digest(Path(self.args.protected_inventory).read_bytes()) == PROTECTED_SHA,
                  'RECOVERY_PROTECTED_INVENTORY_CHANGED')
        release = p.verify_release(self.release, self.args.manifest_sha256)
        own_sha = p.digest(Path(__file__).read_bytes())
        members = json.loads((self.release / 'RELEASE-MANIFEST.json').read_text())
        p.require(members.get('platform/deploy/production-instance/recover-created.py') == own_sha,
                  'RECOVERY_CONTROLLER_NOT_RELEASE_BOUND')
        history = retired_source_guard(self.args.retired_source, self.args.retired_source_sha256)
        protected = self.guard()
        original = self.created_snapshot()
        p.require(original == self.created_snapshot() and protected == self.guard(protected),
                  'RECOVERY_CREATED_STATE_CHANGED')
        disk = os.statvfs(p.BASE)
        budget = self.args.capacity_budget_bytes
        p.require(budget >= 1 << 30 and disk.f_bavail * disk.f_frsize - budget
                  >= max(3 << 30, disk.f_blocks * disk.f_frsize * 0.15), 'PRODUCTION_CAPACITY_RESERVE_FAILED')
        return {'schema': 1, 'kind': 'isolated-production-created-recovery-check', 'at': p.now(),
                'passed': True, 'tool_sha256': own_sha, 'release': str(self.release), **release,
                'protected_inventory_sha256': p.digest(Path(self.args.protected_inventory).read_bytes()),
                'protected': protected, 'retired_source_sha256': self.args.retired_source_sha256,
                'retired_source': history, 'original': original, 'admission_enabled': False,
                'capacity_budget_bytes': budget}

    def event(self, phase, **fields):
        self.receipt['phase'] = phase
        self.receipt['history'].append({'at': p.now(), 'phase': phase, **fields})
        path = RECOVERY / 'receipt.json'
        if os.path.lexists(path):
            p.require(p.fingerprint(path) == self.receipt_pin, 'RECOVERY_RECEIPT_CHANGED')
        tmp = RECOVERY / ('receipt-' + p.secrets.token_hex(8) + '.tmp')
        p.exclusive(tmp, p.canonical(self.receipt))
        os.replace(tmp, path)
        self.receipt_pin = p.fingerprint(path)

    def fresh(self, *, created_prestart=False):
        self.historical_guard()
        super().fresh(created_prestart=created_prestart)

    def preserve_and_advance(self, raw_check):
        RECOVERY.mkdir(mode=0o700)
        os.chmod(RECOVERY, 0o700)
        self.recovery_directory_pin = p.fingerprint(RECOVERY)
        self.saved_pins = {}
        for name, source, sha in (
            ('original-marker.json', p.PRIVATE / 'installation.json', OLD_MARKER),
            ('original-failed-receipt.json', p.PRIVATE / 'receipt.json', OLD_RECEIPT),
            ('retired-source.json', Path(self.args.retired_source), self.args.retired_source_sha256)):
            body, _ = read_bound(source, sha)
            p.exclusive(RECOVERY / name, body)
            self.saved_pins[name] = p.fingerprint(RECOVERY / name)
        p.exclusive(RECOVERY / 'check.json', raw_check)
        self.saved_pins['check.json'] = p.fingerprint(RECOVERY / 'check.json')
        self.receipt = {'schema': 1, 'kind': 'isolated-production-created-recovery', 'at': p.now(),
                        'passed': False, 'check_sha256': self.args.check_sha256,
                        'source': self.capsule['helpers'], 'recovery_tool_sha256': self.capsule['tool_sha256'],
                        'original_failed_receipt_sha256': OLD_RECEIPT, 'original_marker_sha256': OLD_MARKER,
                        'original_manifest_sha256': OLD_MANIFEST, 'container_id': CID, 'history': []}
        self.event('original_evidence_preserved')
        self.historical_guard()
        self.marker = copy.deepcopy(self.capsule['original']['marker'])
        self.marker.update(release=str(self.release), manifest_sha256=self.args.manifest_sha256)
        p.require(p.fingerprint(p.PRIVATE / 'installation.json') == self.capsule['original']['marker_pin'],
                  'RECOVERY_ORIGINAL_MARKER_CHANGED')
        temporary = RECOVERY / 'advanced-marker.tmp'
        p.exclusive(temporary, p.canonical(self.marker))
        p.require(p.fingerprint(p.PRIVATE / 'installation.json') == self.capsule['original']['marker_pin'],
                  'RECOVERY_ORIGINAL_MARKER_CHANGED')
        os.replace(temporary, p.PRIVATE / 'installation.json')
        self.advanced_marker_pin = p.fingerprint(p.PRIVATE / 'installation.json')
        self.event('database_resources_created', source_advanced=True)

    def repair_monitor_directory(self):
        path = p.PRIVATE / 'monitor'
        before = self.capsule['original']['directories']['monitor']
        p.no_mount(path)
        p.require(p.fingerprint(path) == before and not list(path.iterdir()),
                  'RECOVERY_MONITOR_DIRECTORY_CHANGED')
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            p.require(stat.S_ISDIR(opened.st_mode)
                      and (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, stat.S_IMODE(opened.st_mode))
                      == (before['device'], before['inode'], 0, 999, 0o700)
                      and p.fingerprint(path) == before and not os.listdir(fd),
                      'RECOVERY_MONITOR_DIRECTORY_CHANGED')
            os.fchmod(fd, 0o750)
            after = p.fingerprint(path)
            expected = {**before, 'mode': 0o750}
            actual_fd = os.fstat(fd)
            p.require(after == expected and stat.S_IMODE(actual_fd.st_mode) == 0o750
                      and (actual_fd.st_dev, actual_fd.st_ino) == (after['device'], after['inode'])
                      and not os.listdir(fd), 'RECOVERY_MONITOR_PERMISSION_REPAIR_CHANGED')
            self.receipt['monitor_directory_repair'] = {'before': before, 'after': after}
            self.event('database_resources_created', monitor_permissions_repaired=True)
        finally:
            os.close(fd)

    def start_and_bootstrap(self):
        self.fresh(created_prestart=True)
        self.runtime.command(['docker', 'start', CID])
        for _ in range(30):
            try:
                self.runtime.command(['docker', 'exec', CID, 'pg_isready', '-U', p.DB_OWNER, '-d', p.DATABASE])
                break
            except p.Refusal:
                time.sleep(1)
        else:
            raise p.Refusal('PRODUCTION_DATABASE_NOT_READY')
        self.fresh()
        raw_env, _ = read_bound(p.PRIVATE / 'runtime.env', self.marker['private_pins']['runtime.env']['sha256'])
        env = parse_private_env(raw_env)
        self.runtime.command(['docker', 'exec', '-i', CID, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                              '-U', p.DB_OWNER, '-d', p.DATABASE], input=role_sql(env))
        self.fresh()
        p.require(not os.path.lexists(p.PIN), 'RECOVERY_PRODUCTION_PIN_ALREADY_EXISTS')
        os.symlink(str(self.release), p.PIN)
        env['OASIS_BOOTSTRAP_ALLOWED_ORIGINS'] = json.dumps(self.marker['origins'], separators=(',', ':'))
        self.runtime.command(['/usr/bin/node', '--import', str(self.release / 'platform/node_modules/tsx/dist/loader.mjs'),
                              str(self.release / 'platform/deploy/production-instance/bootstrap.mjs'),
                              str(p.PRIVATE / 'operator-credentials.json'), str(p.PRIVATE / 'bootstrap.json')],
                             env=env, timeout=180)
        env.clear()
        result = json.loads((p.PRIVATE / 'bootstrap.json').read_text())
        p.require(result.get('passed') is True and result.get('admission_enabled') is False
                  and result.get('players_created') == 0 and result.get('coins_funded') == '0',
                  'BOOTSTRAP_RECEIPT_INVALID')
        p.require(not any(os.path.lexists(p.PRIVATE / 'state' / name)
                          for name in ('development-credentials.json', 'sandbox-app-credentials.json')),
                  'PRODUCTION_DEVELOPMENT_SEED_PRESENT')
        self.receipt['bootstrap'] = result
        self.event('production_bootstrap_proved')

    def finish_closed(self):
        self.fresh()
        ops = self.load_operations()
        with ops.operations_lock():
            backup = ops.backup(self.marker, self.runtime)
            self.event('backup_created', backup=backup)
            drill = ops.restore(self.marker, Path(backup['path']), self.runtime)
        p.require(drill['passed'] and drill['cleanup']['database_removed'] and drill['cleanup']['temporary_removed'],
                  'PRODUCTION_RESTORE_DRILL_FAILED')
        self.event('restore_proved', drill=drill)
        self.fresh()
        self.install_units()
        self.fresh()
        self.runtime.command(['systemctl', 'enable', '--now', 'oasis-production-db.service',
                              'oasis-production-api.service', 'oasis-production-instance-backup.timer',
                              'oasis-production-instance-monitor.timer'])
        for _ in range(20):
            try:
                self.runtime.http('http://127.0.0.1:18891/health/ready', 200, 'production')
                break
            except p.Refusal:
                time.sleep(1)
        else:
            raise p.Refusal('PRODUCTION_API_NOT_READY')
        self.fresh()
        self.runtime.command(['systemctl', 'start', 'oasis-production-instance-monitor.service'])
        self.receipt.update(passed=True, admission_enabled=False, players_created=0, coins_funded='0',
                            backup=backup, restore=drill, staged_ingress_pending=True)
        self.event('complete_closed')
        return self.receipt

    def apply(self):
        raw, _ = read_bound(Path(self.args.check), self.args.check_sha256)
        capsule = json.loads(raw)
        p.fresh_time(capsule.get('at'))
        p.require(capsule.get('kind') == 'isolated-production-created-recovery-check'
                  and capsule.get('passed') is True and capsule.get('tool_sha256') == p.digest(Path(__file__).read_bytes()),
                  'RECOVERY_CHECK_CONTROLLER_MISMATCH')
        actual = self.check()
        p.require({k: v for k, v in actual.items() if k != 'at'}
                  == {k: v for k, v in capsule.items() if k != 'at'}, 'RECOVERY_CHECK_STATE_CHANGED')
        p.require(self.args.recover_exact_created_closed is True, 'EXPLICIT_CREATED_RECOVERY_REQUIRED')
        self.capsule = capsule
        lock_path = p.BASE / 'private/release.lock'
        fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            pin = capsule['protected']['files'][str(lock_path)]
            p.require(pin['uid'] == pin['gid'] == 0 and pin['mode'] == 0o644,
                      'RECOVERY_SHARED_LOCK_OWNER_CHANGED')
            p.lock_descriptor_guard(fd, lock_path, pin)
            p.fcntl.flock(fd, p.fcntl.LOCK_EX | p.fcntl.LOCK_NB)
            p.lock_descriptor_guard(fd, lock_path, pin)
            locked = self.check()
            p.require({k: v for k, v in locked.items() if k != 'at'}
                      == {k: v for k, v in capsule.items() if k != 'at'}, 'RECOVERY_LOCKED_STATE_CHANGED')
            try:
                self.preserve_and_advance(raw)
                self.repair_monitor_directory()
                self.start_and_bootstrap()
                result = self.finish_closed()
                p.lock_descriptor_guard(fd, lock_path, pin)
                return result
            except Exception as error:
                if self.receipt:
                    self.fail_closed(error)
                raise
        finally:
            os.close(fd)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('mode', choices=('check', 'apply'))
    result.add_argument('--release', required=True)
    result.add_argument('--manifest-sha256', required=True)
    result.add_argument('--protected-inventory', required=True)
    result.add_argument('--retired-source', required=True)
    result.add_argument('--retired-source-sha256', required=True)
    result.add_argument('--origin', required=True)
    result.add_argument('--pg-image', required=True)
    result.add_argument('--capacity-budget-bytes', type=int, default=1 << 30)
    result.add_argument('--check')
    result.add_argument('--check-sha256')
    result.add_argument('--recover-exact-created-closed', action='store_true')
    return result


def main():
    args = parser().parse_args()
    os.umask(0o077)
    try:
        p.require(os.getuid() == 0, 'ROOT_REQUIRED')
        tool = Recovery(args)
        result = tool.apply() if args.mode == 'apply' else tool.check()
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'passed': False, 'error_code': str(error) if isinstance(error, p.Refusal)
                          else 'CREATED_RECOVERY_INTERNAL_ERROR'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
