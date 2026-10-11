#!/usr/bin/env python3
"""Dedicated HTTPS ingress for the isolated production instance.

This tool does not create accounts, enable admission, modify the live vhost,
switch public/current, or operate a database. Run on the authorized host.
Every mutation requires the exact prospective release manifest and a complete
check receipt. The first ACME stage only publishes its own challenge route.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time
import urllib.request

BASE = Path('/opt/oasis')
HOST = 'oasis-player.43.98.202.236.sslip.io'
ORIGIN = 'https://' + HOST
PUBLIC_READY = ORIGIN + '/health/ready'
LOCAL_READY = 'http://127.0.0.1:18891/health/ready'
PRIVATE = BASE / 'production-ingress-private'
WEBROOT = BASE / 'production-player-acme-webroot'
BRIDGE = Path('/etc/nginx/conf.d/oasis-production-player-acme.conf')
PROXY = BRIDGE
TLS = Path('/etc/nginx/conf.d/oasis-production-player.conf')
CERT = BASE / 'acme/config/live/oasis-production-player'
CERTBOT = BASE / 'certbot/bin/certbot'
RENEW_SERVICE = Path('/etc/systemd/system/oasis-production-player-certificate.service')
RENEW_TIMER = Path('/etc/systemd/system/oasis-production-player-certificate.timer')
LOCK = PRIVATE / '.production-ingress-lock'
HELPER_MEMBERS = {'units': 'platform/deploy/production-ingress-units.py',
                  'runtime': 'platform/deploy/production-instance/provision.py',
                  'certificate': 'platform/deploy/production-ingress-cert.py'}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def read_regular(path, limit=1024 * 1024):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
            and not info.st_mode & 0o022 and info.st_size <= limit, 'UNSAFE_OPERATOR_INPUT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        current = os.fstat(stream.fileno())
        require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), 'INPUT_REPLACED')
        data = stream.read(limit + 1)
        after = path.lstat()
        require((after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) ==
                (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns), 'INPUT_CHANGED')
    require(len(data) <= limit, 'INPUT_TOO_LARGE')
    return data


def file_pin(path):
    before = path.lstat()
    data = read_regular(path)
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink',
              'st_size', 'st_mtime_ns', 'st_ctime_ns')
    require(all(getattr(before, key) == getattr(after, key) for key in fields), 'PIN_FILE_CHANGED')
    return {**{key: getattr(after, key) for key in fields}, 'sha256': sha(data)}


def release_lock_guard(fd, expected):
    info = os.fstat(fd)
    require(all(getattr(info, key) == expected[key] for key in
                ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink'))
            and file_pin(BASE / 'private/release.lock') == expected, 'SHARED_RELEASE_LOCK_REPLACED')


def run(args, check=True):
    executables = {'docker': '/usr/bin/docker', 'nginx': '/usr/sbin/nginx',
                   'systemctl': '/usr/bin/systemctl', str(CERTBOT): str(CERTBOT)}
    require(args and args[0] in executables, 'UNRECOGNIZED_OPERATOR_COMMAND')
    command = [executables[args[0]], *args[1:]]
    # Neither an interactive shell nor a timer may inject executable lookup,
    # dynamic libraries, language loaders, proxies or an alternate D-Bus.
    clean = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
    value = subprocess.run(command, capture_output=True, text=True, timeout=120, env=clean)
    if check and value.returncode:
        # Certbot and Nginx diagnostics may include local paths. Keep a bounded
        # private receipt, rather than copying command/environment values.
        raise RuntimeError('COMMAND_FAILED: ' + args[0])
    return value


def release_binding(release, manifest_sha):
    require(re.fullmatch(r'/opt/oasis/releases/\d{8}-\d{2}', str(release)), 'IMMUTABLE_RELEASE_REQUIRED')
    require(re.fullmatch(r'[a-f0-9]{64}', manifest_sha), 'EXACT_MANIFEST_SHA_REQUIRED')
    require(release.is_dir() and not release.is_symlink(), 'RELEASE_DIRECTORY_REQUIRED')
    raw = read_regular(release / 'RELEASE-MANIFEST.json', 8 * 1024 * 1024)
    require(sha(raw) == manifest_sha, 'RELEASE_MANIFEST_CHANGED')
    manifest = json.loads(raw)
    for name in ['platform/dist/index.html', 'platform/deploy/production-ingress.py',
                 *HELPER_MEMBERS.values()]:
        require(name in manifest, 'INGRESS_RELEASE_MEMBER_MISSING')
        require(sha(read_regular(release / name, 8 * 1024 * 1024)) == manifest[name], 'RELEASE_MEMBER_CHANGED')
    require(sha(read_regular(Path(__file__).resolve(), 8 * 1024 * 1024)) ==
            manifest['platform/deploy/production-ingress.py'], 'EXECUTING_CONTROLLER_CHANGED')
    return {'release': str(release), 'manifest_sha256': manifest_sha,
            'tool_sha256': manifest['platform/deploy/production-ingress.py'],
            'helpers': {key: manifest[name] for key, name in HELPER_MEMBERS.items()}}


def load_bound_helper(binding, name):
    path = Path(binding['release']) / HELPER_MEMBERS[name]
    require(sha(read_regular(path, 8 * 1024 * 1024)) == binding['helpers'][name],
            'INGRESS_HELPER_CHANGED')
    spec = importlib.util.spec_from_file_location('oasis_ingress_' + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def certificate_unit_guard(binding, loaded=False):
    configs = configurations(binding)
    templates = {path.name: configs[str(path)] for path in (RENEW_SERVICE, RENEW_TIMER)}
    helper = load_bound_helper(binding, 'units')
    runtime = load_bound_helper(binding, 'runtime').Runtime()
    installed = any(path.exists() or path.is_symlink() for path in (RENEW_SERVICE, RENEW_TIMER))
    if loaded or installed:
        return helper.loaded_guard(templates, runtime)
    return helper.namespace_guard(templates, runtime, installed=False)


def configurations(binding):
    release = binding['release']
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
    tls = f'''map $uri $oasis_production_static_cache_control {{
 default "public, max-age=0, must-revalidate";
 "~-[A-Za-z0-9_-]{{8}}\\.(js|mjs|css|png|webp|jpe?g|svg|glb|gltf|bin|woff2?|mp3|ogg|wasm)$" "public, max-age=31536000, immutable";
 "~-mobile-[a-f0-9]{{10}}\\.webp$" "public, max-age=31536000, immutable";
}}
server {{
 listen 443 ssl http2;
 server_name {HOST};
 ssl_certificate {CERT}/fullchain.pem;
 ssl_certificate_key {CERT}/privkey.pem;
 ssl_protocols TLSv1.2 TLSv1.3;
 root /opt/oasis/production-current/platform/dist;
 server_tokens off;
 client_max_body_size 128k;
 add_header X-Content-Type-Options nosniff always;
 add_header Referrer-Policy no-referrer always;
 proxy_http_version 1.1;
 proxy_set_header Connection "";
 proxy_set_header Host $host;
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-For $remote_addr;
 proxy_set_header X-Forwarded-Proto https;
 gzip on;
 gzip_vary on;
 gzip_min_length 1024;
 gzip_types text/plain text/css text/javascript application/javascript application/json application/wasm image/svg+xml model/gltf-binary;
 location = /demo {{ return 410; }}
 location ^~ /demo/ {{ return 410; }}
 location ^~ /api/demo/ {{ return 410; }}
 location ^~ /downloads/ {{ return 404; }}
 location ~ /\\. {{ deny all; }}
 location ~* \\.(pem|key|env|sql)$ {{ deny all; }}
 location = /health {{ proxy_pass http://127.0.0.1:18891; }}
 location = /health/ready {{ proxy_pass http://127.0.0.1:18891; }}
 location ~ ^/(arena/assets|legacy/assets|legacy/bundles)/ {{
  root /opt/oasis/static-assets;
  types {{
   application/javascript js mjs; text/css css;
   image/png png; image/webp webp; image/jpeg jpg jpeg; image/svg+xml svg;
   model/gltf-binary glb; model/gltf+json gltf; application/wasm wasm;
   application/octet-stream bin; font/woff woff; font/woff2 woff2;
   audio/mpeg mp3; audio/ogg ogg; video/webm webm;
  }}
  try_files $uri @oasis_production_api_static;
  add_header Cache-Control $oasis_production_static_cache_control;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
 }}
 location ~ ^/(api|v1|play|arena|legacy)/ {{ proxy_pass http://127.0.0.1:18891; }}
 location = /index.html {{
  add_header Cache-Control no-store always;
  add_header X-Content-Type-Options nosniff always;
  try_files $uri =404;
 }}
 location ~ ^/(assets|previews)/ {{
  root /opt/oasis/static-assets;
  types {{
   application/javascript js mjs; text/css css;
   image/png png; image/webp webp; image/jpeg jpg jpeg; image/svg+xml svg;
   model/gltf-binary glb; model/gltf+json gltf; application/wasm wasm;
   application/octet-stream bin; font/woff woff; font/woff2 woff2;
   audio/mpeg mp3; audio/ogg ogg; video/webm webm;
  }}
  try_files $uri @oasis_production_player_static;
  add_header Cache-Control $oasis_production_static_cache_control;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
 }}
 location @oasis_production_api_static {{ proxy_pass http://127.0.0.1:18891; }}
 location @oasis_production_player_static {{
  root /opt/oasis/production-current/platform/dist;
  types {{
   application/javascript js mjs; text/css css;
   image/png png; image/webp webp; image/jpeg jpg jpeg; image/svg+xml svg;
   model/gltf-binary glb; model/gltf+json gltf; application/wasm wasm;
   application/octet-stream bin; font/woff woff; font/woff2 woff2;
   audio/mpeg mp3; audio/ogg ogg; video/webm webm;
  }}
  try_files $uri =404;
  add_header Cache-Control $oasis_production_static_cache_control;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
 }}
 location / {{
  add_header Cache-Control no-store always;
  add_header X-Content-Type-Options nosniff always;
  try_files $uri $uri/ /index.html;
 }}
}}
'''
    service = f'''[Unit]
Description=Renew the isolated production player HTTPS certificate
After=network-online.target nginx.service
Wants=network-online.target
[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=/usr/bin/python3 -I -B {release}/platform/deploy/production-ingress.py renew --release {release} --manifest-sha256 {binding['manifest_sha256']}
'''
    timer = '''[Unit]
Description=Check the isolated production player certificate twice daily
[Timer]
OnCalendar=*-*-* 00,12:20:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
'''
    return {str(BRIDGE): bridge.encode(), str(PRIVATE / 'proxy-acme.conf'): proxy.encode(),
            str(PRIVATE / 'certbot-cli.ini'): b'', str(TLS): tls.encode(),
            str(RENEW_SERVICE): service.encode(), str(RENEW_TIMER): timer.encode()}


def exact_file(path, data, mode=0o644):
    if path.exists() or path.is_symlink():
        require(read_regular(path) == data, 'EXISTING_CONFIG_CONFLICT')
        require(stat.S_IMODE(path.lstat().st_mode) == mode, 'CONFIG_MODE_CHANGED')
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return True


def protected_files():
    # Protect every other host vhost, not merely game.tianyahuyu.com. Runtime
    # PIDs may change on a graceful shared reload; configuration bytes must not.
    return {str(p): sha(read_regular(p)) for p in sorted(Path('/etc/nginx/conf.d').glob('*.conf'))
            if p not in (BRIDGE, TLS)}


def proxy_identity():
    value = json.loads(run(['docker', 'inspect', 'proxy-nginx']).stdout)
    require(len(value) == 1 and value[0]['State']['Running'], 'SHARED_PROXY_NOT_RUNNING')
    row = value[0]
    require(run(['docker', 'exec', row['Id'], 'id', '-u']).stdout.strip() == '0', 'PROXY_ROOT_INSPECTION_REQUIRED')
    return {'id': row['Id'], 'image': row['Image']}


def proxy_configs(identity):
    result = run(['docker', 'exec', identity['id'], 'sh', '-c',
                  'for p in /etc/nginx/conf.d/*.conf; do test -f "$p" && test ! -L "$p" || exit 42; sha256sum "$p" || exit 43; done'])
    rows = {}
    for line in result.stdout.splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (/etc/nginx/conf\.d/[A-Za-z0-9_.-]+\.conf)', line)
        require(match is not None, 'PROXY_CONFIG_INVENTORY_INVALID')
        digest, name = match.groups()
        require(name not in rows, 'PROXY_CONFIG_DUPLICATE')
        if name != str(PROXY):
            rows[name] = digest
    return rows


def public_get(url, expected=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=15) as response:
        require(response.url == url and response.status == 200, 'PUBLIC_ROUTE_CHANGED')
        body = response.read(64 * 1024 + 1)
        require(len(body) <= 64 * 1024, 'PUBLIC_RESPONSE_TOO_LARGE')
    if expected is not None:
        require(body == expected, 'PUBLIC_RESPONSE_CHANGED')
    return body


def production_health(url):
    require(url in (PUBLIC_READY, LOCAL_READY), 'PRODUCTION_HEALTH_SCOPE_CHANGED')
    body = public_get(url)
    health = json.loads(body)
    require(isinstance(health, dict) and health.get('environment') == 'production'
            and health.get('status') == 'ok', 'PRODUCTION_HEALTH_REQUIRED')
    return body


def owned_directory(path, mode, create=False):
    if not path.exists() and not path.is_symlink():
        require(create, 'OWNED_DIRECTORY_CHANGED')
        path.mkdir(mode=mode)
        path.chmod(mode)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and (path != PRIVATE or info.st_gid == 0)
            and stat.S_IMODE(info.st_mode) == mode, 'OWNED_DIRECTORY_CHANGED')


def check(binding, require_public_https=True):
    if PRIVATE.exists() or PRIVATE.is_symlink():
        owned_directory(PRIVATE, 0o700)
    configs = configurations(binding)
    own = {}
    for name, expected in configs.items():
        path = Path(name)
        if path.exists() or path.is_symlink():
            require(read_regular(path) == expected, 'EXISTING_CONFIG_CONFLICT')
            own[name] = sha(expected)
        else:
            own[name] = None
    require(CERTBOT.is_file(), 'CERTBOT_MISSING')
    run(['nginx', '-t'])
    proxy = proxy_identity()
    run(['docker', 'exec', proxy['id'], 'nginx', '-t'])
    helper = load_bound_helper(binding, 'certificate')
    certificate_scope = {'default_cli_configs': helper.default_cli_guard()}
    if (PRIVATE / 'certbot-cli.ini').exists():
        certificate_scope = helper.scope_check('renew' if CERT.exists() else 'certonly')
    health_url, health_scope = PUBLIC_READY, 'public-production-https-ready'
    if not require_public_https and not TLS.exists() and not TLS.is_symlink():
        health_url, health_scope = LOCAL_READY, 'production-loopback-bootstrap-ready'
    return {'schema': 'production-ingress-check-v1', 'binding': binding,
            'certificate_units': certificate_unit_guard(binding),
            'certificate_scope': certificate_scope,
            'protected': protected_files(), 'proxy': proxy,
            'proxy_protected': proxy_configs(proxy), 'own': own,
            'shared_lock': file_pin(BASE / 'private/release.lock'),
            'public_health': sha(production_health(health_url)),
            'health_url': health_url, 'health_scope': health_scope,
            'read_only': True, 'checked_at_ms': int(time.time() * 1000)}


def prepare_acme(binding, expected_proxy):
    identity = proxy_identity()
    require(identity == expected_proxy, 'SHARED_PROXY_CHANGED')
    configs = configurations(binding)
    for directory, mode in [(PRIVATE, 0o700), (WEBROOT, 0o755),
                            (WEBROOT / '.well-known', 0o755), (WEBROOT / '.well-known/acme-challenge', 0o755)]:
        owned_directory(directory, mode, create=True)
    load_bound_helper(binding, 'certificate').prepare_cli_config()
    exact_file(BRIDGE, configs[str(BRIDGE)])
    local = PRIVATE / 'proxy-acme.conf'
    exact_file(local, configs[str(local)])
    current = run(['docker', 'exec', identity['id'], 'sh', '-c',
                   'test ! -L "$1" || exit 42; if test -e "$1"; then test -f "$1" && cat "$1" || exit 43; else test -d /etc/nginx/conf.d && exit 44; fi',
                   'sh', str(PROXY)], check=False)
    if current.returncode == 44:
        run(['docker', 'cp', str(local), identity['id'] + ':' + str(PROXY)])
    else:
        require(current.returncode == 0 and current.stdout.encode() == configs[str(local)], 'PROXY_CONFIG_CONFLICT')
    run(['nginx', '-t'])
    run(['docker', 'exec', identity['id'], 'nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    run(['docker', 'exec', identity['id'], 'nginx', '-s', 'reload'])
    name = 'player-' + secrets.token_hex(16)
    challenge = WEBROOT / '.well-known/acme-challenge' / name
    exact_file(challenge, name.encode())
    try:
        public_get('http://' + HOST + '/.well-known/acme-challenge/' + name, name.encode())
    finally:
        require(read_regular(challenge) == name.encode(), 'CHALLENGE_CHANGED')
        challenge.unlink()


def certificate(binding, expected_proxy, renew=False):
    prepare_acme(binding, expected_proxy)
    helper = load_bound_helper(binding, 'certificate')
    scope = helper.scope_check('renew' if renew else 'certonly')
    run(scope['argv'])
    helper.scope_check('renew')
    if renew:
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])


def start(binding):
    certificate_unit_guard(binding)
    require((BASE / 'production-current').is_symlink() and
            str((BASE / 'production-current').resolve(strict=True)) == binding['release'], 'PRODUCTION_RELEASE_CHANGED')
    body = json.loads(public_get('http://127.0.0.1:18891/health/ready'))
    require(body.get('environment') == 'production' and body.get('status') == 'ok', 'PRODUCTION_API_NOT_HEALTHY')
    require(CERT.is_dir(), 'CERTIFICATE_MISSING')
    configs = configurations(binding)
    created = exact_file(TLS, configs[str(TLS)])
    created_pin = file_pin(TLS) if created else None
    try:
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        health = json.loads(public_get(ORIGIN + '/health/ready'))
        require(health.get('environment') == 'production' and health.get('status') == 'ok', 'PUBLIC_PRODUCTION_HEALTH_REQUIRED')
    except Exception:
        if created:
            require(file_pin(TLS) == created_pin and read_regular(TLS) == configs[str(TLS)],
                    'ROLLBACK_CONFIG_REPLACED')
            TLS.unlink()
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
        raise
    for path in (RENEW_SERVICE, RENEW_TIMER):
        exact_file(path, configs[str(path)])
    run(['systemctl', 'daemon-reload'])
    certificate_unit_guard(binding, loaded=True)
    run(['systemctl', 'enable', '--now', RENEW_TIMER.name])
    certificate_unit_guard(binding, loaded=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('check', 'acme', 'certificate', 'start', 'renew'))
    parser.add_argument('--release', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--check-file', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    os.umask(0o077)
    binding = release_binding(Path(args.release), args.manifest_sha256)
    if args.stage == 'check':
        require(args.output and args.output.is_absolute(), 'EXCLUSIVE_OUTPUT_REQUIRED')
        exact_file(args.output, canonical(check(binding, require_public_https=False)), 0o600)
        print('PRODUCTION_INGRESS_CHECK_PASSED')
        return
    if PRIVATE.exists() or PRIVATE.is_symlink():
        owned_directory(PRIVATE, 0o700)
    else:
        require(args.stage == 'acme', 'OWNED_DIRECTORY_CHANGED')
    lock_created = False
    shared_lock = None
    try:
        shared_lock = os.open(BASE / 'private/release.lock', os.O_RDWR | os.O_NOFOLLOW)
        info = os.fstat(shared_lock)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
                and not info.st_mode & 0o022, 'SHARED_RELEASE_LOCK_UNSAFE')
        lock_pin = file_pin(BASE / 'private/release.lock')
        release_lock_guard(shared_lock, lock_pin)
        fcntl.flock(shared_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        release_lock_guard(shared_lock, lock_pin)
        before = check(binding, require_public_https=args.stage == 'renew')
        require(before['shared_lock'] == lock_pin, 'SHARED_RELEASE_LOCK_REPLACED')
        if args.stage != 'renew':
            require(args.check_file, 'CHECK_RECEIPT_REQUIRED')
            receipt = json.loads(read_regular(args.check_file))
            require(receipt['schema'] == before['schema'] and receipt['read_only'] is True
                    and receipt['binding'] == binding and receipt['protected'] == before['protected']
                    and receipt['proxy'] == before['proxy'] and receipt['own'] == before['own']
                    and receipt['proxy_protected'] == before['proxy_protected']
                    and receipt['certificate_units'] == before['certificate_units']
                    and receipt['certificate_scope'] == before['certificate_scope']
                    and receipt['shared_lock'] == before['shared_lock']
                    and receipt.get('health_url') == before['health_url']
                    and receipt.get('health_scope') == before['health_scope'], 'CHECK_RECEIPT_STALE')
            require(0 <= int(time.time() * 1000) - receipt['checked_at_ms'] < 15 * 60 * 1000, 'CHECK_RECEIPT_EXPIRED')
        owned_directory(PRIVATE, 0o700, create=args.stage == 'acme')
        require(not LOCK.exists() and not LOCK.is_symlink(), 'INGRESS_OPERATION_RUNNING')
        LOCK.mkdir(mode=0o700)
        lock_created = True
        operation = {'acme': lambda value: prepare_acme(value, before['proxy']),
                     'certificate': lambda value: certificate(value, before['proxy']), 'start': start,
                     'renew': lambda value: certificate(value, before['proxy'], renew=True)}[args.stage]
        operation(binding)
        release_lock_guard(shared_lock, lock_pin)
        require(protected_files() == before['protected'], 'OTHER_VHOST_CHANGED')
        require(proxy_identity() == before['proxy'], 'SHARED_PROXY_CHANGED')
        require(proxy_configs(before['proxy']) == before['proxy_protected'], 'OTHER_PROXY_VHOST_CHANGED')
        production_health(PUBLIC_READY if args.stage in ('start', 'renew') else before['health_url'])
        print('PRODUCTION_INGRESS_' + args.stage.upper() + '_PASSED')
    finally:
        if shared_lock is not None:
            os.close(shared_lock)
        if lock_created:
            LOCK.rmdir()


if __name__ == '__main__':
    main()
