"""Build an isolated Mock TLS ingress; no install, signal or network operation.

Original and historical 04/05 profile bytes retain separate identities. This
builder is an architecture component, not permission to activate either pair.
Only the original exact template or freshly verified profile generator output
can enter the renderer. It never accepts an arbitrary Nginx include/body.
"""
import hashlib
from pathlib import Path
import stat
import types

HERE = Path(__file__).resolve().parent
HOST = 'oasis-mock.43.98.202.236.sslip.io'
UNIT = 'oasis-android-mock-ingress.service'
USER = 'oasis-mock-ingress'
PORT = 18986
PREFIX = '/etc/oasis-android-mock-ingress'
RUNTIME = '/run/oasis-android-mock-ingress'
CREDENTIALS = '/run/credentials/' + UNIT
TEMPLATE_SHA = 'e378300ec2e02a0699740eb9fab80ad4d24ea5309bdb55d934e2656e8be2ed29'
DEPENDENCIES = {
    'route_profile.py': '7c2e2ed387a1fa29953d8f0db30e00039d2831f39ebbc61658db6733d7e0542d',
    'asset_store.py': 'dedea88dc2739c79d128c6ea84802ded4417a94bfe455c4151290dbc7fbbdbdf',
    'asset_routes.py': '2729eef44d6fc55fffcd8016ea5401657d25a5873121b373bcbc850daa26f9f0',
    'asset_bundle.py': '50db617d949877e30ff184f3a9effc5ca47bd17b398d97f9758580e83a8c7a69',
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def require(value, code):
    if not value:
        raise ValueError(code)


def original_profile():
    raw = (HERE / 'mock.nginx.conf.example').read_bytes()
    require(sha(raw) == TEMPLATE_SHA, 'INGRESS_TEMPLATE_CHANGED')
    return raw.replace(b'mock-game.example.invalid', HOST.encode()).replace(
        b'/live/ANDROID_MOCK/', b'/live/oasis-android-mock/')


def _render_verified_profile(raw):
    # Callers below either compare the whole original or generate the overlay
    # from pinned manifests/bundle. No untrusted fragment reaches this function.
    replacements = {
        b'    listen 443 ssl http2;': b'    listen 127.0.0.1:18986 ssl http2;',
        b'    ssl_certificate /opt/oasis/acme/config/live/oasis-android-mock/fullchain.pem;':
            f'    ssl_certificate {CREDENTIALS}/fullchain.pem;'.encode(),
        b'    ssl_certificate_key /opt/oasis/acme/config/live/oasis-android-mock/privkey.pem;':
            f'    ssl_certificate_key {CREDENTIALS}/privkey.pem;'.encode(),
    }
    for before, after in replacements.items():
        require(raw.count(before) == 1, 'INGRESS_PROFILE_ENCLOSURE_CHANGED')
        raw = raw.replace(before, after)
    # No user directive: both master and workers run as the unit's unprivileged
    # user. Override compiled destinations before Nginx can create/chown paths.
    head = f'''# Generated dedicated Mock ingress. No shared Nginx include tree.
daemon off;
master_process on;
worker_processes 1;
pid {RUNTIME}/nginx.pid;
lock_file {RUNTIME}/nginx.lock;
error_log stderr notice;
events {{ worker_connections 256; }}
http {{
    access_log off;
    # Redirects retain the public HTTPS origin, never the loopback TLS port.
    port_in_redirect off;
    # The stable outer proxy replaces this header using its actual client IP.
    # Trust only the loopback transport, never an arbitrary forwarded chain.
    set_real_ip_from 127.0.0.1;
    real_ip_header X-Real-IP;
    real_ip_recursive off;
    client_body_temp_path {RUNTIME}/body;
    proxy_temp_path {RUNTIME}/proxy;
    fastcgi_temp_path {RUNTIME}/fastcgi;
    uwsgi_temp_path {RUNTIME}/uwsgi;
    scgi_temp_path {RUNTIME}/scgi;
    # Standalone MIME definitions avoid a shared include dependency.
    types {{
        text/html html;
        text/css css;
        application/javascript js mjs;
        application/json json;
        image/png png;
        image/jpeg jpg jpeg;
        image/webp webp;
        image/svg+xml svg;
        font/woff2 woff2;
        audio/mpeg mp3;
        audio/ogg ogg;
        application/wasm wasm;
        model/gltf-binary glb;
        application/zip zip;
        application/vnd.android.package-archive apk;
    }}
    default_type application/octet-stream;
'''.encode()
    return head + raw + b'}\n'


def build_config(profile_bytes):
    """Render only the byte-exact original profile, not an arbitrary fragment."""
    require(isinstance(profile_bytes, bytes) and profile_bytes == original_profile(),
            'INGRESS_UNVERIFIED_PROFILE')
    return _render_verified_profile(profile_bytes)


def verified_profile_module():
    # Verify all transitive sources before executing even the first module.
    for name, expected in DEPENDENCIES.items():
        path = HERE / name
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and not info.st_mode & 0o022 and sha(path.read_bytes()) == expected,
                'INGRESS_DEPENDENCY_CHANGED')
    path = HERE / 'route_profile.py'
    module = types.ModuleType('dedicated_ingress_verified_profiles')
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


def build_profile_configs(**verified_inputs):
    """Validate complete historical bundle/selected manifest bodies, then render.

    This preserves the existing exact 04/05 contract. A future current-release
    pair must have its own reviewed generator and identity; callers cannot pass
    a config, receipt or replacement manifest pin to bypass the old verifier.
    """
    profile = verified_profile_module()
    material = profile.build_profiles(**verified_inputs)
    require(material['original.conf'] == original_profile(), 'INGRESS_ORIGINAL_CHANGED')
    configs = {name: _render_verified_profile(material[name])
               for name in ('original.conf', 'overlay.conf')}
    unit = (HERE / 'mock-ingress.service.example').read_bytes()
    identity = {
        'schema': 'mock-dedicated-ingress-candidate-v1',
        'scope': 'Historical 04/05 route compatibility; not current-runtime upgrade approval',
        'origin': 'https://' + HOST, 'listener': f'127.0.0.1:{PORT}',
        'unit': UNIT, 'user': USER, 'prefix': PREFIX, 'runtime': RUNTIME,
        'profile_receipt_sha256': sha(material['receipt.json']),
        'profile_sources': {name: sha(material[name]) for name in configs},
        'configs': {name: sha(body) for name, body in configs.items()},
        'unit_sha256': sha(unit), 'dependencies': dict(DEPENDENCIES),
        'installed': False, 'shared_front_door_migrated': False,
        'remaining': ['dedicated-process-native-tls-and-hup', 'systemd-and-credential-lifecycle',
                      'stable-outer-tls-proxy-and-first-cutover', 'current-release-pair',
                      'boot-guard-and-journal-recovery', '13-game-apk-acceptance'],
    }
    return configs, identity
