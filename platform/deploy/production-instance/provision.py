#!/usr/bin/python3
"""Create one isolated, closed production runtime. No public ingress writes or data migration."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import secrets
import shlex
import stat
import subprocess
import sys
import time
import urllib.request
import urllib.error
import ssl
import socket

BASE = Path('/opt/oasis')
PRIVATE = BASE / 'production-instance-private'
BACKUPS = BASE / 'production-backups'
PIN = BASE / 'production-current'
OWNER = 'oasis-prod'
CONTAINER = 'oasis-production-postgres'
VOLUME = 'oasis-production-pgdata'
NETWORK = 'oasis-production-internal'
NETWORK_OPTIONS = {'com.docker.network.bridge.host_binding_ipv4':'127.0.0.1'}
PG_PORT_BINDINGS = {'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'18893'}]}
DATABASE = 'oasis_production'
DB_OWNER = 'oasis_prod_owner'
DB_APP = 'oasis_prod_app'
LABEL = 'com.oasis.production-instance.owner'
RETIRE_SHA = '931dfadda3577244b434ee86c74f95cf3e66053362ff61ac10f207d69737c920'
RETIRE = BASE / 'private/mock-retirement-20261010/receipt.json'
UNITS = ('oasis-production-db.service', 'oasis-production-api.service',
         'oasis-production-instance-backup.service', 'oasis-production-instance-backup.timer',
         'oasis-production-instance-monitor.service', 'oasis-production-instance-monitor.timer')
HELPERS = ('provision.py', 'bootstrap.mjs', 'operations.py', 'inspect-backup.mjs', 'monitor.mjs')
PUBLIC_UNITS = ('oasis-api.service', 'oasis-demo.service', 'nginx.service', 'oasis-production.service')
REQUIRED_PINS = (
 '/opt/oasis/current', '/opt/oasis/private', '/opt/oasis/private/runtime.env',
 '/opt/oasis/private/state/master.key', '/opt/oasis/private/postgres.env',
 '/opt/oasis/private/release.lock',
 '/opt/oasis/private/last-release.json', '/opt/oasis/private/static-assets-head.json',
 '/etc/nginx/conf.d/oasis.conf', '/etc/nginx/conf.d/oasis-android-mock.conf',
 str(RETIRE), '/opt/oasis/private/mock-retirement-20261010/failed-v5-receipt.json',
 '/opt/oasis/private/mock-retirement-20261010/failed-v6-receipt.json',
 '/opt/oasis/acme/config/live/oasis-android-mock/fullchain.pem',
 '/opt/oasis/acme/config/live/oasis-android-mock/privkey.pem',
 '/opt/oasis/backups/20261009T155133Z',
 '/opt/oasis/releases/20261009-02/RELEASE-MANIFEST.json',
 '/opt/oasis/releases/20261009-03/RELEASE-MANIFEST.json',
 '/opt/oasis/releases/20261008-23/RELEASE-MANIFEST.json',
 '/opt/oasis/releases/20261008-24/RELEASE-MANIFEST.json')

class Refusal(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Refusal(code)

def require_pg_host_tcp():
    # Verify the same host endpoint used by Node, rather than a container socket
    # or the temporary Unix-only server used by the PostgreSQL entrypoint.
    try:
        with socket.create_connection(('127.0.0.1',18893),timeout=3):
            pass
    except OSError:
        raise Refusal('PRODUCTION_PG_HOST_TCP_NOT_READY') from None

def digest(value):
    return hashlib.sha256(value).hexdigest()

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def fresh_time(value, seconds=600, now=None):
    try:
        age = (now or dt.datetime.now(dt.timezone.utc)).timestamp() - dt.datetime.fromisoformat(value).timestamp()
    except (ValueError, TypeError):
        raise Refusal('CHECK_TIMESTAMP_INVALID')
    require(0 <= age <= seconds, 'CHECK_NOT_FRESH')

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def no_mount(path, mountinfo=None):
    text = mountinfo if mountinfo is not None else Path('/proc/self/mountinfo').read_text()
    root = str(path)
    for line in text.splitlines():
        cols = line.split()
        require(len(cols) >= 6, 'MOUNTINFO_INVALID')
        point = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), cols[4])
        require(point != root and not point.startswith(root + '/'), 'OWNED_PATH_MOUNTED')

def fingerprint(path, *, links=False):
    p = Path(path)
    s = p.lstat()
    value = {'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode),
             'device': s.st_dev, 'inode': s.st_ino}
    if stat.S_ISLNK(s.st_mode):
        require(links, 'SYMLINK_REJECTED')
        target = p.resolve(strict=True)
        value.update(kind='symlink', target=os.readlink(p), leaf=str(target), leaf_metadata=fingerprint(target))
    elif stat.S_ISDIR(s.st_mode):
        value.update(kind='directory')
    else:
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'REGULAR_SINGLE_LINK_REQUIRED')
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            require((before.st_dev, before.st_ino) == (s.st_dev, s.st_ino), 'FILE_IDENTITY_CHANGED')
            h = hashlib.sha256()
            while True:
                block = os.read(fd, 1 << 20)
                if not block:
                    break
                h.update(block)
            require(os.fstat(fd).st_mtime_ns == before.st_mtime_ns, 'FILE_CHANGED_DURING_HASH')
            value.update(kind='file', bytes=s.st_size, sha256=h.hexdigest())
        finally:
            os.close(fd)
    return value

def exclusive(path, data, mode=0o600, uid=0, gid=0):
    # Requested modes must survive umask 077; guards never accept an inferred mode.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
        require(stat.S_IMODE(os.fstat(fd).st_mode) == mode, 'OWNED_FILE_MODE_READBACK_FAILED')
    finally:
        os.close(fd)

def lock_descriptor_guard(fd,path,expected):
    s=os.fstat(fd)
    require(stat.S_ISREG(s.st_mode) and s.st_nlink==1
            and {'device':s.st_dev,'inode':s.st_ino,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}
                =={key:expected[key] for key in ('device','inode','uid','gid','mode')}
            and fingerprint(path)==expected,'SHARED_DEPLOY_LOCK_REPLACED')

def validate_origin(value):
    from urllib.parse import urlsplit
    u = urlsplit(value)
    require(u.scheme == 'https' and u.hostname and not u.username and not u.password
            and not u.path and not u.query and not u.fragment and value == 'https://' + u.netloc
            and re.fullmatch(r'[A-Za-z0-9.-]+(?::443)?', u.netloc), 'HTTPS_ORIGIN_REQUIRED')
    return value

def parse_env(path):
    require(fingerprint(path)['mode'] == 0o600, 'ENV_MODE_UNSAFE')
    result = {}
    for line in Path(path).read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        require(sep and re.fullmatch('[A-Z][A-Z0-9_]*', key) and key not in result
                and '\x00' not in value and '\r' not in value, 'ENV_FORMAT_INVALID')
        result[key] = value
    return result

SYSTEMD_ROOTS=('/etc/systemd/system','/run/systemd/system','/run/systemd/transient','/run/systemd/system.control',
               '/etc/systemd/system.control','/usr/lib/systemd/system','/lib/systemd/system')
def owned_unit_reference(value):
    return 'oasis-production-instance-' in value or any(name in value for name in UNITS)

def enabled_link_guard(path,allowed,systemd=Path('/etc/systemd/system')):
    target_parent=systemd/('timers.target.wants' if path.name.endswith('.timer') else 'multi-user.target.wants')
    require(path.parent==target_parent
            and path.name in ('oasis-production-api.service','oasis-production-db.service',
                              'oasis-production-instance-backup.timer','oasis-production-instance-monitor.timer')
            and path.name in allowed and path.resolve(strict=True)==systemd/path.name,'FOREIGN_PRODUCTION_UNIT_LINK')

def unit_namespace_guard(templates=None):
    allowed=templates or {}
    for root in SYSTEMD_ROOTS:
        for path in Path(root).rglob('*'):
            if path.is_symlink():
                target=os.readlink(path)
                if owned_unit_reference(path.name) or owned_unit_reference(target):
                    enabled_link_guard(path,allowed)
            elif path.is_file():
                if path==Path('/etc/systemd/system')/path.name and path.name in allowed:
                    meta=fingerprint(path)
                    require(meta['uid']==0 and meta['mode']==0o644 and meta['sha256']==digest(allowed[path.name].encode()),'OWNED_UNIT_CONTENT_CHANGED')
                else:
                    require(not owned_unit_reference(path.name) and not owned_unit_reference(path.read_text(errors='replace')),
                            'FOREIGN_PRODUCTION_UNIT_DEPENDENCY')
            elif path.is_dir():
                require(not owned_unit_reference(path.name),'FOREIGN_PRODUCTION_UNIT_DIRECTORY')

def unit_object_path(name):
    return '/org/freedesktop/systemd1/unit/'+''.join(c if c.isascii() and c.isalnum() else '_'+format(ord(c),'02x') for c in name)

def expected_commands(template):
    return {key:[[parts[0],parts,False] for parts in [shlex.split(line.partition('=')[2]) for line in template.splitlines() if line.startswith(key+'=')]]
            for key in ('ExecStartPre','ExecStart','ExecStartPost','ExecStop','ExecStopPost')}

def account_guard(marker):
    user=pwd.getpwnam(OWNER);group=grp.getgrnam(OWNER)
    require(user.pw_uid==marker['uid'] and user.pw_gid==marker['gid']==group.gr_gid
            and user.pw_dir==str(PRIVATE) and user.pw_shell=='/usr/sbin/nologin'
            and [p.pw_name for p in pwd.getpwall() if p.pw_uid==user.pw_uid]==[OWNER]
            and [g.gr_name for g in grp.getgrall() if g.gr_gid==group.gr_gid]==[OWNER]
            and not group.gr_mem and not any(p.pw_gid==group.gr_gid and p.pw_name!=OWNER for p in pwd.getpwall())
            and not any(OWNER in g.gr_mem for g in grp.getgrall()),'PRODUCTION_UID_OR_GROUP_NOT_EXCLUSIVE')

class Runtime:
    def command(self, args, *, input=None, env=None, timeout=60, binary=False):
        clean = {key: value for key, value in os.environ.items()
                 if not key.lower().endswith('_proxy') and key not in ('NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
                 'PYTHONHOME', 'PYTHONPATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH','DBUS_SYSTEM_BUS_ADDRESS','DBUS_SESSION_BUS_ADDRESS','SSL_CERT_FILE','SSL_CERT_DIR','ENV','BASH_ENV')}
        clean.update({'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        if env:
            clean.update(env)
        try:
            result = subprocess.run(args, input=input, capture_output=True, text=not binary,
                                    timeout=timeout, env=clean, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Refusal('COMMAND_UNAVAILABLE_OR_TIMEOUT')
        require(result.returncode == 0, 'COMMAND_FAILED_' + Path(args[0]).name.upper().replace('-', '_'))
        return result.stdout

    def inspect(self, kind, name):
        return json.loads(self.command(['docker', kind, 'inspect', name]))[0]

    def names(self, kind):
        fmt = '{{.Names}}' if kind == 'container' else '{{.Name}}'
        return set(self.command(['docker', kind, 'ls', *(['-a'] if kind == 'container' else []), '--format', fmt]).splitlines())

    def service(self, name):
        raw = self.command(['systemctl', 'show', name, '--no-pager', '--property=MainPID,ActiveState,FragmentPath,DropInPaths,NeedDaemonReload'])
        result = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        pid = int(result.get('MainPID') or 0)
        if pid:
            p = Path('/proc') / str(pid)
            fields = (p / 'stat').read_text().rsplit(')', 1)[1].split()
            result['process'] = {'pid': pid, 'start_ticks': fields[19], 'cwd': os.readlink(p / 'cwd'),
                                 'exe': os.readlink(p / 'exe'), 'uid': (p / 'status').read_text().split('Uid:')[1].split()[0]}
        return result

    def loaded_commands(self,name):
        # One persistent sender holds exact unit metadata through inactive-unit GC.
        import dbus
        saved={key:os.environ.pop(key) for key in ('DBUS_SYSTEM_BUS_ADDRESS','DBUS_SESSION_BUS_ADDRESS') if key in os.environ}
        bus=None;manager=None;referenced=False
        try:
            bus=dbus.SystemBus(private=True)
            manager=dbus.Interface(bus.get_object('org.freedesktop.systemd1','/org/freedesktop/systemd1'),'org.freedesktop.systemd1.Manager')
            manager.RefUnit(name,timeout=30);referenced=True
            found=manager.GetUnit(name,timeout=30)
            require(isinstance(found,dbus.ObjectPath) and str(found)==unit_object_path(name),'OWNED_LOADED_UNIT_IDENTITY_CHANGED')
            props=dbus.Interface(bus.get_object('org.freedesktop.systemd1',found),'org.freedesktop.DBus.Properties')
            reload=props.Get('org.freedesktop.systemd1.Unit','NeedDaemonReload',timeout=30)
            require(isinstance(reload,dbus.Boolean) and not bool(reload),'OWNED_UNIT_RELOAD_NEEDED')
            result={}
            for key in ('PartOf','BindsTo','DropInPaths'):
                values=props.Get('org.freedesktop.systemd1.Unit',key,timeout=30)
                require(isinstance(values,dbus.Array) and str(values.signature)=='s' and not values,'OWNED_LOADED_FOREIGN_DEPENDENCY')
            if name.endswith('.service'):
                types=(dbus.String,dbus.Array,dbus.Boolean,dbus.UInt64,dbus.UInt64,dbus.UInt64,dbus.UInt64,dbus.UInt32,dbus.Int32,dbus.Int32)
                for key in ('ExecStartPre','ExecStart','ExecStartPost','ExecStop','ExecStopPost'):
                    array=props.Get('org.freedesktop.systemd1.Service',key,timeout=30)
                    require(isinstance(array,dbus.Array) and str(array.signature)=='(sasbttttuii)','OWNED_LOADED_COMMAND_SHAPE_UNKNOWN')
                    result[key]=[]
                    for row in array:
                        require(isinstance(row,dbus.Struct) and len(row)==10 and all(isinstance(item,kind) for item,kind in zip(row,types))
                                and str(row[1].signature)=='s' and all(isinstance(arg,dbus.String) for arg in row[1]),'OWNED_LOADED_COMMAND_ROW_UNKNOWN')
                        result[key].append([str(row[0]),[str(arg) for arg in row[1]],bool(row[2])])
            return result
        finally:
            try:
                if referenced:manager.UnrefUnit(name,timeout=30)
            finally:
                if bus is not None:bus.close()
                os.environ.update(saved)

    def http(self, url, status, environment=None):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        try:
            response = opener.open(urllib.request.Request(url, method='GET'), timeout=8)
        except urllib.error.HTTPError as response_error:
            response = response_error
        except (urllib.error.URLError,TimeoutError,OSError):
            raise Refusal('PROTECTED_HTTP_UNAVAILABLE')
        with response:
            require(response.status == status and response.geturl() == url, 'PROTECTED_HTTP_FAILED')
            if environment:
                value = json.loads(response.read(131073))
                require(value.get('status') == 'ok' and value.get('environment') == environment, 'PROTECTED_HEALTH_CHANGED')

    def protect(self, paths):
        result = {'files': {p: fingerprint(p, links=True) for p in paths},
                  'services': {name: self.service(name) for name in PUBLIC_UNITS}, 'containers': {}}
        for name in ('oasis-postgres', 'proxy-nginx'):
            c = self.inspect('container', name)
            require(c['State']['Running'] is True, 'SHARED_CONTAINER_NOT_RUNNING')
            result['containers'][name] = {key: c[key] for key in ('Id', 'Image', 'Mounts')}
            result['containers'][name]['networks'] = {k: {'NetworkID': v['NetworkID']} for k, v in c['NetworkSettings']['Networks'].items()}
        nginx = sorted(str(p) for p in Path('/etc/nginx').rglob('*') if p.is_file() or p.is_symlink())
        result['nginx'] = {p: fingerprint(p, links=True) for p in nginx}
        proxy = result['containers']['proxy-nginx']['Id']
        raw = self.command(['docker', 'exec', proxy, 'sh', '-c', 'find /etc/nginx -type f -exec sha256sum {} + | LC_ALL=C sort'])
        require(all(re.fullmatch(r'[a-f0-9]{64}  /etc/nginx/[^\n]+', row) for row in raw.splitlines()), 'PROXY_CONFIG_SCAN_INVALID')
        result['proxy_nginx_files'] = raw.splitlines()
        public_id=result['containers']['oasis-postgres']['Id']
        fields="'pending_rooms',(SELECT count(*) FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')),'pending_cycles',(SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')),'pending_gp_operations',(SELECT count(*) FROM gp_operations WHERE state='PENDING'),'pending_pvp_operations',(SELECT count(*) FROM pvp_operations WHERE state='PENDING'),'pending_integration_checks',(SELECT count(*) FROM gp_integration_checks WHERE status IN ('QUEUED','RUNNING')),'pending_reservations',(SELECT count(*) FROM wallet_reservations WHERE state='RESERVED'),'pending_wallet_matches',(SELECT count(*) FROM wallet_matches WHERE state NOT IN ('SETTLED','VOIDED','CANCELLED')),'pending_wallet_probability',(SELECT count(*) FROM wallet_probability WHERE state NOT IN ('SETTLED','CANCELLED','EXPIRED')),'pending_reserved_balances',(SELECT count(*) FROM wallet_users WHERE reserved<>0 OR credit_pending<>0)"
        query=f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT count(*)=0 AS absent,count(*)=5 AS present FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('gp_transfer_bindings','gp_transfer_accounts','gp_transfers','gp_transfer_outbox','wallet_transfer_clearing')
\\gset
\\if :absent
SELECT json_build_object('environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),'non_sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment!='sandbox'),{fields},'transfer_schema','absent','pending_transfers',0,'pending_inbound_minor',0,'pending_outbound_minor',0,'stray_transfer_ledger',(SELECT count(*) FROM wallet_ledger WHERE account LIKE 'transfer:%' OR meta->>'kind' LIKE 'transfer_%'));
\\else
\\if :present
SELECT json_build_object('environment',(SELECT environment FROM gp_runtime_identity WHERE singleton),'non_sandbox_apps',(SELECT count(*) FROM gp_apps WHERE environment!='sandbox'),{fields},'transfer_schema','present','pending_transfers',(SELECT count(*) FROM gp_transfers WHERE state='PENDING'),'pending_inbound_minor',(SELECT coalesce(sum(amount_minor),0) FROM gp_transfers WHERE state='PENDING' AND direction='IN'),'pending_outbound_minor',(SELECT coalesce(sum(amount_minor),0) FROM gp_transfers WHERE state='PENDING' AND direction='OUT'),'stray_transfer_ledger',0);
\\else
DO $guard$ BEGIN RAISE EXCEPTION 'TRANSFER_SCHEMA_INCOMPLETE'; END $guard$;
\\endif
\\endif
COMMIT;
"""
        rows=[json.loads(row) for row in self.command(['docker','exec','-i',public_id,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','oasis','-d','oasis_platform'],input=query).splitlines() if row.startswith('{')]
        require(len(rows)==1 and rows[0].get('environment')=='sandbox' and rows[0].get('non_sandbox_apps')==0
                and rows[0].get('transfer_schema') in ('present','absent')
                and all(type(value) is int and value>=0 for key,value in rows[0].items() if key not in ('environment','transfer_schema')),'PUBLIC_DATABASE_ISOLATION_INVALID')
        result['public_pending_obligations']=rows[0]
        backup=Path('/opt/oasis/backups/20261009T155133Z')
        no_mount(backup)
        result['preserved_backup']={str(item.relative_to(backup)):fingerprint(item) for item in sorted(backup.rglob('*'))}
        self.http('https://game.tianyahuyu.com/health', 200, 'sandbox')
        self.http('https://game.tianyahuyu.com/demo/', 200)
        for route in ('/health', '/demo/', '/api/demo/config', '/'):
            self.http('https://oasis-mock.43.98.202.236.sslip.io' + route, 410)
        return result

def validate_protected(value):
    require(isinstance(value, dict) and value.get('kind') == 'production-protected-inventory'
            and isinstance(value.get('paths'), list) and len(value['paths']) == len(set(value['paths']))
            and set(REQUIRED_PINS) <= set(value['paths'])
            and all(isinstance(p, str) and p.startswith(('/opt/oasis/', '/etc/nginx/')) and '..' not in Path(p).parts
                    and not p.startswith((str(PRIVATE), str(BACKUPS), str(PIN))) for p in value['paths']), 'PROTECTED_INVENTORY_INVALID')
    # Root supplies precise actual public master/postgres paths, not copied data.
    require('/opt/oasis/private/state/master.key' in value['paths']
            and '/opt/oasis/private/postgres.env' in value['paths'], 'PROTECTED_DATABASE_SECRET_PINS_REQUIRED')
    require(value.get('current') == '/opt/oasis/releases/20261009-03'
            and value.get('previous') == '/opt/oasis/releases/20261009-02'
            and value.get('retirement_receipt_sha256') == RETIRE_SHA, 'PROTECTED_RELEASE_ROLE_INVALID')
    return value

def owned_namespace_free(runtime):
    for path in (PRIVATE, BACKUPS, PIN, *[Path('/etc/systemd/system') / unit for unit in UNITS]):
        require(not path.exists() and not path.is_symlink(), 'PRODUCTION_NAMESPACE_ALREADY_EXISTS')
    require(OWNER not in {p.pw_name for p in pwd.getpwall()} and OWNER not in {g.gr_name for g in grp.getgrall()}, 'PRODUCTION_UID_ALREADY_EXISTS')
    for kind, name in (('container', CONTAINER), ('volume', VOLUME), ('network', NETWORK)):
        require(name not in runtime.names(kind), 'PRODUCTION_DOCKER_NAMESPACE_ALREADY_EXISTS')
    ports = runtime.command(['ss', '-H', '-ltn'])
    require(not any(re.search(r':(?:18891|18893)\s', row) for row in ports.splitlines()), 'PRODUCTION_PORT_IN_USE')
    for unit in UNITS:
        s = runtime.service(unit)
        require(not s.get('FragmentPath') and not s.get('DropInPaths') and not int(s.get('MainPID') or 0), 'PRODUCTION_LOADED_UNIT_EXISTS')

def verify_release(release, manifest_sha):
    require(re.fullmatch(r'/opt/oasis/releases/\d{8}-\d{2}', str(release)) and not release.is_symlink(), 'IMMUTABLE_RELEASE_REQUIRED')
    manifest = fingerprint(release / 'RELEASE-MANIFEST.json')
    require(manifest['sha256'] == manifest_sha, 'RELEASE_MANIFEST_CHANGED')
    members = json.loads((release / 'RELEASE-MANIFEST.json').read_text())
    require(isinstance(members,dict) and all(isinstance(name,str) and not Path(name).is_absolute()
            and '..' not in Path(name).parts and isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value)
            for name,value in members.items()),'RELEASE_MANIFEST_MEMBER_INVALID')
    required = ['platform/server/index.mjs', 'platform/server/runtime-mode.mjs', 'platform/server/platform.mjs',
                'platform/server/db.mjs', 'platform/server/schema.sql', 'platform/package-lock.json',
                *['platform/deploy/production-instance/' + name for name in HELPERS]]
    # Verify every executable/schema/config source the listening backend may import.
    # Built media retains the root release/artifact verification; it is not rehashed each phase.
    required=list(set(required)|{name for name in members if name.startswith(('platform/server/','platform/shared/','src/','platform/arena/','platform/specs/'))
                                and Path(name).suffix in ('.mjs','.js','.ts','.json','.sql') and '/dist/' not in name})
    for name in required:
        p = release / name
        require(name in members and fingerprint(p)['sha256'] == members[name], 'RELEASE_MEMBER_CHANGED')
    here = Path(__file__).resolve().parent
    require(all(digest((here / name).read_bytes()) == members['platform/deploy/production-instance/' + name] for name in HELPERS), 'CONTROLLER_NOT_RELEASE_BOUND')
    require((release / 'platform/node_modules/tsx/dist/loader.mjs').is_file(), 'RELEASE_RUNTIME_DEPENDENCIES_MISSING')
    return {'manifest_sha256': manifest_sha, 'helpers': {name: members['platform/deploy/production-instance/' + name] for name in HELPERS}}

class Provisioner:
    def __init__(self, args, runtime=None):
        self.args = args
        self.runtime = runtime or Runtime()
        self.release = Path(args.release or '.')
        self.protected = validate_protected(json.loads(Path(args.protected_inventory).read_text()))
        self.receipt = None

    def guard(self, expected=None):
        require(str((BASE / 'current').resolve(strict=True)) == self.protected['current'], 'PUBLIC_CURRENT_CHANGED')
        last = json.loads((BASE / 'private/last-release.json').read_text())
        require(last.get('current') == self.protected['current'] and last.get('previous') == self.protected['previous']
                and last.get('health') == 'passed', 'PUBLIC_RELEASE_ROLES_CHANGED')
        require(fingerprint(RETIRE)['sha256'] == RETIRE_SHA, 'MOCK_RETIREMENT_RECEIPT_CHANGED')
        require(fingerprint(BASE/'private/state/master.key')['sha256']=='543967ae6c8beafdeb601278234b993cb8af776da3a0de546e6f1a181b994628'
                and fingerprint(BASE/'private/postgres.env')['sha256']=='a4a65fc07047dd14e343909e67b2089193b4b4a0e824a51b22e1d4992689096b','PUBLIC_DATABASE_SECRET_CHANGED')
        retire = json.loads(RETIRE.read_text())
        require(retire.get('passed') is True and retire.get('phase') == 'complete', 'MOCK_NOT_RETIRED')
        current = self.runtime.protect(self.protected['paths'])
        private_meta=current['files']['/opt/oasis/private']
        require(private_meta['mode']==0o700 and private_meta['uid']==private_meta['gid']==998, 'SHARED_PRIVATE_MODE_CHANGED')
        if expected:
            require(current == expected, 'PROTECTED_STATE_CHANGED')
        elif self.protected.get('snapshot'):
            require(current == self.protected['snapshot'], 'PROTECTED_INVENTORY_SNAPSHOT_CHANGED')
        return current

    def check(self, *, inventory=False):
        require(inventory or isinstance(self.protected.get('snapshot'),dict),'REVIEWED_PROTECTED_SNAPSHOT_REQUIRED')
        validate_origin(self.args.origin)
        origins = list(dict.fromkeys([self.args.origin, 'https://game.tianyahuyu.com']))
        require(re.fullmatch('sha256:[a-f0-9]{64}', self.args.pg_image), 'CACHED_IMAGE_ID_REQUIRED')
        image = self.runtime.inspect('image', self.args.pg_image)
        require(image['Id'] == self.args.pg_image and image.get('Os') == 'linux' and image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.title', '').lower() != 'oasis', 'POSTGRES_IMAGE_ID_INVALID')
        require(any(x == 'PG_MAJOR=16' for x in image.get('Config', {}).get('Env', [])), 'POSTGRES_16_IMAGE_REQUIRED')
        release = verify_release(self.release, self.args.manifest_sha256)
        owned_namespace_free(self.runtime)
        protected = self.guard()
        require(all(unit.get('NeedDaemonReload')=='no' for unit in protected['services'].values()),'SHARED_UNITS_AWAIT_RELOAD')
        unit_namespace_guard()
        disk = os.statvfs(BASE)
        budget = self.args.capacity_budget_bytes
        require(budget >= 1 << 30 and disk.f_bavail * disk.f_frsize - budget >= max(3 << 30, disk.f_blocks * disk.f_frsize * 0.15), 'PRODUCTION_CAPACITY_RESERVE_FAILED')
        require(Path('/usr/bin/node').is_file() and Path('/usr/sbin/runuser').is_file(), 'HOST_RUNTIME_MISSING')
        for path in (BASE, Path('/etc/systemd/system')):
            s = path.lstat()
            require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022, 'OWNED_PARENT_UNSAFE')
        return {'schema': 1, 'kind': 'isolated-production-provision-inventory' if inventory else 'isolated-production-provision-check', 'at': now(), 'passed': True,
                'tool_sha256': digest(Path(__file__).read_bytes()), 'release': str(self.release), **release,
                'protected_inventory_sha256': digest(Path(self.args.protected_inventory).read_bytes()),
                'protected': protected, 'pg_image': self.args.pg_image, 'origins': origins,
                'admission_enabled': False, 'capacity_budget_bytes': budget,
                'capacity': {'available_bytes': disk.f_bavail * disk.f_frsize, 'total_bytes': disk.f_blocks * disk.f_frsize}}

    def event(self, phase, **fields):
        self.receipt['phase'] = phase
        self.receipt['history'].append({'at': now(), 'phase': phase, **fields})
        # Only our own inode is replaced, never an unknown file or failed history.
        p = PRIVATE / 'receipt.json'
        if p.exists():
            require(fingerprint(p) == self.receipt_pin, 'OWNED_RECEIPT_CHANGED')
        tmp = PRIVATE / ('receipt-' + secrets.token_hex(8) + '.tmp')
        exclusive(tmp, canonical(self.receipt))
        os.replace(tmp, p)
        self.receipt_pin = fingerprint(p)

    def fresh(self, *, created_prestart=False):
        if created_prestart:
            require(self.receipt.get('phase')=='database_resources_created'
                    and not self.receipt.get('bootstrap') and not self.receipt.get('units_installed')
                    and not os.path.lexists(PIN) and not os.path.lexists(PRIVATE/'bootstrap.json'),
                    'PRODUCTION_PRESTART_PHASE_CHANGED')
        self.guard(self.capsule['protected'])
        verify_release(self.release, self.args.manifest_sha256)
        marker = json.loads((PRIVATE / 'installation.json').read_text())
        require(marker == self.marker, 'PRODUCTION_OWNERSHIP_CHANGED')
        require(PIN.is_symlink() and str(PIN.resolve(strict=True))==str(self.release),'PRODUCTION_RELEASE_PIN_CHANGED') if self.receipt.get('bootstrap') else None
        if self.marker.get('private_pins'):
            require(all(fingerprint(PRIVATE/name)==value for name,value in self.marker['private_pins'].items()),'PRODUCTION_PRIVATE_CONFIG_CHANGED')
        if self.receipt.get('unit_pins'):
            require(all(fingerprint(Path('/etc/systemd/system')/name)==value for name,value in self.receipt['unit_pins'].items()),'PRODUCTION_OWNED_UNIT_CHANGED')
            self.loaded_unit_guard()
        no_mount(PRIVATE); no_mount(BACKUPS)
        if self.receipt.get('container_id'):
            from_operations = self.load_operations()
            from_operations.owned_resources(self.marker, self.runtime,created_prestart=created_prestart)

    def load_operations(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('oasis_production_operations', Path(__file__).with_name('operations.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        # Both helpers are release-bound; use the executing controller's exact
        # exception class rather than masking a second import's typed refusal.
        module.p.Refusal = Refusal
        return module

    def fail_closed(self,error):
        failed_at=self.receipt.get('phase')
        self.receipt['error_code']=str(error) if isinstance(error,Refusal) else 'PROVISION_FAILED'
        self.receipt['failed_at_phase']=failed_at
        self.event('failed_closed')
        try:
            # Scope-limited stop only. Never delete data or suppress the primary
            # failure when a second ownership/stop guard correctly refuses.
            if self.receipt.get('units_installed'):
                self.loaded_unit_guard()
                self.runtime.command(['systemctl','stop','oasis-production-api.service','oasis-production-instance-monitor.timer','oasis-production-instance-backup.timer'])
            if self.receipt.get('container_id'):
                prestart=failed_at=='database_resources_created' and not self.receipt.get('bootstrap') and not self.receipt.get('units_installed')
                # This phase also covers role/bootstrap failures after start;
                # never apply the Created exception to a running database.
                created=prestart and self.runtime.inspect('container',self.marker['container_id']).get('State',{}).get('Status')=='created'
                resources=self.load_operations().owned_resources(self.marker,self.runtime,
                    created_prestart=created)
                if resources['running']:
                    self.runtime.command(['docker','stop','--time','30',self.marker['container_id']])
        except Exception as cleanup_error:
            self.receipt['cleanup_error_code']=str(cleanup_error) if isinstance(cleanup_error,Refusal) else 'PROVISION_FAILURE_STOP_FAILED'
            self.event('failed_closed',stop_refused=True,cleanup_error_code=self.receipt['cleanup_error_code'])

    def apply(self):
        raw = Path(self.args.check).read_bytes()
        require(digest(raw) == self.args.check_sha256, 'CHECK_EXTERNAL_HASH_MISMATCH')
        capsule = json.loads(raw); fresh_time(capsule.get('at'))
        require(capsule.get('kind') == 'isolated-production-provision-check' and capsule.get('passed') is True
                and capsule.get('tool_sha256') == digest(Path(__file__).read_bytes()), 'CHECK_CONTROLLER_MISMATCH')
        actual = self.check()
        require({k:v for k,v in actual.items() if k not in ('at', 'capacity')} == {k:v for k,v in capsule.items() if k not in ('at', 'capacity')}, 'CHECK_INPUT_OR_STATE_CHANGED')
        require(self.args.create_isolated_production_closed is True, 'EXPLICIT_ISOLATED_APPLY_REQUIRED')
        self.capsule = capsule
        # Shared deployment serialization; do not create/rewrite its lock file.
        lock_path = BASE / 'private/release.lock'
        require(lock_path.is_file() and not lock_path.is_symlink(), 'EXISTING_DEPLOY_LOCK_REQUIRED')
        lock = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            lock_descriptor_guard(lock,lock_path,capsule['protected']['files'][str(lock_path)])
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            lock_descriptor_guard(lock,lock_path,capsule['protected']['files'][str(lock_path)])
            owned_namespace_free(self.runtime); self.guard(capsule['protected'])
            PRIVATE.mkdir(mode=0o700); BACKUPS.mkdir(mode=0o700)
            self.marker = {'schema':1, 'kind':'isolated-production-instance', 'owner':secrets.token_hex(16),
                           'release':str(self.release), 'manifest_sha256':self.args.manifest_sha256,
                           'origins':capsule['origins'], 'pg_image':self.args.pg_image}
            exclusive(PRIVATE / 'installation.json', canonical(self.marker))
            self.receipt = {'schema':1, 'kind':'isolated-production-provision', 'at':now(), 'passed':False,
                            'check_sha256':self.args.check_sha256, 'source':capsule['helpers'], 'history':[]}
            self.event('namespace_created')
            try:
                self.provision_resources()
                self.fresh()
                ops = self.load_operations()
                with ops.operations_lock():
                    backup = ops.backup(self.marker, self.runtime)
                    self.event('backup_created', backup=backup)
                    drill = ops.restore(self.marker, Path(backup['path']), self.runtime)
                require(drill['passed'] and drill['cleanup']['database_removed'], 'PRODUCTION_RESTORE_DRILL_FAILED')
                self.event('restore_proved', drill=drill)
                self.fresh()
                self.install_units()
                self.fresh()
                self.runtime.command(['systemctl','enable','--now','oasis-production-db.service','oasis-production-api.service',
                                      'oasis-production-instance-backup.timer','oasis-production-instance-monitor.timer'])
                for _ in range(20):
                    try:
                        self.runtime.http('http://127.0.0.1:18891/health/ready', 200, 'production'); break
                    except Refusal:
                        time.sleep(1)
                else:
                    raise Refusal('PRODUCTION_API_NOT_READY')
                self.fresh()
                self.runtime.command(['systemctl','start','oasis-production-instance-monitor.service'])
                self.receipt.update(passed=True, admission_enabled=False, players_created=0, coins_funded='0',
                                    backup=backup, restore=drill, staged_ingress_pending=True)
                self.event('complete_closed')
                return self.receipt
            except Exception as error:
                self.fail_closed(error)
                raise
        finally:
            os.close(lock)

    def provision_resources(self):
        self.runtime.command(['groupadd','--system',OWNER])
        self.runtime.command(['useradd','--system','--gid',OWNER,'--home-dir',str(PRIVATE),'--no-create-home','--shell','/usr/sbin/nologin',OWNER])
        user = pwd.getpwnam(OWNER); group = grp.getgrnam(OWNER)
        require(user.pw_gid == group.gr_gid and sum(p.pw_uid == user.pw_uid for p in pwd.getpwall()) == 1, 'DEDICATED_UID_NOT_UNIQUE')
        os.chown(PRIVATE,0,group.gr_gid);os.chmod(PRIVATE,0o750)
        state = PRIVATE / 'state';state.mkdir(mode=0o700);os.chown(state,user.pw_uid,group.gr_gid)
        (PRIVATE / 'monitor').mkdir(mode=0o750);os.chown(PRIVATE / 'monitor',0,group.gr_gid)
        os.chmod(PRIVATE / 'monitor',0o750)
        exclusive(state / 'master.key',secrets.token_bytes(32),uid=user.pw_uid,gid=group.gr_gid)
        require(fingerprint(state/'master.key')['sha256']!=fingerprint(BASE/'private/state/master.key')['sha256'],'PRODUCTION_MASTER_KEY_NOT_INDEPENDENT')
        passwords = {'owner':secrets.token_urlsafe(48),'app':secrets.token_urlsafe(48)}
        exclusive(PRIVATE / 'postgres.env',f'POSTGRES_USER={DB_OWNER}\nPOSTGRES_DB={DATABASE}\nPOSTGRES_PASSWORD={passwords["owner"]}\n'.encode())
        env = {'NODE_ENV':'production','OASIS_ENVIRONMENT':'production','OASIS_PRODUCTION_ADMISSION_ENABLED':'0',
               'OASIS_START_WALLET':'0','OASIS_PUBLIC_ORIGIN':self.args.origin,'OASIS_API_PORT':'18891',
               'OASIS_DATABASE_URL':f'postgres://{DB_APP}:{passwords["app"]}@127.0.0.1:18893/{DATABASE}',
               'OASIS_LOCAL_DIR':str(state)+'/', 'OASIS_TRUST_LOOPBACK_PROXY':'1','OASIS_ENGINE_WORKERS':'2','OASIS_ENGINE_QUEUE':'64',
               'OASIS_WALLET_ALLOWED_ORIGINS':'','OASIS_MONITOR_BACKUP_DIR':str(BACKUPS),
               'OASIS_MONITOR_BACKUP_UNIT':'oasis-production-instance-backup.service','OASIS_MONITOR_BACKUP_TIMER':'oasis-production-instance-backup.timer',
               'OASIS_MONITOR_CERT_FILE':'/opt/oasis/acme/config/live/oasis-production-player/fullchain.pem',
               'OASIS_PRODUCTION_CERTIFICATE_UNIT':'oasis-production-player-certificate.service',
               'OASIS_PRODUCTION_CERTIFICATE_TIMER':'oasis-production-player-certificate.timer',
               'OASIS_MONITOR_STATUS_FILE':str(PRIVATE / 'monitor/status.json'),'OASIS_MONITOR_REPORT_GROUP_READ':'1',
               'OASIS_RELEASE_STATUS_FILE':str(PRIVATE / 'release-status.json'),'OASIS_CAPACITY_STATUS_FILE':str(PRIVATE / 'capacity-status.json'),
               'OASIS_ANDROID_STATUS_FILE':str(PRIVATE / 'android-validation.json')}
        exclusive(PRIVATE / 'runtime.env',''.join(k+'='+v+'\n' for k,v in env.items()).encode())
        exclusive(PRIVATE / 'operator-credentials.json',canonical({'username':'operator','password':secrets.token_urlsafe(48)}))
        labels = ['--label',LABEL+'='+self.marker['owner']]
        self.runtime.command(['docker','volume','create',*labels,VOLUME])
        self.runtime.command(['docker','network','create','--driver','bridge','--opt',
            'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',*labels,NETWORK])
        cid = self.runtime.command(['docker','create','--name',CONTAINER,*labels,'--network',NETWORK,
            '--publish','127.0.0.1:18893:5432','--mount',f'type=volume,source={VOLUME},target=/var/lib/postgresql/data',
            '--env-file',str(PRIVATE / 'postgres.env'),'--memory','1g','--cpus','2','--pids-limit','256',
            self.args.pg_image,'postgres','-c','max_connections=128','-c','shared_buffers=128MB']).strip()
        require(re.fullmatch('[a-f0-9]{64}',cid), 'PRODUCTION_CONTAINER_ID_INVALID')
        volume=self.runtime.inspect('volume',VOLUME);network=self.runtime.inspect('network',NETWORK)
        self.marker.update(container_id=cid,uid=user.pw_uid,gid=group.gr_gid,
            volume_identity={key:volume.get(key) for key in ('Name','CreatedAt','Driver','Options','Mountpoint')},network_id=network['Id'],
            private_pins={name:fingerprint(PRIVATE/name) for name in ('runtime.env','postgres.env','operator-credentials.json','state/master.key')})
        old = PRIVATE / 'installation.json';pin=fingerprint(old)
        tmp=PRIVATE / 'installation-final.json';exclusive(tmp,canonical(self.marker));require(fingerprint(old)==pin,'OWNERSHIP_MARKER_CHANGED');os.replace(tmp,old)
        self.receipt['container_id']=cid; self.event('database_resources_created')
        self.fresh(created_prestart=True); self.runtime.command(['docker','start',cid])
        for _ in range(30):
            try:
                self.runtime.command(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U',DB_OWNER,'-d',DATABASE]);break
            except Refusal:
                time.sleep(1)
        else:
            raise Refusal('PRODUCTION_DATABASE_NOT_READY')
        # The empty endpoint exception ends at start. Verify assigned networking
        # and all protected identities again before any role/seed mutation.
        self.fresh()
        require_pg_host_tcp()
        # Password travels only through private stdin, never argv/report/stdout.
        sql=f"CREATE ROLE {DB_APP} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 96 PASSWORD '{passwords['app']}';\nREVOKE CONNECT ON DATABASE postgres,template0,template1 FROM PUBLIC;\nREVOKE ALL ON DATABASE {DATABASE} FROM PUBLIC;\nGRANT CONNECT,TEMPORARY ON DATABASE {DATABASE} TO {DB_APP};\nALTER SCHEMA public OWNER TO {DB_APP};\nREVOKE ALL ON SCHEMA public FROM PUBLIC;\n"
        self.runtime.command(['docker','exec','-i',cid,'psql','-X','-v','ON_ERROR_STOP=1','-U',DB_OWNER,'-d',DATABASE],input=sql)
        passwords.clear()
        os.symlink(str(self.release),PIN)
        env['OASIS_BOOTSTRAP_ALLOWED_ORIGINS']=json.dumps(self.marker['origins'],separators=(',',':'))
        self.runtime.command(['/usr/bin/node','--import',str(self.release / 'platform/node_modules/tsx/dist/loader.mjs'),
            str(self.release / 'platform/deploy/production-instance/bootstrap.mjs'),str(PRIVATE / 'operator-credentials.json'),
            str(PRIVATE / 'bootstrap.json')],env=env,timeout=180)
        result=json.loads((PRIVATE / 'bootstrap.json').read_text())
        require(result.get('passed') is True and result.get('admission_enabled') is False
                and result.get('players_created') == 0 and result.get('coins_funded') == '0','BOOTSTRAP_RECEIPT_INVALID')
        require(not (state / 'development-credentials.json').exists() and not (state / 'sandbox-app-credentials.json').exists(), 'PRODUCTION_DEVELOPMENT_SEED_PRESENT')
        self.receipt['bootstrap']=result;self.event('production_bootstrap_proved')

    def install_units(self):
        templates=unit_templates(self.release,self.marker['container_id'])
        for name,body in templates.items():
            exclusive(Path('/etc/systemd/system')/name,body.encode(),0o644)
        self.receipt['units_installed']=True
        self.runtime.command(['systemctl','daemon-reload'])
        for name in UNITS:
            require(fingerprint(Path('/etc/systemd/system')/name)['sha256']==digest(templates[name].encode()),'OWNED_UNIT_CHANGED')
        self.receipt['unit_pins']={name:fingerprint(Path('/etc/systemd/system')/name) for name in UNITS}
        self.loaded_unit_guard()
        self.event('isolated_units_installed')

    def loaded_unit_guard(self):
        templates=unit_templates(self.release,self.marker['container_id'])
        unit_namespace_guard(templates)
        for name,template in templates.items():
            state=self.runtime.service(name)
            require(state.get('FragmentPath')==str(Path('/etc/systemd/system')/name) and not state.get('DropInPaths')
                    and state.get('NeedDaemonReload')=='no','OWNED_UNIT_FRAGMENT_CHANGED')
            commands=self.runtime.loaded_commands(name)
            require(commands==(expected_commands(template) if name.endswith('.service') else {}),'OWNED_LOADED_COMMAND_CHANGED')

def unit_templates(release,cid):
    require(re.fullmatch('[a-f0-9]{64}',cid),'UNIT_CONTAINER_ID_INVALID')
    directory=str(release / 'platform')
    helper=str(release / 'platform/deploy/production-instance')
    hardened=f'NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nUMask=0077\nReadWritePaths={PRIVATE}\n'
    db=f'[Unit]\nDescription=OASIS isolated production database\nRequires=docker.service\nAfter=docker.service\n\n[Service]\nType=oneshot\nRemainAfterExit=true\nExecStart=/usr/bin/docker start {cid}\nExecStop=/usr/bin/docker stop --time 30 {cid}\nTimeoutStartSec=60\nTimeoutStopSec=90\n\n[Install]\nWantedBy=multi-user.target\n'
    api=f'[Unit]\nDescription=OASIS closed production API\nRequires=oasis-production-db.service\nAfter=oasis-production-db.service\n\n[Service]\nType=simple\nUser={OWNER}\nGroup={OWNER}\nWorkingDirectory={directory}\nEnvironmentFile={PRIVATE}/runtime.env\nExecStart=/usr/bin/node --import tsx server/index.mjs\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=45\nMemoryMax=2G\nTasksMax=256\n{hardened}\n[Install]\nWantedBy=multi-user.target\n'
    backup=f'[Unit]\nDescription=OASIS production identity backup\nRequires=oasis-production-db.service\nAfter=oasis-production-db.service\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -I -B {helper}/operations.py backup\nTimeoutStartSec=300\nUMask=0077\nPrivateTmp=true\n'
    monitor=f'[Unit]\nDescription=OASIS production dependency monitor\nAfter=oasis-production-api.service\n\n[Service]\nType=oneshot\nGroup={OWNER}\nWorkingDirectory={directory}\nEnvironmentFile={PRIVATE}/runtime.env\nExecStart=/usr/bin/node {helper}/monitor.mjs\nTimeoutStartSec=75\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n'
    def timer(target,schedule):
        return f'[Unit]\nDescription=OASIS isolated production schedule\n\n[Timer]\n{schedule}\nUnit={target}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n'
    return dict(zip(UNITS,(db,api,backup,timer(UNITS[2],'OnCalendar=*-*-* 03:20:00\nRandomizedDelaySec=180'),monitor,timer(UNITS[4],'OnBootSec=60\nOnUnitActiveSec=60'))))

def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=('capture','inventory','check','apply'))
    p.add_argument('--release');p.add_argument('--manifest-sha256')
    p.add_argument('--protected-inventory',required=True);p.add_argument('--origin')
    p.add_argument('--pg-image');p.add_argument('--capacity-budget-bytes',type=int,default=1<<30)
    p.add_argument('--check');p.add_argument('--check-sha256');p.add_argument('--create-isolated-production-closed',action='store_true')
    return p

def main():
    args=parser().parse_args();os.umask(0o077)
    try:
        require(os.getuid()==0,'ROOT_REQUIRED')
        tool=Provisioner(args)
        if args.mode=='capture':
            owned_namespace_free(tool.runtime)
            result={**tool.protected,'at':now(),'snapshot':tool.guard()}
        else:
            require(all((args.release,args.manifest_sha256,args.origin,args.pg_image)),'PROVISION_INPUTS_REQUIRED')
            result=tool.apply() if args.mode=='apply' else tool.check(inventory=args.mode=='inventory')
        print(json.dumps(result,sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'passed':False,'error_code':str(error) if isinstance(error,Refusal) else 'PROVISION_INTERNAL_ERROR'}))
        return 2

if __name__=='__main__':
    sys.exit(main())
