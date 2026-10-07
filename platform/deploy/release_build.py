"""Reject stale or partial browser builds before packaging a runtime release."""
import hashlib
import json
import argparse
import gzip
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
from urllib.parse import urlsplit

SOURCE_TREES = ('src', 'public', 'platform/src', 'platform/public', 'platform/specs',
                'platform/shared', 'platform/arena', 'platform/legacy', 'platform/android-smoke/app',
                # The partner kit copies wallet modules/examples and derives
                # public math-profile metadata from server code.
                'platform/server', 'platform/examples/partner-wallet')
EXCLUDED = {'dist', 'node_modules', '.local', '__pycache__'}
SOURCE_FILES = ('index.html', 'tiger.html', 'package.json', 'package-lock.json',
                'platform/index.html', 'platform/package.json', 'platform/package-lock.json',
                'platform/vite.config.js', 'platform/scripts/build-legacy.mjs',
                'platform/scripts/build-partner-kit.mjs', 'platform/scripts/build-release.mjs',
                'platform/scripts/android-artifact.mjs', 'platform/android-smoke/prepare-mock-build.mjs',
                'platform/scripts/retained-assets.mjs', 'platform/retained-assets.lock.json',
                'platform/android-smoke/build.sh', 'platform/android-smoke/build-metadata.mjs',
                'platform/deploy/release_build.py', 'platform/mobile-assets.json')
OUTPUT_TREES = ('platform/dist', 'platform/arena/dist', 'platform/legacy/dist')
STAMP = 'platform/release-build-manifest.json'
RETAINED_LOCK = 'platform/retained-assets.lock.json'
MAX_RETAINED_BYTES = 512 * 1024 * 1024
STATIC_NAMESPACES = {
    'platform/dist/assets/': '/assets/',
    'platform/arena/dist/assets/': '/arena/assets/',
    'platform/legacy/dist/bundles/': '/legacy/bundles/',
    'platform/legacy/dist/assets/': '/legacy/assets/',
}
STATIC_TYPES = {
    '.js': ('application/javascript', 'text/javascript'),
    '.mjs': ('application/javascript', 'text/javascript'),
    '.css': ('text/css',), '.webp': ('image/webp',), '.png': ('image/png',),
    '.jpg': ('image/jpeg',), '.jpeg': ('image/jpeg',), '.svg': ('image/svg+xml',),
    '.glb': ('model/gltf-binary',), '.gltf': ('model/gltf+json',),
    '.bin': ('application/octet-stream',), '.mp3': ('audio/mpeg',),
    '.ogg': ('audio/ogg',), '.woff': ('font/woff',), '.woff2': ('font/woff2',),
    '.wasm': ('application/wasm',), '.webm': ('video/webm',),
}
FINGERPRINT = re.compile(r'[-.][A-Za-z0-9_-]{8,64}\.(?:js|mjs|css|png|webp|jpe?g|svg|glb|gltf|bin|woff2?|mp3|ogg|wasm)$')
SHA256 = re.compile(r'[a-f0-9]{64}')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def regular_path(root, relative, missing=False):
    """Reject symlinks in every component, including dist itself."""
    path = root
    for part in PurePosixPath(relative).parts:
        path = path / part
        require(not path.is_symlink(), 'UNSAFE_RETAINED_PATH: ' + relative)
    require(missing or path.is_file(), 'RETAINED_ASSET_MISSING: ' + relative)
    require(not path.exists() or path.is_file(), 'UNSAFE_RETAINED_PATH: ' + relative)
    return path


def static_public_path(name):
    require(isinstance(name, str), 'INVALID_RETAINED_PATH')
    path = PurePosixPath(name)
    require(path.as_posix() == name and not path.is_absolute()
            and '..' not in path.parts
            and all(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', p) for p in path.parts),
            'UNSAFE_RETAINED_PATH: ' + name)
    for prefix, public in STATIC_NAMESPACES.items():
        if name.startswith(prefix):
            require(path.suffix in STATIC_TYPES and path.suffix != '.webm',
                    'INVALID_RETAINED_EXTENSION: ' + name)
            return public + name[len(prefix):]
    if name == 'platform/dist/mark.svg' or re.fullmatch(r'platform/dist/previews/[a-z0-9_-]+\.(?:png|webm)', name):
        return '/' + name[len('platform/dist/'):]
    raise ValueError('INVALID_RETAINED_NAMESPACE: ' + name)


def load_retained_lock(root):
    path = regular_path(root, RETAINED_LOCK)
    lock = json.loads(path.read_text())
    require(isinstance(lock, dict) and lock.get('schema') == 'oasis-retained-static-v1',
            'INVALID_RETAINED_SCHEMA')
    bundle, assets = lock.get('bundle'), lock.get('assets')
    require(isinstance(bundle, dict) and isinstance(assets, list) and 0 < len(assets) <= 10000,
            'INVALID_RETAINED_LOCK')
    try:
        url = urlsplit(bundle.get('url', ''))
        valid_url = (url.scheme == 'https' and url.hostname and not url.username
                     and not url.password and not url.fragment and not url.query
                     and url.port in (None, 443) and url.path.endswith('.tar.gz'))
    except (ValueError, TypeError):
        valid_url = False
    require(valid_url, 'RETAINED_BUNDLE_HTTPS_REQUIRED')
    require(isinstance(bundle.get('sha256'), str) and SHA256.fullmatch(bundle['sha256']),
            'INVALID_RETAINED_BUNDLE_HASH')
    require(type(bundle.get('bytes')) is int and 0 < bundle['bytes'] <= MAX_RETAINED_BYTES,
            'INVALID_RETAINED_BUNDLE_SIZE')
    by_public, by_path = {}, {}
    for asset in assets:
        require(isinstance(asset, dict), 'INVALID_RETAINED_ASSET')
        name = asset.get('path')
        public = static_public_path(name)
        require(asset.get('publicPath') == public, 'RETAINED_PUBLIC_PATH_MISMATCH: ' + name)
        require(name not in by_path and public not in by_public, 'DUPLICATE_RETAINED_ASSET: ' + name)
        require(isinstance(asset.get('sha256'), str) and SHA256.fullmatch(asset['sha256']),
                'INVALID_RETAINED_ASSET_HASH: ' + name)
        require(type(asset.get('bytes')) is int and 0 < asset['bytes'] <= MAX_RETAINED_BYTES,
                'INVALID_RETAINED_ASSET_SIZE: ' + name)
        require(asset.get('contentType') in STATIC_TYPES[PurePosixPath(name).suffix],
                'INVALID_RETAINED_CONTENT_TYPE: ' + name)
        role = asset.get('role', 'fingerprint')
        require(role in ('fingerprint', 'dependency'), 'INVALID_RETAINED_ROLE: ' + name)
        require(any(name.startswith(prefix) for prefix in STATIC_NAMESPACES) or role == 'dependency',
                'RETAINED_ROOT_RESOURCE_REQUIRES_DEPENDENCY_ROLE: ' + name)
        require(role != 'fingerprint' or FINGERPRINT.search(PurePosixPath(name).name),
                'RETAINED_ROOT_NOT_FINGERPRINTED: ' + name)
        sources = asset.get('sources')
        require(isinstance(sources, list) and bool(sources), 'RETAINED_SOURCE_REQUIRED: ' + name)
        seen_sources = set()
        for source in sources:
            require(isinstance(source, dict)
                    and isinstance(source.get('release'), str)
                    and re.fullmatch(r'[0-9]{8}-[0-9]{2}', source['release'])
                    and isinstance(source.get('manifest_sha256'), str)
                    and SHA256.fullmatch(source['manifest_sha256']), 'INVALID_RETAINED_SOURCE: ' + name)
            identity = (source['release'], source['manifest_sha256'])
            require(identity not in seen_sources, 'DUPLICATE_RETAINED_SOURCE: ' + name)
            seen_sources.add(identity)
        dependencies = asset.get('dependencies')
        require(isinstance(dependencies, list) and all(isinstance(p, str) for p in dependencies)
                and len(dependencies) == len(set(dependencies)), 'INVALID_RETAINED_DEPENDENCIES: ' + name)
        by_path[name], by_public[public] = asset, asset
    require(sum(asset['bytes'] for asset in assets) <= MAX_RETAINED_BYTES, 'RETAINED_ASSET_TOTAL_TOO_LARGE')
    for asset in assets:
        require(all(p in by_public for p in asset['dependencies']),
                'RETAINED_DEPENDENCY_MISSING: ' + asset['path'])
    reachable = set()
    pending = [a['publicPath'] for a in assets if a.get('role', 'fingerprint') == 'fingerprint']
    while pending:
        public = pending.pop()
        if public not in reachable:
            reachable.add(public)
            pending.extend(by_public[public]['dependencies'])
    require(len(reachable) == len(assets), 'UNREACHABLE_RETAINED_DEPENDENCY')
    return lock


def verify_retained_assets(root, lock=None):
    lock = load_retained_lock(root) if lock is None else lock
    for asset in lock['assets']:
        path = regular_path(root, asset['path'])
        require(path.stat().st_size == asset['bytes'] and file_digest(path) == asset['sha256'],
                'RETAINED_ASSET_HASH_MISMATCH: ' + asset['path'])
    return lock


def verify_ustar_structure(archive):
    """tarfile hides GNU/PAX extension records; reject those before using its API."""
    payload_bytes = 0
    entries = 0
    with gzip.open(archive, 'rb') as source:
        while True:
            header = source.read(512)
            require(len(header) == 512, 'TRUNCATED_RETAINED_ARCHIVE')
            if header == b'\0' * 512:
                trailer = source.read(1024 * 1024 + 1)
                require(512 <= len(trailer) <= 1024 * 1024 and len(trailer) % 512 == 0
                        and not any(trailer), 'INVALID_RETAINED_ARCHIVE_TRAILER')
                return
            require(header[257:263] == b'ustar\0' and header[263:265] == b'00'
                    and header[156:157] in (b'0', b'\0', b'5'), 'RETAINED_USTAR_REQUIRED')
            entry = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
            entries += 1
            payload_bytes += entry.size
            require(entries <= 20000 and 0 <= entry.size <= MAX_RETAINED_BYTES
                    and payload_bytes <= MAX_RETAINED_BYTES, 'RETAINED_ARCHIVE_TOO_LARGE')
            require(not entry.isdir() or entry.size == 0, 'INVALID_RETAINED_ARCHIVE_DIRECTORY')
            remaining = ((entry.size + 511) // 512) * 512
            while remaining:
                block = source.read(min(1024 * 1024, remaining))
                require(bool(block), 'TRUNCATED_RETAINED_ARCHIVE')
                remaining -= len(block)


def materialize_retained_assets(root, archive):
    """Verify the entire archive and every destination before creating any asset."""
    lock = load_retained_lock(root)
    bundle = lock['bundle']
    require(archive.is_file() and not archive.is_symlink(), 'INVALID_RETAINED_BUNDLE_FILE')
    require(archive.stat().st_size == bundle['bytes'] and file_digest(archive) == bundle['sha256'],
            'RETAINED_BUNDLE_HASH_MISMATCH')
    verify_ustar_structure(archive)
    expected = {asset['path']: asset for asset in lock['assets']}
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents if str(parent) != '.'}
    with tarfile.open(archive, 'r:gz') as tar:
        members, seen = {}, set()
        for entry in tar:
            name = entry.name.rstrip('/') if entry.isdir() else entry.name
            path = PurePosixPath(name)
            require(name not in seen and not path.is_absolute() and '..' not in path.parts
                    and path.as_posix() == name and not entry.pax_headers
                    and len(entry.name.encode('utf8')) <= 255,
                    'UNSAFE_RETAINED_ARCHIVE_ENTRY: ' + entry.name)
            seen.add(name)
            require(not entry.linkname and entry.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE),
                    'UNSAFE_RETAINED_ARCHIVE_ENTRY: ' + entry.name)
            if entry.isdir():
                require(name in directories, 'UNEXPECTED_RETAINED_ARCHIVE_DIRECTORY: ' + name)
                continue
            require(name in expected and entry.size == expected[name]['bytes'],
                    'RETAINED_ARCHIVE_MANIFEST_MISMATCH: ' + name)
            content = tar.extractfile(entry)
            value = hashlib.sha256()
            for block in iter(lambda: content.read(1024 * 1024), b''):
                value.update(block)
            require(value.hexdigest() == expected[name]['sha256'], 'RETAINED_ARCHIVE_HASH_MISMATCH: ' + name)
            members[name] = entry
        require(set(members) == set(expected), 'RETAINED_ARCHIVE_ASSETS_MISSING')
        # A new build may already produce some retained files. Reuse only exact bytes.
        for name, asset in expected.items():
            path = regular_path(root, name, missing=True)
            require(not path.exists() or (path.stat().st_size == asset['bytes']
                    and file_digest(path) == asset['sha256']), 'RETAINED_DESTINATION_CONFLICT: ' + name)
        written = 0
        for name, entry in members.items():
            path = regular_path(root, name, missing=True)
            if path.exists():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation prevents replacing a concurrently produced artifact.
            with path.open('xb') as target, tar.extractfile(entry) as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    target.write(block)
            os.chmod(path, 0o644)
            written += 1
    verify_retained_assets(root, lock)
    return {'retained_assets': len(expected), 'materialized': written, 'bundle_sha256': bundle['sha256']}


def fingerprint(root, paths):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(set(paths)) if p.is_file()}


def inputs(root):
    paths = [root / p for p in SOURCE_FILES]
    for directory in SOURCE_TREES:
        paths.extend(p for p in (root / directory).rglob('*')
                     if not EXCLUDED.intersection(p.relative_to(root / directory).parts)
                     and p.name != 'build-manifest.json')
    return fingerprint(root, paths)


def outputs(root):
    for entry in ('platform/dist/index.html', 'platform/arena/dist/index.html',
                  'platform/legacy/dist/thunder.html', 'platform/legacy/dist/tiger.html'):
        if not (root / entry).is_file():
            raise ValueError('MISSING_BROWSER_BUILD: ' + entry)
    return fingerprint(root, [p for directory in OUTPUT_TREES
                              for p in (root / directory).rglob('*')])


def record(root):
    verify_retained_assets(root)
    manifest = {'format': 1, 'inputs': inputs(root), 'outputs': outputs(root)}
    (root / STAMP).write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def verify(root):
    stamp = root / STAMP
    if not stamp.is_file():
        raise ValueError('FULL_RELEASE_BUILD_REQUIRED: run npm run build:release')
    manifest = json.loads(stamp.read_text())
    if manifest.get('format') != 1 or manifest.get('inputs') != inputs(root):
        raise ValueError('STALE_BUILD_INPUTS: run npm run build:release')
    verify_retained_assets(root)
    if manifest.get('outputs') != outputs(root):
        raise ValueError('STALE_BUILD_OUTPUTS: run npm run build:release')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='verify', choices=(
        'record', 'verify', 'retained-inspect', 'retained-materialize'))
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    repo = args.root.resolve(strict=True)
    if args.action == 'retained-inspect':
        lock = load_retained_lock(repo)
        print(json.dumps({'bundle': lock['bundle'], 'retained_assets': len(lock['assets'])}))
    elif args.action == 'retained-materialize':
        require(args.archive is not None, 'RETAINED_ARCHIVE_REQUIRED')
        print(json.dumps(materialize_retained_assets(repo, args.archive)))
    else:
        result = record(repo) if args.action == 'record' else verify(repo)
        print(json.dumps({'build': args.action, 'inputs': len(result['inputs']), 'outputs': len(result['outputs'])}))
