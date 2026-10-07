#!/usr/bin/env python3
"""Offline-only retained Mock assets for the exact 20261007-04 -> 20261008-05 gap.

No extraction, network, subprocess, service, installer, or Nginx operations.
The route plan is data for a later separately reviewed adapter, not permission to
upgrade. Fixed pins cannot be overridden on the command line.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile


OLD = '20261007-04'
NEW = '20261008-05'
ORIGIN = 'https://oasis-mock.43.98.202.236.sslip.io'
PINS = {
    'old_manifest': '47e5cab2ff8c910e7821e6c1edbd92a26135944241fc5b0c1610a44952d883bc',
    'manifest': 'b5ae243cf9860cd8323783422459811ff3efb13ff41ba3342084f9ae50ca78db',
    'archive': '3bb2170363c9f1e00cc9c2d37e2ebd83060838e873c24dbb6647455bc8076990',
    'check_log': 'a5a99b16379e03a725f66f14c0302e119966c97c7067616f5a1f5aa6f4fddd4b',
    'check_metadata': '08b07f8c79d212487d2db4ff3a2b99c76e8c896d0f121a4d95aaca84fdd371f2',
}
SOURCE_COMMIT = '12e453a67236a0539c23c68eac1b057e7cec808a'
EXPECTED_COUNT = 88
EXPECTED_BYTES = 3692973
CONFLICTS = {
    'platform/dist/downloads/android-smoke-build.json': 'mutable-download-metadata',
    'platform/dist/downloads/oasis-partner-sandbox-kit.zip': 'mutable-partner-kit',
    'platform/dist/specs/android-webview-integration.md': 'mutable-integration-document',
    'platform/dist/specs/third-party-launch-readiness-2026-10-07.md': 'mutable-readiness-document',
}
PREFIXES = {
    'platform/dist/assets/': '/assets/',
    'platform/arena/dist/assets/': '/arena/assets/',
    'platform/legacy/dist/bundles/': '/legacy/bundles/',
}
SOURCE_MEMBERS = {
    'manifest': 'source/manifest.json',
    'check_log': 'source/check.log',
    'check_metadata': 'source/check.json',
}
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_MEMBERS = 2048


def require(value, code):
    if not value:
        raise ValueError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode()


def json_value(raw):
    require(len(raw) <= MAX_JSON_BYTES, 'JSON_TOO_LARGE')
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'DUPLICATE_JSON_KEY')
            value[key] = item
        return value
    def constant(_):
        raise ValueError('NONFINITE_JSON')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def safe_name(name):
    require(isinstance(name, str) and bool(name)
            and re.fullmatch(r'[A-Za-z0-9_./-]+', name)
            and not name.startswith('/') and not name.endswith('/')
            and all(part not in ('', '.', '..') for part in name.split('/'))
            and PurePosixPath(name).as_posix() == name, 'UNSAFE_PATH')
    return name


def safe_local_path(value):
    path = Path(os.path.abspath(value))
    # Check existing components, without resolving a symlink away first.
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            require(not part.is_symlink(), 'LOCAL_SYMLINK')
    return path


def open_regular(value):
    path = safe_local_path(value)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'LOCAL_NOT_REGULAR')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def read_small(value):
    with open_regular(value) as stream:
        data = stream.read(MAX_JSON_BYTES + 1)
    require(len(data) <= MAX_JSON_BYTES, 'INPUT_TOO_LARGE')
    return data


def digest_stream(stream, maximum):
    digest = hashlib.sha256()
    total = 0
    while True:
        block = stream.read(1024 * 1024)
        if not block:
            break
        total += len(block)
        require(total <= maximum, 'INPUT_TOO_LARGE')
        digest.update(block)
    return digest.hexdigest()


def validated_sources(sources):
    require(set(sources) == set(SOURCE_MEMBERS), 'SOURCE_SET')
    for key, data in sources.items():
        require(isinstance(data, bytes) and sha(data) == PINS[key], 'SOURCE_PIN_MISMATCH')
    manifest = json_value(sources['manifest'])
    require(isinstance(manifest, dict) and 0 < len(manifest) < MAX_MEMBERS, 'MANIFEST_SHAPE')
    for name, value in manifest.items():
        safe_name(name)
        require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), 'MANIFEST_HASH')
    meta = json_value(sources['check_metadata'])
    require(isinstance(meta, dict) and meta.get('log_sha256') == PINS['check_log']
            and meta.get('ssh_exit_code') == 2
            and meta.get('mode') == 'one real check-only; no apply/recover', 'EVIDENCE_METADATA')
    log = sources['check_log'].decode('utf-8')
    start, end = 'CONTROLLER_STDOUT_BEGIN\n', '\nCONTROLLER_STDOUT_END'
    require(log.count(start) == log.count(end) == 1, 'EVIDENCE_SECTION')
    report = json_value(log.split(start)[1].split(end)[0].encode())
    require(isinstance(report, dict) and report.get('mode') == 'check-only'
            and report.get('old') == '/opt/oasis/releases/' + OLD
            and report.get('new') == '/opt/oasis/releases/' + NEW
            and report.get('old_manifest') == PINS['old_manifest']
            and report.get('new_manifest') == PINS['manifest']
            and report.get('apply_allowed') is False
            and report.get('blockers') == ['forward_assets', 'rollback_assets'], 'EVIDENCE_SCOPE')
    for name, checked in (('forward_assets', 618), ('rollback_assets', 706)):
        row = report.get(name)
        require(isinstance(row, dict) and row.get('compatible') is False
                and row.get('checked') == checked
                and row.get('changed') == sorted(CONFLICTS), 'CONFLICT_EVIDENCE')
    require(report['forward_assets'].get('missing') == [], 'UNEXPECTED_FORWARD_GAP')
    missing = report['rollback_assets'].get('missing')
    require(isinstance(missing, list) and len(missing) == EXPECTED_COUNT
            and all(isinstance(item, str) for item in missing)
            and missing == sorted(set(missing)), 'GAP_SET')
    for name in (*missing, *CONFLICTS):
        require(name in manifest, 'EVIDENCE_NOT_IN_MANIFEST')
    for name in missing:
        asset_url(name)
    return manifest, missing


def asset_url(name):
    safe_name(name)
    for prefix, public in PREFIXES.items():
        if name.startswith(prefix):
            leaf = name[len(prefix):]
            require(re.fullmatch(r'[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(js|css)', leaf), 'NOT_HASHED_JS_CSS')
            return public + leaf
    raise ValueError('ASSET_OUTSIDE_ALLOWLIST')


def safe_member(member):
    safe_name(member.name)
    require(member.type == tarfile.REGTYPE and member.linkname == ''
            and member.sparse is None, 'UNSAFE_TAR_TYPE')
    require(0 <= member.size <= MAX_FILE_BYTES, 'TAR_FILE_TOO_LARGE')
    # The published source uses only PAX mtime. No path, sparse or size override.
    require(set(member.pax_headers) <= {'mtime'}, 'UNSAFE_TAR_EXTENSION')


def source_assets(archive, sources):
    manifest, missing = validated_sources(sources)
    payloads, seen, total = {}, set(), 0
    with open_regular(archive) as stream:
        require(digest_stream(stream, MAX_SOURCE_BYTES) == PINS['archive'], 'ARCHIVE_PIN_MISMATCH')
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode='r|gz') as tar:
            for member in tar:
                safe_member(member)
                require(member.name not in seen and len(seen) < MAX_MEMBERS, 'DUPLICATE_OR_TOO_MANY_MEMBERS')
                seen.add(member.name)
                total += member.size
                require(total <= MAX_SOURCE_BYTES, 'TAR_EXPANSION_LIMIT')
                require(member.name in manifest or member.name == 'RELEASE-MANIFEST.json', 'UNMANIFESTED_SOURCE')
                file = tar.extractfile(member)
                require(file is not None, 'MISSING_TAR_BODY')
                data = file.read(member.size + 1)
                require(len(data) == member.size, 'TAR_LENGTH_MISMATCH')
                expected = manifest.get(member.name, PINS['manifest'])
                require(sha(data) == expected, 'SOURCE_FILE_HASH_MISMATCH')
                if member.name == 'RELEASE-MANIFEST.json':
                    require(data == sources['manifest'], 'EMBEDDED_MANIFEST_MISMATCH')
                if member.name in missing:
                    payloads[member.name] = data
        require(seen == set(manifest) | {'RELEASE-MANIFEST.json'}, 'MISSING_SOURCE_FILES')
        # Same descriptor is checked again, so an in-place source rewrite while
        # streaming cannot silently produce a trusted partial source package.
        stream.seek(0)
        require(digest_stream(stream, MAX_SOURCE_BYTES) == PINS['archive'], 'SOURCE_CHANGED_DURING_READ')
    require(sum(map(len, payloads.values())) == EXPECTED_BYTES, 'GAP_LENGTH_MISMATCH')
    return payloads


def make_plan(sources, payloads):
    manifest, missing = validated_sources(sources)
    require(set(payloads) == set(missing), 'PAYLOAD_SET')
    entries, urls = [], set()
    for name in missing:
        body, url = payloads[name], asset_url(name)
        require(isinstance(body, bytes) and sha(body) == manifest[name], 'PAYLOAD_HASH_MISMATCH')
        require(url not in urls, 'URL_CONFLICT')
        urls.add(url)
        entries.append({
            'source_path': name, 'url_path': url, 'bundle_member': 'files' + url,
            'sha256': manifest[name], 'body_bytes': len(body), 'methods': ['GET', 'HEAD'],
            'status': 200, 'get_body': 'exact-file-bytes', 'head_body_bytes': 0,
            'headers': {'Content-Type': 'text/css' if name.endswith('.css') else 'text/javascript',
                        'Content-Length': str(len(body)),
                        'Cache-Control': 'public,max-age=31536000,immutable',
                        'X-Content-Type-Options': 'nosniff', 'ETag': '"sha256-' + manifest[name] + '"'},
        })
    require(len(entries) == EXPECTED_COUNT
            and sum(item['body_bytes'] for item in entries) == EXPECTED_BYTES, 'GAP_TOTALS')
    return {
        'schema': 'mock-immutable-asset-bundle-v1',
        'scope': {'old_release': OLD, 'new_release': NEW, 'origin': ORIGIN,
                  'reviewed_source_commit': SOURCE_COMMIT, 'pins': dict(PINS)},
        'status': 'offline-preparation-only', 'apply_allowed': False,
        'storage': 'dedicated-mock-immutable-store-only',
        'routing': {'match': 'exact-raw-path', 'query': 'reject', 'other_methods': 405,
                    'unknown_paths': 'no-overlay-match', 'metadata_public': False,
                    'body_transform': 'none', 'content_encoding': 'identity',
                    'pin_values': [OLD, NEW],
                    'precedence': 'exact-allowlist-before-mock-static-and-game-proxy',
                    'api_demo_play_health_routes': 'unchanged'},
        'count': len(entries), 'body_bytes': EXPECTED_BYTES, 'entries': entries,
        'unresolved_conflicts': [
            {'source_path': name, 'classification': CONFLICTS[name],
             'new_sha256': manifest[name], 'old_sha256': None,
             'old_hash_status': 'not-present-in-check-only-evidence',
             'evidence': ['forward_assets.changed', 'rollback_assets.changed'],
             'resolution': 'blocked-pending-explicit-review', 'overlay_included': False}
            for name in sorted(CONFLICTS)],
        'remaining_gates': [
            'fresh-complete-old-new-manifest-and-bidirectional-static-inventory',
            'explicit-four-mutable-conflicts-policy-with-old-and-new-byte-evidence',
            'reviewed-mock-only-atomic-overlay-install-and-service-start-adapter',
            'readback-exact-get-head-hash-length-mime-cache-on-both-pins',
            'api-private-isolation-and-unknown-path-negative-http-checks',
            'upgrade-controller-template-identity-and-recovery-review',
            'fresh-13-game-mock-browser-and-apk-acceptance'],
    }


def tar_bytes(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name, body in sorted(files.items()):
            safe_name(name)
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(body), 0o644, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            tar.addfile(info, io.BytesIO(body))
    result = output.getvalue()
    require(len(result) <= MAX_BUNDLE_BYTES, 'BUNDLE_TOO_LARGE')
    return result


def check_bytes(raw):
    require(len(raw) <= MAX_BUNDLE_BYTES, 'BUNDLE_TOO_LARGE')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as tar:
        for member in tar:
            safe_member(member)
            require(member.name not in files and len(files) < MAX_MEMBERS, 'DUPLICATE_OR_TOO_MANY_MEMBERS')
            require(member.mode == 0o644 and member.uid == member.gid == member.mtime == 0
                    and member.uname == member.gname == '' and not member.pax_headers, 'NONCANONICAL_BUNDLE_MEMBER')
            file = tar.extractfile(member)
            body = file.read(member.size + 1)
            require(len(body) == member.size, 'TAR_LENGTH_MISMATCH')
            files[member.name] = body
    require(set(SOURCE_MEMBERS.values()) <= set(files) and 'BUNDLE-PLAN.json' in files, 'BUNDLE_METADATA_MISSING')
    sources = {key: files[name] for key, name in SOURCE_MEMBERS.items()}
    _, missing = validated_sources(sources)
    payloads = {}
    for name in missing:
        key = 'files' + asset_url(name)
        require(key in files, 'BUNDLE_ASSET_MISSING')
        payloads[name] = files[key]
    plan = make_plan(sources, payloads)
    require(files['BUNDLE-PLAN.json'] == encoded(plan), 'PLAN_MISMATCH')
    expected = set(SOURCE_MEMBERS.values()) | {'BUNDLE-PLAN.json'} | {
        item['bundle_member'] for item in plan['entries']}
    require(set(files) == expected, 'UNEXPECTED_BUNDLE_MEMBER')
    # Byte-for-byte canonical roundtrip rejects extra tar streams, hidden trailing
    # data, nonstandard headers and padding as well as conflicting duplicates.
    require(tar_bytes(files) == raw, 'NONCANONICAL_BUNDLE')
    return {'schema': 'mock-asset-bundle-check-v1', 'verified': True,
            'bundle_sha256': sha(raw), 'bundle_bytes': len(raw),
            'plan_sha256': sha(files['BUNDLE-PLAN.json']),
            'asset_count': plan['count'], 'asset_body_bytes': plan['body_bytes'],
            'unresolved_conflicts': len(plan['unresolved_conflicts']),
            'apply_allowed': False, 'installed': False, 'network_checked': False}


def check_bundle(path):
    with open_regular(path) as stream:
        raw = stream.read(MAX_BUNDLE_BYTES + 1)
    return check_bytes(raw)


def compile_bundle(archive, manifest, evidence, evidence_log, output):
    sources = {'manifest': read_small(manifest), 'check_metadata': read_small(evidence),
               'check_log': read_small(evidence_log)}
    payloads = source_assets(archive, sources)
    plan = make_plan(sources, payloads)
    files = {SOURCE_MEMBERS[key]: raw for key, raw in sources.items()}
    files['BUNDLE-PLAN.json'] = encoded(plan)
    files.update({'files' + asset_url(name): body for name, body in payloads.items()})
    bundle = tar_bytes(files)
    receipt = check_bytes(bundle)
    target = safe_local_path(output)
    # Do not create parents or permit accidental use of installation locations.
    require(not any(target == Path(prefix) or Path(prefix) in target.parents for prefix in
                    ('/opt', '/etc', '/run', '/var', '/usr', '/System', '/Library', '/proc', '/sys', '/dev')),
            'DEPLOYMENT_OUTPUT_FORBIDDEN')
    require(target.parent.is_dir(), 'OUTPUT_PARENT_MISSING')
    target.mkdir(mode=0o700)  # exclusive; never overwrite an earlier artifact
    for name, raw in (('bundle.tar', bundle), ('plan.json', encoded(plan)), ('receipt.json', encoded(receipt))):
        descriptor = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    descriptor = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    require(check_bundle(target / 'bundle.tar') == receipt, 'OUTPUT_READBACK_MISMATCH')
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    compile_parser = modes.add_parser('compile', help='create a fresh local artifact directory')
    for arg in ('archive', 'manifest', 'evidence', 'evidence-log', 'output'):
        compile_parser.add_argument('--' + arg, required=True)
    check_parser = modes.add_parser('check', help='read-only verification, no extraction or output files')
    check_parser.add_argument('--bundle', required=True)
    args = parser.parse_args(argv)
    try:
        result = (check_bundle(args.bundle) if args.mode == 'check' else compile_bundle(
            args.archive, args.manifest, args.evidence, args.evidence_log, args.output))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, tarfile.TarError, UnicodeError, KeyError, TypeError):
        # Avoid path, content or metadata disclosure in CLI errors.
        print(json.dumps({'verified': False, 'error': 'ASSET_BUNDLE_REFUSED', 'apply_allowed': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
