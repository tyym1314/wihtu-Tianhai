#!/usr/bin/env python3
"""Explicit, resumable provisioning for the same-host internal Android mock stack."""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import subprocess
import time
import urllib.request

BASE = Path('/opt/oasis')
PRIVATE = BASE / 'android-mock-private'
PIN = BASE / 'android-mock-current'
MARKER = PRIVATE / 'installation.json'
LIVE_ENV = BASE / 'private/runtime.env'
USER = 'oasis-mock'
CONTAINER = 'oasis-android-mock-postgres'
VOLUME = 'oasis-android-mock-postgres-data'
NETWORK = 'oasis-android-mock-internal'
LABEL = 'com.oasis.android-mock'
HOST = 'oasis-mock.43.98.202.236.sslip.io'
PORTS = (18981, 18982, 18983, 18985)
UNITS = ('oasis-android-mock-api', 'oasis-android-mock-demo', 'oasis-android-mock-db', 'oasis-android-mock-network', 'oasis-android-mock-certificate')
PROXY_UNIT = 'oasis-android-mock-db-proxy'
PROXY_BINARY = Path('/usr/lib/systemd/systemd-socket-proxyd')
RUNTIME_UNITS = (*UNITS[:4], PROXY_UNIT + '.socket', PROXY_UNIT + '.service')
PROXY_CONF = '/etc/nginx/conf.d/oasis-android-mock-acme.conf'
BRIDGE_CONF = Path('/etc/nginx/conf.d/oasis-android-mock-acme.conf')
TLS_CONF = Path('/etc/nginx/conf.d/oasis-android-mock.conf')
CERT = BASE / 'acme/config/live/oasis-android-mock'
WEBROOT = BASE / 'android-mock-acme-webroot'


def run(arguments, *, input=None, check=True):
    result = subprocess.run(arguments, input=input, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError('COMMAND_FAILED: ' + Path(arguments[0]).name + ' (inspect restricted local logs)')
    return result


def output(arguments, **kwargs):
    return run(arguments, **kwargs).stdout.strip()


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def release_check(value):
    release = Path(value)
    require(release.is_absolute() and release.parent == BASE / 'releases' and re.fullmatch(r'\d{8}-\d{2}', release.name), 'EXACT_IMMUTABLE_RELEASE_REQUIRED')
    require(release.resolve(strict=True) == release, 'SYMLINK_RELEASE_REJECTED')
    manifest = json.loads((release / 'RELEASE-MANIFEST.json').read_text())
    entries = manifest.get('files', manifest)
    require(isinstance(entries, dict) and len(entries) > 10, 'INVALID_RELEASE_MANIFEST')
    for name, expected in entries.items():
        target = release / name
        require(not Path(name).is_absolute() and '..' not in Path(name).parts and not target.is_symlink() and target.resolve().is_relative_to(release), 'UNSAFE_RELEASE_PATH')
        require(digest(target) == expected, 'RELEASE_HASH_MISMATCH: ' + name)
    for name in ('install.py', 'preflight.mjs', 'isolation.mjs', 'mock-api.service.example', 'mock-demo.service.example', 'mock.nginx.conf.example'):
        require('platform/deploy/mock-sandbox/' + name in entries, 'MOCK_TOOLING_NOT_IN_RELEASE_MANIFEST')
    for name in ('tsx', 'pg'):
        require((release / ('platform/node_modules/' + name + '/package.json')).is_file(), 'RELEASE_DEPENDENCIES_MISSING')
    return release, digest(release / 'RELEASE-MANIFEST.json')


def load():
    require(MARKER.is_file() and not MARKER.is_symlink(), 'INSTALLATION_NOT_PROVISIONED')
    require(MARKER.stat().st_uid == 0 and MARKER.stat().st_mode & 0o077 == 0, 'INSTALLATION_MARKER_PERMISSIONS')
    state = json.loads(MARKER.read_text())
    require(state.get('kind') == 'isolated-13-game-mock' and state.get('host') == HOST, 'INSTALLATION_MARKER_INVALID')
    return state


def save(state):
    temporary = PRIVATE / ('.installation-' + str(os.getpid()))
    with temporary.open('x') as target:
        target.write(json.dumps(state, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, MARKER)


def existing_exact_file(path, text, mode=0o644):
    """Validate an existing owned file without creating an absent one."""
    require(not path.is_symlink(), 'REFUSE_SYMLINK: ' + str(path))
    if path.exists():
        require(path.is_file() and path.read_text() == text, 'REFUSE_EXISTING_DIFFERENT_FILE: ' + str(path))
        require(path.stat().st_uid == 0 and path.stat().st_mode & 0o777 == mode, 'EXISTING_FILE_PERMISSIONS: ' + str(path))
        return True
    return False


def exact_file(path, text, mode=0o644):
    if existing_exact_file(path, text, mode):
        return
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, 'w') as target:
        target.write(text)
    path.chmod(mode)


def inspect(kind, name):
    result = run(['docker', kind, 'inspect', name], check=False)
    if result.returncode:
        return None
    return json.loads(result.stdout)[0]


def resources(state=None):
    for kind, name in [('container', CONTAINER), ('volume', VOLUME), ('network', NETWORK)]:
        resource = inspect(kind, name)
        if resource:
            labels = resource.get('Labels') or resource.get('Config', {}).get('Labels', {})
            require(state and labels.get(LABEL) == state['id'], 'UNOWNED_DOCKER_RESOURCE: ' + name)
    for path in [PRIVATE, PIN, WEBROOT, BRIDGE_CONF, TLS_CONF, *[Path('/etc/systemd/system/' + name + '.service') for name in UNITS], Path('/etc/systemd/system/oasis-android-mock-certificate.timer'), *proxy_unit_paths()]:
        require(state or not path.exists() and not path.is_symlink(), 'UNOWNED_EXISTING_PATH: ' + str(path))
    if not state:
        require(run(['getent', 'passwd', USER], check=False).returncode != 0, 'UNOWNED_UNIX_USER')
        require(run(['getent', 'group', USER], check=False).returncode != 0, 'UNOWNED_UNIX_GROUP')
        require(run(['nft', 'list', 'table', 'inet', 'oasis_android_mock'], check=False).returncode != 0, 'UNOWNED_FIREWALL_TABLE')
        require(run(['docker', 'exec', 'proxy-nginx', 'test', '-e', PROXY_CONF], check=False).returncode != 0, 'UNOWNED_PROXY_CONFIG')
        require(not CERT.exists() and not (BASE / 'acme/config/renewal/oasis-android-mock.conf').exists(), 'UNOWNED_CERTIFICATE')


def check(release_value, state=None):
    for executable in ('docker', 'systemctl', 'nginx', 'nft', 'getent', 'useradd', 'runuser', 'node', 'ss'):
        require(shutil.which(executable), 'REQUIRED_COMMAND_MISSING: ' + executable)
    require((BASE / 'certbot/bin/certbot').is_file(), 'CERTBOT_MISSING')
    proxy_binary_guard()
    require(LIVE_ENV.is_file(), 'LIVE_ENV_MISSING')
    release, release_hash = release_check(release_value)
    if state:
        require(state['release'] == str(release) and state['manifest_sha256'] == release_hash, 'RELEASE_PIN_CHANGED')
    require(shutil.disk_usage(BASE).free >= 3 * 1024 ** 3, 'LESS_THAN_3_GIB_FREE_DISK')
    memory = re.search(r'^MemAvailable:\s+(\d+)', Path('/proc/meminfo').read_text(), re.M)
    require(memory and int(memory[1]) >= 3 * 1024 ** 2, 'LESS_THAN_3_GIB_AVAILABLE_RAM')
    require((os.cpu_count() or 0) >= 4, 'FOUR_HOST_CPUS_REQUIRED')
    require('43.98.202.236' in {entry[4][0] for entry in socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)}, 'MOCK_DNS_MISMATCH')
    live = inspect('container', 'oasis-postgres')
    require(live and live['State']['Running'], 'LIVE_POSTGRES_IMAGE_UNAVAILABLE')
    image_id = live['Image']
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_id), 'UNPINNED_POSTGRES_IMAGE')
    require(inspect('image', image_id), 'POSTGRES_IMAGE_NOT_LOCAL')
    run(['nginx', '-t'])
    run(['docker', 'exec', 'proxy-nginx', 'nginx', '-t'])
    require('/etc/nginx/conf.d/*.conf' in output(['nginx', '-T']), 'NGINX_CONF_D_INCLUDE_MISSING')
    resources(state)
    if not state:
        require(HOST not in output(['nginx', '-T']) and HOST not in output(['docker', 'exec', 'proxy-nginx', 'nginx', '-T']), 'HOST_ALREADY_CONFIGURED')
        for port in PORTS:
            require(not output(['ss', '-H', '-ltn', 'sport = :' + str(port)]), 'PORT_ALREADY_LISTENING: ' + str(port))
    print(json.dumps({'check': 'passed', 'release': str(release), 'origin': 'https://' + HOST, 'free_disk_gib': round(shutil.disk_usage(BASE).free / 1024 ** 3, 2), 'capacity_scope': 'single-user internal QA only'}))
    return release, release_hash, image_id


def database_guard(state):
    resource = inspect('container', CONTAINER)
    require(resource and resource['Config']['Labels'].get(LABEL) == state['id'], 'MOCK_CONTAINER_NOT_OWNED')
    require(resource['Image'] == state['postgres_image'], 'MOCK_POSTGRES_IMAGE_CHANGED')
    require((resource['HostConfig'].get('PortBindings') or {}) in ({}, {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18983'}]}), 'MOCK_POSTGRES_BINDING_CHANGED')
    mounts = [entry for entry in resource['Mounts'] if entry['Destination'] == '/var/lib/postgresql/data']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['Name'] == VOLUME, 'MOCK_POSTGRES_VOLUME_CHANGED')
    require(resource['HostConfig']['Memory'] == 1024 ** 3 and resource['HostConfig']['NanoCpus'] == 500000000, 'MOCK_POSTGRES_LIMITS_CHANGED')
    volume = inspect('volume', VOLUME)
    isolated_network = inspect('network', NETWORK)
    require(volume and volume.get('Labels', {}).get(LABEL) == state['id'], 'MOCK_VOLUME_NOT_OWNED')
    require(isolated_network and isolated_network.get('Labels', {}).get(LABEL) == state['id'] and isolated_network.get('Internal') is True, 'MOCK_NETWORK_NOT_ISOLATED')
    require(resource['HostConfig']['NetworkMode'] == NETWORK and set(resource['NetworkSettings']['Networks']) == {NETWORK}, 'MOCK_DATABASE_NETWORK_CHANGED')


def database_sql(source):
    return output(['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'oasis_android_mock', '-At'], input=source)


def network_text(uid, database_address):
    require(ipaddress.ip_address(database_address).version == 4 and ipaddress.ip_address(database_address).is_private, 'INVALID_MOCK_DATABASE_ADDRESS')
    return f'''table inet oasis_android_mock {{
 chain output {{
  type filter hook output priority 0; policy accept;
  meta skuid {uid} ct state established,related accept
  meta skuid {uid} ip daddr 127.0.0.1 tcp dport {{ 18981, 18982, 18983, 18985 }} accept
  meta skuid {uid} ip daddr {database_address} tcp dport 5432 accept
  meta skuid {uid} reject
 }}
}}
'''


def provision(release_value):
    state = load() if MARKER.exists() else None
    release, release_hash, image_id = check(release_value, state)
    if not state:
        PRIVATE.mkdir(mode=0o700)
        state = {'kind': 'isolated-13-game-mock', 'id': secrets.token_hex(16), 'host': HOST, 'release': str(release), 'manifest_sha256': release_hash, 'postgres_image': image_id}
        save(state)
    if run(['getent', 'passwd', USER], check=False).returncode:
        run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', USER])
    account = pwd.getpwnam(USER)
    require(account.pw_dir == '/nonexistent' and account.pw_shell == '/usr/sbin/nologin', 'MOCK_USER_CHANGED')
    if 'uid' in state:
        require(state['uid'] == account.pw_uid, 'MOCK_UID_CHANGED')
    state['uid'] = account.pw_uid
    save(state)
    os.chown(PRIVATE, 0, account.pw_gid)
    PRIVATE.chmod(0o750)
    directory = PRIVATE / 'state'
    if not directory.exists():
        directory.mkdir(mode=0o700)
        os.chown(directory, account.pw_uid, account.pw_gid)
    require(not directory.is_symlink() and directory.stat().st_uid == account.pw_uid and directory.stat().st_mode & 0o777 == 0o700, 'MOCK_STATE_PERMISSIONS')
    for name in ('master.key', 'hosted-demo-guest.key'):
        target = directory / name
        if not target.exists():
            require(not state.get('keys_created'), 'MOCK_KEY_MISSING_DO_NOT_REGENERATE')
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as destination:
                destination.write(secrets.token_bytes(32))
            os.chown(target, account.pw_uid, account.pw_gid)
        require(not target.is_symlink() and target.stat().st_size == 32 and target.stat().st_uid == account.pw_uid and target.stat().st_mode & 0o777 == 0o600, 'MOCK_KEY_PERMISSIONS')
    state['keys_created'] = True
    save(state)
    credentials = PRIVATE / 'database.json'
    if not credentials.exists():
        require(not state.get('credentials_created'), 'MOCK_CREDENTIALS_MISSING_DO_NOT_REGENERATE')
        exact_file(credentials, json.dumps({'admin': secrets.token_hex(32), 'app': secrets.token_hex(32)}) + '\n', 0o600)
    require(not credentials.is_symlink() and credentials.stat().st_uid == 0 and credentials.stat().st_mode & 0o777 == 0o600, 'DATABASE_SECRET_PERMISSIONS')
    passwords = json.loads(credentials.read_text())
    require(all(re.fullmatch(r'[a-f0-9]{64}', passwords[key]) for key in ('admin', 'app')), 'DATABASE_SECRET_INVALID')
    state['credentials_created'] = True
    save(state)
    exact_file(PRIVATE / 'postgres.env', 'POSTGRES_USER=postgres\nPOSTGRES_DB=oasis_android_mock\nPOSTGRES_PASSWORD=' + passwords['admin'] + '\n', 0o600)
    template = (release / 'platform/deploy/mock-sandbox/mock.env.example').read_text()
    environment = '\n'.join(line for line in template.splitlines() if line and not line.startswith('#')) + '\n'
    environment = environment.replace('https://mock-game.example.invalid', 'https://' + HOST).replace('postgres://DEDICATED_MOCK_USER:DEDICATED_MOCK_PASSWORD@MOCK_POSTGRES_HOST:MOCK_POSTGRES_PORT/oasis_android_mock', 'postgres://oasis_mock_app:' + passwords['app'] + '@127.0.0.1:18983/oasis_android_mock')
    exact_file(PRIVATE / 'runtime.env', environment, 0o600)
    if not PIN.exists() and not PIN.is_symlink():
        PIN.symlink_to(release)
    require(PIN.is_symlink() and PIN.resolve() == release, 'MOCK_RELEASE_PIN_CONFLICT')
    if state.get('database_created'):
        require(inspect('container', CONTAINER) and inspect('volume', VOLUME) and inspect('network', NETWORK), 'MOCK_DATABASE_RESOURCE_MISSING_DO_NOT_RECREATE')
    if not inspect('volume', VOLUME):
        run(['docker', 'volume', 'create', '--label', LABEL + '=' + state['id'], VOLUME])
    if not inspect('network', NETWORK):
        run(['docker', 'network', 'create', '--internal', '--label', LABEL + '=' + state['id'], NETWORK])
    if not inspect('container', CONTAINER):
        run(['docker', 'create', '--name', CONTAINER, '--label', LABEL + '=' + state['id'], '--network', NETWORK, '--restart=no', '--memory=1g', '--memory-swap=1g', '--cpus=0.5', '--pids-limit=128', '--mount', 'type=volume,src=' + VOLUME + ',dst=/var/lib/postgresql/data', '--env-file', str(PRIVATE / 'postgres.env'), '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2', state['postgres_image'], '-c', 'shared_buffers=128MB', '-c', 'max_connections=110'])
    database_guard(state)
    state['database_created'] = True
    save(state)
    run(['docker', 'start', CONTAINER])
    for attempt in range(30):
        if run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'oasis_android_mock'], check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('MOCK_DATABASE_START_TIMEOUT')
    if database_sql("SELECT count(*) FROM pg_roles WHERE rolname='oasis_mock_app';") == '0':
        database_sql("CREATE ROLE oasis_mock_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + passwords['app'] + "';")
    require(database_sql("SELECT (NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)::int FROM pg_roles WHERE rolname='oasis_mock_app';") == '1', 'MOCK_DATABASE_ROLE_PRIVILEGES')
    database_sql('REVOKE CONNECT ON DATABASE postgres, template0, template1 FROM PUBLIC; REVOKE ALL ON DATABASE oasis_android_mock FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE oasis_android_mock TO oasis_mock_app; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO oasis_mock_app;')
    database_address = inspect('container', CONTAINER)['NetworkSettings']['Networks'][NETWORK]['IPAddress']
    if 'postgres_address' in state:
        require(state['postgres_address'] == database_address, 'MOCK_DATABASE_ADDRESS_CHANGED')
    state['postgres_address'] = database_address
    save(state)
    exact_file(PRIVATE / 'network.nft', network_text(account.pw_uid, database_address), 0o600)
    install_units(release, state)
    run(['systemctl', 'daemon-reload'])
    print('MOCK_PROVISIONED: API and HTTPS remain stopped; next run acme, certificate, then start')


def install_units(release, state=None):
    templates = release / 'platform/deploy/mock-sandbox'
    for name in ('api', 'demo'):
        exact_file(Path('/etc/systemd/system/oasis-android-mock-' + name + '.service'), (templates / ('mock-' + name + '.service.example')).read_text())
    command = '/usr/bin/python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py '
    exact_file(Path('/etc/systemd/system/oasis-android-mock-db.service'), f'''[Unit]
Description=Isolated Android mock PostgreSQL container
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre={command}guard-db
ExecStart=/usr/bin/docker start {CONTAINER}
ExecStop=/usr/bin/docker stop --time 30 {CONTAINER}
[Install]
WantedBy=multi-user.target
''')
    exact_file(Path('/etc/systemd/system/oasis-android-mock-network.service'), f'''[Unit]
Description=Android mock UID outbound network boundary
After=oasis-android-mock-db.service
Requires=oasis-android-mock-db.service
Before=oasis-android-mock-api.service oasis-android-mock-demo.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={command}network
[Install]
WantedBy=multi-user.target
''')
    exact_file(Path('/etc/systemd/system/oasis-android-mock-certificate.service'), f'''[Unit]
Description=Renew only the Android mock HTTPS certificate
After=network-online.target docker.service nginx.service
[Service]
Type=oneshot
ExecStart={command}renew
''')
    exact_file(Path('/etc/systemd/system/oasis-android-mock-certificate.timer'), '''[Unit]
Description=Android mock certificate renewal schedule
[Timer]
OnCalendar=*-*-* 03,15:20:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
''')
    if state is not None:
        install_proxy_units(state)


def proxy_binary_guard():
    require(PROXY_BINARY.is_file() and os.access(PROXY_BINARY, os.X_OK), 'SOCKET_PROXY_BINARY_MISSING')
    require(PROXY_BINARY.stat().st_uid == 0 and PROXY_BINARY.stat().st_mode & 0o022 == 0, 'SOCKET_PROXY_BINARY_PERMISSIONS')


def proxy_unit_paths():
    return (Path('/etc/systemd/system/' + PROXY_UNIT + '.socket'), Path('/etc/systemd/system/' + PROXY_UNIT + '.service'), Path('/etc/systemd/system/oasis-android-mock-api.service.d'))


def proxy_unit_files(state):
    address = state['postgres_address']
    require(ipaddress.ip_address(address).version == 4 and ipaddress.ip_address(address).is_private, 'INVALID_MOCK_DATABASE_ADDRESS')
    socket_path, service_path, dropin_dir = proxy_unit_paths()
    command = '/usr/bin/python3 /opt/oasis/android-mock-current/platform/deploy/mock-sandbox/install.py '
    return {socket_path: f'''[Unit]
Description=Loopback listener for the isolated Android mock database
DefaultDependencies=no
After=oasis-android-mock-network.service
Requires=oasis-android-mock-network.service
Before=oasis-android-mock-api.service shutdown.target
Conflicts=shutdown.target
[Socket]
ListenStream=127.0.0.1:18983
Accept=no
Service={PROXY_UNIT}.service
[Install]
WantedBy=multi-user.target
''', service_path: f'''[Unit]
Description=UID-confined proxy to the isolated Android mock database
After=oasis-android-mock-network.service {PROXY_UNIT}.socket
Requires=oasis-android-mock-network.service {PROXY_UNIT}.socket
[Service]
Type=simple
User={USER}
Group={USER}
ExecStartPre=+{command}guard-proxy
ExecStart={PROXY_BINARY} {address}:5432
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
MemoryMax=128M
TasksMax=16
''', dropin_dir / '10-database-proxy.conf': f'''[Unit]
After={PROXY_UNIT}.socket {PROXY_UNIT}.service
Requires={PROXY_UNIT}.socket {PROXY_UNIT}.service
'''}


def install_proxy_units(state):
    proxy_binary_guard()
    directory = proxy_unit_paths()[2]
    require(not directory.is_symlink(), 'SOCKET_PROXY_DROPIN_SYMLINK')
    directory.mkdir(mode=0o755, exist_ok=True)
    require(directory.is_dir() and directory.stat().st_uid == 0, 'SOCKET_PROXY_DROPIN_OWNER')
    directory.chmod(0o755)
    for path, content in proxy_unit_files(state).items():
        exact_file(path, content)


def proxy_files_guard(state):
    proxy_binary_guard()
    for path, content in proxy_unit_files(state).items():
        require(path.is_file() and not path.is_symlink() and path.read_text() == content, 'SOCKET_PROXY_UNIT_CHANGED')
        require(path.stat().st_uid == 0 and path.stat().st_mode & 0o777 == 0o644, 'SOCKET_PROXY_UNIT_PERMISSIONS')


def network(state):
    require(pwd.getpwnam(USER).pw_uid == state['uid'], 'MOCK_UID_CHANGED')
    database_guard(state)
    require(inspect('container', CONTAINER)['NetworkSettings']['Networks'][NETWORK]['IPAddress'] == state['postgres_address'], 'MOCK_DATABASE_ADDRESS_CHANGED')
    expected = network_text(state['uid'], state['postgres_address'])
    require((PRIVATE / 'network.nft').read_text() == expected, 'NETWORK_POLICY_CHANGED')
    present = run(['nft', '-j', 'list', 'table', 'inet', 'oasis_android_mock'], check=False)
    if present.returncode:
        run(['nft', '-c', '-f', str(PRIVATE / 'network.nft')])
        run(['nft', '-f', str(PRIVATE / 'network.nft')])
        state['network_fingerprint'] = network_fingerprint()
        save(state)
    else:
        require(state.get('network_fingerprint') == network_fingerprint(), 'NETWORK_POLICY_DRIFT')


def network_fingerprint():
    document = json.loads(output(['nft', '-j', 'list', 'table', 'inet', 'oasis_android_mock']))
    normalized = []
    for item in document['nftables']:
        if 'metainfo' in item:
            continue
        normalized.append({kind: {key: value for key, value in content.items() if key != 'handle'} for kind, content in item.items()})
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


def release_guard(state):
    release, manifest_hash = release_check(state['release'])
    require(manifest_hash == state['manifest_sha256'] and PIN.is_symlink() and PIN.resolve() == release, 'MOCK_RELEASE_PIN_CHANGED')
    return release


def proxy_guard(state):
    release = release_guard(state)
    database_guard(state)
    require(pwd.getpwnam(USER).pw_uid == state['uid'], 'MOCK_UID_CHANGED')
    require(inspect('container', CONTAINER)['NetworkSettings']['Networks'][NETWORK]['IPAddress'] == state['postgres_address'], 'MOCK_DATABASE_ADDRESS_CHANGED')
    require(state.get('network_fingerprint') == network_fingerprint(), 'NETWORK_POLICY_DRIFT')
    proxy_files_guard(state)
    run(['runuser', '-u', USER, '--', 'test', '-r', str(release / 'platform/server/index.mjs')])
    require(run(['runuser', '-u', USER, '--', 'test', '-r', str(LIVE_ENV)], check=False).returncode != 0, 'MOCK_CAN_READ_LIVE_ENV')


def guard(state):
    proxy_guard(state)
    require(output(['systemctl', 'is-active', PROXY_UNIT + '.socket'], check=False) == 'active', 'SOCKET_PROXY_NOT_LISTENING')
    probe = '''import socket
for port in (18881,18882,18883,18885):
    try:
        connection=socket.create_connection(('127.0.0.1',port),timeout=1)
    except OSError:
        continue
    connection.close()
    raise SystemExit(1)
socket.create_connection(('127.0.0.1',18983),timeout=2).close()
'''
    run(['runuser', '-u', USER, '--', '/usr/bin/python3', '-c', probe])


def public_probe(url, accepts, failure):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, new_url):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=min(1.5, max(0.01, deadline - time.monotonic()))) as response:
                payload = response.read(4097)
                if response.status == 200 and len(payload) <= 4096 and accepts(payload):
                    return
        except Exception:
            pass
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.25, remaining))
    raise RuntimeError(failure)


def acme(state):
    challenge = WEBROOT / '.well-known/acme-challenge'
    for directory in (WEBROOT, WEBROOT / '.well-known', challenge):
        require(not directory.is_symlink(), 'ACME_WEBROOT_SYMLINK')
        directory.mkdir(mode=0o755, exist_ok=True)
        require(directory.stat().st_uid == 0, 'ACME_WEBROOT_OWNER_CHANGED')
        directory.chmod(0o755)
    bridge = f'''server {{
 listen 172.17.0.1:18884;
 server_name {HOST};
 root {WEBROOT};
 location ^~ /.well-known/acme-challenge/ {{ try_files $uri =404; }}
 location / {{ return 404; }}
}}
'''
    proxy = f'''server {{
 listen 80;
 server_name {HOST};
 location ^~ /.well-known/acme-challenge/ {{
  proxy_pass http://172.17.0.1:18884;
  proxy_set_header Host $host;
 }}
 location / {{ return 301 https://{HOST}$request_uri; }}
}}
'''
    exact_file(BRIDGE_CONF, bridge)
    local_proxy = PRIVATE / 'proxy-acme.conf'
    exact_file(local_proxy, proxy)
    existing = run(['docker', 'exec', 'proxy-nginx', 'cat', PROXY_CONF], check=False)
    if existing.returncode:
        run(['docker', 'cp', str(local_proxy), 'proxy-nginx:' + PROXY_CONF])
    else:
        require(existing.stdout == proxy, 'PROXY_CONFIG_CONFLICT')
    run(['nginx', '-t'])
    run(['docker', 'exec', 'proxy-nginx', 'nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    run(['docker', 'exec', 'proxy-nginx', 'nginx', '-s', 'reload'])
    challenge_name = 'mock-preflight-' + secrets.token_hex(16)
    target = challenge / challenge_name
    exact_file(target, challenge_name, 0o644)
    try:
        public_probe('http://' + HOST + '/.well-known/acme-challenge/' + challenge_name, lambda body: body == challenge_name.encode(), 'PUBLIC_ACME_ROUTE_FAILED')
    finally:
        target.unlink()
    print('MOCK_ACME_ROUTE_OK')


def certbot_arguments():
    return ['--config-dir', str(BASE / 'acme/config'), '--work-dir', str(BASE / 'acme/work'), '--logs-dir', str(BASE / 'acme/logs')]


def certificate(state, renew=False):
    acme(state)
    executable = str(BASE / 'certbot/bin/certbot')
    if renew:
        require(CERT.exists(), 'MOCK_CERTIFICATE_MISSING')
        run([executable, 'renew', '--cert-name', 'oasis-android-mock', '--non-interactive', '--quiet', *certbot_arguments()])
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    else:
        run([executable, 'certonly', '--webroot', '-w', str(WEBROOT), '--cert-name', 'oasis-android-mock', '-d', HOST, '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--keep-until-expiring', *certbot_arguments()])
    print('MOCK_CERTIFICATE_OK')


def start(state):
    template = (Path(state['release']) / 'platform/deploy/mock-sandbox/mock.nginx.conf.example').read_text()
    tls_text = template.replace('mock-game.example.invalid', HOST).replace('/live/ANDROID_MOCK/', '/live/oasis-android-mock/')
    # Reject unknown profiles before check() invokes Nginx or any service starts.
    # Missing TLS configuration is normal for the first start; do not create it
    # until the existing release, certificate and isolation checks have passed.
    existing_exact_file(TLS_CONF, tls_text)
    check(state['release'], state)
    require(CERT.exists(), 'MOCK_CERTIFICATE_MISSING')
    run(['systemctl', 'start', 'oasis-android-mock-network', 'oasis-android-mock-db', PROXY_UNIT + '.socket', PROXY_UNIT + '.service'])
    guard(load())
    # Recheck/create exclusively before entering application startup's failure
    # handler, so a conflicting file cannot stop already-running applications.
    exact_file(TLS_CONF, tls_text)
    try:
        run(['systemctl', 'start', 'oasis-android-mock-api', 'oasis-android-mock-demo'])
        for attempt in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:18981/health', timeout=2) as response:
                    require(json.load(response).get('status') == 'ok', 'MOCK_API_UNHEALTHY')
                request = urllib.request.Request('http://127.0.0.1:18985/demo/', headers={'Host': HOST})
                with urllib.request.urlopen(request, timeout=2) as response:
                    require(response.status == 200, 'MOCK_DEMO_UNHEALTHY')
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('MOCK_HEALTH_TIMEOUT')
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        public_probe('https://' + HOST + '/health', lambda body: json.loads(body).get('status') == 'ok' and json.loads(body).get('environment') == 'sandbox', 'MOCK_PUBLIC_HEALTH_FAILED')
        run(['systemctl', 'enable', 'oasis-android-mock-api', 'oasis-android-mock-demo', 'oasis-android-mock-db', 'oasis-android-mock-network', PROXY_UNIT + '.socket'])
        run(['systemctl', 'enable', '--now', 'oasis-android-mock-certificate.timer'])
    except Exception:
        run(['systemctl', 'stop', 'oasis-android-mock-demo', 'oasis-android-mock-api'], check=False)
        raise
    print('MOCK_STARTED: internal QA only; requires all-13 game and physical Android acceptance')


def stop(state):
    resources(state)
    run(['systemctl', 'disable', '--now', 'oasis-android-mock-certificate.timer', 'oasis-android-mock-demo', 'oasis-android-mock-api', PROXY_UNIT + '.socket', PROXY_UNIT + '.service', 'oasis-android-mock-network', 'oasis-android-mock-db'])
    print('MOCK_STOPPED: mock database volume, keys, certificate, release pin and network boundary retained; no live resources changed')


def status(state):
    release_guard(state)
    database_guard(state)
    services = {name: output(['systemctl', 'is-active', name], check=False) for name in RUNTIME_UNITS}
    startup = {name: output(['systemctl', 'is-enabled', name], check=False) for name in (*RUNTIME_UNITS, 'oasis-android-mock-certificate.timer')}
    database_running = inspect('container', CONTAINER)['State']['Running']
    deployment_status = 'stopped' if all(value == 'inactive' for value in services.values()) and not database_running else 'degraded'
    health = {'api': False, 'demo': False, 'public_https': False}
    isolation = 'not_probed'
    if all(value == 'active' for value in services.values()) and database_running:
        guard(state)
        isolation = 'verified'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        probes = (
            ('api', 'http://127.0.0.1:18981/health/ready', 2),
            ('demo', urllib.request.Request('http://127.0.0.1:18985/demo/', headers={'Host': HOST}), 2),
            ('public_https', 'https://' + HOST + '/health', 15),
        )
        for name, request, timeout in probes:
            try:
                with opener.open(request, timeout=timeout) as response:
                    if name == 'demo':
                        health[name] = response.status == 200
                    else:
                        payload = json.load(response)
                        health[name] = response.status == 200 and payload.get('status') == 'ok' and payload.get('environment') == 'sandbox'
            except Exception:
                health[name] = False
        if all(health.values()):
            deployment_status = 'running'
    print(json.dumps({'origin': 'https://' + HOST, 'release': state['release'], 'status': deployment_status, 'healthy': all(health.values()), 'health_checks': health, 'isolation': isolation, 'services': services, 'startup_enabled': startup, 'database_running': database_running, 'postgres_loopback_port': 18983, 'capacity_scope': 'single-user internal QA only'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('check', 'provision', 'acme', 'certificate', 'start', 'status', 'stop', 'guard', 'guard-db', 'guard-proxy', 'network', 'renew'))
    parser.add_argument('--release', help='Exact /opt/oasis/releases/YYYYMMDD-NN directory; required for check/provision')
    arguments = parser.parse_args()
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    if arguments.stage == 'check':
        require(arguments.release, 'RELEASE_REQUIRED')
        check(arguments.release, load() if MARKER.exists() else None)
        return
    if arguments.stage in ('guard', 'guard-db', 'guard-proxy'):
        {'guard': guard, 'guard-db': database_guard, 'guard-proxy': proxy_guard}[arguments.stage](load())
        return
    if arguments.stage == 'network':
        with open('/run/lock/oasis-android-mock-network.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            network(load())
        return
    with open('/run/lock/oasis-android-mock-install.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if arguments.stage == 'provision':
            require(arguments.release, 'RELEASE_REQUIRED')
            provision(arguments.release)
        else:
            state = load()
            functions = {'acme': acme, 'certificate': certificate, 'start': start, 'status': status, 'stop': stop, 'network': network, 'renew': lambda value: certificate(value, renew=True)}
            functions[arguments.stage](state)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if isinstance(error, RuntimeError):
            raise SystemExit(str(error))
        raise SystemExit('MOCK_INSTALL_FAILED: ' + type(error).__name__ + '; inspect restricted local state without sharing secrets')
