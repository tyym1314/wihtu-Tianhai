"""Pure Mock 04/05 route profiles and separate, read-only filesystem checks.

No installer, subprocess, network, Nginx command or filesystem writer. A profile
match is not proof that Nginx loaded it or that the runtime may be upgraded.
"""
import io
import os
from pathlib import Path
import re
import stat
import tarfile
import types

_source = Path(__file__).with_name('asset_store.py')
store = types.ModuleType('mock_profile_store')
store.__file__ = str(_source)
exec(compile(_source.read_bytes(), str(_source), 'exec'), store.__dict__)
routes, bundle = store.routes, store.bundle

PROFILE_ROOT = Path('/opt/oasis/android-mock-route-profiles/04-to-05-v1')
TLS_CONF = Path('/etc/nginx/conf.d/oasis-android-mock.conf')
CURRENT = '/opt/oasis/android-mock-current'
TEMPLATE = 'platform/deploy/mock-sandbox/mock.nginx.conf.example'
TEMPLATE_SHA = 'e378300ec2e02a0699740eb9fab80ad4d24ea5309bdb55d934e2656e8be2ed29'
APK = 'platform/dist/downloads/oasis-android-smoke-1.2.0-debug.apk'
APK_SHA = '4531f672c89869d52d45c2c809d8667359d9026916cda19b1f6f5a35090a976c'
APK_BYTES = 33171
JSON_PATH = 'platform/dist/downloads/android-smoke-build.json'
ZIP_PATH = 'platform/dist/downloads/oasis-partner-sandbox-kit.zip'
CANONICAL_JSON = 'android-smoke-build-schema2.json'
MANIFEST_PINS = {'04': bundle.PINS['old_manifest'], '05': bundle.PINS['manifest']}
MANIFEST_COUNTS = {'04': 633, '05': 1013}
# Exact historical pairs, not a blanket downloads/specs exemption.
MUTABLE = {
    JSON_PATH: {
        '04': ('0b5127a7ec54b95b42025d758e99c8bacf743704d5d9b1a2cae5da39b06642e4', 245),
        '05': ('698d78c03d4fbc5d0c3fd73d6d578b8eec95bce4a0bd8344fde2c1b17a4bbddc', 1481),
        'policy': 'canonical-05-on-both-pins', 'mime': 'application/json'},
    ZIP_PATH: {
        '04': ('e6b58d12af7276bb3c72646b87e680cbf92318ca2fa13cca5c5cc9908395e27a', 323055),
        '05': ('7c77c9f9f29a1b7a9cd3de89330a10b82c4d954f4f3fa2e6c2cbcdbddff07196', 325779),
        'policy': 'exact-file-from-current-mock-pin', 'mime': 'application/zip'},
    'platform/dist/specs/android-webview-integration.md': {
        '04': ('4adc56db58fc330844bf28f5660d3f258a658ce26fe6197dffe2b8bccdd7aead', 3562),
        '05': ('3d601a7987053c9accb985dfe0321c7efb99063bbe5f383aab2e0b005cee98de', 6268),
        'policy': 'exact-historical-document-from-current-mock-pin', 'mime': 'text/plain'},
    'platform/dist/specs/third-party-launch-readiness-2026-10-07.md': {
        '04': ('b9cefc9f67354457148257adc99605715548849fa099a0170cda766ddb9a80e1', 20139),
        '05': ('487bbc3fc216b727cf8200ca157909b8262d35089b1aa184ca78bbe1f668df22', 42739),
        'policy': 'exact-historical-document-from-current-mock-pin', 'mime': 'text/plain'},
}
SELECTED = set(MUTABLE) | {APK, TEMPLATE}


def checked_manifest(raw, version):
    bundle.require(version in MANIFEST_PINS and isinstance(raw, bytes)
                   and bundle.sha(raw) == MANIFEST_PINS[version], 'PROFILE_MANIFEST_PIN')
    manifest = bundle.json_value(raw)
    bundle.require(isinstance(manifest, dict) and len(manifest) == MANIFEST_COUNTS[version],
                   'PROFILE_MANIFEST_MEMBERS')
    for name, digest in manifest.items():
        bundle.safe_name(name)
        bundle.require(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest), 'PROFILE_MANIFEST_HASH')
    bundle.require(SELECTED <= set(manifest), 'PROFILE_SOURCE_MISSING')
    return manifest


def checked_selected(manifest, files, version):
    bundle.require(isinstance(files, dict) and set(files) == SELECTED, 'PROFILE_SOURCE_SET')
    for name, raw in files.items():
        bundle.require(isinstance(raw, bytes) and len(raw) <= bundle.MAX_FILE_BYTES
                       and bundle.sha(raw) == manifest[name], 'PROFILE_SOURCE_HASH')
    bundle.require(bundle.sha(files[TEMPLATE]) == TEMPLATE_SHA, 'PROFILE_TEMPLATE_PIN')
    bundle.require(bundle.sha(files[APK]) == APK_SHA and len(files[APK]) == APK_BYTES, 'PROFILE_APK_PIN')
    for name, pair in MUTABLE.items():
        bundle.require((bundle.sha(files[name]), len(files[name])) == pair[version], 'PROFILE_MUTABLE_PIN')


def mutable_locations():
    parts = []
    for name, policy in MUTABLE.items():
        url = '/' + name.removeprefix('platform/dist/')
        target = str(PROFILE_ROOT / CANONICAL_JSON) if name == JSON_PATH else CURRENT + '/' + name
        parts += [f'location = {url} {{',
                  '    recursive_error_pages off;',
                  '    error_page 403 404 =404 @oasis_mock_mutable_missing;',
                  '    error_page 405 =405 @oasis_mock_mutable_method;',
                  '    if ($scheme != https) { return 404; }',
                  f'    if ($http_host !~* "^{routes.HOST.replace(".", "[.]")}(:443)?$") {{ return 404; }}',
                  f'    if ($request_uri != "{url}") {{ return 404; }}',
                  '    if ($request_method !~ "^(GET|HEAD)$") { return 405; }',
                  f'    alias {target};',
                  # The one pin is intentional; the activation controller must
                  # validate it. Do not allow other symlinks below that prefix.
                  '    disable_symlinks on;' if name == JSON_PATH else f'    disable_symlinks on from={CURRENT};',
                  '    open_file_cache off;', '    types { }',
                  f'    default_type {policy["mime"]};',
                  '    charset utf-8;' if name.endswith('.md') else '    charset off;',
                  '    gzip off;', '    expires off;', '    max_ranges 0;',
                  '    etag on;', '    if_modified_since off;',
                  '    add_header Cache-Control no-store always;',
                  '    add_header X-Content-Type-Options nosniff always;',
                  '    add_header Referrer-Policy no-referrer always;']
        if name == ZIP_PATH:
            parts.append('    add_header Content-Disposition \'attachment; filename="oasis-partner-sandbox-kit.zip"\';')
        parts.append('}')
    for suffix, status in (('missing', 404), ('method', 405)):
        parts += [f'location @oasis_mock_mutable_{suffix} {{', '    internal;',
                  '    recursive_error_pages off;', '    default_type text/plain;',
                  '    add_header Cache-Control no-store always;',
                  '    add_header X-Content-Type-Options nosniff always;']
        if status == 405:
            parts.append('    add_header Allow "GET, HEAD" always;')
        parts += [f'    return {status};', '}']
    return ('\n'.join(parts) + '\n').encode()


def build_profiles(*, old_manifest, new_manifest, old_files, new_files, asset_bundle):
    """Pure bytes -> candidate material files; never accepts a caller's receipt.

    Manifest pins authenticate all declared hashes. This function checks only
    the selected source bodies and the complete bundle, not either release tree.
    """
    old, new = checked_manifest(old_manifest, '04'), checked_manifest(new_manifest, '05')
    checked_selected(old, old_files, '04')
    checked_selected(new, new_files, '05')
    bundle.require(old_files[TEMPLATE] == new_files[TEMPLATE] and old_files[APK] == new_files[APK],
                   'PROFILE_SHARED_SOURCE_CHANGED')
    before, after = bundle.json_value(old_files[JSON_PATH]), bundle.json_value(new_files[JSON_PATH])
    legacy = {'apk', 'version', 'version_code', 'sha256', 'game_count', 'device_verification'}
    bundle.require(set(before) == legacy and all(before[k] == after.get(k) for k in legacy)
                   and after.get('schema_version') == 2 and after.get('variant') == 'historical-live'
                   and after.get('distribution_status') == 'historical-qa'
                   and after.get('origin') == 'https://game.tianyahuyu.com'
                   and after.get('package_name') == 'com.tianyahuyu.oasis.smoke'
                   and after.get('launch_activity') == 'com.tianyahuyu.oasis.smoke.MainActivity'
                   and after['sha256'] == APK_SHA and after['apk'] == Path(APK).name,
                   'PROFILE_METADATA_IDENTITY')
    generated, route_receipt = routes.artifacts(asset_bundle)
    with tarfile.open(fileobj=io.BytesIO(asset_bundle), mode='r:') as archive:
        bundle.require(archive.extractfile('source/manifest.json').read() == new_manifest,
                       'PROFILE_BUNDLE_MANIFEST')
    original = old_files[TEMPLATE].replace(b'mock-game.example.invalid', routes.HOST.encode()).replace(
        b'/live/ANDROID_MOCK/', b'/live/oasis-android-mock/')
    bundle.require(original.endswith(b'\n}\n'), 'PROFILE_TEMPLATE_END')
    overlay = original[:-2] + generated['locations.conf'] + mutable_locations() + b'}\n'
    policy = {
        'schema': 'mock-route-profile-policy-v1', 'old': bundle.OLD, 'new': bundle.NEW,
        'origin': bundle.ORIGIN, 'manifests': dict(MANIFEST_PINS),
        'immutable_bundle_sha256': route_receipt['bundle_sha256'],
        'immutable_locations_sha256': route_receipt['locations_sha256'],
        'mutable': MUTABLE, 'apk_sha256': APK_SHA, 'apk_bytes': APK_BYTES,
        'canonical_json_material': str(PROFILE_ROOT / CANONICAL_JSON),
        'mutable_cache': 'no-store; native ETag; If-Modified-Since disabled; open_file_cache off',
        'mutable_range': 'max_ranges 0; complete representation, no cross-pin byte ranges',
        'conditional_requests': 'native If-* semantics still require HTTP verification; no unconditional 412',
        'old_cache_boundary': 'no-store does not invalidate previously cached schema1 bytes',
        'pin_boundary': 'three mutable aliases intentionally follow the verified Mock pin; overlay retained on rollback',
    }
    artifacts = {'original.conf': original, 'overlay.conf': overlay,
                 CANONICAL_JSON: new_files[JSON_PATH], 'policy.json': bundle.encoded(policy)}
    receipt = {'schema': 'mock-route-profile-candidate-v1', 'files': {k: bundle.sha(v) for k, v in artifacts.items()},
               'selected_sources_verified': True, 'release_trees_verified': False,
               'store_checked': False, 'installed': False, 'http_verified': False, 'apply_allowed': False,
               'remaining_gates': ['fresh-release-static-inventories-and-pin', 'actual-store-and-material-files',
                                   'enclosing-nginx-config-and-worker-permissions', 'activation-and-recovery',
                                   'both-pin-http-cache-range-and-old-cache-tests', 'mock-13-game-and-device-acceptance']}
    artifacts['receipt.json'] = bundle.encoded(receipt)
    return artifacts


def classify_config_bytes(raw, **inputs):
    artifacts = build_profiles(**inputs)
    matches = [name for name in ('original', 'overlay') if raw == artifacts[name + '.conf']]
    bundle.require(len(matches) == 1, 'UNKNOWN_ROUTE_PROFILE')
    return {'profile': matches[0], 'config_sha256': bundle.sha(raw),
            'filesystem_verified': False, 'http_verified': False, 'apply_allowed': False}


def read_release_inputs(root, version):
    """Read/verify every manifest-declared body; no extraction or installation.

    Does not validate extra unmanifested files, node_modules, runtime identity or
    active pin. Those existing upgrade-controller checks remain mandatory.
    """
    root = bundle.safe_local_path(root)
    raw = bundle.read_small(root / 'RELEASE-MANIFEST.json')
    manifest = checked_manifest(raw, version)
    selected = {}
    for name, expected in manifest.items():
        with bundle.open_regular(root / name) as stream:
            data = stream.read(bundle.MAX_FILE_BYTES + 1)
        bundle.require(len(data) <= bundle.MAX_FILE_BYTES and bundle.sha(data) == expected,
                       'PROFILE_RELEASE_FILE_HASH')
        if name in SELECTED:
            selected[name] = data
    checked_selected(manifest, selected, version)
    return raw, selected


def owned_bytes(path, owner, mode, limit):
    with bundle.open_regular(path) as stream:
        info = os.fstat(stream.fileno())
        bundle.require(info.st_uid == owner and stat.S_IMODE(info.st_mode) == mode,
                       'PROFILE_FILE_PERMISSIONS')
        raw = stream.read(limit + 1)
    bundle.require(len(raw) <= limit, 'PROFILE_FILE_LENGTH')
    return raw


def verify_profile_files(inputs, config_path, bundle_path, *, store_parent=store.STORE.parent,
                         material_root=PROFILE_ROOT, owner=0):
    """Real read-only checks, including the store's existing shared lock.

    Relocation is an explicitly labelled local-fixture capability, not a CLI or
    installation option. Even fixed production paths do not prove activation.
    """
    artifacts = build_profiles(**inputs)
    config_path = bundle.safe_local_path(config_path)
    raw = owned_bytes(config_path, owner, 0o644, routes.MAX_CONFIG_BYTES + 16384)
    result = classify_config_bytes(raw, **inputs)
    result.update(filesystem_verified=True, store_checked=False, material_files_verified=False,
                  active_config_verified=False, pin_verified=False,
                  relocated_fixture=(config_path != TLS_CONF or Path(store_parent) != store.STORE.parent
                                     or Path(material_root) != PROFILE_ROOT or owner != 0))
    if result['profile'] == 'original':
        return result
    with bundle.open_regular(bundle_path) as stream:
        source = stream.read(bundle.MAX_BUNDLE_BYTES + 1)
    bundle.require(source == inputs['asset_bundle'], 'PROFILE_STORE_BUNDLE_CHANGED')
    checked_store = store.Store(store_parent, owner=owner).check(bundle_path)
    bundle.require(checked_store['bundle_sha256'] == bundle.sha(inputs['asset_bundle']), 'PROFILE_STORE_BUNDLE_CHANGED')
    material_root = bundle.safe_local_path(material_root)
    info = material_root.lstat()
    bundle.require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner
                   and stat.S_IMODE(info.st_mode) == 0o755, 'PROFILE_MATERIAL_DIRECTORY')
    bundle.require({p.name for p in material_root.iterdir()} == set(artifacts), 'PROFILE_MATERIAL_MEMBERS')
    for name, expected in artifacts.items():
        bundle.require(owned_bytes(material_root / name, owner, 0o444, len(expected)) == expected,
                       'PROFILE_MATERIAL_CHANGED')
    result.update(store_checked=True, material_files_verified=True,
                  store_receipt_sha256=bundle.sha(store.expected_artifacts(bundle_path)['receipt']))
    return result
